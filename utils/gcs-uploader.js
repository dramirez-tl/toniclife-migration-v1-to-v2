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

module.exports = { init, uploadFile, uploadMultiple, getStats, resetStats };
