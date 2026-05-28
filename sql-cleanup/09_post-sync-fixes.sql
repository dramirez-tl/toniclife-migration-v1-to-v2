-- ============================================================================
-- 09_post-sync-fixes.sql
-- ----------------------------------------------------------------------------
-- INSTANCIA: ejecutar SOLO en la v2  → AlloyDB PROD
--            host 34.70.18.38 / base toniclife_db_v2 / schema tonic
--            (en DBeaver: la conexión "AlloyDB - PROD". NO en la v1 legacy.)
--
-- Correcciones post-migración del sync dirigido 2026-05-28. Cada sección es
-- independiente (BEGIN/COMMIT propio). Revisa los SELECT de verificación antes
-- de hacer COMMIT.
--
-- ORDEN sugerido:
--   * Sección A (ciclo de red): ejecútala ANTES de la re-corrida
--     `node index.js -p 0 -p 7b -p 10c -p 99`, para que la fase 99 pueda
--     restaurar el CHECK chk_network_members_root_depth.
--   * Secciones B y C: cualquier momento (antes o después de la re-corrida).
-- ============================================================================


-- ============================================================================
-- SECCIÓN A — Romper ciclo de patrocinio en network_members (3 nodos de v1)
-- ----------------------------------------------------------------------------
-- Los nodos 2225215 y 2226312 se apuntan mutuamente como padre (ciclo) y
-- 2271257 cuelga del primero. El CTE de la fase 6 no pudo calcular su
-- depth/path → quedaron depth=0/path vacío y bloquearon el CHECK.
-- Acción: desprenderlos como raíz (parent_id NULL, depth 0, path canónico).
-- ============================================================================

-- Antes: deben ser exactamente 3 violaciones
SELECT COUNT(*) AS violaciones_antes
FROM tonic.network_members
WHERE (depth = 0 AND parent_id IS NOT NULL) OR (path IS NULL OR path = '');

BEGIN;

-- Desactivar triggers de usuario en network_members: hay un trigger que
-- propaga cambios entre filas relacionadas y, como estos 3 nodos están
-- entrelazados (el ciclo), choca con el mismo UPDATE (error 27000). Fijamos
-- los valores finales a mano, así que no necesitamos esa propagación.
ALTER TABLE tonic.network_members DISABLE TRIGGER USER;

UPDATE tonic.network_members
SET parent_id         = NULL,
    sponsor_member_id = NULL,
    depth             = 0,
    path              = '/' || id::text,
    children_count    = 0,
    updated_at        = NOW()
WHERE id IN (
  'b1538a29-8d4f-4c9b-b63c-11eff451c821',  -- legacy 2225215
  '8eced9ab-59de-4694-b443-c0299ef00f37',  -- legacy 2226312
  'c1321b22-9123-4f44-88fb-40ff61d14f2c'   -- legacy 2271257
);
-- Esperado: UPDATE 3

ALTER TABLE tonic.network_members ENABLE TRIGGER USER;

-- Después: debe ser 0
SELECT COUNT(*) AS violaciones_despues
FROM tonic.network_members
WHERE (depth = 0 AND parent_id IS NOT NULL) OR (path IS NULL OR path = '');

COMMIT;

-- (Opcional, si NO vas a correr la fase 99) restaurar el CHECK manualmente:
-- ALTER TABLE tonic.network_members
--   ADD CONSTRAINT chk_network_members_root_depth
--   CHECK ((depth = 0 AND parent_id IS NULL) OR (depth > 0 AND parent_id IS NOT NULL));


-- ============================================================================
-- SECCIÓN B — Backfill seguro de users.email
-- ----------------------------------------------------------------------------
-- El backfill de la fase 99 falla porque users.email es UNIQUE pero muchísimos
-- clientes comparten email basura/compartido en v1 ('@' = 119,245 clientes,
-- '.' = 14,127, correos de promotor reutilizados, etc.). No se pueden volver
-- únicos sin inventar datos. Aquí solo copiamos los emails VÁLIDOS y ÚNICOS;
-- el resto de usuarios se queda con email NULL (entran por username de todos
-- modos). No se modifica ningún dato de customers.
-- ============================================================================

BEGIN;

UPDATE tonic.users u
SET email = c.email, updated_at = NOW()
FROM tonic.customers c
WHERE u.customer_id = c.id
  AND u.email IS NULL
  AND c.email IS NOT NULL
  AND c.email LIKE '%@%.%'                       -- descarta basura ('@', '.', 'X@', '@.', '@*')
  AND c.email IN (                               -- solo emails que aparecen en UN cliente
        SELECT email FROM tonic.customers
        WHERE email IS NOT NULL AND email LIKE '%@%.%'
        GROUP BY email HAVING COUNT(*) = 1
      )
  AND NOT EXISTS (SELECT 1 FROM tonic.users u2 WHERE lower(u2.email) = lower(c.email));

-- Verificación
SELECT COUNT(*) AS users_con_email FROM tonic.users WHERE email IS NOT NULL;

COMMIT;


-- ============================================================================
-- SECCIÓN C — Corregir configuración MLM (rangos / niveles / generaciones)
-- ----------------------------------------------------------------------------
-- ⚠️  AFECTA CÁLCULO DE COMISIONES Y CALIFICACIÓN (DINERO).
-- ⚠️  Verifica estos valores con el equipo de comisiones antes de hacer COMMIT.
--
-- Causa: la migración leía nombres de columna v1 equivocados (ej. points_plan
-- en vez de point_personal), así que TODOS los umbrales/porcentajes quedaron
-- en 0/NULL en v2. Los valores de abajo vienen TAL CUAL de v1 (fuente de
-- verdad: t_plan, t_nivel, t_generation). El código de phase-05 ya quedó
-- corregido para futuras corridas; esto repara los datos actuales sin re-correr
-- la fase 5 completa (58 min).
-- ============================================================================

BEGIN;

-- --- Rangos (mlm_ranks ← t_plan): points_personal / points_group / qualifiers / level_max / generation_max ---
UPDATE tonic.mlm_ranks SET points_personal_required=3300,  points_group_required=0,        qualifiers_first_level=0, level_max=2, generation_max=0, updated_at=NOW() WHERE legacy_id=1;   -- Distribuidor
UPDATE tonic.mlm_ranks SET points_personal_required=3300,  points_group_required=50000,    qualifiers_first_level=3, level_max=3, generation_max=0, updated_at=NOW() WHERE legacy_id=2;   -- Bronce
UPDATE tonic.mlm_ranks SET points_personal_required=3300,  points_group_required=170000,   qualifiers_first_level=3, level_max=2, generation_max=1, updated_at=NOW() WHERE legacy_id=3;   -- Plata
UPDATE tonic.mlm_ranks SET points_personal_required=3300,  points_group_required=500000,   qualifiers_first_level=4, level_max=2, generation_max=2, updated_at=NOW() WHERE legacy_id=4;   -- Oro
UPDATE tonic.mlm_ranks SET points_personal_required=3300,  points_group_required=1500000,  qualifiers_first_level=4, level_max=2, generation_max=3, updated_at=NOW() WHERE legacy_id=5;   -- Platino
UPDATE tonic.mlm_ranks SET points_personal_required=6600,  points_group_required=3500000,  qualifiers_first_level=5, level_max=2, generation_max=4, updated_at=NOW() WHERE legacy_id=6;   -- Diamante
UPDATE tonic.mlm_ranks SET points_personal_required=6600,  points_group_required=6750000,  qualifiers_first_level=6, level_max=2, generation_max=4, updated_at=NOW() WHERE legacy_id=7;   -- Doble Diamante
UPDATE tonic.mlm_ranks SET points_personal_required=6600,  points_group_required=9500000,  qualifiers_first_level=7, level_max=2, generation_max=4, updated_at=NOW() WHERE legacy_id=8;   -- Triple Diamante
UPDATE tonic.mlm_ranks SET points_personal_required=6600,  points_group_required=15000000, qualifiers_first_level=8, level_max=2, generation_max=4, updated_at=NOW() WHERE legacy_id=9;   -- Diamante Sirius
UPDATE tonic.mlm_ranks SET points_personal_required=6600,  points_group_required=20000000, qualifiers_first_level=9, level_max=2, generation_max=4, updated_at=NOW() WHERE legacy_id=10;  -- Diamante Azul

-- --- Niveles (mlm_level_commissions ← t_nivel): base / upgraded / qualifiers ---
UPDATE tonic.mlm_level_commissions SET base_percentage=0.15, upgraded_percentage=0.20, qualifiers_required=5, updated_at=NOW() WHERE legacy_id=1;  -- Nivel 1
UPDATE tonic.mlm_level_commissions SET base_percentage=0.05, upgraded_percentage=0,    qualifiers_required=0, updated_at=NOW() WHERE legacy_id=2;  -- Nivel 2
UPDATE tonic.mlm_level_commissions SET base_percentage=0.05, upgraded_percentage=0,    qualifiers_required=0, updated_at=NOW() WHERE legacy_id=3;  -- Nivel 3

-- --- Generaciones (mlm_generation_commissions ← t_generation): generation_number / percentage ---
-- Nota: legacy 5 pasa de generation_number 5 -> 4 (el 4 está libre).
UPDATE tonic.mlm_generation_commissions SET generation_number=0, percentage=0.04, updated_at=NOW() WHERE legacy_id=1;
UPDATE tonic.mlm_generation_commissions SET generation_number=1, percentage=0.05, updated_at=NOW() WHERE legacy_id=2;
UPDATE tonic.mlm_generation_commissions SET generation_number=2, percentage=0.05, updated_at=NOW() WHERE legacy_id=3;
UPDATE tonic.mlm_generation_commissions SET generation_number=3, percentage=0.02, updated_at=NOW() WHERE legacy_id=4;
UPDATE tonic.mlm_generation_commissions SET generation_number=4, percentage=0.02, updated_at=NOW() WHERE legacy_id=5;

-- Verificación (compara contra v1)
SELECT 'ranks'       AS tabla, legacy_id, points_personal_required::text AS v1_personal, points_group_required::text AS v1_group, generation_max::text AS gen_max
FROM tonic.mlm_ranks ORDER BY legacy_id;
SELECT 'levels'      AS tabla, legacy_id, base_percentage, upgraded_percentage, qualifiers_required FROM tonic.mlm_level_commissions ORDER BY legacy_id;
SELECT 'generations' AS tabla, legacy_id, generation_number, percentage FROM tonic.mlm_generation_commissions ORDER BY legacy_id;

COMMIT;
