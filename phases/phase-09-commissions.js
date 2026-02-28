const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursorBulk, buildMultiRowInsertWithUUID, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, toBoolean } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase09(v1Pool, v2Pool) {
  logger.phase('09', 'Períodos y Comisiones');
  const allResults = [];

  // ==============================================================
  // commission_periods
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
          period_number = EXCLUDED.period_number,
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          status = EXCLUDED.status,
          is_closed = EXCLUDED.is_closed,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          Number(row.id_period),
          cleanTrunc(row.code_period, 10) || String(row.id_period),
          cleanTrunc(row.name_period, 50) || `Periodo ${row.id_period}`,
          row.date_start_period || null,
          row.date_end_period || null,
          status,
          isClosed,
          row.id_period,
        ]
      );
    },
  }));

  // Calentar caché con TODAS las entidades necesarias
  await idResolver.warmUp(v2Pool, [
    { type: 'commission_period', table: 'commission_periods' },
    { type: 'customer', table: 'customers' },
    { type: 'mlm_rank', table: 'mlm_ranks' },
  ]);

  // ==============================================================
  // customer_period_stats — BULK
  // ==============================================================
  logger.table('customer_period_stats', 'Migrando t_customers_period/_v2 → customer_period_stats (BULK)');

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

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: periodStatsQuery,
    tableName: 'customer_period_stats',
    totalCount: statsCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      const customerIds = [...new Set(rows.map(r => r.id_customers).filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      return { periodMap, customerMap };
    },

    transformRow: (row, resolved) => {
      const periodId = resolved.periodMap.get(String(row.id_period));
      const customerId = resolved.customerMap.get(String(row.id_customers));
      if (!periodId || !customerId) return null;

      return {
        period_id: periodId,
        customer_id: customerId,
        legacy_id_period: row.id_period,
        legacy_id_customers: row.id_customers,
        points_personal: toDecimal(row.point_current_customers, 0),
        points_group: toDecimal(row.point_group, 0),
        points_business_mxn: toDecimal(row.point_business_customers, 0),
        points_business_usd: 0,
        is_active: true,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'period_id', 'customer_id',
        'legacy_id_period', 'legacy_id_customers',
        'points_personal', 'points_group',
        'points_business_mxn', 'points_business_usd',
        'is_active',
      ];
      return buildMultiRowInsertWithUUID('tonic.customer_period_stats', columns, rows,
        `ON CONFLICT (period_id, customer_id) DO UPDATE SET
          points_personal = EXCLUDED.points_personal,
          points_group = EXCLUDED.points_group,
          points_business_mxn = EXCLUDED.points_business_mxn,
          points_business_usd = EXCLUDED.points_business_usd,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // ==============================================================
  // rank_history — BULK
  // ==============================================================
  logger.table('rank_history', 'Migrando t_customers_plan_history → rank_history (BULK)');
  const histCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers_plan_history');

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers, id_plan, id_period
      FROM toniclife.t_customers_plan_history ORDER BY id_customers, id_period
    `,
    tableName: 'rank_history',
    totalCount: histCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const customerIds = [...new Set(rows.map(r => r.id_customers).filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      const rankIds = [...new Set(rows.map(r => r.id_plan).filter(Boolean))];
      const rankMap = await idResolver.resolveMany(v2Pool, 'mlm_rank', rankIds, 'mlm_ranks');

      return { customerMap, periodMap, rankMap };
    },

    transformRow: (row, resolved) => {
      const customerId = resolved.customerMap.get(String(row.id_customers));
      const periodId = resolved.periodMap.get(String(row.id_period));
      const toRankId = resolved.rankMap.get(String(row.id_plan));
      if (!customerId || !periodId || !toRankId) return null;

      return {
        customer_id: customerId,
        period_id: periodId,
        previous_rank_id: null,
        rank_id: toRankId,
        change_type: 'initial',
        is_active: true,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'customer_id', 'period_id', 'previous_rank_id', 'rank_id',
        'change_type', 'is_active',
      ];
      return buildMultiRowInsertWithUUID('tonic.rank_history', columns, rows,
        'ON CONFLICT DO NOTHING'
      );
    },
  }));

  // ==============================================================
  // commission_payments — BULK
  // ==============================================================
  logger.table('commission_payments', 'Migrando t_customers_paid → commission_payments (BULK)');
  const paidCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_customers_paid');

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: `
      SELECT id_customers_paid, id_customers, id_period, amount_paid,
             id_type_money, date_pay, created_at
      FROM toniclife.t_customers_paid ORDER BY id_customers_paid
    `,
    tableName: 'commission_payments',
    totalCount: paidCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const customerIds = [...new Set(rows.map(r => r.id_customers).filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      return { customerMap, periodMap };
    },

    transformRow: (row, resolved) => {
      const customerId = resolved.customerMap.get(String(row.id_customers));
      const periodId = resolved.periodMap.get(String(row.id_period));
      if (!customerId || !periodId) return null;

      return {
        customer_id: customerId,
        period_id: periodId,
        amount: toDecimal(row.amount_paid, 0),
        payment_date: row.date_pay || new Date(),
        legacy_id: row.id_customers_paid,
        is_active: true,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'customer_id', 'period_id', 'amount', 'payment_date', 'legacy_id', 'is_active',
      ];
      return buildMultiRowInsertWithUUID('tonic.commission_payments', columns, rows,
        `ON CONFLICT (legacy_id) DO UPDATE SET
          customer_id = EXCLUDED.customer_id,
          period_id = EXCLUDED.period_id,
          amount = EXCLUDED.amount,
          payment_date = EXCLUDED.payment_date,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // ==============================================================
  // commission_calculations — BULK
  // ==============================================================
  logger.table('commission_calculations', 'Migrando t_period_commisions → commission_calculations (BULK)');
  const calcCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_period_commisions');

  allResults.push(await processWithCursorBulk({
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

    resolveBatch: async (rows) => {
      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      const customerIds = [...new Set(rows.map(r => r.id_customers).filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      return { periodMap, customerMap };
    },

    transformRow: (row, resolved) => {
      const periodId = resolved.periodMap.get(String(row.id_period));
      const customerId = resolved.customerMap.get(String(row.id_customers));
      if (!periodId || !customerId) return null;

      return {
        period_id: periodId,
        customer_id: customerId,
        commission_type: 'mlm',
        legacy_id_period: row.id_period,
        legacy_id_customers: row.id_customers,
        subtotal_earnings: toDecimal(row.subtotal_earnings, 0),
        iva_amount: toDecimal(row.iva, 0),
        isr_amount: toDecimal(row.isr, 0),
        total_amount: toDecimal(row.total, 0),
        status: 'calculated',
        is_active: true,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'period_id', 'customer_id', 'commission_type',
        'legacy_id_period', 'legacy_id_customers',
        'subtotal_earnings', 'iva_amount', 'isr_amount', 'total_amount',
        'status', 'is_active',
      ];
      return buildMultiRowInsertWithUUID('tonic.commission_calculations', columns, rows,
        `ON CONFLICT (period_id, customer_id, commission_type) DO UPDATE SET
          subtotal_earnings = EXCLUDED.subtotal_earnings,
          iva_amount = EXCLUDED.iva_amount,
          isr_amount = EXCLUDED.isr_amount,
          total_amount = EXCLUDED.total_amount,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`
      );
    },
  }));

  // ==============================================================
  // commission_details (1.9M) — BULK
  // ==============================================================
  logger.table('commission_details', 'Migrando t_period_commisions_det → commission_details (BULK)');
  const detCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_period_commisions_det');
  logger.info(`    Total: ${detCount.toLocaleString()} registros`);

  // WarmUp commission_calculations para resolver commission_id
  await idResolver.warmUpFromQuery(v2Pool, 'commission_calc',
    `SELECT (period_id || ':' || customer_id)::text AS legacy_id, id
     FROM tonic.commission_calculations`
  );

  allResults.push(await processWithCursorBulk({
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

    resolveBatch: async (rows, v2Client) => {
      const periodIds = [...new Set(rows.map(r => r.id_period).filter(Boolean))];
      const periodMap = await idResolver.resolveMany(v2Pool, 'commission_period', periodIds, 'commission_periods');

      const customerIds = [...new Set([
        ...rows.map(r => r.id_customers_parent),
        ...rows.map(r => r.id_customers),
      ].filter(Boolean))];
      const customerMap = await idResolver.resolveMany(v2Pool, 'customer', customerIds, 'customers');

      // Resolve commission_ids: look up commission_calculations by (period_id, customer_id)
      // Build unique pairs
      const pairsToResolve = new Set();
      for (const row of rows) {
        const pId = periodMap.get(String(row.id_period));
        const cId = customerMap.get(String(row.id_customers_parent));
        if (pId && cId) pairsToResolve.add(`${pId}:${cId}`);
      }

      // Check cache first, query missing ones
      const commissionMap = new Map();
      const uncachedPairs = [];
      for (const pair of pairsToResolve) {
        const cached = idResolver.cache && idResolver.cache.get(`commission_calc:${pair}`);
        if (cached) {
          commissionMap.set(pair, cached);
        } else {
          uncachedPairs.push(pair);
        }
      }

      if (uncachedPairs.length > 0) {
        // Batch lookup
        const periodUuids = [];
        const customerUuids = [];
        for (const pair of uncachedPairs) {
          const [p, c] = pair.split(':');
          periodUuids.push(p);
          customerUuids.push(c);
        }

        // Query in chunks of ~2000 pairs
        const PAIR_CHUNK = 2000;
        for (let i = 0; i < uncachedPairs.length; i += PAIR_CHUNK) {
          const chunkPairs = uncachedPairs.slice(i, i + PAIR_CHUNK);
          const chunkPeriods = periodUuids.slice(i, i + PAIR_CHUNK);
          const chunkCustomers = customerUuids.slice(i, i + PAIR_CHUNK);

          const { rows: calcRows } = await v2Client.query(
            `SELECT id, period_id, customer_id FROM tonic.commission_calculations
             WHERE (period_id, customer_id) IN (${chunkPairs.map((_, idx) =>
               `($${idx * 2 + 1}::uuid, $${idx * 2 + 2}::uuid)`
             ).join(', ')})`,
            chunkPairs.flatMap((_, idx) => [chunkPeriods[idx], chunkCustomers[idx]])
          );

          for (const cr of calcRows) {
            const key = `${cr.period_id}:${cr.customer_id}`;
            commissionMap.set(key, cr.id);
            idResolver.set('commission_calc', key, cr.id);
          }
        }
      }

      return { periodMap, customerMap, commissionMap };
    },

    transformRow: (row, resolved) => {
      const periodId = resolved.periodMap.get(String(row.id_period));
      const customerId = resolved.customerMap.get(String(row.id_customers_parent));
      const sourceCustomerId = resolved.customerMap.get(String(row.id_customers));
      if (!periodId || !customerId || !sourceCustomerId) return null;

      const commissionId = resolved.commissionMap.get(`${periodId}:${customerId}`);
      if (!commissionId) return null;

      return {
        commission_id: commissionId,
        period_id: periodId,
        parent_customer_id: customerId,
        source_customer_id: sourceCustomerId,
        level_number: row.nivel != null ? Number(row.nivel) : 0,
        generation_number: row.generation != null ? Number(row.generation) : null,
        source_points_personal: toDecimal(row.point_current_customers, 0),
        level_percentage: toDecimal(row.percentage_nivel, 0),
        subtotal_earnings: toDecimal(row.subtotal_earnings, 0),
        is_active: true,
      };
    },

    buildInsertSQL: (rows) => {
      const columns = [
        'commission_id', 'period_id', 'parent_customer_id', 'source_customer_id',
        'level_number', 'generation_number',
        'source_points_personal', 'level_percentage', 'subtotal_earnings',
        'is_active',
      ];
      return buildMultiRowInsertWithUUID('tonic.commission_details', columns, rows,
        'ON CONFLICT DO NOTHING'
      );
    },
  }));

  logger.info('\n    OMITIDO: t_period_red (29.8M), t_period_red_roll_over (32M), t_period_first_level (1.9M)');

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
