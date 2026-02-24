const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV = Buffer.alloc(16, 0); // IV fijo, idéntico al backend NestJS

/**
 * Encripta una contraseña con AES-256-GCM.
 * Formato resultado: "hexEncrypted:hexAuthTag" — idéntico al backend NestJS.
 */
function encryptPassword(plainText, keyGcm) {
  if (!plainText || !keyGcm) return null;

  const key = Buffer.isBuffer(keyGcm) ? keyGcm : Buffer.from(keyGcm, 'utf8');
  if (key.length !== 32) {
    throw new Error(`KEY_GCM debe tener 32 bytes (256 bits). Recibidos: ${key.length}`);
  }

  const cipher = crypto.createCipheriv(ALGORITHM, key, IV);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${encrypted}:${authTag.toString('hex')}`;
}

module.exports = { encryptPassword };
