const logger = require('../utils/logger');
const { uploadFile } = require('../utils/gcs-uploader');
const config = require('../config');

/**
 * All tables with file columns that need GCS migration.
 * Each entry specifies the v2 table name, the column(s) containing legacy URLs,
 * and a function to determine the GCS folder path from the row.
 */
const FILE_TABLES = [
  {
    name: 'product_images',
    table: 'tonic.product_images',
    columns: [
      { source: 'image_url', gcsFolder: (row) => `products/images/${row.id}` },
    ],
  },
  {
    name: 'customers',
    table: 'tonic.customers',
    columns: [
      { source: 'photo_url',           gcsFolder: (row) => `customers/${row.legacy_id}/photo` },
      { source: 'contract_url',        gcsFolder: (row) => `customers/${row.legacy_id}/contract` },
      { source: 'ine_document_url',    gcsFolder: (row) => `customers/${row.legacy_id}/ine` },
      { source: 'bank_statement_url',  gcsFolder: (row) => `customers/${row.legacy_id}/bank-statement` },
      { source: 'tax_id_document_url', gcsFolder: (row) => `customers/${row.legacy_id}/tax-id` },
    ],
  },
  {
    name: 'invoices',
    table: 'tonic.invoices',
    columns: [
      { source: 'xml_file_path', gcsFolder: (row) => `invoices/xml/${row.legacy_id}` },
    ],
  },
  {
    name: 'purchase_orders',
    table: 'tonic.purchase_orders',
    columns: [
      { source: 'file_url', gcsFolder: (row) => `purchase-orders/${row.legacy_id}` },
    ],
  },
  {
    name: 'system_files',
    table: 'tonic.system_files',
    columns: [
      { source: 'url', gcsFolder: (row) => `system-files/${row.legacy_id}` },
    ],
  },
];

const LEGACY_URL_PREFIX = 'https://tonic-life.net';

module.exports = async function phase14(v1Pool, v2Pool) {
  logger.phase('14', 'Migración de Archivos a GCS');

  const gcsUploader = require('../utils/gcs-uploader');
  const ready = await gcsUploader.init();
  if (!ready) {
    logger.error('  GCS no disponible. Abortando fase 14.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: 'GCS not available' }] };
  }

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };

  for (const tableDef of FILE_TABLES) {
    for (const colDef of tableDef.columns) {
      logger.table(tableDef.name, `Migrando ${colDef.source} a GCS`);

      // Find rows with legacy URLs that haven't been migrated to GCS yet
      const idCols = 'id' + (tableDef.table === 'tonic.product_images' ? '' : ', legacy_id');
      const { rows } = await v2Pool.query(
        `SELECT ${idCols}, ${colDef.source}
         FROM ${tableDef.table}
         WHERE ${colDef.source} IS NOT NULL
           AND ${colDef.source} LIKE $1`,
        [`${LEGACY_URL_PREFIX}%`]
      );

      logger.info(`    ${tableDef.name}.${colDef.source}: ${rows.length} archivos por migrar`);
      if (rows.length === 0) continue;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const url = row[colDef.source];
          // Extract the relative path from the legacy URL
          // e.g. "https://tonic-life.net/assets/files/photo.jpg" → "files/photo.jpg"
          let relativePath = url;
          if (url.startsWith(LEGACY_URL_PREFIX)) {
            relativePath = url.substring(LEGACY_URL_PREFIX.length);
            // Remove leading /assets/ or / prefix
            relativePath = relativePath.replace(/^\/assets\//, '').replace(/^\//, '');
          }

          const gcsFolder = colDef.gcsFolder(row);
          const gcsPath = await uploadFile(relativePath, gcsFolder);

          if (gcsPath && !gcsPath.startsWith('http')) {
            await v2Pool.query(
              `UPDATE ${tableDef.table} SET ${colDef.source} = $1, updated_at = NOW() WHERE id = $2`,
              [gcsPath, row.id]
            );
            results.migrated++;
          } else {
            results.skipped++;
          }
        } catch (err) {
          results.failed++;
          if (results.errors.length < 200) {
            results.errors.push({
              table: tableDef.name,
              column: colDef.source,
              id: row.id,
              error: err.message,
            });
          }
          if (results.failed <= 10) {
            logger.debug(`    Error en ${tableDef.name}.${colDef.source} id=${row.id}: ${err.message}`);
          }
        }

        if (i > 0 && i % 500 === 0) {
          logger.progress(`${tableDef.name}.${colDef.source}`, i, rows.length);
        }
      }

      logger.info(`    ✓ ${tableDef.name}.${colDef.source}: procesados ${rows.length}`);
    }
  }

  const gcsStats = gcsUploader.getStats();
  logger.info(`\n  Fase 14 completa: ${results.migrated} actualizados, ${results.skipped} omitidos, ${results.failed} fallidos`);
  logger.info(`  GCS stats: ${gcsStats.uploaded} subidos, ${gcsStats.alreadyExisted} ya existían, ${gcsStats.failed} fallidos`);

  return results;
};
