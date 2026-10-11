-- Simplificação Fase 4 — pré-planejamento: data pretendida de início da OS na semana, quem
-- planejou e versão (reprogramação concorrente). Somente ADITIVA; itens existentes ficam com
-- data nula (sem restrição de início), exatamente como funcionavam.

-- AlterTable
ALTER TABLE "production_plan_items" ADD COLUMN     "planned_by_id" UUID,
ADD COLUMN     "start_date" DATE,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AddForeignKey
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_planned_by_id_fkey" FOREIGN KEY ("planned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Versão sempre positiva.
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_version_positive"
  CHECK ("version" >= 1);
