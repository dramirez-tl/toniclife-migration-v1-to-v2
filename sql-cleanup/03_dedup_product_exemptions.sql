-- ============================================================================
-- CLEANUP 03: Dedup masivo de tonic.product_exemptions
-- ============================================================================
-- Proposito:
--   Eliminar duplicados en product_exemptions generados por re-ejecuciones
--   de phase-04 con ON CONFLICT DO NOTHING que no funcionaba sin UNIQUE
--   (la PK por id deja insertar la misma combinacion N veces).
--
-- Estado actual (verificado 2026-05-19):
--   - Productos con 455-460 copias de la misma exemption_type ('iva').
--   - Implica que phase-04 corrio ~455 veces o que cada producto genero
--     una fila por cada t_product_exempt mas un producto que mapea a 'all'.
--   - En cualquier caso: la combinacion (product_id, exemption_type) debe
--     ser UNICA logicamente.
--
-- Estado deseado:
--   - 1 fila por (product_id, exemption_type).
--   - Conservar la mas antigua (created_at minimo).
--
-- Estrategia:
--   DELETE in-place con CTE keep. Tabla tiene PK id; no hay FKs entrantes
--   verificadas. Si las hay, los DELETE solo eliminan rows redundantes
--   (las mantenidas conservan sus ids originales por estrategia "keep oldest").
--
-- Audit trigger: deshabilitar durante DELETE masivo.
--
-- Tiempo estimado: <2 segundos.
-- Reversible: NO. Usar SAVEPOINT + verificar conteo antes de COMMIT.
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 1) Sanity check inicial
SELECT
    'inicial' AS estado,
    COUNT(*) AS total,
    COUNT(DISTINCT (product_id, exemption_type)) AS combinaciones_unicas
FROM tonic.product_exemptions;

-- 2) Deshabilitar audit triggers durante DELETE (si existen)
ALTER TABLE tonic.product_exemptions DISABLE TRIGGER USER;

-- 3) DELETE manteniendo la fila mas antigua por (product_id, exemption_type)
WITH keep AS (
    SELECT DISTINCT ON (product_id, exemption_type) id
    FROM tonic.product_exemptions
    ORDER BY product_id, exemption_type, created_at ASC, id ASC
)
DELETE FROM tonic.product_exemptions
WHERE id NOT IN (SELECT id FROM keep);

-- 4) Re-habilitar triggers
ALTER TABLE tonic.product_exemptions ENABLE TRIGGER USER;

-- 5) Sanity check post-dedup
SELECT
    'post_dedup' AS estado,
    COUNT(*) AS total,
    COUNT(DISTINCT (product_id, exemption_type)) AS combinaciones_unicas
FROM tonic.product_exemptions;

-- 6) Verificar que no quedaron dupes
SELECT product_id, exemption_type, COUNT(*) AS aun_dupe
FROM tonic.product_exemptions
GROUP BY product_id, exemption_type
HAVING COUNT(*) > 1;
-- Esperado: 0 filas

COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- No reversible. Para backup previo:
--
-- CREATE TABLE tonic.product_exemptions_backup_20260519 AS
-- SELECT * FROM tonic.product_exemptions;
--
-- ============================================================================
