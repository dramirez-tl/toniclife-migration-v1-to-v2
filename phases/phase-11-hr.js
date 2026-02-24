const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable } = require('../utils/batch-processor');
const { cleanString, cleanTrunc, toDecimal, validateEnum } = require('../utils/validators');

module.exports = async function phase11(v1Pool, v2Pool) {
  logger.phase('11', 'Recursos Humanos');
  const allResults = [];

  // --- job_positions ---
  logger.table('job_positions', 'Migrando t_job → job_positions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_job, name_job FROM toniclife.t_job ORDER BY id_job',
    tableName: 'job_positions',
    transformAndInsert: async (row, client) => {
      const jobName = cleanString(row.name_job) || `Puesto ${row.id_job}`;
      await client.query(
        `INSERT INTO tonic.job_positions (id, code, name, legacy_id, is_active)
         SELECT gen_random_uuid(), $1, $2, $3, true
         WHERE NOT EXISTS (
           SELECT 1 FROM tonic.job_positions WHERE legacy_id = $3
         )`,
        [`JOB-${row.id_job}`, jobName, row.id_job]
      );
    },
  }));

  // --- departments ---
  logger.table('departments', 'Migrando t_departments → departments');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id, name FROM toniclife.t_departments ORDER BY id',
    tableName: 'departments',
    transformAndInsert: async (row, client) => {
      await client.query(
        `INSERT INTO tonic.departments (id, code, name, legacy_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (legacy_id) DO NOTHING`,
        [`DEPT-${row.id}`, cleanString(row.name) || `Depto ${row.id}`, row.id]
      );
    },
  }));

  // --- work_areas ---
  logger.table('work_areas', 'Migrando t_area → work_areas');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_area, name_area FROM toniclife.t_area ORDER BY id_area',
    tableName: 'work_areas',
    transformAndInsert: async (row, client) => {
      const areaName = cleanString(row.name_area) || `Área ${row.id_area}`;
      await client.query(
        `INSERT INTO tonic.work_areas (id, code, name, legacy_id, is_active)
         SELECT gen_random_uuid(), $1, $2, $3, true
         WHERE NOT EXISTS (
           SELECT 1 FROM tonic.work_areas WHERE legacy_id = $3
         )`,
        [`AREA-${row.id_area}`, areaName, row.id_area]
      );
    },
  }));

  // --- employees (paso 1: sin supervisor_id) ---
  logger.table('employees', 'Migrando t_employees → employees (paso 1: sin supervisor)');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_employee, name_employee, last_name_employee,
                         rfc_employee, curp_employee, contract_date_employee,
                         salary_employee, sdi_imss_employee, imss_employee,
                         salary_type, employer_registration, enabled_employee,
                         zip_code_employee, vacations_totals_days, vacations_used_days,
                         vacations_left_days, journey_worker, id_worker, id_supervisor,
                         is_boss, is_boss_rrhh
                  FROM toniclife.t_employees ORDER BY id_employee`,
    tableName: 'employees',
    transformAndInsert: async (row, client) => {
      // t_employees does NOT have id_department, id_job, id_area, id_branch_office
      const departmentId = null;
      const jobPositionId = null;
      const workAreaId = null;
      const branchId = null;

      // Buscar user_id via workers
      let userId = null;
      if (row.id_worker) {
        const workerUuid = await idResolver.resolve(v2Pool, 'worker', row.id_worker);
        if (workerUuid) {
          const userResult = await client.query(
            'SELECT id FROM tonic.users WHERE worker_id = $1 LIMIT 1',
            [workerUuid]
          );
          if (userResult.rows.length > 0) userId = userResult.rows[0].id;
        }
      }

      const status = validateEnum('employees.status',
        row.enabled_employee == 1 ? 'active' : 'inactive', 'active');

      await client.query(
        `INSERT INTO tonic.employees (
          id, employee_number, first_name, last_name,
          rfc, curp, imss_number, birth_date,
          phone, email, hire_date,
          department_id, job_position_id, work_area_id, branch_id,
          user_id, status, legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = NOW()`,
        [
          cleanTrunc(`EMP-${row.id_employee}`, 20),
          cleanString(row.name_employee) || 'SIN NOMBRE',
          cleanString(row.last_name_employee) || 'SIN APELLIDO',
          cleanString(row.rfc_employee),
          cleanString(row.curp_employee),
          cleanString(row.imss_employee),
          null,                                                    // birth_date — does not exist in v1
          null,                                                    // phone — does not exist in v1
          null,                                                    // email — does not exist in v1
          row.contract_date_employee || new Date(),                // hire_date — mapped from contract_date_employee
          departmentId, jobPositionId, workAreaId, branchId,
          userId, status, row.id_employee,
          status === 'active',
        ]
      );
    },
  }));

  // --- employees paso 2: actualizar supervisor_id ---
  logger.table('employees', 'Actualizando supervisor_id (self-refs)');
  const supervisorData = await v1Pool.query(
    'SELECT id_employee, id_supervisor FROM toniclife.t_employees WHERE id_supervisor IS NOT NULL'
  );
  let supUpdated = 0;
  for (const row of supervisorData.rows) {
    const result = await v2Pool.query(
      `UPDATE tonic.employees SET supervisor_id = (
        SELECT id FROM tonic.employees WHERE legacy_id = $1 LIMIT 1
      ) WHERE legacy_id = $2 AND supervisor_id IS NULL`,
      [row.id_supervisor, row.id_employee]
    );
    supUpdated += result.rowCount;
  }
  logger.info(`    supervisor_id: ${supUpdated} actualizados`);

  // --- holidays ---
  logger.table('holidays', 'Migrando t_holidays → holidays');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_holiday, holiday_date FROM toniclife.t_holidays ORDER BY id_holiday',
    tableName: 'holidays',
    transformAndInsert: async (row, client) => {
      const { rows } = await client.query(
        `INSERT INTO tonic.holidays (id, name, holiday_date, is_active)
         VALUES (gen_random_uuid(), $1, $2, true)
         RETURNING id`,
        [`Día festivo ${row.id_holiday}`, row.holiday_date]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'holiday', row.id_holiday, rows[0].id, 't_holidays');
      }
    },
  }));

  // --- vacation_rules ---
  logger.table('vacation_rules', 'Migrando t_vacation_rules → vacation_rules');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_vacation_rule, years, range_start, range_end, vacation_days FROM toniclife.t_vacation_rules ORDER BY id_vacation_rule',
    tableName: 'vacation_rules',
    transformAndInsert: async (row, client) => {
      const { rows } = await client.query(
        `INSERT INTO tonic.vacation_rules (id, years_of_service_from, years_of_service_to, vacation_days, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, true)
         ON CONFLICT (years_of_service_from, years_of_service_to) DO NOTHING
         RETURNING id`,
        [row.range_start || row.years || 1, row.range_end || row.years || 1, row.vacation_days || 6]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'vacation_rule', row.id_vacation_rule, rows[0].id, 't_vacation_rules');
      }
    },
  }));

  // --- vacation_requests ---
  logger.table('vacation_requests', 'Migrando t_vacation → vacation_requests');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_vacation, id_employee, from_date, to_date, date_created,
                         journey_worker, status_vacation, user_created, user_approved,
                         date_approved, comments, vacation_days, request_comments
                  FROM toniclife.t_vacation ORDER BY id_vacation`,
    tableName: 'vacation_requests',
    transformAndInsert: async (row, client) => {
      const empResult = await client.query(
        'SELECT id FROM tonic.employees WHERE legacy_id = $1 LIMIT 1',
        [row.id_employee]
      );
      if (empResult.rows.length === 0) return 'skipped';

      // Map status_vacation enum values
      const statusMap = { approved: 'approved', pending: 'pending', rejected: 'rejected' };
      const rawStatus = cleanString(row.status_vacation);
      const status = statusMap[rawStatus] || 'pending';

      const { rows } = await client.query(
        `INSERT INTO tonic.vacation_requests (
          id, request_number, employee_id, start_date, end_date,
          total_calendar_days, status, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, true
        )
        RETURNING id`,
        [
          `VAC-${row.id_vacation}`,
          empResult.rows[0].id,
          row.from_date,
          row.to_date,
          row.vacation_days || 1,
          status,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'vacation_request', row.id_vacation, rows[0].id, 't_vacation');
      }
    },
  }));

  // --- vacation_request_dates ---
  logger.table('vacation_request_dates', 'Migrando t_vacation_dates → vacation_request_dates');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_vacation_dates, id_vacation, date FROM toniclife.t_vacation_dates ORDER BY id_vacation_dates',
    tableName: 'vacation_request_dates',
    transformAndInsert: async (row, client) => {
      const requestId = await idResolver.resolve(v2Pool, 'vacation_request', row.id_vacation);
      if (!requestId) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.vacation_request_dates (id, vacation_request_id, vacation_date, is_active)
         VALUES (gen_random_uuid(), $1, $2, true)
         RETURNING id`,
        [requestId, row.date]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'vacation_request_date', row.id_vacation_dates, rows[0].id, 't_vacation_dates');
      }
    },
  }));

  // --- vacation_balances ---
  logger.table('vacation_balances', 'Migrando t_vacation_accrual_log → vacation_balances');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_vacation_accrual_log, id_employee, year, days_accrued, processed_at FROM toniclife.t_vacation_accrual_log ORDER BY id_vacation_accrual_log',
    tableName: 'vacation_balances',
    transformAndInsert: async (row, client) => {
      const empResult = await client.query(
        'SELECT id FROM tonic.employees WHERE legacy_id = $1 LIMIT 1',
        [row.id_employee]
      );
      if (empResult.rows.length === 0) return 'skipped';

      const { rows } = await client.query(
        `INSERT INTO tonic.vacation_balances (
          id, employee_id, period_year, entitled_days, additional_days, used_days, is_active
        ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
        ON CONFLICT (employee_id, period_year) DO NOTHING
        RETURNING id`,
        [
          empResult.rows[0].id,
          row.year || new Date().getFullYear(),
          toDecimal(row.days_accrued, 0),
          0,                                         // additional_days — does not exist in v1
          0,                                         // used_days — does not exist in v1
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'vacation_balance', row.id_vacation_accrual_log, rows[0].id, 't_vacation_accrual_log');
      }
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated; acc.skipped += r.skipped; acc.failed += r.failed; acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 11 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
