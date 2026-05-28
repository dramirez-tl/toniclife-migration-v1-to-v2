#!/usr/bin/env node
/**
 * detect-gcs-duplicates.js  —  AUDITORÍA READ-ONLY del bucket de GCS
 * --------------------------------------------------------------------------
 * Parte del entregable de "Auditoría de duplicados v1→v2" (2026-05-22).
 *
 * QUÉ HACE (100% lectura, NO modifica nada):
 *   1. Lista todos los blobs del bucket (bucket.getFiles, con paginación).
 *   2. Lee de la BD v2 todas las rutas/URLs de archivo referenciadas.
 *   3. Reporta:
 *        - total de blobs y desglose por prefijo (carpeta raíz)
 *        - duplicados por CONTENIDO (mismo md5Hash en distintas rutas)
 *        - "slots" de archivo único con >1 blob (ej. customers/{id}/photo/*)
 *        - blobs HUÉRFANOS (en el bucket pero sin referencia en la BD)
 *        - conteo de referencias que siguen apuntando a URLs http legacy
 *   4. Escribe el resultado en reports/gcs-duplicates-<fecha>.json
 *
 * SEGURIDAD: este script SOLO usa getFiles()/getMetadata() y SELECTs.
 *   No llama a delete(), save(), upload() ni a ningún INSERT/UPDATE/DELETE.
 *
 * USO:  node reports/detect-gcs-duplicates.js
 *   Requiere GCS_* y V2_* en .env.local (no se imprimen credenciales).
 */

const path = require('path');
// Cargar credenciales desde .env.local (config.js usa .env por defecto)
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });

const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const { Client } = require('pg');

const ENV_PATH = path.resolve(__dirname, '..', '.env.local');

/**
 * GCS_CREDENTIALS suele guardarse como JSON multilínea (pretty-printed) SIN comillas,
 * por lo que dotenv solo captura la primera línea ("{"). Aquí extraemos el bloque JSON
 * completo del .env.local con un escaneo de llaves balanceadas (respetando strings),
 * sin modificar el archivo.
 */
function loadGcsCredentialsRaw(envPath) {
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); } catch { return null; }
  const idx = raw.indexOf('GCS_CREDENTIALS=');
  if (idx === -1) return null;
  const start = raw.indexOf('{', idx);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return raw.slice(start, j + 1); }
  }
  return null;
}

// ---- Config desde entorno (mismos nombres que config.js) ----
const credsRaw = (process.env.GCS_CREDENTIALS && process.env.GCS_CREDENTIALS.length > 1)
  ? process.env.GCS_CREDENTIALS
  : loadGcsCredentialsRaw(ENV_PATH);
const GCS = {
  enabled: process.env.GCS_ENABLED === 'true',
  projectId: process.env.GCS_PROJECT_ID,
  bucketName: process.env.GCS_BUCKET_NAME,
  credentials: credsRaw,
};
const V2 = {
  host: process.env.V2_HOST,
  port: parseInt(process.env.V2_PORT || '5432', 10),
  database: process.env.V2_DATABASE || 'toniclife_db_v2',
  user: process.env.V2_USER,
  password: process.env.V2_PASSWORD,
  // AlloyDB presenta cert autofirmado -> cifrar sin verificar (read-only)
  ssl: { rejectUnauthorized: false },
};

const OUT_FILE = path.resolve(__dirname, 'gcs-duplicates-2026-05-22.json');

// Columnas de la BD que referencian archivos (descubiertas en la auditoría)
const FILE_REF_QUERIES = [
  { table: 'product_images', cols: ['image_url'] },
  { table: 'customers', cols: ['photo_url', 'contract_url', 'ine_document_url', 'bank_statement_url', 'tax_id_document_url'] },
  { table: 'invoices', cols: ['xml_file_path', 'pdf_file_path'] },
  { table: 'purchase_orders', cols: ['file_url'] },
  { table: 'system_files', cols: ['url'] },
];

function isHttp(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

/**
 * Devuelve la ruta DENTRO del bucket si la referencia apunta a nuestro bucket GCS
 * (acepta URL completa https://storage.googleapis.com/<bucket>/<path>,
 * https://<bucket>.storage.googleapis.com/<path>, o ruta relativa).
 * Devuelve null si es un host externo (p.ej. tonic-life.net, drive.google.com).
 */
function toBlobPath(v) {
  if (!v || typeof v !== 'string') return null;
  if (/^https?:\/\//i.test(v)) {
    let u;
    try { u = new URL(v); } catch { return null; }
    if (u.hostname === 'storage.googleapis.com') {
      const parts = u.pathname.replace(/^\/+/, '').split('/');
      if (parts[0] === GCS.bucketName) return decodeURIComponent(parts.slice(1).join('/'));
      return null; // otro bucket
    }
    if (u.hostname === `${GCS.bucketName}.storage.googleapis.com`) {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    }
    return null; // host externo (legacy)
  }
  return v.replace(/^\/+/, ''); // ruta relativa
}

// "slot" = carpeta contenedora del blob (todo menos el último segmento)
function folderOf(name) {
  const i = name.lastIndexOf('/');
  return i === -1 ? '' : name.slice(0, i);
}

async function collectDbReferences(client) {
  const referenced = new Set(); // rutas GCS relativas referenciadas
  const httpLegacy = {};        // tabla.col -> conteo de URLs http
  for (const { table, cols } of FILE_REF_QUERIES) {
    for (const col of cols) {
      let rows;
      try {
        const res = await client.query(
          `SELECT ${col} AS v FROM tonic.${table} WHERE ${col} IS NOT NULL`
        );
        rows = res.rows;
      } catch (err) {
        console.warn(`  ! No se pudo leer tonic.${table}.${col}: ${err.message}`);
        continue;
      }
      let external = 0;
      for (const { v } of rows) {
        const p = toBlobPath(v);
        if (p) { referenced.add(p); continue; }
        if (isHttp(v)) external++; // http pero NO de nuestro bucket = legacy/externo
      }
      if (external > 0) httpLegacy[`${table}.${col}`] = external;
    }
  }
  return { referenced, httpLegacy };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reconcilia los UUID de las carpetas de blobs contra entidades reales en v2,
 * para distinguir archivos "subidos pero no enlazados" de huérfanos verdaderos
 * (cuya entidad ya no existe). Solo SELECT.
 */
async function reconcileEntities(client, blobs) {
  const productIds = new Set();   // UUIDs en products/images/<uuid>/
  const customerKeys = new Set(); // clave en customers/<key>/  (puede ser legacy_id o uuid)
  for (const b of blobs) {
    const s = b.name.split('/');
    if (s[0] === 'products' && s[1] === 'images' && UUID_RE.test(s[2] || '')) productIds.add(s[2]);
    else if (s[0] === 'customers' && s[1]) customerKeys.add(s[1]);
  }
  const prodExist = productIds.size === 0 ? 0 : (await client.query(
    `SELECT count(*)::int n FROM tonic.products WHERE id = ANY($1::uuid[])`, [[...productIds]]
  )).rows[0].n;

  // Clientes: la carpeta puede ser uuid (id), legacy_id numérico o customer_number
  const ck = [...customerKeys];
  const custByUuid = ck.filter((k) => UUID_RE.test(k));
  const custByText = ck; // probar como legacy_id::text y customer_number
  const custUuidExist = custByUuid.length === 0 ? 0 : (await client.query(
    `SELECT count(*)::int n FROM tonic.customers WHERE id = ANY($1::uuid[])`, [custByUuid]
  )).rows[0].n;
  const custLegacyExist = (await client.query(
    `SELECT count(*)::int n FROM tonic.customers WHERE legacy_id::text = ANY($1::text[])`, [custByText]
  )).rows[0].n;
  const custNumberExist = (await client.query(
    `SELECT count(*)::int n FROM tonic.customers WHERE customer_number = ANY($1::text[])`, [custByText]
  )).rows[0].n;

  return {
    productFolders: productIds.size,
    productFoldersExistingAsProductId: prodExist,
    productFoldersOrphan: productIds.size - prodExist,
    customerFolders: customerKeys.size,
    customerFoldersMatchById: custUuidExist,
    customerFoldersMatchByLegacyId: custLegacyExist,
    customerFoldersMatchByCustomerNumber: custNumberExist,
  };
}

async function listAllBlobs(bucket) {
  const blobs = [];
  let pageToken;
  const SAFETY_CAP = 500000;
  do {
    const [files, , apiResponse] = await bucket.getFiles({
      autoPaginate: false,
      maxResults: 1000,
      pageToken,
    });
    for (const f of files) {
      blobs.push({
        name: f.name,
        md5: f.metadata && f.metadata.md5Hash ? f.metadata.md5Hash : null,
        size: f.metadata && f.metadata.size ? Number(f.metadata.size) : null,
        updated: f.metadata ? f.metadata.updated : null,
      });
    }
    pageToken = apiResponse && apiResponse.nextPageToken;
    if (blobs.length >= SAFETY_CAP) {
      console.warn(`  ! Tope de seguridad ${SAFETY_CAP} blobs alcanzado; deteniendo listado.`);
      break;
    }
  } while (pageToken);
  return blobs;
}

function analyze(blobs, dbRefs) {
  const byPrefix = {};
  const samplesByPrefix = {};
  let totalBytes = 0;
  const byMd5 = new Map();   // md5 -> [names]
  const byFolder = new Map(); // folder -> [names]

  for (const b of blobs) {
    const prefix = b.name.split('/')[0] || '(raíz)';
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    if (!samplesByPrefix[prefix]) samplesByPrefix[prefix] = [];
    if (samplesByPrefix[prefix].length < 3) samplesByPrefix[prefix].push(b.name);
    if (b.size) totalBytes += b.size;
    if (b.md5) {
      if (!byMd5.has(b.md5)) byMd5.set(b.md5, []);
      byMd5.get(b.md5).push(b.name);
    }
    const folder = folderOf(b.name);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(b.name);
  }

  // Duplicados por contenido (mismo md5 en >1 ruta)
  const duplicatesByMd5 = [];
  for (const [md5, names] of byMd5) {
    if (names.length > 1) duplicatesByMd5.push({ md5, count: names.length, paths: names });
  }
  duplicatesByMd5.sort((a, b) => b.count - a.count);

  // Slots de archivo único con >1 blob: carpetas que casan patrones single-file
  // (customers/{id}/{slot}/...  e  invoices/xml/{id}/...) con más de 1 archivo.
  const singleSlotRe = /^(customers\/[^/]+\/(photo|contract|ine|bank-statement|tax-id)|invoices\/(xml|pdf)\/[^/]+|purchase-orders\/[^/]+)$/;
  const multiFileSlots = [];
  for (const [folder, names] of byFolder) {
    if (names.length > 1 && singleSlotRe.test(folder)) {
      multiFileSlots.push({ folder, count: names.length, files: names });
    }
  }
  multiFileSlots.sort((a, b) => b.count - a.count);

  // Huérfanos: blobs cuyo path no está referenciado por ninguna columna de BD
  const orphans = blobs
    .map((b) => b.name)
    .filter((name) => !dbRefs.referenced.has(name));

  return {
    totalBlobs: blobs.length,
    totalBytes,
    byPrefix,
    samplesByPrefix,
    duplicatesByMd5,
    multiFileSlots,
    orphans: { count: orphans.length, sample: orphans.slice(0, 50) },
  };
}

async function main() {
  console.log('=== Auditoría READ-ONLY de GCS (sin modificar nada) ===');
  if (!GCS.enabled) {
    console.error('GCS_ENABLED != true en .env.local. Aborto (no hago nada).');
    process.exit(1);
  }
  if (!GCS.bucketName) {
    console.error('GCS_BUCKET_NAME vacío. Aborto.');
    process.exit(1);
  }

  // --- GCS ---
  const storageOpts = {};
  if (GCS.credentials) {
    const creds = JSON.parse(GCS.credentials);
    storageOpts.credentials = creds;
    storageOpts.projectId = GCS.projectId || creds.project_id;
  } else if (GCS.projectId) {
    storageOpts.projectId = GCS.projectId;
  }
  const storage = new Storage(storageOpts);
  const bucket = storage.bucket(GCS.bucketName);

  const [bucketExists] = await bucket.exists();
  if (!bucketExists) {
    console.error(`El bucket "${GCS.bucketName}" no existe o no hay acceso. Aborto.`);
    process.exit(1);
  }
  console.log(`Bucket: ${GCS.bucketName}`);

  // --- BD v2 (read-only) ---
  console.log('Conectando a v2 (read-only) para recolectar referencias...');
  const client = new Client(V2);
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  const dbRefs = await collectDbReferences(client);
  console.log(`  Referencias GCS en BD: ${dbRefs.referenced.size}`);
  console.log(`  Columnas con URLs http legacy:`, dbRefs.httpLegacy);

  // --- Listado de blobs ---
  console.log('Listando blobs del bucket...');
  const blobs = await listAllBlobs(bucket);
  console.log(`  Blobs encontrados: ${blobs.length}`);

  // --- Reconciliación de carpetas vs entidades reales ---
  console.log('Reconciliando UUID de carpetas contra productos/clientes en v2...');
  const reconciliation = await reconcileEntities(client, blobs);
  await client.end();
  console.log('  Reconciliación:', JSON.stringify(reconciliation));

  const analysis = analyze(blobs, dbRefs);

  const report = {
    generatedAt: new Date().toISOString(),
    bucket: GCS.bucketName,
    readOnly: true,
    db: {
      referencedGcsPaths: dbRefs.referenced.size,
      httpLegacyRefs: dbRefs.httpLegacy,
    },
    reconciliation,
    ...analysis,
  };

  require('fs').writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');

  // --- Resumen en consola ---
  console.log('\n========== RESUMEN ==========');
  console.log(`Total blobs:            ${analysis.totalBlobs}`);
  console.log(`Tamaño total:           ${(analysis.totalBytes / 1048576).toFixed(1)} MB`);
  console.log(`Desglose por prefijo:   ${JSON.stringify(analysis.byPrefix)}`);
  console.log(`Duplicados por md5:     ${analysis.duplicatesByMd5.length} grupos`);
  console.log(`Slots con >1 archivo:   ${analysis.multiFileSlots.length}`);
  console.log(`Blobs huérfanos:        ${analysis.orphans.count}`);
  console.log(`Referencias http legacy en BD: ${JSON.stringify(dbRefs.httpLegacy)}`);
  console.log(`\nReporte completo: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
