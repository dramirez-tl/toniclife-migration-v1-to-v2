const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursor, getCount } = require('../utils/batch-processor');
const { cleanString, cleanTrunc } = require('../utils/validators');

module.exports = async function phase12(v1Pool, v2Pool) {
  logger.phase('12', 'Comunicación y Notificaciones');
  const allResults = [];

  // --- notifications ---
  // t_notification real columns: id_notification, type_notification(enum), id_sale(bigint), date_notification(timestamptz)
  logger.table('notifications', 'Migrando t_notification → notifications');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: `SELECT id_notification, type_notification, id_sale, date_notification
                  FROM toniclife.t_notification
                  ORDER BY id_notification`,
    tableName: 'notifications',
    transformAndInsert: async (row, client) => {
      const title = cleanTrunc(row.type_notification, 200) || `Notificación ${row.id_notification}`;

      const existingId = await idResolver.resolve(v2Pool, 'notification', row.id_notification);
      if (existingId) return 'skipped'; // already migrated

      const { rows } = await client.query(
        `INSERT INTO tonic.notifications (
          id, notification_type, title, body,
          is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3,
          true
        )
        RETURNING id`,
        [
          (row.type_notification || 'custom').toLowerCase(),  // notification_type — CHECK requires lowercase
          title,                                    // title — NOT NULL
          null,                                     // body — nullable
        ]
      );
      if (rows.length > 0) {
        await idResolver.registerMapping(v2Pool, 'notification', row.id_notification, rows[0].id, 't_notification');
      }
    },
  }));

  // --- notification_reads ---
  // t_notification_read real columns: id_notification, id_user, date_read — NO PK column!
  logger.table('notification_reads', 'Migrando t_notification_read → notification_reads');
  const readCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_notification_read');
  logger.info(`    Total registros en t_notification_read: ${readCount.toLocaleString()}`);

  const notificationReadTransform = async (row, client) => {
    const notificationId = await idResolver.resolve(v2Pool, 'notification', row.id_notification);
    if (!notificationId) return 'skipped';

    // id_user is the v1 user id — resolve directly via legacy_id on users
    let userId = null;
    if (row.id_user) {
      const userResult = await client.query(
        'SELECT id FROM tonic.users WHERE legacy_id = $1 LIMIT 1',
        [row.id_user]
      );
      if (userResult.rows.length > 0) userId = userResult.rows[0].id;
    }
    if (!userId) return 'skipped';

    // Idempotency: use NOT EXISTS on (notification_id, user_id) since there is no unique legacy id
    await client.query(
      `INSERT INTO tonic.notification_reads (
        id, notification_id, user_id, read_at
      )
      SELECT gen_random_uuid(), $1, $2, $3
      WHERE NOT EXISTS (
        SELECT 1 FROM tonic.notification_reads
        WHERE notification_id = $1 AND user_id = $2
      )`,
      [notificationId, userId, row.date_read || new Date()]
    );
  };

  if (readCount > 50000) {
    allResults.push(await processWithCursor({
      v1Pool, v2Pool,
      sourceQuery: `SELECT id_notification, id_user, date_read
                    FROM toniclife.t_notification_read
                    ORDER BY id_notification, id_user`,
      tableName: 'notification_reads',
      totalCount: readCount,
      batchSize: 5000,
      transformAndInsert: notificationReadTransform,
    }));
  } else {
    allResults.push(await processSmallTable({
      v1Pool, v2Pool,
      sourceQuery: `SELECT id_notification, id_user, date_read
                    FROM toniclife.t_notification_read
                    ORDER BY id_notification, id_user`,
      tableName: 'notification_reads',
      transformAndInsert: notificationReadTransform,
    }));
  }

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated; acc.skipped += r.skipped; acc.failed += r.failed; acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 12 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
