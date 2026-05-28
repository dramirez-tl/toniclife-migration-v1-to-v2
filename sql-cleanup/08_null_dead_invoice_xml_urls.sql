-- ============================================================================
-- CLEANUP 08: Poner en NULL las xml_file_path muertas de invoices (tonic-life.net)
-- ============================================================================
-- Propósito:
--   Las 5,832 facturas migradas tienen xml_file_path apuntando a
--   https://tonic-life.net/assets/... que devuelven HTTP 404 (verificado
--   2026-05-22: el cache legacy ya no existe). Esos enlaces son engañosos:
--   la UI no debe ofrecer un link roto.
--
-- Decisión (2026-05-22): los CFDI NO se migran a GCS; se descargan on-demand
--   de Facturama por sat_uuid (ver billing.service.resolveFacturamaId y el plan
--   reports/plan-migrar-xml-facturas-gcs-2026-05-22.md). La UI debe usar el
--   endpoint GET /api/v1/billing/invoices/:id/xml, NO la columna xml_file_path.
--   Por eso ponemos esas URLs muertas en NULL.
--
-- ⚠️ ÁMBITO FISCAL (billing): NO toca sat_uuid, montos, ni estatus SAT. Solo
--   limpia un puntero a archivo roto. Aun así, requiere visto bueno y se
--   ejecuta con backup previo.
--
-- Alcance: SOLO xml_file_path LIKE '%tonic-life.net%' (las 404). NO toca las
--   que ya apuntan a GCS ni las NULL ni los pdf_file_path.
--
-- Reversible: SÍ, vía la tabla de backup que crea el paso 1.
-- Tiempo estimado: <1 seg (5,832 filas).
-- ============================================================================

-- ============================================================================
-- UP
-- ============================================================================

BEGIN;

-- 1) Backup de (id, xml_file_path) ANTES de tocar nada (reversibilidad).
CREATE TABLE IF NOT EXISTS tonic.invoices_xml_url_backup_20260522 AS
SELECT id, xml_file_path
FROM tonic.invoices
WHERE xml_file_path ILIKE '%tonic-life.net%';

-- 2) Sanity check inicial
SELECT 'inicial' AS estado,
       count(*) FILTER (WHERE xml_file_path ILIKE '%tonic-life.net%') AS urls_muertas,
       count(*) FILTER (WHERE xml_file_path LIKE 'https://storage.googleapis.com/%') AS en_gcs,
       count(*) FILTER (WHERE xml_file_path IS NULL) AS nulas
FROM tonic.invoices;
-- Esperado 2026-05-22: urls_muertas=5832

-- 3) Deshabilitar audit triggers durante el UPDATE (evita ruido / falta de contexto en DBeaver)
ALTER TABLE tonic.invoices DISABLE TRIGGER USER;

-- 4) Poner en NULL las URLs muertas (no toca sat_uuid ni nada fiscal)
UPDATE tonic.invoices
SET xml_file_path = NULL, updated_at = NOW()
WHERE xml_file_path ILIKE '%tonic-life.net%';
-- Esperado: UPDATE 5832

-- 5) Re-habilitar triggers
ALTER TABLE tonic.invoices ENABLE TRIGGER USER;

-- 6) Sanity check post
SELECT 'post' AS estado,
       count(*) FILTER (WHERE xml_file_path ILIKE '%tonic-life.net%') AS urls_muertas
FROM tonic.invoices;
-- Esperado: urls_muertas=0

-- Si todo se ve bien:  COMMIT;   en caso contrario:  ROLLBACK;
COMMIT;

-- ============================================================================
-- DOWN  (restaurar desde el backup)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE tonic.invoices DISABLE TRIGGER USER;
--   UPDATE tonic.invoices i
--     SET xml_file_path = b.xml_file_path, updated_at = NOW()
--     FROM tonic.invoices_xml_url_backup_20260522 b
--     WHERE b.id = i.id;
--   ALTER TABLE tonic.invoices ENABLE TRIGGER USER;
-- COMMIT;
-- -- y luego, si se desea:  DROP TABLE tonic.invoices_xml_url_backup_20260522;
-- ============================================================================
