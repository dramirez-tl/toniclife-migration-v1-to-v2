# TonicLife ERP — Migración de Base de Datos v1 a v2

Script de migración completa del sistema TonicLife ERP desde la base de datos legacy (v1) hacia el nuevo esquema normalizado (v2).

- **Origen (v1):** PostgreSQL en Google Cloud, schema `toniclife`, IDs tipo `bigint`
- **Destino (v2):** PostgreSQL local, schema `tonic`, IDs tipo `UUID`
- **Volumen:** ~77 millones de registros en 131 tablas v1 → ~85 tablas v2
- **Motor:** Node.js con driver `pg` nativo y cursores server-side

---

## Requisitos Previos

| Requisito | Versión mínima |
|-----------|----------------|
| Node.js | 18+ |
| npm | 9+ |
| PostgreSQL (v2 destino) | 14+ |
| Acceso de red a v1 | Puerto 5432 abierto |

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
V1_USER=                       # ** OBLIGATORIO ** Usuario con permisos SELECT en v1
V1_PASSWORD=                   # ** OBLIGATORIO ** Contraseña del usuario v1

# ============================================
# Base de Datos v2 — Destino (Local)
# ============================================
V2_HOST=localhost              # IP o hostname del servidor v2
V2_PORT=5432                   # Puerto PostgreSQL (default: 5432)
V2_DATABASE=toniclife_db_v2    # Nombre de la base de datos v2
V2_SCHEMA=tonic                # Schema destino
V2_USER=                       # ** OBLIGATORIO ** Usuario con permisos FULL en v2
V2_PASSWORD=                   # ** OBLIGATORIO ** Contraseña del usuario v2

# ============================================
# Encriptacion de contraseñas
# ============================================
KEY_GCM=                       # ** OBLIGATORIO ** Llave AES-256-GCM (misma que usa el backend NestJS)

# ============================================
# Configuracion de migracion
# ============================================
BATCH_SIZE=5000                # Registros por lote para tablas grandes (default: 5000)
LOG_LEVEL=info                 # Nivel de log: debug, info, warn, error (default: info)
```

Las variables marcadas como **OBLIGATORIO** deben tener valor. El script no iniciara si faltan.

---

## Uso del CLI

### Ejecutar todas las fases

```bash
node index.js
```

Ejecuta las 16 fases en orden (0 → 1 → 2 → ... → 13 → 99).

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
node index.js -h
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

- Deshabilita **todos** los triggers de auditoria (120+) y auto-numeracion
- Crea indices UNIQUE faltantes (`network_members.legacy_id`, `network_branch_assignments.legacy_id`)
- Elimina temporalmente CHECK constraints que bloquean la migracion
- Verifica/inserta registros default en `tenant_config`, `invoice_providers`, `commission_tax_regimes`

### Fase 1 — Catalogos Base

~200 registros en 10 tablas de referencia.

| v1 | v2 | Registros |
|---|---|---|
| `t_country` | `countries` | ~10 |
| `t_type_money` | `currencies` | ~5 |
| `t_type_price` | `price_types` | ~5 |
| `t_type_document` | `document_types` | ~10 |
| `t_type_format_pay` | `payment_methods` | ~10 |
| `t_tax` | `tax_rules` | ~5 |
| `t_dispatch` | `dispatch_types` | ~10 |
| `t_exchange` | `exchange_rates` | ~100 |
| `t_cfdi` | `sat_cfdi_uses` | ~30 |
| `t_regimen` | `sat_tax_regimes` | ~10 |

### Fase 2 — Sucursales

~40 registros en 2 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_branch_office` | `branches` | ~20 |
| `t_branch_office_tax` | `branch_tax_rules` | ~20 |

Nota: `branches.parent_branch_id` se migra en 2 pasos (INSERT sin parent, luego UPDATE) por ser FK auto-referencial.

### Fase 3 — Seguridad y Acceso

~219K registros en 7 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_profile` | `roles` | ~10 |
| `t_tags_items` | `permissions` | ~50 |
| `t_tags_items_profile` | `role_permissions` | ~200 |
| `t_tags_items_profile_action` | `role_permissions` | ~200 |
| `t_worker` | `workers` | ~50 |
| `t_users` | `users` | **~218K** |
| `t_users_branch_office` | `user_branches` | ~200 |

Transformaciones clave:
- Contraseñas encriptadas con AES-256-GCM (misma llave que backend NestJS)
- Usuarios sin contraseña reciben password temporal + `must_change_password = true`
- Campo `is_migrated_user = true` para todos los usuarios migrados

### Fase 4 — Productos

~887K registros en 13 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_clasification` | `product_categories` | ~30 |
| `t_product_unit` | `product_units` | ~10 |
| `t_component` | `components` | ~10 |
| `t_organ` | `health_organs` | ~20 |
| `t_diseases` | `health_conditions` | ~30 |
| `t_product` | `products` | **~118K** |
| `t_product_price` | `product_prices` | **~324K** |
| `t_product_photo` | `product_images` | ~500 |
| `t_product_lot` | `product_lots` | **~138K** |
| `t_product_component` | `product_components` | ~5K |
| `t_product_tax` | `product_taxes` | ~200 |
| `t_product_exempt` | `product_exemptions` | ~50 |
| `t_product_stock_snapshot` | `stock_levels` | **~306K** |

### Fase 5 — Clientes y Distribuidores

~600K registros en 10 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_plan` | `mlm_ranks` | ~10 |
| `t_nivel` | `mlm_level_commissions` | ~20 |
| `t_generation` | `mlm_generation_commissions` | ~5 |
| `t_customers` | `customers` | **~218K** |
| `t_customers_address` | `customer_addresses` | ~100K |
| `t_customers_bank` | `customer_bank_accounts` | ~50K |
| `t_customers_cedea` | `cedea_contracts` | ~5K |
| `t_customers_social` | `customer_social_profiles` | ~100K |
| `t_customers_kit_cart` | `customer_kit_cart` | ~10K |
| `t_subscriptions` | `customer_subscriptions` | ~5K |

Nota: `customers.sponsor_id` y `customers.upline_id` se migran en 2 pasos por ser FK auto-referenciales.

### Fase 6 — Red MLM

~218K nodos de red + tablas auxiliares.

| v1 | v2 | Registros |
|---|---|---|
| `t_red` | `network_members` | **~218K** |
| `t_red_roll_over` | `network_roll_over` | ~218K |
| `t_red_custom_sponsor` | `network_sponsor_overrides` | ~215K |
| `t_red_custom_upline` | `network_upline_overrides` | ~215K |
| `t_red_sucursales` | `network_branch_assignments` | ~20 |

**La fase mas compleja.** La red se migra en 4 pasos:
1. INSERT nodos sin relaciones (`parent_id = NULL`)
2. UPDATE `parent_id` resolviendo uplines via legacy IDs
3. UPDATE `sponsor_member_id` resolviendo sponsors
4. Recalculo recursivo de `depth`, `path`, `path_legacy`, `children_count`

### Fase 7 — Ventas y Documentos

~6.4M registros en 7 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_promo` | `promotions` | ~50 |
| `t_promo_det` | `promotion_items` | ~200 |
| `t_cart` | `shopping_carts` | ~5K |
| `t_cart_det` | `shopping_cart_items` | ~20K |
| `t_document` | `orders` | **~1.7M** |
| `t_document_det` | `order_items` | **~4.6M** |
| `t_sale_tracker` | `order_shipments` | ~50K |

### Fase 8 — Facturacion

~350K registros en 3 fuentes.

| v1 | v2 | Registros |
|---|---|---|
| `t_factura_libre` | `invoices` (tipo sale) | ~100K |
| `t_factura_libre_det` | `invoice_items` | ~200K |
| `t_bono_facturama` | `invoices` (tipo commission) | ~50K |

### Fase 9 — Comisiones

~4M+ registros en multiples tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_period` | `commission_periods` | ~50 |
| `t_customers_period` / `_v2` | `customer_period_stats` | ~218K/periodo |
| `t_customers_plan_history` | `rank_history` | ~100K |
| `t_customers_paid` | `commission_payments` | **~1.1M** |
| `t_period_commisions` | `commission_calculations` | ~100K |
| `t_period_commisions_det` | `commission_details` | **~1.9M** |
| `t_period_first_level` | `period_first_level_snapshots` | **~1.9M** |

> Los snapshots de red (`t_period_red`, `t_period_red_roll_over`, ~62M registros) estan **excluidos** de esta migracion.

### Fase 10 — Inventario

~5K registros en 2 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_inventory` | `inventory_counts` | ~100 |
| `t_inventory_det` | `inventory_count_details` | ~5K |

### Fase 10b — Proveedores y Compras

~370 registros en 5 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_company` | `company_entities` | ~5 |
| `t_cost_centers` | `cost_centers` | ~20 |
| `t_suppliers` | `suppliers` | ~50 |
| `t_supplier_requests` | `purchase_orders` | ~200 |
| `t_supplier_request_cost_centers` | `purchase_order_cost_centers` | ~100 |

### Fase 11 — Recursos Humanos

~2K registros en 9 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_job` | `job_positions` | ~20 |
| `t_departments` | `departments` | ~10 |
| `t_area` | `work_areas` | ~10 |
| `t_employees` | `employees` | ~100 |
| `t_holidays` | `holidays` | ~50 |
| `t_vacation_rules` | `vacation_rules` | ~10 |
| `t_vacation` | `vacation_requests` | ~500 |
| `t_vacation_dates` | `vacation_request_dates` | ~1K |
| `t_vacation_accrual_log` | `vacation_balances` | ~500 |

Nota: `employees.supervisor_id` se migra en 2 pasos por ser FK auto-referencial.

### Fase 12 — Comunicacion

~60K registros en 2 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_notification` | `notifications` | ~10K |
| `t_notification_read` | `notification_reads` | ~50K |

### Fase 13 — Auditoria y Logs

~1.6M registros en 3 tablas.

| v1 | v2 | Registros |
|---|---|---|
| `t_logs` | `access_logs` | **~1.6M** |
| `t_file` | `system_files` | ~1K |
| `t_text` | `system_settings` | 4 |

### Fase 99 — Post-Migracion y Validacion

No migra registros. Ejecuta 8 pasos de validacion:

1. Re-habilita todos los triggers deshabilitados en fase 0
2. Restaura CHECK constraints (`chk_network_members_root_depth`, `chk_stock_levels_qty_on_hand`)
3. Actualiza `sequence_counters` para que folios automaticos continuen correctamente
4. Valida conteos v1 vs v2 en 19 tablas clave
5. Verifica integridad referencial (busca FKs huerfanos en 8 relaciones)
6. Verifica consistencia de red MLM (depth, path, children_count, ciclos)
7. Spot-check de registros aleatorios cruzando v1 y v2
8. Resumen de `legacy_id_map` por tipo de entidad

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

> **Importante:** La v1 debe estar en **modo solo lectura** durante toda la migracion para evitar inconsistencias.

---

## Idempotencia y Re-ejecucion

Todas las fases son **idempotentes**: se pueden re-ejecutar sin duplicar datos.

### Como funciona

- **Tablas con `legacy_id`:** Usan `ON CONFLICT (legacy_id) DO UPDATE SET ...` para actualizar registros existentes en lugar de duplicarlos.
- **Tablas con UNIQUE compuesto:** Usan `ON CONFLICT ON CONSTRAINT uq_xxx DO NOTHING` o `DO UPDATE`.
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
  migration-report-2026-02-22T15-30-00.json   # Reporte detallado (JSON)
  migration-report-2026-02-22T15-30-00.txt    # Reporte legible (texto)
```

### Contenido del reporte

- Fecha y duracion total de la migracion
- Configuracion utilizada (hosts, batch size)
- Resultados por fase: migrados, omitidos, fallidos, duracion
- Totales globales
- Lista de errores detallados (tabla, legacy_id, mensaje de error, datos del registro)

---

## Estructura del Proyecto

```
migration/
├── index.js                          # Orquestador principal (CLI)
├── config.js                         # Lectura y validacion de .env
├── package.json                      # Dependencias: pg, pg-cursor, dotenv, slugify
├── .env                              # Credenciales (gitignored)
├── .env.example                      # Plantilla de credenciales
├── .gitignore
├── README.md
│
├── utils/
│   ├── id-resolver.js                # Cache UUID + resolucion legacy_id → UUID
│   ├── batch-processor.js            # Lotes con cursor server-side y SAVEPOINTs
│   ├── logger.js                     # Log con timestamps y progreso
│   ├── crypto.js                     # Encriptacion AES-256-GCM
│   ├── trigger-manager.js            # Disable/enable triggers y CHECK constraints
│   └── validators.js                 # Validacion y limpieza de datos
│
├── phases/
│   ├── phase-00-infrastructure.js    # Deshabilitar triggers, crear indices
│   ├── phase-01-catalogs.js          # 10 tablas catalogo
│   ├── phase-02-branches.js          # Sucursales + reglas fiscales
│   ├── phase-03-security.js          # Roles, permisos, usuarios
│   ├── phase-04-products.js          # Productos, precios, inventario
│   ├── phase-05-customers.js         # Clientes, direcciones, cuentas bancarias
│   ├── phase-06-network.js           # Red MLM (4 pasos)
│   ├── phase-07-sales.js             # Ordenes, items, envios
│   ├── phase-08-invoicing.js         # Facturas
│   ├── phase-09-commissions.js       # Periodos, calculos, pagos
│   ├── phase-10-inventory.js         # Conteos de inventario
│   ├── phase-10b-suppliers.js        # Proveedores, ordenes de compra
│   ├── phase-11-hr.js                # Empleados, vacaciones, dias festivos
│   ├── phase-12-communication.js     # Notificaciones
│   ├── phase-13-audit.js             # Logs de acceso, archivos, configuracion
│   └── phase-99-post-migration.js    # Validacion y restauracion de triggers
│
└── reports/
    └── migration-report.js           # Generador de reportes JSON y TXT
```

---

## Troubleshooting

### "Variables de entorno obligatorias faltantes"

```
ERROR: Variables de entorno obligatorias faltantes:
  - V1_USER
  - KEY_GCM
```

**Causa:** El archivo `.env` no tiene todas las variables obligatorias.
**Solucion:** Editar `.env` y completar las variables marcadas: `V1_HOST`, `V1_USER`, `V1_PASSWORD`, `V2_HOST`, `V2_USER`, `V2_PASSWORD`, `KEY_GCM`.

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

### "llave duplicada viola restriccion de unicidad"

```
llave duplicada viola restriccion de unicidad "xxx_legacy_id_key"
```

**Causa:** El registro ya existe en v2 (migracion parcial anterior).
**Solucion:** Esto no deberia ocurrir si se usa `ON CONFLICT`. Si aparece, verificar que el `ON CONFLICT` de la tabla en cuestion esta correctamente definido en la fase correspondiente.

---

### "viola la restriccion check"

```
el nuevo registro para la relacion "orders" viola la restriccion check "chk_orders_status"
```

**Causa:** Un valor de v1 no coincide con los valores permitidos por el CHECK constraint en v2.
**Solucion:** Verificar el mapeo de valores en la fase correspondiente. Los valores validos estan definidos en los CHECK constraints del schema v2. Opciones:
1. Agregar el mapeo faltante en el codigo de la fase
2. Si son datos inconsistentes en v1, usar un valor default

---

### "transaccion abortada, las ordenes seran ignoradas"

```
la transaccion abortada, las ordenes seran ignoradas hasta el fin de bloque de la transaccion
```

**Causa:** Un error previo en la transaccion invalido toda la transaccion (sin SAVEPOINT).
**Solucion:** Este error fue corregido con SAVEPOINTs por registro en `batch-processor.js`. Si reaparece, verificar que estas usando la version mas reciente de ese archivo.

---

### "No hay roles en v2"

```
No hay roles en v2. No se puede migrar usuarios.
```

**Causa:** La fase 3 intenta migrar usuarios pero no hay roles en la tabla `tonic.roles`.
**Solucion:** Ejecutar las fases en orden. Los roles se crean al inicio de la fase 3, antes de los usuarios. Si el error persiste, verificar que `t_profile` en v1 tiene datos.

---

### Fase 6 (Red MLM) tarda demasiado

**Causa:** El recalculo recursivo de `depth`/`path` para 218K nodos puede requerir mucha memoria.
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

### Registros con legacy_id no resuelto (skipped)

**Causa:** Un registro en v1 referencia a otro registro que no se migro (por ejemplo, un order que referencia un customer inexistente).
**Solucion:** Estos registros se reportan como "omitidos" (skipped). Verificar en el reporte que tablas tienen mas skips de lo esperado. Posibles causas:
- La fase de la que depende no se ejecuto primero
- El registro referenciado fue filtrado o tiene datos invalidos en v1

---

### El reporte muestra "faltan N registros"

```
⚠ orders: faltan 1,234 registros (v1=1,731,059, v2=1,729,825)
```

**Causa:** Algunos registros fallaron durante la migracion.
**Solucion:**
1. Revisar la seccion de errores detallados en el reporte
2. Corregir la causa (datos invalidos, FK faltante, etc.)
3. Re-ejecutar la fase: `node index.js -p 7`
4. Volver a validar: `node index.js --validate`
