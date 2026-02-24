const logger = require('./logger');

class IdResolver {
  constructor() {
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, notFound: 0 };
  }

  /**
   * Pre-carga el caché con datos de tablas v2 que tienen legacy_id.
   * Llamar antes de cada fase con las entidades que necesitará.
   */
  async warmUp(v2Pool, entities) {
    for (const { type, table, column } of entities) {
      const col = column || 'legacy_id';
      try {
        const { rows } = await v2Pool.query(
          `SELECT ${col}::text AS legacy_id, id FROM tonic.${table} WHERE ${col} IS NOT NULL`
        );
        for (const row of rows) {
          this.cache.set(`${type}:${row.legacy_id}`, row.id);
        }
        logger.debug(`  Caché calentado: ${type} → ${rows.length} entradas desde ${table}`);
      } catch (err) {
        logger.warn(`  No se pudo calentar caché para ${type} desde ${table}: ${err.message}`);
      }
    }

    // También cargar desde legacy_id_map
    try {
      const { rows } = await v2Pool.query(
        'SELECT entity_type, legacy_id, new_id FROM tonic.legacy_id_map'
      );
      for (const row of rows) {
        this.cache.set(`${row.entity_type}:${row.legacy_id}`, row.new_id);
      }
      logger.debug(`  Caché calentado: legacy_id_map → ${rows.length} entradas`);
    } catch (err) {
      logger.warn(`  No se pudo cargar legacy_id_map: ${err.message}`);
    }
  }

  /**
   * Resuelve un legacy_id a un UUID v2.
   * 1. Busca en caché
   * 2. Busca en columna legacy_id de la tabla destino
   * 3. Busca en legacy_id_map
   */
  async resolve(v2Pool, entityType, legacyId, tableName) {
    if (legacyId === null || legacyId === undefined) return null;

    const cacheKey = `${entityType}:${legacyId}`;
    if (this.cache.has(cacheKey)) {
      this.stats.hits++;
      return this.cache.get(cacheKey);
    }
    this.stats.misses++;

    // Buscar en columna legacy_id de la tabla destino
    if (tableName) {
      try {
        const { rows } = await v2Pool.query(
          `SELECT id FROM tonic.${tableName} WHERE legacy_id = $1 LIMIT 1`,
          [legacyId]
        );
        if (rows.length > 0) {
          this.cache.set(cacheKey, rows[0].id);
          return rows[0].id;
        }
      } catch (err) {
        logger.debug(`  resolve: error buscando en ${tableName}: ${err.message}`);
      }
    }

    // Buscar en legacy_id_map
    try {
      const { rows } = await v2Pool.query(
        'SELECT new_id FROM tonic.legacy_id_map WHERE entity_type = $1 AND legacy_id = $2 LIMIT 1',
        [entityType, String(legacyId)]
      );
      if (rows.length > 0) {
        this.cache.set(cacheKey, rows[0].new_id);
        return rows[0].new_id;
      }
    } catch (err) {
      logger.debug(`  resolve: error buscando en legacy_id_map: ${err.message}`);
    }

    this.stats.notFound++;
    return null;
  }

  /**
   * Registra un mapeo en caché (sin persistir en DB).
   */
  set(entityType, legacyId, newId) {
    this.cache.set(`${entityType}:${legacyId}`, newId);
  }

  /**
   * Inserta un mapeo en legacy_id_map y en caché.
   */
  async registerMapping(v2Pool, entityType, legacyId, newId, legacyTable, legacyData) {
    this.cache.set(`${entityType}:${legacyId}`, newId);
    await v2Pool.query(
      `INSERT INTO tonic.legacy_id_map (entity_type, legacy_id, new_id, legacy_table, legacy_data, migrated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (entity_type, legacy_id) DO NOTHING`,
      [entityType, String(legacyId), newId, legacyTable || null, legacyData ? JSON.stringify(legacyData) : null]
    );
  }

  getStats() {
    return { ...this.stats, cacheSize: this.cache.size };
  }

  clearCache() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, notFound: 0 };
  }
}

// Singleton
module.exports = new IdResolver();
