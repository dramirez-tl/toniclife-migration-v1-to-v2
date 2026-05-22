const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

/**
 * Phase 15 — Reporte de Bonos por Kits (KPM09 / KPM10)
 *
 * Genera un CSV con:
 *  - Cada venta de kit (documento)
 *  - Sucursal, fecha, comprador
 *  - Bono Patrocinador ($1,000) → nivel 1 (patrocinador directo)
 *  - Bono Reclutamiento Nivel 1 ($350) → nivel 2 (patrocinador del patrocinador)
 *  - Bono Reclutamiento Nivel 2 ($300) → nivel 3 (un nivel más arriba)
 *  - Bono Reclutamiento Nivel 3 ($200) → nivel 4 (un nivel más arriba)
 *
 * De momento se aplica SIN restricciones (no valida 5 calificados, etc.)
 */

const KIT_CODES = ['KPM09', 'KPM10'];

const BONUS_RULES = {
  patrocinador: 1000,      // Bono Patrocinador → nivel 1
  reclutamiento_n1: 350,   // Bono Reclutamiento Nivel 1 → nivel 1
  reclutamiento_n2: 300,   // Bono Reclutamiento Nivel 2 → nivel 2
  reclutamiento_n3: 200,   // Bono Reclutamiento Nivel 3 → nivel 3
};

module.exports = async function phase15(v1Pool, _v2Pool) {
  logger.phase('15', 'Reporte de Bonos por Kits KPM09/KPM10');

  let totalProcessed = 0;
  let totalSkipped = 0;
  const errors = [];

  try {
    // ─── Step 1: Get all kit sales (distinct documents) ───
    logger.info('  Step 1: Buscando ventas de kits KPM09/KPM10...');

    const { rows: kitSales } = await v1Pool.query(`
      SELECT DISTINCT
        d.id_document,
        d.date_doc,
        d.id_customers,
        c.name_customers,
        c.last_name_customers,
        c.last_name_mot_customers,
        c.phone_customers,
        c.email_customers,
        bo.name_branch_office,
        p_pack.key_product AS kit_code,
        p_pack.name_product AS kit_name
      FROM toniclife.t_document_det dd
      JOIN toniclife.t_document d ON d.id_document = dd.id_document
      JOIN toniclife.t_product p_pack ON p_pack.id_product = dd.id_product_pack
      LEFT JOIN toniclife.t_customers c ON c.id_customers = d.id_customers
      LEFT JOIN toniclife.t_branch_office bo ON bo.id_branch_office = d.id_branch_office_origin
      WHERE p_pack.key_product IN ('KPM09', 'KPM10')
        AND d.id_type_document IS NULL
        AND (d.anulado IS NULL OR d.anulado = 0)
      ORDER BY d.date_doc DESC, d.id_document
    `);

    logger.info(`    ${kitSales.length} ventas de kits encontradas`);

    if (kitSales.length === 0) {
      logger.info('  No hay ventas de kits. Nada que reportar.');
      return { migrated: 0, skipped: 0, failed: 0, errors: [] };
    }

    // ─── Step 2: For each sale, get upline chain (levels 1-3) ───
    logger.info('  Step 2: Resolviendo cadena de patrocinadores (niveles 1-3)...');

    const reportRows = [];

    for (const sale of kitSales) {
      try {
        const { rows: uplines } = await v1Pool.query(`
          SELECT
            r.nivel,
            r.id_upline,
            cu.name_customers AS upline_name,
            cu.last_name_customers AS upline_last_name,
            cu.last_name_mot_customers AS upline_last_name_mot,
            cu.phone_customers AS upline_phone,
            cu.email_customers AS upline_email
          FROM toniclife.t_red r
          LEFT JOIN toniclife.t_customers cu ON cu.id_customers = r.id_upline
          WHERE r.id_customers = $1
            AND r.nivel IN (1, 2, 3, 4)
          ORDER BY r.nivel ASC
        `, [sale.id_customers]);

        const uplineByLevel = {};
        for (const u of uplines) {
          uplineByLevel[u.nivel] = u;
        }

        const buyerName = [
          sale.name_customers,
          sale.last_name_customers,
          sale.last_name_mot_customers
        ].filter(Boolean).join(' ');

        const dateStr = sale.date_doc
          ? new Date(sale.date_doc).toISOString().slice(0, 10)
          : '';

        // Row for the buyer (summary)
        const baseRow = {
          id_documento: sale.id_document,
          fecha: dateStr,
          sucursal: sale.name_branch_office || '',
          kit_code: sale.kit_code,
          kit_name: sale.kit_name,
          id_comprador: sale.id_customers,
          comprador: buyerName,
          telefono_comprador: sale.phone_customers || '',
          email_comprador: sale.email_customers || '',
        };

        // Bono Patrocinador → nivel 1 (patrocinador directo del comprador)
        const sponsor = uplineByLevel[1];
        const sponsorName = sponsor
          ? [sponsor.upline_name, sponsor.upline_last_name, sponsor.upline_last_name_mot].filter(Boolean).join(' ')
          : 'SIN PATROCINADOR';

        reportRows.push({
          ...baseRow,
          tipo_bono: 'Bono Patrocinador',
          monto_bono: BONUS_RULES.patrocinador,
          id_beneficiario: sponsor ? sponsor.id_upline : '',
          beneficiario: sponsorName,
          telefono_beneficiario: sponsor ? (sponsor.upline_phone || '') : '',
          email_beneficiario: sponsor ? (sponsor.upline_email || '') : '',
          nivel_red: 1,
        });

        // Bono Reclutamiento Nivel 1 ($350) → nivel 2 (patrocinador del patrocinador)
        const level2 = uplineByLevel[2];
        const level2Name = level2
          ? [level2.upline_name, level2.upline_last_name, level2.upline_last_name_mot].filter(Boolean).join(' ')
          : 'SIN UPLINE NIVEL 2';

        reportRows.push({
          ...baseRow,
          tipo_bono: 'Bono Reclutamiento Nivel 1',
          monto_bono: BONUS_RULES.reclutamiento_n1,
          id_beneficiario: level2 ? level2.id_upline : '',
          beneficiario: level2Name,
          telefono_beneficiario: level2 ? (level2.upline_phone || '') : '',
          email_beneficiario: level2 ? (level2.upline_email || '') : '',
          nivel_red: 2,
        });

        // Bono Reclutamiento Nivel 2 ($300) → nivel 3
        const level3 = uplineByLevel[3];
        const level3Name = level3
          ? [level3.upline_name, level3.upline_last_name, level3.upline_last_name_mot].filter(Boolean).join(' ')
          : 'SIN UPLINE NIVEL 3';

        reportRows.push({
          ...baseRow,
          tipo_bono: 'Bono Reclutamiento Nivel 2',
          monto_bono: BONUS_RULES.reclutamiento_n2,
          id_beneficiario: level3 ? level3.id_upline : '',
          beneficiario: level3Name,
          telefono_beneficiario: level3 ? (level3.upline_phone || '') : '',
          email_beneficiario: level3 ? (level3.upline_email || '') : '',
          nivel_red: 3,
        });

        // Bono Reclutamiento Nivel 3 ($200) → nivel 4
        const level4 = uplineByLevel[4];
        const level4Name = level4
          ? [level4.upline_name, level4.upline_last_name, level4.upline_last_name_mot].filter(Boolean).join(' ')
          : 'SIN UPLINE NIVEL 4';

        reportRows.push({
          ...baseRow,
          tipo_bono: 'Bono Reclutamiento Nivel 3',
          monto_bono: BONUS_RULES.reclutamiento_n3,
          id_beneficiario: level4 ? level4.id_upline : '',
          beneficiario: level4Name,
          telefono_beneficiario: level4 ? (level4.upline_phone || '') : '',
          email_beneficiario: level4 ? (level4.upline_email || '') : '',
          nivel_red: 4,
        });

        totalProcessed++;
      } catch (err) {
        logger.warn(`    Error procesando documento ${sale.id_document}: ${err.message}`);
        errors.push({ id_document: sale.id_document, error: err.message });
        totalSkipped++;
      }
    }

    // ─── Step 3: Generate CSV ───
    logger.info('  Step 3: Generando CSV...');

    const headers = [
      'id_documento', 'fecha', 'sucursal', 'kit_code', 'kit_name',
      'id_comprador', 'comprador', 'telefono_comprador', 'email_comprador',
      'tipo_bono', 'monto_bono',
      'id_beneficiario', 'beneficiario', 'telefono_beneficiario', 'email_beneficiario',
      'nivel_red',
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
    const csvPath = path.join(reportsDir, `kit-bonus-report-${timestamp}.csv`);
    fs.writeFileSync(csvPath, '\uFEFF' + csvLines.join('\n'), 'utf8'); // BOM for Excel

    logger.info(`    CSV generado: ${csvPath}`);
    logger.info(`    ${reportRows.length} líneas de bono generadas`);

    // ─── Step 4: Print summary ───
    logger.info('  Step 4: Resumen por kit y sucursal...');

    const summary = {};
    for (const sale of kitSales) {
      const key = `${sale.kit_code} | ${sale.name_branch_office || 'SIN SUCURSAL'}`;
      summary[key] = (summary[key] || 0) + 1;
    }

    for (const [key, count] of Object.entries(summary)) {
      logger.info(`    ${key}: ${count} kit(s) vendido(s)`);
    }

    const totalBonos = reportRows.reduce((sum, r) => sum + r.monto_bono, 0);
    logger.info(`    Total bonos a pagar: $${totalBonos.toLocaleString('es-MX')} MXN`);

  } catch (err) {
    logger.error(`  Error fatal: ${err.message}`);
    errors.push({ error: err.message });
  }

  logger.info(`\n  Phase 15 complete: ${totalProcessed} ventas procesadas, ${totalSkipped} omitidas, ${errors.length} errores`);
  return { migrated: totalProcessed, skipped: totalSkipped, failed: errors.length, errors };
};
