const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, toBoolean } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase09(v1Pool, v2Pool) {
  logger.phase('09', 'Períodos y Comisiones');
  const allResults = [];

  // ==============================================================
  // commission_periods
  // v1 t_period: id_period(PK), date_start_period, date_end_period,
  //   name_period, code_period, finish_period(bool), user_created,
  //   created_at, user_updated, updated_at, customers_paid(bool),
  //   last_id_red, last_id_red_roll_over, paridad_dolar_mxn,
  //   paridad_mxn_dolar, last_id_customers, cron_period, paridad_gua
  // v2: id, period_number, name, start_date, end_date,
  //   status, is_closed, legacy_id, is_active
  // ==============================================================
  logger.table('commission_periods', 'Migrando t_period → commission_periods');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_period, date_start_period, date_end_period,
             name_period, code_period, finish_period,
             created_at, updated_at
      FROM toniclife.t_period ORDER BY id_period
    `,
    tableName: 'commission_periods',
    transformAndInsert: async (row, client) => {
      const isClosed = toBoolean(row.finish_period);
      const status = isClosed ? 'closed' : 'open';
      await client.query(
        `INSERT INTO tonic.commission_periods (
          id, period_number, code, name, start_date, end_date,
          status, is_closed, legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, true
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          status = EXCLUDED.status,
          is_closed = EXCLUDED.is_closed,
          updated_at = NOW()`,
        [
          Number(row.id_period),                                       // period_number — INTEGER, use PK
          cleanTrunc(row.code_period, 10) || String(row.id_period),     // code — VARCHAR(10)
          cleanTrunc(row.name_period, 50) || `Periodo ${row.id_period}`, // name — VARCHAR(50)
          row.date_start_period || null,
          row.date_end_period || null,
          status,
          isClosed,
          row.id_period,
        ]
      );
    },
  }));

  // Calentar caché con períodos recién migrados
  await idResolver.warmUp(v2Pool, [
    { type: 'commission_period', table: 'commission_periods', column: 'legacy_id' },
  ]);

  // ==============================================================
  // customer_period_stats
  // v1 t_customers_period_v2 (PK composite: id_period, id_customers):
  //   id_period, id_customers, point_current_customers, point_business_customers,
  //   point_business_usa, id_plan, point_group, point_roll_over,
  //   qty_inactive_2_months, qty_red, qty_red_buy_not_3300, kit
  // v1 t_customers_period: same structure (fallback)
  // v2: id, period_id, customer_id, legacy_id_period, legacy_id_customers,
  //   points_personal, points_group, points_total,
  //   business_volume_personal, business_volume_group, is_active
  // ==============================================================
  logger.table('customer_period_stats', 'Migrando t_customers_period/_v2 → customer_period_stats');

  // Intentar primero t_customers_period_v2, luego t_customers_period
  let periodStatsQuery = `
    SELECT id_period, id_customers, point_current_customers,
           point_business_customers, point_business_usa, id_plan,
           point_group, point_roll_over, qty_inactive_2_months,
           qty_red, qty_red_buy_not_3300, kit
    FROM toniclife.t_customers_period_v2 ORDER BY id_period, id_customers
  `;
  let periodStatsCountQuery = 'SELECT COUNT(*) AS count FROM toniclife.t_customers_period_v2';
  let useV2 = true;

  try {
    await v1Pool.query('SELECT 1 FROM toniclife.t_customers_period_v2 LIMIT 1');
  } catch {
    useV2 = false;
    periodStatsQuery = `
      SELECT id_period, id_customers, point_current_customers,
             point_business_customers, point_business_usa, id_plan,
             point_group, point_roll_over, qty_inactive_2_months,
             qty_red, qty_red_buy_not_3300, kit
      FROM toniclife.t_customers_period ORDER BY id_period, id_customers
    `;
    periodStatsCountQuery = 'SELECT COUNT(*) AS count FROM toniclife.t_customers_period';
  }

  const statsCount = await getCount(v1Pool, periodStatsCountQuery);
  logger.info(`    Usando ${useV2 ? 't_customers_period_v2' : 't_customers_period'}: ${statsCount.toLocaleString()} registros`);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: periodStatsQuery,
    tableName: 'customer_period_stats',
    totalCount: statsCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const idPeriod = row.id_period;
      const idCustomers = row.id_customers;
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', idPeriod, 'commission_periods');
      const customerId = await idResolver.resolve(v2Pool, 'customer', idCustomers, 'customers');
      if (!periodId || !customerId) return 'skipped';

      const pointsPersonal = toDecimal(row.point_current_customers, 0);
      const pointsGroup = toDecimal(row.point_group, 0);

      await client.query(
        `INSERT INTO tonic.customer_period_stats (
          id, period_id, customer_id,
          legacy_id_period, legacy_id_customers,
          points_personal, points_group,
          points_business_mxn, points_business_usd,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2,
          $3, $4,
          $5, $6,
          $7, $8,
          true
        )
        ON CONFLICT (period_id, customer_id) DO UPDATE SET
          points_personal = EXCLUDED.points_personal,
          updated_at = NOW()`,
        [
          periodId, customerId,
          idPeriod, idCustomers,
          pointsPersonal,
          pointsGroup,
          toDecimal(row.point_business_customers, 0),
          0, // points_business_usd does not exist in v1
        ]
      );
    },
  }));

  // ==============================================================
  // rank_history
  // v1 t_customers_plan_history (PK: id_customers only!):
  //   id_customers, id_plan, id_period — ONLY 3 COLUMNS
  //   No id_plan_from, no created_at
  // v2: id, customer_id, period_id, from_rank_id, to_rank_id,
  //   change_date, is_active
  // ==============================================================
  logger.table('rank_history', 'Migrando t_customers_plan_history → rank_history');
  const histCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers_plan_history');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers, id_plan, id_period
      FROM toniclife.t_customers_plan_history ORDER BY id_customers, id_period
    `,
    tableName: 'rank_history',
    totalCount: histCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', row.id_period, 'commission_periods');
      const toRankId = await idResolver.resolve(v2Pool, 'mlm_rank', row.id_plan, 'mlm_ranks');
      if (!customerId || !periodId) return 'skipped';
      if (!toRankId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.rank_history (
          id, customer_id, period_id, previous_rank_id, rank_id,
          change_type, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          'initial', true
        )
        ON CONFLICT DO NOTHING`,
        [
          customerId,
          periodId,
          null,   // previous_rank_id: v1 has no "from" rank
          toRankId,
        ]
      );
    },
  }));

  // ==============================================================
  // commission_payments
  // v1 t_customers_paid (PK: id_customers_paid):
  //   id_customers_paid, id_customers, id_period, amount_paid,
  //   id_type_money, date_pay, created_at
  // v2: id, customer_id, period_id, amount, legacy_id, is_active
  // ==============================================================
  logger.table('commission_payments', 'Migrando t_customers_paid → commission_payments');
  const paidCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers_paid');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers_paid, id_customers, id_period, amount_paid,
             id_type_money, date_pay, created_at
      FROM toniclife.t_customers_paid ORDER BY id_customers_paid
    `,
    tableName: 'commission_payments',
    totalCount: paidCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', row.id_period, 'commission_periods');
      if (!customerId || !periodId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.commission_payments (
          id, customer_id, period_id, amount, payment_date, legacy_id, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
        ON CONFLICT (legacy_id) DO NOTHING`,
        [customerId, periodId, toDecimal(row.amount_paid, 0), row.date_pay || new Date(), row.id_customers_paid]
      );
    },
  }));

  // ==============================================================
  // commission_calculations
  // v1 t_period_commisions (PK composite: id_period, id_customers):
  //   id_period, id_customers, point_current_customers, point_business_customers,
  //   name_period, name_plan, key_branch_office, full_name,
  //   subtotal_earnings, code_money, type_fee, isr, iva, ret_iva, resico,
  //   total, facturama_response, facturama_id, facturama_folio_id,
  //   facturama_error, change_total, subtotal_changed, isr_changed,
  //   total_changed, facturama_date, new_subtotal_earnings, new_isr,
  //   new_iva, new_ret_iva, new_resico, new_total, facturama_response_upt,
  //   facturama_id_upt, facturama_folio_upt, facturama_error_upt,
  //   facturama_date_upt, facturama_anulado
  // v2: id, period_id, customer_id, commission_type,
  //   legacy_id_period, legacy_id_customers,
  //   gross_amount, tax_amount, retention_amount, net_amount,
  //   status, is_active
  // ==============================================================
  logger.table('commission_calculations', 'Migrando t_period_commisions → commission_calculations');
  const calcCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_period_commisions');

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_period, id_customers, point_current_customers,
             point_business_customers, name_period, name_plan,
             key_branch_office, full_name,
             subtotal_earnings, code_money, type_fee,
             isr, iva, ret_iva, resico, total,
             facturama_anulado
      FROM toniclife.t_period_commisions ORDER BY id_period, id_customers
    `,
    tableName: 'commission_calculations',
    totalCount: calcCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', row.id_period, 'commission_periods');
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!periodId || !customerId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.commission_calculations (
          id, period_id, customer_id, commission_type,
          legacy_id_period, legacy_id_customers,
          subtotal_earnings, iva_amount, isr_amount, total_amount,
          status, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, 'mlm',
          $3, $4,
          $5, $6, $7, $8,
          'calculated', true
        )
        ON CONFLICT (period_id, customer_id, commission_type) DO UPDATE SET
          subtotal_earnings = EXCLUDED.subtotal_earnings,
          updated_at = NOW()`,
        [
          periodId, customerId,
          row.id_period, row.id_customers,
          toDecimal(row.subtotal_earnings, 0),
          toDecimal(row.iva, 0),
          toDecimal(row.isr, 0),
          toDecimal(row.total, 0),
        ]
      );
    },
  }));

  // ==============================================================
  // commission_details (1.9M)
  // v1 t_period_commisions_det (NO PK! No id column):
  //   id_period, id_customers_parent, id_customers, code_money,
  //   full_name, generation, generation_max, id_plan, id_type_money,
  //   name_plan, nivel, nivel_max, percentage_generation,
  //   percentage_nivel, point_business_customers, point_current_customers,
  //   subtotal_earnings, has_exchange
  // v2: id, period_id, customer_id (the earner), source_customer_id (the source),
  //   level_number, generation_number, points, percentage, amount, is_active
  // NOTE: id_customers_parent = who earns the commission (maps to customer_id)
  //       id_customers = whose sales generate the commission (maps to source_customer_id)
  // ==============================================================
  logger.table('commission_details', 'Migrando t_period_commisions_det → commission_details');
  const detCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_period_commisions_det');
  logger.info(`    Total: ${detCount.toLocaleString()} registros`);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_period, id_customers_parent, id_customers, code_money,
             full_name, generation, generation_max, id_plan, id_type_money,
             name_plan, nivel, nivel_max, percentage_generation,
             percentage_nivel, point_business_customers, point_current_customers,
             subtotal_earnings, has_exchange
      FROM toniclife.t_period_commisions_det ORDER BY id_period, id_customers_parent, id_customers
    `,
    tableName: 'commission_details',
    totalCount: detCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      const periodId = await idResolver.resolve(v2Pool, 'commission_period', row.id_period, 'commission_periods');
      // id_customers_parent is the earner (maps to customer_id in v2)
      const customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers_parent, 'customers');
      // id_customers is the source whose sales generate commission
      const sourceCustomerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      if (!periodId || !customerId) return 'skipped';
      if (!sourceCustomerId) return 'skipped'; // source_customer_id is NOT NULL

      // Look up the matching commission_calculations row to get commission_id
      const commResult = await client.query(
        `SELECT id FROM tonic.commission_calculations
         WHERE period_id = $1 AND customer_id = $2 LIMIT 1`,
        [periodId, customerId]
      );
      if (commResult.rows.length === 0) return 'skipped';
      const commissionId = commResult.rows[0].id;

      // No unique PK in v1 — use NOT EXISTS for idempotency instead of registerMapping
      const exists = await client.query(
        `SELECT 1 FROM tonic.commission_details
         WHERE period_id = $1 AND parent_customer_id = $2
           AND source_customer_id IS NOT DISTINCT FROM $3
           AND level_number IS NOT DISTINCT FROM $4
           AND generation_number IS NOT DISTINCT FROM $5
         LIMIT 1`,
        [
          periodId,
          customerId,
          sourceCustomerId,
          row.nivel != null ? Number(row.nivel) : 0,
          row.generation != null ? Number(row.generation) : null,
        ]
      );
      if (exists.rows.length > 0) return 'skipped';

      await client.query(
        `INSERT INTO tonic.commission_details (
          id, commission_id, period_id, parent_customer_id, source_customer_id,
          level_number, generation_number,
          source_points_personal, level_percentage, subtotal_earnings,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6,
          $7, $8, $9,
          true
        )`,
        [
          commissionId, periodId, customerId, sourceCustomerId,
          row.nivel != null ? Number(row.nivel) : 0,
          row.generation != null ? Number(row.generation) : null,
          toDecimal(row.point_current_customers, 0),
          toDecimal(row.percentage_nivel, 0),
          toDecimal(row.subtotal_earnings, 0),
        ]
      );
    },
  }));

  // --- NOTA: t_period_red, t_period_red_roll_over, t_period_first_level se OMITEN ---
  logger.info('\n    OMITIDO: t_period_red (29.8M), t_period_red_roll_over (32M), t_period_first_level (1.9M)');
  logger.info('    → Se migrarán como fase separada posterior');

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 09 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
