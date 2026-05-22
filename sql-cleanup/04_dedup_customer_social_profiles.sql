-- ============================================================================
-- CLEANUP 04: Dedup masivo de tonic.customer_social_profiles
-- ============================================================================
-- Proposito:
--   Eliminar duplicados en customer_social_profiles generados por
--   re-ejecuciones de phase-05 con check SELECT 1 fragil.
--
-- Estado actual (verificado 2026-05-19):
--   - Distribuidores con 3-6 copias de la misma platform.
--   - phase-05 usa "SELECT 1 ... LIMIT 1" antes de INSERT, pero el check
--     no es atomico bajo concurrencia ni captura race conditions.
--
-- Estado deseado:
--   - 1 fila por (customer_id, platform).
--   - Conservar la mas antigua (created_at minimo).
--
-- Tiempo estimado: <2 segundos.
-- Reversible: NO sin backup previo.
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 1) Sanity check inicial
SELECT
    'inicial' AS estado,
    COUNT(*) AS total,
    COUNT(DISTINCT (customer_id, platform)) AS combinaciones_unicas
FROM tonic.customer_social_profiles;

-- 2) Deshabilitar triggers durante DELETE
ALTER TABLE tonic.customer_social_profiles DISABLE TRIGGER USER;

-- 3) DELETE manteniendo la fila mas antigua por (customer_id, platform)
WITH keep AS (
    SELECT DISTINCT ON (customer_id, platform) id
    FROM tonic.customer_social_profiles
    ORDER BY customer_id, platform, created_at ASC, id ASC
)
DELETE FROM tonic.customer_social_profiles
WHERE id NOT IN (SELECT id FROM keep);

-- 4) Re-habilitar triggers
ALTER TABLE tonic.customer_social_profiles ENABLE TRIGGER USER;

-- 5) Sanity check post-dedup
SELECT
    'post_dedup' AS estado,
    COUNT(*) AS total,
    COUNT(DISTINCT (customer_id, platform)) AS combinaciones_unicas
FROM tonic.customer_social_profiles;

-- 6) Verificar que no quedaron dupes
SELECT customer_id, platform, COUNT(*) AS aun_dupe
FROM tonic.customer_social_profiles
GROUP BY customer_id, platform
HAVING COUNT(*) > 1;
-- Esperado: 0 filas

COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- No reversible. Para backup previo:
--
-- CREATE TABLE tonic.customer_social_profiles_backup_20260519 AS
-- SELECT * FROM tonic.customer_social_profiles;
--
-- ============================================================================
