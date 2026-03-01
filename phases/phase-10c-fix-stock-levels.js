const logger = require('../utils/logger');

module.exports = async function phase10c(v1Pool, v2Pool) {
  logger.phase('10c', 'Migrar existencias de inventario desde snapshot feb 2026 de v1');

  let totalUpserted = 0;
  let skipped = 0;
  const errors = [];

  // Paso 1: Cargar snapshot febrero 2026 con stock > 0
  logger.info('  Cargando snapshot de stock feb 2026 con stock > 0...');
  const { rows: v1Stock } = await v1Pool.query(`
    SELECT p.key_product, p.id_branch_office, s.exists_current_qty_product
    FROM toniclife.t_product_stock_snapshot s
    JOIN toniclife.t_product p ON p.id_product = s.id_product
    WHERE s.executed_at >= '2026-02-01'
      AND s.exists_current_qty_product > 0
    ORDER BY p.id_branch_office, p.key_product
  `);
  logger.info(`    ${v1Stock.length} registros de stock encontrados en snapshot feb 2026`);

  if (v1Stock.length === 0) {
    logger.info('  No hay stock que migrar.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [] };
  }

  // Paso 2: Resolver product_id y branch_id en v2
  logger.info('  Resolviendo product_id y branch_id en v2...');
  const { rows: prodRows } = await v2Pool.query('SELECT id, code FROM tonic.products');
  const productMap = {};
  for (const row of prodRows) productMap[row.code] = row.id;
  logger.info(`    ${prodRows.length} productos cargados de v2`);

  const { rows: branchMapRows } = await v2Pool.query(
    "SELECT legacy_id, new_id FROM tonic.legacy_id_map WHERE entity_type = 'branch'"
  );
  const branchMap = {};
  for (const row of branchMapRows) branchMap[String(row.legacy_id)] = row.new_id;
  logger.info(`    ${branchMapRows.length} sucursales mapeadas via legacy_id_map`);

  // Paso 3: UPSERT masivo a stock_levels via temp table
  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    await v2Client.query(`
      CREATE TEMP TABLE tmp_stock (
        product_id UUID NOT NULL,
        branch_id UUID NOT NULL,
        qty NUMERIC NOT NULL
      ) ON COMMIT DROP
    `);

    // Insertar en chunks, resolviendo IDs
    const CHUNK = 5000;
    for (let i = 0; i < v1Stock.length; i += CHUNK) {
      const batch = v1Stock.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (const row of batch) {
        const productId = productMap[row.key_product];
        const branchId = branchMap[String(row.id_branch_office)];
        if (!productId || !branchId) { skipped++; continue; }
        const off = params.length;
        values.push(`($${off+1}, $${off+2}, $${off+3})`);
        params.push(productId, branchId, parseFloat(row.exists_current_qty_product));
      }
      if (values.length > 0) {
        await v2Client.query(`INSERT INTO tmp_stock VALUES ${values.join(',')}`, params);
      }
    }
    logger.info(`    ${skipped} registros omitidos (producto o sucursal no encontrados en v2)`);

    // UPSERT: INSERT o UPDATE si ya existe
    const result = await v2Client.query(`
      INSERT INTO tonic.stock_levels (id, product_id, branch_id, quantity_on_hand, quantity_available, quantity_reserved, quantity_in_transit, last_movement_at)
      SELECT gen_random_uuid(), t.product_id, t.branch_id, t.qty, t.qty, 0, 0, NOW()
      FROM tmp_stock t
      ON CONFLICT (product_id, branch_id) DO UPDATE SET
        quantity_on_hand = EXCLUDED.quantity_on_hand,
        quantity_available = EXCLUDED.quantity_available,
        last_movement_at = NOW()
    `);
    totalUpserted = result.rowCount;
    logger.info(`    ${totalUpserted} stock_levels insertados/actualizados`);

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
  const verify1 = await v2Pool.query('SELECT COUNT(*) AS total FROM tonic.stock_levels');
  const verify2 = await v2Pool.query('SELECT COUNT(*) AS con_stock FROM tonic.stock_levels WHERE quantity_on_hand > 0');
  logger.info(`    Total stock_levels: ${verify1.rows[0].total}`);
  logger.info(`    Con stock > 0: ${verify2.rows[0].con_stock}`);

  const verify3 = await v2Pool.query(`
    SELECT b.name, COUNT(*) AS productos, SUM(sl.quantity_on_hand) AS total
    FROM tonic.stock_levels sl
    JOIN tonic.branches b ON b.id = sl.branch_id
    WHERE sl.quantity_on_hand > 0
    GROUP BY b.name
    ORDER BY total DESC
    LIMIT 10
  `);
  if (verify3.rows.length > 0) {
    logger.info('  Top 10 sucursales por stock:');
    for (const row of verify3.rows) {
      logger.info(`    ${row.name}: ${row.productos} productos, ${Number(row.total).toLocaleString()} unidades`);
    }
  }

  // Spot check producto 8289
  const verify4 = await v2Pool.query(`
    SELECT b.name, sl.quantity_on_hand
    FROM tonic.stock_levels sl
    JOIN tonic.branches b ON b.id = sl.branch_id
    JOIN tonic.products p ON p.id = sl.product_id
    WHERE p.code = '8289' AND sl.quantity_on_hand > 0
    ORDER BY sl.quantity_on_hand DESC
  `);
  if (verify4.rows.length > 0) {
    logger.info(`  Producto 8289 en ${verify4.rows.length} sucursales:`);
    for (const row of verify4.rows) {
      logger.info(`    ${row.name}: ${Number(row.quantity_on_hand).toLocaleString()}`);
    }
  }

  logger.info(`\n  Fase 10c completa: ${totalUpserted} upserted, ${skipped} omitidos, ${errors.length} fallidos`);
  return { migrated: totalUpserted, skipped, failed: errors.length, errors };
};
