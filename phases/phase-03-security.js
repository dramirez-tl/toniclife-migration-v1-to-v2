const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { hashPassword } = require('../utils/crypto');
const { cleanString } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase03(v1Pool, v2Pool) {
  logger.phase('03', 'Seguridad y Acceso');
  const allResults = [];

  // Pre-calentar caché
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches', column: 'id' },
  ]);

  // --- roles ---
  // v1 t_profile: id_profile, description_profile, enabled_profile, main_profile, request_break_box
  logger.table('roles', 'Migrando t_profile → roles');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT id_profile, description_profile, enabled_profile, main_profile, request_break_box FROM toniclife.t_profile ORDER BY id_profile',
    tableName: 'roles',
    transformAndInsert: async (row, client) => {
      const code = (row.main_profile || row.description_profile || `ROLE${row.id_profile}`)
        .toString().substring(0, 50).toLowerCase().replace(/\s+/g, '_');
      const { rows } = await client.query(
        `INSERT INTO tonic.roles (id, code, name, requires_cash_close, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, COALESCE($4::boolean, true))
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [
          code,
          cleanString(row.description_profile) || code,
          row.request_break_box || false,
          row.enabled_profile != null ? row.enabled_profile == 1 : true,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'role', row.id_profile, rows[0].id, 't_profile');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.roles WHERE code = $1`, [code]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'role', row.id_profile, existing.rows[0].id, 't_profile');
        }
      }
    },
  }));

  // --- permissions ---
  // v1 t_tags_items: id_tags_items_parent_master(char), id_tags_items_parent(char),
  //    id_tags_items(char), description(varchar), a_href(varchar), show(int), enabled(int), icon(varchar), number(bigint)
  // v2 permissions: code(UNIQUE), name, description, module, parent_id, permission_type, icon, route, sort_order
  logger.table('permissions', 'Migrando t_tags_items → permissions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_tags_items_parent_master, id_tags_items_parent, id_tags_items,
                         description, a_href, show, enabled, icon, number
                  FROM toniclife.t_tags_items ORDER BY number, id_tags_items`,
    tableName: 'permissions',
    transformAndInsert: async (row, client) => {
      // id_tags_items es varchar/char, usarlo como code
      const code = (row.id_tags_items || '').toString().trim();
      if (!code) return 'skipped';

      const parentCode = (row.id_tags_items_parent || '').toString().trim();
      const module = (row.id_tags_items_parent_master || '').toString().trim() || 'system';

      // Resolver parent_id buscando el permission ya insertado por code
      let parentId = null;
      if (parentCode && parentCode !== code) {
        const parentResult = await client.query(
          'SELECT id FROM tonic.permissions WHERE code = $1 LIMIT 1',
          [parentCode]
        );
        if (parentResult.rows.length > 0) parentId = parentResult.rows[0].id;
      }

      const permType = parentCode ? 'action' : 'menu';

      const { rows } = await client.query(
        `INSERT INTO tonic.permissions (id, code, name, module, permission_type, parent_id, icon, route, sort_order, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::boolean, true))
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [
          code,
          cleanString(row.description) || code,
          module,
          permType,
          parentId,
          cleanString(row.icon),
          cleanString(row.a_href),
          row.number || 0,
          row.enabled != null ? row.enabled == 1 : true,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'permission', code, rows[0].id, 't_tags_items');
      }
    },
  }));

  // --- role_permissions ---
  // v1 t_tags_items_profile: id_profile(bigint), id_tags_items_parent_master(char),
  //    id_tags_items_parent(char), id_tags_items(char), enabled(int), main(int)
  // NO tiene PK propia — es tabla compuesta
  // v2 role_permissions: UNIQUE(role_id, permission_id)
  logger.table('role_permissions', 'Migrando t_tags_items_profile → role_permissions');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_profile, id_tags_items, enabled
                  FROM toniclife.t_tags_items_profile
                  WHERE enabled = 1
                  ORDER BY id_profile, id_tags_items`,
    tableName: 'role_permissions',
    transformAndInsert: async (row, client) => {
      const roleId = await idResolver.resolve(v2Pool, 'role', row.id_profile);
      if (!roleId) return 'skipped';

      // id_tags_items es varchar → buscar permission por code
      const permCode = (row.id_tags_items || '').toString().trim();
      if (!permCode) return 'skipped';

      const permResult = await client.query(
        'SELECT id FROM tonic.permissions WHERE code = $1 LIMIT 1',
        [permCode]
      );
      if (permResult.rows.length === 0) return 'skipped';
      const permissionId = permResult.rows[0].id;

      await client.query(
        `INSERT INTO tonic.role_permissions (id, role_id, permission_id, granted)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT ON CONSTRAINT uq_role_permissions DO NOTHING`,
        [roleId, permissionId]
      );
    },
  }));

  // También migrar acciones de t_tags_items_profile_action
  // v1: id_tags_items_parent_master(varchar), id_tags_items_parent(varchar),
  //     id_tags_items(varchar), id_action(bigint), id_profile(bigint), enabled(bigint)
  logger.table('role_permissions', 'Migrando t_tags_items_profile_action → role_permissions (acciones)');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_profile, id_tags_items, id_action, enabled
                  FROM toniclife.t_tags_items_profile_action
                  WHERE enabled = 1
                  ORDER BY id_profile, id_tags_items`,
    tableName: 'role_permissions',
    transformAndInsert: async (row, client) => {
      const roleId = await idResolver.resolve(v2Pool, 'role', row.id_profile);
      if (!roleId) return 'skipped';

      const permCode = (row.id_tags_items || '').toString().trim();
      if (!permCode) return 'skipped';

      const permResult = await client.query(
        'SELECT id FROM tonic.permissions WHERE code = $1 LIMIT 1',
        [permCode]
      );
      if (permResult.rows.length === 0) return 'skipped';
      const permissionId = permResult.rows[0].id;

      await client.query(
        `INSERT INTO tonic.role_permissions (id, role_id, permission_id, granted)
         VALUES (gen_random_uuid(), $1, $2, true)
         ON CONFLICT ON CONSTRAINT uq_role_permissions DO NOTHING`,
        [roleId, permissionId]
      );
    },
  }));

  // --- workers ---
  // v1 t_worker: id_worker, name_worker, last_name_worker, email_worker, id_job, enabled_worker, auth_machine, auth_machine_description
  // v2 workers: employee_number(UNIQUE), first_name(NOT NULL), last_name(NOT NULL), email, phone, job_title, department, auth_machine, auth_machine_description
  logger.table('workers', 'Migrando t_worker → workers');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_worker, name_worker, last_name_worker, email_worker,
                         id_job, enabled_worker, auth_machine, auth_machine_description
                  FROM toniclife.t_worker ORDER BY id_worker`,
    tableName: 'workers',
    transformAndInsert: async (row, client) => {
      const empNumber = `WRK-${row.id_worker}`;
      const firstName = cleanString(row.name_worker) || 'SIN NOMBRE';
      const lastName = cleanString(row.last_name_worker) || 'SIN APELLIDO';

      const { rows } = await client.query(
        `INSERT INTO tonic.workers (
          id, employee_number, first_name, last_name, email,
          auth_machine, auth_machine_description, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, COALESCE($7::boolean, true)
        )
        ON CONFLICT (employee_number) DO NOTHING
        RETURNING id`,
        [
          empNumber,
          firstName,
          lastName,
          cleanString(row.email_worker),
          row.auth_machine || false,
          cleanString(row.auth_machine_description),
          row.enabled_worker != null ? row.enabled_worker == 1 : true,
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'worker', row.id_worker, rows[0].id, 't_worker');
      } else {
        const existing = await client.query(`SELECT id FROM tonic.workers WHERE employee_number = $1`, [empNumber]);
        if (existing.rows.length > 0) {
          await idResolver.registerMapping(v2Pool, 'worker', row.id_worker, existing.rows[0].id, 't_worker');
        }
      }
    },
  }));

  // --- users (tabla grande: ~218K) ---
  // v1 t_users: id_user, id_profile, username_user, password_user, enabled_user,
  //    id_customers, id_worker, last_update_password, recovery_code, recovery_sent_at
  // v2 users: legacy_id(UNIQUE), username(UNIQUE), email(UNIQUE), password_hash(NOT NULL), role_id(NOT NULL)
  logger.table('users', 'Migrando t_users → users');
  const userCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_users');
  logger.info(`    Total registros en t_users: ${userCount.toLocaleString()}`);

  // Necesitamos un role_id default para usuarios sin profile
  let defaultRoleId = await idResolver.resolve(v2Pool, 'role', 5); // profile 5 suele ser distribuidor
  if (!defaultRoleId) {
    const { rows } = await v2Pool.query('SELECT id FROM tonic.roles LIMIT 1');
    defaultRoleId = rows.length > 0 ? rows[0].id : null;
  }

  if (!defaultRoleId) {
    logger.error('  No hay roles en v2. No se puede migrar usuarios.');
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: 'No roles found in v2' }] };
  }

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_user, id_profile, username_user, password_user, enabled_user,
                         id_customers, id_worker, last_update_password, recovery_code, recovery_sent_at
                  FROM toniclife.t_users ORDER BY id_user`,
    tableName: 'users',
    totalCount: userCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // Hashear contraseña con bcrypt (compatible con NestJS bcrypt.compare)
      let passwordHash = null;
      let mustChangePassword = false;
      if (row.password_user && row.password_user.trim() !== '') {
        passwordHash = await hashPassword(row.password_user);
      }
      if (!passwordHash) {
        passwordHash = await hashPassword('CHANGE_ME_' + row.id_user);
        mustChangePassword = true;
      }

      // Resolver role_id
      const roleId = await idResolver.resolve(v2Pool, 'role', row.id_profile) || defaultRoleId;

      // Resolver customer_id
      let customerId = null;
      if (row.id_customers) {
        customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      }

      // Resolver worker_id
      let workerId = null;
      if (row.id_worker) {
        workerId = await idResolver.resolve(v2Pool, 'worker', row.id_worker);
      }

      const status = row.enabled_user == 1 ? 'active' : 'inactive';
      const username = cleanString(row.username_user) || String(row.id_user);

      await client.query(
        `INSERT INTO tonic.users (
          id, legacy_id, username, password_hash, role_id,
          customer_id, worker_id, status, is_migrated_user,
          must_change_password, password_changed_at,
          recovery_token, recovery_token_expires_at,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, true,
          $8, $9,
          $10, $11,
          $12
        )
        ON CONFLICT (legacy_id) DO UPDATE SET
          username = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          role_id = EXCLUDED.role_id,
          customer_id = EXCLUDED.customer_id,
          worker_id = EXCLUDED.worker_id,
          status = EXCLUDED.status,
          email = NULL,
          email_verified_at = NULL,
          updated_at = NOW()`,
        [
          row.id_user,                                      // $1
          username,                                          // $2
          passwordHash,                                      // $3
          roleId,                                            // $4
          customerId,                                        // $5
          workerId,                                           // $6
          status,                                            // $7
          mustChangePassword,                                // $8
          row.last_update_password || null,                   // $9
          cleanString(row.recovery_code),                    // $10
          row.recovery_sent_at || null,                      // $11
          row.enabled_user == 1,                             // $12
        ]
      );
    },
  }));

  // --- user_branches ---
  // v1 t_users_branch_office: id_users(bigint), id_branch_office(bigint), enabled(bigint)
  // NO tiene PK propia — tabla compuesta
  // v2 user_branches: UNIQUE(user_id, branch_id)
  logger.table('user_branches', 'Migrando t_users_branch_office → user_branches');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_users, id_branch_office, enabled
                  FROM toniclife.t_users_branch_office
                  ORDER BY id_users, id_branch_office`,
    tableName: 'user_branches',
    transformAndInsert: async (row, client) => {
      // Resolver user_id via users.legacy_id (que es id_user de t_users)
      const userResult = await client.query(
        'SELECT id FROM tonic.users WHERE legacy_id = $1 LIMIT 1',
        [row.id_users]
      );
      const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;
      const branchId = await idResolver.resolve(v2Pool, 'branch', row.id_branch_office);

      if (!userId || !branchId) return 'skipped';

      await client.query(
        `INSERT INTO tonic.user_branches (id, user_id, branch_id, is_default, is_active)
         VALUES (gen_random_uuid(), $1, $2, false, COALESCE($3::boolean, true))
         ON CONFLICT ON CONSTRAINT uq_user_branches DO NOTHING`,
        [userId, branchId, row.enabled != null ? row.enabled == 1 : true]
      );
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated;
    acc.skipped += r.skipped;
    acc.failed += r.failed;
    acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 03 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
