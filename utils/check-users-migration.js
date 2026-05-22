// READ-ONLY diagnostic: compara conteos v1 (origen) vs v2 (destino) para la
// migracion de usuarios (Fase 3). NO modifica nada. Solo SELECT COUNT/MIN/MAX.
const { Pool } = require('pg');
const config = require('../config');

(async () => {
  const v1Pool = new Pool({
    host: config.v1.host, port: config.v1.port, database: config.v1.database,
    user: config.v1.user, password: config.v1.password,
    max: 3, connectionTimeoutMillis: 15000,
  });
  const v2IsLocal = ['localhost', '127.0.0.1', '::1'].includes(config.v2.host);
  const v2Pool = new Pool({
    host: config.v2.host, port: config.v2.port, database: config.v2.database,
    user: config.v2.user, password: config.v2.password,
    max: 3, connectionTimeoutMillis: 30000,
    ...(v2IsLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  });

  const q = async (pool, sql) => (await pool.query(sql)).rows[0];

  try {
    console.log('Conectando...');
    console.log('v1:', config.v1.host, '/', config.v1.database, '(schema', config.v1.schema + ')');
    console.log('v2:', config.v2.host, '/', config.v2.database, '(schema', config.v2.schema + ')');
    console.log('');

    // ---- ORIGEN v1 ----
    const v1u = await q(v1Pool, 'SELECT count(*)::int AS c, min(id_user)::int AS mn, max(id_user)::int AS mx FROM toniclife.t_users');
    const v1w = await q(v1Pool, 'SELECT count(*)::int AS c FROM toniclife.t_worker');
    const v1ub = await q(v1Pool, 'SELECT count(*)::int AS c FROM toniclife.t_users_branch_office');
    const v1upwd = await q(v1Pool, "SELECT count(*)::int AS c FROM toniclife.t_users WHERE password_user IS NOT NULL AND password_user != ''");

    // ---- DESTINO v2 ----
    const v2u = await q(v2Pool, 'SELECT count(*)::int AS c, min(legacy_id)::int AS mn, max(legacy_id)::int AS mx FROM tonic.users');
    const v2umig = await q(v2Pool, 'SELECT count(*)::int AS c FROM tonic.users WHERE is_migrated_user = true');
    const v2uleg = await q(v2Pool, 'SELECT count(*)::int AS c FROM tonic.users WHERE legacy_id IS NOT NULL');
    const v2w = await q(v2Pool, 'SELECT count(*)::int AS c FROM tonic.workers');
    const v2ub = await q(v2Pool, 'SELECT count(*)::int AS c FROM tonic.user_branches');
    const v2bcrypt = await q(v2Pool, "SELECT count(*)::int AS c FROM tonic.users WHERE password_hash LIKE '$2b$%'");
    const v2mustchg = await q(v2Pool, 'SELECT count(*)::int AS c FROM tonic.users WHERE must_change_password = true');
    const v2placeholder = await q(v2Pool, "SELECT count(*)::int AS c FROM tonic.users WHERE password_hash = 'EXISTING_SKIP'");

    console.log('==================== USERS (t_users -> users) ====================');
    console.log('  v1 t_users:        ', v1u.c, ' (id_user', v1u.mn, '->', v1u.mx + ')');
    console.log('  v2 users TOTAL:    ', v2u.c, ' (legacy_id', v2u.mn, '->', v2u.mx + ')');
    console.log('  v2 users migrated: ', v2umig.c, '(is_migrated_user=true)');
    console.log('  v2 users w/legacy: ', v2uleg.c, '(legacy_id NOT NULL)');
    console.log('  >> faltan por migrar (v1 - v2_legacy):', v1u.c - v2uleg.c);
    console.log('');
    console.log('==================== PASSWORDS ====================');
    console.log('  v1 users con password:        ', v1upwd.c);
    console.log('  v2 password aun en bcrypt $2b$:', v2bcrypt.c, '(>0 = fix de password incompleto)');
    console.log('  v2 must_change_password=true: ', v2mustchg.c);
    console.log('  v2 password_hash=EXISTING_SKIP:', v2placeholder.c, '(>0 = INSERT roto, no debe quedar)');
    console.log('');
    console.log('==================== WORKERS ====================');
    console.log('  v1 t_worker:', v1w.c, '  v2 workers:', v2w.c, '  diff:', v1w.c - v2w.c);
    console.log('');
    console.log('==================== USER_BRANCHES ====================');
    console.log('  v1 t_users_branch_office:', v1ub.c, '  v2 user_branches:', v2ub.c);
    console.log('');

    // Veredicto rapido
    const usersDiff = v1u.c - v2uleg.c;
    console.log('==================== VEREDICTO ====================');
    if (usersDiff <= 0 && v2bcrypt.c === 0 && v2placeholder.c === 0) {
      console.log('  OK: usuarios migrados completos y passwords convertidos a AES-GCM.');
    } else {
      if (usersDiff > 0) console.log('  INCOMPLETO: faltan', usersDiff, 'usuarios por migrar.');
      if (v2bcrypt.c > 0) console.log('  INCOMPLETO: quedan', v2bcrypt.c, 'passwords en bcrypt (paso fix no termino).');
      if (v2placeholder.c > 0) console.log('  ALERTA: hay', v2placeholder.c, 'con password placeholder EXISTING_SKIP.');
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await v1Pool.end().catch(() => {});
    await v2Pool.end().catch(() => {});
  }
})();
