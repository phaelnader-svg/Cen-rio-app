-- REVERSÃO MANUAL da migration 20261025000000_distribuicao_automatica (Evolução, Fase 3).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código da Fase 2 (89a3f58).
-- Remove apenas o que a migration criou. Perdem-se: titular por peça, histórico de
-- titularidade, classe das etapas e o marcador de geração das tarefas (as tarefas, os
-- responsáveis gravados, os eventos e as auditorias permanecem).
-- SEGURANÇA (Evolução, Fase 8): recusa ANTES de qualquer alteração se já existe titular por peça,
-- histórico de titularidade ou tarefa gerada pela distribuição. Recupere pelo backup.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "service_order_item_owner_changes")
       + (SELECT count(*) FROM "service_order_items" WHERE "upholsterer_user_id" IS NOT NULL)
       + (SELECT count(*) FROM "production_tasks" WHERE "template_id" IS NOT NULL) INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da distribuição automática (Fase 3). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TRIGGER IF EXISTS "service_order_item_owner_changes_immutable" ON "service_order_item_owner_changes";
DROP FUNCTION IF EXISTS cenario_owner_change_immutable();
DROP TRIGGER IF EXISTS "production_tasks_upholsterer_check" ON "production_tasks";
DROP FUNCTION IF EXISTS cenario_task_upholsterer_check();
DROP INDEX IF EXISTS "production_tasks_generated_step_unique";
DROP TABLE IF EXISTS "service_order_item_owner_changes";
ALTER TABLE "service_order_items" DROP CONSTRAINT IF EXISTS "service_order_items_upholsterer_user_id_fkey";
ALTER TABLE "service_order_items" DROP COLUMN IF EXISTS "upholsterer_user_id";
ALTER TABLE "production_template_steps" DROP COLUMN IF EXISTS "step_class";
ALTER TABLE "production_tasks"
  DROP COLUMN IF EXISTS "step_class",
  DROP COLUMN IF EXISTS "template_id",
  DROP COLUMN IF EXISTS "template_step_position",
  DROP COLUMN IF EXISTS "template_version";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "preparation_assignee_user_id";
DROP TYPE IF EXISTS "step_class";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025000000_distribuicao_automatica';
COMMIT;
