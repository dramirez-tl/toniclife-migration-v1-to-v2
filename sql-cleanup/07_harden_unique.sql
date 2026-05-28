-- ============================================================================
-- HARDEN 07: UNIQUE índices preventivos (huecos NO cubiertos por migración 039)
-- ============================================================================
-- Propósito:
--   Cerrar los huecos de idempotencia que la migración 039
--   (toniclife-api/sql/migrations/039_uniques_for_migration_idempotency.sql)
--   NO cubrió. Sin estos UNIQUE, un re-run de las fases correspondientes
--   PODRÍA duplicar (hoy están limpias, ver auditoría 2026-05-22).
--
-- ⚠️ Esta NO es una migración versionada todavía. Para producción, lo correcto
--    es PROMOVERLA a `toniclife-api/sql/migrations/040_harden_more_uniques.sql`.
--
-- ⚠️⚠️ CAUTELA MLM: los dos primeros índices tocan network_*_overrides.
--    Cambios en mlm/ requieren confirmación. Datos hoy limpios (0 dup), seguro.
--
-- PRE-REQUISITO (ya cumplido al 2026-05-22):
--   Tablas sin duplicados. Correr antes 05 y 06. (network_*_overrides e
--   inventory_count_details ya estaban en 0.)
--
-- ----------------------------------------------------------------------------
-- ⚠️ POR QUÉ ESTA VERSIÓN NO USA "CONCURRENTLY"
--   `CREATE INDEX CONCURRENTLY` NO puede ejecutarse dentro de una transacción
--   ni de un "pipeline". DBeaver, al correr el script (o con auto-commit OFF),
--   envía las sentencias en pipeline → error 25001
--   ("CREATE INDEX CONCURRENTLY cannot be executed within a pipeline").
--
--   Como estas tablas son chicas (máx ~216K filas), un índice NORMAL se crea
--   en segundos. Toma un lock que BLOQUEA ESCRITURAS (no lecturas) en la tabla
--   durante el build. network_*_overrides casi no reciben escrituras (overrides
--   de admin), así que es aceptable. Correr en ventana de baja actividad.
--
--   Si prefieres cero-lock, ve al final ("ALTERNATIVA con CONCURRENTLY").
-- ============================================================================

-- ============================================================================
-- ⚠️ CORRECCIÓN (2026-05-22): índice INVÁLIDO por intento previo con CONCURRENTLY
--   Si ya intentaste este script con CONCURRENTLY y falló, pudo quedar
--   `uq_network_sponsor_overrides_legacy_id` en estado INVALID. Como el UP usa
--   `IF NOT EXISTS`, lo SALTA y queda inválido (no impone unicidad). Recrearlo:
--
--     BEGIN;
--       DROP INDEX IF EXISTS tonic.uq_network_sponsor_overrides_legacy_id;
--       CREATE UNIQUE INDEX uq_network_sponsor_overrides_legacy_id
--           ON tonic.network_sponsor_overrides (legacy_id)
--           WHERE legacy_id IS NOT NULL;
--     COMMIT;
--
--   Verificar validez de TODOS (debe dar indisvalid=t en los 5):
--     SELECT n.nspname, c.relname, i.indisvalid
--     FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
--     JOIN pg_namespace n ON n.oid=c.relnamespace
--     WHERE n.nspname='tonic' AND c.relname LIKE 'uq_%'
--       AND c.relname IN ('uq_network_sponsor_overrides_legacy_id',
--         'uq_network_upline_overrides_legacy_id','uq_purchase_order_cost_centers_pair',
--         'uq_shopping_cart_items_pair','uq_inventory_count_details_pair');
-- ============================================================================

-- ============================================================================
-- UP  (versión transaccional — funciona en DBeaver con Ejecutar Script)
-- ============================================================================

BEGIN;

-- 1) network_sponsor_overrides: UNIQUE parcial sobre legacy_id  [MLM]
CREATE UNIQUE INDEX IF NOT EXISTS uq_network_sponsor_overrides_legacy_id
    ON tonic.network_sponsor_overrides (legacy_id)
    WHERE legacy_id IS NOT NULL;

-- 2) network_upline_overrides: UNIQUE parcial sobre legacy_id  [MLM]
CREATE UNIQUE INDEX IF NOT EXISTS uq_network_upline_overrides_legacy_id
    ON tonic.network_upline_overrides (legacy_id)
    WHERE legacy_id IS NOT NULL;

-- 3) purchase_order_cost_centers: UNIQUE (purchase_order_id, cost_center_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_order_cost_centers_pair
    ON tonic.purchase_order_cost_centers (purchase_order_id, cost_center_id);

-- 4) shopping_cart_items: UNIQUE (cart_id, product_id)
--    (Opcional: 039 dejó shopping_carts laxo a propósito; estos son los ITEMS.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_shopping_cart_items_pair
    ON tonic.shopping_cart_items (cart_id, product_id);

-- 5) inventory_count_details: UNIQUE (count_id, product_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_count_details_pair
    ON tonic.inventory_count_details (count_id, product_id);

-- Comentarios (documentación de los índices)
COMMENT ON INDEX tonic.uq_network_sponsor_overrides_legacy_id IS
    'Unique parcial sobre legacy_id. Idempotencia phase-06. Auditoría 2026-05-22.';
COMMENT ON INDEX tonic.uq_network_upline_overrides_legacy_id IS
    'Unique parcial sobre legacy_id. Idempotencia phase-06. Auditoría 2026-05-22.';
COMMENT ON INDEX tonic.uq_purchase_order_cost_centers_pair IS
    'Un centro de costo por OC. Idempotencia phase-10b. Auditoría 2026-05-22.';
COMMENT ON INDEX tonic.uq_shopping_cart_items_pair IS
    'Un producto por carrito. Idempotencia phase-07. Auditoría 2026-05-22.';
COMMENT ON INDEX tonic.uq_inventory_count_details_pair IS
    'Un producto por conteo. Idempotencia phase-10. Auditoría 2026-05-22.';

-- Verificación dentro de la misma transacción (deben aparecer 5, todos válidos)
SELECT indexrelid::regclass AS indice, indisvalid
FROM pg_index
WHERE indexrelid::regclass::text IN (
  'uq_network_sponsor_overrides_legacy_id','uq_network_upline_overrides_legacy_id',
  'uq_purchase_order_cost_centers_pair','uq_shopping_cart_items_pair',
  'uq_inventory_count_details_pair');

-- Si todo se ve bien:  COMMIT;   si algo falla (ej. dup inesperado):  ROLLBACK;
COMMIT;

-- ============================================================================
-- DOWN
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS tonic.uq_inventory_count_details_pair;
--   DROP INDEX IF EXISTS tonic.uq_shopping_cart_items_pair;
--   DROP INDEX IF EXISTS tonic.uq_purchase_order_cost_centers_pair;
--   DROP INDEX IF EXISTS tonic.uq_network_upline_overrides_legacy_id;
--   DROP INDEX IF EXISTS tonic.uq_network_sponsor_overrides_legacy_id;
-- COMMIT;

-- ============================================================================
-- ALTERNATIVA con CONCURRENTLY (cero-lock) — SOLO si la necesitas
-- ============================================================================
-- CONCURRENTLY no bloquea escrituras, pero NO puede ir en transacción/pipeline.
-- Para correrla en DBeaver:
--   1. Activar AUTO-COMMIT (toolbar de DBeaver, o Ctrl+Shift+... según versión).
--   2. Ejecutar UNA sentencia a la vez con Ctrl+Enter (NO el script completo).
--   3. NO envolver en BEGIN/COMMIT.
-- Sentencias (una por una):
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_network_sponsor_overrides_legacy_id ON tonic.network_sponsor_overrides (legacy_id) WHERE legacy_id IS NOT NULL;
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_network_upline_overrides_legacy_id  ON tonic.network_upline_overrides  (legacy_id) WHERE legacy_id IS NOT NULL;
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_purchase_order_cost_centers_pair     ON tonic.purchase_order_cost_centers (purchase_order_id, cost_center_id);
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_shopping_cart_items_pair             ON tonic.shopping_cart_items (cart_id, product_id);
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_inventory_count_details_pair         ON tonic.inventory_count_details (count_id, product_id);
-- Si una CONCURRENTLY falla a medias, deja un índice INVALID: DROP INDEX y reintentar.
-- ============================================================================
