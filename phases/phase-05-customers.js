const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toBoolean, toDecimal, validateEnum } = require('../utils/validators');
const { uploadMultiple } = require('../utils/gcs-uploader');
const { mapValue, CUSTOMER_STATUS, KIT_TYPE, LANGUAGE_CODE } = require('../mappings/value-maps');
const config = require('../config');

module.exports = async function phase05(v1Pool, v2Pool) {
  logger.phase('05', 'Clientes / Distribuidores');
  const allResults = [];

  // Pre-calentar caché
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches', column: 'id' },
    { type: 'price_type', table: 'price_types', column: 'id' },
    { type: 'country', table: 'countries', column: 'id' },
  ]);

  // Resolver defaults para NOT NULL
  // Default branch: legacy id_branch_office = 1 (MX CALL CENTER)
  const defaultBranchId = await idResolver.resolve(v2Pool, 'branch', 1);
  // Default price_type: legacy id_type_price = 1 (Distribuidor)
  const defaultPriceTypeId = await idResolver.resolve(v2Pool, 'price_type', 1);

  if (!defaultBranchId) {
    logger.error('  No se encontró branch default (legacy_id=1). Abortando fase 05.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: 'Default branch not found' }] };
  }
  if (!defaultPriceTypeId) {
    logger.error('  No se encontró price_type default (legacy_id=1). Abortando fase 05.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: 'Default price_type not found' }] };
  }

  // --- mlm_ranks ---
  logger.table('mlm_ranks', 'Migrando t_plan → mlm_ranks');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_plan ORDER BY id_plan',
    tableName: 'mlm_ranks',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_plan || row.name_plan || `RANK${row.id_plan}`)
        .toString().substring(0, 30).toLowerCase().replace(/\s+/g, '_');
      await client.query(
        `INSERT INTO tonic.mlm_ranks (
          id, code, name, rank_number, legacy_id,
          points_personal_required, points_group_required,
          qualifiers_first_level, level_max, generation_max,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8, $9, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()`,
        [
          code,
          row.name_plan || code,
          row.order_plan || row.id_plan,
          row.id_plan,
          toDecimal(row.points_plan, 0),
          toDecimal(row.points_group_plan, 0),
          row.qualifiers_plan || 0,
          row.level_max_plan || null,
          row.generation_max_plan || 0,
        ]
      );
    },
  }));

  // --- mlm_level_commissions ---
  logger.table('mlm_level_commissions', 'Migrando t_nivel → mlm_level_commissions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_nivel ORDER BY id_nivel',
    tableName: 'mlm_level_commissions',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.mlm_level_commissions (
          id, level_number, name, base_percentage, upgraded_percentage,
          qualifiers_required, legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          base_percentage = EXCLUDED.base_percentage,
          updated_at = NOW()`,
        [
          row.number_nivel || row.id_nivel,
          row.name_nivel || `Nivel ${row.id_nivel}`,
          toDecimal(row.percentage_nivel, 0),
          toDecimal(row.percentage_upgraded_nivel, 0),
          row.qualifiers_nivel || 0,
          row.id_nivel,
        ]
      );
    },
  }));

  // --- mlm_generation_commissions ---
  logger.table('mlm_generation_commissions', 'Migrando t_generation → mlm_generation_commissions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_generation ORDER BY id_generation',
    tableName: 'mlm_generation_commissions',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.mlm_generation_commissions (
          id, generation_number, percentage, legacy_id, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, true)
        ON CONFLICT (legacy_id) DO UPDATE SET
          percentage = EXCLUDED.percentage,
          updated_at = NOW()`,
        [
          row.number_generation || row.id_generation,
          toDecimal(row.percentage_generation, 0),
          row.id_generation,
        ]
      );
    },
  }));

  // Calentar caché con mlm_ranks recién migrados
  await idResolver.warmUp(v2Pool, [
    { type: 'mlm_rank', table: 'mlm_ranks', column: 'legacy_id' },
    { type: 'sat_tax_regime', table: 'sat_tax_regimes', column: 'legacy_id' },
    { type: 'commission_tax_regime', table: 'commission_tax_regimes', column: 'id' },
  ]);

  // --- customers (218K registros) — PASO 1: sin self-refs ---
  logger.table('customers', 'Migrando t_customers → customers (paso 1: sin sponsor/upline)');
  const customerCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers');
  logger.info(`    Total registros en t_customers: ${customerCount.toLocaleString()}`);

  // Preconstruir mapa de commission_tax_regime por código
  const commTaxRes = await v2Pool.query('SELECT id, code FROM tonic.commission_tax_regimes');
  const commTaxMap = {};
  for (const r of commTaxRes.rows) commTaxMap[r.code] = r.id;

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_customers ORDER BY id_customers',
    tableName: 'customers',
    totalCount: customerCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const firstName = cleanString(row.name_customers) || 'SIN NOMBRE';
      const lastName = cleanString(row.last_name_customers) || 'SIN APELLIDO';
      const customerNumber = String(row.id_customers).substring(0, 20);
      const status = mapValue(CUSTOMER_STATUS, row.id_status);
      const kitType = cleanTrunc(mapValue(KIT_TYPE, row.id_kit), 20);
      const languageCode = mapValue(LANGUAGE_CODE, row.id_language);

      // Resolver FKs
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office) || defaultBranchId;
      const priceTypeId = await idResolver.resolve(v2Pool, 'price_type', row.id_type_price) || defaultPriceTypeId;
      const rankId = await idResolver.resolve(v2Pool, 'mlm_rank', row.id_plan, 'mlm_ranks');
      const countryId = await idResolver.resolve(v2Pool, 'country', row.id_country);
      const satTaxRegimeId = await idResolver.resolve(v2Pool, 'sat_tax_regime', row.id_regimen, 'sat_tax_regimes');

      // commission_tax_regime: mapear desde el campo del customer si existe
      let commissionTaxRegimeId = null;
      if (row.tax_regime_customers) {
        commissionTaxRegimeId = commTaxMap[row.tax_regime_customers] || null;
      }

      // Upload customer documents to GCS (runs 5 uploads concurrently, skips NULLs)
      const [photoUrl, contractUrl, ineUrl, bankStatementUrl, taxIdUrl] = await uploadMultiple([
        { rawPath: row.file_photo_customers,   gcsFolder: `customers/${row.id_customers}/photo` },
        { rawPath: row.file_contract,          gcsFolder: `customers/${row.id_customers}/contract` },
        { rawPath: row.file_ine,              gcsFolder: `customers/${row.id_customers}/ine` },
        { rawPath: row.file_cuenta_bancaria,   gcsFolder: `customers/${row.id_customers}/bank-statement` },
        { rawPath: row.file_constancia_fiscal, gcsFolder: `customers/${row.id_customers}/tax-id` },
      ]);

      await client.query(
        `INSERT INTO tonic.customers (
          id, legacy_id, customer_number, first_name, last_name, mothers_last_name,
          email, phone, date_of_birth, curp, rfc, ine_number, nss,
          rank_id, current_rank_id,
          customer_type, status, kit_type,
          branch_id, price_type_id, country_id,
          sat_tax_regime_id, commission_tax_regime_id,
          cfdi_use_code, language_code,
          registration_date, last_purchase_date,
          average_monthly_purchase,
          photo_url, contract_url, ine_document_url,
          bank_statement_url, tax_id_document_url,
          documents_validated, terms_accepted, terms_accepted_at,
          is_online_registration, membership_paid,
          moved_roll_over, discount_two_periods,
          payroll_tax_regime_code, payroll_cfdi_use_code,
          payroll_curp, payroll_rfc, payroll_zip_code,
          payment_form_code,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11, $12,
          $13, $13,
          'distributor', $14, $15,
          $16, $17, $18,
          $19, $20,
          $21, $22,
          $23, $24,
          $25,
          $26, $27, $28,
          $29, $30,
          $31, $32, $33,
          $34, $35,
          $36, $37,
          $38, $39,
          $40, $41, $42,
          $43,
          $44
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          status = EXCLUDED.status,
          rank_id = EXCLUDED.rank_id,
          current_rank_id = EXCLUDED.current_rank_id,
          updated_at = NOW()`,
        [
          row.id_customers,                                         // $1 legacy_id
          customerNumber,                                           // $2 customer_number (max 20)
          firstName,                                                // $3 first_name
          lastName,                                                 // $4 last_name
          cleanString(row.last_name_mot_customers),                 // $5 mothers_last_name
          cleanString(row.email_customers),                         // $6 email
          cleanTrunc(row.phone_customers, 30),                      // $7 phone (max 30)
          row.date_birthday_customers || null,                      // $8 date_of_birth
          cleanTrunc(row.curp_customers, 18),                       // $9 curp (max 18)
          cleanTrunc(row.rfc_customers, 13),                        // $10 rfc (max 13)
          cleanTrunc(row.ife_customers, 20),                        // $11 ine_number (max 20)
          cleanTrunc(row.number_secure_social_customers, 15),       // $12 nss (max 15)
          rankId,                                                   // $13 rank_id & current_rank_id
          status,                                                   // $14 status
          kitType,                                                  // $15 kit_type (max 20)
          branchId,                                                 // $16 branch_id
          priceTypeId,                                              // $17 price_type_id
          countryId,                                                // $18 country_id
          satTaxRegimeId,                                           // $19 sat_tax_regime_id
          commissionTaxRegimeId,                                    // $20 commission_tax_regime_id
          cleanTrunc(row.id_cfdi, 10),                              // $21 cfdi_use_code (max 10)
          languageCode,                                             // $22 language_code
          row.date_registration || null,                            // $23 registration_date
          row.last_date_purchase_customers || null,                 // $24 last_purchase_date
          toDecimal(row.average_purchase_month),                    // $25 average_monthly_purchase
          photoUrl,                                                  // $26 photo_url
          contractUrl,                                               // $27 contract_url
          ineUrl,                                                    // $28 ine_document_url
          bankStatementUrl,                                          // $29 bank_statement_url
          taxIdUrl,                                                  // $30 tax_id_document_url
          toBoolean(row.data_validated),                            // $31 documents_validated
          toBoolean(row.terms_accepted),                            // $32 terms_accepted
          row.terms_date || null,                                   // $33 terms_accepted_at
          toBoolean(row.save_online),                               // $34 is_online_registration
          toBoolean(row.pay_membership),                            // $35 membership_paid
          toBoolean(row.moved_roll_over),                           // $36 moved_roll_over
          toBoolean(row.discount_two_periods),                      // $37 discount_two_periods
          cleanTrunc(row.id_regimen_nomina, 10),                    // $38 payroll_tax_regime_code (max 10)
          cleanTrunc(row.id_cfdi_nomina, 10),                       // $39 payroll_cfdi_use_code (max 10)
          cleanTrunc(row.curp_nomina, 18),                          // $40 payroll_curp (max 18)
          cleanTrunc(row.rfc_nomina, 13),                           // $41 payroll_rfc (max 13)
          cleanTrunc(row.zip_code_nomina, 10),                      // $42 payroll_zip_code (max 10)
          cleanTrunc(row.payment_form_facturama, 10),               // $43 payment_form_code (max 10)
          status === 'active',                                      // $44 is_active
        ]
      );
    },
  }));

  // --- customers PASO 2: actualizar sponsor_id y upline_id ---
  // Lee las relaciones de v1 via Node.js y actualiza en v2 (sin dblink)
  logger.table('customers', 'Actualizando sponsor_id y upline_id (self-refs)');

  logger.info('    Actualizando sponsor_id en batches...');
  const sponsorData = await v1Pool.query(
    'SELECT id_customers, id_sponsor FROM toniclife.t_customers WHERE id_sponsor IS NOT NULL'
  );
  let sponsorUpdated = 0;
  const SPONSOR_BATCH = 5000;
  for (let i = 0; i < sponsorData.rows.length; i += SPONSOR_BATCH) {
    const batch = sponsorData.rows.slice(i, i + SPONSOR_BATCH);
    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');
      for (const row of batch) {
        const result = await v2Client.query(
          `UPDATE tonic.customers SET sponsor_id = (
            SELECT id FROM tonic.customers WHERE legacy_id = $1 LIMIT 1
          ) WHERE legacy_id = $2 AND sponsor_id IS NULL`,
          [row.id_sponsor, row.id_customers]
        );
        sponsorUpdated += result.rowCount;
      }
      await v2Client.query('COMMIT');
    } catch (err) {
      await v2Client.query('ROLLBACK');
      logger.error(`    Error actualizando sponsor_id batch: ${err.message}`);
    } finally {
      v2Client.release();
    }
    logger.progress('sponsor_id', Math.min(i + SPONSOR_BATCH, sponsorData.rows.length), sponsorData.rows.length);
  }
  logger.info(`    ✓ sponsor_id: ${sponsorUpdated} actualizados`);

  // Actualizar upline_id
  logger.info('    Actualizando upline_id en batches...');
  const uplineData = await v1Pool.query(
    'SELECT id_customers, id_upline FROM toniclife.t_customers WHERE id_upline IS NOT NULL'
  );
  let uplineUpdated = 0;
  for (let i = 0; i < uplineData.rows.length; i += SPONSOR_BATCH) {
    const batch = uplineData.rows.slice(i, i + SPONSOR_BATCH);
    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');
      for (const row of batch) {
        const result = await v2Client.query(
          `UPDATE tonic.customers SET upline_id = (
            SELECT id FROM tonic.customers WHERE legacy_id = $1 LIMIT 1
          ) WHERE legacy_id = $2 AND upline_id IS NULL`,
          [row.id_upline, row.id_customers]
        );
        uplineUpdated += result.rowCount;
      }
      await v2Client.query('COMMIT');
    } catch (err) {
      await v2Client.query('ROLLBACK');
      logger.error(`    Error actualizando upline_id batch: ${err.message}`);
    } finally {
      v2Client.release();
    }
    logger.progress('upline_id', Math.min(i + SPONSOR_BATCH, uplineData.rows.length), uplineData.rows.length);
  }
  logger.info(`    ✓ upline_id: ${uplineUpdated} actualizados`);

  // --- customer_addresses ---
  // v1 t_customers_address: id_customers_address(bigint PK), id_customers(bigint),
  //   zip_code_customers(varchar), department_customers(varchar),
  //   province_customers(varchar), address_customers(varchar)
  // v2 customer_addresses: customer_id, address_type(20), label(50), street(255),
  //   ext_number(20), int_number(20), neighborhood(100), city(100), state(100),
  //   zip_code(10), country_id(uuid FK), phone(20), reference, is_default, is_active
  logger.table('customer_addresses', 'Migrando t_customers_address → customer_addresses');
  const addrCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers_address');

  // Resolver country_id default (México)
  const defaultCountryId = await idResolver.resolve(v2Pool, 'country', 1);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_customers_address, id_customers, zip_code_customers,
                         department_customers, province_customers, address_customers
                  FROM toniclife.t_customers_address ORDER BY id_customers_address`,
    tableName: 'customer_addresses',
    totalCount: addrCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.customer_addresses (
          id, customer_id, address_type, label, street,
          city, state, zip_code, country_id,
          is_default, is_active
        ) VALUES (
          gen_random_uuid(), $1, 'shipping', 'Principal', $2,
          $3, $4, $5, $6,
          true, true
        )
        RETURNING id`,
        [
          customerId,
          cleanTrunc(row.address_customers, 255),                   // street
          cleanTrunc(row.department_customers, 100),                 // city
          cleanTrunc(row.province_customers, 100),                   // state
          cleanTrunc(row.zip_code_customers, 10),                    // zip_code
          defaultCountryId,                                          // country_id
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'customer_address', row.id_customers_address, rows[0].id, 't_customers_address');
      }
    },
  }));

  // --- customer_bank_accounts ---
  logger.table('customer_bank_accounts', 'Migrando t_customers_bank → customer_bank_accounts');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_customers_bank ORDER BY id_customers_bank',
    tableName: 'customer_bank_accounts',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.customer_bank_accounts (
          id, customer_id, bank_name, account_holder, clabe, account_number, is_default, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, true)
        RETURNING id`,
        [
          customerId,
          cleanString(row.bank_name) || cleanString(row.name_bank) || 'Sin banco',
          cleanString(row.account_holder_bank) || null,
          cleanString(row.clabe_bank) || null,
          cleanString(row.account_number_bank) || null,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'customer_bank_account', row.id_customers_bank, rows[0].id, 't_customers_bank');
      }
    },
  }));

  // --- cedea_contracts ---
  // v1 t_customers_cedea: id_customers_cedea(bigint PK), id_customers(bigint),
  //   id_branch_office(bigint), type_fee(varchar)
  // v2 cedea_contracts: customer_id(NOT NULL), branch_id(NOT NULL), legacy_id,
  //   contract_number(UNIQUE), status(CHECK), notes
  //   UNIQUE(customer_id, branch_id) — usar para idempotencia
  logger.table('cedea_contracts', 'Migrando t_customers_cedea → cedea_contracts');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_customers_cedea, id_customers, id_branch_office, type_fee
                  FROM toniclife.t_customers_cedea ORDER BY id_customers_cedea`,
    tableName: 'cedea_contracts',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office) || defaultBranchId;

      await client.query(
        `INSERT INTO tonic.cedea_contracts (
          id, customer_id, branch_id, contract_number, legacy_id,
          status, notes, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          'active', $5, true
        )
        ON CONFLICT ON CONSTRAINT uq_cedea_customer_branch DO NOTHING`,
        [
          customerId,
          branchId,
          `CEDEA-${row.id_customers_cedea}`,
          row.id_customers_cedea,
          cleanString(row.type_fee) ? `type_fee: ${row.type_fee}` : null,
        ]
      );
    },
  }));

  // --- customer_social_profiles ---
  // v1 type_social: TWITTER, FACEBOOK, LINKEDIN, INSTAGRAM (mayúsculas)
  // v2 platform CHECK: facebook, instagram, tiktok, youtube, whatsapp, twitter, linkedin, other
  const PLATFORM_MAP = {
    facebook: 'facebook', instagram: 'instagram', twitter: 'twitter',
    linkedin: 'linkedin', tiktok: 'tiktok', youtube: 'youtube', whatsapp: 'whatsapp',
  };
  logger.table('customer_social_profiles', 'Migrando t_customers_social → customer_social_profiles');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_customers_social, id_customers, type_social, url_social
                  FROM toniclife.t_customers_social ORDER BY id_customers_social`,
    tableName: 'customer_social_profiles',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const rawPlatform = (cleanString(row.type_social) || '').toLowerCase();
      const platform = PLATFORM_MAP[rawPlatform] || 'other';

      const { rows } = await client.query(
        `INSERT INTO tonic.customer_social_profiles (
          id, customer_id, platform, profile_url, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, true)
        RETURNING id`,
        [customerId, platform, cleanString(row.url_social) || '']
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'customer_social_profile', row.id_customers_social, rows[0].id, 't_customers_social');
      }
    },
  }));

  // --- customer_kit_cart ---
  // v1 t_customers_kit_cart: NO tiene PK. Columnas:
  //   id_customers(bigint), id_kit(bigint), id_branch_office(bigint),
  //   payment_id(varchar), external_reference(varchar), details(text),
  //   created_at(timestamptz), payment_status(enum), id_document(bigint)
  // v2 customer_kit_cart: customer_id(NOT NULL), product_id(NOT NULL),
  //   quantity(NOT NULL default 1), unit_price(NOT NULL), total_price(NOT NULL), status
  logger.table('customer_kit_cart', 'Migrando t_customers_kit_cart → customer_kit_cart');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_customers, id_kit, id_branch_office, payment_id,
                         external_reference, details, created_at, payment_status, id_document
                  FROM toniclife.t_customers_kit_cart
                  ORDER BY id_customers, created_at`,
    tableName: 'customer_kit_cart',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const productId = await idResolver.resolve(v2Pool, 'product', row.id_kit);
      if (!productId) return 'skipped';

      // Verificar si ya existe (idempotencia — tabla sin PK ni UNIQUE)
      const exists = await client.query(
        `SELECT 1 FROM tonic.customer_kit_cart
         WHERE customer_id = $1 AND product_id = $2 LIMIT 1`,
        [customerId, productId]
      );
      if (exists.rows.length > 0) return 'skipped';

      // v1 payment_status: PENDING, PAID (mayúsculas)
      // v2 status CHECK: pending, paid, cancelled
      const rawStatus = (cleanString(row.payment_status) || '').toLowerCase();
      const status = ['pending', 'paid', 'cancelled'].includes(rawStatus) ? rawStatus : 'pending';

      await client.query(
        `INSERT INTO tonic.customer_kit_cart (
          id, customer_id, product_id, quantity, unit_price, total_price, status, is_active, created_at
        ) VALUES (gen_random_uuid(), $1, $2, 1, 0, 0, $3, true, $4)`,
        [customerId, productId, status, row.created_at || null]
      );
    },
  }));

  // --- customer_subscriptions ---
  // v1 t_subscriptions: id_subscription(bigint PK), id_customers(bigint),
  //   subscription_status(bigint), created_at(timestamptz), last_payment(timestamptz),
  //   payload_to_process(text), subscription_type(enum), method_subscription_id(varchar),
  //   method_subscription_response(text), subscription_change_date(timestamptz)
  // v2 customer_subscriptions: customer_id(NOT NULL), subscription_type, status,
  //   started_at, notes, is_active
  logger.table('customer_subscriptions', 'Migrando t_subscriptions → customer_subscriptions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_subscription, id_customers, subscription_status, created_at,
                         last_payment, subscription_type, method_subscription_id,
                         subscription_change_date
                  FROM toniclife.t_subscriptions ORDER BY id_subscription`,
    tableName: 'customer_subscriptions',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      // Verificar idempotencia via legacy_id_map (v2 no tiene columna legacy_id)
      const existing = await idResolver.resolve(v2Pool, 'customer_subscription', row.id_subscription);
      if (existing) return 'skipped';

      // Mapear subscription_status: 1→active, 0→cancelled, otro→inactive
      let status = 'active';
      if (row.subscription_status === 0 || row.subscription_status === '0') status = 'cancelled';
      else if (row.subscription_status !== 1 && row.subscription_status !== '1') status = 'inactive';

      // v1 subscription_type es enum: PAYPAL, MERCADO_PAGO
      // v2 CHECK: monthly_autoship, quarterly, annual
      // Mapear todo a monthly_autoship (suscripciones recurrentes mensuales)
      const SUBSCRIPTION_TYPE_MAP = { paypal: 'monthly_autoship', mercado_pago: 'monthly_autoship' };
      const rawSubType = (cleanString(row.subscription_type) || '').toLowerCase();
      const subType = SUBSCRIPTION_TYPE_MAP[rawSubType] || 'monthly_autoship';
      const noteParts = [];
      if (row.subscription_type) noteParts.push(`v1_type: ${row.subscription_type}`);
      if (row.method_subscription_id) noteParts.push(`method_id: ${row.method_subscription_id}`);
      const notes = noteParts.length > 0 ? noteParts.join(', ') : null;

      const { rows } = await client.query(
        `INSERT INTO tonic.customer_subscriptions (
          id, customer_id, subscription_type, status, started_at, notes, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
        RETURNING id`,
        [
          customerId,
          subType,
          status,
          row.created_at || null,
          notes,
          status === 'active',
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'customer_subscription', row.id_subscription, rows[0].id, 't_subscriptions');
      }
    },
  }));

  // --- Actualizar users.customer_id (fase 03 los dejó en NULL porque customers no existían) ---
  logger.table('users', 'Actualizando users.customer_id con customers ya migrados');
  const userCustomerData = await v1Pool.query(
    'SELECT id_user, id_customers FROM toniclife.t_users WHERE id_customers IS NOT NULL'
  );
  logger.info(`    ${userCustomerData.rows.length.toLocaleString()} users con id_customers en v1`);
  let userCustomerUpdated = 0;
  const UC_BATCH = 5000;
  for (let i = 0; i < userCustomerData.rows.length; i += UC_BATCH) {
    const batch = userCustomerData.rows.slice(i, i + UC_BATCH);
    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');
      for (const row of batch) {
        const result = await v2Client.query(
          `UPDATE tonic.users SET customer_id = (
            SELECT id FROM tonic.customers WHERE legacy_id = $1 LIMIT 1
          ) WHERE legacy_id = $2 AND customer_id IS NULL`,
          [row.id_customers, row.id_user]
        );
        userCustomerUpdated += result.rowCount;
      }
      await v2Client.query('COMMIT');
    } catch (err) {
      await v2Client.query('ROLLBACK');
      logger.error(`    Error actualizando users.customer_id batch: ${err.message}`);
    } finally {
      v2Client.release();
    }
    logger.progress('users.customer_id', Math.min(i + UC_BATCH, userCustomerData.rows.length), userCustomerData.rows.length);
  }
  logger.info(`    ✓ users.customer_id: ${userCustomerUpdated.toLocaleString()} actualizados`);

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 05 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
