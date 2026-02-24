const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Genera un reporte JSON y un resumen de texto de la migración.
 */
async function generateReport(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportsDir = path.join(__dirname, '..', 'reports');

  // Asegurar que existe el directorio
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // =============================================
  // Reporte JSON completo
  // =============================================
  const jsonPath = path.join(reportsDir, `migration-report-${timestamp}.json`);
  const jsonReport = {
    migration: {
      startTime: data.startTime,
      endTime: data.endTime,
      totalDuration: data.totalDuration,
      totalDurationFormatted: logger.formatDuration(data.totalDuration),
    },
    config: data.config,
    totals: data.totals,
    phases: {},
    errors: data.errors.slice(0, 200), // Limitar errores en reporte
    errorCount: data.errors.length,
  };

  // Detalle por fase (incluir primeros 50 errores por fase con desglose por tabla)
  for (const [key, result] of Object.entries(data.phaseResults)) {
    const phaseErrors = result.errors || [];

    // Desglose de errores por tabla (DISTINCT)
    const errorsByTable = {};
    for (const e of phaseErrors) {
      const tbl = e.table || 'unknown';
      if (!errorsByTable[tbl]) errorsByTable[tbl] = { count: 0, samples: [] };
      errorsByTable[tbl].count++;
      if (errorsByTable[tbl].samples.length < 3) {
        errorsByTable[tbl].samples.push({
          legacyId: e.legacyId,
          error: (e.error || '').substring(0, 300),
        });
      }
    }

    jsonReport.phases[key] = {
      name: result.name,
      migrated: result.migrated || 0,
      skipped: result.skipped || 0,
      failed: result.failed || 0,
      duration: result.duration,
      durationFormatted: logger.formatDuration(result.duration),
      crashed: result.crashed || false,
      validation: result.validation || null,
      errorCount: phaseErrors.length,
      errorsByTable,
    };
  }

  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  // =============================================
  // Reporte de texto legible
  // =============================================
  const txtPath = path.join(reportsDir, `migration-report-${timestamp}.txt`);
  const lines = [];

  lines.push('═'.repeat(70));
  lines.push('    REPORTE DE MIGRACIÓN — TonicLife ERP v1 → v2');
  lines.push('═'.repeat(70));
  lines.push('');
  lines.push(`Inicio:   ${data.startTime}`);
  lines.push(`Fin:      ${data.endTime}`);
  lines.push(`Duración: ${logger.formatDuration(data.totalDuration)}`);
  lines.push('');
  lines.push(`Origen:   ${data.config.v1}`);
  lines.push(`Destino:  ${data.config.v2}`);
  lines.push(`Batch:    ${data.config.batchSize}`);
  lines.push('');
  lines.push('─'.repeat(70));
  lines.push('  TOTALES');
  lines.push('─'.repeat(70));
  lines.push(`  Registros migrados: ${data.totals.migrated.toLocaleString()}`);
  lines.push(`  Registros omitidos: ${data.totals.skipped.toLocaleString()}`);
  lines.push(`  Registros fallidos: ${data.totals.failed.toLocaleString()}`);
  lines.push(`  Errores totales:    ${data.errors.length}`);
  lines.push('');
  lines.push('─'.repeat(70));
  lines.push('  DETALLE POR FASE');
  lines.push('─'.repeat(70));

  for (const [key, result] of Object.entries(data.phaseResults)) {
    const status = result.crashed ? 'FALLÓ' : 'OK';
    lines.push(`  Fase ${String(key).padStart(3)} │ ${(result.name || '').padEnd(30)} │ ${status}`);
    lines.push(`          │ migrados: ${(result.migrated || 0).toLocaleString().padStart(10)} │ omitidos: ${(result.skipped || 0).toLocaleString().padStart(10)} │ fallidos: ${(result.failed || 0).toLocaleString().padStart(8)}`);
    lines.push(`          │ duración: ${logger.formatDuration(result.duration)}`);

    // Si tiene datos de validación (fase 99)
    if (result.validation) {
      lines.push(`          │ validación: ${result.validation.passed ? 'APROBADA' : `${result.validation.issues.length} problemas`}`);
      if (result.validation.issues && result.validation.issues.length > 0) {
        for (const issue of result.validation.issues) {
          lines.push(`          │   ⚠ ${issue}`);
        }
      }
    }
    lines.push('');
  }

  // Errores: desglose por fase y tabla
  if (data.errors.length > 0) {
    lines.push('─'.repeat(70));
    lines.push(`  ERRORES POR FASE Y TABLA (${data.errors.length} total)`);
    lines.push('─'.repeat(70));

    // Agrupar errores por fase → tabla → mensaje
    const byPhase = {};
    for (const err of data.errors) {
      const phaseKey = err.phase || '?';
      const tbl = err.table || 'unknown';
      if (!byPhase[phaseKey]) byPhase[phaseKey] = {};
      if (!byPhase[phaseKey][tbl]) byPhase[phaseKey][tbl] = {};
      const msg = (err.error || err.message || 'unknown').substring(0, 200);
      byPhase[phaseKey][tbl][msg] = (byPhase[phaseKey][tbl][msg] || 0) + 1;
    }

    for (const [phase, tables] of Object.entries(byPhase)) {
      lines.push(`  Fase ${phase}:`);
      for (const [tbl, msgs] of Object.entries(tables)) {
        for (const [msg, cnt] of Object.entries(msgs)) {
          lines.push(`    ${tbl} (${cnt}x): ${msg}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('═'.repeat(70));
  lines.push(`  Generado: ${new Date().toISOString()}`);
  lines.push('═'.repeat(70));

  fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');

  logger.info(`  Reporte JSON: ${jsonPath}`);
  logger.info(`  Reporte TXT:  ${txtPath}`);

  return jsonPath;
}

module.exports = { generateReport };
