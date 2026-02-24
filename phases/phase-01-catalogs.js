const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable } = require('../utils/batch-processor');

module.exports = async function phase01(v1Pool, v2Pool) {
  logger.phase('01', 'Catálogos Base');
  const allResults = [];

  // --- countries ---
  logger.table('countries', 'Migrando t_country → countries');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_country ORDER BY id_country',
    tableName: 'countries',
    transformAndInsert: async (row, client) => {
      const { rows } = await client.query(
        `INSERT INTO tonic.countries (id, code, name, phone_code, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [
          (row.code_country || row.abr_country || 'XX').substring(0, 2).toUpperCase(),
          row.name_country || 'Sin nombre',
          row.phone_code_country || null,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'country', row.id_country, rows[0].id, 't_country');
      } else {
        // Ya existía, buscar el id
        const existing = await client.query(
          `SELECT id FROM tonic.countries WHERE code = $1`,
          [(row.code_country || row.abr_country || 'XX').substring(0, 2).toUpperCase()]
        );
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'country', row.id_country, existing.rows[0].id, 't_country');
        }
      }
    },
  }));

  // --- currencies ---
  logger.table('currencies', 'Migrando t_type_money → currencies');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_type_money ORDER BY id_type_money',
    tableName: 'currencies',
    transformAndInsert: async (row, client) => {
      const code = (row.code_type_money || row.abr_type_money || 'XXX').substring(0, 3).toUpperCase();
      const { rows } = await client.query(
        `INSERT INTO tonic.currencies (id, code, name, symbol, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, row.name_type_money || code, row.symbol_type_money || '$']
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'currency', row.id_type_money, rows[0].id, 't_type_money');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.currencies WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'currency', row.id_type_money, existing.rows[0].id, 't_type_money');
        }
      }
    },
  }));

  // --- price_types ---
  logger.table('price_types', 'Migrando t_type_price → price_types');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_type_price ORDER BY id_type_price',
    tableName: 'price_types',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_type_price || row.name_type_price || `TP${row.id_type_price}`).substring(0, 50);
      const { rows } = await client.query(
        `INSERT INTO tonic.price_types (id, code, name, is_active)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, row.name_type_price || code]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'price_type', row.id_type_price, rows[0].id, 't_type_price');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.price_types WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'price_type', row.id_type_price, existing.rows[0].id, 't_type_price');
        }
      }
    },
  }));

  // --- document_types ---
  logger.table('document_types', 'Migrando t_type_document → document_types');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_type_document ORDER BY id_type_document',
    tableName: 'document_types',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_type_document || row.name_type_document || `TD${row.id_type_document}`).substring(0, 20);
      await client.query(
        `INSERT INTO tonic.document_types (id, code, name, category, legacy_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'sales', $3, true)
         ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name`,
        [code, row.name_type_document || code, row.id_type_document]
      );
    },
  }));

  // --- payment_methods ---
  logger.table('payment_methods', 'Migrando t_type_format_pay → payment_methods');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_type_format_pay ORDER BY id_type_format_pay',
    tableName: 'payment_methods',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_type_format_pay || row.name_type_format_pay || `PM${row.id_type_format_pay}`).substring(0, 50);
      const name = row.name_type_format_pay || code;
      // Inferir payment_type del nombre
      const nameLower = name.toLowerCase();
      let paymentType = 'other';
      if (nameLower.includes('efectivo') || nameLower.includes('cash')) paymentType = 'cash';
      else if (nameLower.includes('tarjeta') || nameLower.includes('card') || nameLower.includes('débito') || nameLower.includes('crédito')) paymentType = 'card';
      else if (nameLower.includes('transferencia') || nameLower.includes('depósito') || nameLower.includes('deposito') || nameLower.includes('spei')) paymentType = 'bank_transfer';
      else if (nameLower.includes('cheque')) paymentType = 'check';
      else if (nameLower.includes('puntos') || nameLower.includes('points')) paymentType = 'points';
      else if (nameLower.includes('crédito') || nameLower.includes('credito') || nameLower.includes('credit')) paymentType = 'credit';

      const { rows } = await client.query(
        `INSERT INTO tonic.payment_methods (id, code, name, payment_type, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, name, paymentType]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'payment_method', row.id_type_format_pay, rows[0].id, 't_type_format_pay');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.payment_methods WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'payment_method', row.id_type_format_pay, existing.rows[0].id, 't_type_format_pay');
        }
      }
    },
  }));

  // --- tax_rules ---
  logger.table('tax_rules', 'Migrando t_tax → tax_rules');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_tax ORDER BY id_tax',
    tableName: 'tax_rules',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_tax || row.name_tax || `TAX${row.id_tax}`).substring(0, 50);
      const rate = row.value_tax != null ? parseFloat(row.value_tax) / 100 : 0.16; // v1 stores as percentage, v2 as decimal
      const { rows } = await client.query(
        `INSERT INTO tonic.tax_rules (id, code, name, tax_type, rate, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'iva', $3, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, row.name_tax || code, rate]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'tax_rule', row.id_tax, rows[0].id, 't_tax');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.tax_rules WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'tax_rule', row.id_tax, existing.rows[0].id, 't_tax');
        }
      }
    },
  }));

  // --- dispatch_types ---
  logger.table('dispatch_types', 'Migrando t_dispatch → dispatch_types');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_dispatch ORDER BY id_dispatch',
    tableName: 'dispatch_types',
    transformAndInsert: async (row, client) => {
      const code = (row.abr_dispatch || row.name_dispatch || `D${row.id_dispatch}`).substring(0, 20);
      await client.query(
        `INSERT INTO tonic.dispatch_types (id, code, name, legacy_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name`,
        [code, row.name_dispatch || code, row.id_dispatch]
      );
    },
  }));

  // --- exchange_rates ---
  logger.table('exchange_rates', 'Migrando t_exchange → exchange_rates');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_exchange ORDER BY id_exchange',
    tableName: 'exchange_rates',
    transformAndInsert: async (row, client) => {
      const rate = parseFloat(row.value_exchange || 1);
      const inverseRate = rate > 0 ? 1 / rate : 1;
      const effectiveDate = row.date_exchange || new Date().toISOString().split('T')[0];
      const { rows } = await client.query(
        `INSERT INTO tonic.exchange_rates (id, from_currency_code, to_currency_code, rate, inverse_rate, effective_date, is_active)
         VALUES (gen_random_uuid(), 'USD', 'MXN', $1, $2, $3, true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [rate, inverseRate, effectiveDate]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'exchange_rate', row.id_exchange, rows[0].id, 't_exchange');
      }
    },
  }));

  // --- sat_cfdi_uses ---
  logger.table('sat_cfdi_uses', 'Migrando t_cfdi → sat_cfdi_uses');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_cfdi ORDER BY id_cfdi',
    tableName: 'sat_cfdi_uses',
    transformAndInsert: async (row, client) => {
      const code = (row.code_cfdi || row.id_cfdi || '').toString().substring(0, 10);
      await client.query(
        `INSERT INTO tonic.sat_cfdi_uses (id, code, name, legacy_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name`,
        [code, row.name_cfdi || code, code]
      );
    },
  }));

  // --- sat_tax_regimes ---
  logger.table('sat_tax_regimes', 'Migrando t_regimen → sat_tax_regimes');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_regimen ORDER BY id_regimen',
    tableName: 'sat_tax_regimes',
    transformAndInsert: async (row, client) => {
      const code = (row.code_regimen || row.id_regimen || '').toString().substring(0, 10);
      await client.query(
        `INSERT INTO tonic.sat_tax_regimes (id, code, name, applies_to, legacy_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, 'both', $3, true)
         ON CONFLICT (legacy_id) DO UPDATE SET name = EXCLUDED.name`,
        [code, row.name_regimen || code, row.id_regimen]
      );
    },
  }));

  // Resumen
  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 01 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
