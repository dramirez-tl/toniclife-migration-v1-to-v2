#!/usr/bin/env node

/**
 * sync-stock-api.js — Sincronizar inventarios desde API v1
 *
 * Llama al endpoint POST https://tonic-life.net/report/inventory para cada
 * sucursal de v1, parsea el Excel devuelto y hace UPSERT en stock_levels de v2.
 *
 * Ejecución: node sync-stock-api.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const XLSX = require('xlsx');

const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3NzI0MDc5MzUsImV4cCI6MTgyMjE3NDMzNSwidXNlcm5hbWUiOiJhZG1pbmlzdHJhZG9yIiwicGFzc3dvcmQiOiJoT0xBTVVORE8jMTIzNCIsImZ1bGxfbmFtZSI6IkFkbWluIEFkbWluIiwibmFtZV9qb2IiOm51bGwsIm1haW5fcHJvZmlsZSI6InZlbnRhcyIsImlkX3Byb2ZpbGUiOjEsImlkX2N1c3RvbWVycyI6bnVsbCwidHlwZSI6Mn0.zJA4g9_VPyW67y2OAoVZw1qR2w_qBIZsBoHfvML9mWw';
const API_URL = 'https://tonic-life.net/report/inventory';
const DELAY_MS = 200;

// =============================================
// Pools de conexión
// =============================================
const v1Pool = new Pool({
  host: process.env.V1_HOST,
  port: parseInt(process.env.V1_PORT || '5432'),
  database: process.env.V1_DATABASE || 'postgres',
  user: process.env.V1_USER,
  password: process.env.V1_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const v2IsLocal = ['localhost', '127.0.0.1', '::1'].includes(process.env.V2_HOST);
const v2Pool = new Pool({
  host: process.env.V2_HOST,
  port: parseInt(process.env.V2_PORT || '5432'),
  database: process.env.V2_DATABASE || 'toniclife_db_v2',
  user: process.env.V2_USER,
  password: process.env.V2_PASSWORD,
  max: 15,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 30000,
  ...(v2IsLocal ? {} : { ssl: { rejectUnauthorized: false } }),
});

// =============================================
// Helpers
// =============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${timestamp()}] ERROR: ${msg}`);
}

/**
 * Llama al API de inventario para una sucursal y devuelve el Excel en base64.
 * Retorna null si falla.
 */
async function fetchInventoryExcel(branchId) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt: JWT, p_id_branch_office: branchId }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json();
  if (json.response !== 'success' || !json.data?.excel?.file) {
    throw new Error(`API response: ${json.response || 'no data'}`);
  }

  return json.data.excel.file;
}

/**
 * Parsea el Excel base64 y extrae filas de inventario.
 * Retorna array de { code, quantity }.
 */
function parseExcel(base64DataUri) {
  // Remover el prefijo data:...;base64,
  const base64 = base64DataUri.includes(',') ? base64DataUri.split(',')[1] : base64DataUri;
  const buffer = Buffer.from(base64, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Buscar la fila de headers donde columna A = 'CLAVE'
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const cellA = String(rows[i][0] || '').trim().toUpperCase();
    if (cellA === 'CLAVE') {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return [];
  }

  // Leer datos desde la fila siguiente al header
  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const code = String(rows[i][0] || '').trim();
    const qty = parseFloat(rows[i][2]) || 0;
    if (code && qty > 0) {
      items.push({ code, quantity: qty });
    }
  }

  return items;
}

// =============================================
// Main
// =============================================
async function main() {
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   sync-stock-api — Sincronizar inventarios desde API v1 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Verificar conexiones
  log('Verificando conexiones...');
  try {
    const c1 = await v1Pool.connect();
    c1.release();
    log('  v1 OK');
  } catch (err) {
    logError(`v1: ${err.message}`);
    process.exit(1);
  }
  try {
    const c2 = await v2Pool.connect();
    c2.release();
    log('  v2 OK');
  } catch (err) {
    logError(`v2: ${err.message}`);
    process.exit(1);
  }

  // Paso 1: Obtener sucursales de v1
  log('Cargando sucursales de v1...');
  const { rows: v1Branches } = await v1Pool.query(
    'SELECT id_branch_office, name_branch_office FROM toniclife.t_branch_office ORDER BY id_branch_office'
  );
  log(`  ${v1Branches.length} sucursales en v1`);

  // Paso 2: Cargar mapas de v2
  log('Cargando mapas de v2...');
  const { rows: prodRows } = await v2Pool.query('SELECT id, code FROM tonic.products');
  const productMap = {};
  for (const row of prodRows) productMap[row.code] = row.id;
  log(`  ${prodRows.length} productos en v2`);

  const { rows: branchMapRows } = await v2Pool.query(
    "SELECT legacy_id, new_id FROM tonic.legacy_id_map WHERE entity_type = 'branch'"
  );
  const branchMap = {};
  for (const row of branchMapRows) branchMap[String(row.legacy_id)] = row.new_id;
  log(`  ${branchMapRows.length} sucursales mapeadas en legacy_id_map`);

  // Paso 3: Procesar cada sucursal
  const stats = {
    processed: 0,
    notFoundInV2: [],
    apiErrors: [],
    emptyBranches: [],
    totalUpserted: 0,
    totalZeroed: 0,
    branchStock: [],
  };

  for (let idx = 0; idx < v1Branches.length; idx++) {
    const branch = v1Branches[idx];
    const branchId = branch.id_branch_office;
    const branchName = branch.name_branch_office;
    const v2BranchId = branchMap[String(branchId)];

    const progress = `[${idx + 1}/${v1Branches.length}]`;

    // Si no existe en v2, skip
    if (!v2BranchId) {
      stats.notFoundInV2.push({ id: branchId, name: branchName });
      log(`  ${progress} ${branchName} (${branchId}) — no encontrada en v2, omitiendo`);
      continue;
    }

    // Llamar al API
    let items;
    try {
      const excelData = await fetchInventoryExcel(branchId);
      items = parseExcel(excelData);
    } catch (err) {
      stats.apiErrors.push({ id: branchId, name: branchName, error: err.message });
      logError(`  ${progress} ${branchName} (${branchId}) — API error: ${err.message}`);
      await sleep(DELAY_MS);
      continue;
    }

    if (items.length === 0) {
      stats.emptyBranches.push({ id: branchId, name: branchName });
      log(`  ${progress} ${branchName} (${branchId}) — sin productos con stock`);
      await sleep(DELAY_MS);
      continue;
    }

    // UPSERT en stock_levels
    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');

      await v2Client.query(`
        CREATE TEMP TABLE tmp_api_stock (
          product_id UUID NOT NULL,
          branch_id UUID NOT NULL,
          qty NUMERIC NOT NULL
        ) ON COMMIT DROP
      `);

      // Insertar items resueltos en temp table
      let skippedProducts = 0;
      const CHUNK = 5000;
      for (let i = 0; i < items.length; i += CHUNK) {
        const batch = items.slice(i, i + CHUNK);
        const values = [];
        const params = [];
        for (const item of batch) {
          const productId = productMap[item.code];
          if (!productId) { skippedProducts++; continue; }
          const off = params.length;
          values.push(`($${off + 1}, $${off + 2}, $${off + 3})`);
          params.push(productId, v2BranchId, item.quantity);
        }
        if (values.length > 0) {
          await v2Client.query(`INSERT INTO tmp_api_stock VALUES ${values.join(',')}`, params);
        }
      }

      // UPSERT (quantity_available es GENERATED ALWAYS, no incluir)
      const upsertResult = await v2Client.query(`
        INSERT INTO tonic.stock_levels (id, product_id, branch_id, quantity_on_hand, quantity_reserved, quantity_in_transit, last_movement_at)
        SELECT gen_random_uuid(), t.product_id, t.branch_id, t.qty, 0, 0, NOW()
        FROM tmp_api_stock t
        ON CONFLICT (product_id, branch_id) DO UPDATE SET
          quantity_on_hand = EXCLUDED.quantity_on_hand,
          quantity_reserved = 0,
          quantity_in_transit = 0,
          last_movement_at = NOW()
      `);

      // Poner en 0 los que NO aparecen en el reporte para esta sucursal
      const zeroResult = await v2Client.query(`
        UPDATE tonic.stock_levels sl
        SET quantity_on_hand = 0,
            quantity_reserved = 0,
            quantity_in_transit = 0,
            last_movement_at = NOW()
        WHERE sl.branch_id = $1
          AND sl.quantity_on_hand > 0
          AND NOT EXISTS (
            SELECT 1 FROM tmp_api_stock t
            WHERE t.product_id = sl.product_id AND t.branch_id = sl.branch_id
          )
      `, [v2BranchId]);

      await v2Client.query('COMMIT');

      const upserted = upsertResult.rowCount;
      const zeroed = zeroResult.rowCount;
      stats.totalUpserted += upserted;
      stats.totalZeroed += zeroed;
      stats.processed++;

      const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
      stats.branchStock.push({ name: branchName, products: items.length, totalQty, upserted, zeroed });

      log(`  ${progress} ${branchName} (${branchId}) — ${items.length} productos, ${upserted} upserted, ${zeroed} zeroed${skippedProducts > 0 ? `, ${skippedProducts} no encontrados en v2` : ''}`);
    } catch (err) {
      try { await v2Client.query('ROLLBACK'); } catch (_) {}
      stats.apiErrors.push({ id: branchId, name: branchName, error: `DB: ${err.message}` });
      logError(`  ${progress} ${branchName} (${branchId}) — DB error: ${err.message}`);
    } finally {
      v2Client.release();
    }

    await sleep(DELAY_MS);
  }

  // =============================================
  // Reporte final
  // =============================================
  const duration = Date.now() - startTime;
  const durationStr = duration < 60000
    ? `${(duration / 1000).toFixed(1)}s`
    : `${Math.floor(duration / 60000)}m ${((duration % 60000) / 1000).toFixed(0)}s`;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    RESUMEN FINAL                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  log(`Duración total: ${durationStr}`);
  log(`Sucursales procesadas: ${stats.processed}/${v1Branches.length}`);
  log(`Total stock_levels upserted: ${stats.totalUpserted.toLocaleString()}`);
  log(`Total stock_levels puestos en 0: ${stats.totalZeroed.toLocaleString()}`);

  if (stats.notFoundInV2.length > 0) {
    console.log('');
    log(`Sucursales NO encontradas en v2 (${stats.notFoundInV2.length}):`);
    for (const b of stats.notFoundInV2) {
      log(`  - [${b.id}] ${b.name}`);
    }
  }

  if (stats.apiErrors.length > 0) {
    console.log('');
    log(`Sucursales con error (${stats.apiErrors.length}):`);
    for (const b of stats.apiErrors) {
      log(`  - [${b.id}] ${b.name}: ${b.error}`);
    }
  }

  if (stats.emptyBranches.length > 0) {
    console.log('');
    log(`Sucursales sin productos con stock (${stats.emptyBranches.length}):`);
    for (const b of stats.emptyBranches) {
      log(`  - [${b.id}] ${b.name}`);
    }
  }

  // Top 15 sucursales por stock
  if (stats.branchStock.length > 0) {
    console.log('');
    const top = stats.branchStock.sort((a, b) => b.totalQty - a.totalQty).slice(0, 15);
    log('Top 15 sucursales por stock total:');
    for (const b of top) {
      log(`  ${b.name}: ${b.products} productos, ${Number(b.totalQty).toLocaleString()} unidades, ${b.upserted} upserted, ${b.zeroed} zeroed`);
    }
  }

  // Verificación final desde v2
  console.log('');
  log('Verificación desde v2:');
  const v1Total = await v2Pool.query('SELECT COUNT(*) AS cnt FROM tonic.stock_levels');
  const v2WithStock = await v2Pool.query('SELECT COUNT(*) AS cnt FROM tonic.stock_levels WHERE quantity_on_hand > 0');
  log(`  Total stock_levels: ${v1Total.rows[0].cnt}`);
  log(`  Con stock > 0: ${v2WithStock.rows[0].cnt}`);

  const topV2 = await v2Pool.query(`
    SELECT b.name, COUNT(*) AS productos, SUM(sl.quantity_on_hand) AS total
    FROM tonic.stock_levels sl
    JOIN tonic.branches b ON b.id = sl.branch_id
    WHERE sl.quantity_on_hand > 0
    GROUP BY b.name
    ORDER BY total DESC
    LIMIT 15
  `);
  if (topV2.rows.length > 0) {
    log('  Top 15 sucursales en v2:');
    for (const row of topV2.rows) {
      log(`    ${row.name}: ${row.productos} productos, ${Number(row.total).toLocaleString()} unidades`);
    }
  }

  // Cerrar conexiones
  await v1Pool.end();
  await v2Pool.end();
  log('Conexiones cerradas. Sync completado.');
}

main().catch(err => {
  console.error('\nERROR FATAL:', err.message);
  console.error(err.stack);
  process.exit(2);
});
