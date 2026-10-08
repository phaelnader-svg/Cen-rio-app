-- Fase 6: interface operacional dos tablets (aditiva; nenhuma migration anterior alterada).

-- CreateEnum
CREATE TYPE "completion_requirement" AS ENUM ('NENHUM', 'OBSERVACAO', 'FOTO');

-- AlterEnum
ALTER TYPE "attachment_entity" ADD VALUE 'PRODUCTION_TASK';

-- AlterTable
ALTER TABLE "production_tasks" ADD COLUMN     "completion_note" VARCHAR(500),
ADD COLUMN     "completion_requirement" "completion_requirement" NOT NULL DEFAULT 'NENHUM',
ADD COLUMN     "pause_impediment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "progress_next" VARCHAR(200),
ADD COLUMN     "progress_step" VARCHAR(200);

-- AlterTable
ALTER TABLE "production_template_steps" ADD COLUMN     "completion_requirement" "completion_requirement" NOT NULL DEFAULT 'NENHUM';

-- CreateTable
CREATE TABLE "production_task_materials" (
    "task_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_task_materials_pkey" PRIMARY KEY ("task_id","requirement_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "body" VARCHAR(300) NOT NULL,
    "task_id" UUID,
    "service_order_id" UUID,
    "dedupe_key" VARCHAR(160) NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_task_materials_requirement_id_idx" ON "production_task_materials"("requirement_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "production_task_materials" ADD CONSTRAINT "production_task_materials_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_task_materials" ADD CONSTRAINT "production_task_materials_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "material_requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Regras de integridade
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_read_after_created" CHECK ("read_at" IS NULL OR "read_at" >= "created_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_not_blank" CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0 AND length(btrim("dedupe_key")) > 0);
-- Pausa por impedimento só faz sentido em tarefa pausada.
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_impediment_paused" CHECK (NOT "pause_impediment" OR "status" = 'PAUSADA');
