-- ============================================================================
-- CLEANUP 01: Dedup masivo de tonic.access_logs
-- ============================================================================
-- Proposito:
--   Eliminar duplicados generados por re-ejecuciones previas de la phase-13
--   (audit), que no tenia idempotencia. Cada legacy_id de t_logs aparece ~3
--   veces en v2 actualmente.
--
-- Estado actual:
--   - 5,126,009 filas totales
--   - 1,724,114 legacy_ids distintos (en metadata->>'legacy_id')
--   - Promedio: 2.97 copias por legacy_id
--
-- Estado deseado:
--   - 1,724,114 filas (una por legacy_id) + filas sin legacy_id (NULL)
--   - Conservar la fila MAS ANTIGUA (created_at min) por legacy_id, ya que
--     representa la primera migracion y tiene el created_at mas cercano al
--     evento original.
--
-- Estrategia:
--   Usar CREATE TABLE + INSERT DISTINCT ON + swap (mas rapido que DELETE
--   masivo en tablas de 5M). access_logs es regular (no particionada),
--   permite esta estrategia.
--
-- Riesgos:
--   - Las filas sin metadata->>'legacy_id' (creadas por uso real post-migracion)
--     se conservan TODAS, no se tocan.
--   - Si hay constraints/FKs apuntando a access_logs, se romperian con swap.
--     Verificado: ninguna tabla referencia access_logs (es append-only de
--     auditoria, sin FKs entrantes).
--
-- Tiempo estimado: 2-5 minutos en 5M filas.
-- Reversible: NO totalmente. El backup intermedio (access_logs_backup) sirve
-- de seguro mientras se valida. Se elimina al final con comando manual.
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 1) Sanity check inicial
SELECT
    COUNT(*) AS total_actual,
    COUNT(DISTINCT metadata->>'legacy_id') FILTER (WHERE metadata->>'legacy_id' IS NOT NULL) AS distinct_legacy_id,
    COUNT(*) FILTER (WHERE metadata->>'legacy_id' IS NULL) AS sin_legacy_id
FROM tonic.access_logs;

-- 2) Crear tabla deduplicada (mismo esquema, sin datos)
CREATE TABLE tonic.access_logs_dedup (LIKE tonic.access_logs INCLUDING ALL);

-- 3) Insertar UNA fila por legacy_id (la mas antigua), MAS todas las filas
--    sin legacy_id (usuarios reales post-migracion).
INSERT INTO tonic.access_logs_dedup
SELECT DISTINCT ON (metadata->>'legacy_id') *
FROM tonic.access_logs
WHERE metadata->>'legacy_id' IS NOT NULL
ORDER BY metadata->>'legacy_id', created_at ASC;

INSERT INTO tonic.access_logs_dedup
SELECT *
FROM tonic.access_logs
WHERE metadata->>'legacy_id' IS NULL;

-- 4) Sanity check post-dedup
SELECT
    'access_logs_dedup' AS tbl,
    COUNT(*) AS total,
    COUNT(DISTINCT metadata->>'legacy_id') FILTER (WHERE metadata->>'legacy_id' IS NOT NULL) AS distinct_legacy,
    COUNT(*) FILTER (WHERE metadata->>'legacy_id' IS NULL) AS sin_legacy
FROM tonic.access_logs_dedup;

-- 5) Si los conteos lucen bien (en pantalla), proceder con swap.
--    SI NO, hacer ROLLBACK antes del swap.

-- 6) Renombrar tabla original a backup y promover dedup a access_logs
ALTER TABLE tonic.access_logs RENAME TO access_logs_backup_20260519;
ALTER TABLE tonic.access_logs_dedup RENAME TO access_logs;

-- 7) Reasignar PK constraint
--    (los indices se copian con LIKE ... INCLUDING ALL; constraints tambien)

-- 8) Verificacion final
SELECT
    'access_logs (post-swap)' AS tbl,
    COUNT(*) AS total,
    COUNT(DISTINCT metadata->>'legacy_id') FILTER (WHERE metadata->>'legacy_id' IS NOT NULL) AS distinct_legacy
FROM tonic.access_logs;

COMMIT;

-- ============================================================================
-- LIMPIEZA POSTERIOR (correr manualmente despues de validar varios dias)
-- ============================================================================
-- Una vez confirmado que no hay regresion en logs y la app funciona normal:
--
-- DROP TABLE tonic.access_logs_backup_20260519;
--
-- ============================================================================
-- DOWN (rollback en caso de problema)
-- ============================================================================
-- Si despues del COMMIT detectas problema y la tabla backup aun existe:
--
-- BEGIN;
--   ALTER TABLE tonic.access_logs RENAME TO access_logs_failed_dedup;
--   ALTER TABLE tonic.access_logs_backup_20260519 RENAME TO access_logs;
--   DROP TABLE tonic.access_logs_failed_dedup;
-- COMMIT;
--
-- ============================================================================
-- NOTAS DE IMPACTO
-- ============================================================================
-- - Locking: ALTER TABLE RENAME toma ACCESS EXCLUSIVE muy brevemente.
--   La app puede tener una pausa de <1 seg al hacer queries durante el swap.
-- - INSERT ... DISTINCT ON sobre 5M filas: ~30-90 seg.
-- - Espacio: temporalmente se duplica el almacenamiento (5M + 1.7M filas).
--   Liberar con DROP de backup tras validar.
-- - audit triggers: la tabla nueva conserva triggers por INCLUDING ALL.
--   Si hay un trigger AFTER INSERT que inserta en otra tabla, se disparara
--   durante el INSERT. Verificar antes de correr.
-- ============================================================================
