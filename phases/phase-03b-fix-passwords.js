const logger = require('../utils/logger');
const { encrypt } = require('../utils/crypto');

module.exports = async function phase03b(v1Pool, v2Pool) {
  logger.phase('03b', 'Corrección de Contraseñas bcrypt → AES-256-GCM');

  let updated = 0;
  const errors = [];

  // PASO 1: Usuarios reales con email → Holamundo#1234
  logger.info('  Actualizando usuarios reales con email...');
  const newPasswordReal = encrypt('Holamundo#1234');

  const realResult = await v2Pool.query(`
    SELECT id, email FROM tonic.users
    WHERE password_hash LIKE '$2b$%'
      AND email IS NOT NULL AND email != ''
  `);
  logger.info(`    ${realResult.rows.length} usuarios reales encontrados`);

  for (const row of realResult.rows) {
    try {
      await v2Pool.query(
        `UPDATE tonic.users
         SET password_hash = $1, must_change_password = true, updated_at = NOW()
         WHERE id = $2`,
        [newPasswordReal, row.id]
      );
      updated++;
      logger.info(`    ${row.email} → contraseña actualizada`);
    } catch (err) {
      errors.push({ id: row.id, email: row.email, error: err.message });
    }
  }

  // PASO 2: Usuarios sin email → CHANGE_ME_{username}
  logger.info('  Actualizando usuarios sin email (datos de prueba)...');
  const genericResult = await v2Pool.query(`
    SELECT id, username FROM tonic.users
    WHERE password_hash LIKE '$2b$%'
      AND (email IS NULL OR email = '')
  `);
  logger.info(`    ${genericResult.rows.length} usuarios sin email encontrados`);

  for (const row of genericResult.rows) {
    try {
      const genericPassword = encrypt('CHANGE_ME_' + (row.username || row.id));
      await v2Pool.query(
        `UPDATE tonic.users
         SET password_hash = $1, must_change_password = true, updated_at = NOW()
         WHERE id = $2`,
        [genericPassword, row.id]
      );
      updated++;
    } catch (err) {
      errors.push({ id: row.id, username: row.username, error: err.message });
    }
  }

  // PASO 3: Verificación
  const remaining = await v2Pool.query(
    "SELECT COUNT(*) AS count FROM tonic.users WHERE password_hash LIKE '$2b$%'"
  );
  const remainingCount = parseInt(remaining.rows[0].count);
  if (remainingCount > 0) {
    logger.warn(`  Aún quedan ${remainingCount} usuarios con bcrypt`);
  } else {
    logger.info('  0 usuarios con bcrypt. Todas las contraseñas son AES-256-GCM.');
  }

  logger.info(`\n  Fase 03b completa: ${updated} actualizados, ${errors.length} fallidos`);
  return { migrated: updated, skipped: 0, failed: errors.length, errors };
};
