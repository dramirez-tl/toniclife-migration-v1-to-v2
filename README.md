# TonicLife ERP — Migracion de Base de Datos v1 a v2

Script de migracion completa del sistema TonicLife ERP desde la base de datos legacy (v1) hacia el nuevo esquema normalizado (v2).

- **Origen (v1):** PostgreSQL en Google Cloud (`136.116.247.253`), schema `toniclife`, IDs tipo `bigint`
- **Destino (v2):** PostgreSQL AlloyDB en Google Cloud (`34.70.18.38`), schema `tonic`, IDs tipo `UUID`
- **Volumen:** ~77 millones de registros en 131 tablas v1 → ~85 tablas v2
- **Motor:** Node.js con driver `pg` nativo y cursores server-side
- **Archivos:** Descarga desde `tonic-life.net` y sube a Google Cloud Storage (bucket `toniclife-prod`)

---

## Tabla de Contenido

- [Requisitos Previos](#requisitos-previos)
- [Instalacion](#instalacion)
- [Variables de Entorno](#variables-de-entorno-env)
- [Uso del CLI](#uso-del-cli)
- [Fases de Migracion](#fases-de-migracion)
- [Google Cloud Storage](#google-cloud-storage-gcs)
- [Arquitectura Tecnica](#arquitectura-tecnica)
- [Modulos de Utilidades](#modulos-de-utilidades)
- [Mapeos de Datos](#mapeos-de-datos)
- [Idempotencia y Re-ejecucion](#idempotencia-y-re-ejecucion)
- [Reportes](#reportes)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Troubleshooting](#troubleshooting)

---

## Requisitos Previos

| Requisito | Version minima |
|-----------|----------------|
| Node.js | 18+ |
| npm | 9+ |
| PostgreSQL (v2 destino) | 14+ |
| Acceso de red a v1 | Puerto 5432 abierto |
| Acceso HTTP a tonic-life.net | Para descarga de archivos (si GCS habilitado) |

La base de datos v2 debe tener el schema `tonic` ya creado con todas las tablas, constraints, triggers y funciones. Este script **no crea el schema**; solo migra los datos.

---

## Instalacion

```bash
# 1. Entrar al directorio del proyecto
cd migration

# 2. Instalar dependencias
npm install

# 3. Copiar el archivo de configuracion
cp .env.example .env

# 4. Editar .env con las credenciales reales
#    (ver seccion "Variables de Entorno" mas abajo)
```

### Dependencias

| Paquete | Version | Proposito |
|---------|---------|-----------|
| `pg` | ^8.13.1 | Driver PostgreSQL nativo |
| `pg-cursor` | ^2.12.1 | Cursores server-side para tablas grandes |
| `dotenv` | ^16.4.7 | Carga de variables de entorno desde `.env` |
| `bcrypt` | ^6.0.0 | Hashing de contrasenas (compatible con NestJS v2) |
| `slugify` | ^1.6.6 | Generacion de slugs URL-safe para productos |
| `@google-cloud/storage` | ^7.19.0 | Subida de archivos a Google Cloud Storage |

---

## Variables de Entorno (.env)

```env
# ============================================
# Base de Datos v1 — Origen (Google Cloud)
# ============================================
V1_HOST=136.116.247.253       # IP o hostname del servidor v1
V1_PORT=5432                   # Puerto PostgreSQL (default: 5432)
V1_DATABASE=postgres           # Nombre de la base de datos v1
V1_SCHEMA=toniclife            # Schema de las tablas v1
V1_USER=                       # ** OBLIGATORIO ** Usuario con permisos SELECT
V1_PASSWORD=                   # ** OBLIGATORIO ** Contrasena del usuario v1

# ============================================
# Base de Datos v2 — Destino (AlloyDB)
# ============================================
V2_HOST=34.70.18.38            # IP o hostname del servidor v2
V2_PORT=5432                   # Puerto PostgreSQL (default: 5432)
V2_DATABASE=toniclife_db_v2    # Nombre de la base de datos v2
V2_SCHEMA=tonic                # Schema destino
V2_USER=                       # ** OBLIGATORIO ** Usuario con permisos FULL
V2_PASSWORD=                   # ** OBLIGATORIO ** Contrasena del usuario v2

# ============================================
# Encriptacion de contrasenas
# ============================================
KEY_GCM=                       # ** OBLIGATORIO ** Llave usada historicamente (bcrypt no la necesita, pero config la valida)

# ============================================
# Configuracion de migracion
# ============================================
BATCH_SIZE=5000                # Registros por lote para tablas grandes (default: 5000)
LOG_LEVEL=info                 # Nivel de log: debug, info, warn, error (default: info)

# ============================================
# Google Cloud Storage (opcional)
# ============================================
GCS_ENABLED=false              # true para subir archivos a GCS, false para usar URLs legacy
GCS_PROJECT_ID=                # ID del proyecto en Google Cloud
GCS_BUCKET_NAME=               # Nombre del bucket (ej: toniclife-prod)
GCS_CREDENTIALS=               # JSON completo del service account (una linea)
GCS_CONCURRENCY=8              # Descargas/subidas simultaneas (default: 8)
GCS_RETRY_ATTEMPTS=3           # Reintentos por archivo fallido (default: 3)
```

Las variables marcadas como **OBLIGATORIO** deben tener valor. El script no iniciara si faltan.

Las variables `GCS_*` son **opcionales**. Si `GCS_ENABLED` no es `true`, los archivos se migran como URLs con prefijo `https://tonic-life.net/assets/...` en lugar de subirse a GCS.

---

## Uso del CLI

### Ejecutar todas las fases

```bash
node index.js
```

Ejecuta las 16 fases en orden: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 10b → 11 → 12 → 13 → 99.

### Ejecutar una fase especifica

```bash
node index.js --phase 4
node index.js -p 4              # Atajo equivalente
```

### Ejecutar multiples fases

```bash
node index.js --phase 0 -p 1 -p 2
node index.js -p 5 -p 6 -p 7
```

Las fases se ejecutan en el orden en que se especifican.

### Solo validacion post-migracion

```bash
node index.js --validate
```

Ejecuta unicamente la fase 99 (conteos, integridad referencial, consistencia de red MLM).

### Ejecutar todo excepto validacion

```bash
node index.js --skip-validation
```

Ejecuta fases 0-13 sin la fase 99 al final.

### Vista previa sin ejecutar

```bash
node index.js --dry-run
```

Verifica la conexion a ambas bases de datos y muestra el plan de ejecucion sin modificar ningun dato.

### Ayuda

```bash
node index.js --help
```

### Usando npm scripts

```bash
npm run migrate                 # Equivale a node index.js
npm run validate                # Equivale a node index.js --validate
```

---

## Fases de Migracion

### Fase 0 — Infraestructura

Prepara la base v2 para recibir datos. No migra registros.

- Deshabilita **todos** los triggers de auditoria (120+) y auto-numeracion (9 triggers)
- Crea indices UNIQUE faltantes en `network_members.legacy_id` y `network_branch_assignments.legacy_id`
- Elimina temporalmente CHECK constraints que bloquean la migracion:
  - `chk_network_members_root_depth` (red MLM requiere insercion en 4 pasos)
  - `chk_stock_levels_qty_on_hand` (v1 puede tener cantidades negativas)
- Verifica existencia de registros pre-poblados en `tenant_config`, `isr_brackets`, `sequence_counters`
- Inserta registro default de `invoice_providers` (Facturama)
- Inserta 6 registros en `commission_tax_regimes` (ASIMILADOS, FIC, RESICO, MORAL, FRONTERIZA, SIN_IMPUESTO)

### Fase 1 — Catalogos Base (~200 registros, 10 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_country` | `countries` | ~10 | |
| `t_type_money` | `currencies` | ~5 | |
| `t_type_price` | `price_types` | ~5 | |
| `t_type_document` | `document_types` | ~10 | |
| `t_type_format_pay` | `payment_methods` | ~10 | Infiere `payment_type` (cash, card, bank_transfer, etc.) |
| `t_tax` | `tax_rules` | ~5 | Rate convertido de porcentaje a decimal (/100) |
| `t_dispatch` | `dispatch_types` | ~10 | |
| `t_exchange` | `exchange_rates` | ~100 | Calcula `inverse_rate` |
| `t_cfdi` | `sat_cfdi_uses` | ~30 | |
| `t_regimen` | `sat_tax_regimes` | ~10 | |

### Fase 2 — Sucursales (~40 registros, 2 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_branch_office` | `branches` | ~20 | 2 pasos: INSERT sin parent, UPDATE parent_branch_id |
| `t_branch_office_tax` | `branch_tax_rules` | ~20 | |

Transformaciones:
- `rounding_mode`: mapeo 1→half_up, 2→half_down, 3→floor, 4→ceil, 5→none
- `currency_code`: inferido de `id_type_money`
- `parent_branch_id`: INSERT sin parent (self-ref), luego UPDATE via `id_branch_office_stock`

### Fase 3 — Seguridad y Acceso (~219K registros, 7 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_profile` | `roles` | ~10 | |
| `t_tags_items` | `permissions` | ~50 | Resolucion parent por codigo, tipo menu/action |
| `t_tags_items_profile` | `role_permissions` | ~200 | Solo enabled=1 |
| `t_tags_items_profile_action` | `role_permissions` | ~200 | Permisos a nivel de accion |
| `t_worker` | `workers` | ~50 | |
| `t_users` | `users` | **~219K** | Batch processing |
| `t_users_branch_office` | `user_branches` | ~200 | |

Transformaciones clave para `users`:
- **Contrasenas**: Hash con bcrypt (cost=10), compatible con `bcrypt.compare()` del backend NestJS
- Usuarios sin contrasena reciben password temporal + `must_change_password = true`
- `is_migrated_user = true` para todos los usuarios migrados
- `status`: enabled_user=1 → 'active', enabled_user=0 → 'inactive'
- `customer_id`: resuelto via `customers.legacy_id` (se llena en post-step de fase 05)
- `worker_id`: resuelto via legacy_id_map (entidad "worker")
- `role_id`: resuelto desde `t_users.id_profile`, remapeado en fase 99

### Fase 4 — Productos (~887K registros, 13 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_clasification` | `product_categories` | ~30 | Slug unico: name-id |
| `t_product_unit` | `product_units` | ~10 | |
| `t_component` | `components` | ~10 | type=ingredient default |
| `t_organ` | `health_organs` | ~20 | |
| `t_diseases` | `health_conditions` | ~30 | |
| `t_product` | `products` | **~118K** | Batch. Slug unico con contador |
| `t_product_price` | `product_prices` | **~324K** | Batch. UNIQUE(product_id, price_type_id, currency) |
| `t_product_photo` | `product_images` | ~500 | **GCS upload** de imagenes |
| `t_product_lot` | `product_lots` | **~138K** | Batch. Status: available/expired por fecha |
| `t_product_component` | `product_components` | ~5K | |
| `t_product_tax` | `product_taxes` | ~200 | |
| `t_product_exempt` | `product_exemptions` | ~50 | Tipo: iva/ieps/all |
| `t_product_stock_snapshot` | `stock_levels` | **~306K** | Batch. Default branch_id=1 |

Transformaciones:
- `product_type`: inferido de flags `is_kit`/`is_promo` → finished_good, kit, promotional
- `long_description`: combinacion de benefits + dosis + observation
- `image_url` (product_images): archivo subido a GCS si habilitado

### Fase 5 — Clientes y Distribuidores (~600K registros, 10 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_plan` | `mlm_ranks` | ~10 | |
| `t_nivel` | `mlm_level_commissions` | ~20 | |
| `t_generation` | `mlm_generation_commissions` | ~5 | |
| `t_customers` | `customers` | **~218K** | Batch. 2 pasos (self-refs). **GCS upload** (5 docs) |
| `t_customers_address` | `customer_addresses` | ~100K | Batch |
| `t_customers_bank` | `customer_bank_accounts` | ~50K | |
| `t_customers_cedea` | `cedea_contracts` | ~5K | UNIQUE(customer_id, branch_id) |
| `t_customers_social` | `customer_social_profiles` | ~100K | Plataforma inferida |
| `t_customers_kit_cart` | `customer_kit_cart` | ~10K | |
| `t_subscriptions` | `customer_subscriptions` | ~5K | PAYPAL/MERCADO_PAGO → monthly_autoship |

Transformaciones clave para `customers`:
- **2 pasos**: INSERT sin `sponsor_id`/`upline_id`, luego UPDATE (FKs auto-referenciales)
- **5 documentos a GCS**: photo, contract, INE, bank_statement, tax_id
- `status`: id_status 1→active, 2→inactive, 3→suspended, otro→pending
- `kit_type`: 1→basic, 2→premium
- `language_code`: id_language 1→es, 2→en
- Defaults: `branch_id` → legacy 1, `price_type_id` → legacy 1
- Post-step: UPDATE `users.customer_id` para vincular usuarios con clientes

### Fase 6 — Red MLM (~218K nodos, 5 tablas) — LA MAS COMPLEJA

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_red` (nivel=1) | `network_members` | **~218K** | 4 pasos (ver abajo) |
| `t_red_roll_over` (nivel=1) | `network_roll_over` | ~218K | Misma denormalizacion que t_red |
| `t_red_custom_sponsor` | `network_sponsor_overrides` | ~215K | Legacy_id=hijo, clave sintetica |
| `t_red_custom_upline` | `network_upline_overrides` | ~215K | Legacy_id=hijo, clave sintetica |
| `t_red_sucursales` | `network_branch_assignments` | ~20 | |

**Algoritmo de 4 pasos para `network_members`:**

1. **INSERT sin relaciones**: Solo registros con `nivel=1` de `t_red`. Se insertan con `parent_id=NULL, depth=0, sponsor_member_id=NULL`
2. **UPDATE parent_id**: Resuelve `id_upline` (id_customers) → customer UUID → network_member UUID del padre
3. **UPDATE sponsor_member_id**: Resuelve via `customers.sponsor_id` → network_member del sponsor
4. **Recalculo recursivo**: CTE recursivo desde nodos raiz para recalcular `depth`, `path`, `path_legacy`, `children_count`. Para 218K nodos puede requerir `SET work_mem = '512MB'`

> Despues del paso 4 se restaura el CHECK constraint `chk_network_members_root_depth` en fase 99.

### Fase 7 — Ventas y Documentos (~6.4M registros, 7 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_promo` | `promotions` | ~50 | Tipo inferido de flags |
| `t_promo_det` | `promotion_items` | ~200 | |
| `t_cart` | `shopping_carts` | ~5K | Tipo: regular/public/customer_kit |
| `t_cart_det` | `shopping_cart_items` | ~20K | |
| `t_document` | `orders` | **~1.75M** | Batch. Mayor volumen transaccional |
| `t_document_det` | `order_items` | **~4.6M** | Batch |
| `t_sale_tracker` | `order_shipments` | ~50K | Status mapping |

Transformaciones para `orders`:
- `status`: anulado=0→confirmed, anulado=1→cancelled
- `source`: mapeo de source_doc a valores CHECK (pos, ecommerce, app, phone, other)
- `order_number`: formato "MIG-{legacy_id}" (trigger deshabilitado, se provee explicitamente)
- `shipping_address_snapshot` (jsonb): construido de columnas de direccion de t_document
- Resolucion de FKs: period_id, document_type_id, payment_method_id(s), dispatch_type_id, sponsor_customer_id

### Fase 8 — Facturacion (~355K registros, 4 fuentes)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_factura_libre` | `invoices` (tipo=sale) | ~100K | **GCS upload** XMLs |
| `t_factura_libre_det` | `invoice_items` | ~200K | |
| `t_bono_facturama` | `invoices` (tipo=commission) | ~50K | legacy_id offset +10M. **GCS upload** XMLs |
| `t_bono_cedea_facturama` | `invoices` (tipo=cedea) | ~5K | legacy_id offset +20M |

Detalles:
- Provider default: Facturama (insertado en fase 0)
- XMLs de facturas se suben a GCS: `invoices/xml/{id}/`
- `provider_status`: stamped si tiene facturama_id, pending si no
- ISR se mapea a `tax_amount`

### Fase 9 — Comisiones (~4M+ registros, 6 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_period` | `commission_periods` | ~50 | Status: open/closed |
| `t_customers_period_v2` / `t_customers_period` | `customer_period_stats` | ~218K/periodo | Fallback logic |
| `t_customers_plan_history` | `rank_history` | ~100K | Minimo: customer, plan, period |
| `t_customers_paid` | `commission_payments` | **~1.1M** | |
| `t_period_commisions` | `commission_calculations` | ~100K | type→mlm |
| `t_period_commisions_det` | `commission_details` | **~1.9M** | Batch. Vincula earner y generator |

> **Excluidos** de esta migracion: `t_period_red` (~29.8M), `t_period_red_roll_over` (~32M), `t_period_first_level` (~1.9M) — snapshots de red sin logica en backend v2.

### Fase 10 — Inventario (~5K registros, 2 tablas)

| v1 | v2 | ~Registros |
|---|---|---|
| `t_inventory` | `inventory_counts` | ~100 |
| `t_inventory_det` | `inventory_count_details` | ~5K |

### Fase 10b — Proveedores y Compras (~370 registros, 5 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_company` | `company_entities` | ~5 | |
| `t_cost_centers` | `cost_centers` | ~20 | |
| `t_suppliers` | `suppliers` | ~50 | |
| `t_supplier_requests` | `purchase_orders` | ~200 | **GCS upload** archivos adjuntos |
| `t_supplier_request_cost_centers` | `purchase_order_cost_centers` | ~100 | |

### Fase 11 — Recursos Humanos (~2K registros, 9 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_job` | `job_positions` | ~20 | |
| `t_departments` | `departments` | ~10 | |
| `t_area` | `work_areas` | ~10 | |
| `t_employees` | `employees` | ~100 | 2 pasos: supervisor_id self-ref |
| `t_holidays` | `holidays` | ~50 | |
| `t_vacation_rules` | `vacation_rules` | ~10 | |
| `t_vacation` | `vacation_requests` | ~500 | Status: approved/pending/rejected |
| `t_vacation_dates` | `vacation_request_dates` | ~1K | |
| `t_vacation_accrual_log` | `vacation_balances` | ~500 | |

### Fase 12 — Comunicacion (~60K registros, 2 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_notification` | `notifications` | ~10K | |
| `t_notification_read` | `notification_reads` | ~50K | Sin PK en v1, idempotencia via NOT EXISTS |

### Fase 13 — Auditoria y Logs (~1.6M registros, 3 tablas)

| v1 | v2 | ~Registros | Notas |
|---|---|---|---|
| `t_logs` | `access_logs` | **~1.6M** | Batch. Mapeo de action y device_type |
| `t_file` | `system_files` | ~1K | **GCS upload**. Tipo inferido de extension |
| `t_text` | `system_settings` | 4 | Tipo inferido de JSON parsing |

Transformaciones para `access_logs`:
- `action`: mapeo login/logout/login_failed/refresh_session/password_reset/token_refresh
- `device_type`: inferido de user_agent (mobile/tablet/desktop/api/unknown)
- `metadata`: JSON con legacy_id original

Transformaciones para `system_files`:
- `file_type`: inferido de URL/extension (pdf, image, drive_link, video, document, other)
- URLs externas (Google Drive, YouTube) se mantienen tal cual, no se suben a GCS

### Fase 99 — Post-Migracion y Validacion

No migra registros. Ejecuta 11 pasos de validacion y restauracion:

1. **Backfill de emails**: Actualiza `users.email` desde `customers.email` para usuarios migrados que no tienen email
2. **Remapeo de roles**: Asigna roles v2 basados en contexto:
   - Usuarios con `customer_id` → rol 'customer'
   - Workers con roles legacy → roles funcionales v2 (admin, manager, cashier, etc.)
   - Fallback → rol 'viewer'
3. **Re-habilitar triggers**: Reactiva todos los triggers de auditoria deshabilitados en fase 0
4. **Restaurar CHECK constraints**: `chk_network_members_root_depth` y `chk_stock_levels_qty_on_hand`
5. **Actualizar sequence_counters**: Para que folios automaticos continuen correctamente (customer_number, order_number, invoice_number, employee_number, vacation_request_number)
6. **Validar conteos**: Compara conteos v1 vs v2 en 19 tablas clave (timeout 60s por tabla)
7. **Verificar integridad referencial**: Busca FKs huerfanos en 8 relaciones criticas
8. **Verificar consistencia de red MLM**: 5 checks (depth rules, path, children_count, ciclos)
9. **Spot-check**: Muestreo aleatorio cruzando registros v1 vs v2
10. **Resumen de legacy_id_map**: Conteo por entity_type
11. **Reporte final**: Pass/fail con detalle de problemas encontrados

---

## Google Cloud Storage (GCS)

### Descripcion

Cuando `GCS_ENABLED=true`, el script descarga archivos desde `https://tonic-life.net/assets/...` y los sube al bucket de Google Cloud Storage configurado. En la base de datos v2 se guarda **solo el path de GCS** (sin URL completa), ya que el backend genera URLs firmadas (signed URLs) al servir los archivos.

### Tablas con archivos

| Fase | Tabla v1 | Columna v1 | Tabla v2 | Columna v2 | Path GCS | ~Archivos |
|------|----------|-----------|----------|-----------|----------|-----------|
| 04 | `t_product_photo` | `file_photo` | `product_images` | `image_url` | `products/images/{id}/` | ~500 |
| 05 | `t_customers` | `file_photo_customers` | `customers` | `photo_url` | `customers/{id}/photo/` | ~329 |
| 05 | `t_customers` | `file_contract` | `customers` | `contract_url` | `customers/{id}/contract/` | ~0 |
| 05 | `t_customers` | `file_ine` | `customers` | `ine_document_url` | `customers/{id}/ine/` | ~87 |
| 05 | `t_customers` | `file_cuenta_bancaria` | `customers` | `bank_statement_url` | `customers/{id}/bank-statement/` | ~66 |
| 05 | `t_customers` | `file_constancia_fiscal` | `customers` | `tax_id_document_url` | `customers/{id}/tax-id/` | ~82 |
| 08 | `t_factura_libre` | `name_path` | `invoices` | `xml_file_path` | `invoices/xml/{id}/` | ~5,791 |
| 08 | `t_bono_facturama` | `path_file` | `invoices` | `xml_file_path` | `invoices/xml/bono-{id}/` | variable |
| 10b | `t_supplier_requests` | `file_path` | `purchase_orders` | `file_url` | `purchase-orders/{id}/` | ~1 |
| 13 | `t_file` | `url_file/path_file` | `system_files` | `url` | `system-files/{id}/` | ~11 |

### Organizacion de paths en GCS

```
toniclife-prod/
├── products/images/{id_product}/{filename}
├── customers/{id_customers}/
│   ├── photo/{filename}
│   ├── contract/{filename}
│   ├── ine/{filename}
│   ├── bank-statement/{filename}
│   └── tax-id/{filename}
├── invoices/xml/{id_factura_libre}/{filename}
├── invoices/xml/bono-{id_bono_factura}/{filename}
├── purchase-orders/{id}/{filename}
└── system-files/{id_file}/{filename}
```

### Comportamiento por escenario

| Escenario | Comportamiento |
|-----------|----------------|
| `GCS_ENABLED=false` | Todo usa `prefixUrl()` — URLs tipo `https://tonic-life.net/assets/...` |
| Credenciales invalidas | `init()` retorna false, fallback automatico a `prefixUrl()` |
| HTTP 404 (archivo no existe en v1) | Retorna null, el registro se inserta sin URL |
| HTTP 5xx / timeout | Retry con backoff exponencial (1s, 2s, 4s), si falla → fallback a `prefixUrl()` |
| Error de upload a GCS | Retry con backoff, si falla → fallback a `prefixUrl()` |
| URL externa (Google Drive, YouTube) | Se retorna tal cual, sin intentar subir |
| Archivo ya existe en GCS | Skip upload, retorna el path existente (idempotente) |
| Valor NULL en columna de archivo | Retorna null |

**Garantia critica:** Un fallo de archivo NUNCA impide la insercion del registro de datos.

### Verificacion de archivos migrados

```sql
-- Ver resumen de archivos GCS vs legacy por tabla
SELECT 'product_images' AS tabla,
  COUNT(*) FILTER (WHERE image_url LIKE 'products/%') AS gcs,
  COUNT(*) FILTER (WHERE image_url LIKE 'http%') AS legacy_url,
  COUNT(*) FILTER (WHERE image_url IS NULL) AS sin_archivo
FROM tonic.product_images;
```

---

## Arquitectura Tecnica

### Flujo de ejecucion

```
index.js (orquestador)
  │
  ├── Parseo de argumentos CLI
  ├── Carga de configuracion (config.js)
  ├── Creacion de pools de conexion (v1 read-only, v2 read-write)
  ├── Verificacion de conectividad
  ├── Inicializacion de GCS (si habilitado)
  │
  ├── Para cada fase seleccionada:
  │   ├── require(phase-XX.js)
  │   ├── Ejecutar fase con (v1Pool, v2Pool)
  │   ├── Acumular resultados {migrated, skipped, failed, errors}
  │   └── Continuar con siguiente fase si falla
  │
  ├── Resumen final en consola
  ├── Generacion de reporte JSON + TXT
  └── Cierre de conexiones y exit code
```

### Pools de conexion

| Pool | Host | Max conexiones | SSL | Proposito |
|------|------|---------------|-----|-----------|
| v1Pool | 136.116.247.253 | 5 | No | Solo lectura (SELECT) |
| v2Pool | 34.70.18.38 | 10 | Auto (si no es localhost) | Lectura/escritura completa |

### Procesamiento por lotes

**Tablas grandes (>10K registros):** Cursor server-side de PostgreSQL.
- Lee `BATCH_SIZE` registros a la vez (default: 5000)
- Cada registro se procesa dentro de un SAVEPOINT individual
- Si un registro falla, el SAVEPOINT se revierte sin abortar el batch
- Barra de progreso en consola: `Migrando orders: 50,000/1,751,004 (2.85%)`

**Tablas pequenas (<10K registros):** Carga completa en memoria.
- Una sola transaccion con SAVEPOINTs por registro
- Mismo aislamiento de errores

### Resolucion de IDs

El modulo `id-resolver.js` maneja la traduccion de IDs legacy (bigint) a UUIDs v2:

1. **Cache en memoria** (Map): Busqueda O(1) — la mas rapida
2. **Columna legacy_id** en tabla destino v2: `SELECT id FROM tabla WHERE legacy_id = $1`
3. **Tabla legacy_id_map**: `SELECT new_id FROM legacy_id_map WHERE entity_type = $1 AND legacy_id = $2`

El cache se pre-calienta (warm-up) al inicio de cada fase con las entidades que necesitara.

### Manejo de triggers y constraints

La v2 tiene **120+ triggers de auditoria** que insertan snapshots en `audit_log` para cada INSERT/UPDATE/DELETE. Estos requieren contexto de sesion (`audit.user_id`, `audit.session_id`) que no existe durante la migracion.

Ademas hay **9 triggers de auto-numeracion** (customer_number, order_number, etc.) y **2 triggers de red MLM** (depth_path, children_count).

**Estrategia:**
- Fase 0: `ALTER TABLE tonic.X DISABLE TRIGGER ALL` en TODAS las tablas
- Migracion: INSERT/UPDATE libres sin overhead de triggers
- Fase 99: `ALTER TABLE tonic.X ENABLE TRIGGER ALL`

### Valores CHECK constraint respetados

Todos los INSERT deben coincidir con los valores CHECK de v2:

| Tabla.columna | Valores validos |
|---|---|
| `orders.source` | pos, ecommerce, ecommerce_pending, app, phone, other |
| `orders.status` | pending, confirmed, cancelled, returned, transferred |
| `customers.status` | active, inactive, suspended, pending |
| `customers.customer_type` | distributor, final_customer, preferred_customer |
| `products.product_type` | finished_good, raw_material, kit, service, promotional, material |
| `employees.status` | active, inactive, on_leave, terminated |
| `network_members` | `(depth=0 AND parent_id IS NULL) OR (depth>0 AND parent_id IS NOT NULL)` |

### FKs auto-referenciales (2 pasos)

Estas tablas tienen columnas que referencian a si mismas:

| Tabla | Columna self-ref | Estrategia |
|---|---|---|
| `customers.sponsor_id` | → customers.id | INSERT NULL, UPDATE despues |
| `customers.upline_id` | → customers.id | INSERT NULL, UPDATE despues |
| `network_members.parent_id` | → network_members.id | INSERT NULL, UPDATE paso 2 |
| `employees.supervisor_id` | → employees.id | INSERT NULL, UPDATE despues |
| `branches.parent_branch_id` | → branches.id | INSERT NULL, UPDATE despues |

---

## Modulos de Utilidades

### `utils/id-resolver.js` — Resolucion de IDs Legacy

Singleton que cachea y resuelve mapeos `legacy_id (bigint)` → `UUID`.

| Funcion | Firma | Descripcion |
|---------|-------|-------------|
| `warmUp` | `(v2Pool, entities[])` → void | Pre-carga cache desde tablas v2 y legacy_id_map |
| `resolve` | `(v2Pool, entityType, legacyId, tableName?)` → UUID/null | Resuelve legacy → UUID (cache → DB → map) |
| `set` | `(entityType, legacyId, newId)` → void | Registra mapeo solo en cache |
| `registerMapping` | `(v2Pool, entityType, legacyId, newId, legacyTable?, legacyData?)` → void | Persiste mapeo en legacy_id_map + cache |
| `getStats` | `()` → object | Retorna {hits, misses, notFound, cacheSize} |
| `clearCache` | `()` → void | Limpia cache y resetea estadisticas |

### `utils/batch-processor.js` — Procesamiento por Lotes

| Funcion | Firma | Descripcion |
|---------|-------|-------------|
| `processWithCursor` | `(opts)` → {migrated, skipped, failed, errors} | Tablas grandes: cursor server-side + SAVEPOINTs |
| `processSmallTable` | `(opts)` → {migrated, skipped, failed, errors} | Tablas pequenas: carga completa + SAVEPOINTs |
| `getCount` | `(v1Pool, query)` → number | Ejecuta COUNT(*) y retorna el numero |

Opciones de `processWithCursor` / `processSmallTable`:
- `v1Pool`, `v2Pool`: Pools de conexion
- `sourceQuery`: SQL a ejecutar en v1
- `tableName`: Nombre para logs
- `totalCount`: Total de registros (para barra de progreso)
- `batchSize`: Registros por fetch
- `transformAndInsert(row, v2Client)`: Callback que retorna 'skipped' o truthy

### `utils/logger.js` — Logging Estructurado

| Funcion | Descripcion |
|---------|-------------|
| `error(msg)` | Log nivel ERROR con timestamp |
| `warn(msg)` | Log nivel WARN con timestamp |
| `info(msg)` | Log nivel INFO con timestamp |
| `debug(msg)` | Log nivel DEBUG con timestamp |
| `phase(num, name)` | Header de fase con separadores visuales |
| `table(name, action)` | Mensaje de inicio de tabla |
| `progress(name, current, total)` | Barra de progreso inline con porcentaje |
| `summary(name, results, ms)` | Resumen de tabla (migrados/omitidos/fallidos/duracion) |
| `formatDuration(ms)` | Formatea ms → "1m 30s" / "500ms" / "1.5s" |

### `utils/crypto.js` — Hashing de Contrasenas

| Funcion | Firma | Descripcion |
|---------|-------|-------------|
| `hashPassword` | `(plainText)` → string/null | bcrypt hash con cost=10. Null si input vacio |

Compatible con `bcrypt.compare()` del backend NestJS. El cost factor (10) queda embebido en el hash (`$2b$10$...`), por lo que el backend no necesita configuracion adicional.

### `utils/trigger-manager.js` — Gestion de Triggers y Constraints

| Funcion | Descripcion |
|---------|-------------|
| `disableAllTriggers(v2Pool)` | Deshabilita todos los triggers user-defined en schema tonic |
| `enableAllTriggers(v2Pool)` | Re-habilita todos los triggers |
| `dropNetworkCheckConstraint(v2Pool)` | Elimina `chk_network_members_root_depth` |
| `restoreNetworkCheckConstraint(v2Pool)` | Restaura `chk_network_members_root_depth` |
| `dropStockLevelsCheckConstraint(v2Pool)` | Elimina `chk_stock_levels_qty_on_hand` |
| `restoreStockLevelsCheckConstraint(v2Pool)` | Restaura `chk_stock_levels_qty_on_hand` |
| `createMissingUniqueIndexes(v2Pool)` | Crea indices UNIQUE en legacy_id para ON CONFLICT |

### `utils/validators.js` — Validacion y Limpieza de Datos

| Funcion | Firma | Descripcion |
|---------|-------|-------------|
| `validateEnum` | `(constraintKey, value, defaultValue)` → value | Valida contra CHECK constraints de v2 |
| `cleanString` | `(value)` → string/null | Trim whitespace, null si vacio |
| `cleanTrunc` | `(value, maxLen)` → string/null | Limpia y trunca a longitud maxima |
| `toBoolean` | `(value)` → boolean | Convierte 1/0/'1'/'0' a true/false |
| `toDecimal` | `(value, defaultValue?)` → number/null | Parsea float, retorna default si NaN |
| `slugify` | `(text)` → string/null | Genera slug URL-safe (max 250 chars) |
| `prefixUrl` | `(value)` → string/null | Agrega prefijo `https://tonic-life.net/assets/` a paths relativos |

### `utils/gcs-uploader.js` — Google Cloud Storage

| Funcion | Firma | Descripcion |
|---------|-------|-------------|
| `init` | `()` → boolean | Inicializa cliente GCS, verifica bucket. False si falla |
| `uploadFile` | `(rawFilePath, gcsFolder, opts?)` → string/null | Descarga de v1 + sube a GCS. Fallback a prefixUrl |
| `uploadMultiple` | `(files[])` → (string/null)[] | Upload paralelo con semaforo de concurrencia |
| `getStats` | `()` → object | {uploaded, skipped, failed, alreadyExisted} |
| `resetStats` | `()` → void | Resetea contadores |

Detalles internos:
- **Semaforo**: Limita concurrencia a `GCS_CONCURRENCY` (default 8)
- **Streaming**: HTTP response → pipe directo a GCS write stream (sin archivos temporales)
- **Retry**: Backoff exponencial (1s, 2s, 4s) configurable via `GCS_RETRY_ATTEMPTS`
- **Content-Type**: Detectado por extension (.jpg→image/jpeg, .pdf→application/pdf, etc.)
- **Idempotencia**: `file.exists()` antes de subir

---

## Mapeos de Datos

### `mappings/column-maps.js` — Referencia de tablas v1→v2

Documenta la correspondencia entre tablas origen y destino para cada fase:

```javascript
// Ejemplo de estructura
{
  countries: { source: 't_country', target: 'countries', strategy: 'legacy_id_map', entityType: 'country' },
  products:  { source: 't_product', target: 'products', strategy: 'legacy_id_map', entityType: 'product' },
  users:     { source: 't_users',   target: 'users',    strategy: 'legacy_id' },
}
```

Estrategias:
- `legacy_id_map`: Usa tabla `legacy_id_map` para rastrear mapeo bigint→UUID
- `legacy_id`: Usa columna `legacy_id` directa en la tabla destino

### `mappings/value-maps.js` — Conversion de valores

| Mapa | Conversion |
|------|-----------|
| `CUSTOMER_STATUS` | 1→active, 2→inactive, 3→suspended, _default→pending |
| `KIT_TYPE` | 1→basic, 2→premium, _default→null |
| `ORDER_STATUS_FROM_ANULADO` | 0→confirmed, 1→cancelled, _default→confirmed |
| `ORDER_SOURCE` | POS→pos, ECOMMERCE→ecommerce, APP→app, PHONE→phone, _default→other |
| `USER_STATUS` | 1→active, 0→inactive, _default→inactive |
| `EMPLOYEE_STATUS` | 1→active, 0→inactive, _default→active |
| `LANGUAGE_CODE` | 1→es, 2→en, _default→es |

Funcion helper: `mapValue(map, value)` → aplica el mapeo con fallback a `_default`.

---

## Idempotencia y Re-ejecucion

Todas las fases son **idempotentes**: se pueden re-ejecutar sin duplicar datos.

### Como funciona

- **Tablas con `legacy_id`:** Usan `ON CONFLICT (legacy_id) DO UPDATE SET ...` para actualizar registros existentes.
- **Tablas con UNIQUE compuesto:** Usan `ON CONFLICT ON CONSTRAINT uq_xxx DO NOTHING` o `DO UPDATE`.
- **Tablas sin UNIQUE en legacy_id:** Usan `WHERE NOT EXISTS (SELECT 1 FROM tabla WHERE legacy_id = $1)`.
- **Mapeos de ID:** Se registran en `tonic.legacy_id_map` y se verifican antes de cada insercion.

### Si una fase falla a la mitad

1. Revisar el log para identificar la causa del error
2. Corregir el problema (datos en v1, configuracion, etc.)
3. Volver a ejecutar **la misma fase**:

```bash
node index.js -p 4    # Re-ejecutar solo la fase que fallo
```

Los registros ya migrados se actualizaran (no se duplican) y los pendientes se insertaran.

### Errores por registro vs errores fatales

- **Error por registro:** El registro individual falla pero el batch continua. Se usa `SAVEPOINT` por registro para aislar errores sin abortar la transaccion completa.
- **Error fatal de fase:** Si la fase completa falla (error de conexion, tabla inexistente), el script continua con la siguiente fase y reporta el error al final.

---

## Reportes

Al finalizar cada ejecucion, se generan dos archivos en la carpeta `reports/`:

```
reports/
  migration-report-2026-02-28T15-30-00.json   # Reporte detallado (JSON)
  migration-report-2026-02-28T15-30-00.txt    # Reporte legible (texto)
```

### Contenido del reporte

- Fecha y hora de inicio/fin, duracion total
- Configuracion utilizada (hosts, batch size)
- Resultados por fase: migrados, omitidos, fallidos, duracion
- Estadisticas de GCS (si habilitado): subidos, ya existentes, fallidos
- Totales globales
- Lista de errores detallados (tabla, legacy_id, mensaje de error, datos del registro)

---

## Orden Recomendado para Primera Migracion

Para una primera migracion completa, el orden recomendado es ejecutar por bloques y validar entre cada uno:

```bash
# Bloque 1: Preparacion e infraestructura
node index.js -p 0 -p 1 -p 2
# Verificar manualmente que catalogos y sucursales migraron correctamente

# Bloque 2: Seguridad y productos
node index.js -p 3 -p 4
# Verificar que usuarios y productos tienen datos correctos

# Bloque 3: Clientes y red MLM
node index.js -p 5 -p 6
# Validar la red con queries de integridad (depth/path/children_count)

# Bloque 4: Transacciones
node index.js -p 7 -p 8 -p 9
# Verificar conteos de orders, invoices y comisiones

# Bloque 5: Tablas complementarias
node index.js -p 10 -p 10b -p 11 -p 12 -p 13
# Verificar conteos

# Bloque 6: Validacion final
node index.js --validate
# Revisar el reporte generado
```

> **Importante:** La v1 debe estar en **modo solo lectura** durante toda la migracion para evitar inconsistencias. Los pedidos creados en v1 despues de que la migracion inicio no apareceran en v2 hasta re-ejecutar la fase correspondiente.

---

## Estructura del Proyecto

```
migration/
├── index.js                          # Orquestador principal (CLI, pools, ejecucion de fases)
├── config.js                         # Lectura y validacion de .env
├── package.json                      # Dependencias: pg, bcrypt, slugify, @google-cloud/storage
├── .env                              # Credenciales (gitignored)
├── .env.example                      # Plantilla de credenciales
├── .gitignore
├── README.md
│
├── utils/
│   ├── id-resolver.js                # Cache UUID + resolucion legacy_id → UUID (singleton)
│   ├── batch-processor.js            # Lotes con cursor server-side y SAVEPOINTs
│   ├── logger.js                     # Log con timestamps, progreso y duracion
│   ├── crypto.js                     # Hashing bcrypt (cost=10)
│   ├── trigger-manager.js            # Disable/enable triggers y CHECK constraints
│   ├── validators.js                 # Validacion, limpieza, slugify, prefixUrl
│   └── gcs-uploader.js              # Descarga HTTP + subida a Google Cloud Storage
│
├── mappings/
│   ├── column-maps.js                # Referencia de mapeo columnas v1 → v2
│   └── value-maps.js                 # Mapeo de valores status/enum v1 → v2
│
├── phases/
│   ├── phase-00-infrastructure.js    # Deshabilitar triggers, crear indices, seeds
│   ├── phase-01-catalogs.js          # 10 tablas catalogo (~200 registros)
│   ├── phase-02-branches.js          # Sucursales + reglas fiscales (~40)
│   ├── phase-03-security.js          # Roles, permisos, usuarios (~219K)
│   ├── phase-04-products.js          # Productos, precios, lotes, stock (~887K)
│   ├── phase-05-customers.js         # Clientes, direcciones, cuentas (~600K)
│   ├── phase-06-network.js           # Red MLM en 4 pasos (~218K nodos)
│   ├── phase-07-sales.js             # Ordenes, items, envios (~6.4M)
│   ├── phase-08-invoicing.js         # Facturas desde 3 fuentes (~355K)
│   ├── phase-09-commissions.js       # Periodos, calculos, pagos (~4M+)
│   ├── phase-10-inventory.js         # Conteos de inventario (~5K)
│   ├── phase-10b-suppliers.js        # Proveedores, ordenes de compra (~370)
│   ├── phase-11-hr.js                # Empleados, vacaciones (~2K)
│   ├── phase-12-communication.js     # Notificaciones (~60K)
│   ├── phase-13-audit.js             # Logs, archivos, configuracion (~1.6M)
│   └── phase-99-post-migration.js    # Validacion, restauracion, reportes
│
└── reports/
    └── migration-report.js           # Generador de reportes JSON y TXT
```

**Total de codigo:** ~5,300 lineas en 16 fases + ~1,200 lineas en utilidades.

---

## Tablas NO Migradas

### Excluidas por diseno

| Tabla v1 | Razon |
|----------|-------|
| `t_period_red` (~29.8M) | Snapshot de red por periodo. Sin logica en backend v2 |
| `t_period_red_roll_over` (~32M) | Snapshot de rollover por periodo. Sin logica en backend v2 |
| `t_period_first_level` (~1.9M) | Snapshot primer nivel por periodo. Sin logica en backend v2 |

### Excluidas por ser infraestructura legacy

19 tablas `pma__*` (phpMyAdmin), 3 tablas `telescope_*` (Laravel debug), `failed_jobs`, `job_batches`, `jobs`, `migrations`, `password_resets` (Laravel framework), `users` (tabla default Laravel).

### Excluidas por ser temporales

`regularizar`, `document_regularizar`, `document_regularizar_puntos`, `folios_reprocesar`, `folios_reprocesar_backup`.

### Excluidas por estar vacias en v1

`t_red_kit`, `t_red_fee`, `t_red_password`, `t_red_point`, `t_period_completed`, `t_service_payments`.

### Pendientes de revision

`t_customers_promo`, `t_tax_zip_code`, `t_attendace`, `t_viaticos*`, `t_bot*`, `t_sms*`, `t_encuesta*` — el usuario confirmara si tienen destino en v2.

---

## Troubleshooting

### "Variables de entorno obligatorias faltantes"

```
ERROR: Variables de entorno obligatorias faltantes:
  - V1_USER
  - KEY_GCM
```

**Causa:** El archivo `.env` no tiene todas las variables obligatorias.
**Solucion:** Editar `.env` y completar: `V1_HOST`, `V1_USER`, `V1_PASSWORD`, `V2_HOST`, `V2_USER`, `V2_PASSWORD`, `KEY_GCM`.

---

### "No se pudo conectar a v1/v2"

```
No se pudo conectar a v1: connect ETIMEDOUT 136.116.247.253:5432
```

**Causa:** El servidor de base de datos no es accesible.
**Solucion:**
- Verificar que el servidor esta encendido y acepta conexiones
- Verificar que el firewall permite conexiones al puerto 5432
- Verificar credenciales en `.env`
- Para v1 en Google Cloud: verificar que la IP del cliente esta en la whitelist

---

### "viola la restriccion check"

```
el nuevo registro para la relacion "orders" viola la restriccion check "chk_orders_status"
```

**Causa:** Un valor de v1 no coincide con los valores permitidos por el CHECK constraint en v2.
**Solucion:** Verificar el mapeo de valores en la fase correspondiente. Los valores validos estan en la seccion [Valores CHECK constraint respetados](#valores-check-constraint-respetados). Agregar el mapeo faltante en el codigo de la fase.

---

### "llave duplicada viola restriccion de unicidad"

```
llave duplicada viola restriccion de unicidad "xxx_legacy_id_key"
```

**Causa:** El registro ya existe en v2 (migracion anterior).
**Solucion:** Esto no deberia ocurrir si se usa `ON CONFLICT`. Si aparece, verificar que el `ON CONFLICT` esta correctamente definido.

---

### Fase 6 (Red MLM) tarda demasiado

**Causa:** El recalculo recursivo de depth/path para 218K nodos requiere mucha memoria.
**Solucion:** Aumentar `work_mem` en PostgreSQL v2:

```sql
ALTER SYSTEM SET work_mem = '512MB';
SELECT pg_reload_conf();
```

Restaurar despues de la migracion:

```sql
ALTER SYSTEM RESET work_mem;
SELECT pg_reload_conf();
```

---

### GCS: "No se pudo inicializar"

```
GCS no se pudo inicializar. Archivos usaran prefixUrl fallback.
```

**Causa:** Las credenciales GCS son invalidas o el bucket no existe.
**Solucion:**
- Verificar que `GCS_CREDENTIALS` contiene el JSON completo del service account en una sola linea
- Verificar que `GCS_BUCKET_NAME` existe y el service account tiene permisos de escritura
- Verificar que `GCS_PROJECT_ID` es correcto

---

### Registros con legacy_id no resuelto (skipped)

**Causa:** Un registro en v1 referencia a otro que no se migro.
**Solucion:** Estos se reportan como "omitidos". Verificar que la fase de dependencia se ejecuto primero. Posibles causas:
- La fase de la que depende no se ejecuto
- El registro referenciado fue filtrado o tiene datos invalidos en v1

---

### El reporte muestra "faltan N registros"

```
⚠ orders: faltan 1,234 registros (v1=1,731,059, v2=1,729,825)
```

**Causa:** Algunos registros fallaron o v1 recibio nuevos registros despues de la migracion.
**Solucion:**
1. Revisar la seccion de errores detallados en el reporte
2. Re-ejecutar la fase: `node index.js -p 7`
3. Validar: `node index.js --validate`

---

### "transaccion abortada"

```
la transaccion abortada, las ordenes seran ignoradas hasta el fin de bloque
```

**Causa:** Un error previo invalido la transaccion.
**Solucion:** Este error fue corregido con SAVEPOINTs por registro en `batch-processor.js`. Si reaparece, verificar que usas la version mas reciente.

---

### "No hay roles en v2"

```
No hay roles en v2. No se puede migrar usuarios.
```

**Causa:** La fase 3 necesita roles que se crean al inicio de la misma fase.
**Solucion:** Ejecutar las fases en orden. Si persiste, verificar que `t_profile` en v1 tiene datos.
