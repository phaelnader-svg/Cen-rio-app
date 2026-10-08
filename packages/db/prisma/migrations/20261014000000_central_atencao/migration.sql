-- CreateEnum
CREATE TYPE "issue_status" AS ENUM ('ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO', 'AGUARDANDO_VERIFICACAO', 'RESOLVIDA', 'CANCELADA');

-- AlterEnum
ALTER TYPE "attachment_entity" ADD VALUE 'PRODUCTION_ISSUE';

-- AlterTable
ALTER TABLE "production_tasks" ADD COLUMN     "issue_id" UUID;

-- AlterTable
ALTER TABLE "reschedule_proposals" ADD COLUMN     "issue_id" UUID;

-- CreateTable
CREATE TABLE "production_issues" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" "issue_status" NOT NULL DEFAULT 'ABERTA',
    "impact" VARCHAR(20) NOT NULL,
    "blocks_task" BOOLEAN NOT NULL,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "description" VARCHAR(1000) NOT NULL,
    "task_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "reporter_device_id" UUID,
    "material_requirement_id" UUID,
    "stock_item_id" UUID,
    "material_description" VARCHAR(200),
    "material_quantity" DECIMAL(12,3),
    "material_unit" "material_unit",
    "assignee_user_id" UUID,
    "action_task_id" UUID,
    "required_skill" VARCHAR(30),
    "due_at" TIMESTAMPTZ(3),
    "risk_alerted_at" TIMESTAMPTZ(3),
    "result_note" VARCHAR(1000),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" VARCHAR(500),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_issue_events" (
    "id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "from_status" VARCHAR(30),
    "to_status" VARCHAR(30),
    "note" VARCHAR(1000),
    "data" JSONB,
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_issue_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_issues_number_key" ON "production_issues"("number");

-- CreateIndex
CREATE UNIQUE INDEX "production_issues_action_task_id_key" ON "production_issues"("action_task_id");

-- CreateIndex
CREATE INDEX "production_issues_status_created_at_idx" ON "production_issues"("status", "created_at");

-- CreateIndex
CREATE INDEX "production_issues_task_id_status_idx" ON "production_issues"("task_id", "status");

-- CreateIndex
CREATE INDEX "production_issues_assignee_user_id_status_idx" ON "production_issues"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "production_issues_service_order_id_idx" ON "production_issues"("service_order_id");

-- CreateIndex
CREATE INDEX "production_issue_events_issue_id_created_at_idx" ON "production_issue_events"("issue_id", "created_at");

-- CreateIndex
CREATE INDEX "production_tasks_issue_id_idx" ON "production_tasks"("issue_id");

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "production_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "production_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_action_task_id_fkey" FOREIGN KEY ("action_task_id") REFERENCES "production_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_material_requirement_id_fkey" FOREIGN KEY ("material_requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issue_events" ADD CONSTRAINT "production_issue_events_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "production_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_issue_events" ADD CONSTRAINT "production_issue_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Regras de integridade
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_kind" CHECK ("kind" IN ('MATERIAL', 'TECNICO', 'OUTRO'));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_impact" CHECK ("impact" IN ('IMPEDIDO', 'DIFICULDADE', 'OUTRA_ATIVIDADE'));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_blocks" CHECK ("blocks_task" = ("impact" <> 'DIFICULDADE'));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_description" CHECK (length(trim("description")) >= 3);
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_material" CHECK ("kind" <> 'MATERIAL' OR ("material_description" IS NOT NULL AND "material_quantity" > 0 AND "material_unit" IS NOT NULL));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_assigned" CHECK ("status" NOT IN ('ATRIBUIDA', 'EM_RESOLUCAO') OR "assignee_user_id" IS NOT NULL);
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_resolved" CHECK ("status" <> 'RESOLVIDA' OR ("resolved_at" IS NOT NULL AND "resolved_by_id" IS NOT NULL));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_cancelled" CHECK ("status" <> 'CANCELADA' OR ("cancelled_at" IS NOT NULL AND length(trim(coalesce("cancel_reason", ''))) >= 3));
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_version_positive" CHECK ("version" >= 1 AND "reopen_count" >= 0);
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_issue_not_support" CHECK ("issue_id" IS NULL OR "support_for_task_id" IS NULL);

-- Histórico imutável da ocorrência.
CREATE TRIGGER "production_issue_events_immutable" BEFORE UPDATE OR DELETE ON "production_issue_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
-- Ocorrências nunca são apagadas (encerram como resolvidas ou canceladas).
CREATE OR REPLACE FUNCTION cenario_reject_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Registro não pode ser excluído (%).', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "production_issues_no_delete" BEFORE DELETE ON "production_issues"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();

-- Permissões: a oficina registra ocorrências das próprias tarefas; o Gestor vê e gerencia.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('ocorrencias.registrar'), ('ocorrencias.ver'), ('ocorrencias.gerenciar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'ocorrencias.registrar'
FROM "roles" r
WHERE r."key" IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante')
ON CONFLICT DO NOTHING;
