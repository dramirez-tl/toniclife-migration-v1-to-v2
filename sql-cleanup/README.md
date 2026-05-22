# SQL Cleanup — Pre-Migración Re-run

Scripts SQL de **un solo uso** para limpiar datos duplicados en v2 (`toniclife_db_v2`) antes de re-ejecutar la migración v1→v2.

## ⚠️ ANTES DE EJECUTAR

1. Base de datos es producción real (`34.70.18.38/toniclife_db_v2`). No hay backup automático.
2. Cada script tiene bloques `UP` (acción) y `DOWN` (rollback). El `DOWN` no siempre es completamente reversible — se documentan los casos.
3. Ejecuta dentro de transacciones (`BEGIN; ... COMMIT;`) — si algo se ve mal antes de `COMMIT`, haz `ROLLBACK`.
4. Cada script imprime conteos antes/después como sanity check.

## Orden de ejecución

| Paso | Script | Tabla | Propósito | Tiempo estimado |
|------|--------|-------|-----------|----------------|
| 1 | `01_dedup_access_logs.sql` | `access_logs` | Dedup 5.1M→1.7M filas (3× dupes por legacy_id) | ~2-5 min |
| 2 | `02_dedup_customer_addresses.sql` | `customer_addresses` | Dedup 2.6K→~537 filas (5× dupes por customer+label) | <1 seg |
| 3 | `03_dedup_product_exemptions.sql` | `product_exemptions` | Dedup ~455× dupes por (product_id, exemption_type) | <2 seg |
| 4 | `04_dedup_customer_social_profiles.sql` | `customer_social_profiles` | Dedup ~3-6× dupes por (customer_id, platform) | <2 seg |
| 5 | `../../toniclife-api/sql/migrations/039_uniques_for_migration_idempotency.sql` | varias | Agrega UNIQUE constraints + legacy_id columns para idempotencia | ~1-2 min |

**No saltes pasos.** El paso 3 requiere que 1 y 2 estén completos (las UNIQUE constraints fallarían con datos duplicados).

## Después de ejecutar

- Verifica conteos con queries al final de cada script.
- Procede con `node index.js -p <fase>` para re-correr fases refactorizadas.
- Los re-runs ahora harán `ON CONFLICT (col) DO UPDATE`, no acumularán duplicados.
