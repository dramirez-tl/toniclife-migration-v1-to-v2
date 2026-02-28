const logger = require('./logger');

class IdResolver {
  constructor() {
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, notFound: 0 };
  }

  /**
   * Pre-carga el caché con datos de tablas v2 que tienen legacy_id.
   * Ejecuta todas las cargas en paralelo con Promise.all.
   */
  async warmUp(v2Pool, entities) {
    const promises = entities.map(async ({ type, table, column }) => {
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
    });

    await Promise.all(promises);

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
   * Pre-carga el caché con una query custom.
   * La query debe retornar columnas: legacy_id (text), id (uuid).
   */
  async warmUpFromQuery(v2Pool, entityType, query) {
    try {
      const { rows } = await v2Pool.query(query);
      for (const row of rows) {
        this.cache.set(`${entityType}:${row.legacy_id}`, row.id);
      }
      logger.debug(`  Caché calentado: ${entityType} → ${rows.length} entradas (query custom)`);
    } catch (err) {
      logger.warn(`  No se pudo calentar caché para ${entityType} (query custom): ${err.message}`);
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
   * Resuelve múltiples legacy_ids en un solo query bulk.
   * Retorna Map<string, string> de legacyId → UUID.
   */
  async resolveMany(v2Pool, entityType, legacyIds, tableName) {
    if (!legacyIds || legacyIds.length === 0) return new Map();

    const result = new Map();
    const uncached = [];

    // Check cache first
    for (const id of legacyIds) {
      if (id === null || id === undefined) continue;
      const key = String(id);
      const cacheKey = `${entityType}:${key}`;
      if (this.cache.has(cacheKey)) {
        this.stats.hits++;
        result.set(key, this.cache.get(cacheKey));
      } else {
        uncached.push(id);
      }
    }

    if (uncached.length === 0) return result;
    this.stats.misses += uncached.length;

    // Bulk lookup in table
    if (tableName) {
      try {
        const { rows } = await v2Pool.query(
          `SELECT legacy_id::text AS legacy_id, id FROM tonic.${tableName} WHERE legacy_id = ANY($1::bigint[])`,
          [uncached]
        );
        for (const row of rows) {
          this.cache.set(`${entityType}:${row.legacy_id}`, row.id);
          result.set(row.legacy_id, row.id);
        }
      } catch (err) {
        logger.debug(`  resolveMany: error bulk lookup in ${tableName}: ${err.message}`);
      }
    }

    // Check which are still missing
    const stillMissing = uncached.filter(id => !result.has(String(id)));

    if (stillMissing.length > 0) {
      // Bulk lookup in legacy_id_map
      try {
        const { rows } = await v2Pool.query(
          `SELECT legacy_id, new_id FROM tonic.legacy_id_map WHERE entity_type = $1 AND legacy_id = ANY($2::text[])`,
          [entityType, stillMissing.map(String)]
        );
        for (const row of rows) {
          this.cache.set(`${entityType}:${row.legacy_id}`, row.new_id);
          result.set(row.legacy_id, row.new_id);
        }
      } catch (err) {
        logger.debug(`  resolveMany: error bulk lookup in legacy_id_map: ${err.message}`);
      }

      // Count not found
      const finalMissing = stillMissing.filter(id => !result.has(String(id)));
      this.stats.notFound += finalMissing.length;
    }

    return result;
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

  /**
   * Inserta múltiples mapeos en legacy_id_map en un solo INSERT multi-row.
   * mappings: Array<{ entityType, legacyId, newId, legacyTable?, legacyData? }>
   */
  async registerMappingBatch(v2Pool, mappings) {
    if (!mappings || mappings.length === 0) return;

    // Set all in cache
    for (const m of mappings) {
      this.cache.set(`${m.entityType}:${m.legacyId}`, m.newId);
    }

    // Build multi-row INSERT with chunking
    const COLS_PER_ROW = 5;
    const MAX_PARAMS = 65535;
    const chunkSize = Math.floor(MAX_PARAMS / COLS_PER_ROW);

    for (let i = 0; i < mappings.length; i += chunkSize) {
      const chunk = mappings.slice(i, i + chunkSize);
      const values = [];
      const params = [];

      for (let j = 0; j < chunk.length; j++) {
        const m = chunk[j];
        const offset = j * COLS_PER_ROW;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        params.push(
          m.entityType,
          String(m.legacyId),
          m.newId,
          m.legacyTable || null,
          m.legacyData ? JSON.stringify(m.legacyData) : null
        );
      }

      await v2Pool.query(
        `INSERT INTO tonic.legacy_id_map (entity_type, legacy_id, new_id, legacy_table, legacy_data)
         VALUES ${values.join(', ')}
         ON CONFLICT (entity_type, legacy_id) DO NOTHING`,
        params
      );
    }
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
