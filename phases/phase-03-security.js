// ============================================================================
// PHASE 03: Seguridad y Acceso
// ============================================================================
// MODIFICADO 2026-05-19:
//   - SKIP migracion de roles, permissions y role_permissions desde v1
//     (mig 019 ya consolido 94->27 roles; user maneja roles/permisos
//     manualmente desde admin v2).
//   - role_id se asigna asi:
//       * Users con customer_id NOT NULL -> role 'customer'
//       * Resto -> role fallback 'asistente' (usuario reasigna desde admin)
//   - Re-runs no modifican role_id de usuarios existentes (preserva ajustes
//     manuales). Solo INSERTs nuevos toman estos defaults.
//
// Sub-fases mantenidas:
//   - workers (t_worker -> workers)
//   - users (t_users -> users) con role_id lookup directo en v2.tonic.roles
//   - password_hash fix bcrypt -> AES-256-GCM
//   - user_branches (t_users_branch_office -> user_branches)
// ============================================================================

const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { hashPassword, encrypt } = require('../utils/crypto');
const { cleanString } = require('../utils/validators');
const config = require('../config');

const FALLBACK_ROLE_CODE = 'asistente';
const CUSTOMER_ROLE_CODE = 'customer';

async function resolveRoleIdByCode(v2Pool, code) {
  const { rows } = await v2Pool.query(
    'SELECT id FROM tonic.roles WHERE code = $1 LIMIT 1',
    [code]
  );
  return rows.length > 0 ? rows[0].id : null;
}

module.exports = async function phase03(v1Pool, v2Pool) {
  logger.phase('03', 'Seguridad y Acceso (SKIP roles/permissions, solo workers/users/user_branches)');
  const allResults = [];

  // Pre-calentar cache
  await idResolver.warmUp(v2Pool, [
    { type: 'branch', table: 'branches' },
  ]);

  // ============================================================
  // Pre-resolve role IDs desde v2 (NO se insertan; solo lookup).
  // ============================================================
  const customerRoleId = await resolveRoleIdByCode(v2Pool, CUSTOMER_ROLE_CODE);
  const fallbackRoleId = await resolveRoleIdByCode(v2Pool, FALLBACK_ROLE_CODE);

  if (!customerRoleId) {
    logger.error(`  Rol '${CUSTOMER_ROLE_CODE}' no existe en v2. Crear primero desde mig 002/019.`);
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: `Missing role '${CUSTOMER_ROLE_CODE}'` }] };
  }
  if (!fallbackRoleId) {
    logger.error(`  Rol fallback '${FALLBACK_ROLE_CODE}' no existe en v2. Crear primero.`);
    return { migrated: 0, skipped: 0, failed: 0, errors: [{ error: `Missing role '${FALLBACK_ROLE_CODE}'` }] };
  }

  logger.info(`  Rol 'customer' = ${customerRoleId}`);
  logger.info(`  Rol fallback '${FALLBACK_ROLE_CODE}' = ${fallbackRoleId}`);

  // ============================================================
  // workers (t_worker -> workers)
  // ============================================================
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
        ON CONFLICT (employee_number) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          email = EXCLUDED.email,
          auth_machine = EXCLUDED.auth_machine,
          auth_machine_description = EXCLUDED.auth_machine_description,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()
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
      }
    },
  }));

  // ============================================================
  // users (~218K)
  // ON CONFLICT (legacy_id) DO UPDATE: solo username, customer_id, worker_id,
  // status, is_active. NUNCA sobrescribe role_id ni password_hash (preserva
  // ajustes manuales y passwords ya migrados).
  // ============================================================
  logger.table('users', 'Migrando t_users → users');
  const userCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_users');
  logger.info(`    Total registros en t_users: ${userCount.toLocaleString()}`);

  allResults.push(await processWithCursor({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_user, id_profile, username_user, password_user, enabled_user,
                         id_customers, id_worker, last_update_password, recovery_code, recovery_sent_at
                  FROM toniclife.t_users ORDER BY id_user`,
    tableName: 'users',
    totalCount: userCount,
    batchSize: config.migration.batchSize,
    transformAndInsert: async (row, client) => {
      // Si usuario ya existe, ON CONFLICT no escribe password_hash, asi que
      // saltamos el hash costoso y usamos placeholder para satisfacer NOT NULL
      // en el path de INSERT.
      const existsResult = await client.query(
        'SELECT 1 FROM tonic.users WHERE legacy_id = $1 LIMIT 1',
        [row.id_user]
      );
      const alreadyExists = existsResult.rows.length > 0;

      let passwordHash;
      let mustChangePassword = false;

      if (alreadyExists) {
        passwordHash = 'EXISTING_SKIP';
      } else {
        if (row.password_user && row.password_user.trim() !== '') {
          passwordHash = await hashPassword(row.password_user);
        }
        if (!passwordHash) {
          passwordHash = await hashPassword('CHANGE_ME_' + row.id_user);
          mustChangePassword = true;
        }
      }

      // role_id por defecto en INSERTs nuevos:
      //   id_customers presente -> 'customer'
      //   sino                  -> fallback (user reasigna desde admin)
      // NOTA: en UPDATEs (ON CONFLICT), role_id NO se sobrescribe.
      const roleId = row.id_customers ? customerRoleId : fallbackRoleId;

      let customerId = null;
      if (row.id_customers) {
        customerId = await idResolver.resolve(v2Pool, 'customer', row.id_customers, 'customers');
      }

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
          customer_id = EXCLUDED.customer_id,
          worker_id = EXCLUDED.worker_id,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          row.id_user,
          username,
          passwordHash,
          roleId,
          customerId,
          workerId,
          status,
          mustChangePassword,
          row.last_update_password || null,
          cleanString(row.recovery_code),
          row.recovery_sent_at || null,
          row.enabled_user == 1,
        ]
      );
    },
  }));

  // ============================================================
  // Correccion password_hash bcrypt -> AES-256-GCM (idempotente)
  // Solo afecta filas con password_hash LIKE '$2b$%'. Si ya estan en
  // AES-GCM, el WHERE las excluye y el rowCount sera 0.
  // ============================================================
  logger.info('    Corrigiendo password_hash de bcrypt -> AES-256-GCM...');
  const PASS_BATCH = 5000;
  const passData = await v1Pool.query(
    "SELECT id_user, password_user FROM toniclife.t_users WHERE password_user IS NOT NULL AND password_user != '' ORDER BY id_user"
  );
  let passUpdated = 0;
  for (let i = 0; i < passData.rows.length; i += PASS_BATCH) {
    const batch = passData.rows.slice(i, i + PASS_BATCH);
    const v2Client = await v2Pool.connect();
    try {
      await v2Client.query('BEGIN');
      for (const row of batch) {
        const encrypted = encrypt(row.password_user);
        if (encrypted) {
          const result = await v2Client.query(
            `UPDATE tonic.users SET password_hash = $1, updated_at = NOW()
             WHERE legacy_id = $2 AND password_hash LIKE '$2b$%'`,
            [encrypted, row.id_user]
          );
          passUpdated += result.rowCount;
        }
      }
      await v2Client.query('COMMIT');
    } catch (err) {
      try { await v2Client.query('ROLLBACK'); } catch (_) {}
      logger.error(`    Error corrigiendo passwords batch: ${err.message}`);
    } finally {
      v2Client.release();
    }
    logger.progress('password fix', Math.min(i + PASS_BATCH, passData.rows.length), passData.rows.length);
  }
  logger.info(`    password_hash corregidos: ${passUpdated.toLocaleString()}`);

  // ============================================================
  // user_branches (t_users_branch_office -> user_branches)
  // ============================================================
  logger.table('user_branches', 'Migrando t_users_branch_office → user_branches');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_users, id_branch_office, enabled
                  FROM toniclife.t_users_branch_office
                  ORDER BY id_users, id_branch_office`,
    tableName: 'user_branches',
    transformAndInsert: async (row, client) => {
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
         ON CONFLICT ON CONSTRAINT uq_user_branches DO UPDATE SET
           is_active = EXCLUDED.is_active,
           updated_at = NOW()`,
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
