const logger = require('../utils/logger');

const priceTypeMap = {
  1: 'public',
  2: 'distributor',
  3: 'promotional',
};

const USD_TO_COP = 3750;

module.exports = async function phase04f(v1Pool, v2Pool) {
  logger.phase('04f', 'Actualizar precios Colombia desde sucursal COLOMBIA CALI (id_branch_office=123) con conversión USD→COP');

  let totalUpdated = 0;
  const errors = [];

  // Paso 1: Cargar precios de v1 sucursal Colombia Cali (id_branch_office = 123)
  logger.info('  Cargando precios de v1 sucursal Colombia Cali (id_branch_office=123)...');
  const { rows: v1Prices } = await v1Pool.query(`
    SELECT p.key_product, pp.id_type_price, pp.price, pp.point, pp.value_business
    FROM toniclife.t_product_price pp
    JOIN toniclife.t_product p ON p.id_product = pp.id_product
    WHERE p.id_branch_office = 123
    ORDER BY p.key_product, pp.id_type_price
  `);
  logger.info(`    ${v1Prices.length} precios Colombia encontrados en v1`);

  if (v1Prices.length === 0) {
    logger.info('  No hay precios Colombia que actualizar.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [] };
  }

  // Paso 2: Resolver country_id de Colombia y UUIDs de price_types
  const { rows: countryRows } = await v2Pool.query("SELECT id FROM tonic.countries WHERE code = 'CO'");
  if (countryRows.length === 0) {
    logger.error('  No se encontró country con code=CO en v2');
    return { migrated: 0, skipped: 0, failed: 1, errors: [{ error: 'Country CO not found' }] };
  }
  const colombiaCountryId = countryRows[0].id;
  logger.info(`    Country CO id: ${colombiaCountryId}`);

  const { rows: ptRows } = await v2Pool.query('SELECT id, code FROM tonic.price_types');
  const ptUuidMap = {};
  for (const row of ptRows) {
    ptUuidMap[row.code] = row.id;
  }

  // Paso 3: UPDATE masivo usando temp table (con conversión USD→COP en price)
  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    await v2Client.query(`
      CREATE TEMP TABLE tmp_colombia_prices (
        product_code TEXT NOT NULL,
        price_type_code TEXT NOT NULL,
        price NUMERIC(12,2),
        points NUMERIC(12,2),
        business_value NUMERIC(12,2)
      ) ON COMMIT DROP
    `);

    // Insertar en chunks con conversión USD→COP en price
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
        values.push(`($${off+1}, $${off+2}, $${off+3}, $${off+4}, $${off+5})`);
        const convertedPrice = Math.round((parseFloat(row.price) || 0) * USD_TO_COP * 100) / 100;
        params.push(
          row.key_product,
          ptCode,
          convertedPrice,
          row.point || 0,
          row.value_business || 0
        );
      }
      if (values.length > 0) {
        await v2Client.query(`INSERT INTO tmp_colombia_prices VALUES ${values.join(',')}`, params);
      }
    }

    // UPDATE JOIN para precios Colombia
    const result = await v2Client.query(`
      UPDATE tonic.product_prices pp
      SET price = t.price,
          points = t.points,
          business_value = t.business_value,
          updated_at = NOW()
      FROM tmp_colombia_prices t
      JOIN tonic.products p ON p.code = t.product_code
      JOIN tonic.price_types pt ON pt.code = t.price_type_code
      WHERE pp.product_id = p.id
        AND pp.price_type_id = pt.id
        AND pp.country_id = $1
        AND (pp.price != t.price OR pp.points != t.points OR pp.business_value != t.business_value)
    `, [colombiaCountryId]);
    totalUpdated = result.rowCount;
    logger.info(`    ${totalUpdated} precios Colombia actualizados (USD→COP x${USD_TO_COP})`);

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
  const verify1 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND price > 0", [colombiaCountryId]);
  const verify2 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND points > 0", [colombiaCountryId]);
  const verify3 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND business_value > 0", [colombiaCountryId]);
  logger.info(`    Colombia con price > 0: ${verify1.rows[0].cnt}`);
  logger.info(`    Colombia con points > 0: ${verify2.rows[0].cnt}`);
  logger.info(`    Colombia con business_value > 0: ${verify3.rows[0].cnt}`);

  // Spot check
  const verify4 = await v2Pool.query(`
    SELECT p.code, pt.code AS price_type, pp.price, pp.points, pp.business_value
    FROM tonic.product_prices pp
    JOIN tonic.price_types pt ON pt.id = pp.price_type_id
    JOIN tonic.products p ON p.id = pp.product_id
    WHERE pp.country_id = $1 AND pp.price > 0
    ORDER BY p.code, pt.code
    LIMIT 6
  `, [colombiaCountryId]);
  if (verify4.rows.length > 0) {
    logger.info('  Muestra precios Colombia actualizados (ya en COP):');
    for (const row of verify4.rows) {
      logger.info(`    ${row.code} ${row.price_type}: price=${row.price}, pts=${row.points}, bv=${row.business_value}`);
    }
  }

  logger.info(`\n  Fase 04f completa: ${totalUpdated} actualizados, ${errors.length} fallidos`);
  return { migrated: totalUpdated, skipped: 0, failed: errors.length, errors };
};
