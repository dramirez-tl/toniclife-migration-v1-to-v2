const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal } = require('../utils/validators');
const { prefixUrl } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase08(v1Pool, v2Pool) {
  logger.phase('08', 'Facturación');
  const allResults = [];

  // Pre-calentar caché
  await idResolver.warmUp(v2Pool, [
    { type: 'customer', table: 'customers' },
    { type: 'branch', table: 'branches' },
    { type: 'product', table: 'products' },
  ]);

  // Obtener provider_id de Facturama
  const providerResult = await v2Pool.query(
    "SELECT id FROM tonic.invoice_providers WHERE code = 'facturama' LIMIT 1"
  );
  const providerId = providerResult.rows.length > 0 ? providerResult.rows[0].id : null;

  // --- invoices desde t_factura_libre (tipo=sale) ---
  logger.table('invoices (sale)', 'Migrando t_factura_libre → invoices');
  const invoiceCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_factura_libre');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT
        id_factura_libre, id_customers, full_name, rfc_customers,
        curp_customers, zip_code_customers, id_regimen, id_cfdi,
        subtotal, isr, total, type, created_at, created_user,
        folio_id, facturama_id, facturama_response, id_period,
        id_branch_office, has_invoice_doc, iva, total_iva,
        total_sin_iva, id_type_format_pay, invoice_change,
        name_path, payment_form_facturama
      FROM toniclife.t_factura_libre ORDER BY id_factura_libre`,
    tableName: 'invoices (sale)',
    totalCount: invoiceCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office)
        || await idResolver.resolve(v2Pool, 'branch', 1);

      if (!branchId) return 'skipped';

      const invoiceNumber = `FAC-${row.id_factura_libre}`;
      const rawPath = row.name_path && !String(row.name_path).includes('/')
        ? `files/facturama/${row.name_path}` : row.name_path;
      const xmlFilePath = prefixUrl(rawPath);

      await client.query(
        `INSERT INTO tonic.invoices (
          id, invoice_number, legacy_id, invoice_type,
          customer_id, branch_id, provider_id,
          receiver_name, receiver_rfc,
          receiver_cfdi_use_code, payment_method_code, payment_form_code,
          subtotal, tax_amount, total,
          sat_uuid, xml_file_path, pdf_file_path,
          provider_status, stamped_at,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, 'sale',
          $3, $4, $5,
          $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, $15, $16,
          $17, $18,
          true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          invoice_number = EXCLUDED.invoice_number,
          invoice_type = EXCLUDED.invoice_type,
          customer_id = EXCLUDED.customer_id,
          branch_id = EXCLUDED.branch_id,
          provider_id = EXCLUDED.provider_id,
          receiver_name = EXCLUDED.receiver_name,
          receiver_rfc = EXCLUDED.receiver_rfc,
          receiver_cfdi_use_code = EXCLUDED.receiver_cfdi_use_code,
          payment_method_code = EXCLUDED.payment_method_code,
          payment_form_code = EXCLUDED.payment_form_code,
          subtotal = EXCLUDED.subtotal,
          tax_amount = EXCLUDED.tax_amount,
          total = EXCLUDED.total,
          sat_uuid = EXCLUDED.sat_uuid,
          xml_file_path = CASE WHEN tonic.invoices.xml_file_path LIKE 'https://storage.googleapis.com/%'
                               THEN tonic.invoices.xml_file_path ELSE EXCLUDED.xml_file_path END,
          pdf_file_path = EXCLUDED.pdf_file_path,
          provider_status = EXCLUDED.provider_status,
          stamped_at = EXCLUDED.stamped_at,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          invoiceNumber,                                            // $1
          row.id_factura_libre,                                     // $2
          customerId,                                               // $3
          branchId,                                                 // $4
          providerId,                                               // $5
          cleanString(row.full_name) || 'Sin nombre',               // $6
          cleanString(row.rfc_customers),                           // $7
          cleanString(row.id_cfdi),                                 // $8
          null,                                                     // $9  metodo_pago no existe en v1
          cleanString(row.payment_form_facturama),                  // $10
          toDecimal(row.subtotal, 0),                               // $11
          toDecimal(row.iva, 0),                                    // $12
          toDecimal(row.total, 0),                                  // $13
          cleanString(row.facturama_id),                            // $14
          xmlFilePath,                                              // $15
          null,                                                     // $16 pdf_file_path no existe en v1
          row.facturama_id ? 'stamped' : 'pending',                 // $17
          row.created_at || null,                                   // $18
        ]
      );
    },
  }));

  // --- invoice_items desde t_factura_libre_det ---
  logger.table('invoice_items', 'Migrando t_factura_libre_det → invoice_items');
  const itemCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_factura_libre_det');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT
        id_factura_libre_det, id_factura_libre, id_product, qty, price
      FROM toniclife.t_factura_libre_det ORDER BY id_factura_libre_det`,
    tableName: 'invoice_items',
    totalCount: itemCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const invoiceResult = await client.query(
        'SELECT id FROM tonic.invoices WHERE legacy_id = $1 LIMIT 1',
        [row.id_factura_libre]
      );
      if (invoiceResult.rows.length === 0) return 'skipped';

      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);

      const qty = toDecimal(row.qty, 1);
      const price = toDecimal(row.price, 0);
      const total = toDecimal(qty * price, 0);

      await client.query(
        `INSERT INTO tonic.invoice_items (
          id, invoice_id, product_id, description,
          quantity, unit_price, subtotal, total, legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6, $7, $8, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          invoice_id = EXCLUDED.invoice_id,
          product_id = EXCLUDED.product_id,
          description = EXCLUDED.description,
          quantity = EXCLUDED.quantity,
          unit_price = EXCLUDED.unit_price,
          subtotal = EXCLUDED.subtotal,
          total = EXCLUDED.total,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          invoiceResult.rows[0].id,
          productId,
          'Producto migrado',
          qty,
          price,
          total,
          total,
          row.id_factura_libre_det,
        ]
      );
    },
  }));

  // --- invoices desde t_bono_facturama (tipo=commission) ---
  logger.table('invoices (commission)', 'Migrando t_bono_facturama → invoices');
  const bonoCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_bono_facturama');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT
        id_bono_factura, id_customers, date_start, date_end,
        facturama_response, facturama_id, facturama_error,
        folio_id, change_total, subtotal, isr, total,
        facturama_date, path_file, id_period
      FROM toniclife.t_bono_facturama ORDER BY id_bono_factura`,
    tableName: 'invoices (commission)',
    totalCount: bonoCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const branchId = await idResolver.resolve(v2Pool, 'branch', 1);

      const legacyId = Number(row.id_bono_factura) + 10000000;
      const xmlFilePath = prefixUrl(row.path_file);

      await client.query(
        `INSERT INTO tonic.invoices (
          id, invoice_number, legacy_id, invoice_type,
          customer_id, branch_id, provider_id,
          receiver_name, receiver_rfc,
          subtotal, tax_amount, total,
          sat_uuid, xml_file_path, pdf_file_path,
          provider_status, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, 'commission',
          $3, $4, $5,
          $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          invoice_number = EXCLUDED.invoice_number,
          invoice_type = EXCLUDED.invoice_type,
          customer_id = EXCLUDED.customer_id,
          branch_id = EXCLUDED.branch_id,
          provider_id = EXCLUDED.provider_id,
          receiver_name = EXCLUDED.receiver_name,
          receiver_rfc = EXCLUDED.receiver_rfc,
          subtotal = EXCLUDED.subtotal,
          tax_amount = EXCLUDED.tax_amount,
          total = EXCLUDED.total,
          sat_uuid = EXCLUDED.sat_uuid,
          xml_file_path = CASE WHEN tonic.invoices.xml_file_path LIKE 'https://storage.googleapis.com/%'
                               THEN tonic.invoices.xml_file_path ELSE EXCLUDED.xml_file_path END,
          pdf_file_path = EXCLUDED.pdf_file_path,
          provider_status = EXCLUDED.provider_status,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          `BONO-${row.id_bono_factura}`,
          legacyId,
          customerId,
          branchId,
          providerId,
          'Comisión',
          null,
          toDecimal(row.subtotal, 0),
          toDecimal(row.isr, 0),
          toDecimal(row.total, 0),
          cleanString(row.facturama_id),
          xmlFilePath,
          null,
          row.facturama_id ? 'stamped' : 'pending',
        ]
      );
    },
  }));

  // --- invoices desde t_bono_cedea_facturama (tipo=cedea) ---
  logger.table('invoices (cedea)', 'Migrando t_bono_cedea_facturama → invoices');
  const cedeaCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_bono_cedea_facturama');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT
        id_bono_cedea_factura, id_customers, id_period,
        facturama_response, facturama_id, facturama_error,
        folio_id, change_total, subtotal_changed, isr_changed,
        total_changed, facturama_date
      FROM toniclife.t_bono_cedea_facturama ORDER BY id_bono_cedea_factura`,
    tableName: 'invoices (cedea)',
    totalCount: cedeaCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const branchId = await idResolver.resolve(v2Pool, 'branch', 1);

      const legacyId = Number(row.id_bono_cedea_factura) + 20000000;

      await client.query(
        `INSERT INTO tonic.invoices (
          id, invoice_number, legacy_id, invoice_type,
          customer_id, branch_id, provider_id,
          receiver_name, receiver_rfc,
          subtotal, tax_amount, total,
          sat_uuid, provider_status, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, 'cedea',
          $3, $4, $5,
          $6, $7,
          $8, $9, $10,
          $11, $12, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          invoice_number = EXCLUDED.invoice_number,
          invoice_type = EXCLUDED.invoice_type,
          customer_id = EXCLUDED.customer_id,
          branch_id = EXCLUDED.branch_id,
          provider_id = EXCLUDED.provider_id,
          receiver_name = EXCLUDED.receiver_name,
          receiver_rfc = EXCLUDED.receiver_rfc,
          subtotal = EXCLUDED.subtotal,
          tax_amount = EXCLUDED.tax_amount,
          total = EXCLUDED.total,
          sat_uuid = EXCLUDED.sat_uuid,
          provider_status = EXCLUDED.provider_status,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          `CEDEA-${row.id_bono_cedea_factura}`,
          legacyId,
          customerId,
          branchId,
          providerId,
          'CEDEA',
          null,
          toDecimal(row.subtotal_changed, 0),
          toDecimal(row.isr_changed, 0),
          toDecimal(row.total_changed, 0),
          cleanString(row.facturama_id),
          row.facturama_id ? 'stamped' : 'pending',
        ]
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

  logger.info(`\n  Fase 08 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
