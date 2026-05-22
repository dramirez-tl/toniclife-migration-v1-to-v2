const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

/**
 * Phase 16 — Reporte de Compras por Distribuidor, Sucursal y Periodo
 *
 * Genera un CSV con:
 *  - ID del distribuidor
 *  - Nombre del distribuidor
 *  - Sucursal donde compro
 *  - Periodo (mes/ano)
 *  - Total de compra en la moneda de la sucursal (MXN, USD, COP)
 */

module.exports = async function phase16(v1Pool, _v2Pool) {
  logger.phase('16', 'Reporte de Compras por Distribuidor, Sucursal y Periodo');

  let totalProcessed = 0;
  let totalSkipped = 0;
  const errors = [];

  try {
    // ─── Step 1: Query purchases grouped by distributor, branch, period (month) ───
    logger.info('  Step 1: Consultando compras por distribuidor, sucursal y periodo (mes/año)...');

    const { rows } = await v1Pool.query(`
      SELECT
        d.id_customers,
        c.name_customers,
        c.last_name_customers,
        c.last_name_mot_customers,
        bo.id_branch_office,
        bo.name_branch_office,
        CASE bo.id_type_money
          WHEN 1 THEN 'MXN'
          WHEN 2 THEN 'USD'
          WHEN 3 THEN 'COP'
          ELSE 'MXN'
        END AS currency_code,
        EXTRACT(YEAR FROM d.date_doc)::int  AS doc_year,
        EXTRACT(MONTH FROM d.date_doc)::int AS doc_month,
        SUM(dd.qty * dd.price) AS total_purchased
      FROM toniclife.t_document_det dd
      JOIN toniclife.t_document d      ON d.id_document = dd.id_document
      JOIN toniclife.t_branch_office bo ON bo.id_branch_office = d.id_branch_office_origin
      LEFT JOIN toniclife.t_customers c  ON c.id_customers = d.id_customers
      WHERE d.id_type_document IS NULL
        AND (d.anulado IS NULL OR d.anulado = 0)
        AND d.id_customers IS NOT NULL
        AND d.date_doc IS NOT NULL
      GROUP BY
        d.id_customers,
        c.name_customers,
        c.last_name_customers,
        c.last_name_mot_customers,
        bo.id_branch_office,
        bo.name_branch_office,
        bo.id_type_money,
        doc_year,
        doc_month
      ORDER BY
        doc_year DESC,
        doc_month DESC,
        bo.name_branch_office,
        d.id_customers
    `);

    logger.info(`    ${rows.length} registros encontrados`);

    if (rows.length === 0) {
      logger.info('  No hay datos. Nada que reportar.');
      return { migrated: 0, skipped: 0, failed: 0, errors: [] };
    }

    // ─── Step 2: Build report rows ───
    logger.info('  Step 2: Construyendo filas del reporte...');

    const reportRows = [];

    for (const row of rows) {
      try {
        const distribName = [
          row.name_customers,
          row.last_name_customers,
          row.last_name_mot_customers,
        ].filter(Boolean).join(' ');

        const periodLabel = formatPeriod(row.doc_month, row.doc_year);

        reportRows.push({
          id_distribuidor: row.id_customers,
          distribuidor: distribName,
          id_sucursal: row.id_branch_office,
          sucursal: row.name_branch_office || 'SIN SUCURSAL',
          moneda: row.currency_code || 'MXN',
          periodo: periodLabel,
          anio: row.doc_year || '',
          mes: row.doc_month || '',
          total_compra: parseFloat(row.total_purchased || 0).toFixed(2),
        });

        totalProcessed++;
      } catch (err) {
        logger.warn(`    Error procesando fila id_customers=${row.id_customers}: ${err.message}`);
        errors.push({ id_customers: row.id_customers, error: err.message });
        totalSkipped++;
      }
    }

    // ─── Step 3: Generate CSV ───
    logger.info('  Step 3: Generando CSV...');

    const headers = [
      'id_distribuidor', 'distribuidor',
      'id_sucursal', 'sucursal', 'moneda',
      'periodo', 'anio', 'mes',
      'total_compra',
    ];

    const csvLines = [headers.join(',')];

    for (const row of reportRows) {
      const line = headers.map(h => {
        const val = (row[h] ?? '').toString().replace(/"/g, '""');
        return `"${val}"`;
      });
      csvLines.push(line.join(','));
    }

    const reportsDir = path.join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    const csvPath = path.join(reportsDir, `branch-purchases-report-${timestamp}.csv`);
    fs.writeFileSync(csvPath, '\uFEFF' + csvLines.join('\n'), 'utf8'); // BOM for Excel

    logger.info(`    CSV generado: ${csvPath}`);
    logger.info(`    ${reportRows.length} filas generadas`);

    // ─── Step 4: Print summary ───
    logger.info('  Step 4: Resumen por sucursal y moneda...');

    const summary = {};
    for (const row of reportRows) {
      const key = `${row.sucursal} (${row.moneda})`;
      if (!summary[key]) {
        summary[key] = { count: 0, total: 0 };
      }
      summary[key].count++;
      summary[key].total += parseFloat(row.total_compra);
    }

    for (const [key, data] of Object.entries(summary).sort((a, b) => b[1].total - a[1].total)) {
      logger.info(`    ${key}: ${data.count} registros, Total: $${data.total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);
    }

  } catch (err) {
    logger.error(`  Error fatal: ${err.message}`);
    errors.push({ error: err.message });
  }

  logger.info(`\n  Phase 16 complete: ${totalProcessed} filas procesadas, ${totalSkipped} omitidas, ${errors.length} errores`);
  return { migrated: totalProcessed, skipped: totalSkipped, failed: errors.length, errors };
};

/**
 * Formats month/year into a human-readable period label (e.g., "Febrero 2026")
 */
function formatPeriod(month, year) {
  if (!month || !year) return 'SIN PERIODO';
  const months = [
    '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  return `${months[month] || month} ${year}`;
}
