-- ============================================================================
-- CLEANUP 06: Dedup de tonic.purchase_order_cost_centers
-- ============================================================================
-- Propósito:
--   Eliminar duplicados por (purchase_order_id, cost_center_id) generados
--   porque la tabla NO tiene UNIQUE de negocio (solo PK id) y phase-10b
--   inserta sin ON CONFLICT.
--
-- Estado actual (verificado 2026-05-22):
--   - 3 filas en total; 1 grupo con 3 copias del mismo
--     (purchase_order_id, cost_center_id) => 2 filas sobrantes.
--
-- ⚠️ REVISIÓN PREVIA OBLIGATORIA:
--   purchase_order_cost_centers tiene columnas amount y percentage: las 3
--   copias pueden representar montos/porcentajes distintos de la MISMA OC al
--   mismo centro de costo. Si es así, la dedup "keep oldest" PERDERÍA monto.
--   Correr la query de REVISIÓN (paso 0) y confirmar con el área de compras
--   ANTES de borrar. Si los montos difieren, NO ejecutar este script: el caso
--   correcto podría ser SUMAR/consolidar, no descartar.
--
-- Estado deseado:
--   - 1 fila por (purchase_order_id, cost_center_id). Conservar la MÁS ANTIGUA.
--
-- Reversible: NO (salvo backup). Tiempo estimado: <1 seg.
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 0) REVISIÓN: ver las filas duplicadas completas ANTES de borrar.
SELECT pcc.*
FROM tonic.purchase_order_cost_centers pcc
JOIN (
    SELECT purchase_order_id, cost_center_id
    FROM tonic.purchase_order_cost_centers
    GROUP BY purchase_order_id, cost_center_id
    HAVING count(*) > 1
) d ON d.purchase_order_id = pcc.purchase_order_id
   AND d.cost_center_id = pcc.cost_center_id
ORDER BY pcc.purchase_order_id, pcc.cost_center_id, pcc.created_at;

-- 1) Sanity check inicial
SELECT 'inicial' AS estado,
       count(*) AS total,
       count(*) - count(DISTINCT (purchase_order_id, cost_center_id)) AS sobrantes
FROM tonic.purchase_order_cost_centers;
-- Esperado 2026-05-22: total=3, sobrantes=2

-- 2) Deshabilitar audit triggers durante el DELETE (si existen)
ALTER TABLE tonic.purchase_order_cost_centers DISABLE TRIGGER USER;

-- 3) DELETE manteniendo la fila más antigua por (purchase_order_id, cost_center_id)
WITH keep AS (
    SELECT DISTINCT ON (purchase_order_id, cost_center_id) id
    FROM tonic.purchase_order_cost_centers
    ORDER BY purchase_order_id, cost_center_id, created_at ASC, id ASC
)
DELETE FROM tonic.purchase_order_cost_centers
WHERE id NOT IN (SELECT id FROM keep);
-- Esperado: DELETE 2

-- 4) Re-habilitar triggers
ALTER TABLE tonic.purchase_order_cost_centers ENABLE TRIGGER USER;

-- 5) Sanity check post-dedup
SELECT 'post_dedup' AS estado,
       count(*) AS total,
       count(*) - count(DISTINCT (purchase_order_id, cost_center_id)) AS sobrantes
FROM tonic.purchase_order_cost_centers;
-- Esperado: sobrantes=0

-- Si todo se ve bien:  COMMIT;   en caso contrario:  ROLLBACK;
COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- No reversible. Para backup previo (opcional, recomendado):
--
-- CREATE TABLE tonic.purchase_order_cost_centers_backup_20260522 AS
-- SELECT * FROM tonic.purchase_order_cost_centers;
-- ============================================================================
