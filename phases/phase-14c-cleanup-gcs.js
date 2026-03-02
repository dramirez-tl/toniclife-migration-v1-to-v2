const logger = require('../utils/logger');
const config = require('../config');

module.exports = async function phase14c(v1Pool, v2Pool) {
  logger.phase('14c', 'Limpiar archivos huérfanos del bucket GCS');

  const errors = [];
  const BUCKET_NAME = 'toniclife-prod';
  const BUCKET_PREFIX = `https://storage.googleapis.com/${BUCKET_NAME}/`;

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

  // Paso 2: Listar TODOS los archivos del bucket
  logger.info('  Paso 2: Listando archivos del bucket GCS...');
  const { Storage } = require('@google-cloud/storage');

  let storage;
  if (config.gcs.credentials) {
    const credentials = JSON.parse(config.gcs.credentials);
    storage = new Storage({ projectId: config.gcs.projectId, credentials });
  } else {
    storage = new Storage({ projectId: config.gcs.projectId });
  }

  const bucket = storage.bucket(BUCKET_NAME);

  let allFiles = [];
  let query = {};
  do {
    const [files, nextQuery] = await bucket.getFiles(query);
    allFiles = allFiles.concat(files);
    if (allFiles.length % 10000 === 0) {
      logger.info(`    Listados: ${allFiles.length.toLocaleString()} archivos...`);
    }
    query = nextQuery;
  } while (query);

  logger.info(`    ${allFiles.length.toLocaleString()} archivos en bucket`);

  // Paso 3: Identificar y eliminar huérfanos
  logger.info('  Paso 3: Identificando archivos huérfanos...');
  const orphans = allFiles.filter(f => !referencedPaths.has(f.name));
  const kept = allFiles.length - orphans.length;
  logger.info(`    ${kept.toLocaleString()} archivos referenciados (se conservan)`);
  logger.info(`    ${orphans.length.toLocaleString()} archivos huérfanos a eliminar`);

  if (orphans.length === 0) {
    logger.info('  No hay archivos huérfanos que eliminar.');
    return { migrated: 0, skipped: kept, failed: 0, errors: [] };
  }

  let deleted = 0;
  let deleteFailed = 0;
  const BATCH = 100;
  for (let i = 0; i < orphans.length; i += BATCH) {
    const batch = orphans.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(f => f.delete()));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        deleted++;
      } else {
        deleteFailed++;
        if (deleteFailed <= 10) {
          logger.warn(`    Error eliminando archivo: ${result.reason?.message || result.reason}`);
        }
      }
    }
    if ((deleted + deleteFailed) % 1000 === 0 || i + BATCH >= orphans.length) {
      logger.info(`    Progreso: ${(deleted + deleteFailed).toLocaleString()} / ${orphans.length.toLocaleString()} (${deleted.toLocaleString()} ok, ${deleteFailed.toLocaleString()} failed)`);
    }
  }

  logger.info(`    Eliminación completa: ${deleted.toLocaleString()} eliminados, ${deleteFailed.toLocaleString()} fallidos`);

  // Paso 4: Verificación
  logger.info('  Paso 4: Verificación...');
  let remainingCount = 0;
  let verifyQuery = {};
  do {
    const [files, nextQuery] = await bucket.getFiles(verifyQuery);
    remainingCount += files.length;
    verifyQuery = nextQuery;
  } while (verifyQuery);

  logger.info(`    Archivos restantes en bucket: ${remainingCount.toLocaleString()}`);
  logger.info(`    Archivos referenciados en BD: ${referencedPaths.size.toLocaleString()}`);

  if (deleteFailed > 0) {
    errors.push({ error: `${deleteFailed} archivos no pudieron eliminarse` });
  }

  logger.info(`\n  Fase 14c completa: ${deleted.toLocaleString()} eliminados, ${kept.toLocaleString()} conservados, ${deleteFailed} fallidos`);
  return { migrated: deleted, skipped: kept, failed: deleteFailed, errors };
};
