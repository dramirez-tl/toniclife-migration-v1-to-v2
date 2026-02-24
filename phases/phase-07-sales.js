const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, toBoolean, validateEnum } = require('../utils/validators');
const { mapValue, ORDER_STATUS_FROM_ANULADO, ORDER_SOURCE } = require('../mappings/value-maps');
const config = require('../config');

module.exports = async function phase07(v1Pool, v2Pool) {
  logger.phase('07', 'Ventas y Documentos');
  const allResults = [];

  // Pre-calentar caché
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches', column: 'id' },
    { type: 'payment_method', table: 'payment_methods', column: 'id' },
    { type: 'product', table: 'products', column: 'id' },
  ]);

  // ==============================================================
  // promotions
  // v1 t_promo: id_promo(PK), name_promo, flag_point_promo(bool),
  //   percentage_discount_promo(numeric), flag_percentage_discount_promo(bool),
  //   date_start_promo(date), date_end_promo(date), enabled_promo(bool),
  //   date_created, user_created, date_updated, user_updated
  // v2: name(NOT NULL varchar 100), promotion_type(NOT NULL CHECK),
  //   start_date(NOT NULL), end_date(NOT NULL), CHECK end_date >= start_date,
  //   discount_percentage, includes_points, legacy_id(UNIQUE int), is_active
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
      // Determinar promotion_type según flag
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
        ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name`,
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
  // v1 t_promo_det: PK compuesto (id_promo, id_product).
  //   Columnas: id_promo, id_product, qty_min, qty_free
  //   NO tiene id_promo_det
  // v2: promotion_id(NOT NULL), product_id(NOT NULL), min_quantity(NOT NULL),
  //   free_quantity. NO tiene legacy_id.
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

      // Idempotencia: skip si ya existe (promotion_id + product_id)
      const exists = await client.query(
        'SELECT 1 FROM tonic.promotion_items WHERE promotion_id = $1 AND product_id = $2 LIMIT 1',
        [promotionId, productId]
      );
      if (exists.rows.length > 0) return 'skipped';

      await client.query(
        `INSERT INTO tonic.promotion_items (
          id, promotion_id, product_id, min_quantity, free_quantity, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, true)`,
        [promotionId, productId, toDecimal(row.qty_min, 1), toDecimal(row.qty_free, 0)]
      );
    },
  }));

  // ==============================================================
  // shopping_carts
  // v1 t_cart: PK compuesto (id_customers, id_customers_sale_public, id_customers_sale).
  //   NO tiene id_cart.
  //   Columnas relevantes: id_customers, id_customers_sale, id_customers_sale_public,
  //     id_branch_office, total, iva, has_shipping, is_usa, type_cart(enum),
  //     discount_type, discount_doc, discount_amount, has_subscription,
  //     payment_request, rfc_customers, zip_code_customers, id_regimen, id_cfdi,
  //     zip_code_cart, address_cart, province_cart, department_cart,
  //     full_name_cart, phone_cart, email_cart, created_at,
  //     name_customers, last_name_customers, id_customers_kit
  // v2: customer_id(NOT NULL), sale_customer_id, cart_type(CHECK: regular,public,customer_kit),
  //     branch_id, subtotal, tax_amount, status(CHECK: active,converted,abandoned,expired),
  //     requires_shipping, is_usa, shipping_name, shipping_zip_code, shipping_state,
  //     shipping_city, shipping_phone, billing_rfc, billing_zip_code,
  //     billing_tax_regime_code, billing_cfdi_use_code, has_subscription,
  //     payment_request, discount_type, discount_amount, is_active
  //     NO tiene legacy_id.
  // ==============================================================
  logger.table('shopping_carts', 'Migrando t_cart → shopping_carts');

  // Mapeo de type_cart v1 → cart_type v2
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

      // Idempotencia: skip si ya existe para este customer
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
          customerId,                                              // $1
          saleCustomerId,                                          // $2
          cartType,                                                // $3
          branchId,                                                // $4
          toDecimal(row.total, 0),                                 // $5
          toDecimal(row.iva, 0),                                   // $6
          row.discount_type != null ? Number(row.discount_type) : null, // $7
          toDecimal(row.discount_amount, 0),                       // $8
          toBoolean(row.has_shipping),                             // $9
          toBoolean(row.is_usa),                                   // $10
          toBoolean(row.has_subscription),                         // $11
          cleanTrunc(row.full_name_cart, 200),                     // $12
          cleanTrunc(row.zip_code_cart, 10),                       // $13
          cleanTrunc(row.province_cart, 100),                      // $14
          cleanTrunc(row.department_cart, 100),                    // $15
          cleanTrunc(row.phone_cart, 30),                          // $16
          cleanTrunc(row.rfc_customers, 13),                       // $17
          cleanTrunc(row.zip_code_customers, 10),                  // $18
          row.payment_request ? String(row.payment_request).substring(0, 5000) : null, // $19
          row.created_at || new Date(),                            // $20
        ]
      );

      // Registrar mapeo para poder vincular cart_items
      if (rows.length > 0) {
        await idResolver.registerMapping(
          v2Pool, 'shopping_cart', row.id_customers, rows[0].id, 't_cart'
        );
      }
    },
  }));

  // ==============================================================
  // shopping_cart_items
  // v1 t_cart_det: PK compuesto (id_product, id_customers, id_customers_sale_public).
  //   NO tiene id_cart_det ni id_cart.
  //   Columnas: id_customers, id_customers_sale_public, id_product,
  //     qty, price, lot, point, value_business, price_original
  // v2: cart_id(NOT NULL), product_id(NOT NULL), quantity(NOT NULL),
  //     unit_price(NOT NULL), original_price, points, business_value,
  //     lot_number(varchar 50), is_active
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
      // Buscar el cart en v2 via el customer
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

      // Idempotencia: skip si ya existe (cart_id + product_id)
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
          cartId,
          productId,
          toDecimal(row.qty, 1),
          toDecimal(row.price, 0),
          toDecimal(row.price_original),
          toDecimal(row.point),
          toDecimal(row.value_business),
          cleanTrunc(row.lot, 50),
        ]
      );
    },
  }));

  // ==============================================================
  // orders (1.7M registros)
  // v1 t_document: id_document(PK int), number_invoice_doc, number_lot_doc,
  //   id_period, id_type_document, observation_doc, id_branch_office_origin,
  //   id_branch_office_destination, date_doc, total_doc, subtotal_doc, iva_doc,
  //   total_sin_iva_doc, discount_amount, discount_doc, total_iva_doc,
  //   id_customers, source_doc, has_invoice_doc, user_created, payment_request,
  //   payment_response, id_type_format_pay, created_at, updated_at,
  //   shipping_value, zip_code_customers, department_customers, province_customers,
  //   address_customers, pick_up_branch_office, id_dispatch, anulado,
  //   observation_confirm, id_type_format_pay_2, amount_format_pay,
  //   amount_format_pay_2, observation_anulado, date_anulado,
  //   sponsor_received, id_sponsor, ecommerce_publico, earnings_customers,
  //   phone_cart, email_cart, full_name_cart, commission_ecommerce
  // v2 orders: branch_id(NOT NULL), subtotal(NOT NULL), total(NOT NULL),
  //   order_date(NOT NULL date), order_number(UNIQUE varchar 20),
  //   legacy_id(UNIQUE int), status(CHECK), source(CHECK)
  // ==============================================================
  logger.table('orders', 'Migrando t_document → orders');
  const orderCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_document');
  logger.info(`    Total registros en t_document: ${orderCount.toLocaleString()}`);

  allResults.push(await processWithCursor({
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
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office_origin)
        || await idResolver.resolve(v2Pool, 'branch', 1); // default branch
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', row.id_period, 'commission_periods');
      const docTypeId = await idResolver.resolve(v2Pool, 'document_type', row.id_type_document, 'document_types');
      const payMethodId = await idResolver.resolve(v2Pool, 'payment_method', row.id_type_format_pay);
      const payMethod2Id = await idResolver.resolve(v2Pool, 'payment_method', row.id_type_format_pay_2);
      const dispatchTypeId = await idResolver.resolve(v2Pool, 'dispatch_type', row.id_dispatch, 'dispatch_types');
      const pickupBranchId = await idResolver.resolve(v2Pool, 'branch', row.pick_up_branch_office);

      if (!branchId) return 'skipped';

      const status = mapValue(ORDER_STATUS_FROM_ANULADO, row.anulado);
      const source = mapValue(ORDER_SOURCE, row.source_doc);
      // order_number max 20 chars: "M-" + id (max 18 dígitos)
      const orderNumber = `M-${row.id_document}`.substring(0, 20);

      // Construir shipping_address_snapshot desde columnas reales de v1
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

      // Resolver sponsor_customer_id
      let sponsorCustomerId = null;
      if (row.id_sponsor) {
        sponsorCustomerId = await idResolver.resolve(v2Pool, 'customer', row.id_sponsor, 'customers');
      }

      await client.query(
        `INSERT INTO tonic.orders (
          id, legacy_id, order_number, document_type_id, source,
          period_id, customer_id, branch_id,
          subtotal, discount_percentage, discount_amount,
          tax_amount, shipping_amount, total,
          payment_method_id, payment_method_2_id,
          payment_amount_1, payment_amount_2,
          payment_reference,
          payment_gateway_request, payment_gateway_response,
          status, observation, confirmation_notes,
          cancellation_reason, cancelled_at,
          order_date, is_invoiced,
          dispatch_type_id, pickup_branch_id,
          shipping_address_snapshot,
          is_ecommerce, is_public_sale,
          ecommerce_commission, customer_earnings,
          sponsor_customer_id, sponsor_received,
          is_active, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, $15,
          $16, $17,
          $18,
          $19, $20,
          $21, $22, $23,
          $24, $25,
          $26, $27,
          $28, $29,
          $30::jsonb,
          $31, $32,
          $33, $34,
          $35, $36,
          $37, $38, $39
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = NOW()`,
        [
          row.id_document,                                                          // $1
          orderNumber,                                                              // $2
          docTypeId,                                                                // $3
          source,                                                                   // $4
          periodId,                                                                 // $5
          customerId,                                                               // $6
          branchId,                                                                 // $7
          toDecimal(row.subtotal_doc, 0),                                           // $8
          toDecimal(row.discount_doc, 0),                                           // $9
          toDecimal(row.discount_amount, 0),                                        // $10
          toDecimal(row.iva_doc, 0),                                                // $11
          toDecimal(row.shipping_value, 0),                                         // $12
          toDecimal(row.total_doc, 0),                                              // $13
          payMethodId,                                                              // $14
          payMethod2Id,                                                             // $15
          toDecimal(row.amount_format_pay),                                         // $16
          toDecimal(row.amount_format_pay_2),                                       // $17
          cleanTrunc(row.number_invoice_doc, 100),                                  // $18
          row.payment_request ? String(row.payment_request).substring(0, 5000) : null,  // $19
          row.payment_response ? String(row.payment_response).substring(0, 5000) : null, // $20
          status,                                                                   // $21
          cleanString(row.observation_doc),                                         // $22
          cleanString(row.observation_confirm),                                     // $23
          cleanString(row.observation_anulado),                                     // $24
          row.date_anulado || null,                                                 // $25
          row.date_doc || new Date().toISOString().split('T')[0],                   // $26
          toBoolean(row.has_invoice_doc),                                           // $27
          dispatchTypeId,                                                           // $28
          pickupBranchId,                                                           // $29
          shippingSnapshot,                                                         // $30
          source === 'ecommerce' || source === 'ecommerce_pending',                 // $31
          toBoolean(row.ecommerce_publico),                                         // $32
          toDecimal(row.commission_ecommerce),                                      // $33
          toDecimal(row.earnings_customers),                                        // $34
          sponsorCustomerId,                                                        // $35
          toBoolean(row.sponsor_received),                                          // $36
          status !== 'cancelled',                                                   // $37
          row.created_at || new Date(),                                             // $38
          row.updated_at || row.created_at || new Date(),                           // $39
        ]
      );
    },
  }));

  // ==============================================================
  // order_items (4.6M registros)
  // v1 t_document_det: id_document_det(bigint), id_document(bigint FK),
  //   id_product(bigint), id_product_pack(bigint), qty_pack(bigint),
  //   qty(bigint), price(numeric), lot(text), point(numeric),
  //   value_business(numeric), date_expiration(date), enabled(bigint),
  //   qty_original(bigint)
  // v2 order_items: order_id(NOT NULL), product_id(NOT NULL), quantity(NOT NULL),
  //   unit_price(NOT NULL), total_price(NOT NULL), points, business_value,
  //   lot_number(varchar 50), expiration_date, pack_product_id, quantity_pack,
  //   quantity_original, line_number, is_active, legacy_id(UNIQUE bigint)
  // ==============================================================
  logger.table('order_items', 'Migrando t_document_det → order_items');
  const itemCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_document_det');
  logger.info(`    Total registros en t_document_det: ${itemCount.toLocaleString()}`);

  allResults.push(await processWithCursor({
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
    transformAndInsert: async (row, client) => {
      // Resolver order_id via orders.legacy_id
      const orderResult = await client.query(
        'SELECT id FROM tonic.orders WHERE legacy_id = $1 LIMIT 1',
        [row.id_document]
      );
      if (orderResult.rows.length === 0) return 'skipped';
      const orderId = orderResult.rows[0].id;

      const productId = await idResolver.resolve(v2Pool, 'product', row.id_product);
      if (!productId) return 'skipped';

      const packProductId = row.id_product_pack
        ? await idResolver.resolve(v2Pool, 'product', row.id_product_pack)
        : null;

      const qty = toDecimal(row.qty, 1);
      const price = toDecimal(row.price, 0);
      const totalPrice = qty * price;

      await client.query(
        `INSERT INTO tonic.order_items (
          id, order_id, product_id, pack_product_id,
          quantity, quantity_original, quantity_pack,
          unit_price, total_price,
          points, business_value,
          lot_number, expiration_date,
          is_active, legacy_id
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6,
          $7, $8,
          $9, $10,
          $11, $12,
          $13, $14
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          quantity = EXCLUDED.quantity,
          updated_at = NOW()`,
        [
          orderId,                            // $1
          productId,                          // $2
          packProductId,                      // $3
          qty,                                // $4
          toDecimal(row.qty_original),        // $5
          toDecimal(row.qty_pack),            // $6
          price,                              // $7
          totalPrice,                         // $8
          toDecimal(row.point),               // $9
          toDecimal(row.value_business),      // $10
          cleanTrunc(row.lot, 50),            // $11
          row.date_expiration || null,        // $12
          row.enabled != 0,                   // $13
          row.id_document_det,                // $14
        ]
      );
    },
  }));

  // ==============================================================
  // order_shipments
  // v1 t_sale_tracker: id_sale(PK bigint, FK a t_document.id_document),
  //   provider_name(varchar), guide_number(varchar), send_date(date),
  //   user_created(varchar), date_created(timestamptz), status_dispatch(varchar)
  //   NO tiene id_sale_tracker
  // v2 order_shipments: order_id(NOT NULL), carrier_name(varchar 50),
  //   tracking_number(varchar 100), ship_date(date), status(CHECK:
  //   pending,shipped,in_transit,delivered,returned,rejected),
  //   legacy_id(UNIQUE bigint), notes, is_active
  // ==============================================================
  logger.table('order_shipments', 'Migrando t_sale_tracker → order_shipments');
  const shipmentCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_sale_tracker');

  // Mapeo de status_dispatch v1 → v2 CHECK values
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

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_sale, provider_name, guide_number, send_date,
             user_created, date_created, status_dispatch
      FROM toniclife.t_sale_tracker ORDER BY id_sale
    `,
    tableName: 'order_shipments',
    totalCount: shipmentCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // id_sale es tanto PK como FK a t_document.id_document
      const orderResult = await client.query(
        'SELECT id FROM tonic.orders WHERE legacy_id = $1 LIMIT 1',
        [row.id_sale]
      );
      if (orderResult.rows.length === 0) return 'skipped';

      // Determinar status
      const rawStatus = cleanString(row.status_dispatch);
      const status = (rawStatus && SHIPMENT_STATUS_MAP[rawStatus])
        || (row.send_date ? 'shipped' : 'pending');

      await client.query(
        `INSERT INTO tonic.order_shipments (
          id, order_id, carrier_name, tracking_number,
          ship_date, status, legacy_id, is_active, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6, true, $7
        )
        ON CONFLICT (legacy_id) DO NOTHING`,
        [
          orderResult.rows[0].id,                    // $1
          cleanTrunc(row.provider_name, 50),          // $2
          cleanTrunc(row.guide_number, 100),           // $3
          row.send_date || null,                       // $4
          status,                                      // $5
          row.id_sale,                                 // $6
          row.date_created || new Date(),              // $7
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

  logger.info(`\n  Fase 07 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
