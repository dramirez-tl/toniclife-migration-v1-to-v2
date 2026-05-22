const logger = require('../utils/logger');
const idResolver = require('../utils/id-resolver');
const { processSmallTable, processWithCursorBulk, buildMultiRowInsertWithUUID, getCount } = require('../utils/batch-processor');
const { cleanString, prefixUrl } = require('../utils/validators');
const config = require('../config');

module.exports = async function phase13(v1Pool, v2Pool) {
  logger.phase('13', 'Auditoría, Logs y Configuración');
  const allResults = [];

  // Pre-calentar caché de users para access_logs
  await idResolver.warmUp(v2Pool, [
    { type: 'user', table: 'users' },
  ]);

  // Mapeo de acciones v1 → v2
  const ACTION_MAP = {
    login: 'login',
    logout: 'logout',
    login_failed: 'login_failed',
    refresh: 'refresh_session',
    token_refresh: 'token_refresh',
    password_reset: 'password_reset',
  };
  const VALID_ACTIONS = ['login', 'logout', 'refresh_session', 'login_failed', 'password_reset', 'token_refresh'];
  const VALID_DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'api', 'unknown'];

  // --- access_logs (1.6M registros) — BULK ---
  logger.table('access_logs', 'Migrando t_logs → access_logs (bulk)');
  const logCount = await getCount(v1Pool, 'SELECT COUNT(*) AS count FROM toniclife.t_logs');
  logger.info(`    Total registros en t_logs: ${logCount.toLocaleString()}`);

  allResults.push(await processWithCursorBulk({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_logs ORDER BY id_log',
    tableName: 'access_logs',
    totalCount: logCount,
    batchSize: config.migration.batchSize,

    resolveBatch: async (rows) => {
      const userLegacyIds = [...new Set(rows.map(r => r.id_user).filter(Boolean))];
      const userMap = await idResolver.resolveMany(v2Pool, 'user', userLegacyIds, 'users');
      return { userMap };
    },

    transformRow: (row, { userMap }) => {
      const userId = row.id_user ? (userMap.get(String(row.id_user)) || null) : null;

      // Mapear acción
      const rawAction = (row.action_log || row.type_log || 'login').toString().toLowerCase().trim();
      let action = ACTION_MAP[rawAction] || null;
      if (!action) {
        if (rawAction.includes('login') && rawAction.includes('fail')) action = 'login_failed';
        else if (rawAction.includes('login')) action = 'login';
        else if (rawAction.includes('logout')) action = 'logout';
        else if (rawAction.includes('refresh')) action = 'refresh_session';
        else if (rawAction.includes('password')) action = 'password_reset';
        else action = 'login';
      }
      if (!VALID_ACTIONS.includes(action)) action = 'login';

      // Device type
      let deviceType = null;
      if (row.device_type_log || row.user_agent_log) {
        const ua = (row.device_type_log || row.user_agent_log || '').toString().toLowerCase();
        if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) deviceType = 'mobile';
        else if (ua.includes('tablet') || ua.includes('ipad')) deviceType = 'tablet';
        else if (ua.includes('api') || ua.includes('postman')) deviceType = 'api';
        else if (ua.includes('desktop') || ua.includes('windows') || ua.includes('mac')) deviceType = 'desktop';
        else deviceType = 'unknown';
      }
      if (deviceType && !VALID_DEVICE_TYPES.includes(deviceType)) deviceType = 'unknown';

      return {
        user_id: userId,
        username: cleanString(row.username_log || row.email_log),
        action,
        ip_address: row.ip_log || row.ip_address_log || null,
        user_agent: cleanString(row.user_agent_log),
        device_type: deviceType,
        session_id: cleanString(row.session_id_log),
        metadata: row.id_log ? JSON.stringify({ legacy_id: row.id_log }) : null,
        created_at: row.created_at || row.date_log || new Date(),
      };
    },

    buildInsertSQL: (transformedRows) => {
      // Idempotente desde mig 039: UNIQUE INDEX parcial sobre
      // ((metadata->>'legacy_id')) WHERE metadata->>'legacy_id' IS NOT NULL.
      // Re-runs hacen UPDATE en filas migradas (con legacy_id) y dejan
      // intactos los logs reales generados por la app (sin legacy_id).
      return buildMultiRowInsertWithUUID(
        'tonic.access_logs',
        ['user_id', 'username', 'action', 'ip_address', 'user_agent', 'device_type', 'session_id', 'metadata', 'created_at'],
        transformedRows,
        `ON CONFLICT ((metadata->>'legacy_id')) WHERE (metadata->>'legacy_id') IS NOT NULL DO UPDATE SET
          user_id = EXCLUDED.user_id,
          username = EXCLUDED.username,
          action = EXCLUDED.action,
          ip_address = EXCLUDED.ip_address,
          user_agent = EXCLUDED.user_agent,
          device_type = EXCLUDED.device_type,
          session_id = EXCLUDED.session_id,
          created_at = EXCLUDED.created_at`,
        { ip_address: 'inet', metadata: 'jsonb' }
      );
    },
  }));

  // --- system_files (GCS uploads → row-by-row) ---
  logger.table('system_files', 'Migrando t_file → system_files');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_file ORDER BY id_file',
    tableName: 'system_files',
    transformAndInsert: async (row, client) => {
      const VALID_FILE_TYPES = ['pdf', 'image', 'drive_link', 'video', 'document', 'other'];
      let fileType = 'other';
      const url = (row.url_file || row.path_file || '').toString().toLowerCase();
      const name = (row.name_file || '').toString().toLowerCase();
      if (url.includes('.pdf') || name.includes('.pdf')) fileType = 'pdf';
      else if (url.includes('.jpg') || url.includes('.png') || url.includes('.gif') || url.includes('.jpeg') || url.includes('.webp')) fileType = 'image';
      else if (url.includes('drive.google') || url.includes('docs.google')) fileType = 'drive_link';
      else if (url.includes('.mp4') || url.includes('.avi') || url.includes('youtube') || url.includes('vimeo')) fileType = 'video';
      else if (url.includes('.doc') || url.includes('.xls') || url.includes('.ppt') || url.includes('.csv')) fileType = 'document';

      if (!VALID_FILE_TYPES.includes(fileType)) fileType = 'other';

      const code = (row.code_file || `FILE-${row.id_file}`).toString().substring(0, 50);
      const fileUrl = prefixUrl(row.url_file || row.path_file);

      await client.query(
        `INSERT INTO tonic.system_files (
          id, code, name, file_type, url,
          mime_type, file_size, module, description,
          sort_order, legacy_id, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, true
        )
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name,
          file_type = EXCLUDED.file_type,
          url = CASE WHEN tonic.system_files.url LIKE 'https://storage.googleapis.com/%'
                     THEN tonic.system_files.url ELSE EXCLUDED.url END,
          mime_type = EXCLUDED.mime_type,
          file_size = EXCLUDED.file_size,
          module = EXCLUDED.module,
          description = EXCLUDED.description,
          sort_order = EXCLUDED.sort_order,
          legacy_id = EXCLUDED.legacy_id,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [
          code,
          cleanString(row.name_file) || code,
          fileType,
          fileUrl || '',
          cleanString(row.mime_type_file),
          row.size_file || null,
          cleanString(row.module_file),
          cleanString(row.description_file),
          row.order_file || 0,
          row.id_file,
        ]
      );
    },
  }));

  // --- system_settings ---
  logger.table('system_settings', 'Migrando t_text → system_settings');
  allResults.push(await processSmallTable({
    v1Pool, v2Pool,
    sourceQuery: 'SELECT * FROM toniclife.t_text ORDER BY id_text',
    tableName: 'system_settings',
    transformAndInsert: async (row, client) => {
      const VALID_VALUE_TYPES = ['string', 'number', 'boolean', 'json', 'array', 'image_url'];
      let valueType = 'string';

      const rawValue = row.value_text || row.content_text || '';
      let jsonValue;
      try {
        const parsed = JSON.parse(rawValue);
        if (Array.isArray(parsed)) { valueType = 'array'; jsonValue = JSON.stringify(parsed); }
        else if (typeof parsed === 'object') { valueType = 'json'; jsonValue = JSON.stringify(parsed); }
        else if (typeof parsed === 'number') { valueType = 'number'; jsonValue = JSON.stringify(parsed); }
        else if (typeof parsed === 'boolean') { valueType = 'boolean'; jsonValue = JSON.stringify(parsed); }
        else { jsonValue = JSON.stringify(String(rawValue)); }
      } catch {
        jsonValue = JSON.stringify(String(rawValue));
      }

      if (!VALID_VALUE_TYPES.includes(valueType)) valueType = 'string';

      const key = cleanString(row.key_text || row.name_text) || `setting_${row.id_text}`;
      const category = cleanString(row.category_text) || 'general';

      await client.query(
        `INSERT INTO tonic.system_settings (
          id, category, key, value, value_type,
          description, is_public, is_active
        ) VALUES (
          gen_random_uuid(), $1, $2, $3::jsonb, $4,
          $5, false, true
        )
        ON CONFLICT (category, key) DO UPDATE SET
          value = EXCLUDED.value,
          value_type = EXCLUDED.value_type,
          description = EXCLUDED.description,
          is_active = EXCLUDED.is_active,
          updated_at = NOW()`,
        [category, key, jsonValue, valueType, cleanString(row.description_text)]
      );
    },
  }));

  const totals = allResults.reduce((acc, r) => {
    acc.migrated += r.migrated; acc.skipped += r.skipped; acc.failed += r.failed; acc.errors.push(...r.errors);
    return acc;
  }, { migrated: 0, skipped: 0, failed: 0, errors: [] });

  logger.info(`\n  Fase 13 completa: ${totals.migrated} migrados, ${totals.skipped} omitidos, ${totals.failed} fallidos`);
  return totals;
};
