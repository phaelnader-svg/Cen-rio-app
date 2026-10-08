-- CreateEnum
CREATE TYPE "help_status" AS ENUM ('PENDENTE', 'ATRIBUIDA', 'EM_EXECUCAO', 'CONCLUIDA', 'CANCELADA', 'ESCALADA');

-- CreateEnum
CREATE TYPE "proposal_status" AS ENUM ('PENDENTE', 'APROVADA', 'AJUSTADA', 'REJEITADA', 'OBSOLETA');

-- AlterTable
ALTER TABLE "production_tasks" ADD COLUMN     "estimated_minutes" INTEGER,
ADD COLUMN     "support_for_task_id" UUID;

-- CreateTable
CREATE TABLE "employee_skills" (
    "employee_id" UUID NOT NULL,
    "skill" VARCHAR(30) NOT NULL,
    "granted_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_skills_pkey" PRIMARY KEY ("employee_id","skill")
);

-- CreateTable
CREATE TABLE "help_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "justification" VARCHAR(300),
    "note" VARCHAR(300),
    "status" "help_status" NOT NULL DEFAULT 'PENDENTE',
    "helper_user_id" UUID,
    "support_task_id" UUID,
    "assigned_at" TIMESTAMPTZ(3),
    "escalated_at" TIMESTAMPTZ(3),
    "delay_alerted_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "help_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_request_events" (
    "id" UUID NOT NULL,
    "help_request_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "note" VARCHAR(500),
    "evaluation" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_proposals" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" "proposal_status" NOT NULL DEFAULT 'PENDENTE',
    "critical" BOOLEAN NOT NULL DEFAULT true,
    "situation" VARCHAR(500) NOT NULL,
    "problem" VARCHAR(500) NOT NULL,
    "affected_task_ids" UUID[],
    "alternatives" JSONB NOT NULL,
    "proposed_alternative_id" VARCHAR(40) NOT NULL,
    "chosen_alternative_id" VARCHAR(40),
    "applied_actions" JSONB,
    "dedupe_key" VARCHAR(160) NOT NULL,
    "attendance_id" UUID,
    "help_request_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reschedule_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_actions" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "automatic" BOOLEAN NOT NULL,
    "task_id" UUID,
    "help_request_id" UUID,
    "proposal_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planning_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_skills_skill_idx" ON "employee_skills"("skill");

-- CreateIndex
CREATE UNIQUE INDEX "help_requests_number_key" ON "help_requests"("number");

-- CreateIndex
CREATE UNIQUE INDEX "help_requests_support_task_id_key" ON "help_requests"("support_task_id");

-- CreateIndex
CREATE INDEX "help_requests_status_urgent_created_at_idx" ON "help_requests"("status", "urgent", "created_at");

-- CreateIndex
CREATE INDEX "help_requests_requester_user_id_created_at_idx" ON "help_requests"("requester_user_id", "created_at");

-- CreateIndex
CREATE INDEX "help_requests_helper_user_id_status_idx" ON "help_requests"("helper_user_id", "status");

-- CreateIndex
CREATE INDEX "help_request_events_help_request_id_created_at_idx" ON "help_request_events"("help_request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_proposals_number_key" ON "reschedule_proposals"("number");

-- CreateIndex
CREATE UNIQUE INDEX "reschedule_proposals_dedupe_key_key" ON "reschedule_proposals"("dedupe_key");

-- CreateIndex
CREATE INDEX "reschedule_proposals_status_created_at_idx" ON "reschedule_proposals"("status", "created_at");

-- CreateIndex
CREATE INDEX "planning_actions_created_at_idx" ON "planning_actions"("created_at");

-- CreateIndex
CREATE INDEX "planning_actions_task_id_idx" ON "planning_actions"("task_id");

-- CreateIndex
CREATE INDEX "production_tasks_support_for_task_id_idx" ON "production_tasks"("support_for_task_id");

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_support_for_task_id_fkey" FOREIGN KEY ("support_for_task_id") REFERENCES "production_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_support_task_id_fkey" FOREIGN KEY ("support_task_id") REFERENCES "production_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_helper_user_id_fkey" FOREIGN KEY ("helper_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_request_events" ADD CONSTRAINT "help_request_events_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "help_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_request_events" ADD CONSTRAINT "help_request_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "operational_attendances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "help_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_actions" ADD CONSTRAINT "planning_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Regras de integridade
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_estimated_minutes_range" CHECK ("estimated_minutes" IS NULL OR "estimated_minutes" BETWEEN 1 AND 1440);
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_support_not_self" CHECK ("support_for_task_id" IS NULL OR "support_for_task_id" <> "id");
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_skill" CHECK ("skill" IN ('PARAFUSAR', 'MOVIMENTAR', 'AUXILIAR_MONTAGEM', 'POSICIONAR', 'APOIO_GERAL', 'DESMONTAGEM', 'PREPARACAO', 'CABECEIRA', 'REPARO', 'INSTALACAO', 'INSPECAO', 'CORTE_COSTURA'));
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_kind" CHECK ("kind" IN ('PARAFUSAR', 'MOVIMENTAR', 'AUXILIAR_MONTAGEM', 'POSICIONAR', 'OUTRO'));
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_minutes_range" CHECK ("estimated_minutes" BETWEEN 5 AND 240);
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_urgent_justified" CHECK (NOT "urgent" OR length(trim(coalesce("justification", ''))) >= 5);
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_assigned_consistent" CHECK ("status" NOT IN ('ATRIBUIDA', 'EM_EXECUCAO', 'CONCLUIDA') OR ("helper_user_id" IS NOT NULL AND "support_task_id" IS NOT NULL AND "assigned_at" IS NOT NULL));
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_helper_not_requester" CHECK ("helper_user_id" IS NULL OR "helper_user_id" <> "requester_user_id");
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_cancelled" CHECK ("status" <> 'CANCELADA' OR "cancelled_at" IS NOT NULL);
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_completed" CHECK ("status" <> 'CONCLUIDA' OR "completed_at" IS NOT NULL);
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_version_positive" CHECK ("version" >= 1);
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_kind" CHECK ("kind" IN ('AUSENCIA', 'BLOQUEIO', 'AJUDA_URGENTE', 'CONFLITO'));
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_decided" CHECK ("status" IN ('PENDENTE', 'OBSOLETA') OR "decided_at" IS NOT NULL);
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_chosen" CHECK ("status" NOT IN ('APROVADA', 'AJUSTADA') OR "chosen_alternative_id" IS NOT NULL);
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_version_positive" CHECK ("version" >= 1);

-- Uma solicitação aberta por pessoa e tarefa (evita pedidos duplicados).
CREATE UNIQUE INDEX "help_requests_one_open_per_task" ON "help_requests"("task_id", "requester_user_id")
  WHERE "status" IN ('PENDENTE', 'ATRIBUIDA', 'EM_EXECUCAO', 'ESCALADA');

-- Históricos imutáveis (toda decisão automática ou aprovada fica registrada).
CREATE TRIGGER "help_request_events_immutable" BEFORE UPDATE OR DELETE ON "help_request_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "planning_actions_immutable" BEFORE UPDATE OR DELETE ON "planning_actions"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Permissões: tapeceiros e cabeceiras pedem ajuda; o Gestor tem o catálogo completo.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'ajuda.solicitar'
FROM "roles" r
WHERE r."key" IN ('gestor', 'tapeceiro', 'cabeceiras_qualidade')
ON CONFLICT DO NOTHING;

-- Competências iniciais por função (o gestor ajusta depois na tela de competências).
INSERT INTO "employee_skills" ("employee_id", "skill")
SELECT e."id", s.skill
FROM "employees" e
JOIN "user_roles" ur ON ur."user_id" = e."user_id"
JOIN "roles" r ON r."id" = ur."role_id"
JOIN (VALUES
  ('ajudante', 'PARAFUSAR'), ('ajudante', 'MOVIMENTAR'), ('ajudante', 'AUXILIAR_MONTAGEM'),
  ('ajudante', 'POSICIONAR'), ('ajudante', 'APOIO_GERAL'), ('ajudante', 'DESMONTAGEM'),
  ('ajudante', 'PREPARACAO'),
  ('cabeceiras_qualidade', 'PARAFUSAR'), ('cabeceiras_qualidade', 'MOVIMENTAR'),
  ('cabeceiras_qualidade', 'AUXILIAR_MONTAGEM'), ('cabeceiras_qualidade', 'POSICIONAR'),
  ('cabeceiras_qualidade', 'APOIO_GERAL'), ('cabeceiras_qualidade', 'DESMONTAGEM'),
  ('cabeceiras_qualidade', 'PREPARACAO'), ('cabeceiras_qualidade', 'CABECEIRA'),
  ('cabeceiras_qualidade', 'REPARO'), ('cabeceiras_qualidade', 'INSTALACAO'),
  ('cabeceiras_qualidade', 'INSPECAO'),
  ('tapeceiro', 'CORTE_COSTURA')
) AS s(role_key, skill) ON s.role_key = r."key"
ON CONFLICT DO NOTHING;
