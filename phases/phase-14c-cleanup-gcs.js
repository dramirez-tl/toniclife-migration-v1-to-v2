const logger = require('../utils/logger');
const config = require('../config');

module.exports = async function phase14c(v1Pool, v2Pool) {
  logger.phase('14c', 'Limpiar archivos huérfanos del bucket GCS');

  const errors = [];
  const BUCKET_NAME = 'toniclife-prod';
  const BUCKET_PREFIX = `https://storage.googleapis.com/${BUCKET_NAME}/`;
  const PREFIXES = ['products/', 'customers/', 'purchase-orders/'];
  const DELETE_BATCH = 100;
  const PAGE_SIZE = 1000;

  // Paso 1: Recolectar TODAS las URLs GCS referenciadas en la BD
  logger.info('  Paso 1: Recolectando URLs GCS referenciadas en BD...');
  const referencedPaths = new Set();

  // product_images
  const { rows: r1 } = await v2Pool.query(`SELECT image_url FROM tonic.product_images WHERE image_url LIKE '${BUCKET_PREFIX}%'`);
  for (const r of r1) referencedPaths.add(r.image_url.replace(BUCKET_PREFIX, ''));
  logger.info(`    product_images: ${r1.length}`);

  // customers - todas las columnas de archivos
  for (const col of ['photo_url', 'ine_document_url', 'bank_statement_url', 'tax_id_document_url']) {
    const { rows } = await v2Pool.query(`SELECT ${col} FROM tonic.customers WHERE ${col} LIKE '${BUCKET_PREFIX}%'`);
    for (const r of rows) referencedPaths.add(r[col].replace(BUCKET_PREFIX, ''));
    logger.info(`    customers.${col}: ${rows.length}`);
  }

  // invoices
  const { rows: r3 } = await v2Pool.query(`SELECT xml_file_path FROM tonic.invoices WHERE xml_file_path LIKE '${BUCKET_PREFIX}%'`);
  for (const r of r3) referencedPaths.add(r.xml_file_path.replace(BUCKET_PREFIX, ''));
  logger.info(`    invoices: ${r3.length}`);

  // purchase_orders
  const { rows: r4 } = await v2Pool.query(`SELECT file_url FROM tonic.purchase_orders WHERE file_url LIKE '${BUCKET_PREFIX}%'`);
  for (const r of r4) referencedPaths.add(r.file_url.replace(BUCKET_PREFIX, ''));
  logger.info(`    purchase_orders: ${r4.length}`);

  // system_files
  const { rows: r5 } = await v2Pool.query(`SELECT url FROM tonic.system_files WHERE url LIKE '${BUCKET_PREFIX}%'`);
  for (const r of r5) referencedPaths.add(r.url.replace(BUCKET_PREFIX, ''));
  logger.info(`    system_files: ${r5.length}`);

  logger.info(`    Total archivos únicos referenciados: ${referencedPaths.size}`);

  // Inicializar GCS
  const { Storage } = require('@google-cloud/storage');
  let storage;
  if (config.gcs.credentials) {
    const credentials = JSON.parse(config.gcs.credentials);
    storage = new Storage({ projectId: config.gcs.projectId, credentials });
  } else {
    storage = new Storage({ projectId: config.gcs.projectId });
  }
  const bucket = storage.bucket(BUCKET_NAME);

  // Paso 2+3: Listar por prefijo y eliminar huérfanos sobre la marcha (sin acumular)
  let totalListed = 0;
  let totalKept = 0;
  let totalDeleted = 0;
  let totalDeleteFailed = 0;

  for (const prefix of PREFIXES) {
    logger.info(`  Procesando prefijo: ${prefix}`);
    let prefixListed = 0;
    let prefixKept = 0;
    let prefixDeleted = 0;
    let deleteQueue = [];

    let query = { prefix, maxResults: PAGE_SIZE };
    do {
      const [files, nextQuery] = await bucket.getFiles(query);
      prefixListed += files.length;

      // Separar referenciados de huérfanos
      for (const file of files) {
        if (referencedPaths.has(file.name)) {
          prefixKept++;
        } else {
          deleteQueue.push(file);
        }
      }

      // Eliminar huérfanos en batches cuando se acumulan suficientes
      while (deleteQueue.length >= DELETE_BATCH) {
        const batch = deleteQueue.splice(0, DELETE_BATCH);
        const results = await Promise.allSettled(batch.map(f => f.delete()));
        for (const result of results) {
          if (result.status === 'fulfilled') {
            prefixDeleted++;
          } else {
            totalDeleteFailed++;
            if (totalDeleteFailed <= 10) {
              logger.warn(`    Error eliminando: ${result.reason?.message || result.reason}`);
            }
          }
        }
      }

      if (prefixListed % 5000 === 0 && prefixListed > 0) {
        logger.info(`    ${prefix}: listados ${prefixListed.toLocaleString()}, eliminados ${prefixDeleted.toLocaleString()}, conservados ${prefixKept.toLocaleString()}`);
      }

      query = nextQuery;
    } while (query);

    // Eliminar huérfanos restantes del queue
    if (deleteQueue.length > 0) {
      const results = await Promise.allSettled(deleteQueue.map(f => f.delete()));
      for (const result of results) {
        if (result.status === 'fulfilled') {
          prefixDeleted++;
        } else {
          totalDeleteFailed++;
          if (totalDeleteFailed <= 10) {
            logger.warn(`    Error eliminando: ${result.reason?.message || result.reason}`);
          }
        }
      }
      deleteQueue = [];
    }

    logger.info(`    ${prefix}: ${prefixListed.toLocaleString()} listados, ${prefixDeleted.toLocaleString()} eliminados, ${prefixKept.toLocaleString()} conservados`);

    totalListed += prefixListed;
    totalKept += prefixKept;
    totalDeleted += prefixDeleted;
  }

  // Paso 4: Verificación (conteo ligero por prefijo)
  logger.info('  Paso 4: Verificación...');
  let remainingCount = 0;
  for (const prefix of PREFIXES) {
    let prefixCount = 0;
    let vQuery = { prefix, maxResults: PAGE_SIZE };
    do {
      const [files, nextQuery] = await bucket.getFiles(vQuery);
      prefixCount += files.length;
      vQuery = nextQuery;
    } while (vQuery);
    logger.info(`    ${prefix}: ${prefixCount.toLocaleString()} archivos restantes`);
    remainingCount += prefixCount;
  }

  logger.info(`    Total archivos restantes en bucket: ${remainingCount.toLocaleString()}`);
  logger.info(`    Archivos referenciados en BD: ${referencedPaths.size.toLocaleString()}`);

  if (totalDeleteFailed > 0) {
    errors.push({ error: `${totalDeleteFailed} archivos no pudieron eliminarse` });
  }

  logger.info(`\n  Fase 14c completa: ${totalDeleted.toLocaleString()} eliminados, ${totalKept.toLocaleString()} conservados, ${totalDeleteFailed} fallidos`);
  return { migrated: totalDeleted, skipped: totalKept, failed: totalDeleteFailed, errors };
};
