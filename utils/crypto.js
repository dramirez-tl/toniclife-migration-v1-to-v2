const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

/**
 * Hashea una contraseña con bcrypt (compatible con NestJS bcrypt.compare).
 * @param {string} plainText - Contraseña en texto plano
 * @returns {Promise<string|null>} Hash bcrypt ($2b$10$...) o null si input vacío
 */
async function hashPassword(plainText) {
  if (!plainText || !plainText.trim()) return null;
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

module.exports = { hashPassword };
