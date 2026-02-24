const logger = require('../utils/logger');
const {
  disableAllTriggers,
  createMissingUniqueIndexes,
  dropNetworkCheckConstraint,
  dropStockLevelsCheckConstraint,
} = require('../utils/trigger-manager');

module.exports = async function phase00(v1Pool, v2Pool) {
  logger.phase('00', 'Infraestructura');

  // 1. Deshabilitar todos los triggers
  await disableAllTriggers(v2Pool);

  // 2. Crear índices UNIQUE faltantes
  await createMissingUniqueIndexes(v2Pool);

  // 3. Eliminar CHECK constraints temporalmente
  await dropNetworkCheckConstraint(v2Pool);
  await dropStockLevelsCheckConstraint(v2Pool);

  // 4. Verificar tablas de configuración pre-pobladas
  logger.table('Verificación', 'Verificando tablas de configuración pre-pobladas');
  const checks = [
    { table: 'tenant_config', label: 'tenant_config' },
    { table: 'isr_brackets', label: 'isr_brackets' },
    { table: 'sequence_counters', label: 'sequence_counters' },
  ];
  for (const check of checks) {
    const { rows } = await v2Pool.query(`SELECT COUNT(*) AS count FROM tonic.${check.table}`);
    const count = parseInt(rows[0].count, 10);
    if (count === 0) {
      logger.warn(`  ⚠ ${check.label} está vacía — puede necesitar datos iniciales`);
    } else {
      logger.info(`  ✓ ${check.label}: ${count} registros`);
    }
  }

  // 5. Insertar invoice_provider default (Facturama)
  logger.table('invoice_providers', 'Insertando proveedor de facturación default');
  await v2Pool.query(`
    INSERT INTO tonic.invoice_providers (id, code, name, country_code, api_base_url, is_active)
    VALUES (gen_random_uuid(), 'facturama', 'Facturama', 'MX', 'https://apisandbox.facturama.mx', true)
    ON CONFLICT DO NOTHING
  `);
  logger.info('  ✓ invoice_providers: proveedor Facturama verificado');

  // 6. Insertar commission_tax_regimes (derivados de regímenes fiscales)
  logger.table('commission_tax_regimes', 'Insertando regímenes fiscales de comisiones');
  const regimes = [
    { code: 'ASIMILADOS', name: 'Asimilados a salarios', iva_rate: 0, isr_retention_rate: 0.10 },
    { code: 'FIC', name: 'Factura Individual de Comisiones', iva_rate: 0.16, isr_retention_rate: 0 },
    { code: 'RESICO', name: 'RESICO', iva_rate: 0, isr_retention_rate: 0, resico_rate: 0.0125 },
    { code: 'MORAL', name: 'Persona Moral', iva_rate: 0.16, isr_retention_rate: 0 },
    { code: 'FRONTERIZA', name: 'Zona Fronteriza', iva_rate: 0.08, isr_retention_rate: 0 },
    { code: 'SIN_IMPUESTO', name: 'Sin impuesto', iva_rate: 0, isr_retention_rate: 0 },
  ];
  for (const r of regimes) {
    await v2Pool.query(`
      INSERT INTO tonic.commission_tax_regimes (id, code, name, iva_rate, isr_retention_rate, resico_rate, is_active)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
      ON CONFLICT DO NOTHING
    `, [r.code, r.name, r.iva_rate, r.isr_retention_rate, r.resico_rate || 0]);
  }
  logger.info(`  ✓ commission_tax_regimes: ${regimes.length} regímenes verificados`);

  return { migrated: 0, skipped: 0, failed: 0, errors: [] };
};
