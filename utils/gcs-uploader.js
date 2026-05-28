const https = require('https');
const http = require('http');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const config = require('../config');
const { prefixUrl } = require('./validators');
const logger = require('./logger');

// --- Semaphore for concurrency control ---
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      this.queue.shift()();
    }
  }
}

// --- MIME type map ---
const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.xml': 'application/xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.txt': 'text/plain', '.mp4': 'video/mp4',
};

// --- Module state ---
let bucket = null;
let semaphore = null;
let initialized = false;
let gcsEnabled = false;

const stats = { uploaded: 0, skipped: 0, failed: 0, alreadyExisted: 0 };

// --- Helper: HTTP GET as stream ---
function httpGet(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        httpGet(res.headers.location, timeout).then(resolve).catch(reject);
        res.resume();
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
  });
}

// --- Helper: sleep ---
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Download from source and upload to GCS ---
async function downloadAndUpload(sourceUrl, gcsPath, retries) {
  const file = bucket.file(gcsPath);

  // Check if already exists (idempotent)
  const [exists] = await file.exists();
  if (exists) {
    stats.alreadyExisted++;
    return gcsPath;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await httpGet(sourceUrl);

      if (res.statusCode === 404) {
        stats.failed++;
        return null; // File doesn't exist at source
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }

      const ext = path.extname(gcsPath).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      await new Promise((resolve, reject) => {
        const writeStream = file.createWriteStream({
          metadata: { contentType },
          resumable: false,
        });
        res.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        res.on('error', reject);
      });

      stats.uploaded++;
      return gcsPath;
    } catch (err) {
      if (attempt === retries) {
        stats.failed++;
        return null;
      }
      await sleep(1000 * Math.pow(2, attempt - 1)); // 1s, 2s, 4s
    }
  }
}

/**
 * Initialize GCS uploader. Call once at startup.
 * @returns {Promise<boolean>} true if GCS is ready
 */
async function init() {
  if (!config.gcs.enabled) {
    gcsEnabled = false;
    return false;
  }

  try {
    let storageOpts = { projectId: config.gcs.projectId };

    if (config.gcs.credentials) {
      const creds = JSON.parse(config.gcs.credentials);
      storageOpts.credentials = creds;
    }

    const storage = new Storage(storageOpts);
    bucket = storage.bucket(config.gcs.bucketName);

    // Verify access
    const [exists] = await bucket.exists();
    if (!exists) {
      logger.error(`  GCS bucket "${config.gcs.bucketName}" no existe`);
      gcsEnabled = false;
      return false;
    }

    semaphore = new Semaphore(config.gcs.concurrency);
    gcsEnabled = true;
    initialized = true;
    return true;
  } catch (err) {
    logger.error(`  GCS init error: ${err.message}`);
    gcsEnabled = false;
    return false;
  }
}

/**
 * Upload a file from v1 source to GCS.
 * @param {string|null} rawFilePath - Raw value from v1 DB column
 * @param {string} gcsFolder - GCS path prefix (e.g., "customers/123/photo")
 * @param {object} [options]
 * @param {string} [options.filenameOverride] - Override extracted filename
 * @returns {Promise<string|null>} GCS path or fallback URL or null
 */
async function uploadFile(rawFilePath, gcsFolder, options = {}) {
  // Fallback when GCS disabled
  if (!gcsEnabled) return prefixUrl(rawFilePath);

  if (rawFilePath === null || rawFilePath === undefined) return null;
  const trimmed = String(rawFilePath).trim();
  if (trimmed === '') return null;

  // Build full source URL
  const sourceUrl = prefixUrl(trimmed);
  if (!sourceUrl) return null;

  // External URLs (Google Drive, YouTube, etc.) — don't upload, return as-is
  if (!sourceUrl.includes('tonic-life.net')) {
    return sourceUrl;
  }

  // Extract filename and build GCS path
  const filename = options.filenameOverride || path.basename(trimmed);
  const gcsPath = `${gcsFolder}/${filename}`.replace(/\/+/g, '/');

  await semaphore.acquire();
  try {
    const result = await downloadAndUpload(sourceUrl, gcsPath, config.gcs.retryAttempts);
    // If upload failed, use prefixUrl fallback so data isn't lost
    return result || prefixUrl(rawFilePath);
  } catch (err) {
    stats.failed++;
    return prefixUrl(rawFilePath); // fallback
  } finally {
    semaphore.release();
  }
}

/**
 * Upload multiple file fields for a single record in parallel.
 * @param {Array<{rawPath: string|null, gcsFolder: string}>} files
 * @returns {Promise<Array<string|null>>} Array of GCS paths in same order
 */
async function uploadMultiple(files) {
  return Promise.all(
    files.map(({ rawPath, gcsFolder }) => uploadFile(rawPath, gcsFolder))
  );
}

// --- Download + upload FORZANDO sobrescritura (sin skip por exists) ---
async function downloadAndUploadForce(sourceUrl, gcsPath, retries) {
  const file = bucket.file(gcsPath);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await httpGet(sourceUrl);

      if (res.statusCode === 404) {
        stats.failed++;
        return null; // No existe en origen — NO borrar lo que ya hay
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }

      const ext = path.extname(gcsPath).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      await new Promise((resolve, reject) => {
        const writeStream = file.createWriteStream({
          metadata: { contentType },
          resumable: false,
        });
        res.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        res.on('error', reject);
      });

      stats.uploaded++;
      return gcsPath;
    } catch (err) {
      if (attempt === retries) {
        stats.failed++;
        return null;
      }
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
}

/**
 * Reemplaza el archivo de un "slot" de UNA sola entidad (1 archivo por slot):
 * sube el archivo de v1 a un path canonico y BORRA cualquier otro objeto del
 * folder del slot. Garantiza exactamente 1 archivo por folder.
 *
 * Orden seguro contra perdida de datos:
 *   1. Descarga de v1 + sube el nuevo a {gcsFolder}/{canonicalName}.{ext}
 *   2. Solo si la subida fue EXITOSA, borra los demas objetos del folder.
 *   3. Si v1 da 404/error, NO borra nada y retorna fallback (conserva lo viejo).
 *
 * Para slots de 1 archivo: customers/{id}/photo, /contract, /ine,
 * /bank-statement, /tax-id; invoices/xml/{id}; purchase-orders/{id};
 * system-files/{id}. NO usar para product_images (varios por producto).
 *
 * @param {string|null} rawFilePath - valor crudo de la columna v1
 * @param {string} gcsFolder - folder del slot (sin filename)
 * @param {string} canonicalName - nombre base canonico (sin extension), ej "photo"
 * @returns {Promise<string|null>} URL publica de GCS, o fallback prefixUrl, o null
 */
async function replaceFileSingle(rawFilePath, gcsFolder, canonicalName) {
  if (!gcsEnabled) return prefixUrl(rawFilePath);
  if (rawFilePath === null || rawFilePath === undefined) return null;
  const trimmed = String(rawFilePath).trim();
  if (trimmed === '') return null;

  const sourceUrl = prefixUrl(trimmed);
  if (!sourceUrl) return null;

  // URLs externas (Drive/YouTube): se devuelven tal cual, no se gestionan en GCS
  if (!sourceUrl.includes('tonic-life.net')) return sourceUrl;

  const folder = gcsFolder.replace(/\/+$/, '');
  const ext = path.extname(trimmed).toLowerCase();
  const gcsPath = `${folder}/${canonicalName}${ext}`.replace(/\/+/g, '/');

  await semaphore.acquire();
  try {
    // 1. Subir el nuevo (forzar overwrite). Si falla, no tocar lo viejo.
    const result = await downloadAndUploadForce(sourceUrl, gcsPath, config.gcs.retryAttempts);
    if (!result) return prefixUrl(rawFilePath);

    // 2. Borrar los demas objetos del folder (versiones viejas / otra extension)
    try {
      const [existing] = await bucket.getFiles({ prefix: `${folder}/` });
      const toDelete = existing.filter(f => f.name !== gcsPath);
      if (toDelete.length > 0) {
        await Promise.allSettled(toDelete.map(f => f.delete()));
      }
    } catch (_) {
      // Si falla el borrado de viejos, no es fatal: 14c los limpia luego.
    }

    return result;
  } catch (err) {
    stats.failed++;
    return prefixUrl(rawFilePath);
  } finally {
    semaphore.release();
  }
}

/**
 * Reemplaza una imagen de producto (varias por producto) en un path
 * deterministico por legacy_id, forzando sobrescritura. NO borra otros
 * objetos del folder (el producto puede tener mas imagenes). La limpieza
 * de huerfanos por cambio de extension la hace 14b/14c.
 *
 * @param {string|null} rawFilePath
 * @param {string} gcsFolder - products/images/{product_id}
 * @param {string} canonicalName - ej "img-{legacy_id}"
 * @returns {Promise<string|null>}
 */
async function replaceFileVersioned(rawFilePath, gcsFolder, canonicalName) {
  if (!gcsEnabled) return prefixUrl(rawFilePath);
  if (rawFilePath === null || rawFilePath === undefined) return null;
  const trimmed = String(rawFilePath).trim();
  if (trimmed === '') return null;

  const sourceUrl = prefixUrl(trimmed);
  if (!sourceUrl) return null;
  if (!sourceUrl.includes('tonic-life.net')) return sourceUrl;

  const folder = gcsFolder.replace(/\/+$/, '');
  const ext = path.extname(trimmed).toLowerCase();
  const gcsPath = `${folder}/${canonicalName}${ext}`.replace(/\/+/g, '/');

  await semaphore.acquire();
  try {
    // 1. Subir el nuevo (forzar overwrite). Si falla, no tocar lo viejo.
    const result = await downloadAndUploadForce(sourceUrl, gcsPath, config.gcs.retryAttempts);
    if (!result) return prefixUrl(rawFilePath);

    // 2. Borrado DEFINITIVO de huerfanos: objetos del MISMO legacy_id con otra
    // extension (ej. img-5.jpg cuando ahora es img-5.png). El prefijo + regex
    // exacta evitan tocar otras imagenes del producto y el falso match
    // img-5 vs img-50. 14c queda como red de seguridad.
    try {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${esc(folder)}/${esc(canonicalName)}\\.[^/]+$`);
      const [existing] = await bucket.getFiles({ prefix: `${folder}/${canonicalName}.` });
      const toDelete = existing.filter(f => re.test(f.name) && f.name !== gcsPath);
      if (toDelete.length > 0) {
        await Promise.allSettled(toDelete.map(f => f.delete()));
      }
    } catch (_) {
      // Si falla el borrado de viejos, no es fatal: 14c los limpia luego.
    }

    return result;
  } catch (err) {
    stats.failed++;
    return prefixUrl(rawFilePath);
  } finally {
    semaphore.release();
  }
}

/**
 * Get upload statistics.
 */
function getStats() {
  return { ...stats };
}

/**
 * Reset statistics (call at start of each phase if desired).
 */
function resetStats() {
  stats.uploaded = 0;
  stats.skipped = 0;
  stats.failed = 0;
  stats.alreadyExisted = 0;
}

module.exports = { init, uploadFile, uploadMultiple, replaceFileSingle, replaceFileVersioned, getStats, resetStats };
