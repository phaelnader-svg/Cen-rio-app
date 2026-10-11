-- REVERSÃO MANUAL da migration 20261213000000_pre_planejamento (Simplificação, Fase 4).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (0b7b967).
-- SEGURANÇA: só é permitida enquanto NENHUMA OS tiver sido planejada pelo fluxo novo (data de
-- início, autor ou reprogramação registrados). Havendo, aborta ANTES de qualquer alteração —
-- perderia a data pretendida de início (que impede liberar tarefas antes da hora): recupere
-- pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "production_plan_items"
   WHERE "start_date" IS NOT NULL OR "planned_by_id" IS NOT NULL OR "version" <> 1;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % OS planejada(s) pelo pré-planejamento (Fase 4). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
ALTER TABLE "production_plan_items" DROP CONSTRAINT IF EXISTS "production_plan_items_version_positive";
ALTER TABLE "production_plan_items" DROP CONSTRAINT IF EXISTS "production_plan_items_planned_by_id_fkey";
ALTER TABLE "production_plan_items" DROP COLUMN IF EXISTS "planned_by_id";
ALTER TABLE "production_plan_items" DROP COLUMN IF EXISTS "start_date";
ALTER TABLE "production_plan_items" DROP COLUMN IF EXISTS "version";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261213000000_pre_planejamento';
COMMIT;
