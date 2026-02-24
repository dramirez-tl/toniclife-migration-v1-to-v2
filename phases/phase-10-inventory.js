const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal } = require('../utils/validators');

module.exports = async function phase10(v1Pool, v2Pool) {
  logger.phase('10', 'Inventario');
  const allResults = [];

  // --- inventory_counts ---
  // t_inventory (PK: id_inventory): id_inventory, name_inventory, date_inventory,
  //   total_inventory, qty_difference_total_inventory, id_branch_office,
  //   user_created, created_at, user_updated, updated_at
  logger.table('inventory_counts', 'Migrando t_inventory → inventory_counts');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_inventory, name_inventory, date_inventory,
                         total_inventory, qty_difference_total_inventory,
                         id_branch_office, user_created, created_at,
                         user_updated, updated_at
                  FROM toniclife.t_inventory
                  ORDER BY id_inventory`,
    tableName: 'inventory_counts',
    transformAndInsert: async (row, client) => {
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office);
      if (!branchId) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.inventory_counts (
          id, count_number, branch_id, count_type, planned_date, status, notes, is_active
        ) VALUES (gen_random_uuid(), $1, $2, 'full', $3, 'approved', $4, true)
        ON CONFLICT (count_number) DO UPDATE SET
          planned_date = EXCLUDED.planned_date,
          count_type = EXCLUDED.count_type,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING id`,
        [
          `INV-${row.id_inventory}`,
          branchId,
          row.date_inventory || new Date(),
          cleanString(row.name_inventory),
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'inventory_count', row.id_inventory, rows[0].id, 't_inventory');
      }
    },
  }));

  // --- inventory_count_details ---
  // t_inventory_det (NO PK, no id column): id_inventory, id_product,
  //   qty_system, qty_physic, qty_difference, subtotal, price
  logger.table('inventory_count_details', 'Migrando t_inventory_det → inventory_count_details');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_inventory, id_product, qty_system, qty_physic,
                         qty_difference, subtotal, price
                  FROM toniclife.t_inventory_det
                  ORDER BY id_inventory, id_product`,
    tableName: 'inventory_count_details',
    transformAndInsert: async (row, client) => {
      const countId = await idResolver.resolve(v2Pool, 'inventory_count', row.id_inventory);
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!countId || !productId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.inventory_count_details (
          id, count_id, product_id,
          system_quantity, counted_quantity
        )
        SELECT gen_random_uuid(), $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM tonic.inventory_count_details
          WHERE count_id = $1 AND product_id = $2
        )`,
        [
          countId, productId,
          toDecimal(row.qty_system, 0),
          toDecimal(row.qty_physic, 0),
        ]
      );
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated; acc.skipped += r.skipped; acc.failed += r.failed; acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 10 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
