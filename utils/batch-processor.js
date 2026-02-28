const Cursor = require('pg-cursor');
const logger = require('./logger');

const MAX_PARAMS = 65535;

/**
 * Procesa una tabla grande usando cursor server-side.
 * Sin SAVEPOINTs — cada INSERT es autocommit.
 * Reutiliza una sola conexión v2 durante todo el cursor.
 */
async function processWithCursor(opts) {
  const {
    v1Pool, v2Pool, sourceQuery, tableName,
    totalCount, batchSize, transformAndInsert
  } = opts;

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };
  let processed = 0;

  const v1Client = await v1Pool.connect();
  const v2Client = await v2Pool.connect();
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

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          const result = await transformAndInsert(row, v2Client);
          if (result === 'skipped') {
            results.skipped++;
          } else {
            results.migrated++;
          }
        } catch (err) {
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
    v2Client.release();
  }

  return results;
}

/**
 * Procesa una tabla pequeña (<10K registros) sin SAVEPOINTs.
 * Cada INSERT es autocommit.
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
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const result = await transformAndInsert(row, v2Client);
        if (result === 'skipped') {
          results.skipped++;
        } else {
          results.migrated++;
        }
      } catch (err) {
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
  } catch (err) {
    logger.error(`    Error fatal en ${tableName}: ${err.message}`);
    results.failed += rows.length;
  } finally {
    v2Client.release();
  }

  return results;
}

/**
 * Procesa una tabla grande usando cursor + bulk INSERTs.
 *
 * Patrón:
 *   1. Lee un batch de N filas con el cursor
 *   2. resolveBatch() pre-resuelve todos los IDs del batch en queries bulk
 *   3. transformRow() transforma cada fila de forma síncrona (sin queries a DB)
 *   4. buildInsertSQL() genera INSERT multi-row
 *   5. Si el bulk INSERT falla, usa binary split para encontrar los registros problemáticos
 *
 * @param {Object} opts
 * @param {Pool} opts.v1Pool
 * @param {Pool} opts.v2Pool
 * @param {string} opts.sourceQuery
 * @param {string} opts.tableName
 * @param {number} opts.totalCount
 * @param {number} opts.batchSize
 * @param {Function} opts.resolveBatch - async (rows, v2Client) => resolvedData
 * @param {Function} opts.transformRow - (row, resolvedData) => object | null (null = skip)
 * @param {Function} opts.buildInsertSQL - (transformedRows) => Array<{sql, params}>
 */
async function processWithCursorBulk(opts) {
  const {
    v1Pool, v2Pool, sourceQuery, tableName,
    totalCount, batchSize,
    resolveBatch, transformRow, buildInsertSQL
  } = opts;

  const results = { migrated: 0, skipped: 0, failed: 0, errors: [] };
  let processed = 0;

  const v1Client = await v1Pool.connect();
  const v2Client = await v2Pool.connect();
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

      try {
        // Step 1: Resolve all IDs for the batch
        const resolved = await resolveBatch(rows, v2Client);

        // Step 2: Transform all rows synchronously
        const transformedRows = [];
        let batchSkipped = 0;
        for (const row of rows) {
          try {
            const transformed = transformRow(row, resolved);
            if (transformed === null) {
              batchSkipped++;
            } else {
              transformedRows.push(transformed);
            }
          } catch (err) {
            batchSkipped++;
          }
        }

        // Step 3: Bulk insert
        if (transformedRows.length > 0) {
          const statements = buildInsertSQL(transformedRows);
          await v2Client.query('BEGIN');
          for (const { sql, params } of statements) {
            await v2Client.query(sql, params);
          }
          await v2Client.query('COMMIT');
          results.migrated += transformedRows.length;
        }
        results.skipped += batchSkipped;
      } catch (err) {
        // Batch failed — use binary split fallback
        try { await v2Client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        logger.debug(`    Bulk insert failed for ${tableName}, using binary split: ${err.message}`);

        try {
          const resolved = await resolveBatch(rows, v2Client);
          const transformedRows = [];
          let batchSkipped = 0;
          for (const row of rows) {
            try {
              const transformed = transformRow(row, resolved);
              if (transformed === null) {
                batchSkipped++;
              } else {
                transformedRows.push(transformed);
              }
            } catch (_) {
              batchSkipped++;
            }
          }
          results.skipped += batchSkipped;
          await binarySplitInsert(transformedRows, buildInsertSQL, v2Client, results, tableName);
        } catch (splitErr) {
          logger.error(`    Binary split also failed for ${tableName}: ${splitErr.message}`);
          results.failed += rows.length;
        }
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
    v2Client.release();
  }

  return results;
}

/**
 * Binary split: intenta insertar un grupo de filas.
 * Si falla, divide a la mitad recursivamente hasta encontrar los registros problemáticos.
 */
async function binarySplitInsert(rows, buildInsertSQL, v2Client, results, tableName) {
  if (rows.length === 0) return;

  if (rows.length === 1) {
    try {
      const statements = buildInsertSQL(rows);
      for (const { sql, params } of statements) {
        await v2Client.query(sql, params);
      }
      results.migrated++;
    } catch (err) {
      results.failed++;
      if (results.errors.length < 200) {
        results.errors.push({
          table: tableName,
          legacyId: rows[0].legacy_id || 'unknown',
          error: err.message,
          data: JSON.stringify(rows[0]).substring(0, 500),
        });
      }
    }
    return;
  }

  // Try bulk insert
  try {
    const statements = buildInsertSQL(rows);
    await v2Client.query('BEGIN');
    for (const { sql, params } of statements) {
      await v2Client.query(sql, params);
    }
    await v2Client.query('COMMIT');
    results.migrated += rows.length;
  } catch (err) {
    try { await v2Client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    // Split in half and retry
    const mid = Math.floor(rows.length / 2);
    await binarySplitInsert(rows.slice(0, mid), buildInsertSQL, v2Client, results, tableName);
    await binarySplitInsert(rows.slice(mid), buildInsertSQL, v2Client, results, tableName);
  }
}

/**
 * Genera uno o más INSERTs multi-row con parámetros numerados.
 * Divide en chunks si el número de parámetros excede MAX_PARAMS (65535).
 *
 * @param {string} table - Nombre completo de la tabla (e.g. 'tonic.orders')
 * @param {string[]} columns - Lista de columnas
 * @param {Object[]} rows - Datos a insertar (objetos con keys = columns)
 * @param {string} onConflict - Cláusula ON CONFLICT
 * @param {Object} [columnTypes] - Casts de tipo por columna { col: 'jsonb' }
 * @returns {Array<{sql: string, params: any[]}>}
 */
function buildMultiRowInsert(table, columns, rows, onConflict, columnTypes = {}) {
  if (rows.length === 0) return [];

  const numCols = columns.length;
  const chunkSize = Math.floor(MAX_PARAMS / numCols);
  const statements = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valueClauses = [];
    const params = [];

    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      const placeholders = columns.map((col, k) => {
        const paramNum = j * numCols + k + 1;
        const cast = columnTypes[col] ? `::${columnTypes[col]}` : '';
        return `$${paramNum}${cast}`;
      });
      valueClauses.push(`(${placeholders.join(', ')})`);

      for (const col of columns) {
        params.push(row[col] !== undefined ? row[col] : null);
      }
    }

    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueClauses.join(', ')} ${onConflict || ''}`;
    statements.push({ sql, params });
  }

  return statements;
}

/**
 * Igual que buildMultiRowInsert pero agrega gen_random_uuid() como primera columna (id).
 * La columna 'id' NO debe estar en el array de columns — se agrega automáticamente.
 */
function buildMultiRowInsertWithUUID(table, columns, rows, onConflict, columnTypes = {}) {
  if (rows.length === 0) return [];

  const numCols = columns.length; // NOT counting 'id' since it's not parameterized
  const chunkSize = Math.floor(MAX_PARAMS / numCols);
  const allColumns = ['id', ...columns];
  const statements = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valueClauses = [];
    const params = [];

    for (let j = 0; j < chunk.length; j++) {
      const row = chunk[j];
      const placeholders = columns.map((col, k) => {
        const paramNum = j * numCols + k + 1;
        const cast = columnTypes[col] ? `::${columnTypes[col]}` : '';
        return `$${paramNum}${cast}`;
      });
      valueClauses.push(`(gen_random_uuid(), ${placeholders.join(', ')})`);

      for (const col of columns) {
        params.push(row[col] !== undefined ? row[col] : null);
      }
    }

    const sql = `INSERT INTO ${table} (${allColumns.join(', ')}) VALUES ${valueClauses.join(', ')} ${onConflict || ''}`;
    statements.push({ sql, params });
  }

  return statements;
}

/**
 * Obtiene el conteo de registros de una tabla v1.
 */
async function getCount(v1Pool, query) {
  const { rows } = await v1Pool.query(query);
  return parseInt(rows[0].count, 10);
}

module.exports = {
  processWithCursor,
  processSmallTable,
  processWithCursorBulk,
  buildMultiRowInsert,
  buildMultiRowInsertWithUUID,
  getCount,
};
