-- ============================================================================
-- CLEANUP 05: Dedup de tonic.shopping_cart_items
-- ============================================================================
-- Propósito:
--   Eliminar las filas duplicadas por (cart_id, product_id) generadas porque
--   shopping_cart_items NO tiene UNIQUE de negocio (solo PK id) y phase-07
--   inserta items sin ON CONFLICT efectivo.
--
-- Estado actual (verificado 2026-05-22):
--   - 6,866 filas; 11 filas sobrantes en ~9 grupos (cart_id, product_id).
--   - Mayor grupo: 3 copias de un mismo (cart_id, product_id).
--   - Son carritos históricos/transaccionales migrados de v1 (t_cart_det).
--
-- Estado deseado:
--   - 1 fila por (cart_id, product_id). Conservar la MÁS ANTIGUA (created_at).
--
-- ⚠️ REVISIÓN PREVIA OBLIGATORIA:
--   Las copias pueden diferir en quantity/unit_price/points/business_value.
--   Correr primero la query de "REVISIÓN" (abajo, dentro de UP) y confirmar
--   que descartar las más nuevas es aceptable. Si una copia más nueva tiene
--   la cantidad correcta, ajustar la estrategia de "keep" antes de borrar.
--
-- Reversible: NO (salvo backup previo). Tiempo estimado: <1 seg.
-- Pre-requisito: ninguno (tabla de baja escala).
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 0) REVISIÓN: ver las filas duplicadas completas ANTES de borrar.
--    (Si las copias difieren en datos relevantes, NO continuar a ciegas.)
SELECT sci.*
FROM tonic.shopping_cart_items sci
JOIN (
    SELECT cart_id, product_id
    FROM tonic.shopping_cart_items
    GROUP BY cart_id, product_id
    HAVING count(*) > 1
) d ON d.cart_id = sci.cart_id AND d.product_id = sci.product_id
ORDER BY sci.cart_id, sci.product_id, sci.created_at;

-- 1) Sanity check inicial
SELECT 'inicial' AS estado,
       count(*) AS total,
       count(DISTINCT (cart_id, product_id)) AS combinaciones_unicas,
       count(*) - count(DISTINCT (cart_id, product_id)) AS sobrantes
FROM tonic.shopping_cart_items;
-- Esperado 2026-05-22: total=6866, sobrantes=11

-- 2) Deshabilitar audit triggers durante el DELETE (si existen)
ALTER TABLE tonic.shopping_cart_items DISABLE TRIGGER USER;

-- 3) DELETE manteniendo la fila más antigua por (cart_id, product_id)
WITH keep AS (
    SELECT DISTINCT ON (cart_id, product_id) id
    FROM tonic.shopping_cart_items
    ORDER BY cart_id, product_id, created_at ASC, id ASC
)
DELETE FROM tonic.shopping_cart_items
WHERE id NOT IN (SELECT id FROM keep);
-- Esperado: DELETE 11

-- 4) Re-habilitar triggers
ALTER TABLE tonic.shopping_cart_items ENABLE TRIGGER USER;

-- 5) Sanity check post-dedup
SELECT 'post_dedup' AS estado,
       count(*) AS total,
       count(*) - count(DISTINCT (cart_id, product_id)) AS sobrantes
FROM tonic.shopping_cart_items;
-- Esperado: sobrantes=0

-- 6) Verificar que no quedaron duplicados
SELECT cart_id, product_id, count(*) AS aun_dupe
FROM tonic.shopping_cart_items
GROUP BY cart_id, product_id
HAVING count(*) > 1;
-- Esperado: 0 filas

-- Si todo se ve bien:  COMMIT;   en caso contrario:  ROLLBACK;
COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- No reversible. Para backup previo (opcional, recomendado):
--
-- CREATE TABLE tonic.shopping_cart_items_backup_20260522 AS
-- SELECT * FROM tonic.shopping_cart_items;
--
-- Restauración: re-insertar desde el backup las filas borradas.
-- ============================================================================
