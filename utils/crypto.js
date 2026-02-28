const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV = Buffer.alloc(16, 0); // IV fijo de 16 bytes (igual que en el backend v2)

// Leer la clave desde config o variable de entorno
let _key = null;

function getKey() {
  if (!_key) {
    try {
      const config = require('../config');
      _key = config.crypto?.keyGcm || process.env.KEY_GCM || '';
    } catch {
      _key = process.env.KEY_GCM || '';
    }
  }
  return _key;
}

/**
 * Encripta un texto plano con AES-256-GCM.
 * Formato de salida: "encryptedHex:authTagHex"
 * Idéntico al encrypt() del backend NestJS v2.
 *
 * @param {string} plainText - Texto plano a encriptar
 * @returns {string|null} - Texto encriptado en formato "hex:authTag" o null
 */
function encrypt(plainText) {
  if (!plainText || !plainText.trim()) return null;

  const key = getKey();
  if (!key) throw new Error('KEY_GCM no configurada');

  const cipher = crypto.createCipheriv(ALGORITHM, key, IV);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${encrypted}:${authTag.toString('hex')}`;
}

/**
 * Desencripta un texto encriptado con AES-256-GCM.
 * Formato de entrada: "encryptedHex:authTagHex"
 *
 * @param {string} encryptedText - Texto en formato "hex:authTag"
 * @returns {string|null} - Texto plano o null
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;

  const key = getKey();
  if (!key) throw new Error('KEY_GCM no configurada');

  const [encrypted, authTagHex] = encryptedText.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, IV);
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Mantener nombre "hashPassword" para compatibilidad con las fases que lo importan
// pero ahora encripta con AES-256-GCM en vez de hacer bcrypt hash
async function hashPassword(plainText) {
  return encrypt(plainText);
}

module.exports = { encrypt, decrypt, hashPassword };
