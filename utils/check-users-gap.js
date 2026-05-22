// READ-ONLY: ubica DONDE estan los usuarios faltantes (cola vs huecos dispersos)
const { Pool } = require('pg');
const config = require('../config');

(async () => {
  const v1Pool = new Pool({ host: config.v1.host, port: config.v1.port, database: config.v1.database, user: config.v1.user, password: config.v1.password, max: 3, connectionTimeoutMillis: 15000 });
  const v2Pool = new Pool({ host: config.v2.host, port: config.v2.port, database: config.v2.database, user: config.v2.user, password: config.v2.password, max: 3, connectionTimeoutMillis: 30000, ssl: { rejectUnauthorized: false } });
  const q = async (pool, sql, params) => (await pool.query(sql, params)).rows;
  try {
    const V2MAX = (await q(v2Pool, 'SELECT max(legacy_id)::int AS mx FROM tonic.users'))[0].mx;
    // Cuantos v1 users tienen id_user > v2max (la cola no migrada)
    const tail = (await q(v1Pool, 'SELECT count(*)::int AS c, min(id_user)::int AS mn, max(id_user)::int AS mx FROM toniclife.t_users WHERE id_user > $1', [V2MAX]))[0];
    console.log('v2 max legacy_id:', V2MAX);
    console.log('v1 users con id_user >', V2MAX, '(la "cola"):', tail.c, '  rango', tail.mn, '->', tail.mx);

    // Cuantos v1 users con id_user <= v2max NO estan en v2 (huecos dispersos en zona ya procesada)
    const v1ids = (await q(v1Pool, 'SELECT id_user::int AS id FROM toniclife.t_users WHERE id_user <= $1 ORDER BY id_user', [V2MAX])).map(r => r.id);
    const v2ids = new Set((await q(v2Pool, 'SELECT legacy_id::int AS id FROM tonic.users WHERE legacy_id <= $1', [V2MAX])).map(r => r.id));
    const missingInRange = v1ids.filter(id => !v2ids.has(id));
    console.log('v1 users con id_user <=', V2MAX, ':', v1ids.length);
    console.log('  de esos, faltantes en v2 (huecos en zona procesada):', missingInRange.length);
    if (missingInRange.length > 0) console.log('  primeros 20 huecos:', missingInRange.slice(0, 20).join(', '));

    console.log('');
    console.log('TOTAL faltantes =', tail.c, '(cola) +', missingInRange.length, '(huecos) =', tail.c + missingInRange.length);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await v1Pool.end().catch(() => {});
    await v2Pool.end().catch(() => {});
  }
})();
