const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, processWithCursorBulk, buildMultiRowInsertWithUUID, getCount } = require('../utils/batch-processor');
const { cleanString, slugify, validateEnum, toDecimal, toBoolean, prefixUrl } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase04(v1Pool, v2Pool) {
  logger.phase('04', 'Productos');
  const allResults = [];

  // Pre-calentar caché — FIX: removed column: 'id'
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches' },
    { type: 'tax_rule', table: 'tax_rules' },
  ]);

  // --- product_categories ---
  logger.table('product_categories', 'Migrando t_clasification → product_categories');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_clasification, name_clasification, code_clasification, order_number_ecommerce_publico
                  FROM toniclife.t_clasification ORDER BY id_clasification`,
    tableName: 'product_categories',
    transformAndInsert: async (row, client) => {
      const name = cleanString(row.name_clasification) || `CAT${row.id_clasification}`;
      const code = cleanString(row.code_clasification) || name.substring(0, 50).toLowerCase().replace(/\s+/g, '_');
      const slug = (slugify(name) || code) + `-${row.id_clasification}`;
      const { rows } = await client.query(
        `INSERT INTO tonic.product_categories (id, code, name, slug, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           sort_order = EXCLUDED.sort_order,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [code, name, slug, row.order_number_ecommerce_publico || 0]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product_category', row.id_clasification, rows[0].id, 't_clasification');
      }
    },
  }));

  // --- product_units ---
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
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           abbreviation = EXCLUDED.abbreviation,
           unit_type = EXCLUDED.unit_type,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [code, code, code.substring(0, 10)]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product_unit', row.id_product_unit, rows[0].id, 't_product_unit');
      }
    },
  }));

  // --- components ---
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
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           component_type = EXCLUDED.component_type,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [code, name]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'component', row.id_component, rows[0].id, 't_component');
      }
    },
  }));

  // --- health_organs ---
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
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [code, name, row.enabled_organ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'health_organ', row.id_organ, rows[0].id, 't_organ');
      }
    },
  }));

  // --- health_conditions ---
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
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           is_active = EXCLUDED.is_active,
           updated_at = NOW()
         RETURNING id`,
        [code, name, cleanString(row.description_disease), row.enabled_disease]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'health_condition', row.id_disease, rows[0].id, 't_diseases');
      }
    },
  }));

  // --- products (118K registros — row-by-row due to stateful slug) ---
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

      let baseSlug = slugify(name) || code.toLowerCase();
      let slug = baseSlug;
      let counter = 1;
      while (slugSet.has(slug)) {
        slug = `${baseSlug}-${counter++}`;
      }
      slugSet.add(slug);

      let productType = 'finished_good';
      if (row.is_kit == 1 || row.pack_product === true) productType = 'kit';
      else if (row.is_promo == 1) productType = 'promotional';
      productType = validateEnum('products.product_type', productType, 'finished_good');

      let kitType = null;
      if (productType === 'kit') {
        const typeKitStr = (row.type_kit || '').toString().toLowerCase();
        if (typeKitStr === 'dynamic' || typeKitStr === 'dinamico') kitType = 'dynamic';
        else kitType = 'fixed';
      }

      const categoryId = await idResolver.resolve(v2Pool, 'product_category', row.id_clasification);
      const unitId = await idResolver.resolve(v2Pool, 'product_unit', row.id_product_unit);

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
          description = EXCLUDED.description,
          long_description = EXCLUDED.long_description,
          category_id = EXCLUDED.category_id,
          unit_id = EXCLUDED.unit_id,
          product_type = EXCLUDED.product_type,
          kit_type = EXCLUDED.kit_type,
          sat_product_code = EXCLUDED.sat_product_code,
          min_stock_alert = EXCLUDED.min_stock_alert,
          max_stock_level = EXCLUDED.max_stock_level,
          weight_kg = EXCLUDED.weight_kg,
          slug = EXCLUDED.slug,
          is_visible_ecommerce = EXCLUDED.is_visible_ecommerce,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
        RETURNING id`,
        [
          code, name,
          cleanString(row.description_product), longDescription,
          categoryId, unitId,
          productType, kitType,
          cleanString(row.code_sat),
          toDecimal(row.stock_min_product), toDecimal(row.stock_max_product),
          toDecimal(row.weight_product), slug,
          row.avaible_store_product == 1,
          row.enabled_product,
        ]
      );

      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'product', row.id_product, rows[0].id, 't_product');
      }
    },
  }));

  // --- product_prices (324K registros) — BULK ---
  logger.table('product_prices', 'Migrando t_product_price → product_prices (bulk)');
  const priceCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_price');

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_type_price, price, point, value_business
                  FROM toniclife.t_product_price ORDER BY id_product, id_type_price`,
    tableName: 'product_prices',
    totalCount: priceCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const productIds = [...new Set(rows.map(r => r.id_product).filter(Boolean))];
      const priceTypeIds = [...new Set(rows.map(r => r.id_type_price).filter(Boolean))];
      const [productMap, priceTypeMap] = await Promise.all([
        idResolver.resolveMany(v2Pool, 'product', productIds),
        idResolver.resolveMany(v2Pool, 'price_type', priceTypeIds),
      ]);
      return { productMap, priceTypeMap };
    },

    transformRow: (row, { productMap, priceTypeMap }) => {
      const productId = productMap.get(String(row.id_product));
      const priceTypeId = priceTypeMap.get(String(row.id_type_price));
      if (!productId || !priceTypeId) return null;

      return {
        product_id: productId,
        price_type_id: priceTypeId,
        currency_code: 'MXN',
        price: toDecimal(row.price, 0),
        effective_from: '2000-01-01',
        is_active: true,
      };
    },

    buildInsertSQL: (transformedRows) => {
      return buildMultiRowInsertWithUUID(
        'tonic.product_prices',
        ['product_id', 'price_type_id', 'currency_code', 'price', 'effective_from', 'is_active'],
        transformedRows,
        `ON CONFLICT ON CONSTRAINT uq_product_prices DO UPDATE SET
          price = EXCLUDED.price,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // --- product_images (GCS uploads → row-by-row) ---
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

  // --- product_lots (138K registros) — BULK ---
  logger.table('product_lots', 'Migrando t_product_lot → product_lots (bulk)');
  const lotCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_lot');

  const defaultBranchId = await idResolver.resolve(v2Pool, 'branch', 1);

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product_lot, id_product, lot, exists_current_qty_product, date_expiration
                  FROM toniclife.t_product_lot ORDER BY id_product_lot`,
    tableName: 'product_lots',
    totalCount: lotCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const productIds = [...new Set(rows.map(r => r.id_product).filter(Boolean))];
      const productMap = await idResolver.resolveMany(v2Pool, 'product', productIds);
      return { productMap };
    },

    transformRow: (row, { productMap }) => {
      const productId = productMap.get(String(row.id_product));
      if (!productId) return null;

      const lotNumber = cleanString(row.lot) || `LOT-${row.id_product_lot}`;
      const qty = toDecimal(row.exists_current_qty_product, 0);
      const expDate = row.date_expiration || '2099-12-31';
      let status = 'available';
      if (row.date_expiration && new Date(row.date_expiration) < new Date()) {
        status = 'expired';
      }

      return {
        product_id: productId,
        branch_id: defaultBranchId,
        lot_number: lotNumber,
        expiration_date: expDate,
        quantity: qty,
        initial_quantity: qty,
        status,
        is_active: true,
      };
    },

    buildInsertSQL: (transformedRows) => {
      return buildMultiRowInsertWithUUID(
        'tonic.product_lots',
        ['product_id', 'branch_id', 'lot_number', 'expiration_date', 'quantity', 'initial_quantity', 'status', 'is_active'],
        transformedRows,
        `ON CONFLICT ON CONSTRAINT uq_product_lots DO UPDATE SET
          quantity = EXCLUDED.quantity,
          initial_quantity = EXCLUDED.initial_quantity,
          status = EXCLUDED.status,
          expiration_date = EXCLUDED.expiration_date,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // --- product_components ---
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
  logger.table('product_exemptions', 'Migrando t_product_exempt → product_exemptions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product, id_exempt, order_exempt
                  FROM toniclife.t_product_exempt ORDER BY id_product, id_exempt`,
    tableName: 'product_exemptions',
    transformAndInsert: async (row, client) => {
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

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

  // --- stock_levels (306K registros) — BULK ---
  logger.table('stock_levels', 'Migrando t_product_stock_snapshot → stock_levels (bulk)');
  const stockCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_product_stock_snapshot');

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_product_stock_snapshot, id_product, exists_current_qty_product, executed_at
                  FROM toniclife.t_product_stock_snapshot ORDER BY id_product_stock_snapshot`,
    tableName: 'stock_levels',
    totalCount: stockCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const productIds = [...new Set(
        rows.map(r => r.id_product ? Math.round(Number(r.id_product)) : null).filter(Boolean)
      )];
      const productMap = await idResolver.resolveMany(v2Pool, 'product', productIds);
      return { productMap };
    },

    transformRow: (row, { productMap }) => {
      const productLegacyId = row.id_product ? Math.round(Number(row.id_product)) : null;
      if (!productLegacyId) return null;
      const productId = productMap.get(String(productLegacyId));
      if (!productId) return null;

      const qty = toDecimal(row.exists_current_qty_product, 0);

      return {
        product_id: productId,
        branch_id: defaultBranchId,
        quantity_on_hand: qty,
        last_count_date: row.executed_at ? new Date(row.executed_at).toISOString().split('T')[0] : null,
        last_count_quantity: qty,
        is_active: true,
      };
    },

    buildInsertSQL: (transformedRows) => {
      return buildMultiRowInsertWithUUID(
        'tonic.stock_levels',
        ['product_id', 'branch_id', 'quantity_on_hand', 'last_count_date', 'last_count_quantity', 'is_active'],
        transformedRows,
        `ON CONFLICT ON CONSTRAINT uq_stock_levels DO UPDATE SET
          quantity_on_hand = EXCLUDED.quantity_on_hand,
          last_count_date = EXCLUDED.last_count_date,
          last_count_quantity = EXCLUDED.last_count_quantity,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
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
