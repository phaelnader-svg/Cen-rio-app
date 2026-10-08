-- CreateEnum
CREATE TYPE "material_requirement_origin" AS ENUM ('PREVISAO_MANUAL', 'SOLICITACAO_APROVADA');

-- CreateEnum
CREATE TYPE "measurement_status" AS ENUM ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "material_request_status" AS ENUM ('RASCUNHO', 'ENVIADA', 'EM_REVISAO', 'APROVADA', 'DEVOLVIDA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "material_unit" AS ENUM ('METRO', 'METRO_QUADRADO', 'PLACA', 'PECA', 'UNIDADE', 'EMBALAGEM');

-- AlterTable
ALTER TABLE "material_requirements" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "color" VARCHAR(60),
ADD COLUMN     "foam_density" VARCHAR(30),
ADD COLUMN     "length_cm" DECIMAL(8,2),
ADD COLUMN     "material_request_item_id" UUID,
ADD COLUMN     "origin" "material_requirement_origin" NOT NULL DEFAULT 'PREVISAO_MANUAL',
ADD COLUMN     "reference" VARCHAR(80),
ADD COLUMN     "thickness_cm" DECIMAL(8,2),
ADD COLUMN     "unit_code" "material_unit",
ADD COLUMN     "width_cm" DECIMAL(8,2);

-- CreateTable
CREATE TABLE "measurements" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "kind" "measurement_kind" NOT NULL,
    "status" "measurement_status" NOT NULL DEFAULT 'PENDENTE',
    "assignee_user_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" DATE NOT NULL,
    "reason" VARCHAR(500),
    "notes" VARCHAR(2000),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_pieces" (
    "measurement_id" UUID NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '[]',
    "notes" VARCHAR(1000),

    CONSTRAINT "measurement_pieces_pkey" PRIMARY KEY ("measurement_id","service_order_item_id")
);

-- CreateTable
CREATE TABLE "material_requests" (
    "id" UUID NOT NULL,
    "measurement_id" UUID NOT NULL,
    "status" "material_request_status" NOT NULL DEFAULT 'RASCUNHO',
    "submitted_at" TIMESTAMPTZ(3),
    "reviewed_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "return_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "material_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_request_items" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "service_order_item_id" UUID,
    "kind" "material_kind" NOT NULL,
    "sourcing" "material_sourcing" NOT NULL,
    "description" VARCHAR(160) NOT NULL,
    "color" VARCHAR(60),
    "reference" VARCHAR(80),
    "foam_density" VARCHAR(30),
    "thickness_cm" DECIMAL(8,2),
    "length_cm" DECIMAL(8,2),
    "width_cm" DECIMAL(8,2),
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "material_unit" NOT NULL,
    "notes" VARCHAR(500),

    CONSTRAINT "material_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurement_revisions" (
    "id" UUID NOT NULL,
    "measurement_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(40),
    "to_status" VARCHAR(40),
    "note" VARCHAR(500),
    "changes" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "measurements_number_key" ON "measurements"("number");

-- CreateIndex
CREATE INDEX "measurements_assignee_user_id_status_idx" ON "measurements"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "measurements_service_order_id_idx" ON "measurements"("service_order_id");

-- CreateIndex
CREATE INDEX "measurements_status_due_date_idx" ON "measurements"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "material_requests_measurement_id_key" ON "material_requests"("measurement_id");

-- CreateIndex
CREATE INDEX "material_requests_status_idx" ON "material_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "material_request_items_request_id_position_key" ON "material_request_items"("request_id", "position");

-- CreateIndex
CREATE INDEX "measurement_revisions_measurement_id_created_at_idx" ON "measurement_revisions"("measurement_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "material_requirements_material_request_item_id_key" ON "material_requirements"("material_request_item_id");

-- AddForeignKey
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_material_request_item_id_fkey" FOREIGN KEY ("material_request_item_id") REFERENCES "material_request_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_pieces" ADD CONSTRAINT "measurement_pieces_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "measurements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_pieces" ADD CONSTRAINT "measurement_pieces_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "measurements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "material_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_revisions" ADD CONSTRAINT "measurement_revisions_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "measurements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurement_revisions" ADD CONSTRAINT "measurement_revisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Fase 3 — regras de integridade adicionais
-- ─────────────────────────────────────────────────────────────────────────────

-- Audiência combinada (gestão + responsável) excede 120 caracteres: ampliação segura.
ALTER TABLE "domain_events" ALTER COLUMN "audience" TYPE VARCHAR(400);

-- Medições
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_extraordinary_reason"
  CHECK ("kind" <> 'EXTRAORDINARIA' OR ("reason" IS NOT NULL AND length(trim("reason")) > 0));
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_cancel_consistency"
  CHECK (("status" = 'CANCELADA') = ("cancelled_at" IS NOT NULL));
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_completed_at"
  CHECK ("status" <> 'CONCLUIDA' OR "completed_at" IS NOT NULL);
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_version_positive" CHECK ("version" >= 1);
-- No máximo uma medição ativa por peça (ou por OS inteira): evita tarefas duplicadas.
CREATE UNIQUE INDEX "measurements_one_active_per_target" ON "measurements" (
  "service_order_id", COALESCE("service_order_item_id", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "status" IN ('PENDENTE', 'EM_ANDAMENTO');

-- Solicitações
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_approved_at"
  CHECK ("status" <> 'APROVADA' OR "approved_at" IS NOT NULL);
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_version_positive" CHECK ("version" >= 1);

-- Itens: quantidade positiva, unidade compatível, inteiros para unidades contáveis,
-- tecido sempre exclusivo da OS, medidas de espuma positivas.
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_quantity"
  CHECK ("quantity" > 0);
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_unit_kind" CHECK (
  ("kind" = 'TECIDO' AND "unit" = 'METRO')
  OR ("kind" = 'ESPUMA' AND "unit" IN ('PLACA', 'PECA', 'METRO_QUADRADO'))
  OR ("kind" = 'OUTRO')
);
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_integer_units" CHECK (
  "unit" IN ('METRO', 'METRO_QUADRADO') OR "quantity" = trunc("quantity")
);
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_fabric_per_os"
  CHECK ("kind" <> 'TECIDO' OR "sourcing" = 'EXCLUSIVO_OS');
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_dimensions" CHECK (
  ("thickness_cm" IS NULL OR "thickness_cm" > 0)
  AND ("length_cm" IS NULL OR "length_cm" > 0)
  AND ("width_cm" IS NULL OR "width_cm" > 0)
);

-- Necessidades aprovadas: sempre ligadas ao item da solicitação, com unidade estruturada.
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_approved_origin" CHECK (
  "origin" <> 'SOLICITACAO_APROVADA'
  OR ("material_request_item_id" IS NOT NULL AND "unit_code" IS NOT NULL AND "quantity" IS NOT NULL AND "approved_at" IS NOT NULL)
);

-- Histórico das medições é imutável.
CREATE TRIGGER "measurement_revisions_immutable" BEFORE UPDATE OR DELETE ON "measurement_revisions"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Função protegida Gestor recebe as novas permissões.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('medicoes.gerenciar'), ('materiais.ver'), ('materiais.aprovar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
