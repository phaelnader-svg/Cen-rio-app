-- REVERSÃO MANUAL da migration 20261018000000_fila_semanal (Evolução, Fase 2).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (839770a).
-- Remove apenas o que a migration criou. ATENÇÃO: planejamentos criados em FILA_SEMANAL
-- continuam existindo, mas o código anterior os tratará como "por horário" (tarefas sem
-- horário ficam PROGRAMADA até o gestor definir data/hora). Posições de fila e a semana de
-- origem das pendências transferidas são perdidas (os eventos TRANSFERIDA_SEMANA/FILA_REORDENADA
-- e as revisões permanecem no histórico).
BEGIN;
DROP TRIGGER IF EXISTS "production_plans_mode_immutable" ON "production_plans";
DROP FUNCTION IF EXISTS cenario_plan_mode_immutable();
DROP INDEX IF EXISTS "production_tasks_one_active_per_assignee";
DROP TRIGGER IF EXISTS "production_tasks_queue_exclusive" ON "production_tasks";
DROP FUNCTION IF EXISTS cenario_task_queue_exclusive();
DROP INDEX IF EXISTS "production_tasks_queue_open_idx";
ALTER TABLE "production_tasks" DROP CONSTRAINT IF EXISTS "production_tasks_carried_from_plan_id_fkey";
ALTER TABLE "production_tasks" DROP CONSTRAINT IF EXISTS "production_tasks_queue_position_positive";
ALTER TABLE "production_tasks"
  DROP COLUMN IF EXISTS "queue_exclusive",
  DROP COLUMN IF EXISTS "carried_from_plan_id",
  DROP COLUMN IF EXISTS "queue_position";
ALTER TABLE "production_plans" DROP COLUMN IF EXISTS "mode";
DROP TYPE IF EXISTS "plan_mode";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018000000_fila_semanal';
COMMIT;
