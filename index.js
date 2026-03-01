#!/usr/bin/env node

// Manejar --help antes de cargar config (que valida .env)
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
TonicLife ERP — Migración v1 → v2

Uso: node index.js [opciones]

Opciones:
  --phase <N>, -p <N>     Ejecutar solo la fase N (se puede repetir)
  --validate              Solo ejecutar validación (fase 99)
  --skip-validation       Todo excepto fase 99
  --dry-run               Conectar y mostrar plan sin ejecutar
  --help, -h              Mostrar esta ayuda

Fases: 0(Infra), 1(Catálogos), 2(Sucursales), 3(Seguridad), 3b(Fix Passwords),
       4(Productos), 4b(Fix Precios), 4c(Fix USD), 4d(Fix Frontera),
       4e(Fix Guatemala), 4f(Fix Colombia), 5(Clientes), 6(Red MLM), 7(Ventas),
       7b(Tipos Orden), 8(Facturación), 9(Comisiones), 10(Inventario),
       10b(Proveedores), 11(RRHH), 12(Comunicación), 13(Auditoría),
       99(Post-Migración)

Requiere .env con credenciales. Copia .env.example como plantilla.
`);
  process.exit(0);
}

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./utils/logger');
const { generateReport } = require('./reports/migration-report');

// =============================================
// Definición de fases
// =============================================
const PHASES = {
  0:   { name: 'Infraestructura',            module: './phases/phase-00-infrastructure' },
  1:   { name: 'Catálogos Base',             module: './phases/phase-01-catalogs' },
  2:   { name: 'Sucursales',                 module: './phases/phase-02-branches' },
  3:   { name: 'Seguridad y Acceso',         module: './phases/phase-03-security' },
  '3b': { name: 'Fix Contraseñas bcrypt',    module: './phases/phase-03b-fix-passwords' },
  4:   { name: 'Productos',                  module: './phases/phase-04-products' },
  '4b': { name: 'Fix Precios Points/BV',    module: './phases/phase-04b-fix-prices' },
  '4c': { name: 'Fix Precios USD',          module: './phases/phase-04c-fix-prices-usd' },
  '4d': { name: 'Fix Precios Frontera',     module: './phases/phase-04d-fix-prices-frontera' },
  '4e': { name: 'Fix Precios Guatemala',    module: './phases/phase-04e-fix-prices-guatemala' },
  '4f': { name: 'Fix Precios Colombia',     module: './phases/phase-04f-fix-prices-colombia' },
  5:   { name: 'Clientes/Distribuidores',    module: './phases/phase-05-customers' },
  6:   { name: 'Red MLM',                    module: './phases/phase-06-network' },
  7:   { name: 'Ventas y Documentos',        module: './phases/phase-07-sales' },
  '7b': { name: 'Tipos de Orden/Ecommerce', module: './phases/phase-07b-order-types' },
  8:   { name: 'Facturación',                module: './phases/phase-08-invoicing' },
  9:   { name: 'Comisiones',                 module: './phases/phase-09-commissions' },
  10:  { name: 'Inventario',                 module: './phases/phase-10-inventory' },
  '10b': { name: 'Proveedores',             module: './phases/phase-10b-suppliers' },
  11:  { name: 'Recursos Humanos',           module: './phases/phase-11-hr' },
  12:  { name: 'Comunicación',               module: './phases/phase-12-communication' },
  13:  { name: 'Auditoría y Logs',           module: './phases/phase-13-audit' },
  14:  { name: 'Archivos GCS',               module: './phases/phase-14-gcs-files' },
  99:  { name: 'Post-Migración/Validación',  module: './phases/phase-99-post-migration' },
};

// Orden de ejecución por defecto (todas las fases)
const DEFAULT_ORDER = [0, 1, 2, 3, '3b', 4, '4b', '4c', '4d', '4e', '4f', 5, 6, 7, '7b', 8, 9, 10, '10b', 11, 12, 13, 14, 99];

// =============================================
// Parseo de argumentos
// =============================================
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    phases: [],
    validateOnly: false,
    skipValidation: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--phase' || arg === '-p') {
      const val = args[++i];
      if (val !== undefined) {
        const phaseKey = (val === '10b' || val === '3b' || val === '4b' || val === '4c' || val === '4d' || val === '4e' || val === '4f' || val === '7b') ? val : Number(val);
        if (PHASES[phaseKey]) {
          options.phases.push(phaseKey);
        } else {
          console.error(`Fase desconocida: ${val}`);
          console.error(`Fases válidas: ${Object.keys(PHASES).join(', ')}`);
          process.exit(1);
        }
      }
    } else if (arg === '--validate') {
      options.validateOnly = true;
    } else if (arg === '--skip-validation') {
      options.skipValidation = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║        TonicLife ERP — Migración v1 → v2                ║
╚══════════════════════════════════════════════════════════╝

Uso: node index.js [opciones]

Opciones:
  --phase <N>, -p <N>     Ejecutar solo la fase N (se puede repetir)
  --validate              Solo ejecutar validación post-migración (fase 99)
  --skip-validation       Ejecutar todo excepto fase 99
  --dry-run               Conectar y mostrar plan sin ejecutar
  --help, -h              Mostrar esta ayuda

Ejemplos:
  node index.js                        # Ejecutar todas las fases
  node index.js --phase 1              # Solo fase 1 (catálogos)
  node index.js -p 5 -p 6              # Fases 5 y 6
  node index.js --validate             # Solo validación post-migración
  node index.js --phase 0 --phase 1 --phase 2  # Infraestructura + catálogos + sucursales

Fases disponibles:`);
  for (const [key, phase] of Object.entries(PHASES)) {
    console.log(`  ${String(key).padStart(3)}: ${phase.name}`);
  }
  console.log('');
}

// =============================================
// Ejecución principal
// =============================================
async function main() {
  const options = parseArgs();
  const startTime = Date.now();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     TonicLife ERP — Migración v1 → v2                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Determinar qué fases ejecutar
  let phasesToRun;
  if (options.validateOnly) {
    phasesToRun = [99];
  } else if (options.phases.length > 0) {
    phasesToRun = options.phases;
  } else if (options.skipValidation) {
    phasesToRun = DEFAULT_ORDER.filter(p => p !== 99);
  } else {
    phasesToRun = [...DEFAULT_ORDER];
  }

  logger.info(`Fases a ejecutar: ${phasesToRun.join(', ')}`);
  logger.info(`v1: ${config.v1.host}:${config.v1.port}/${config.v1.database} (schema: ${config.v1.schema})`);
  logger.info(`v2: ${config.v2.host}:${config.v2.port}/${config.v2.database} (schema: ${config.v2.schema})`);
  logger.info(`Batch size: ${config.migration.batchSize}`);
  logger.info(`Log level: ${config.migration.logLevel}`);

  if (options.dryRun) {
    logger.info('\n--- DRY RUN: No se ejecutarán cambios ---');
    logger.info('\nPlan de ejecución:');
    for (const phaseKey of phasesToRun) {
      const phase = PHASES[phaseKey];
      logger.info(`  Fase ${phaseKey}: ${phase.name}`);
    }
    return;
  }

  // =============================================
  // Crear pools de conexión
  // =============================================
  const v1Pool = new Pool({
    host: config.v1.host,
    port: config.v1.port,
    database: config.v1.database,
    user: config.v1.user,
    password: config.v1.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  const v2IsLocal = ['localhost', '127.0.0.1', '::1'].includes(config.v2.host);
  const v2Pool = new Pool({
    host: config.v2.host,
    port: config.v2.port,
    database: config.v2.database,
    user: config.v2.user,
    password: config.v2.password,
    max: 15,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 30000,
    ...(v2IsLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  // =============================================
  // Verificar conectividad
  // =============================================
  logger.info('\nVerificando conexiones...');
  try {
    const v1Client = await v1Pool.connect();
    const v1Version = await v1Client.query('SELECT version()');
    logger.info(`  v1 conectado: ${v1Version.rows[0].version.split(' ').slice(0, 2).join(' ')}`);
    v1Client.release();
  } catch (err) {
    logger.error(`No se pudo conectar a v1: ${err.message}`);
    process.exit(1);
  }

  try {
    const v2Client = await v2Pool.connect();
    const v2Version = await v2Client.query('SELECT version()');
    logger.info(`  v2 conectado: ${v2Version.rows[0].version.split(' ').slice(0, 2).join(' ')}`);
    v2Client.release();
  } catch (err) {
    logger.error(`No se pudo conectar a v2: ${err.message}`);
    await v1Pool.end();
    process.exit(1);
  }

  // =============================================
  // Inicializar GCS (si habilitado)
  // =============================================
  const gcsUploader = require('./utils/gcs-uploader');
  if (config.gcs.enabled) {
    logger.info('\nInicializando Google Cloud Storage...');
    try {
      const ready = await gcsUploader.init();
      if (ready) {
        logger.info(`  GCS configurado: bucket=${config.gcs.bucketName}, concurrency=${config.gcs.concurrency}`);
      } else {
        logger.warn('  GCS no se pudo inicializar. Archivos usarán prefixUrl fallback.');
      }
    } catch (err) {
      logger.warn(`  Error inicializando GCS: ${err.message}. Archivos usarán prefixUrl fallback.`);
    }
  } else {
    logger.info('\nGCS deshabilitado (GCS_ENABLED!=true). Archivos usarán URLs con prefixUrl.');
  }

  // =============================================
  // Ejecutar fases
  // =============================================
  const phaseResults = {};
  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const allErrors = [];

  for (const phaseKey of phasesToRun) {
    const phase = PHASES[phaseKey];
    const phaseStart = Date.now();

    try {
      const phaseFunc = require(phase.module);
      const result = await phaseFunc(v1Pool, v2Pool);

      const phaseDuration = Date.now() - phaseStart;
      phaseResults[phaseKey] = {
        name: phase.name,
        ...result,
        duration: phaseDuration,
      };

      totalMigrated += result.migrated || 0;
      totalSkipped += result.skipped || 0;
      totalFailed += result.failed || 0;
      if (result.errors) allErrors.push(...result.errors);

      logger.info(`  Fase ${phaseKey} completada en ${logger.formatDuration(phaseDuration)}`);
    } catch (err) {
      const phaseDuration = Date.now() - phaseStart;
      logger.error(`\n✗ FASE ${phaseKey} FALLÓ: ${err.message}`);
      logger.error(`  Stack: ${err.stack}`);

      phaseResults[phaseKey] = {
        name: phase.name,
        migrated: 0,
        skipped: 0,
        failed: 0,
        errors: [{ phase: phaseKey, error: err.message }],
        duration: phaseDuration,
        crashed: true,
      };

      allErrors.push({ phase: phaseKey, error: err.message, stack: err.stack });

      // Preguntar si continuar (excepto en modo batch)
      if (!process.stdin.isTTY) {
        logger.error('Abortando migración (no-interactive mode)');
        break;
      }

      // En modo interactivo, continuar con la siguiente fase
      logger.warn(`  Continuando con la siguiente fase...`);
    }
  }

  // =============================================
  // Resumen final
  // =============================================
  const totalDuration = Date.now() - startTime;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                    RESUMEN FINAL                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  logger.info(`Duración total: ${logger.formatDuration(totalDuration)}`);
  logger.info(`Registros migrados: ${totalMigrated.toLocaleString()}`);
  logger.info(`Registros omitidos: ${totalSkipped.toLocaleString()}`);
  logger.info(`Registros fallidos: ${totalFailed.toLocaleString()}`);
  logger.info(`Errores totales: ${allErrors.length}`);
  if (config.gcs.enabled) {
    const gcsStats = gcsUploader.getStats();
    logger.info(`GCS archivos: ${gcsStats.uploaded} subidos, ${gcsStats.alreadyExisted} ya existían, ${gcsStats.failed} fallidos`);
  }
  console.log('');

  // Resumen por fase (en orden de ejecución, no en orden de Object.entries)
  logger.info('Resumen por fase:');
  for (const key of phasesToRun) {
    const result = phaseResults[key];
    if (!result) continue;
    const status = result.crashed ? '✗' : '✓';
    const parts = [];
    if (result.migrated) parts.push(`migrados: ${result.migrated.toLocaleString()}`);
    if (result.skipped) parts.push(`omitidos: ${result.skipped.toLocaleString()}`);
    if (result.failed) parts.push(`fallidos: ${result.failed.toLocaleString()}`);
    parts.push(logger.formatDuration(result.duration));
    logger.info(`  ${status} Fase ${key} (${result.name}): ${parts.join(', ')}`);
  }

  // Errores detallados
  if (allErrors.length > 0) {
    console.log('');
    logger.warn(`Errores detallados (primeros 50):`);
    for (const err of allErrors.slice(0, 50)) {
      logger.warn(`  - ${err.phase ? `[Fase ${err.phase}] ` : ''}${err.table || ''}: ${err.error || err.message || JSON.stringify(err)}`);
    }
    if (allErrors.length > 50) {
      logger.warn(`  ... y ${allErrors.length - 50} errores más`);
    }
  }

  // =============================================
  // Generar reporte
  // =============================================
  try {
    const reportPath = await generateReport({
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
      totalDuration,
      phasesExecuted: phasesToRun,
      phaseResults,
      totals: { migrated: totalMigrated, skipped: totalSkipped, failed: totalFailed },
      errors: allErrors,
      config: {
        v1: `${config.v1.host}:${config.v1.port}/${config.v1.database}`,
        v2: `${config.v2.host}:${config.v2.port}/${config.v2.database}`,
        batchSize: config.migration.batchSize,
      },
    });
    logger.info(`\nReporte guardado en: ${reportPath}`);
  } catch (err) {
    logger.error(`Error generando reporte: ${err.message}`);
  }

  // =============================================
  // Cerrar conexiones
  // =============================================
  logger.info('\nCerrando conexiones...');
  await v1Pool.end();
  await v2Pool.end();
  logger.info('Conexiones cerradas.');

  // Exit code basado en errores
  if (allErrors.length > 0 || totalFailed > 0) {
    logger.warn('\nMigración completada con errores. Revisar reporte.');
    process.exit(1);
  } else {
    logger.info('\nMigración completada exitosamente.');
    process.exit(0);
  }
}

// =============================================
// Entry point
// =============================================
main().catch(err => {
  console.error('\nERROR FATAL:', err.message);
  console.error(err.stack);
  process.exit(2);
});
