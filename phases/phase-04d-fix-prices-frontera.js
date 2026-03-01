const logger = require('../utils/logger');

const priceTypeMap = {
  1: 'public',
  2: 'distributor',
  3: 'promotional',
};

module.exports = async function phase04d(v1Pool, v2Pool) {
  logger.phase('04d', 'Actualizar precios Frontera MX-USA desde CEDIS Tijuana (id_branch_office=64)');

  let totalUpdated = 0;
  const errors = [];

  // Paso 1: Cargar precios de v1 sucursal CEDIS Tijuana (id_branch_office = 64)
  logger.info('  Cargando precios de v1 sucursal CEDIS Tijuana (id_branch_office=64)...');
  const { rows: v1Prices } = await v1Pool.query(`
    SELECT p.key_product, pp.id_type_price, pp.price, pp.point, pp.value_business
    FROM toniclife.t_product_price pp
    JOIN toniclife.t_product p ON p.id_product = pp.id_product
    WHERE p.id_branch_office = 64
    ORDER BY p.key_product, pp.id_type_price
  `);
  logger.info(`    ${v1Prices.length} precios Frontera encontrados en v1`);

  if (v1Prices.length === 0) {
    logger.info('  No hay precios Frontera que actualizar.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [] };
  }

  // Paso 2: Resolver country_id de Frontera y UUIDs de price_types
  const { rows: countryRows } = await v2Pool.query("SELECT id FROM tonic.countries WHERE code = 'FN'");
  if (countryRows.length === 0) {
    logger.error('  No se encontró country con code=FN en v2');
    return { migrated: 0, skipped: 0, failed: 1, errors: [{ error: 'Country FN not found' }] };
  }
  const fronteraCountryId = countryRows[0].id;
  logger.info(`    Country FN id: ${fronteraCountryId}`);

  const { rows: ptRows } = await v2Pool.query('SELECT id, code FROM tonic.price_types');
  const ptUuidMap = {};
  for (const row of ptRows) {
    ptUuidMap[row.code] = row.id;
  }

  // Paso 3: UPDATE masivo usando temp table
  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    await v2Client.query(`
      CREATE TEMP TABLE tmp_frontera_prices (
        product_code TEXT NOT NULL,
        price_type_code TEXT NOT NULL,
        price NUMERIC(12,2),
        points NUMERIC(12,2),
        business_value NUMERIC(12,2)
      ) ON COMMIT DROP
    `);

    // Insertar en chunks
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
        params.push(
          row.key_product,
          ptCode,
          row.price || 0,
          row.point || 0,
          row.value_business || 0
        );
      }
      if (values.length > 0) {
        await v2Client.query(`INSERT INTO tmp_frontera_prices VALUES ${values.join(',')}`, params);
      }
    }

    // UPDATE JOIN para precios Frontera
    const result = await v2Client.query(`
      UPDATE tonic.product_prices pp
      SET price = t.price,
          points = t.points,
          business_value = t.business_value,
          updated_at = NOW()
      FROM tmp_frontera_prices t
      JOIN tonic.products p ON p.code = t.product_code
      JOIN tonic.price_types pt ON pt.code = t.price_type_code
      WHERE pp.product_id = p.id
        AND pp.price_type_id = pt.id
        AND pp.country_id = $1
        AND (pp.price != t.price OR pp.points != t.points OR pp.business_value != t.business_value)
    `, [fronteraCountryId]);
    totalUpdated = result.rowCount;
    logger.info(`    ${totalUpdated} precios Frontera actualizados`);

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
  const verify1 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND price > 0", [fronteraCountryId]);
  const verify2 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND points > 0", [fronteraCountryId]);
  const verify3 = await v2Pool.query("SELECT COUNT(*) AS cnt FROM tonic.product_prices WHERE country_id = $1 AND business_value > 0", [fronteraCountryId]);
  logger.info(`    Frontera con price > 0: ${verify1.rows[0].cnt}`);
  logger.info(`    Frontera con points > 0: ${verify2.rows[0].cnt}`);
  logger.info(`    Frontera con business_value > 0: ${verify3.rows[0].cnt}`);

  // Spot check
  const verify4 = await v2Pool.query(`
    SELECT p.code, pt.code AS price_type, pp.price, pp.points, pp.business_value
    FROM tonic.product_prices pp
    JOIN tonic.price_types pt ON pt.id = pp.price_type_id
    JOIN tonic.products p ON p.id = pp.product_id
    WHERE pp.country_id = $1 AND pp.price > 0
    ORDER BY p.code, pt.code
    LIMIT 6
  `, [fronteraCountryId]);
  if (verify4.rows.length > 0) {
    logger.info('  Muestra precios Frontera actualizados:');
    for (const row of verify4.rows) {
      logger.info(`    ${row.code} ${row.price_type}: price=${row.price}, pts=${row.points}, bv=${row.business_value}`);
    }
  }

  logger.info(`\n  Fase 04d completa: ${totalUpdated} actualizados, ${errors.length} fallidos`);
  return { migrated: totalUpdated, skipped: 0, failed: errors.length, errors };
};
