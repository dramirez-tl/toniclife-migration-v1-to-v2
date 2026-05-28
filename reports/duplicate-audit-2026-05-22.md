# Auditoría de duplicados v1→v2 — BD + GCS

**Fecha:** 2026-05-22 · **Alcance:** base de datos v2 (`toniclife_db_v2` / schema `tonic`) y bucket GCS (`toniclife-prod`) · **Tipo:** read-only (auditoría + detección). Esta auditoría **no modificó** datos ni esquema.

---

## 1. Veredicto

- **Base de datos: prácticamente limpia.** Solo **13 filas duplicadas reales** en toda la BD (de ~50M filas): `shopping_cart_items` (11) y `purchase_order_cost_centers` (2). El resto de tablas con volumen están en 0 duplicados o protegidas por la BD.
- **GCS: archivos migrados y enlazados, pero con duplicación de contenido.** El bucket tiene **2,547 archivos (~39 GB)**. `product_images` (1,959) y documentos de clientes (568) están subidos y correctamente referenciados desde la BD. Hay **1,350 archivos redundantes por contenido** (la misma imagen reusada en muchos productos) y **facturas (XML) NO migradas** (5,832 siguen en `tonic-life.net`).

> El miedo original ("no quiero registros duplicados ni en BD ni en GCS") se confirma **mayormente infundado en BD**; en GCS el único "duplicado" real es la reutilización de la misma imagen entre productos (no basura, no re-subidas accidentales).

---

## 2. Acceso a las bases (estado de conexiones)

| Conexión | Servidor | Estado |
|---|---|---|
| MCP `postgres-qa` | v1 LEGACY `136.116.247.253` (schema `toniclife`, tablas `t_*`) | ✅ funciona |
| MCP `postgres` | v2 `34.70.18.38` / `toniclife_db_v2` (schema `tonic`, PG 16.11) | ❌ roto: `self-signed certificate` |

**Causa del fallo v2:** la cadena del MCP usa `?sslmode=require` y la librería `pg` de Node valida el cert autofirmado de AlloyDB.
**Fix:** en `~/.claude.json`, server `postgres`, cambiar `sslmode=require` → `sslmode=no-verify` y **reiniciar Claude Code** (los MCP se cargan al inicio).
**Workaround usado en esta auditoría:** `psql` 18.1 con `sslmode=require` (libpq cifra pero **no** verifica el cert) → conexión read-only directa a v2.

---

## 3. Base de datos — hallazgos

### 3.1 La mayoría de tablas son inmunes a duplicados
El schema `tonic` tiene **120 UNIQUE constraints**. En esas tablas el duplicado es **imposible** (la BD lo rechaza). La auditoría se concentró en las que **no** tienen UNIQUE de negocio (solo PK uuid) o tienen UNIQUE **parcial** (`WHERE legacy_id IS NOT NULL`, que se brinca filas con clave NULL).

### 3.2 Dashboard de duplicados reales (vía `sql-cleanup/00_detect_duplicates.sql`)

| Tabla | Clave de negocio | Total | Filas sobrantes | Filas clave NULL |
|---|---|---:|---:|---:|
| `shopping_cart_items` | (cart_id, product_id) | 6,866 | **11** | 0 |
| `purchase_order_cost_centers` | (purchase_order_id, cost_center_id) | 3 | **2** | 0 |
| `inventory_count_details` | (count_id, product_id) | 58 | 0 | 0 |
| `network_members` | legacy_id | 218,899 | 0 | 0 |
| `network_sponsor_overrides` | legacy_id | 215,895 | 0 | 0 |
| `network_upline_overrides` | legacy_id | 215,895 | 0 | 0 |
| `product_images` | (product_id, filename) | 1,959 | 0 | 0 |

- `network_sponsor_overrides` / `network_upline_overrides` (216K c/u) **no** tienen UNIQUE sobre `legacy_id`, pero hoy están **limpias** (corrieron una sola vez).
- `customer_addresses`: **0 filas** — el cleanup `02` (DELETE total) ya corrió; re-migración pendiente.
- `notifications` (2,361): sin clave natural. Una heurística detecta 2,262 notificaciones `sale_ecommerce` idénticas en el mismo segundo, pero con `entity_id`/`created_by` NULL → **probablemente legítimas** (una por destinatario), **no** duplicados confirmados. Requiere revisión manual si preocupa.

### 3.3 Estado previo confirmado
- Los cleanups `01`–`04` (access_logs, customer_addresses, product_exemptions, customer_social_profiles) **ya se aplicaron** (existe `access_logs_backup_20260519`, `customer_addresses`=0, etc.).
- La migración **`039_uniques_for_migration_idempotency.sql` ya está aplicada** en prod (sus índices únicos parciales existen en vivo).

---

## 4. GCS — hallazgos (vía `reports/detect-gcs-duplicates.js`)

Bucket `toniclife-prod`: **2,547 blobs, ~39 GB**.

| Prefijo | Blobs | Estado |
|---|---:|---|
| `products/images/{product_images.id}/...` | 1,959 | ✅ subidos y enlazados (`image_url` = URL completa de GCS) |
| `customers/{legacy_id}/{slot}/...` | 568 | ✅ subidos y enlazados; los 397 clientes con docs existen en v2 |
| `courses/` | 5 | módulo cursos (no migración de archivos) |
| `marketing/` | 14 | módulo marketing (no migración) |
| `purchase-orders/` | 1 | OC con adjunto |

**Conclusiones GCS:**
1. **No hay ruptura de enlace BD↔GCS para productos/clientes.** 2,528 de 2,547 blobs están referenciados por la BD; los 19 "huérfanos" son `courses/` + `marketing/` (los gestionan otros módulos, no la migración).
2. 🚩 **Duplicación de contenido: 333 grupos por `md5` = 1,350 archivos redundantes**, casi todos en `products/images/`. Es la **misma imagen** reutilizada por muchos productos (ej. un banner en 79 productos), cada uno con su propia copia bajo su carpeta. **No es basura ni re-subida accidental:** cada copia está referenciada por su producto. Eliminarlas requiere un rediseño de almacenamiento por contenido (content-addressed) y **NO** es seguro borrar masivamente.
3. **Facturas (XML) NO migradas:** `invoices.xml_file_path` (5,832) sigue apuntando a `tonic-life.net`; 0 blobs `invoices/` en el bucket. Esto es **completitud de migración pendiente**, no un duplicado.
4. `system_files.url` (11) apunta a `drive.google.com` (externo; probablemente intencional).
5. Ningún "slot" de archivo único (`customers/{id}/{slot}`) tiene >1 archivo.

Detalle completo y crudo en `reports/gcs-duplicates-2026-05-22.json`.

---

## 5. Riesgos a futuro (no son duplicados de hoy)

1. **`network_sponsor_overrides` / `network_upline_overrides`** (216K c/u): sin UNIQUE sobre `legacy_id` → un re-run de phase-06 **duplicaría**. → `sql-cleanup/07_harden_unique.sql`. **[MLM: confirmar antes de aplicar]**
2. **`product_images`**: las 1,959 tienen `legacy_id NULL` → el índice único parcial de la migración 039 es **inerte** para ellas. Fueron creadas por un proceso que usa `product_images.id` como carpeta (no por phase-04, que setea `legacy_id`). Si se corre phase-04 de imágenes, definir cómo poblar `legacy_id` o se generarán duplicados/colisiones.
3. **`shopping_cart_items` / `purchase_order_cost_centers`**: sin dedup → origen de las 13 filas. → cleanup `05`/`06` + hardening `07`.

---

## 6. Fuera de alcance (decisión del usuario)

**Roles y permisos del personal interno NO se migran** (la estructura legacy "está hecha un cochinero"). Solo cuentan **clientes/distribuidores**; el staff queda sin rol/permisos en v2 y se asignará a mano desde el admin de V2. Esta auditoría **no tocó** `tonic.roles`, `tonic.permissions`, `tonic.role_permissions` ni los `role_id` del staff.

---

## 7. Entregables producidos

| Archivo | Qué es | Ejecuta |
|---|---|---|
| `reports/duplicate-audit-2026-05-22.md` | Este reporte | — |
| `reports/detect-gcs-duplicates.js` | Escáner GCS **read-only** (list + md5 + cruce BD) | `node reports/detect-gcs-duplicates.js` |
| `reports/gcs-duplicates-2026-05-22.json` | Resultado crudo del escaneo | — |
| `sql-cleanup/00_detect_duplicates.sql` | Detección BD **solo SELECT** (dashboard reusable) | el usuario, en DBeaver/psql |
| `sql-cleanup/05_dedup_shopping_cart_items.sql` | Limpieza 11 filas (UP/DOWN) | el usuario, **no ejecutado** |
| `sql-cleanup/06_dedup_purchase_order_cost_centers.sql` | Limpieza 2 filas (UP/DOWN) | el usuario, **no ejecutado** |
| `sql-cleanup/07_harden_unique.sql` | Índices únicos preventivos (UP/DOWN) | el usuario, **no ejecutado** |

---

## 8. Siguientes pasos sugeridos (decide el usuario; nada se ejecuta solo)

1. **(Opcional) Limpiar las 13 filas:** revisar el paso 0 de `05`/`06` (las copias pueden diferir en montos/cantidades) y, si procede, correr en DBeaver dentro de `BEGIN…COMMIT`.
2. **(Opcional) Endurecer:** tras la limpieza, correr `07` (con la cautela MLM). Idealmente **promoverlo a `toniclife-api/sql/migrations/040_*.sql`** para versionarlo junto a 039.
3. **GCS — facturas:** decidir si migrar los 5,832 XML de `tonic-life.net` a GCS (completitud), tema aparte de duplicados.
4. **GCS — imágenes redundantes:** evaluar (a futuro) almacenamiento por contenido para no guardar 1,350 copias del mismo archivo. NO borrar masivamente.
5. **Arreglar el MCP `postgres`** (`sslmode=no-verify` + reiniciar) para futuras sesiones read-only sobre v2.
