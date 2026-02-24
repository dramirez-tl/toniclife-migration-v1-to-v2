const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, prefixUrl } = require('../utils/validators');

module.exports = async function phase10b(v1Pool, v2Pool) {
  logger.phase('10.5', 'Proveedores y Compras');
  const allResults = [];

  // --- company_entities ---
  // t_company (PK: id_company): id_company, name_company, enabled_company — ONLY 3 COLUMNS
  logger.table('company_entities', 'Migrando t_company → company_entities');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_company, name_company, enabled_company
                  FROM toniclife.t_company
                  ORDER BY id_company`,
    tableName: 'company_entities',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.company_entities (
          id, company_name, rfc, legal_name, legacy_id, is_active
        ) VALUES (gen_random_uuid(), $1, NULL, NULL, $2, true)
        ON CONFLICT (legacy_id) DO NOTHING`,
        [
          cleanString(row.name_company) || `COMP${row.id_company}`,
          row.id_company,
        ]
      );
    },
  }));

  // --- cost_centers ---
  // t_cost_centers (PK: id): id, cost_center_name, department_id — ONLY 3 COLUMNS
  logger.table('cost_centers', 'Migrando t_cost_centers → cost_centers');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id, cost_center_name, department_id
                  FROM toniclife.t_cost_centers
                  ORDER BY id`,
    tableName: 'cost_centers',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.cost_centers (
          id, code, name, legacy_id, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, true)
        ON CONFLICT (legacy_id) DO NOTHING`,
        [
          `CC-${row.id}`,
          cleanString(row.cost_center_name) || `Centro ${row.id}`,
          row.id,
        ]
      );
    },
  }));

  // --- suppliers ---
  // t_suppliers (PK: id): id, supplier_name, rfc, address, id_bank, cc, cci,
  //   status(bool), created_at, updated_at, cuenta_contable,
  //   nombre_contacto, telefono_contacto, correo_contacto
  logger.table('suppliers', 'Migrando t_suppliers → suppliers');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id, supplier_name, rfc, address, id_bank, cc, cci,
                         status, created_at, updated_at, cuenta_contable,
                         nombre_contacto, telefono_contacto, correo_contacto
                  FROM toniclife.t_suppliers
                  ORDER BY id`,
    tableName: 'suppliers',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.suppliers (
          id, supplier_code, supplier_name, rfc,
          bank_name, bank_account_number, bank_account_clabe,
          legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6,
          $7, true
        )
        ON CONFLICT (legacy_id) DO NOTHING`,
        [
          `SUP-${row.id}`,
          cleanString(row.supplier_name) || `Proveedor ${row.id}`,
          cleanTrunc(row.rfc, 13),
          null,                        // bank_name — does not exist in v1
          cleanTrunc(row.cc, 20),         // bank_account_number ← cc
          cleanTrunc(row.cci, 20),        // bank_account_clabe  ← cci
          row.id,
        ]
      );
    },
  }));

  // --- purchase_orders ---
  // t_supplier_requests (PK: id): id, supplier_id, amount, request_description,
  //   request_date, created_at, updated_at, user_created, status(enum),
  //   user_action, rejection_reason, file_path, id_company
  logger.table('purchase_orders', 'Migrando t_supplier_requests → purchase_orders');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id, supplier_id, amount, request_description,
                         request_date, created_at, updated_at, user_created,
                         status, user_action, rejection_reason, file_path,
                         id_company
                  FROM toniclife.t_supplier_requests
                  ORDER BY id`,
    tableName: 'purchase_orders',
    transformAndInsert: async (row, client) => {
      const supplierResult = await client.query(
        'SELECT id FROM tonic.suppliers WHERE legacy_id = $1 LIMIT 1',
        [row.supplier_id]
      );
      if (supplierResult.rows.length === 0) return 'skipped';

      const branchId = await idResolver.resolve(v2Pool, 'branch', 1); // default branch
      if (!branchId) return 'skipped';

      const totalAmount = toDecimal(row.amount, 0);

      // purchase_orders has no UNIQUE index on legacy_id — use NOT EXISTS for idempotency
      await client.query(
        `INSERT INTO tonic.purchase_orders (
          id, po_number, supplier_id, branch_id,
          currency_code, subtotal, tax_amount, total_amount,
          file_url, status, legacy_id, is_active
        )
        SELECT gen_random_uuid(), $1, $2, $3,
          $4, $5, $6, $7,
          $8, 'completed', $9, true
        WHERE NOT EXISTS (
          SELECT 1 FROM tonic.purchase_orders WHERE legacy_id = $9
        )`,
        [
          `PO-${row.id}`,
          supplierResult.rows[0].id,
          branchId,                     // branch_id — default branch
          'MXN',                        // currency_code — default
          totalAmount,                  // subtotal  ← amount (only column available)
          0,                            // tax_amount — not available in v1
          totalAmount,                  // total_amount ← amount (only column available)
          prefixUrl(row.file_path),     // file_url ← file_path
          row.id,
        ]
      );
    },
  }));

  // --- purchase_order_cost_centers ---
  // t_supplier_request_cost_centers (PK: id): id, supplier_request_id,
  //   cost_center_id, amount
  logger.table('purchase_order_cost_centers', 'Migrando t_supplier_request_cost_centers');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id, supplier_request_id, cost_center_id, amount
                  FROM toniclife.t_supplier_request_cost_centers
                  ORDER BY id`,
    tableName: 'purchase_order_cost_centers',
    transformAndInsert: async (row, client) => {
      const poResult = await client.query(
        'SELECT id FROM tonic.purchase_orders WHERE legacy_id = $1 LIMIT 1',
        [row.supplier_request_id]
      );
      const ccResult = await client.query(
        'SELECT id FROM tonic.cost_centers WHERE legacy_id = $1 LIMIT 1',
        [row.cost_center_id]
      );
      if (poResult.rows.length === 0 || ccResult.rows.length === 0) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.purchase_order_cost_centers (
          id, purchase_order_id, cost_center_id, amount, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, true)
        RETURNING id`,
        [poResult.rows[0].id, ccResult.rows[0].id, toDecimal(row.amount, 0)]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'po_cost_center', row.id, rows[0].id, 't_supplier_request_cost_centers');
      }
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated; acc.skipped += r.skipped; acc.failed += r.failed; acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 10.5 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
