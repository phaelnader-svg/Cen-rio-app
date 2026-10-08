-- CreateEnum
CREATE TYPE "production_activity" AS ENUM ('DESMONTAGEM', 'PREPARACAO', 'PREPARACAO_MDF', 'CORTE_TECIDO', 'CORTE_ESPUMA', 'CORTE', 'COSTURA', 'REVESTIMENTO', 'MONTAGEM', 'ACABAMENTO', 'APOIO', 'OUTRA');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "task_role" AS ENUM ('PRINCIPAL', 'APOIO');

-- CreateEnum
CREATE TYPE "pause_reason" AS ENUM ('FIM_EXPEDIENTE', 'AGUARDANDO_ORIENTACAO', 'INTERRUPCAO_PROGRAMADA', 'OUTRO');

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('RASCUNHO', 'PUBLICADO');

-- CreateTable
CREATE TABLE "production_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "piece_types" "piece_type"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_template_steps" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "activity" "production_activity" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "role" "task_role" NOT NULL DEFAULT 'APOIO',
    "requires_materials" BOOLEAN NOT NULL DEFAULT false,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "depends_on" INTEGER[],

    CONSTRAINT "production_template_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plans" (
    "id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "status" "plan_status" NOT NULL DEFAULT 'RASCUNHO',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "notes" VARCHAR(1000),
    "created_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_items" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "principal_user_id" UUID,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_plan_revisions" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "off_schedule" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_plan_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_tasks" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "plan_id" UUID,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "activity" "production_activity" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "role" "task_role" NOT NULL DEFAULT 'APOIO',
    "assignee_user_id" UUID,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMPTZ(3),
    "due_date" DATE,
    "instructions" VARCHAR(2000),
    "requires_materials" BOOLEAN NOT NULL DEFAULT false,
    "status" "task_status" NOT NULL DEFAULT 'RASCUNHO',
    "blockers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blocked_reason" VARCHAR(500),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "completed_device_id" UUID,
    "pause_reason" "pause_reason",
    "pause_note" VARCHAR(300),
    "progress_note" VARCHAR(500),
    "progress_percent" INTEGER,
    "progress_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_task_dependencies" (
    "task_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_task_dependencies_pkey" PRIMARY KEY ("task_id","depends_on_id")
);

-- CreateTable
CREATE TABLE "production_task_events" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "note" VARCHAR(500),
    "changes" JSONB,
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_template_steps_template_id_position_key" ON "production_template_steps"("template_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "production_plans_week_start_key" ON "production_plans"("week_start");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_items_plan_id_service_order_id_key" ON "production_plan_items"("plan_id", "service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_plan_revisions_plan_id_revision_key" ON "production_plan_revisions"("plan_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "production_tasks_number_key" ON "production_tasks"("number");

-- CreateIndex
CREATE INDEX "production_tasks_assignee_user_id_status_idx" ON "production_tasks"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "production_tasks_service_order_id_idx" ON "production_tasks"("service_order_id");

-- CreateIndex
CREATE INDEX "production_tasks_plan_id_idx" ON "production_tasks"("plan_id");

-- CreateIndex
CREATE INDEX "production_tasks_status_scheduled_at_idx" ON "production_tasks"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "production_task_dependencies_depends_on_id_idx" ON "production_task_dependencies"("depends_on_id");

-- CreateIndex
CREATE INDEX "production_task_events_task_id_created_at_idx" ON "production_task_events"("task_id", "created_at");

-- AddForeignKey
ALTER TABLE "production_template_steps" ADD CONSTRAINT "production_template_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "production_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "production_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_principal_user_id_fkey" FOREIGN KEY ("principal_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_revisions" ADD CONSTRAINT "production_plan_revisions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "production_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_plan_revisions" ADD CONSTRAINT "production_plan_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "production_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_task_dependencies" ADD CONSTRAINT "production_task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_task_dependencies" ADD CONSTRAINT "production_task_dependencies_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "production_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_task_events" ADD CONSTRAINT "production_task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_task_events" ADD CONSTRAINT "production_task_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────── Restrições de integridade da Fase 5 ───────────────

ALTER TABLE "production_templates" ADD CONSTRAINT "production_templates_version_positive" CHECK ("version" >= 1);
ALTER TABLE "production_template_steps" ADD CONSTRAINT "production_template_steps_position" CHECK ("position" >= 1);

ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_monday" CHECK (EXTRACT(ISODOW FROM "week_start") = 1);
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_published" CHECK (
  "status" = 'RASCUNHO' OR ("published_at" IS NOT NULL AND "revision" >= 1)
);
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_version_positive" CHECK ("version" >= 1 AND "revision" >= 0);
ALTER TABLE "production_plan_revisions" ADD CONSTRAINT "production_plan_revisions_positive" CHECK ("revision" >= 1);

ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_execution" CHECK (
  ("status" NOT IN ('EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA') OR "started_at" IS NOT NULL) AND
  ("status" <> 'CONCLUIDA' OR "completed_at" IS NOT NULL) AND
  ("status" <> 'PAUSADA' OR "pause_reason" IS NOT NULL) AND
  ("status" <> 'CANCELADA' OR "cancel_reason" IS NOT NULL)
);
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_started_needs_assignee" CHECK (
  "status" NOT IN ('EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA') OR "assignee_user_id" IS NOT NULL
);
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_progress" CHECK (
  "progress_percent" IS NULL OR ("progress_percent" BETWEEN 0 AND 100)
);
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_version_positive" CHECK ("version" >= 1);
ALTER TABLE "production_task_dependencies" ADD CONSTRAINT "production_task_dependencies_not_self" CHECK ("task_id" <> "depends_on_id");

-- Histórico imutável (revisões publicadas e eventos de tarefas).
CREATE TRIGGER "production_plan_revisions_immutable" BEFORE UPDATE OR DELETE ON "production_plan_revisions"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "production_task_events_immutable" BEFORE UPDATE OR DELETE ON "production_task_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Modelos iniciais (sugestões editáveis pelo gestor).
WITH t AS (
  INSERT INTO "production_templates" ("id", "name", "piece_types", "updated_at")
  VALUES (gen_random_uuid(), 'Reforma de sofá', ARRAY['SOFA', 'CANTO_ALEMAO']::"piece_type"[], now())
  RETURNING "id"
)
INSERT INTO "production_template_steps" ("id", "template_id", "position", "activity", "name", "role", "requires_materials", "optional", "depends_on")
SELECT gen_random_uuid(), t."id", s.p, s.a::"production_activity", s.n, s.r::"task_role", s.m, s.o, s.d
FROM t, (VALUES
  (1, 'DESMONTAGEM', 'Desmontagem', 'APOIO', false, true, ARRAY[]::int[]),
  (2, 'PREPARACAO', 'Preparação', 'APOIO', false, false, ARRAY[1]),
  (3, 'CORTE_TECIDO', 'Corte de tecido', 'PRINCIPAL', true, false, ARRAY[]::int[]),
  (4, 'COSTURA', 'Costura', 'PRINCIPAL', true, false, ARRAY[3]),
  (5, 'MONTAGEM', 'Montagem', 'PRINCIPAL', true, false, ARRAY[2, 4]),
  (6, 'ACABAMENTO', 'Acabamento', 'PRINCIPAL', false, false, ARRAY[5])
) AS s(p, a, n, r, m, o, d);

WITH t AS (
  INSERT INTO "production_templates" ("id", "name", "piece_types", "updated_at")
  VALUES (gen_random_uuid(), 'Cabeceira', ARRAY['CABECEIRA']::"piece_type"[], now())
  RETURNING "id"
)
INSERT INTO "production_template_steps" ("id", "template_id", "position", "activity", "name", "role", "requires_materials", "optional", "depends_on")
SELECT gen_random_uuid(), t."id", s.p, s.a::"production_activity", s.n, s.r::"task_role", s.m, s.o, s.d
FROM t, (VALUES
  (1, 'PREPARACAO_MDF', 'Preparação do MDF', 'APOIO', true, false, ARRAY[]::int[]),
  (2, 'CORTE_ESPUMA', 'Corte de espuma', 'APOIO', true, false, ARRAY[]::int[]),
  (3, 'REVESTIMENTO', 'Revestimento', 'PRINCIPAL', true, false, ARRAY[1, 2]),
  (4, 'MONTAGEM', 'Montagem', 'PRINCIPAL', false, false, ARRAY[3]),
  (5, 'ACABAMENTO', 'Acabamento', 'PRINCIPAL', false, false, ARRAY[4])
) AS s(p, a, n, r, m, o, d);

WITH t AS (
  INSERT INTO "production_templates" ("id", "name", "piece_types", "updated_at")
  VALUES (gen_random_uuid(), 'Cadeira ou poltrona', ARRAY['CADEIRA', 'POLTRONA', 'PUFE', 'BANCO']::"piece_type"[], now())
  RETURNING "id"
)
INSERT INTO "production_template_steps" ("id", "template_id", "position", "activity", "name", "role", "requires_materials", "optional", "depends_on")
SELECT gen_random_uuid(), t."id", s.p, s.a::"production_activity", s.n, s.r::"task_role", s.m, s.o, s.d
FROM t, (VALUES
  (1, 'DESMONTAGEM', 'Desmontagem (quando necessária)', 'APOIO', false, true, ARRAY[]::int[]),
  (2, 'PREPARACAO', 'Preparação', 'APOIO', false, false, ARRAY[1]),
  (3, 'CORTE', 'Corte', 'PRINCIPAL', true, false, ARRAY[]::int[]),
  (4, 'COSTURA', 'Costura', 'PRINCIPAL', true, false, ARRAY[3]),
  (5, 'MONTAGEM', 'Montagem', 'PRINCIPAL', true, false, ARRAY[2, 4]),
  (6, 'ACABAMENTO', 'Acabamento', 'PRINCIPAL', false, false, ARRAY[5])
) AS s(p, a, n, r, m, o, d);

-- Permissões: o Gestor recebe todas; as funções de produção executam as próprias tarefas.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('producao.ver'), ('producao.planejar'), ('producao.executar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'producao.executar'
FROM "roles" r
WHERE r."key" IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante')
ON CONFLICT DO NOTHING;
