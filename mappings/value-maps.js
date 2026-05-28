/**
 * Mapas de conversión de valores v1 → v2
 */

// t_customers.id_status → customers.status
const CUSTOMER_STATUS = {
  1: 'active',
  2: 'inactive',
  3: 'suspended',
  _default: 'pending',
};

// t_customers.id_kit → customers.kit_type
// Mig 028 amplio CHECK para incluir 'preferente'.
// OJO: v1 guarda TEXTO en id_kit ('basico' / 'premium'), no 1/2/3.
const KIT_TYPE = {
  'basico': 'basic',
  'premium': 'premium',
  'preferente': 'preferente',
  // compat numérico (por si alguna fila antigua usa códigos)
  1: 'basic',
  2: 'premium',
  3: 'preferente',
  _default: null,
};

// t_document.anulado → orders.status
const ORDER_STATUS_FROM_ANULADO = {
  0: 'confirmed',
  1: 'cancelled',
  _default: 'confirmed',
};

// t_document.source_doc → orders.source
const ORDER_SOURCE = {
  'pos': 'pos',
  'POS': 'pos',
  'ecommerce': 'ecommerce',
  'ECOMMERCE': 'ecommerce',
  'ecommerce_pending': 'ecommerce_pending',
  'app': 'app',
  'APP': 'app',
  'phone': 'phone',
  'PHONE': 'phone',
  _default: 'other',
};

// t_users.enabled_user → users.status
const USER_STATUS = {
  1: 'active',
  0: 'inactive',
  _default: 'inactive',
};

// t_employees.status → employees.status
const EMPLOYEE_STATUS = {
  1: 'active',
  0: 'inactive',
  _default: 'active',
};

// t_language.id → language_code
const LANGUAGE_CODE = {
  1: 'es',
  2: 'en',
  _default: 'es',
};

// Función helper para mapear un valor usando un mapa
function mapValue(map, value) {
  if (value === null || value === undefined) return map._default || null;
  const mapped = map[value] || map[String(value)];
  return mapped !== undefined ? mapped : (map._default || null);
}

module.exports = {
  CUSTOMER_STATUS,
  KIT_TYPE,
  ORDER_STATUS_FROM_ANULADO,
  ORDER_SOURCE,
  USER_STATUS,
  EMPLOYEE_STATUS,
  LANGUAGE_CODE,
  mapValue,
};
