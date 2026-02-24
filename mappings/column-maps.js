/**
 * Definiciones centralizadas de mapeo de columnas v1 → v2.
 * Cada entrada define: la tabla fuente v1, la tabla destino v2,
 * y cómo se mapea cada columna.
 *
 * Este archivo es documentación/referencia. La lógica real de
 * transformación está en cada archivo de fase.
 */

module.exports = {
  // ============================================
  // FASE 1 — Catálogos
  // ============================================
  countries: {
    source: 't_country',
    target: 'countries',
    strategy: 'legacy_id_map',
    entityType: 'country',
  },
  currencies: {
    source: 't_type_money',
    target: 'currencies',
    strategy: 'legacy_id_map',
    entityType: 'currency',
  },
  priceTypes: {
    source: 't_type_price',
    target: 'price_types',
    strategy: 'legacy_id_map',
    entityType: 'price_type',
  },
  documentTypes: {
    source: 't_type_document',
    target: 'document_types',
    strategy: 'legacy_id',
  },
  paymentMethods: {
    source: 't_type_format_pay',
    target: 'payment_methods',
    strategy: 'legacy_id_map',
    entityType: 'payment_method',
  },
  taxRules: {
    source: 't_tax',
    target: 'tax_rules',
    strategy: 'legacy_id_map',
    entityType: 'tax_rule',
  },
  dispatchTypes: {
    source: 't_dispatch',
    target: 'dispatch_types',
    strategy: 'legacy_id',
  },
  exchangeRates: {
    source: 't_exchange',
    target: 'exchange_rates',
    strategy: 'legacy_id_map',
    entityType: 'exchange_rate',
  },
  satCfdiUses: {
    source: 't_cfdi',
    target: 'sat_cfdi_uses',
    strategy: 'legacy_id',
  },
  satTaxRegimes: {
    source: 't_regimen',
    target: 'sat_tax_regimes',
    strategy: 'legacy_id',
  },

  // ============================================
  // FASE 2 — Sucursales
  // ============================================
  branches: {
    source: 't_branch_office',
    target: 'branches',
    strategy: 'legacy_id_map',
    entityType: 'branch',
  },
  branchTaxRules: {
    source: 't_branch_office_tax',
    target: 'branch_tax_rules',
    strategy: 'legacy_id_map',
    entityType: 'branch_tax_rule',
  },

  // ============================================
  // FASE 3 — Seguridad
  // ============================================
  roles: {
    source: 't_profile',
    target: 'roles',
    strategy: 'legacy_id_map',
    entityType: 'role',
  },
  permissions: {
    source: 't_tags_items',
    target: 'permissions',
    strategy: 'legacy_id_map',
    entityType: 'permission',
  },
  rolePermissions: {
    source: 't_tags_items_profile',
    target: 'role_permissions',
    strategy: 'legacy_id_map',
    entityType: 'role_permission',
  },
  workers: {
    source: 't_worker',
    target: 'workers',
    strategy: 'legacy_id_map',
    entityType: 'worker',
  },
  users: {
    source: 't_users',
    target: 'users',
    strategy: 'legacy_id',
  },
  userBranches: {
    source: 't_users_branch_office',
    target: 'user_branches',
    strategy: 'legacy_id_map',
    entityType: 'user_branch',
  },

  // ============================================
  // FASE 4 — Productos
  // ============================================
  productCategories: {
    source: 't_clasification',
    target: 'product_categories',
    strategy: 'legacy_id_map',
    entityType: 'product_category',
  },
  products: {
    source: 't_product',
    target: 'products',
    strategy: 'legacy_id_map',
    entityType: 'product',
  },
  productPrices: {
    source: 't_product_price',
    target: 'product_prices',
    strategy: 'legacy_id_map',
    entityType: 'product_price',
  },

  // ============================================
  // FASE 5 — Clientes
  // ============================================
  mlmRanks: {
    source: 't_plan',
    target: 'mlm_ranks',
    strategy: 'legacy_id',
  },
  customers: {
    source: 't_customers',
    target: 'customers',
    strategy: 'legacy_id',
  },

  // ============================================
  // FASE 6 — Red
  // ============================================
  networkMembers: {
    source: 't_red',
    target: 'network_members',
    strategy: 'legacy_id',
  },

  // ============================================
  // FASE 7 — Ventas
  // ============================================
  orders: {
    source: 't_document',
    target: 'orders',
    strategy: 'legacy_id',
  },
  orderItems: {
    source: 't_document_det',
    target: 'order_items',
    strategy: 'legacy_id',
  },
};
