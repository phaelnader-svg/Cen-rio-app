-- Evolução, Fase 3: distribuição automática de tarefas por OS e peça.
-- Migration ADITIVA: nenhuma coluna existente é alterada ou removida; nenhuma tarefa, plano,
-- titular ou valor financeiro existente é reescrito. Planos LEGADO e suas tarefas ficam como estão.

-- CreateEnum
CREATE TYPE "step_class" AS ENUM ('PREPARACAO', 'TAPECARIA', 'OUTRA');
-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "preparation_assignee_user_id" UUID;
-- AlterTable
ALTER TABLE "production_tasks" ADD COLUMN     "step_class" "step_class",
ADD COLUMN     "template_id" UUID,
ADD COLUMN     "template_step_position" INTEGER,
ADD COLUMN     "template_version" INTEGER;
-- AlterTable
ALTER TABLE "production_template_steps" ADD COLUMN     "step_class" "step_class";
-- AlterTable
ALTER TABLE "service_order_items" ADD COLUMN     "upholsterer_user_id" UUID;
-- CreateTable
CREATE TABLE "service_order_item_owner_changes" (
    "id" UUID NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "from_user_id" UUID,
    "to_user_id" UUID NOT NULL,
    "reason" VARCHAR(500),
    "moved_task_ids" UUID[],
    "financial_review_required" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_order_item_owner_changes_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "service_order_item_owner_changes_service_order_item_id_crea_idx" ON "service_order_item_owner_changes"("service_order_item_id", "created_at");
-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_upholsterer_user_id_fkey" FOREIGN KEY ("upholsterer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "service_order_item_owner_changes" ADD CONSTRAINT "service_order_item_owner_changes_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "service_order_item_owner_changes" ADD CONSTRAINT "service_order_item_owner_changes_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "service_order_item_owner_changes" ADD CONSTRAINT "service_order_item_owner_changes_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "service_order_item_owner_changes" ADD CONSTRAINT "service_order_item_owner_changes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Classificação das etapas dos modelos existentes: só quando atividade e papel CONCORDAM.
-- Combinações ambíguas (ex.: montagem como APOIO) ficam NULL e aparecem como pendência
-- "etapa sem classificação" — nunca uma atribuição silenciosa.
UPDATE "production_template_steps" SET "step_class" = CASE
  WHEN "activity" IN ('DESMONTAGEM','PREPARACAO','PREPARACAO_MDF','CORTE_ESPUMA') AND "role" = 'APOIO'
    THEN 'PREPARACAO'::"step_class"
  WHEN "activity" IN ('CORTE_TECIDO','CORTE','COSTURA','REVESTIMENTO','MONTAGEM','ACABAMENTO') AND "role" = 'PRINCIPAL'
    THEN 'TAPECARIA'::"step_class"
  WHEN "activity" IN ('APOIO','OUTRA') AND "role" = 'APOIO'
    THEN 'OUTRA'::"step_class"
  ELSE NULL
END;

-- Idempotência da geração: no máximo uma tarefa viva por peça + etapa do modelo (canceladas não
-- contam). Tarefas antigas (template_id nulo) não entram no índice.
CREATE UNIQUE INDEX "production_tasks_generated_step_unique"
  ON "production_tasks" ("service_order_item_id", "template_id", "template_step_position")
  WHERE "template_id" IS NOT NULL AND "status" <> 'CANCELADA';

-- Titular único da tapeçaria (CA3-01): uma tarefa classificada como TAPECARIA de uma peça com
-- titular só pode ser atribuída ao titular (ou ficar sem responsável). Tarefas já concluídas não
-- são tocadas pela substituição; o gatilho só age quando o responsável é gravado.
CREATE FUNCTION cenario_task_upholsterer_check() RETURNS trigger AS $$
DECLARE owner UUID;
BEGIN
  IF NEW.step_class = 'TAPECARIA' AND NEW.assignee_user_id IS NOT NULL
     AND NEW.service_order_item_id IS NOT NULL THEN
    SELECT upholsterer_user_id INTO owner FROM service_order_items WHERE id = NEW.service_order_item_id;
    IF owner IS NOT NULL AND owner <> NEW.assignee_user_id THEN
      RAISE EXCEPTION 'A tapeçaria da peça é do tapeceiro titular'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "production_tasks_upholsterer_check"
  BEFORE INSERT OR UPDATE OF "assignee_user_id", "step_class", "service_order_item_id"
  ON "production_tasks" FOR EACH ROW EXECUTE FUNCTION cenario_task_upholsterer_check();

-- Histórico de titularidade é imutável (como as revisões do planejamento).
CREATE FUNCTION cenario_owner_change_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'O histórico de titularidade é imutável' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "service_order_item_owner_changes_immutable"
  BEFORE UPDATE OR DELETE ON "service_order_item_owner_changes"
  FOR EACH ROW EXECUTE FUNCTION cenario_owner_change_immutable();
