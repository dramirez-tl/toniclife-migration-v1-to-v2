const logger = require('../utils/logger');
const { enableAllTriggers } = require('../utils/trigger-manager');

/**
 * Ejecuta un query con statement_timeout para evitar bloqueos indefinidos.
 * Adquiere un client dedicado, setea el timeout, ejecuta, y resetea.
 * @param {import('pg').Pool} pool
 * @param {string} sql
 * @param {number} timeoutMs - Timeout en milisegundos (0 = sin límite)
 * @returns {Promise<import('pg').QueryResult>}
 */
async function timedQuery(pool, sql, timeoutMs = 60000) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '${timeoutMs}'`);
    const result = await client.query(sql);
    await client.query(`SET statement_timeout = '0'`);
    return result;
  } catch (err) {
    // Resetear timeout antes de liberar (puede fallar si la conexión murió)
    await client.query(`SET statement_timeout = '0'`).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Formatea duración en segundos */
function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1);
}

module.exports = async function phase99(v1Pool, v2Pool) {
  logger.phase('99', 'Post-Migración y Validación');
  const issues = [];

  const phase99Start = Date.now();

  // =============================================
  // 1. Re-habilitar triggers
  // =============================================
  const step1Start = Date.now();
  logger.info('Paso 1: Re-habilitando triggers...');
  try {
    await enableAllTriggers(v2Pool);
    logger.info('  ✓ Triggers re-habilitados');
  } catch (err) {
    issues.push(`Error re-habilitando triggers: ${err.message}`);
    logger.error(`  ✗ ${err.message}`);
  }
  logger.info(`  Paso 1 completado en ${elapsed(step1Start)}s`);

  // =============================================
  // 2. Restaurar CHECK constraints (con timeout 30s)
  // =============================================
  const step2Start = Date.now();
  logger.info('\nPaso 2: Restaurando CHECK constraints...');

  const checkConstraints = [
    {
      label: 'network_members (chk_network_members_root_depth)',
      sql: `ALTER TABLE tonic.network_members
            ADD CONSTRAINT chk_network_members_root_depth
            CHECK ((depth = 0 AND parent_id IS NULL) OR (depth > 0 AND parent_id IS NOT NULL))`,
    },
    {
      label: 'stock_levels (chk_stock_levels_qty_on_hand)',
      sql: `ALTER TABLE tonic.stock_levels
            ADD CONSTRAINT chk_stock_levels_qty_on_hand
            CHECK (quantity_on_hand >= 0)`,
    },
  ];

  for (let i = 0; i < checkConstraints.length; i++) {
    const cc = checkConstraints[i];
    logger.info(`  [${i + 1}/${checkConstraints.length}] Restaurando ${cc.label}...`);
    try {
      await timedQuery(v2Pool, cc.sql, 30000);
      logger.info(`  ✓ ${cc.label} restaurado`);
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${cc.label}: timeout (>30s) — se omite, verificar manualmente`);
        issues.push(`CHECK constraint ${cc.label}: timeout restaurando`);
      } else if (err.message.includes('already exists')) {
        logger.info(`  ✓ ${cc.label} ya existe`);
      } else {
        logger.warn(`  ⚠ ${cc.label}: ${err.message}`);
        issues.push(`CHECK constraint ${cc.label}: ${err.message}`);
      }
    }
  }
  logger.info(`  Paso 2 completado en ${elapsed(step2Start)}s`);

  // =============================================
  // 3. Actualizar sequence_counters
  // =============================================
  const step3Start = Date.now();
  logger.info('\nPaso 3: Actualizando sequence_counters...');
  let seqUpdated = 0;
  const sequences = [
    {
      name: 'customer_number',
      query: `SELECT COALESCE(MAX(
        CASE WHEN customer_number ~ '^[0-9]+$'
             THEN customer_number::bigint
             ELSE 0 END
      ), 0) AS max_val FROM tonic.customers`,
    },
    {
      name: 'order_number',
      query: `SELECT COALESCE(MAX(
        CASE WHEN order_number ~ '^MIG-[0-9]+$'
             THEN SUBSTRING(order_number FROM 5)::bigint
             WHEN order_number ~ '^[0-9]+$'
             THEN order_number::bigint
             ELSE 0 END
      ), 0) AS max_val FROM tonic.orders`,
    },
    {
      name: 'invoice_number',
      query: `SELECT COALESCE(MAX(
        CASE WHEN invoice_number ~ '^INV-[0-9]+$'
             THEN SUBSTRING(invoice_number FROM 5)::bigint
             WHEN invoice_number ~ '^[0-9]+$'
             THEN invoice_number::bigint
             ELSE 0 END
      ), 0) AS max_val FROM tonic.invoices`,
    },
    {
      name: 'employee_number',
      query: `SELECT COALESCE(MAX(
        CASE WHEN employee_number ~ '^EMP-[0-9]+$'
             THEN SUBSTRING(employee_number FROM 5)::bigint
             WHEN employee_number ~ '^[0-9]+$'
             THEN employee_number::bigint
             ELSE 0 END
      ), 0) AS max_val FROM tonic.employees`,
    },
    {
      name: 'vacation_request_number',
      query: `SELECT COALESCE(MAX(
        CASE WHEN request_number ~ '^VAC-[0-9]+$'
             THEN SUBSTRING(request_number FROM 5)::bigint
             WHEN request_number ~ '^[0-9]+$'
             THEN request_number::bigint
             ELSE 0 END
      ), 0) AS max_val FROM tonic.vacation_requests`,
    },
  ];

  const currentYear = new Date().getFullYear();
  for (let i = 0; i < sequences.length; i++) {
    const seq = sequences[i];
    logger.info(`  [${i + 1}/${sequences.length}] Calculando máximo para ${seq.name}...`);
    try {
      const { rows } = await timedQuery(v2Pool, seq.query, 60000);
      const maxVal = rows[0]?.max_val || 0;
      await v2Pool.query(
        `INSERT INTO tonic.sequence_counters (sequence_name, sequence_year, current_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (sequence_name, sequence_year)
         DO UPDATE SET current_value = GREATEST(tonic.sequence_counters.current_value, $3)`,
        [seq.name, currentYear, maxVal]
      );
      logger.info(`  ✓ ${seq.name}: ${maxVal}`);
      seqUpdated++;
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${seq.name}: timeout (>60s) — se omite`);
        issues.push(`Sequence ${seq.name}: timeout calculando máximo`);
      } else {
        issues.push(`Error actualizando sequence ${seq.name}: ${err.message}`);
        logger.error(`  ✗ ${seq.name}: ${err.message}`);
      }
    }
  }
  logger.info(`  Paso 3 completado en ${elapsed(step3Start)}s. ${seqUpdated}/${sequences.length} secuencias actualizadas.`);

  // =============================================
  // 4. Validar conteos v1 vs v2
  // =============================================
  const step4Start = Date.now();
  logger.info('\nPaso 4: Validando conteos v1 vs v2...');
  const countChecks = [
    { v1: 'toniclife.t_country', v2: 'tonic.countries', label: 'countries' },
    { v1: 'toniclife.t_type_money', v2: 'tonic.currencies', label: 'currencies' },
    { v1: 'toniclife.t_type_price', v2: 'tonic.price_types', label: 'price_types' },
    { v1: 'toniclife.t_branch_office', v2: 'tonic.branches', label: 'branches' },
    { v1: 'toniclife.t_profile', v2: 'tonic.roles', label: 'roles' },
    { v1: 'toniclife.t_worker', v2: 'tonic.workers', label: 'workers' },
    { v1: 'toniclife.t_users', v2: 'tonic.users', label: 'users' },
    { v1: 'toniclife.t_product', v2: 'tonic.products', label: 'products' },
    { v1: 'toniclife.t_product_price', v2: 'tonic.product_prices', label: 'product_prices' },
    { v1: 'toniclife.t_customers', v2: 'tonic.customers', label: 'customers' },
    { v1: 'toniclife.t_customers_address', v2: 'tonic.customer_addresses', label: 'customer_addresses' },
    { v1: 'toniclife.t_document', v2: 'tonic.orders', label: 'orders' },
    { v1: 'toniclife.t_document_det', v2: 'tonic.order_items', label: 'order_items' },
    { v1: 'toniclife.t_period', v2: 'tonic.commission_periods', label: 'commission_periods' },
    { v1: 'toniclife.t_employees', v2: 'tonic.employees', label: 'employees' },
    { v1: 'toniclife.t_departments', v2: 'tonic.departments', label: 'departments' },
    { v1: 'toniclife.t_holidays', v2: 'tonic.holidays', label: 'holidays' },
    { v1: 'toniclife.t_notification', v2: 'tonic.notifications', label: 'notifications' },
    { v1: 'toniclife.t_logs', v2: 'tonic.access_logs', label: 'access_logs' },
  ];

  const countResults = [];
  for (let i = 0; i < countChecks.length; i++) {
    const check = countChecks[i];
    logger.info(`  [${i + 1}/${countChecks.length}] Comparando ${check.label}...`);
    try {
      const v1Res = await timedQuery(v1Pool, `SELECT COUNT(*) AS c FROM ${check.v1}`, 60000);
      const v2Res = await timedQuery(v2Pool, `SELECT COUNT(*) AS c FROM ${check.v2}`, 60000);
      const v1Count = v1Res.rows[0].c;
      const v2Count = v2Res.rows[0].c;
      const diff = Number(v1Count) - Number(v2Count);
      const pct = Number(v1Count) > 0 ? ((Number(v2Count) / Number(v1Count)) * 100).toFixed(1) : 'N/A';
      const status = diff === 0 ? '✓' : diff > 0 ? '⚠' : '✓+';
      logger.info(`  ${status} ${check.label}: v1=${Number(v1Count).toLocaleString()} -> v2=${Number(v2Count).toLocaleString()} (${pct}%)`);
      countResults.push({ table: check.label, v1: Number(v1Count), v2: Number(v2Count), diff, pct });
      if (diff > 0) {
        issues.push(`${check.label}: faltan ${diff} registros (v1=${v1Count}, v2=${v2Count})`);
      }
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${check.label}: timeout (>60s) — se omite`);
      } else {
        logger.error(`  ✗ ${check.label}: ${err.message}`);
      }
      countResults.push({ table: check.label, v1: '?', v2: '?', error: err.message });
    }
  }

  const countIssues = countResults.filter(r => r.diff > 0).length;
  logger.info(`  Paso 4 completado en ${elapsed(step4Start)}s. ${countResults.length} tablas verificadas, ${countIssues} con diferencias.`);

  // =============================================
  // 5. Verificar integridad referencial (timeout 60s por query)
  // =============================================
  const step5Start = Date.now();
  logger.info('\nPaso 5: Verificando integridad referencial...');
  const fkChecks = [
    {
      label: 'orders -> customers',
      sql: `SELECT COUNT(*) AS c FROM tonic.orders o
            WHERE o.customer_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.customers c WHERE c.id = o.customer_id)`,
    },
    {
      label: 'orders -> branches',
      sql: `SELECT COUNT(*) AS c FROM tonic.orders o
            WHERE o.branch_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.branches b WHERE b.id = o.branch_id)`,
    },
    {
      label: 'order_items -> orders',
      sql: `SELECT COUNT(*) AS c FROM tonic.order_items oi
            WHERE NOT EXISTS (SELECT 1 FROM tonic.orders o WHERE o.id = oi.order_id)`,
    },
    {
      label: 'order_items -> products',
      sql: `SELECT COUNT(*) AS c FROM tonic.order_items oi
            WHERE oi.product_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.products p WHERE p.id = oi.product_id)`,
    },
    {
      label: 'users -> roles',
      sql: `SELECT COUNT(*) AS c FROM tonic.users u
            WHERE u.role_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.roles r WHERE r.id = u.role_id)`,
    },
    {
      label: 'customers -> branches',
      sql: `SELECT COUNT(*) AS c FROM tonic.customers c
            WHERE c.branch_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.branches b WHERE b.id = c.branch_id)`,
    },
    {
      label: 'network_members -> customers',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members nm
            WHERE NOT EXISTS (SELECT 1 FROM tonic.customers c WHERE c.id = nm.customer_id)`,
    },
    {
      label: 'employees -> departments',
      sql: `SELECT COUNT(*) AS c FROM tonic.employees e
            WHERE e.department_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tonic.departments d WHERE d.id = e.department_id)`,
    },
  ];

  let fkOrphanCount = 0;
  for (let i = 0; i < fkChecks.length; i++) {
    const check = fkChecks[i];
    logger.info(`  [${i + 1}/${fkChecks.length}] Verificando ${check.label}...`);
    try {
      const { rows } = await timedQuery(v2Pool, check.sql, 60000);
      const orphans = Number(rows[0].c);
      if (orphans > 0) {
        logger.warn(`  ⚠ ${check.label}: ${orphans} registros huérfanos`);
        issues.push(`FK huérfana ${check.label}: ${orphans} registros`);
        fkOrphanCount += orphans;
      } else {
        logger.info(`  ✓ ${check.label}: OK`);
      }
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${check.label}: timeout (>60s) — se omite`);
        issues.push(`FK check ${check.label}: timeout`);
      } else {
        logger.error(`  ✗ ${check.label}: ${err.message}`);
      }
    }
  }
  logger.info(`  Paso 5 completado en ${elapsed(step5Start)}s. ${fkOrphanCount === 0 ? 'Sin huérfanos.' : `${fkOrphanCount} huérfanos encontrados.`}`);

  // =============================================
  // 6. Verificar consistencia de red MLM (timeout 60s por query)
  // =============================================
  const step6Start = Date.now();
  logger.info('\nPaso 6: Verificando consistencia de red MLM...');
  const networkChecks = [
    {
      label: 'Nodos raíz con depth != 0',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members
            WHERE parent_id IS NULL AND depth != 0`,
    },
    {
      label: 'Nodos no-raíz con depth = 0',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members
            WHERE parent_id IS NOT NULL AND depth = 0`,
    },
    {
      label: 'Nodos con path vacío',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members
            WHERE path IS NULL OR path = ''`,
    },
    {
      label: 'children_count inconsistente',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members nm
            WHERE nm.children_count != (
              SELECT COUNT(*) FROM tonic.network_members child
              WHERE child.parent_id = nm.id
            )`,
    },
    {
      label: 'Ciclos en red (parent_id = id)',
      sql: `SELECT COUNT(*) AS c FROM tonic.network_members
            WHERE parent_id = id`,
    },
  ];

  let networkIssueCount = 0;
  for (let i = 0; i < networkChecks.length; i++) {
    const check = networkChecks[i];
    logger.info(`  [${i + 1}/${networkChecks.length}] Verificando ${check.label.toLowerCase()}...`);
    try {
      const { rows } = await timedQuery(v2Pool, check.sql, 60000);
      const count = Number(rows[0].c);
      if (count > 0) {
        logger.warn(`  ⚠ ${check.label}: ${count}`);
        issues.push(`Red MLM — ${check.label}: ${count}`);
        networkIssueCount++;
      } else {
        logger.info(`  ✓ ${check.label}: OK`);
      }
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${check.label}: timeout (>60s) — se omite`);
        issues.push(`Red MLM — ${check.label}: timeout`);
      } else {
        logger.error(`  ✗ ${check.label}: ${err.message}`);
      }
    }
  }
  logger.info(`  Paso 6 completado en ${elapsed(step6Start)}s. ${networkIssueCount === 0 ? 'Red consistente.' : `${networkIssueCount} problemas detectados.`}`);

  // =============================================
  // 7. Spot-check de registros aleatorios (timeout 60s por query)
  // =============================================
  const step7Start = Date.now();
  logger.info('\nPaso 7: Spot-check de registros aleatorios...');
  const spotChecks = [
    {
      label: 'Customer con datos completos',
      sql: `SELECT c.id, c.customer_number, c.first_name, c.last_name,
                   c.branch_id, c.price_type_id, c.legacy_id
            FROM tonic.customers c
            WHERE c.legacy_id IS NOT NULL
            ORDER BY RANDOM() LIMIT 3`,
    },
    {
      label: 'Order con items',
      sql: `SELECT o.id, o.order_number, o.status, o.total, o.legacy_id,
                   (SELECT COUNT(*) FROM tonic.order_items oi WHERE oi.order_id = o.id) AS item_count
            FROM tonic.orders o
            WHERE o.legacy_id IS NOT NULL
            ORDER BY RANDOM() LIMIT 3`,
    },
    {
      label: 'Network member con path',
      sql: `SELECT nm.id, nm.depth, nm.path, nm.children_count, nm.legacy_id,
                   c.customer_number
            FROM tonic.network_members nm
            JOIN tonic.customers c ON c.id = nm.customer_id
            ORDER BY RANDOM() LIMIT 3`,
    },
    {
      label: 'User con password encriptada',
      sql: `SELECT u.id, u.username, u.status, u.is_migrated_user,
                   CASE WHEN u.password_hash IS NOT NULL THEN 'SET' ELSE 'NULL' END AS pwd_status
            FROM tonic.users u
            WHERE u.legacy_id IS NOT NULL
            ORDER BY RANDOM() LIMIT 3`,
    },
  ];

  for (let i = 0; i < spotChecks.length; i++) {
    const check = spotChecks[i];
    logger.info(`  [${i + 1}/${spotChecks.length}] Consultando ${check.label.toLowerCase()}...`);
    try {
      const { rows } = await timedQuery(v2Pool, check.sql, 60000);
      logger.info(`  ${check.label} (${rows.length} muestras):`);
      for (const row of rows) {
        logger.info(`    -> ${JSON.stringify(row)}`);
      }
    } catch (err) {
      const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
      if (isTimeout) {
        logger.warn(`  ⚠ ${check.label}: timeout (>60s) — se omite`);
      } else {
        logger.error(`  ✗ ${check.label}: ${err.message}`);
      }
    }
  }
  logger.info(`  Paso 7 completado en ${elapsed(step7Start)}s.`);

  // =============================================
  // 8. Resumen de legacy_id_map (timeout 60s)
  // =============================================
  const step8Start = Date.now();
  logger.info('\nPaso 8: Resumen de legacy_id_map...');
  let totalMappings = 0;
  try {
    const { rows } = await timedQuery(v2Pool, `
      SELECT entity_type, COUNT(*) AS count
      FROM tonic.legacy_id_map
      GROUP BY entity_type
      ORDER BY count DESC
    `, 60000);
    logger.info('  Mapeos registrados por tipo:');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      logger.info(`    [${i + 1}/${rows.length}] ${row.entity_type}: ${Number(row.count).toLocaleString()}`);
      totalMappings += Number(row.count);
    }
    logger.info(`  Total de mapeos: ${totalMappings.toLocaleString()}`);
  } catch (err) {
    const isTimeout = err.message.includes('statement timeout') || err.message.includes('canceling statement');
    if (isTimeout) {
      logger.warn('  ⚠ legacy_id_map: timeout (>60s) — se omite');
    } else {
      logger.error(`  ✗ legacy_id_map: ${err.message}`);
    }
  }
  logger.info(`  Paso 8 completado en ${elapsed(step8Start)}s.`);

  // =============================================
  // Resumen final
  // =============================================
  const phase99Duration = elapsed(phase99Start);
  logger.info('\n' + '='.repeat(60));
  if (issues.length === 0) {
    logger.info('VALIDACION COMPLETA — No se encontraron problemas');
  } else {
    logger.warn(`VALIDACION COMPLETA — ${issues.length} problemas encontrados:`);
    for (const issue of issues) {
      logger.warn(`  - ${issue}`);
    }
  }
  logger.info('='.repeat(60));
  logger.info(`\nPost-migracion completada. Todos los pasos finalizados. (${phase99Duration}s)`);

  return {
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    validation: {
      issues,
      countResults,
      passed: issues.length === 0,
    },
  };
};
