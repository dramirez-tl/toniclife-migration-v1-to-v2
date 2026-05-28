# Plan — Migrar los XML de facturas a GCS

**Fecha:** 2026-05-22 · **Estado:** propuesta revisable (NADA ejecutado). Territorio fiscal/billing → requiere visto bueno explícito antes de correr cualquier cosa.

---

## 1. Objetivo

Que los XML (CFDI) de las facturas históricas queden almacenados en GCS (`toniclife-prod`) y referenciados desde `tonic.invoices.xml_file_path`, en lugar de apuntar a URLs `tonic-life.net` que ya no existen.

---

## 2. Diagnóstico de viabilidad (lo que se verificó hoy, en vivo)

| Hecho | Evidencia |
|---|---|
| **Las URLs legacy dan 404** | `curl` a muestras `sale` y `commission` de `tonic-life.net/assets/...` → HTTP 404 (página de error de 25 bytes). Los XML cacheados en el servidor viejo **ya no existen**. |
| **El origen v1 de los paths está vacío** | `V1_DATABASE=postgres` / schema `toniclife`: `t_factura_libre` = 0 filas y `t_bono_facturama` = 0 filas. La sección de facturas de `phase-14` **no tiene de dónde leer** → por eso nunca se migraron. |
| **Sí está el folio fiscal** | 5,832 facturas pendientes (1,938 sale + 3,894 commission) **todas** con `sat_uuid`. |
| **Falta el id interno de Facturama** | `provider_invoice_id` = NULL en las 5,832; `provider_response` vacío. La migración solo trajo `sat_uuid`, no el id de Facturama. |
| **El proveedor es Facturama** | Las 5,832 tienen `provider_id` → `invoice_providers.code = 'facturama'`. |

**Conclusión:** el camino ingenuo ("correr `phase-14` de facturas") **está muerto**: ni el cache legacy ni las tablas fuente de v1 sirven. La **única fuente canónica y legal** de esos XML es **Facturama** (o el SAT), recuperándolos por `sat_uuid`.

> Nota de alcance: además de las 5,832 con URL muerta, hay ~4,400 facturas (sale/commission/cedea) con `sat_uuid` pero `xml_file_path` NULL (nunca tuvieron archivo). Si se quiere, el mismo proceso puede traer también esas. Total potencial con `sat_uuid` ≈ 10,300.

---

## 3. El backend ya tiene las piezas

`toniclife-api/src/integrations/facturama/facturama.client.ts` expone:
- **`getCfdiByUuid(uuid)`** → `GET /cfdi?keyword={uuid}` → devuelve el CFDI con su **id interno de Facturama**.
- **`downloadXml(id)`** → baja el XML por id de Facturama.
- `downloadPdf(id)`, `getCfdi(id)`, `listIssuedCfdis(...)`, `getBalance()`.

Es decir, el flujo por factura es: `getCfdiByUuid(sat_uuid)` → `id` → `downloadXml(id)` → subir a GCS → actualizar BD.

---

## ✅ DECISIÓN (2026-05-22)

**No se migran archivos a GCS.** El `sat_uuid` queda como referencia fiscal legal y el CFDI se descarga **on-demand desde Facturama** vía el admin V2, **para TODAS las facturas con `sat_uuid` (~10.3K)**, no solo las 5,832 con URL muerta.

### Qué falta exactamente (verificado en código)
- **Endpoints ya existen**: `GET /api/v1/billing/invoices/:id/xml` y `.../pdf` (`billing.controller.ts:301,321`).
- **Bloqueo**: `getFacturamaId(invoice)` (`billing.service.ts:902`) devuelve `provider_invoice_id` y, si es NULL, **lanza** `BadRequestException('LEGACY_INVOICE: ... no está disponible para descarga desde Facturama')`. Las ~10.3K migradas tienen `provider_invoice_id` NULL → hoy el botón de descarga les daría ese error.

### Cambio propuesto (chico, backend) — NO ejecutado, requiere tu OK (billing = máximo cuidado)
En `billing.service.ts`, que la resolución del id de Facturama caiga a `sat_uuid` cuando falte `provider_invoice_id`:

```ts
// downloadXml / downloadPdf (hoy llaman a getFacturamaId síncrono)
private async resolveFacturamaId(invoice: InvoicesRow): Promise<string> {
  if (invoice.provider_invoice_id) return invoice.provider_invoice_id;
  if (invoice.sat_uuid) {
    const cfdi = await this.facturamaClient.getCfdiByUuid(invoice.sat_uuid); // /cfdi?keyword=uuid
    // cachear para próximas descargas (evita la búsqueda keyword cada vez):
    await this.postgres.sql`UPDATE invoices SET provider_invoice_id = ${cfdi.Id} WHERE id = ${invoice.id}`;
    return cfdi.Id;
  }
  throw new BadRequestException('Factura sin sat_uuid ni provider_invoice_id; no descargable.');
}
```
- Convertir `downloadXml`/`downloadPdf` para usar `resolveFacturamaId` (async). 
- Manejar 404 de `getCfdiByUuid` con mensaje claro ("CFDI no encontrado en Facturama por UUID; recuperar del portal SAT").
- **Efecto secundario útil**: la primera descarga rellena `provider_invoice_id`, así que la 2ª vez ya no busca por keyword.

### Frontend (admin V2)
- Verificar que la vista de factura tenga botones "Descargar XML/PDF" que peguen a esos endpoints. Si ya existen, no hay cambio; solo dejarán de dar el error LEGACY una vez aplicado el fallback.

### Higiene de datos (decisión menor, opcional)
- Las `xml_file_path` que apuntan a `tonic-life.net` (5,832) son **enlaces muertos** (404). Opciones: (a) ponerlas en NULL para que la UI no ofrezca un link roto y use solo el endpoint on-demand; (b) dejarlas pero que el frontend nunca las use como link directo. Recomiendo (a) con un pequeño UPDATE revisable. La UI debe basarse en el endpoint `/invoices/:id/xml`, **no** en `xml_file_path`.

### Riesgos (siguen aplicando)
- Retención de Facturama para CFDIs 2022-2023 (validar con la primera descarga real). Los no disponibles → portal SAT.
- `getCfdiByUuid` usa `keyword`: validar que el resultado tenga `Uuid == sat_uuid`.
- Cambios en `billing/` requieren tu confirmación explícita.

---

## 4. Opciones (consideradas — quedó elegida la C / on-demand)

### Opción A — Re-descargar de Facturama por `sat_uuid` (RECOMENDADA)
Fuente autoritativa, legal y completa. Construir un script de migración dedicado.

### Opción B — Restaurar desde un backup del servidor legacy
Si existe un respaldo del filesystem de `tonic-life.net` (carpeta `assets/files/facturama/` y `assets/factura_libre/`), subir esos archivos directo a GCS sin tocar Facturama. Más rápido y sin costo de API, pero **depende de que el backup exista** (hoy las URLs vivas dan 404).

### Opción C — No migrar los archivos
El `sat_uuid` es la referencia fiscal legal; el XML siempre se puede recuperar de SAT/Facturama on-demand. Dejar `xml_file_path` apuntando a... nada (o NULL) y exponer un botón "descargar CFDI" que llama a Facturama al momento. Cero migración de archivos.

---

## 5. Diseño de la Opción A (recomendada)

Nuevo script `reports/migrate-invoice-xml-to-gcs.js` (o fase `phase-08b`), **idempotente y con dry-run**:

1. **Selección**: `SELECT id, legacy_id, sat_uuid, invoice_type FROM tonic.invoices WHERE provider_id = (facturama) AND sat_uuid IS NOT NULL AND xml_file_path NOT LIKE 'https://storage.googleapis.com/%'` (incluye las 5,832 con URL muerta y, opcionalmente, las NULL).
2. **Por factura** (con throttling y semáforo, ej. 3-5 concurrentes):
   - `getCfdiByUuid(sat_uuid)` → id de Facturama. Si 404 → registrar como "no encontrada en Facturama" y continuar (no romper).
   - `downloadXml(id)` → contenido XML (base64/string).
   - Subir a GCS en `invoices/xml/{legacy_id}/invoice.xml` (mismo patrón que `phase-14`, `replaceFileSingle`).
   - `UPDATE tonic.invoices SET xml_file_path = '<url GCS>', provider_invoice_id = '<id>', updated_at = NOW() WHERE id = ...` (de paso, rellenar el `provider_invoice_id` faltante).
   - (Opcional) bajar también el PDF a `invoices/pdf/{legacy_id}/invoice.pdf` y setear `pdf_file_path`.
3. **Idempotencia**: re-correr salta las que ya tienen URL GCS. Reporte final: migradas / no-encontradas-en-facturama / errores, con CSV de las fallidas.
4. **Dry-run primero**: una corrida que solo hace `getCfdiByUuid` sobre una muestra (ej. 50) para medir tasa de éxito y latencia antes de lanzar las ~5,832.

**Auth/credenciales:** reusar `FACTURAMA_*` (user/password/baseURL prod). Confirmar que apunta a **producción** (no sandbox) y que el ambiente de Facturama es el que emitió esos CFDIs.

---

## 6. Riesgos y consideraciones

- **Fiscal/billing = máximo cuidado** (CLAUDE.md). Solo escribe `xml_file_path`/`pdf_file_path`/`provider_invoice_id` — NO toca montos, UUID, ni estatus SAT. Aun así, requiere tu visto bueno.
- **Retención en Facturama**: CFDIs de 2022-2023 podrían no estar disponibles vía API (Facturama suele conservarlos, pero hay que validarlo con el dry-run). Los que no aparezcan → recuperables del portal del SAT manualmente.
- **Volumen / rate-limit / costo**: ~5,832 × (1 búsqueda + 1 descarga) ≈ 11,700 llamadas. Facturama puede limitar y/o cobrar consultas. Throttling obligatorio; correr en ventana controlada.
- **`getCfdiByUuid` usa `keyword`**: si un UUID devolviera >1 resultado o ninguno, manejar el caso (validar que el UUID del resultado == `sat_uuid`).
- **GCS**: el `GCS_CREDENTIALS` en `.env.local` está mal formateado (JSON multilínea) — el script debe leerlo robustamente (como hace `detect-gcs-duplicates.js`) o arreglar el `.env.local` primero.
- **cedea (189)**: tienen `sat_uuid` pero quizá otro flujo; decidir si entran.

---

## 7. Esfuerzo estimado

- Script + dry-run + pruebas: ~medio día.
- Corrida completa: depende de rate-limit de Facturama (estimar tras dry-run; con 4 concurrentes y ~1 req/s podría ser 1-3 h).

---

## 8. Decisiones abiertas (necesito tu input antes de construir nada)

1. **¿Tienes un backup del servidor legacy** (`tonic-life.net/assets/...`) con los XML? → si sí, Opción B es más simple/barata.
2. Si vamos por **Facturama (Opción A)**: ¿el ambiente Facturama de producción sigue activo y con esos CFDIs? ¿OK con el volumen de llamadas (posible costo)?
3. **Alcance**: ¿solo las 5,832 con URL muerta, o también las ~4,400 con `sat_uuid` pero sin XML?
4. ¿Migrar también **PDF**, o solo XML?
5. ¿O prefieres la **Opción C** (no migrar archivos; descargar on-demand desde el admin V2)?
