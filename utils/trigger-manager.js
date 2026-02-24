const logger = require('./logger');

/**
 * Deshabilita TODOS los triggers en el schema tonic.
 */
async function disableAllTriggers(v2Pool) {
  logger.info('Deshabilitando todos los triggers en schema tonic...');
  const { rows } = await v2Pool.query(`
    SELECT DISTINCT c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'tonic'
      AND NOT t.tgisinternal
  `);

  for (const row of rows) {
    await v2Pool.query(`ALTER TABLE tonic."${row.table_name}" DISABLE TRIGGER ALL`);
  }
  logger.info(`  Triggers deshabilitados en ${rows.length} tablas`);
}

/**
 * Re-habilita TODOS los triggers en el schema tonic.
 */
async function enableAllTriggers(v2Pool) {
  logger.info('Re-habilitando todos los triggers en schema tonic...');
  const { rows } = await v2Pool.query(`
    SELECT DISTINCT c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'tonic'
      AND NOT t.tgisinternal
  `);

  for (const row of rows) {
    await v2Pool.query(`ALTER TABLE tonic."${row.table_name}" ENABLE TRIGGER ALL`);
  }
  logger.info(`  Triggers re-habilitados en ${rows.length} tablas`);
}

/**
 * Elimina temporalmente el CHECK constraint de network_members
 * que impide tener depth=0 con parent_id no null (necesario durante migración).
 */
async function dropNetworkCheckConstraint(v2Pool) {
  logger.info('Eliminando CHECK constraint chk_network_members_root_depth...');
  try {
    await v2Pool.query(`
      ALTER TABLE tonic.network_members
      DROP CONSTRAINT IF EXISTS chk_network_members_root_depth
    `);
    logger.info('  CHECK constraint eliminado');
  } catch (err) {
    logger.warn(`  No se pudo eliminar constraint: ${err.message}`);
  }
}

/**
 * Restaura el CHECK constraint de network_members.
 */
async function restoreNetworkCheckConstraint(v2Pool) {
  logger.info('Restaurando CHECK constraint chk_network_members_root_depth...');
  try {
    await v2Pool.query(`
      ALTER TABLE tonic.network_members
      ADD CONSTRAINT chk_network_members_root_depth
      CHECK ((depth = 0 AND parent_id IS NULL) OR (depth > 0 AND parent_id IS NOT NULL))
    `);
    logger.info('  CHECK constraint restaurado');
  } catch (err) {
    logger.warn(`  No se pudo restaurar constraint: ${err.message}`);
  }
}

/**
 * Elimina temporalmente el CHECK constraint de stock_levels
 * que impide cantidades negativas (v1 puede tenerlas).
 */
async function dropStockLevelsCheckConstraint(v2Pool) {
  logger.info('Eliminando CHECK constraint chk_stock_levels_qty_on_hand...');
  try {
    await v2Pool.query(`
      ALTER TABLE tonic.stock_levels
      DROP CONSTRAINT IF EXISTS chk_stock_levels_qty_on_hand
    `);
    logger.info('  CHECK constraint eliminado');
  } catch (err) {
    logger.warn(`  No se pudo eliminar constraint: ${err.message}`);
  }
}

/**
 * Restaura el CHECK constraint de stock_levels.
 */
async function restoreStockLevelsCheckConstraint(v2Pool) {
  logger.info('Restaurando CHECK constraint chk_stock_levels_qty_on_hand...');
  try {
    await v2Pool.query(`
      ALTER TABLE tonic.stock_levels
      ADD CONSTRAINT chk_stock_levels_qty_on_hand
      CHECK (quantity_on_hand >= 0)
    `);
    logger.info('  CHECK constraint restaurado');
  } catch (err) {
    logger.warn(`  No se pudo restaurar constraint (puede haber datos negativos): ${err.message}`);
  }
}

/**
 * Crea índices UNIQUE faltantes necesarios para ON CONFLICT.
 */
async function createMissingUniqueIndexes(v2Pool) {
  logger.info('Creando índices UNIQUE faltantes...');

  const indexes = [
    {
      name: 'uq_network_members_legacy_id',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_network_members_legacy_id
            ON tonic.network_members(legacy_id) WHERE legacy_id IS NOT NULL`,
    },
    {
      name: 'uq_network_branch_assignments_legacy_id',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_network_branch_assignments_legacy_id
            ON tonic.network_branch_assignments(legacy_id) WHERE legacy_id IS NOT NULL`,
    },
  ];

  for (const idx of indexes) {
    try {
      await v2Pool.query(idx.sql);
      logger.info(`  Índice ${idx.name} creado/verificado`);
    } catch (err) {
      logger.warn(`  Error creando índice ${idx.name}: ${err.message}`);
    }
  }
}

module.exports = {
  disableAllTriggers,
  enableAllTriggers,
  dropNetworkCheckConstraint,
  restoreNetworkCheckConstraint,
  dropStockLevelsCheckConstraint,
  restoreStockLevelsCheckConstraint,
  createMissingUniqueIndexes,
};
