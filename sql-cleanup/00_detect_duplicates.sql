-- ============================================================================
-- DETECT 00: Detección de duplicados en v2 (toniclife_db_v2 / schema tonic)
-- ============================================================================
-- READ-ONLY. Este script SOLO contiene SELECTs. No modifica datos ni esquema.
-- Seguro de correr contra producción (34.70.18.38) en DBeaver o psql.
--
-- Propósito:
--   Re-verificar el estado de duplicados tras cualquier re-ejecución de la
--   migración v1→v2. Producido durante la auditoría del 2026-05-22.
--
-- Contexto (auditoría 2026-05-22):
--   - El schema tonic tiene 120 UNIQUE constraints => en esas tablas el
--     duplicado es IMPOSIBLE (la BD lo rechaza). No hace falta revisarlas.
--   - El riesgo se concentra en tablas SIN UNIQUE de negocio (solo PK uuid)
--     y en las de UNIQUE PARCIAL (WHERE legacy_id IS NOT NULL), donde las
--     filas con clave NULL se brincan el dedup.
--   - Resultado del 2026-05-22: solo 13 filas duplicadas reales en toda la BD
--     (shopping_cart_items=11, purchase_order_cost_centers=2). El resto = 0.
--
-- Uso:
--   psql "<conn>?sslmode=require" -f sql-cleanup/00_detect_duplicates.sql
--   (o pegar por secciones en DBeaver)
-- ============================================================================

\echo '== A) DASHBOARD: filas sobrantes por clave de negocio (riesgo real) =='
-- "filas_sobrantes" = total - combinaciones únicas por la clave indicada.
-- > 0 significa duplicados presentes.
SELECT 'network_sponsor_overrides'   AS tabla, 'legacy_id'                        AS clave,
       count(*)                      AS total,
       count(legacy_id) - count(DISTINCT legacy_id)            AS filas_sobrantes,
       count(*) - count(legacy_id)                             AS filas_clave_null
FROM tonic.network_sponsor_overrides
UNION ALL
SELECT 'network_upline_overrides', 'legacy_id', count(*),
       count(legacy_id) - count(DISTINCT legacy_id),
       count(*) - count(legacy_id)
FROM tonic.network_upline_overrides
UNION ALL
SELECT 'network_members', 'legacy_id', count(*),
       count(legacy_id) - count(DISTINCT legacy_id),
       count(*) - count(legacy_id)
FROM tonic.network_members
UNION ALL
SELECT 'shopping_cart_items', '(cart_id, product_id)', count(*),
       count(*) - count(DISTINCT (cart_id, product_id)),
       0
FROM tonic.shopping_cart_items
UNION ALL
SELECT 'purchase_order_cost_centers', '(purchase_order_id, cost_center_id)', count(*),
       count(*) - count(DISTINCT (purchase_order_id, cost_center_id)),
       0
FROM tonic.purchase_order_cost_centers
UNION ALL
SELECT 'inventory_count_details', '(count_id, product_id)', count(*),
       count(*) - count(DISTINCT (count_id, product_id)),
       0
FROM tonic.inventory_count_details
UNION ALL
SELECT 'product_images', '(product_id, filename)', count(*),
       count(*) - count(DISTINCT (product_id, substring(image_url FROM '[^/]+$'))),
       count(*) - count(image_url)
FROM tonic.product_images
ORDER BY filas_sobrantes DESC, tabla;

\echo '== B) DETALLE: grupos duplicados en shopping_cart_items (esperado: 11 sobrantes) =='
SELECT cart_id, product_id, count(*) AS copias
FROM tonic.shopping_cart_items
GROUP BY cart_id, product_id
HAVING count(*) > 1
ORDER BY copias DESC
LIMIT 50;

\echo '== C) DETALLE: grupos duplicados en purchase_order_cost_centers (esperado: 2 sobrantes) =='
SELECT purchase_order_id, cost_center_id, count(*) AS copias
FROM tonic.purchase_order_cost_centers
GROUP BY purchase_order_id, cost_center_id
HAVING count(*) > 1
ORDER BY copias DESC;

\echo '== D) HEURÍSTICA: notifications sin clave natural -> filas potencialmente repetidas =='
-- notifications no tiene legacy_id ni UNIQUE de negocio. Clave heurística:
-- mismas (tipo, título, entidad, creador) en el mismo segundo.
SELECT notification_type, entity_type, entity_id, title, created_by,
       date_trunc('second', created_at) AS creado_seg, count(*) AS copias
FROM tonic.notifications
GROUP BY notification_type, entity_type, entity_id, title, created_by, date_trunc('second', created_at)
HAVING count(*) > 1
ORDER BY copias DESC
LIMIT 50;

\echo '== E) INVENTARIO: tablas tonic SIN UNIQUE de negocio (solo PK surrogada) =='
-- Lista las tablas cuyo único índice único es la PK por id (riesgo a futuro
-- si una fase inserta sin dedup). NO implica que hoy tengan duplicados.
SELECT c.relname AS tabla,
       c.reltuples::bigint AS filas_est,
       EXISTS (SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema='tonic' AND col.table_name=c.relname
                 AND col.column_name='legacy_id') AS tiene_legacy_id
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='tonic' AND c.relkind='r'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.oid AND i.indisunique
      AND i.indexrelid <> (SELECT conindid FROM pg_constraint
                           WHERE conrelid=c.oid AND contype='p' LIMIT 1)
  )
ORDER BY c.reltuples DESC;

\echo '== F) REFERENCIA: todas las UNIQUE constraints/índices únicos de tonic =='
SELECT conrelid::regclass::text AS tabla, conname, pg_get_constraintdef(oid) AS definicion
FROM pg_constraint
WHERE connamespace='tonic'::regnamespace AND contype IN ('u')
ORDER BY tabla;
-- FIN — todo lo anterior es SELECT. No se modificó nada.
