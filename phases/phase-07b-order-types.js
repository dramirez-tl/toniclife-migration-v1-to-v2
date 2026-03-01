const logger = require('../utils/logger');

const typeMapping = {
  1: 'ING',
  2: 'EGR',
  3: 'TRASP',
  4: 'PROD',
  5: 'DEV-ALM-GEN',
  6: 'NEW_PROD',
};

module.exports = async function phase07b(v1Pool, v2Pool) {
  logger.phase('07b', 'Asignar document_type_id e is_ecommerce a órdenes');

  let totalUpdated = 0;
  const errors = [];

  // Resolver UUIDs de document_types
  const dtResult = await v2Pool.query('SELECT id, code FROM tonic.document_types');
  const dtMap = {};
  for (const row of dtResult.rows) {
    dtMap[row.code] = row.id;
  }

  const saleTypeId = dtMap['SALE'];
  const ecommPagadoId = dtMap['ECOMMERCE_PAGADO'];

  if (!saleTypeId) {
    logger.error('  No se encontró document_type SALE en v2');
    return { migrated: 0, skipped: 0, failed: 1, errors: [{ error: 'SALE document_type not found' }] };
  }

  logger.info('  document_types encontrados:');
  for (const [code, id] of Object.entries(dtMap)) {
    logger.info(`    ${code}: ${id}`);
  }

  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    // Crear tabla temporal
    await v2Client.query(`
      CREATE TEMP TABLE tmp_order_types (
        legacy_id BIGINT NOT NULL,
        id_type_document INT,
        has_mercado_pago BOOLEAN,
        is_ecommerce_publico BOOLEAN,
        is_anulado BOOLEAN
      ) ON COMMIT DROP
    `);

    // Cargar datos de v1 en chunks
    const CHUNK = 50000;
    let offset = 0;
    let total = 0;
    logger.info('  Cargando tipos de documento desde v1...');

    while (true) {
      const { rows } = await v1Pool.query(`
        SELECT id_document, id_type_document,
               (id_payment_mercado_pago IS NOT NULL) AS has_mp,
               (COALESCE(ecommerce_publico, 0) = 1) AS is_ecomm,
               (COALESCE(anulado, 0) = 1) AS is_anul
        FROM toniclife.t_document
        ORDER BY id_document
        LIMIT ${CHUNK} OFFSET ${offset}
      `);
      if (rows.length === 0) break;

      const values = [];
      const params = [];
      for (let i = 0; i < rows.length; i++) {
        const off = i * 5;
        values.push(`($${off+1}, $${off+2}, $${off+3}, $${off+4}, $${off+5})`);
        params.push(
          rows[i].id_document,
          rows[i].id_type_document,
          rows[i].has_mp,
          rows[i].is_ecomm,
          rows[i].is_anul
        );
      }
      await v2Client.query(
        `INSERT INTO tmp_order_types VALUES ${values.join(',')}`,
        params
      );
      total += rows.length;
      offset += CHUNK;
      logger.progress('cargando tipos', total, 1751004);
    }
    logger.info(`    ${total.toLocaleString()} registros cargados en tabla temporal`);

    // UPDATE 1: document_type_id para tipos 1-6
    logger.info('  Asignando document_type_id por tipo...');
    for (const [typeId, code] of Object.entries(typeMapping)) {
      const dtId = dtMap[code];
      if (!dtId) {
        logger.warn(`    ${code} no encontrado en document_types, saltando`);
        continue;
      }
      const result = await v2Client.query(`
        UPDATE tonic.orders o
        SET document_type_id = $1, updated_at = NOW()
        FROM tmp_order_types t
        WHERE o.legacy_id = t.legacy_id
          AND t.id_type_document = $2
          AND o.document_type_id IS NULL
      `, [dtId, parseInt(typeId)]);
      logger.info(`    ${code} (type=${typeId}): ${result.rowCount.toLocaleString()} actualizados`);
      totalUpdated += result.rowCount;
    }

    // UPDATE 2: E-commerce pagado (Mercado Pago o ecommerce_publico)
    if (ecommPagadoId) {
      const ecommResult = await v2Client.query(`
        UPDATE tonic.orders o
        SET document_type_id = $1,
            is_ecommerce = true,
            updated_at = NOW()
        FROM tmp_order_types t
        WHERE o.legacy_id = t.legacy_id
          AND (t.has_mercado_pago = true OR t.is_ecommerce_publico = true)
          AND o.document_type_id IS NULL
      `, [ecommPagadoId]);
      logger.info(`    ECOMMERCE_PAGADO: ${ecommResult.rowCount.toLocaleString()} actualizados`);
      totalUpdated += ecommResult.rowCount;
    } else {
      logger.warn('    ECOMMERCE_PAGADO no encontrado en document_types, saltando');
    }

    // UPDATE 3: Marcar is_ecommerce para los que ya tienen document_type_id
    const ecommFlagResult = await v2Client.query(`
      UPDATE tonic.orders o
      SET is_ecommerce = true,
          updated_at = NOW()
      FROM tmp_order_types t
      WHERE o.legacy_id = t.legacy_id
        AND (t.has_mercado_pago = true OR t.is_ecommerce_publico = true)
        AND o.is_ecommerce = false
    `);
    logger.info(`    is_ecommerce flag: ${ecommFlagResult.rowCount.toLocaleString()} actualizados`);
    totalUpdated += ecommFlagResult.rowCount;

    // UPDATE 4: Todo lo que queda sin tipo → SALE
    const saleResult = await v2Client.query(`
      UPDATE tonic.orders o
      SET document_type_id = $1, updated_at = NOW()
      WHERE o.document_type_id IS NULL
    `, [saleTypeId]);
    logger.info(`    SALE (default): ${saleResult.rowCount.toLocaleString()} actualizados`);
    totalUpdated += saleResult.rowCount;

    await v2Client.query('COMMIT');
  } catch (err) {
    try { await v2Client.query('ROLLBACK'); } catch (_) {}
    logger.error(`  Error: ${err.message}`);
    errors.push({ error: err.message });
  } finally {
    v2Client.release();
  }

  // Verificación
  logger.info('  Verificación final:');
  const verify = await v2Pool.query(`
    SELECT dt.code, COUNT(*) AS cnt
    FROM tonic.orders o
    LEFT JOIN tonic.document_types dt ON dt.id = o.document_type_id
    GROUP BY dt.code
    ORDER BY cnt DESC
  `);
  for (const row of verify.rows) {
    logger.info(`    ${row.code || 'NULL'}: ${Number(row.cnt).toLocaleString()}`);
  }

  const ecommVerify = await v2Pool.query('SELECT COUNT(*) AS cnt FROM tonic.orders WHERE is_ecommerce = true');
  logger.info(`  Total órdenes e-commerce: ${ecommVerify.rows[0].cnt}`);

  const nullCheck = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.orders WHERE document_type_id IS NULL");
  const nullCount = parseInt(nullCheck.rows[0].cnt);
  if (nullCount > 0) {
    logger.warn(`  Aún quedan ${nullCount} órdenes sin document_type_id`);
  } else {
    logger.info('  0 órdenes sin document_type_id');
  }

  logger.info(`\n  Fase 07b completa: ${totalUpdated.toLocaleString()} actualizados, ${errors.length} fallidos`);
  return { migrated: totalUpdated, skipped: 0, failed: errors.length, errors };
};
