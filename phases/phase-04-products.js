const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, slugify, validateEnum, toDecimal, toBoolean, prefixUrl } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase04(v1Pool, v2Pool) {
  logger.phase('04', 'Productos');
  const allResults = [];

  // Pre-calentar caché
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches', column: 'id' },
    { type: 'tax_rule', table: 'tax_rules', column: 'id' },
  ]);

  // --- product_categories ---
  // v1 t_clasification: id_clasification, name_clasification, code_clasification, order_number_ecommerce_publico
  // v2 product_categories: code(UNIQUE), name, slug(UNIQUE), sort_order
  logger.table('product_categories', 'Migrando t_clasification → product_categories');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_clasification, name_clasification, code_clasification, order_number_ecommerce_publico
                  FROM toniclife.t_clasification ORDER BY id_clasification`,
    tableName: 'product_categories',
    transformAndInsert: async (row, client) => {
      const name = cleanString(row.name_clasification) || `CAT${row.id_clasification}`;
      const code = cleanString(row.code_clasification) || name.substring(0, 50).toLowerCase().replace(/\s+/g, '_');
      // Slug único: agregar id para evitar colisiones
      const slug = (slugify(name) || code) + `-${row.id_clasification}`;
      const { rows } = await client.query(
        `INSERT INTO tonic.product_categories (id, code, name, slug, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, name, slug, row.order_number_ecommerce_publico || 0]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product_category', row.id_clasification, rows[0].id, 't_clasification');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.product_categories WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'product_category', row.id_clasification, existing.rows[0].id, 't_clasification');
        }
      }
    },
  }));

  // --- product_units ---
  // v1 t_product_unit: id_product_unit, code_product_unit
  // v2 product_units: code(UNIQUE), name(NOT NULL), abbreviation(NOT NULL), unit_type(NOT NULL CHECK)
  logger.table('product_units', 'Migrando t_product_unit → product_units');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product_unit, code_product_unit FROM toniclife.t_product_unit ORDER BY id_product_unit`,
    tableName: 'product_units',
    transformAndInsert: async (row, client) => {
      const code = cleanString(row.code_product_unit) || `U${row.id_product_unit}`;
      const { rows } = await client.query(
        `INSERT INTO tonic.product_units (id, code, name, abbreviation, unit_type, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, 'unit', true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, code, code.substring(0, 10)]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product_unit', row.id_product_unit, rows[0].id, 't_product_unit');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.product_units WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'product_unit', row.id_product_unit, existing.rows[0].id, 't_product_unit');
        }
      }
    },
  }));

  // --- components ---
  // v1 t_component: id_component, key_component, name_component
  // v2 components: code(UNIQUE), name(NOT NULL), component_type(NOT NULL CHECK: ingredient|raw_material|packaging|label|other)
  logger.table('components', 'Migrando t_component → components');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_component, key_component, name_component FROM toniclife.t_component ORDER BY id_component`,
    tableName: 'components',
    transformAndInsert: async (row, client) => {
      const code = cleanString(row.key_component) || `COMP${row.id_component}`;
      const name = cleanString(row.name_component) || code;
      const { rows } = await client.query(
        `INSERT INTO tonic.components (id, code, name, component_type, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'ingredient', true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, name]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'component', row.id_component, rows[0].id, 't_component');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.components WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'component', row.id_component, existing.rows[0].id, 't_component');
        }
      }
    },
  }));

  // --- health_organs ---
  // v1 t_organ: id_organ, name_organ, enabled_organ
  // v2 health_organs: code(UNIQUE), name(NOT NULL)
  logger.table('health_organs', 'Migrando t_organ → health_organs');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_organ, name_organ, enabled_organ FROM toniclife.t_organ ORDER BY id_organ`,
    tableName: 'health_organs',
    transformAndInsert: async (row, client) => {
      const name = cleanString(row.name_organ) || `ORG${row.id_organ}`;
      const code = `ORG-${row.id_organ}`;
      const { rows } = await client.query(
        `INSERT INTO tonic.health_organs (id, code, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, COALESCE($3::boolean, true))
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, name, row.enabled_organ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'health_organ', row.id_organ, rows[0].id, 't_organ');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.health_organs WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'health_organ', row.id_organ, existing.rows[0].id, 't_organ');
        }
      }
    },
  }));

  // --- health_conditions ---
  // v1 t_diseases: id_disease(NOT id_diseases!), name_disease, description_disease, enabled_disease, date_created, date_updated
  // v2 health_conditions: code(UNIQUE), name(NOT NULL)
  logger.table('health_conditions', 'Migrando t_diseases → health_conditions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_disease, name_disease, description_disease, enabled_disease
                  FROM toniclife.t_diseases ORDER BY id_disease`,
    tableName: 'health_conditions',
    transformAndInsert: async (row, client) => {
      const name = cleanString(row.name_disease) || `DIS${row.id_disease}`;
      const code = `DIS-${row.id_disease}`;
      const { rows } = await client.query(
        `INSERT INTO tonic.health_conditions (id, code, name, description, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, COALESCE($4::boolean, true))
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, name, cleanString(row.description_disease), row.enabled_disease]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'health_condition', row.id_disease, rows[0].id, 't_diseases');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.health_conditions WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'health_condition', row.id_disease, existing.rows[0].id, 't_diseases');
        }
      }
    },
  }));

  // --- products (118K registros) ---
  // v1 t_product: id_product, key_product, name_product, description_product,
  //   id_clasification, pack_product, stock_min_product, stock_max_product, weight_product,
  //   price_product, avaible_store_product, description_store_product, iva_product,
  //   id_branch_office, exists_separated_qty_product, created_at, updated_at,
  //   is_kit, type_kit, bono_kit_pesos, bono_kit_usd, is_promo,
  //   enabled_product, code_sat, show_in_new_customers, id_product_unit,
  //   has_event, id_organ, benefits_product, dosis_product, observation_product,
  //   show_bot_product, bot_name_product, id_supplier
  // v2 products: code(UNIQUE), name, slug(UNIQUE), product_type(CHECK), kit_type(CHECK)
  logger.table('products', 'Migrando t_product → products');
  const productCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product');
  logger.info(`    Total registros en t_product: ${productCount.toLocaleString()}`);

  const slugSet = new Set();

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, key_product, name_product, description_product,
                         id_clasification, pack_product, stock_min_product, stock_max_product,
                         weight_product, price_product, avaible_store_product,
                         description_store_product, iva_product, id_branch_office,
                         is_kit, type_kit, is_promo, enabled_product, code_sat,
                         id_product_unit, id_organ, benefits_product, dosis_product,
                         observation_product
                  FROM toniclife.t_product ORDER BY id_product`,
    tableName: 'products',
    totalCount: productCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const code = cleanString(row.key_product) || `P${row.id_product}`;
      const name = cleanString(row.name_product) || code;

      // Generar slug único
      let baseSlug = slugify(name) || code.toLowerCase();
      let slug = baseSlug;
      let counter = 1;
      while (slugSet.has(slug)) {
        slug = `${baseSlug}-${counter++}`;
      }
      slugSet.add(slug);

      // Mapear product_type: finished_good|raw_material|kit|service|promotional|material
      let productType = 'finished_good';
      if (row.is_kit == 1 || row.pack_product === true) productType = 'kit';
      else if (row.is_promo == 1) productType = 'promotional';
      productType = validateEnum('products.product_type', productType, 'finished_good');

      // kit_type: fixed|dynamic|null
      let kitType = null;
      if (productType === 'kit') {
        const typeKitStr = (row.type_kit || '').toString().toLowerCase();
        if (typeKitStr === 'dynamic' || typeKitStr === 'dinamico') kitType = 'dynamic';
        else kitType = 'fixed';
      }

      const categoryId = await idResolver.resolve(v2Pool, 'product_category', row.id_clasification);
      const unitId = await idResolver.resolve(v2Pool, 'product_unit', row.id_product_unit);

      // long_description: combinar benefits + dosis + observation
      const longDescParts = [
        row.benefits_product ? `Beneficios: ${row.benefits_product}` : null,
        row.dosis_product ? `Dosis: ${row.dosis_product}` : null,
        row.observation_product ? `Observaciones: ${row.observation_product}` : null,
      ].filter(Boolean);
      const longDescription = longDescParts.length > 0 ? longDescParts.join('\n\n') : null;

      const { rows } = await client.query(
        `INSERT INTO tonic.products (
          id, code, name, description, long_description,
          category_id, unit_id, product_type, kit_type,
          sat_product_code,
          tracks_inventory, min_stock_alert, max_stock_level,
          weight_kg, slug,
          is_visible_ecommerce, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9,
          true, $10, $11,
          $12, $13,
          COALESCE($14::boolean, true), COALESCE($15::boolean, true)
        )
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          updated_at = NOW()
        RETURNING id`,
        [
          code,                                                    // $1
          name,                                                    // $2
          cleanString(row.description_product),                    // $3
          longDescription,                                         // $4
          categoryId,                                              // $5
          unitId,                                                  // $6
          productType,                                             // $7
          kitType,                                                 // $8
          cleanString(row.code_sat),                               // $9
          toDecimal(row.stock_min_product),                        // $10
          toDecimal(row.stock_max_product),                        // $11
          toDecimal(row.weight_product),                           // $12
          slug,                                                    // $13
          row.avaible_store_product == 1,                          // $14
          row.enabled_product,                                     // $15
        ]
      );

      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product', row.id_product, rows[0].id, 't_product');
      }
    },
  }));

  // --- product_prices (324K registros) ---
  // v1 t_product_price: id_product, id_type_price, price, point, value_business
  //   NO tiene PK propia — tabla compuesta
  // v2 product_prices: UNIQUE(product_id, price_type_id, currency_code), effective_from(NOT NULL)
  logger.table('product_prices', 'Migrando t_product_price → product_prices');
  const priceCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_price');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_type_price, price, point, value_business
                  FROM toniclife.t_product_price ORDER BY id_product, id_type_price`,
    tableName: 'product_prices',
    totalCount: priceCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      const priceTypeId = await idResolver.resolve(v2Pool, 'price_type', row.id_type_price);
      if (!productId || !priceTypeId) return 'skipped';

      // Default currency MXN (se puede mejorar si la sucursal del producto tiene otra moneda)
      const currencyCode = 'MXN';

      await client.query(
        `INSERT INTO tonic.product_prices (
          id, product_id, price_type_id, currency_code, price, effective_from, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, '2000-01-01', true)
        ON CONFLICT ON CONSTRAINT uq_product_prices DO UPDATE SET
          price = EXCLUDED.price,
          updated_at = NOW()`,
        [productId, priceTypeId, currencyCode, toDecimal(row.price, 0)]
      );
    },
  }));

  // --- product_images ---
  // v1 t_product_photo: id_photo, id_product, name_photo, alt_photo, file_photo
  // v2 product_images: product_id, image_url(NOT NULL), alt_text, sort_order
  logger.table('product_images', 'Migrando t_product_photo → product_images');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_photo, id_product, name_photo, alt_photo, file_photo
                  FROM toniclife.t_product_photo ORDER BY id_photo`,
    tableName: 'product_images',
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      const imageUrl = prefixUrl(row.file_photo);
      if (!imageUrl) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.product_images (id, product_id, image_url, alt_text, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, 0, true)
         RETURNING id`,
        [productId, imageUrl, cleanString(row.alt_photo) || cleanString(row.name_photo)]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product_image', row.id_photo, rows[0].id, 't_product_photo');
      }
    },
  }));

  // --- product_lots (138K registros) ---
  // v1 t_product_lot: id_product_lot, id_product, lot, exists_current_qty_product, date_expiration
  //   NO tiene id_branch_office — necesita resolver la sucursal del producto
  // v2 product_lots: UNIQUE(product_id, branch_id, lot_number), branch_id(NOT NULL), lot_number(NOT NULL),
  //   expiration_date(NOT NULL), quantity(NOT NULL), initial_quantity(NOT NULL),
  //   status(CHECK: available|quarantine|expired|consumed|returned)
  logger.table('product_lots', 'Migrando t_product_lot → product_lots');
  const lotCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_lot');

  // Necesitamos un branch_id default ya que t_product_lot no tiene id_branch_office
  const defaultBranchId = await idResolver.resolve(v2Pool, 'branch', 1);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product_lot, id_product, lot, exists_current_qty_product, date_expiration
                  FROM toniclife.t_product_lot ORDER BY id_product_lot`,
    tableName: 'product_lots',
    totalCount: lotCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      const lotNumber = cleanString(row.lot) || `LOT-${row.id_product_lot}`;
      const qty = toDecimal(row.exists_current_qty_product, 0);
      const expDate = row.date_expiration || '2099-12-31';

      // Determinar status basado en fecha de expiración
      let status = 'available';
      if (row.date_expiration && new Date(row.date_expiration) < new Date()) {
        status = 'expired';
      }

      await client.query(
        `INSERT INTO tonic.product_lots (
          id, product_id, branch_id, lot_number, expiration_date,
          quantity, initial_quantity, status, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, true
        )
        ON CONFLICT ON CONSTRAINT uq_product_lots DO UPDATE SET
          quantity = EXCLUDED.quantity,
          status = EXCLUDED.status,
          updated_at = NOW()`,
        [productId, defaultBranchId, lotNumber, expDate, qty, qty, status]
      );
    },
  }));

  // --- product_components ---
  // v1 t_product_component: id_product, id_component, qty, enabled_component
  //   NO tiene PK propia — tabla compuesta
  // v2 product_components: product_id, component_id, quantity(NOT NULL)
  logger.table('product_components', 'Migrando t_product_component → product_components');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_component, qty, enabled_component
                  FROM toniclife.t_product_component ORDER BY id_product, id_component`,
    tableName: 'product_components',
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      const componentId = await idResolver.resolve(v2Pool, 'component', row.id_component);
      if (!productId || !componentId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.product_components (id, product_id, component_id, quantity, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, COALESCE($4::boolean, true))
         ON CONFLICT DO NOTHING`,
        [productId, componentId, toDecimal(row.qty, 1), row.enabled_component != null ? row.enabled_component == 1 : true]
      );
    },
  }));

  // --- product_taxes ---
  // v1 t_product_tax: id_product, id_tax, order_tax(boolean)
  //   NO tiene PK propia — tabla compuesta
  // v2 product_taxes: UNIQUE(product_id, tax_rule_id)
  logger.table('product_taxes', 'Migrando t_product_tax → product_taxes');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_tax, order_tax
                  FROM toniclife.t_product_tax ORDER BY id_product, id_tax`,
    tableName: 'product_taxes',
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      const taxRuleId = await idResolver.resolve(v2Pool, 'tax_rule', row.id_tax);
      if (!productId || !taxRuleId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.product_taxes (id, product_id, tax_rule_id, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT ON CONSTRAINT uq_product_taxes DO NOTHING`,
        [productId, taxRuleId, row.order_tax ? 1 : 0]
      );
    },
  }));

  // --- product_exemptions ---
  // v1 t_product_exempt: id_product, id_exempt, order_exempt(boolean)
  //   NO tiene PK propia — tabla compuesta
  // v2 product_exemptions: product_id, exemption_type(CHECK: iva|ieps|all)
  logger.table('product_exemptions', 'Migrando t_product_exempt → product_exemptions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_exempt, order_exempt
                  FROM toniclife.t_product_exempt ORDER BY id_product, id_exempt`,
    tableName: 'product_exemptions',
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      // id_exempt maps to exemption type: default to 'iva'
      const exemptMap = { 1: 'iva', 2: 'ieps', 3: 'all' };
      const exemptionType = exemptMap[row.id_exempt] || 'iva';

      await client.query(
        `INSERT INTO tonic.product_exemptions (id, product_id, exemption_type, is_active)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT DO NOTHING`,
        [productId, exemptionType]
      );
    },
  }));

  // --- stock_levels (306K registros) ---
  // v1 t_product_stock_snapshot: id_product_stock_snapshot, id_product(numeric),
  //   key_product, description_product, exists_current_qty_product(numeric), executed_at
  //   NO tiene id_branch_office
  // v2 stock_levels: UNIQUE(product_id, branch_id), quantity_on_hand(NOT NULL)
  logger.table('stock_levels', 'Migrando t_product_stock_snapshot → stock_levels');
  const stockCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_stock_snapshot');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product_stock_snapshot, id_product, exists_current_qty_product, executed_at
                  FROM toniclife.t_product_stock_snapshot ORDER BY id_product_stock_snapshot`,
    tableName: 'stock_levels',
    totalCount: stockCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // id_product is numeric in this table, cast to int for lookup
      const productLegacyId = row.id_product ? Math.round(Number(row.id_product)) : null;
      if (!productLegacyId) return 'skipped';

      const productId = await idResolver.resolve(v2Pool, 'product', productLegacyId);
      if (!productId) return 'skipped';

      const qty = toDecimal(row.exists_current_qty_product, 0);

      await client.query(
        `INSERT INTO tonic.stock_levels (
          id, product_id, branch_id, quantity_on_hand,
          last_count_date, last_count_quantity, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, true
        )
        ON CONFLICT ON CONSTRAINT uq_stock_levels DO UPDATE SET
          quantity_on_hand = EXCLUDED.quantity_on_hand,
          last_count_date = EXCLUDED.last_count_date,
          last_count_quantity = EXCLUDED.last_count_quantity,
          updated_at = NOW()`,
        [
          productId,
          defaultBranchId,
          qty,
          row.executed_at ? new Date(row.executed_at).toISOString().split('T')[0] : null,
          qty,
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

  logger.info(`\n  Fase 04 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
