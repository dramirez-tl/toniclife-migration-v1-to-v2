const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursorBulk, buildMultiRowInsertWithUUID, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, toBoolean } = require('../utils/validators');
const { mapValue, ORDER_STATUS_FROM_ANULADO, ORDER_SOURCE } = require('../mappings/value-maps');
const config = require('../config');

module.exports = async function phase07(v1Pool, v2Pool) {
  logger.phase('07', 'Ventas y Documentos');
  const allResults = [];

  // Pre-calentar caché con TODAS las entidades que la fase necesita
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches' },
    { type: 'payment_method', table: 'payment_methods' },
    { type: 'product', table: 'products' },
    { type: 'customer', table: 'customers' },
    { type: 'commission_period', table: 'commission_periods' },
    { type: 'document_type', table: 'document_types' },
    { type: 'dispatch_type', table: 'dispatch_types' },
  ]);

  // ==============================================================
  // promotions
  // ==============================================================
  logger.table('promotions', 'Migrando t_promo → promotions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_promo, name_promo, flag_point_promo,
             percentage_discount_promo, flag_percentage_discount_promo,
             date_start_promo, date_end_promo, enabled_promo, date_created
      FROM toniclife.t_promo ORDER BY id_promo
    `,
    tableName: 'promotions',
    transformAndInsert: async (row, client) => {
      const promoType = row.flag_percentage_discount_promo
        ? 'percentage_discount' : 'free_product';
      const startDate = row.date_start_promo || '2000-01-01';
      const endDate = row.date_end_promo || '2099-12-31';

      await client.query(
        `INSERT INTO tonic.promotions (
          id, name, promotion_type, discount_percentage,
          includes_points, start_date, end_date,
          legacy_id, is_active, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6,
          $7, $8, $9
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          name = EXCLUDED.name,
          promotion_type = EXCLUDED.promotion_type,
          discount_percentage = EXCLUDED.discount_percentage,
          includes_points = EXCLUDED.includes_points,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          cleanTrunc(row.name_promo, 100) || `PROMO${row.id_promo}`,
          promoType,
          toDecimal(row.percentage_discount_promo, 0),
          toBoolean(row.flag_point_promo),
          startDate,
          endDate,
          row.id_promo,
          toBoolean(row.enabled_promo),
          row.date_created || new Date(),
        ]
      );
    },
  }));

  // ==============================================================
  // promotion_items
  // ==============================================================
  logger.table('promotion_items', 'Migrando t_promo_det → promotion_items');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_promo, id_product, qty_min, qty_free
      FROM toniclife.t_promo_det ORDER BY id_promo, id_product
    `,
    tableName: 'promotion_items',
    transformAndInsert: async (row, client) => {
      const promoResult = await client.query(
        'SELECT id FROM tonic.promotions WHERE legacy_id = $1 LIMIT 1',
        [row.id_promo]
      );
      if (promoResult.rows.length === 0) return 'skipped';
      const promotionId = promoResult.rows[0].id;
      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.promotion_items (
          id, promotion_id, product_id, min_quantity, free_quantity, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, true)
        ON CONFLICT DO NOTHING`,
        [promotionId, productId, toDecimal(row.qty_min, 1), toDecimal(row.qty_free, 0)]
      );
    },
  }));

  // ==============================================================
  // shopping_carts
  // ==============================================================
  logger.table('shopping_carts', 'Migrando t_cart → shopping_carts');

  const CART_TYPE_MAP = {
    'regular': 'regular', 'REGULAR': 'regular',
    'public': 'public', 'PUBLIC': 'public',
    'publico': 'public', 'PUBLICO': 'public',
    'kit': 'customer_kit', 'KIT': 'customer_kit',
    'customer_kit': 'customer_kit',
  };

  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers, id_customers_sale, id_customers_sale_public,
             id_branch_office, total, iva, has_shipping, is_usa, type_cart,
             discount_type, discount_doc, discount_amount, has_subscription,
             payment_request, rfc_customers, zip_code_customers, id_regimen, id_cfdi,
             zip_code_cart, address_cart, province_cart, department_cart,
             full_name_cart, phone_cart, email_cart, created_at
      FROM toniclife.t_cart ORDER BY id_customers
    `,
    tableName: 'shopping_carts',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const saleCustomerId = row.id_customers_sale
        ? await idResolver.resolve(v2Pool, 'customer', row.id_customers_sale, 'customers')
        : null;
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office);

      const exists = await client.query(
        `SELECT 1 FROM tonic.shopping_carts WHERE customer_id = $1
         AND sale_customer_id IS NOT DISTINCT FROM $2 LIMIT 1`,
        [customerId, saleCustomerId]
      );
      if (exists.rows.length > 0) return 'skipped';

      const cartTypeRaw = row.type_cart ? String(row.type_cart).toLowerCase().trim() : null;
      const cartType = CART_TYPE_MAP[cartTypeRaw] || CART_TYPE_MAP[row.type_cart] || 'regular';

      const { rows } = await client.query(
        `INSERT INTO tonic.shopping_carts (
          id, customer_id, sale_customer_id, cart_type, branch_id,
          subtotal, tax_amount, discount_type, discount_amount,
          requires_shipping, is_usa, has_subscription,
          shipping_name, shipping_zip_code, shipping_state, shipping_city,
          shipping_phone,
          billing_rfc, billing_zip_code,
          payment_request, status, is_active, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          $16,
          $17, $18,
          $19, 'active', true, $20
        )
        RETURNING id`,
        [
          customerId, saleCustomerId, cartType, branchId,
          toDecimal(row.total, 0), toDecimal(row.iva, 0),
          row.discount_type != null ? Number(row.discount_type) : null,
          toDecimal(row.discount_amount, 0),
          toBoolean(row.has_shipping), toBoolean(row.is_usa), toBoolean(row.has_subscription),
          cleanTrunc(row.full_name_cart, 200), cleanTrunc(row.zip_code_cart, 10),
          cleanTrunc(row.province_cart, 100), cleanTrunc(row.department_cart, 100),
          cleanTrunc(row.phone_cart, 30),
          cleanTrunc(row.rfc_customers, 13), cleanTrunc(row.zip_code_customers, 10),
          row.payment_request ? String(row.payment_request).substring(0, 5000) : null,
          row.created_at || new Date(),
        ]
      );

      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'shopping_cart', row.id_customers, rows[0].id, 't_cart');
      }
    },
  }));

  // ==============================================================
  // shopping_cart_items
  // ==============================================================
  logger.table('shopping_cart_items', 'Migrando t_cart_det → shopping_cart_items');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers, id_customers_sale_public, id_product,
             qty, price, lot, point, value_business, price_original
      FROM toniclife.t_cart_det ORDER BY id_customers, id_product
    `,
    tableName: 'shopping_cart_items',
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!customerId) return 'skipped';

      const cartResult = await client.query(
        'SELECT id FROM tonic.shopping_carts WHERE customer_id = $1 LIMIT 1',
        [customerId]
      );
      if (cartResult.rows.length === 0) return 'skipped';
      const cartId = cartResult.rows[0].id;

      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      const exists = await client.query(
        'SELECT 1 FROM tonic.shopping_cart_items WHERE cart_id = $1 AND product_id = $2 LIMIT 1',
        [cartId, productId]
      );
      if (exists.rows.length > 0) return 'skipped';

      await client.query(
        `INSERT INTO tonic.shopping_cart_items (
          id, cart_id, product_id, quantity, unit_price,
          original_price, points, business_value, lot_number, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8, true
        )`,
        [
          cartId, productId,
          toDecimal(row.qty, 1), toDecimal(row.price, 0),
          toDecimal(row.price_original), toDecimal(row.point),
          toDecimal(row.value_business), cleanTrunc(row.lot, 50),
        ]
      );
    },
  }));

  // ==============================================================
  // orders (1.7M registros) — BULK
  // ==============================================================
  logger.table('orders', 'Migrando t_document → orders (BULK)');
  const orderCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_document');
  logger.info(`    Total registros en t_document: ${orderCount.toLocaleString()}`);

  const defaultBranchId = await idResolver.resolve(v2Pool, 'branch', 1);

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_document, number_invoice_doc, id_period, id_type_document,
             observation_doc, id_branch_office_origin, date_doc,
             total_doc, subtotal_doc, iva_doc, discount_amount, discount_doc,
             shipping_value, id_customers, source_doc, has_invoice_doc,
             payment_request, payment_response,
             id_type_format_pay, id_type_format_pay_2,
             amount_format_pay, amount_format_pay_2,
             pick_up_branch_office, id_dispatch, anulado,
             observation_confirm, observation_anulado, date_anulado,
             sponsor_received, id_sponsor,
             ecommerce_publico, earnings_customers, commission_ecommerce,
             zip_code_customers, department_customers, province_customers,
             address_customers, phone_cart, email_cart, full_name_cart,
             created_at, updated_at
      FROM toniclife.t_document ORDER BY id_document
    `,
    tableName: 'orders',
    totalCount: orderCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const customerIds = [...new Set(rows.map(r => r.id_customers).filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      const branchIds = [...new Set([
        ...rows.map(r => r.id_branch_office_origin),
        ...rows.map(r => r.pick_up_branch_office),
      ].filter(Boolean))];
      const branchMap = await idResolver.resolveMany(v2Pool, 'branch', branchIds, 'branches');

      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      const docTypeIds = [...new Set(rows.map(r => r.id_type_document).filter(Boolean))];
      const docTypeMap = await idResolver.resolveMany(v2Pool, 'document_type', docTypeIds, 'document_types');

      const payMethodIds = [...new Set([
        ...rows.map(r => r.id_type_format_pay),
        ...rows.map(r => r.id_type_format_pay_2),
      ].filter(Boolean))];
      const payMethodMap = await idResolver.resolveMany(v2Pool, 'payment_method', payMethodIds, 'payment_methods');

      const dispatchIds = [...new Set(rows.map(r => r.id_dispatch).filter(Boolean))];
      const dispatchMap = await idResolver.resolveMany(v2Pool, 'dispatch_type', dispatchIds, 'dispatch_types');

      const sponsorIds = [...new Set(rows.map(r => r.id_sponsor).filter(Boolean))];
      const sponsorMap = await idResolver.resolveMany(v2Pool, 'customer', sponsorIds, 'customers');

      return { customerMap, branchMap, periodMap, docTypeMap, payMethodMap, dispatchMap, sponsorMap };
    },

    transformRow: (row, resolved) => {
      const branchId = resolved.branchMap.get(String(row.id_branch_office_origin)) || defaultBranchId;
      if (!branchId) return null;

      const status = mapValue(ORDER_STATUS_FROM_ANULADO, row.anulado);
      const source = mapValue(ORDER_SOURCE, row.source_doc);

      let shippingSnapshot = null;
      if (row.address_customers || row.province_customers || row.zip_code_customers) {
        shippingSnapshot = JSON.stringify({
          address: cleanString(row.address_customers) || null,
          state: cleanString(row.province_customers) || null,
          city: cleanString(row.department_customers) || null,
          zip_code: cleanString(row.zip_code_customers) || null,
          full_name: cleanString(row.full_name_cart) || null,
          phone: cleanString(row.phone_cart) || null,
          email: cleanString(row.email_cart) || null,
        });
      }

      return {
        legacy_id: row.id_document,
        order_number: `M-${row.id_document}`.substring(0, 20),
        document_type_id: resolved.docTypeMap.get(String(row.id_type_document)) || null,
        source,
        period_id: resolved.periodMap.get(String(row.id_period)) || null,
        customer_id: resolved.customerMap.get(String(row.id_customers)) || null,
        branch_id: branchId,
        subtotal: toDecimal(row.subtotal_doc, 0),
        discount_percentage: toDecimal(row.discount_doc, 0),
        discount_amount: toDecimal(row.discount_amount, 0),
        tax_amount: toDecimal(row.iva_doc, 0),
        shipping_amount: toDecimal(row.shipping_value, 0),
        total: toDecimal(row.total_doc, 0),
        payment_method_id: resolved.payMethodMap.get(String(row.id_type_format_pay)) || null,
        payment_method_2_id: resolved.payMethodMap.get(String(row.id_type_format_pay_2)) || null,
        payment_amount_1: toDecimal(row.amount_format_pay),
        payment_amount_2: toDecimal(row.amount_format_pay_2),
        payment_reference: cleanTrunc(row.number_invoice_doc, 100),
        payment_gateway_request: row.payment_request ? String(row.payment_request).substring(0, 5000) : null,
        payment_gateway_response: row.payment_response ? String(row.payment_response).substring(0, 5000) : null,
        status,
        observation: cleanString(row.observation_doc),
        confirmation_notes: cleanString(row.observation_confirm),
        cancellation_reason: cleanString(row.observation_anulado),
        cancelled_at: row.date_anulado || null,
        order_date: row.date_doc || new Date().toISOString().split('T')[0],
        is_invoiced: toBoolean(row.has_invoice_doc),
        dispatch_type_id: resolved.dispatchMap.get(String(row.id_dispatch)) || null,
        pickup_branch_id: resolved.branchMap.get(String(row.pick_up_branch_office)) || null,
        shipping_address_snapshot: shippingSnapshot,
        is_ecommerce: source === 'ecommerce' || source === 'ecommerce_pending',
        is_public_sale: toBoolean(row.ecommerce_publico),
        ecommerce_commission: toDecimal(row.commission_ecommerce),
        customer_earnings: toDecimal(row.earnings_customers),
        sponsor_customer_id: resolved.sponsorMap.get(String(row.id_sponsor)) || null,
        sponsor_received: toBoolean(row.sponsor_received),
        is_active: status !== 'cancelled',
        created_at: row.created_at || new Date(),
        updated_at: row.updated_at || row.created_at || new Date(),
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'legacy_id', 'order_number', 'document_type_id', 'source',
        'period_id', 'customer_id', 'branch_id',
        'subtotal', 'discount_percentage', 'discount_amount',
        'tax_amount', 'shipping_amount', 'total',
        'payment_method_id', 'payment_method_2_id',
        'payment_amount_1', 'payment_amount_2', 'payment_reference',
        'payment_gateway_request', 'payment_gateway_response',
        'status', 'observation', 'confirmation_notes',
        'cancellation_reason', 'cancelled_at',
        'order_date', 'is_invoiced',
        'dispatch_type_id', 'pickup_branch_id',
        'shipping_address_snapshot',
        'is_ecommerce', 'is_public_sale',
        'ecommerce_commission', 'customer_earnings',
        'sponsor_customer_id', 'sponsor_received',
        'is_active', 'created_at', 'updated_at',
      ];
      return buildMultiRowInsertWithUUID('tonic.orders', columns, rows,
        `ON CONFLICT (legacy_id) DO UPDATE SET
          order_number = EXCLUDED.order_number,
          document_type_id = EXCLUDED.document_type_id,
          source = EXCLUDED.source,
          period_id = EXCLUDED.period_id,
          customer_id = EXCLUDED.customer_id,
          branch_id = EXCLUDED.branch_id,
          subtotal = EXCLUDED.subtotal,
          discount_percentage = EXCLUDED.discount_percentage,
          discount_amount = EXCLUDED.discount_amount,
          tax_amount = EXCLUDED.tax_amount,
          shipping_amount = EXCLUDED.shipping_amount,
          total = EXCLUDED.total,
          payment_method_id = EXCLUDED.payment_method_id,
          payment_method_2_id = EXCLUDED.payment_method_2_id,
          payment_amount_1 = EXCLUDED.payment_amount_1,
          payment_amount_2 = EXCLUDED.payment_amount_2,
          payment_reference = EXCLUDED.payment_reference,
          payment_gateway_request = EXCLUDED.payment_gateway_request,
          payment_gateway_response = EXCLUDED.payment_gateway_response,
          status = EXCLUDED.status,
          observation = EXCLUDED.observation,
          confirmation_notes = EXCLUDED.confirmation_notes,
          cancellation_reason = EXCLUDED.cancellation_reason,
          cancelled_at = EXCLUDED.cancelled_at,
          order_date = EXCLUDED.order_date,
          is_invoiced = EXCLUDED.is_invoiced,
          dispatch_type_id = EXCLUDED.dispatch_type_id,
          pickup_branch_id = EXCLUDED.pickup_branch_id,
          shipping_address_snapshot = EXCLUDED.shipping_address_snapshot,
          is_ecommerce = EXCLUDED.is_ecommerce,
          is_public_sale = EXCLUDED.is_public_sale,
          ecommerce_commission = EXCLUDED.ecommerce_commission,
          customer_earnings = EXCLUDED.customer_earnings,
          sponsor_customer_id = EXCLUDED.sponsor_customer_id,
          sponsor_received = EXCLUDED.sponsor_received,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        { shipping_address_snapshot: 'jsonb' }
      );
    },
  }));

  // ==============================================================
  // order_items (4.6M registros) — BULK
  // ==============================================================
  logger.table('order_items', 'Migrando t_document_det → order_items (BULK)');
  const itemCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_document_det');
  logger.info(`    Total registros en t_document_det: ${itemCount.toLocaleString()}`);

  // WarmUp orders para resolver order_id desde cache
  await idResolver.warmUpFromQuery(v2Pool, 'order',
    'SELECT legacy_id::text AS legacy_id, id FROM tonic.orders WHERE legacy_id IS NOT NULL'
  );

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_document_det, id_document, id_product, id_product_pack,
             qty_pack, qty, price, lot, point, value_business,
             date_expiration, enabled, qty_original
      FROM toniclife.t_document_det ORDER BY id_document_det
    `,
    tableName: 'order_items',
    totalCount: itemCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const orderLegacyIds = [...new Set(rows.map(r => r.id_document).filter(Boolean))];
      const orderMap = await idResolver.resolveMany(v2Pool, 'order', orderLegacyIds, 'orders');

      const productLegacyIds = [...new Set([
        ...rows.map(r => r.id_product),
        ...rows.map(r => r.id_product_pack),
      ].filter(Boolean))];
      const productMap = await idResolver.resolveMany(v2Pool, 'product', productLegacyIds, 'products');

      return { orderMap, productMap };
    },

    transformRow: (row, resolved) => {
      const orderId = resolved.orderMap.get(String(row.id_document));
      if (!orderId) return null;

      const productId = resolved.productMap.get(String(row.id_product));
      if (!productId) return null;

      const packProductId = row.id_product_pack
        ? resolved.productMap.get(String(row.id_product_pack)) || null
        : null;

      const qty = toDecimal(row.qty, 1);
      const price = toDecimal(row.price, 0);

      return {
        order_id: orderId,
        product_id: productId,
        pack_product_id: packProductId,
        quantity: qty,
        quantity_original: toDecimal(row.qty_original),
        quantity_pack: toDecimal(row.qty_pack),
        unit_price: price,
        total_price: qty * price,
        points: toDecimal(row.point),
        business_value: toDecimal(row.value_business),
        lot_number: cleanTrunc(row.lot, 50),
        expiration_date: row.date_expiration || null,
        is_active: row.enabled != 0,
        legacy_id: row.id_document_det,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'order_id', 'product_id', 'pack_product_id',
        'quantity', 'quantity_original', 'quantity_pack',
        'unit_price', 'total_price',
        'points', 'business_value',
        'lot_number', 'expiration_date',
        'is_active', 'legacy_id',
      ];
      return buildMultiRowInsertWithUUID('tonic.order_items', columns, rows,
        `ON CONFLICT (legacy_id) DO UPDATE SET
          order_id = EXCLUDED.order_id,
          product_id = EXCLUDED.product_id,
          pack_product_id = EXCLUDED.pack_product_id,
          quantity = EXCLUDED.quantity,
          quantity_original = EXCLUDED.quantity_original,
          quantity_pack = EXCLUDED.quantity_pack,
          unit_price = EXCLUDED.unit_price,
          total_price = EXCLUDED.total_price,
          points = EXCLUDED.points,
          business_value = EXCLUDED.business_value,
          lot_number = EXCLUDED.lot_number,
          expiration_date = EXCLUDED.expiration_date,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // ==============================================================
  // order_shipments — BULK
  // ==============================================================
  logger.table('order_shipments', 'Migrando t_sale_tracker → order_shipments (BULK)');
  const shipmentCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_sale_tracker');

  const SHIPMENT_STATUS_MAP = {
    'pending': 'pending', 'PENDING': 'pending',
    'shipped': 'shipped', 'SHIPPED': 'shipped',
    'enviado': 'shipped', 'ENVIADO': 'shipped',
    'in_transit': 'in_transit', 'IN_TRANSIT': 'in_transit',
    'en_transito': 'in_transit', 'EN_TRANSITO': 'in_transit',
    'delivered': 'delivered', 'DELIVERED': 'delivered',
    'entregado': 'delivered', 'ENTREGADO': 'delivered',
    'returned': 'returned', 'RETURNED': 'returned',
    'devuelto': 'returned', 'DEVUELTO': 'returned',
    'rejected': 'rejected', 'REJECTED': 'rejected',
    'rechazado': 'rejected', 'RECHAZADO': 'rejected',
  };

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_sale, provider_name, guide_number, send_date,
             user_created, date_created, status_dispatch
      FROM toniclife.t_sale_tracker ORDER BY id_sale
    `,
    tableName: 'order_shipments',
    totalCount: shipmentCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const orderLegacyIds = [...new Set(rows.map(r => r.id_sale).filter(Boolean))];
      const orderMap = await idResolver.resolveMany(v2Pool, 'order', orderLegacyIds, 'orders');
      return { orderMap };
    },

    transformRow: (row, resolved) => {
      const orderId = resolved.orderMap.get(String(row.id_sale));
      if (!orderId) return null;

      const rawStatus = cleanString(row.status_dispatch);
      const status = (rawStatus && SHIPMENT_STATUS_MAP[rawStatus])
        || (row.send_date ? 'shipped' : 'pending');

      return {
        order_id: orderId,
        carrier_name: cleanTrunc(row.provider_name, 50),
        tracking_number: cleanTrunc(row.guide_number, 100),
        ship_date: row.send_date || null,
        status,
        legacy_id: row.id_sale,
        is_active: true,
        created_at: row.date_created || new Date(),
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'order_id', 'carrier_name', 'tracking_number',
        'ship_date', 'status', 'legacy_id', 'is_active', 'created_at',
      ];
      return buildMultiRowInsertWithUUID('tonic.order_shipments', columns, rows,
        `ON CONFLICT (legacy_id) DO UPDATE SET
          order_id = EXCLUDED.order_id,
          carrier_name = EXCLUDED.carrier_name,
          tracking_number = EXCLUDED.tracking_number,
          ship_date = EXCLUDED.ship_date,
          status = EXCLUDED.status,
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

  logger.info(`\n  Fase 07 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
