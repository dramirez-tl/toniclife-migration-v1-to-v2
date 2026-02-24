const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable } = require('../utils/batch-processor');

module.exports = async function phase02(v1Pool, v2Pool) {
  logger.phase('02', 'Sucursales');
  const allResults = [];

  // Pre-calentar caché de entidades necesarias
  await idResolver.warmUp(v2Pool, [
    { type: 'country', table: 'countries', column: 'id' },
    { type: 'currency', table: 'currencies', column: 'id' },
  ]);

  // --- branches (paso 1: insertar sin parent_branch_id) ---
  logger.table('branches', 'Migrando t_branch_office → branches (paso 1: sin parent)');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_branch_office ORDER BY id_branch_office',
    tableName: 'branches',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_branch_office || row.name_branch_office || `BR${row.id_branch_office}`)
        .toString().substring(0, 20).replace(/\s+/g, '_').toUpperCase();
      const countryId = await idResolver.resolve(v2Pool, 'country', row.id_country, 'countries');

      // Mapear rounding_mode desde v1
      let roundingMode = 'half_up';
      if (row.id_type_round) {
        const roundMap = { 1: 'half_up', 2: 'half_down', 3: 'floor', 4: 'ceil', 5: 'none' };
        roundingMode = roundMap[row.id_type_round] || 'half_up';
      }

      // Resolver currency_code
      const currencyCode = row.id_type_money === 1 ? 'MXN' : row.id_type_money === 2 ? 'USD' : row.id_type_money === 3 ? 'COP' : 'MXN';

      const { rows } = await client.query(
        `INSERT INTO tonic.branches (
          id, code, name, country_id, currency_code, rounding_mode,
          address_street, address_city, address_state, address_zip,
          address_phone, address_email,
          is_warehouse, is_pos_enabled, is_ecommerce_enabled,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11,
          false, true, true,
          COALESCE($12::boolean, true)
        )
        ON CONFLICT (code) DO NOTHING
        RETURNING id`,
        [
          code,
          row.name_branch_office || code,
          countryId,
          currencyCode,
          roundingMode,
          row.address_branch_office || null,
          row.city_branch_office || null,
          row.state_branch_office || null,
          row.zip_code_branch_office || null,
          row.phone_branch_office || null,
          row.email_branch_office || null,
          row.enabled_branch_office != null ? row.enabled_branch_office == 1 : true,
        ]
      );

      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'branch', row.id_branch_office, rows[0].id, 't_branch_office');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.branches WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'branch', row.id_branch_office, existing.rows[0].id, 't_branch_office');
        }
      }
    },
  }));

  // --- branches (paso 2: actualizar parent_branch_id) ---
  logger.table('branches', 'Actualizando parent_branch_id (self-refs via id_branch_office_stock)');
  const branchesWithParent = await v1Pool.query(
    'SELECT id_branch_office, id_branch_office_stock FROM toniclife.t_branch_office WHERE id_branch_office_stock IS NOT NULL'
  );
  let parentUpdated = 0;
  for (const row of branchesWithParent.rows) {
    const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office);
    const parentId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office_stock);
    if (branchId && parentId) {
      await v2Pool.query(
        'UPDATE tonic.branches SET parent_branch_id = $1 WHERE id = $2',
        [parentId, branchId]
      );
      parentUpdated++;
    }
  }
  logger.info(`  ✓ branches parent_branch_id: ${parentUpdated} actualizados`);

  // --- branch_tax_rules ---
  logger.table('branch_tax_rules', 'Migrando t_branch_office_tax → branch_tax_rules');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_branch_office, id_tax, order_tax FROM toniclife.t_branch_office_tax ORDER BY id_branch_office, id_tax',
    tableName: 'branch_tax_rules',
    transformAndInsert: async (row, client) => {
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office);
      const taxRuleId = await idResolver.resolve(v2Pool, 'tax_rule', row.id_tax);

      if (!branchId || !taxRuleId) {
        logger.debug(`    Omitiendo branch_tax_rule: branch=${row.id_branch_office}→${branchId}, tax=${row.id_tax}→${taxRuleId}`);
        return 'skipped';
      }

      await client.query(
        `INSERT INTO tonic.branch_tax_rules (id, branch_id, tax_rule_id, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT DO NOTHING`,
        [branchId, taxRuleId, row.order_tax ? 1 : 0]
      );
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 02 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
