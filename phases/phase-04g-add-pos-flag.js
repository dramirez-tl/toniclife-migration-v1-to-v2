const logger = require('../utils/logger');

module.exports = async function phase04g(v1Pool, v2Pool) {
  logger.phase('04g', 'Agregar columna is_available_pos a products y habilitar para todos');

  const errors = [];

  // Paso 1: Agregar columna si no existe
  logger.info('  Paso 1: Verificando/agregando columna is_available_pos...');
  const { rows: colCheck } = await v2Pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'tonic' AND table_name = 'products' AND column_name = 'is_available_pos'
  `);

  if (colCheck.length === 0) {
    await v2Pool.query(`
      ALTER TABLE tonic.products ADD COLUMN is_available_pos BOOLEAN NOT NULL DEFAULT true
    `);
    logger.info('    Columna is_available_pos agregada con DEFAULT true');
  } else {
    logger.info('    Columna is_available_pos ya existe');
  }

  // Paso 2: Asegurar que todos los productos tengan is_available_pos = true
  logger.info('  Paso 2: Habilitando is_available_pos para todos los productos...');
  const result = await v2Pool.query(`
    UPDATE tonic.products SET is_available_pos = true WHERE is_available_pos = false OR is_available_pos IS NULL
  `);
  logger.info(`    ${result.rowCount} productos actualizados`);

  // Paso 3: Verificación
  logger.info('  Verificación:');
  const v1 = await v2Pool.query('SELECT COUNT(*) AS total FROM tonic.products');
  const v2 = await v2Pool.query('SELECT COUNT(*) AS pos_true FROM tonic.products WHERE is_available_pos = true');
  const v3 = await v2Pool.query('SELECT COUNT(*) AS pos_false FROM tonic.products WHERE is_available_pos = false');
  logger.info(`    Total productos: ${v1.rows[0].total}`);
  logger.info(`    is_available_pos = true: ${v2.rows[0].pos_true}`);
  logger.info(`    is_available_pos = false: ${v3.rows[0].pos_false}`);

  logger.info(`\n  Fase 04g completa: ${result.rowCount} actualizados, ${errors.length} fallidos`);
  return { migrated: result.rowCount, skipped: 0, failed: errors.length, errors };
};
