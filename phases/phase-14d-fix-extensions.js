const logger = require('../utils/logger');
const config = require('../config');

const COLUMNS = ['photo_url', 'ine_document_url', 'bank_statement_url', 'tax_id_document_url'];
const EXTENSIONS = ['jpeg', 'jpg', 'png', 'pdf', 'gif', 'webp'];
const BUCKET_NAME = 'toniclife-prod';
const BUCKET_PREFIX = `https://storage.googleapis.com/${BUCKET_NAME}/`;

module.exports = async function phase14d(v1Pool, v2Pool) {
  logger.phase('14d', 'Corregir extensiones de archivos de clientes en GCS y BD');

  let totalFixed = 0;
  let totalSkipped = 0;
  const errors = [];

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

  // Paso 1+2: Para cada columna, encontrar URLs sin punto y corregir
  for (const col of COLUMNS) {
    logger.info(`  Procesando ${col}...`);

    const { rows } = await v2Pool.query(`
      SELECT id, ${col} AS url FROM tonic.customers
      WHERE ${col} LIKE '${BUCKET_PREFIX}%'
        AND ${col} NOT LIKE '%.jpg'
        AND ${col} NOT LIKE '%.jpeg'
        AND ${col} NOT LIKE '%.png'
        AND ${col} NOT LIKE '%.pdf'
        AND ${col} NOT LIKE '%.gif'
        AND ${col} NOT LIKE '%.webp'
    `);
    logger.info(`    ${rows.length} URLs sin extensión válida`);

    let colFixed = 0;
    let colSkipped = 0;

    for (const row of rows) {
      const oldUrl = row.url;
      const oldPath = oldUrl.replace(BUCKET_PREFIX, '');

      // Detectar extensión pegada al final sin punto
      let newPath = null;
      for (const ext of EXTENSIONS) {
        if (oldPath.endsWith(ext) && !oldPath.endsWith('.' + ext)) {
          newPath = oldPath.slice(0, -ext.length) + '.' + ext;
          break;
        }
      }

      if (!newPath) {
        colSkipped++;
        continue;
      }

      const newUrl = BUCKET_PREFIX + newPath;

      try {
        const oldFile = bucket.file(oldPath);
        const newFile = bucket.file(newPath);
        await oldFile.copy(newFile);
        await oldFile.delete();
        await v2Pool.query(`UPDATE tonic.customers SET ${col} = $1 WHERE id = $2`, [newUrl, row.id]);
        colFixed++;
      } catch (err) {
        // Si el archivo no existe en GCS, solo actualizar la URL en BD
        logger.warn(`    Error GCS ${oldPath}: ${err.message}, actualizando solo BD`);
        try {
          await v2Pool.query(`UPDATE tonic.customers SET ${col} = $1 WHERE id = $2`, [newUrl, row.id]);
          colFixed++;
        } catch (dbErr) {
          logger.error(`    Error BD: ${dbErr.message}`);
          errors.push({ col, id: row.id, error: dbErr.message });
        }
      }
    }

    logger.info(`    ${colFixed} corregidos, ${colSkipped} omitidos (extensión no reconocida)`);
    totalFixed += colFixed;
    totalSkipped += colSkipped;
  }

  // Paso 3: Verificación
  logger.info('  Verificación:');
  for (const col of COLUMNS) {
    const { rows } = await v2Pool.query(`
      SELECT COUNT(*) AS cnt FROM tonic.customers
      WHERE ${col} LIKE '${BUCKET_PREFIX}%'
        AND ${col} NOT LIKE '%.jpg'
        AND ${col} NOT LIKE '%.jpeg'
        AND ${col} NOT LIKE '%.png'
        AND ${col} NOT LIKE '%.pdf'
        AND ${col} NOT LIKE '%.gif'
        AND ${col} NOT LIKE '%.webp'
    `);
    logger.info(`    ${col} sin extensión válida: ${rows[0].cnt}`);
  }

  // Conteo total por columna
  for (const col of COLUMNS) {
    const { rows } = await v2Pool.query(`SELECT COUNT(*) AS cnt FROM tonic.customers WHERE ${col} LIKE '${BUCKET_PREFIX}%'`);
    logger.info(`    ${col} total GCS: ${rows[0].cnt}`);
  }

  logger.info(`\n  Fase 14d completa: ${totalFixed} corregidos, ${totalSkipped} omitidos, ${errors.length} fallidos`);
  return { migrated: totalFixed, skipped: totalSkipped, failed: errors.length, errors };
};
