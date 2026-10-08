-- CreateEnum
CREATE TYPE "inspection_status" AS ENUM ('PENDENTE', 'EM_ANDAMENTO', 'APROVADA', 'REPROVADA', 'INVALIDADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "packaging_status" AS ENUM ('PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA', 'INVALIDADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('PROVISORIA', 'AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO', 'CONCLUIDA', 'FRUSTRADA', 'CANCELADA');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "production_activity" ADD VALUE 'CORRECAO';
ALTER TYPE "production_activity" ADD VALUE 'EMBALAGEM';

-- Anexos (fotos) de inspeção, embalagem, entrega e ocorrência logística.
ALTER TYPE "attachment_entity" ADD VALUE 'QUALITY_INSPECTION';
ALTER TYPE "attachment_entity" ADD VALUE 'PACKAGING';
ALTER TYPE "attachment_entity" ADD VALUE 'DELIVERY';
ALTER TYPE "attachment_entity" ADD VALUE 'LOGISTICS_OCCURRENCE';

-- AlterTable
ALTER TABLE "commercial_order_items" ADD COLUMN     "returned_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "quality_inspector_user_id" UUID;

-- AlterTable
ALTER TABLE "pickup_requests" ADD COLUMN     "logistics_user_id" UUID;

-- AlterTable
ALTER TABLE "production_tasks" ADD COLUMN     "inspection_id" UUID;

-- AlterTable
ALTER TABLE "service_order_items" ADD COLUMN     "current_location_id" UUID,
ADD COLUMN     "fulfillment_stage" VARCHAR(30) NOT NULL DEFAULT 'EM_PRODUCAO';

-- CreateTable
CREATE TABLE "quality_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "piece_types" "piece_type"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_template_items" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "guidance" VARCHAR(300),
    "required" BOOLEAN NOT NULL DEFAULT true,
    "service_types" "service_type"[],

    CONSTRAINT "quality_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspections" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "template_id" UUID,
    "round" INTEGER NOT NULL,
    "reason" VARCHAR(30) NOT NULL,
    "status" "inspection_status" NOT NULL DEFAULT 'PENDENTE',
    "inspector_user_id" UUID,
    "substitute_reason" VARCHAR(300),
    "executor_authorized_by_id" UUID,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "due_date" DATE,
    "item_version" INTEGER NOT NULL,
    "os_revision" INTEGER,
    "previous_inspection_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decided_device_id" UUID,
    "decision_note" VARCHAR(1000),
    "invalidated_at" TIMESTAMPTZ(3),
    "invalid_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_inspection_items" (
    "id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "guidance" VARCHAR(300),
    "required" BOOLEAN NOT NULL DEFAULT true,
    "result" VARCHAR(20),
    "note" VARCHAR(500),
    "checked_at" TIMESTAMPTZ(3),
    "checked_by_id" UUID,

    CONSTRAINT "quality_inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_events" (
    "id" UUID NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "inspection_id" UUID,
    "kind" VARCHAR(40) NOT NULL,
    "note" VARCHAR(1000),
    "data" JSONB,
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packaging_records" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "task_id" UUID,
    "status" "packaging_status" NOT NULL DEFAULT 'PENDENTE',
    "assignee_user_id" UUID,
    "tapeceiro_authorized_by_id" UUID,
    "protection" VARCHAR(30),
    "location_id" UUID,
    "notes" VARCHAR(500),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "invalidated_at" TIMESTAMPTZ(3),
    "invalid_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "packaging_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_locations" (
    "id" UUID NOT NULL,
    "key" VARCHAR(30) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_location_events" (
    "id" UUID NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "note" VARCHAR(300),
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_location_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "address_id" UUID,
    "address_snapshot" JSONB NOT NULL,
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(30),
    "scheduled_date" DATE NOT NULL,
    "window_start" CHAR(5),
    "window_end" CHAR(5),
    "team" "pickup_team" NOT NULL DEFAULT 'EQUIPE_PROPRIA',
    "responsible_user_id" UUID,
    "requires_installation" BOOLEAN NOT NULL DEFAULT false,
    "instructions" VARCHAR(1000),
    "notes" VARCHAR(1000),
    "status" "delivery_status" NOT NULL DEFAULT 'PROVISORIA',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "departed_at" TIMESTAMPTZ(3),
    "arrived_at" TIMESTAMPTZ(3),
    "installed_at" TIMESTAMPTZ(3),
    "installation_note" VARCHAR(1000),
    "completed_at" TIMESTAMPTZ(3),
    "completion_note" VARCHAR(1000),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_items" (
    "delivery_id" UUID NOT NULL,
    "service_order_item_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    "note" VARCHAR(500),
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "delivery_items_pkey" PRIMARY KEY ("delivery_id","service_order_item_id")
);

-- CreateTable
CREATE TABLE "delivery_events" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "note" VARCHAR(1000),
    "data" JSONB,
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_occurrences" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "delivery_id" UUID,
    "pickup_id" UUID,
    "service_order_item_id" UUID,
    "description" VARCHAR(1000) NOT NULL,
    "blocks_shipping" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
    "responsible_user_id" UUID,
    "reported_by_id" UUID,
    "device_id" UUID,
    "resolution" VARCHAR(1000),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "logistics_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_occurrence_events" (
    "id" UUID NOT NULL,
    "occurrence_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "note" VARCHAR(1000),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logistics_occurrence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_returns" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'REGISTRADA',
    "reason" VARCHAR(500) NOT NULL,
    "responsible_user_id" UUID,
    "return_date" DATE NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_id" UUID,
    "confirmation_note" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "piece_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "piece_return_lines" (
    "return_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "service_order_item_ids" UUID[],

    CONSTRAINT "piece_return_lines_pkey" PRIMARY KEY ("return_id","order_item_id")
);

-- CreateTable
CREATE TABLE "receipt_corrections" (
    "id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "previous_quantity" INTEGER NOT NULL,
    "new_quantity" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quality_template_items_template_id_position_key" ON "quality_template_items"("template_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "quality_inspections_number_key" ON "quality_inspections"("number");

-- CreateIndex
CREATE INDEX "quality_inspections_status_created_at_idx" ON "quality_inspections"("status", "created_at");

-- CreateIndex
CREATE INDEX "quality_inspections_inspector_user_id_status_idx" ON "quality_inspections"("inspector_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "quality_inspections_service_order_item_id_round_key" ON "quality_inspections"("service_order_item_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "quality_inspection_items_inspection_id_position_key" ON "quality_inspection_items"("inspection_id", "position");

-- CreateIndex
CREATE INDEX "quality_events_service_order_item_id_created_at_idx" ON "quality_events"("service_order_item_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_records_number_key" ON "packaging_records"("number");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_records_inspection_id_key" ON "packaging_records"("inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_records_task_id_key" ON "packaging_records"("task_id");

-- CreateIndex
CREATE INDEX "packaging_records_status_idx" ON "packaging_records"("status");

-- CreateIndex
CREATE INDEX "packaging_records_service_order_item_id_idx" ON "packaging_records"("service_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_locations_key_key" ON "item_locations"("key");

-- CreateIndex
CREATE INDEX "item_location_events_service_order_item_id_created_at_idx" ON "item_location_events"("service_order_item_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_number_key" ON "deliveries"("number");

-- CreateIndex
CREATE INDEX "deliveries_scheduled_date_idx" ON "deliveries"("scheduled_date");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "deliveries_responsible_user_id_status_idx" ON "deliveries"("responsible_user_id", "status");

-- CreateIndex
CREATE INDEX "delivery_items_service_order_item_id_idx" ON "delivery_items"("service_order_item_id");

-- CreateIndex
CREATE INDEX "delivery_events_delivery_id_created_at_idx" ON "delivery_events"("delivery_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_occurrences_number_key" ON "logistics_occurrences"("number");

-- CreateIndex
CREATE INDEX "logistics_occurrences_status_created_at_idx" ON "logistics_occurrences"("status", "created_at");

-- CreateIndex
CREATE INDEX "logistics_occurrence_events_occurrence_id_created_at_idx" ON "logistics_occurrence_events"("occurrence_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "piece_returns_number_key" ON "piece_returns"("number");

-- CreateIndex
CREATE INDEX "piece_returns_order_id_idx" ON "piece_returns"("order_id");

-- CreateIndex
CREATE INDEX "receipt_corrections_receipt_line_id_idx" ON "receipt_corrections"("receipt_line_id");

-- CreateIndex
CREATE INDEX "production_tasks_inspection_id_idx" ON "production_tasks"("inspection_id");

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_logistics_user_id_fkey" FOREIGN KEY ("logistics_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_current_location_id_fkey" FOREIGN KEY ("current_location_id") REFERENCES "item_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "quality_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_template_items" ADD CONSTRAINT "quality_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "quality_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "quality_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_inspector_user_id_fkey" FOREIGN KEY ("inspector_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_inspection_items" ADD CONSTRAINT "quality_inspection_items_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "quality_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_events" ADD CONSTRAINT "quality_events_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_events" ADD CONSTRAINT "quality_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "quality_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_assignee_user_id_fkey" FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "item_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_location_events" ADD CONSTRAINT "item_location_events_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_location_events" ADD CONSTRAINT "item_location_events_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "item_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_location_events" ADD CONSTRAINT "item_location_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_occurrence_events" ADD CONSTRAINT "logistics_occurrence_events_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "logistics_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_return_lines" ADD CONSTRAINT "piece_return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "piece_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "piece_return_lines" ADD CONSTRAINT "piece_return_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_corrections" ADD CONSTRAINT "receipt_corrections_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Regras de integridade
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_round" CHECK ("round" >= 1);
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_reason" CHECK ("reason" IN ('PRODUCAO_CONCLUIDA', 'CORRECAO_CONCLUIDA', 'ALTERACAO_TECNICA', 'MANUAL'));
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_decided" CHECK ("status" NOT IN ('APROVADA', 'REPROVADA') OR ("decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL));
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_rejection_reason" CHECK ("status" <> 'REPROVADA' OR length(trim(coalesce("decision_note", ''))) >= 3);
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_approved_version" CHECK ("status" <> 'APROVADA' OR "os_revision" IS NOT NULL);
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_invalidated" CHECK ("status" <> 'INVALIDADA' OR ("invalidated_at" IS NOT NULL AND "invalid_reason" IS NOT NULL));
ALTER TABLE "quality_inspection_items" ADD CONSTRAINT "quality_inspection_items_result" CHECK ("result" IS NULL OR "result" IN ('OK', 'NAO_CONFORME', 'NAO_SE_APLICA'));
ALTER TABLE "quality_inspection_items" ADD CONSTRAINT "quality_inspection_items_na_optional" CHECK ("result" IS DISTINCT FROM 'NAO_SE_APLICA' OR NOT "required");
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_protection" CHECK ("protection" IS NULL OR "protection" IN ('PLASTICO_BOLHA', 'MANTA', 'PAPELAO', 'FILME_STRETCH', 'CAPA_TECIDO', 'OUTRO'));
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_completed" CHECK ("status" <> 'CONCLUIDA' OR ("completed_at" IS NOT NULL AND "protection" IS NOT NULL AND "location_id" IS NOT NULL));
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_stage" CHECK ("fulfillment_stage" IN ('EM_PRODUCAO', 'AGUARDANDO_INSPECAO', 'EM_INSPECAO', 'EM_CORRECAO', 'AGUARDANDO_EMBALAGEM', 'EM_EMBALAGEM', 'BLOQUEIO_EXPEDICAO', 'PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'EM_TRANSPORTE', 'ENTREGUE', 'DEVOLVIDA', 'CANCELADA'));
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_window" CHECK (("window_start" IS NULL OR "window_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND ("window_end" IS NULL OR "window_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND ("window_start" IS NULL OR "window_end" IS NULL OR "window_start" < "window_end"));
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_completed" CHECK ("status" <> 'CONCLUIDA' OR "completed_at" IS NOT NULL);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_cancelled" CHECK ("status" <> 'CANCELADA' OR length(trim(coalesce("cancel_reason", ''))) >= 3);
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_status" CHECK ("status" IN ('PENDENTE', 'ENTREGUE', 'DIVERGENTE', 'NAO_ENTREGUE'));
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_kind" CHECK ("kind" IN ('CLIENTE_INDISPONIVEL', 'PECA_DANIFICADA', 'ENDERECO_INCORRETO', 'ATRASO_TRANSPORTE', 'INSTALACAO_INCOMPLETA', 'DIVERGENCIA', 'OUTRO'));
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_status" CHECK ("status" IN ('ABERTA', 'EM_TRATAMENTO', 'RESOLVIDA', 'CANCELADA'));
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_target" CHECK ("delivery_id" IS NOT NULL OR "pickup_id" IS NOT NULL OR "service_order_item_id" IS NOT NULL);
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_closed" CHECK (("status" <> 'RESOLVIDA' OR ("resolved_at" IS NOT NULL AND "resolution" IS NOT NULL)) AND ("status" <> 'CANCELADA' OR length(trim(coalesce("cancel_reason", ''))) >= 3));
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_status" CHECK ("status" IN ('REGISTRADA', 'CONFIRMADA', 'CANCELADA'));
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_confirmed" CHECK ("status" <> 'CONFIRMADA' OR ("confirmed_at" IS NOT NULL AND "confirmed_by_id" IS NOT NULL));
ALTER TABLE "piece_return_lines" ADD CONSTRAINT "piece_return_lines_quantity" CHECK ("quantity" > 0);
ALTER TABLE "receipt_corrections" ADD CONSTRAINT "receipt_corrections_quantities" CHECK ("previous_quantity" >= 0 AND "new_quantity" >= 0 AND "previous_quantity" <> "new_quantity");
ALTER TABLE "commercial_order_items" ADD CONSTRAINT "commercial_order_items_returned" CHECK ("returned_quantity" >= 0 AND "returned_quantity" <= "received_quantity");
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_inspection_link" CHECK ("inspection_id" IS NULL OR "activity"::text IN ('CORRECAO', 'EMBALAGEM'));

-- Uma inspeção aberta e uma embalagem aberta por peça; uma entrega ativa por peça.
CREATE UNIQUE INDEX "quality_inspections_one_open" ON "quality_inspections"("service_order_item_id")
  WHERE "status" IN ('PENDENTE', 'EM_ANDAMENTO');
CREATE UNIQUE INDEX "packaging_records_one_open" ON "packaging_records"("service_order_item_id")
  WHERE "status" IN ('PENDENTE', 'EM_ANDAMENTO');
CREATE UNIQUE INDEX "delivery_items_one_active" ON "delivery_items"("service_order_item_id")
  WHERE "active";

-- Históricos imutáveis.
CREATE TRIGGER "quality_events_immutable" BEFORE UPDATE OR DELETE ON "quality_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "item_location_events_immutable" BEFORE UPDATE OR DELETE ON "item_location_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "delivery_events_immutable" BEFORE UPDATE OR DELETE ON "delivery_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "logistics_occurrence_events_immutable" BEFORE UPDATE OR DELETE ON "logistics_occurrence_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "receipt_corrections_immutable" BEFORE UPDATE OR DELETE ON "receipt_corrections"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
-- Registros que nunca são apagados (encerram com motivo).
CREATE TRIGGER "quality_inspections_no_delete" BEFORE DELETE ON "quality_inspections"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "packaging_records_no_delete" BEFORE DELETE ON "packaging_records"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "deliveries_no_delete" BEFORE DELETE ON "deliveries"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "logistics_occurrences_no_delete" BEFORE DELETE ON "logistics_occurrences"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "piece_returns_no_delete" BEFORE DELETE ON "piece_returns"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();

-- Decisão de qualidade é definitiva: reprovação nunca muda; aprovação só pode ser invalidada.
CREATE OR REPLACE FUNCTION cenario_inspection_decided() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('REPROVADA', 'INVALIDADA', 'CANCELADA') THEN
    RAISE EXCEPTION 'Inspeção decidida não pode ser alterada (%).', OLD."status";
  END IF;
  IF OLD."status" = 'APROVADA' AND (NEW."status" <> 'INVALIDADA'
      OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
      OR NEW."decided_by_id" IS DISTINCT FROM OLD."decided_by_id"
      OR NEW."decision_note" IS DISTINCT FROM OLD."decision_note"
      OR NEW."item_version" IS DISTINCT FROM OLD."item_version") THEN
    RAISE EXCEPTION 'Aprovação de qualidade só pode ser invalidada, nunca alterada.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "quality_inspections_decided" BEFORE UPDATE ON "quality_inspections"
  FOR EACH ROW EXECUTE FUNCTION cenario_inspection_decided();
CREATE OR REPLACE FUNCTION cenario_inspection_item_locked() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "quality_inspections" i WHERE i."id" = OLD."inspection_id"
             AND i."status" NOT IN ('PENDENTE', 'EM_ANDAMENTO')) THEN
    RAISE EXCEPTION 'Checklist de inspeção decidida não pode ser alterado.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "quality_inspection_items_locked" BEFORE UPDATE OR DELETE ON "quality_inspection_items"
  FOR EACH ROW EXECUTE FUNCTION cenario_inspection_item_locked();

-- Localizações internas iniciais (configuráveis).
INSERT INTO "item_locations" ("id", "key", "label", "position") VALUES
  (gen_random_uuid(), 'RECEBIMENTO', 'Recebimento', 1),
  (gen_random_uuid(), 'AGUARDANDO_PRODUCAO', 'Aguardando produção', 2),
  (gen_random_uuid(), 'MESA_PRODUCAO', 'Mesa de produção', 3),
  (gen_random_uuid(), 'AREA_TESTES', 'Área de testes', 4),
  (gen_random_uuid(), 'EMBALAGEM', 'Embalagem', 5),
  (gen_random_uuid(), 'EXPEDICAO', 'Expedição', 6),
  (gen_random_uuid(), 'EM_TRANSPORTE', 'Em transporte', 7),
  (gen_random_uuid(), 'ENTREGUE', 'Entregue', 8)
ON CONFLICT ("key") DO NOTHING;

-- Função de logística terceirizada (André e Izaías): só as próprias retiradas e entregas.
INSERT INTO "roles" ("id", "key", "name", "description", "system", "updated_at")
VALUES (gen_random_uuid(), 'logistica_terceirizada', 'Logística terceirizada',
        'Retiradas e entregas atribuídas: endereço, contato operacional, peças, data, horário e instruções. Sem valores comerciais.',
        true, now())
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('producao.acessar'), ('logistica.executar')) AS p(permission)
WHERE r."key" = 'logistica_terceirizada'
ON CONFLICT DO NOTHING;
-- Permissões: Thiago (cabeceiras/qualidade) inspeciona; o Gestor tem o catálogo completo.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('qualidade.inspecionar'), ('qualidade.gerenciar'), ('entregas.ver'),
                   ('entregas.gerenciar'), ('logistica.executar'), ('devolucoes.gerenciar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'qualidade.inspecionar' FROM "roles" r WHERE r."key" = 'cabeceiras_qualidade'
ON CONFLICT DO NOTHING;
