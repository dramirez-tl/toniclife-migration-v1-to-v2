/**
 * Mapas de valores válidos para CHECK constraints en v2.
 */
const VALID_VALUES = {
  'orders.source': ['pos', 'ecommerce', 'ecommerce_pending', 'app', 'phone', 'other'],
  'orders.status': ['pending', 'confirmed', 'cancelled', 'returned', 'transferred'],
  'customers.customer_type': ['distributor', 'final_customer', 'preferred_customer'],
  'customers.status': ['active', 'inactive', 'suspended', 'pending'],
  'customers.kit_type': ['basic', 'premium', null],
  'products.product_type': ['finished_good', 'raw_material', 'kit', 'service', 'promotional', 'material'],
  'employees.status': ['active', 'inactive', 'on_leave', 'terminated'],
  'employees.contract_type': ['permanent', 'temporary', 'trial_period', 'initial_training'],
  'employees.gender': ['male', 'female', 'other'],
  'payment_methods.payment_type': ['cash', 'card', 'bank_transfer', 'digital_wallet', 'credit', 'points', 'check', 'other'],
  'dispatch_types.category': ['sales', 'inventory', 'production'],
  'branches.rounding_mode': ['half_up', 'half_down', 'floor', 'ceil', 'none'],
  'promotions.promotion_type': ['free_product', 'percentage_discount', 'fixed_discount', 'points_multiplier'],
  'invoices.status': ['pending', 'stamped', 'cancelled', 'error'],
  'commission_periods.status': ['open', 'closed', 'paid'],
};

/**
 * Valida que un valor sea válido para un CHECK constraint.
 * Retorna el valor si es válido, o el defaultValue si no.
 */
function validateEnum(constraintKey, value, defaultValue) {
  const valid = VALID_VALUES[constraintKey];
  if (!valid) return value; // constraint no definido, pasar directo
  if (valid.includes(value)) return value;
  if (valid.includes(null) && (value === null || value === undefined)) return null;
  return defaultValue !== undefined ? defaultValue : valid[0];
}

/**
 * Limpia un string: trim, y convierte vacío a null.
 */
function cleanString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Convierte 1/0 a boolean.
 */
function toBoolean(value) {
  if (value === null || value === undefined) return false;
  return value === 1 || value === '1' || value === true;
}

/**
 * Convierte un valor numérico a decimal seguro para PostgreSQL.
 */
function toDecimal(value, defaultValue) {
  if (value === null || value === undefined) return defaultValue ?? null;
  const num = parseFloat(value);
  return isNaN(num) ? (defaultValue ?? null) : num;
}

/**
 * Genera un slug a partir de un texto.
 */
function slugify(text) {
  if (!text) return null;
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 250);
}

/**
 * Limpia un string y lo trunca a maxLen caracteres.
 * Retorna null si el valor es vacío.
 */
function cleanTrunc(value, maxLen) {
  const s = cleanString(value);
  if (s === null) return null;
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

/**
 * Prefija una ruta de archivo con la URL base de assets de Tonic Life.
 * - null/empty → null
 * - Ya empieza con "http" → lo deja tal cual
 * - Empieza con "assets/" → antepone "https://tonic-life.net/" (sin duplicar assets)
 * - Empieza con "/" → antepone "https://tonic-life.net/assets"
 * - Otro → antepone "https://tonic-life.net/assets/"
 */
function prefixUrl(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase().startsWith('http')) return trimmed;
  if (trimmed.startsWith('assets/')) return `https://tonic-life.net/${trimmed}`;
  if (trimmed.startsWith('/')) return `https://tonic-life.net/assets${trimmed}`;
  return `https://tonic-life.net/assets/${trimmed}`;
}

module.exports = {
  VALID_VALUES,
  validateEnum,
  cleanString,
  cleanTrunc,
  toBoolean,
  toDecimal,
  slugify,
  prefixUrl,
};
