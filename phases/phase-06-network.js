const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processWithCursor, getCount } = require('../utils/batch-processor');
const config = require('../config');

module.exports = async function phase06(v1Pool, v2Pool) {
  logger.phase('06', 'Red MLM');
  const allResults = [];

  // ==============================================================
  // PASO 1: INSERT network_members sin relaciones jerárquicas
  // Extraer solo nivel=1 de t_red (padre directo de cada distribuidor)
  // ==============================================================
  logger.table('network_members', 'PASO 1: Insertando miembros de red (sin parent_id)');

  const nmCount = await getCount(v1Pool, `
    SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT ON (id_customers) id_red
      FROM toniclife.t_red
      WHERE nivel = 1
      ORDER BY id_customers, id_red
    ) sub
  `);
  logger.info(`    Registros nivel=1 en t_red: ${nmCount.toLocaleString()}`);

  // También contar distribuidores sin nivel=1 (nodos raíz)
  const rootCount = await getCount(v1Pool, `
    SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT id_customers FROM toniclife.t_red
      EXCEPT
      SELECT DISTINCT id_customers FROM toniclife.t_red WHERE nivel = 1
    ) sub
  `);
  logger.info(`    Nodos raíz (sin nivel=1): ${rootCount}`);

  // Pre-cargar mapa de datos de customers (uuid → {registration_date, is_active})
  // Elimina ~218K queries individuales en PASO 1
  logger.info('    Pre-cargando datos de customers...');
  const custDataRows = await v2Pool.query(
    'SELECT id, registration_date, is_active FROM tonic.customers'
  );
  const customerDataMap = new Map();
  for (const r of custDataRows.rows) {
    customerDataMap.set(r.id, { registration_date: r.registration_date, is_active: r.is_active });
  }
  logger.info(`    ${customerDataMap.size.toLocaleString()} customers cargados en memoria`);

  // Insertar nodos con nivel=1 (tienen padre)
  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT DISTINCT ON (id_customers)
        id_red, id_customers, id_upline, created_at
      FROM toniclife.t_red
      WHERE nivel = 1
      ORDER BY id_customers, id_red
    `,
    tableName: 'network_members (nivel=1)',
    totalCount: nmCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      // Lookup from pre-loaded Map (eliminates inline SELECT)
      const cust = customerDataMap.get(customerId) || {};

      await client.query(
        `INSERT INTO tonic.network_members (
          id, customer_id, parent_id, sponsor_member_id,
          depth, path, path_legacy, children_count,
          enrollment_date, legacy_id, is_active, created_at
        ) VALUES (
          gen_random_uuid(), $1, NULL, NULL,
          0, NULL, NULL, 0,
          $2, $3, $4, $5
        )
        ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
          customer_id = EXCLUDED.customer_id,
          enrollment_date = EXCLUDED.enrollment_date,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          customerId,
          cust.registration_date || null,
          row.id_red,
          cust.is_active !== false,
          row.created_at || new Date(),
        ]
      );
    },
  }));

  // Insertar nodos raíz (distribuidores en t_red que NO tienen nivel=1)
  if (rootCount > 0) {
    logger.table('network_members', 'Insertando nodos raíz');
    const rootResult = await v1Pool.query(`
      SELECT DISTINCT r.id_customers, MIN(r.id_red) AS id_red, MIN(r.created_at) AS created_at
      FROM toniclife.t_red r
      WHERE NOT EXISTS (
        SELECT 1 FROM toniclife.t_red r2
        WHERE r2.id_customers = r.id_customers AND r2.nivel = 1
      )
      GROUP BY r.id_customers
    `);

    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');
      for (const row of rootResult.rows) {
        const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
        if (!customerId) continue;

        // Lookup from pre-loaded Map (eliminates inline SELECT)
        const cust = customerDataMap.get(customerId) || {};

        await v2Client.query(
          `INSERT INTO tonic.network_members (
            id, customer_id, parent_id, depth, path, children_count,
            enrollment_date, legacy_id, is_active, created_at
          ) VALUES (
            gen_random_uuid(), $1, NULL, 0, NULL, 0,
            $2, $3, $4, $5
          )
          ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
            customer_id = EXCLUDED.customer_id,
            enrollment_date = EXCLUDED.enrollment_date,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()`,
          [
            customerId,
            cust.registration_date || null,
            row.id_red,
            cust.is_active !== false,
            row.created_at || new Date(),
          ]
        );
      }
      await v2Client.query('COMMIT');
    } finally {
      v2Client.release();
    }
    logger.info(`    ✓ ${rootResult.rows.length} nodos raíz insertados`);
  }

  // ==============================================================
  // PASO 2: UPDATE parent_id (padre directo)
  // ==============================================================
  logger.table('network_members', 'PASO 2: Actualizando parent_id');
  logger.info('    Cargando relaciones padre-hijo de v1...');
  const parentData = await v1Pool.query(`
    SELECT DISTINCT ON (id_customers) id_customers, id_upline
    FROM toniclife.t_red
    WHERE nivel = 1 AND id_upline IS NOT NULL
    ORDER BY id_customers, id_red
  `);
  logger.info(`    ${parentData.rows.length.toLocaleString()} relaciones cargadas`);

  // Bulk UPDATE con temp table: volcar pares (child_legacy, parent_legacy) → UPDATE JOIN
  const paso2Client = await v2Pool.connect();
  let parentUpdated = 0;
  try {
    await paso2Client.query('BEGIN');
    await paso2Client.query(`
      CREATE TEMP TABLE tmp_parent_map (
        child_legacy  BIGINT NOT NULL,
        parent_legacy BIGINT NOT NULL
      ) ON COMMIT DROP
    `);

    // Insertar en chunks de 10K (para no exceder 65535 params)
    const CHUNK = 10000;
    for (let i = 0; i < parentData.rows.length; i += CHUNK) {
      const chunk = parentData.rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (let j = 0; j < chunk.length; j++) {
        const off = j * 2;
        values.push(`($${off + 1}, $${off + 2})`);
        params.push(chunk[j].id_customers, chunk[j].id_upline);
      }
      await paso2Client.query(
        `INSERT INTO tmp_parent_map (child_legacy, parent_legacy) VALUES ${values.join(',')}`,
        params
      );
    }
    logger.info('    Temp table cargada, ejecutando UPDATE JOIN...');

    const updateResult = await paso2Client.query(`
      UPDATE tonic.network_members nm
      SET parent_id = parent_nm.id
      FROM tmp_parent_map t
      JOIN tonic.customers child_c ON child_c.legacy_id = t.child_legacy
      JOIN tonic.customers parent_c ON parent_c.legacy_id = t.parent_legacy
      JOIN tonic.network_members parent_nm ON parent_nm.customer_id = parent_c.id
      WHERE nm.customer_id = child_c.id
        AND nm.parent_id IS NULL
    `);
    parentUpdated = updateResult.rowCount;

    await paso2Client.query('COMMIT');
  } catch (err) {
    await paso2Client.query('ROLLBACK');
    logger.error(`    Error bulk parent_id: ${err.message}`);
  } finally {
    paso2Client.release();
  }
  logger.info(`    ✓ parent_id: ${parentUpdated} actualizados`);

  // ==============================================================
  // PASO 3: UPDATE sponsor_member_id
  // ==============================================================
  logger.table('network_members', 'PASO 3: Actualizando sponsor_member_id');
  const sponsorResult = await v2Pool.query(`
    UPDATE tonic.network_members nm
    SET sponsor_member_id = sponsor_nm.id
    FROM tonic.customers c
    JOIN tonic.customers sponsor_c ON sponsor_c.id = c.sponsor_id
    JOIN tonic.network_members sponsor_nm ON sponsor_nm.customer_id = sponsor_c.id
    WHERE nm.customer_id = c.id
      AND c.sponsor_id IS NOT NULL
      AND nm.sponsor_member_id IS NULL
  `);
  logger.info(`    ✓ sponsor_member_id: ${sponsorResult.rowCount} actualizados`);

  // ==============================================================
  // PASO 4: Recalcular depth, path, path_legacy, children_count
  // ==============================================================
  logger.table('network_members', 'PASO 4: Recalculando depth, path y children_count');

  // Usar cliente dedicado con transacción para que SET LOCAL tenga efecto
  const paso4Client = await v2Pool.connect();
  try {
    await paso4Client.query('BEGIN');
    await paso4Client.query("SET LOCAL work_mem = '512MB'");

    logger.info('    Calculando depth y path con CTE recursivo...');
    const depthResult = await paso4Client.query(`
      WITH RECURSIVE tree AS (
        SELECT id, customer_id, parent_id, legacy_id,
               0 AS depth,
               '/' || id::TEXT AS path,
               '/' || COALESCE(legacy_id::TEXT, id::TEXT) AS path_legacy
        FROM tonic.network_members
        WHERE parent_id IS NULL
        UNION ALL
        SELECT nm.id, nm.customer_id, nm.parent_id, nm.legacy_id,
               t.depth + 1,
               t.path || '/' || nm.id::TEXT,
               t.path_legacy || '/' || COALESCE(nm.legacy_id::TEXT, nm.id::TEXT)
        FROM tonic.network_members nm
        JOIN tree t ON nm.parent_id = t.id
      )
      UPDATE tonic.network_members nm
      SET depth = tree.depth,
          path = tree.path,
          path_legacy = tree.path_legacy
      FROM tree
      WHERE nm.id = tree.id
    `);
    logger.info(`    ✓ depth/path: ${depthResult.rowCount} registros actualizados`);

    // Actualizar children_count
    logger.info('    Calculando children_count...');
    const childrenResult = await paso4Client.query(`
      UPDATE tonic.network_members nm
      SET children_count = COALESCE(sub.cnt, 0)
      FROM (
        SELECT parent_id, COUNT(*) AS cnt
        FROM tonic.network_members
        WHERE parent_id IS NOT NULL
        GROUP BY parent_id
      ) sub
      WHERE nm.id = sub.parent_id
    `);
    logger.info(`    ✓ children_count: ${childrenResult.rowCount} registros actualizados`);

    await paso4Client.query('COMMIT');
  } catch (err) {
    await paso4Client.query('ROLLBACK');
    throw err;
  } finally {
    paso4Client.release();
  }

  // ==============================================================
  // network_roll_over (extraer nivel=1 de t_red_roll_over)
  // v1 columnas reales: id_red, id_customers, nivel, id_upline, created_at
  // v2 columnas: member_id, original_parent_id, roll_over_parent_id(NOT NULL),
  //              period_id, reason, applied_by, applied_at(NOT NULL), is_active
  // UNIQUE: uq_network_roll_over_member_period (member_id, period_id)
  // No tiene columna legacy_id en v2.
  // ==============================================================
  logger.table('network_roll_over', 'Migrando t_red_roll_over → network_roll_over');
  const rolloverCount = await getCount(v1Pool, `
    SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT ON (id_customers) id_red
      FROM toniclife.t_red_roll_over
      WHERE nivel = 1
      ORDER BY id_customers, id_red
    ) sub
  `);
  logger.info(`    Registros nivel=1 en t_red_roll_over: ${rolloverCount.toLocaleString()}`);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT DISTINCT ON (id_customers)
        id_red, id_customers, id_upline, created_at
      FROM toniclife.t_red_roll_over
      WHERE nivel = 1
      ORDER BY id_customers, id_red
    `,
    tableName: 'network_roll_over',
    totalCount: rolloverCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // Resolver member_id (del customer)
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const memberResult = await client.query(
        'SELECT id, parent_id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
        [customerId]
      );
      if (memberResult.rows.length === 0) return 'skipped';
      const memberId = memberResult.rows[0].id;
      const originalParentId = memberResult.rows[0].parent_id || null;

      // Idempotencia: skip si ya existe para este member con period_id NULL
      const exists = await client.query(
        'SELECT 1 FROM tonic.network_roll_over WHERE member_id = $1 AND period_id IS NULL LIMIT 1',
        [memberId]
      );
      if (exists.rows.length > 0) return 'skipped';

      // Resolver roll_over_parent (id_upline del roll_over)
      let rollOverParentId = null;
      if (row.id_upline) {
        const parentCustomerId = await idResolver.resolve(v2Pool, 'customer', row.id_upline, 'customers');
        if (parentCustomerId) {
          const parentMember = await client.query(
            'SELECT id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
            [parentCustomerId]
          );
          if (parentMember.rows.length > 0) rollOverParentId = parentMember.rows[0].id;
        }
      }
      if (!rollOverParentId) return 'skipped'; // roll_over_parent_id es NOT NULL

      await client.query(
        `INSERT INTO tonic.network_roll_over (
          id, member_id, original_parent_id, roll_over_parent_id,
          period_id, is_active, applied_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          NULL, true, $4, $4, $4
        )`,
        [memberId, originalParentId, rollOverParentId, row.created_at || new Date()]
      );
    },
  }));

  // ==============================================================
  // network_sponsor_overrides
  // v1 columnas reales: hijo (child customer id), padre (custom sponsor id),
  //                     puntos, negocio
  // v2 columnas: member_id(NOT NULL), original_sponsor_id, custom_sponsor_id(NOT NULL),
  //              effective_from(NOT NULL date), effective_to, reason, applied_by,
  //              legacy_id, is_active
  // Sin PK en v1. Usamos hijo como legacy_id sintético.
  // legacy_id index NO es UNIQUE → usamos NOT EXISTS para idempotencia.
  // ==============================================================
  logger.table('network_sponsor_overrides', 'Migrando t_red_custom_sponsor → network_sponsor_overrides');
  const sponsorOverCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_red_custom_sponsor');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT hijo, padre, puntos, negocio FROM toniclife.t_red_custom_sponsor ORDER BY hijo',
    tableName: 'network_sponsor_overrides',
    totalCount: sponsorOverCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // hijo = id_customers del hijo (child)
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.hijo, 'customers');
      if (!customerId) return 'skipped';

      const memberResult = await client.query(
        'SELECT id, sponsor_member_id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
        [customerId]
      );
      if (memberResult.rows.length === 0) return 'skipped';
      const memberId = memberResult.rows[0].id;
      const originalSponsorId = memberResult.rows[0].sponsor_member_id || null;

      // Idempotencia: skip si ya existe un override para este member
      const exists = await client.query(
        'SELECT 1 FROM tonic.network_sponsor_overrides WHERE legacy_id = $1 LIMIT 1',
        [row.hijo]
      );
      if (exists.rows.length > 0) return 'skipped';

      // padre = id_customers del sponsor custom
      let customSponsorId = null;
      if (row.padre) {
        const sponsorCustId = await idResolver.resolve(v2Pool, 'customer', row.padre, 'customers');
        if (sponsorCustId) {
          const spMember = await client.query(
            'SELECT id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
            [sponsorCustId]
          );
          if (spMember.rows.length > 0) customSponsorId = spMember.rows[0].id;
        }
      }
      if (!customSponsorId) return 'skipped'; // custom_sponsor_id es NOT NULL

      await client.query(
        `INSERT INTO tonic.network_sponsor_overrides (
          id, member_id, original_sponsor_id, custom_sponsor_id,
          effective_from, legacy_id, is_active, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          '2000-01-01', $4, true, NOW(), NOW()
        )`,
        [memberId, originalSponsorId, customSponsorId, row.hijo]
      );
    },
  }));

  // ==============================================================
  // network_upline_overrides
  // v1 columnas reales: hijo (child customer id), padre (custom upline id),
  //                     puntos, negocio
  // v2 columnas: member_id(NOT NULL), original_upline_id, custom_upline_id(NOT NULL),
  //              upline_level(NOT NULL int), effective_from(NOT NULL date),
  //              effective_to, reason, applied_by, legacy_id, is_active
  // Sin PK en v1. Usamos hijo como legacy_id sintético.
  // ==============================================================
  logger.table('network_upline_overrides', 'Migrando t_red_custom_upline → network_upline_overrides');
  const uplineOverCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_red_custom_upline');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT hijo, padre, puntos, negocio FROM toniclife.t_red_custom_upline ORDER BY hijo',
    tableName: 'network_upline_overrides',
    totalCount: uplineOverCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // hijo = id_customers del hijo (child)
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.hijo, 'customers');
      if (!customerId) return 'skipped';

      const memberResult = await client.query(
        'SELECT id, parent_id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
        [customerId]
      );
      if (memberResult.rows.length === 0) return 'skipped';
      const memberId = memberResult.rows[0].id;
      const originalUplineId = memberResult.rows[0].parent_id || null;

      // Idempotencia: skip si ya existe un override para este member
      const exists = await client.query(
        'SELECT 1 FROM tonic.network_upline_overrides WHERE legacy_id = $1 LIMIT 1',
        [row.hijo]
      );
      if (exists.rows.length > 0) return 'skipped';

      // padre = id_customers del upline custom
      let customUplineId = null;
      if (row.padre) {
        const uplineCustId = await idResolver.resolve(v2Pool, 'customer', row.padre, 'customers');
        if (uplineCustId) {
          const upMember = await client.query(
            'SELECT id FROM tonic.network_members WHERE customer_id = $1 LIMIT 1',
            [uplineCustId]
          );
          if (upMember.rows.length > 0) customUplineId = upMember.rows[0].id;
        }
      }
      if (!customUplineId) return 'skipped'; // custom_upline_id es NOT NULL

      await client.query(
        `INSERT INTO tonic.network_upline_overrides (
          id, member_id, original_upline_id, custom_upline_id,
          upline_level, effective_from, legacy_id, is_active, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          1, '2000-01-01', $4, true, NOW(), NOW()
        )`,
        [memberId, originalUplineId, customUplineId, row.hijo]
      );
    },
  }));

  // ==============================================================
  // network_branch_assignments
  // v1 columnas reales: id_sucu (bigint, referencia a sucursal),
  //                     name (varchar), usuario (varchar)
  // v2 columnas: branch_id(NOT NULL uuid), display_name(varchar 100),
  //              username(varchar 50), legacy_id, is_active
  // ==============================================================
  logger.table('network_branch_assignments', 'Migrando t_red_sucursales → network_branch_assignments');
  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_sucu, name, usuario FROM toniclife.t_red_sucursales ORDER BY id_sucu',
    tableName: 'network_branch_assignments',
    totalCount: await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_red_sucursales'),
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_sucu);
      if (!branchId) return 'skipped';

      // Idempotencia: skip si ya existe con este legacy_id
      const exists = await client.query(
        'SELECT 1 FROM tonic.network_branch_assignments WHERE legacy_id = $1 LIMIT 1',
        [row.id_sucu]
      );
      if (exists.rows.length > 0) return 'skipped';

      const displayName = cleanString(row.name);
      const username = cleanString(row.usuario);

      await client.query(
        `INSERT INTO tonic.network_branch_assignments (
          id, branch_id, display_name, username, legacy_id, is_active, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, true, NOW(), NOW()
        )`,
        [
          branchId,
          displayName ? displayName.substring(0, 100) : null,
          username ? username.substring(0, 50) : null,
          row.id_sucu,
        ]
      );
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 06 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};

function cleanString(val) {
  if (val === null || val === undefined) return null;
  const trimmed = String(val).trim();
  return trimmed === '' ? null : trimmed;
}
