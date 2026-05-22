-- ============================================================================
-- CLEANUP 02: DELETE de tonic.customer_addresses (re-migracion limpia)
-- ============================================================================
-- Proposito:
--   Limpiar completamente customer_addresses para re-migrar desde v1 con
--   legacy_id (columna que se agrega via mig 039). Razon:
--
--   - v1 tiene 537 direcciones; varios customers tienen hasta 5 direcciones.
--   - v2 tiene 2,613 filas con 5x dupes por (customer_id, address_type='shipping',
--     label='Principal') porque phase-05 inserta hardcoded label.
--   - Dedup keeping-oldest perderia 4 direcciones por customer (lossy).
--   - Mejor: borrar TODO y re-migrar con legacy_id = id_customers_address,
--     labels diferenciados ("Direccion 1", "Direccion 2", ...).
--
-- Verificado (2026-05-19):
--   - orders.shipping_address_id IS NOT NULL: 0 filas (no hay FKs reales).
--   - customer_subscriptions.shipping_address_id IS NOT NULL: 0 filas.
--
-- NOTA: NO se usa TRUNCATE. customer_addresses esta referenciada por FKs de
--   orders.shipping_address_id y customer_subscriptions.shipping_address_id.
--   PostgreSQL bloquea TRUNCATE en tablas referenciadas por FK (aunque no
--   haya filas que apunten), y TRUNCATE ... CASCADE borraria esas tablas
--   (inaceptable). Se usa DELETE, que respeta las FKs: como 0 filas
--   referencian customer_addresses, el DELETE pasa sin error.
--
-- Tiempo estimado: <1 segundo (2,613 filas).
-- Reversible: NO. Hacer backup antes si se requiere.
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 1) Sanity check inicial
SELECT
    'inicial' AS estado,
    COUNT(*) AS total,
    COUNT(DISTINCT customer_id) AS customers_unicos
FROM tonic.customer_addresses;

-- 2) Verificar FKs no referenciadas (seguridad)
SELECT 'orders FKs' AS check_name, COUNT(*) AS apuntan_a_addr
FROM tonic.orders WHERE shipping_address_id IS NOT NULL
UNION ALL
SELECT 'subs FKs', COUNT(*)
FROM tonic.customer_subscriptions WHERE shipping_address_id IS NOT NULL;
-- Esperado: ambas 0. Si > 0, ABORTAR y revisar.

-- 3) Deshabilitar audit trigger durante DELETE masivo
ALTER TABLE tonic.customer_addresses DISABLE TRIGGER audit_customer_addresses;

-- 4) DELETE (no TRUNCATE: FKs de orders/customer_subscriptions lo bloquean)
DELETE FROM tonic.customer_addresses;

-- 5) Re-habilitar trigger
ALTER TABLE tonic.customer_addresses ENABLE TRIGGER audit_customer_addresses;

-- 6) Verificar vacio
SELECT 'post_delete' AS estado, COUNT(*) AS total FROM tonic.customer_addresses;
-- Esperado: 0

COMMIT;

-- ============================================================================
-- BACKUP (correr ANTES del DELETE si se desea poder revertir)
-- ============================================================================
-- CREATE TABLE tonic.customer_addresses_backup_20260521 AS
-- SELECT * FROM tonic.customer_addresses;
--
-- Rollback post-DELETE:
-- INSERT INTO tonic.customer_addresses SELECT * FROM tonic.customer_addresses_backup_20260521;
-- ============================================================================

-- ============================================================================
-- NOTAS DE IMPACTO
-- ============================================================================
-- - Locking: DELETE toma ROW EXCLUSIVE; lecturas concurrentes OK.
-- - audit_log: con trigger deshabilitado durante DELETE no se genera ruido.
-- - DELETE respeta las FKs: si alguna fila estuviera referenciada por
--   orders/customer_subscriptions, fallaria. Verificado que 0 filas
--   referencian -> DELETE pasa limpio.
-- - Despues del DELETE, ejecutar phase-05 re-poblara con legacy_id y
--   labels deterministicos por customer.
-- - Opcional: VACUUM ANALYZE tonic.customer_addresses tras el DELETE.
-- ============================================================================
