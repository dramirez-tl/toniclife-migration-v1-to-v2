const logger = require('../utils/logger');

module.exports = async function phase14b(v1Pool, v2Pool) {
  logger.phase('14b', 'Deduplicar imágenes de productos');

  let totalDeleted = 0;
  let primaryFixed = 0;
  const errors = [];

  // Estado inicial
  const before = await v2Pool.query('SELECT COUNT(*) AS total FROM tonic.product_images');
  logger.info(`  Estado inicial: ${before.rows[0].total} imágenes`);

  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    // Paso 1: Eliminar TODAS las imágenes con URL de tonic-life.net
    logger.info('  Paso 1: Eliminando imágenes con URL tonic-life.net...');
    const del1 = await v2Client.query("DELETE FROM tonic.product_images WHERE image_url LIKE 'https://tonic-life.net/%'");
    logger.info(`    ${del1.rowCount} imágenes tonic-life.net eliminadas`);
    totalDeleted += del1.rowCount;

    // Paso 2: Deduplicar imágenes GCS (1 por product_id + filename)
    logger.info('  Paso 2: Deduplicando imágenes GCS por (product_id, filename)...');
    const del2 = await v2Client.query(`
      DELETE FROM tonic.product_images
      WHERE id NOT IN (
        SELECT DISTINCT ON (product_id, SUBSTRING(image_url FROM '[^/]+$'))
          id
        FROM tonic.product_images
        WHERE image_url LIKE 'https://storage.googleapis.com/%'
        ORDER BY product_id, SUBSTRING(image_url FROM '[^/]+$'), is_primary DESC, id ASC
      )
    `);
    logger.info(`    ${del2.rowCount} duplicados GCS eliminados`);
    totalDeleted += del2.rowCount;

    // Paso 3: Asegurar 1 primary por producto
    logger.info('  Paso 3: Asegurando 1 is_primary por producto...');
    const fix = await v2Client.query(`
      UPDATE tonic.product_images pi
      SET is_primary = true
      WHERE pi.id IN (
        SELECT DISTINCT ON (product_id) id
        FROM tonic.product_images
        WHERE product_id NOT IN (
          SELECT product_id FROM tonic.product_images WHERE is_primary = true
        )
        ORDER BY product_id, sort_order ASC, id ASC
      )
    `);
    primaryFixed = fix.rowCount;
    logger.info(`    ${primaryFixed} productos sin primary corregidos`);

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
  const r1 = await v2Pool.query('SELECT COUNT(*) AS total FROM tonic.product_images');
  logger.info(`    Total imágenes: ${r1.rows[0].total}`);

  const r2 = await v2Pool.query('SELECT ROUND(AVG(cnt)) AS avg, MIN(cnt) AS min, MAX(cnt) AS max FROM (SELECT COUNT(*) AS cnt FROM tonic.product_images GROUP BY product_id) t');
  logger.info(`    Por producto: avg=${r2.rows[0].avg}, min=${r2.rows[0].min}, max=${r2.rows[0].max}`);

  const r3 = await v2Pool.query('SELECT COUNT(DISTINCT product_id) AS con_primary FROM tonic.product_images WHERE is_primary = true');
  const r4 = await v2Pool.query('SELECT COUNT(DISTINCT product_id) AS total_productos FROM tonic.product_images');
  logger.info(`    Productos con primary: ${r3.rows[0].con_primary}/${r4.rows[0].total_productos}`);

  // Spot check 8289
  const r5 = await v2Pool.query(`
    SELECT pi.image_url, pi.is_primary
    FROM tonic.product_images pi
    JOIN tonic.products p ON p.id = pi.product_id
    WHERE p.code = '8289'
    ORDER BY pi.is_primary DESC
  `);
  if (r5.rows.length > 0) {
    logger.info(`  Producto 8289 (${r5.rows.length} imágenes):`);
    for (const row of r5.rows) {
      const filename = row.image_url.split('/').pop();
      logger.info(`    ${row.is_primary ? '[PRIMARY]' : '         '} ${filename}`);
    }
  }

  logger.info(`\n  Fase 14b completa: ${totalDeleted} eliminadas, ${primaryFixed} primary corregidos, ${errors.length} fallidos`);
  return { migrated: totalDeleted, skipped: 0, failed: errors.length, errors };
};
