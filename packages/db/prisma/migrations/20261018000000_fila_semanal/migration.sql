-- Evolução, Fase 2: planejamento semanal contínuo (fila por funcionário).
-- Migration ADITIVA: nenhuma coluna existente é alterada ou removida; nenhum dado é reescrito.
-- Planos existentes (publicados ou rascunho) ficam LEGADO e preservam horários e regras.

-- Modo do planejamento (novo tipo; não altera enums existentes).
CREATE TYPE "plan_mode" AS ENUM ('LEGADO', 'FILA_SEMANAL');
ALTER TABLE "production_plans" ADD COLUMN "mode" "plan_mode" NOT NULL DEFAULT 'LEGADO';

-- Fila: posição definida pelo gestor, semana de origem da pendência transferida e marcação
-- das tarefas que contam como "principal ativa" (calculada no banco, abaixo).
ALTER TABLE "production_tasks"
  ADD COLUMN "queue_position" INTEGER,
  ADD COLUMN "carried_from_plan_id" UUID,
  ADD COLUMN "queue_exclusive" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "production_tasks"
  ADD CONSTRAINT "production_tasks_queue_position_positive"
  CHECK ("queue_position" IS NULL OR "queue_position" > 0);

ALTER TABLE "production_tasks"
  ADD CONSTRAINT "production_tasks_carried_from_plan_id_fkey"
  FOREIGN KEY ("carried_from_plan_id") REFERENCES "production_plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Leitura da fila de cada funcionário (só tarefas em aberto).
CREATE INDEX "production_tasks_queue_open_idx"
  ON "production_tasks" ("assignee_user_id", "plan_id", "priority", "queue_position", "sequence")
  WHERE "status" NOT IN ('CONCLUIDA', 'CANCELADA');

-- queue_exclusive = tarefa de plano FILA_SEMANAL que não é apoio (ajuda). Calculado pelo banco a
-- cada inclusão ou mudança de plano/apoio: nenhum caminho de código consegue esquecer a marcação.
CREATE FUNCTION cenario_task_queue_exclusive() RETURNS trigger AS $$
BEGIN
  NEW.queue_exclusive := NEW.support_for_task_id IS NULL
    AND NEW.plan_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM production_plans p WHERE p.id = NEW.plan_id AND p.mode = 'FILA_SEMANAL'
    );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "production_tasks_queue_exclusive"
  BEFORE INSERT OR UPDATE OF "plan_id", "support_for_task_id", "queue_exclusive"
  ON "production_tasks" FOR EACH ROW EXECUTE FUNCTION cenario_task_queue_exclusive();

-- Decisão D-6: no modo fila, no máximo UMA tarefa principal em execução por funcionário
-- (pausadas não contam; apoio de ajuda não conta). Garantido no banco, mesmo sob concorrência.
-- Tarefas existentes ficam com queue_exclusive = false: dados legados não são afetados.
CREATE UNIQUE INDEX "production_tasks_one_active_per_assignee"
  ON "production_tasks" ("assignee_user_id")
  WHERE "status" = 'EM_EXECUCAO' AND "queue_exclusive";

-- O modo de um planejamento não muda depois de criado (D-1: nada migra automaticamente).
CREATE FUNCTION cenario_plan_mode_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'O modo do planejamento não pode ser alterado'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "production_plans_mode_immutable"
  BEFORE UPDATE OF "mode" ON "production_plans"
  FOR EACH ROW EXECUTE FUNCTION cenario_plan_mode_immutable();
