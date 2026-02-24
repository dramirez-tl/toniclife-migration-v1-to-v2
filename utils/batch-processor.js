const Cursor = require('pg-cursor');
const logger = require('./logger');

/**
 * Procesa una tabla grande usando cursor server-side.
 * Usa SAVEPOINT por registro para aislar errores individuales sin abortar el batch.
 */
async function processWithCursor(opts) {
  const {
    v1Pool, v2Pool, sourceQuery, tableName,
    totalCount, batchSize, transformAndInsert
  } = opts;

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };
  let processed = 0;

  const v1Client = await v1Pool.connect();
  try {
    const cursor = v1Client.query(new Cursor(sourceQuery));

    let hasMore = true;
    while (hasMore) {
      const rows = await new Promise((resolve, reject) => {
        cursor.read(batchSize, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      // Procesar batch en una transacción v2 con SAVEPOINTs por registro
      const v2Client = await v2Pool.connect();
      try {
        await v2Client.query('BEGIN');

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const spName = `sp_${i}`;
          try {
            await v2Client.query(`SAVEPOINT ${spName}`);
            const result = await transformAndInsert(row, v2Client);
            if (result === 'skipped') {
              results.skipped++;
            } else {
              results.migrated++;
            }
            await v2Client.query(`RELEASE SAVEPOINT ${spName}`);
          } catch (err) {
            await v2Client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
            results.failed++;
            const legacyId = row.id || row[Object.keys(row)[0]];
            if (results.errors.length < 200) {
              results.errors.push({
                table: tableName,
                legacyId,
                error: err.message,
                data: JSON.stringify(row).substring(0, 500),
              });
            }
            if (results.failed <= 10) {
              logger.debug(`    Error en ${tableName} registro ${legacyId}: ${err.message}`);
            }
          }
        }

        await v2Client.query('COMMIT');
      } catch (err) {
        try { await v2Client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        logger.error(`    Error fatal en batch de ${tableName}: ${err.message}`);
        results.failed += rows.length;
      } finally {
        v2Client.release();
      }

      processed += rows.length;
      if (totalCount > 0) {
        logger.progress(tableName, processed, totalCount);
      }
    }

    await new Promise((resolve, reject) => {
      cursor.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } finally {
    v1Client.release();
  }

  return results;
}

/**
 * Procesa una tabla pequeña (<10K registros) en una sola transacción.
 * Usa SAVEPOINT por registro para aislar errores individuales.
 */
async function processSmallTable(opts) {
  const {
    v1Pool, v2Pool, sourceQuery, tableName,
    transformAndInsert
  } = opts;

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };

  const { rows } = await v1Pool.query(sourceQuery);
  logger.info(`    ${tableName}: ${rows.length} registros encontrados en v1`);

  if (rows.length === 0) return results;

  const v2Client = await v2Pool.connect();
  try {
    await v2Client.query('BEGIN');

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const spName = `sp_${i}`;
      try {
        await v2Client.query(`SAVEPOINT ${spName}`);
        const result = await transformAndInsert(row, v2Client);
        if (result === 'skipped') {
          results.skipped++;
        } else {
          results.migrated++;
        }
        await v2Client.query(`RELEASE SAVEPOINT ${spName}`);
      } catch (err) {
        await v2Client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
        results.failed++;
        const legacyId = row.id || row[Object.keys(row)[0]];
        if (results.errors.length < 200) {
          results.errors.push({
            table: tableName,
            legacyId,
            error: err.message,
            data: JSON.stringify(row).substring(0, 500),
          });
        }
        logger.debug(`    Error en ${tableName} registro ${legacyId}: ${err.message}`);
      }
    }

    await v2Client.query('COMMIT');
  } catch (err) {
    try { await v2Client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    logger.error(`    Error fatal en transacción de ${tableName}: ${err.message}`);
    results.failed += rows.length;
  } finally {
    v2Client.release();
  }

  return results;
}

/**
 * Obtiene el conteo de registros de una tabla v1.
 */
async function getCount(v1Pool, query) {
  const { rows } = await v1Pool.query(query);
  return parseInt(rows[0].count, 10);
}

module.exports = { processWithCursor, processSmallTable, getCount };
