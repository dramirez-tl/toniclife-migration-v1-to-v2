const logger = require('../utils/logger');

const priceTypeMap = {
  1: 'public',
  2: 'distributor',
  3: 'promotional',
};

module.exports = async function phase04b(v1Pool, v2Pool) {
  logger.phase('04b', 'Actualizar points y business_value en product_prices');

  let totalUpdated = 0;
  const errors = [];

  // Paso 1: Cargar precios de v1 SOLO de la sucursal Call Center (id_branch_office = 1)
  logger.info('  Cargando precios con points/business_value desde v1 (sucursal 1)...');
  const { rows: v1Prices } = await v1Pool.query(`
    SELECT p.key_product, pp.id_type_price, pp.point, pp.value_business
    FROM toniclife.t_product_price pp
    JOIN toniclife.t_product p ON p.id_product = pp.id_product
    WHERE p.id_branch_office = 1
      AND (pp.point > 0 OR pp.value_business > 0)
    ORDER BY p.key_product, pp.id_type_price
  `);
  logger.info(`    ${v1Prices.length} precios con points/business_value encontrados en v1`);

  if (v1Prices.length === 0) {
    logger.info('  No hay precios que actualizar.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [] };
  }

  // Paso 2: Resolver UUIDs de price_types
  const { rows: ptRows } = await v2Pool.query('SELECT id, code FROM tonic.price_types');
  const ptUuidMap = {};
  for (const row of ptRows) {
    ptUuidMap[row.code] = row.id;
  }
  logger.info('  price_types encontrados:');
  for (const [code, id] of Object.entries(ptUuidMap)) {
    logger.info(`    ${code}: ${id}`);
  }

  // Paso 3: UPDATE masivo usando temp table
  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    await v2Client.query(`
      CREATE TEMP TABLE tmp_price_update (
        product_code TEXT NOT NULL,
        price_type_code TEXT NOT NULL,
        points NUMERIC(12,2),
        business_value NUMERIC(12,2)
      ) ON COMMIT DROP
    `);

    // Insertar datos en temp table
    const CHUNK = 5000;
    for (let i = 0; i < v1Prices.length; i += CHUNK) {
      const batch = v1Prices.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const ptCode = priceTypeMap[row.id_type_price];
        if (!ptCode) continue;
        const off = params.length;
        values.push(`($${off+1}, $${off+2}, $${off+3}, $${off+4})`);
        params.push(row.key_product, ptCode, row.point || 0, row.value_business || 0);
      }
      if (values.length > 0) {
        await v2Client.query(`INSERT INTO tmp_price_update VALUES ${values.join(',')}`, params);
      }
    }

    // UPDATE JOIN
    const result = await v2Client.query(`
      UPDATE tonic.product_prices pp
      SET points = t.points,
          business_value = t.business_value,
          updated_at = NOW()
      FROM tmp_price_update t
      JOIN tonic.products p ON p.code = t.product_code
      JOIN tonic.price_types pt ON pt.code = t.price_type_code
      WHERE pp.product_id = p.id
        AND pp.price_type_id = pt.id
        AND (pp.points != t.points OR pp.business_value != t.business_value)
    `);
    totalUpdated = result.rowCount;
    logger.info(`    ${totalUpdated} precios actualizados con points/business_value`);

    await v2Client.query('COMMIT');
  } catch (err) {
    try { await v2Client.query('ROLLBACK'); } catch (_) {}
    logger.error(`  Error: ${err.message}`);
    errors.push({ error: err.message });
  } finally {
    v2Client.release();
  }

  // Paso 4: Verificación
  logger.info('  Verificación:');
  const verify1 = await v2Pool.query('SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE points > 0');
  const verify2 = await v2Pool.query('SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE business_value > 0');
  logger.info(`    ${verify1.rows[0].cnt} con points > 0, ${verify2.rows[0].cnt} con business_value > 0`);

  // Spot check Jimmy Coffee
  const verify3 = await v2Pool.query(`
    SELECT pt.code, pp.price, pp.points, pp.business_value
    FROM tonic.product_prices pp
    JOIN tonic.price_types pt ON pt.id = pp.price_type_id
    JOIN tonic.products p ON p.id = pp.product_id
    WHERE p.code = '9019'
    ORDER BY pt.code
  `);
  if (verify3.rows.length > 0) {
    logger.info('  Jimmy Coffee (9019) verificación:');
    for (const row of verify3.rows) {
      logger.info(`    ${row.code}: price=${row.price}, points=${row.points}, bv=${row.business_value}`);
    }
  }

  logger.info(`\n  Fase 04b completa: ${totalUpdated} actualizados, ${errors.length} fallidos`);
  return { migrated: totalUpdated, skipped: 0, failed: errors.length, errors };
};
