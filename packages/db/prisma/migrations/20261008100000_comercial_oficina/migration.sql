-- CreateEnum
CREATE TYPE "customer_kind" AS ENUM ('PF', 'PJ');

-- CreateEnum
CREATE TYPE "commercial_order_status" AS ENUM ('AGUARDANDO_RETIRADA', 'RETIRADA_AGENDADA', 'RECEBIDO_PARCIAL', 'RECEBIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "piece_type" AS ENUM ('SOFA', 'POLTRONA', 'CADEIRA', 'CABECEIRA', 'CANTO_ALEMAO', 'PUFE', 'BANCO', 'COLCHAO', 'OUTRO');

-- CreateEnum
CREATE TYPE "pickup_status" AS ENUM ('AGUARDANDO_AGENDAMENTO', 'AGENDADA', 'EM_EXECUCAO', 'RETIRADA_REALIZADA', 'RECEBIDA_NA_OFICINA', 'CANCELADA', 'COM_OCORRENCIA');

-- CreateEnum
CREATE TYPE "pickup_team" AS ENUM ('LOGISTICA_TERCEIRIZADA', 'EQUIPE_PROPRIA');

-- CreateEnum
CREATE TYPE "event_source" AS ENUM ('MANUAL', 'SISTEMA', 'INTEGRACAO');

-- CreateEnum
CREATE TYPE "receipt_origin" AS ENUM ('RETIRADA', 'ENTREGUE_PELO_CLIENTE');

-- CreateEnum
CREATE TYPE "piece_condition" AS ENUM ('BOA', 'REGULAR', 'DANIFICADA');

-- CreateEnum
CREATE TYPE "service_order_status" AS ENUM ('ABERTA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('BAIXA', 'NORMAL', 'ALTA', 'URGENTE');

-- CreateEnum
CREATE TYPE "service_type" AS ENUM ('REFORMA_COMPLETA', 'TROCA_DE_TECIDO', 'TROCA_DE_ESPUMA', 'REPARO', 'FABRICACAO', 'INSTALACAO', 'OUTRO');

-- CreateEnum
CREATE TYPE "measurement_kind" AS ENUM ('ROTINA', 'EXTRAORDINARIA');

-- CreateEnum
CREATE TYPE "material_kind" AS ENUM ('TECIDO', 'ESPUMA', 'OUTRO');

-- CreateEnum
CREATE TYPE "material_sourcing" AS ENUM ('EXCLUSIVO_OS', 'ESTOQUE');

-- CreateEnum
CREATE TYPE "attachment_entity" AS ENUM ('COMMERCIAL_ORDER', 'PICKUP', 'RECEIPT', 'SERVICE_ORDER', 'SERVICE_ORDER_ITEM');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "kind" "customer_kind" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "trade_name" VARCHAR(160),
    "document" VARCHAR(14),
    "phone" VARCHAR(13),
    "whatsapp" VARCHAR(13),
    "email" VARCHAR(254),
    "notes" VARCHAR(2000),
    "search_text" VARCHAR(800) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "street" VARCHAR(160) NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "complement" VARCHAR(80),
    "district" VARCHAR(80),
    "city" VARCHAR(80) NOT NULL,
    "state" CHAR(2) NOT NULL,
    "postal_code" CHAR(8),
    "reference" VARCHAR(200),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "pickup_address_id" UUID,
    "pickup_address_snapshot" JSONB,
    "contracted_service" VARCHAR(300) NOT NULL,
    "description" VARCHAR(2000),
    "agreed_value_cents" INTEGER,
    "payment_terms" VARCHAR(1000),
    "notes" VARCHAR(2000),
    "status" "commercial_order_status" NOT NULL DEFAULT 'AGUARDANDO_RETIRADA',
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commercial_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "piece_type" "piece_type" NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "commercial_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "address_id" UUID,
    "address_snapshot" JSONB,
    "scheduled_date" DATE,
    "window_start" CHAR(5),
    "window_end" CHAR(5),
    "team" "pickup_team" NOT NULL DEFAULT 'LOGISTICA_TERCEIRIZADA',
    "team_notes" VARCHAR(200),
    "instructions" VARCHAR(1000),
    "external_reference" VARCHAR(80),
    "status" "pickup_status" NOT NULL DEFAULT 'AGUARDANDO_AGENDAMENTO',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pickup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_request_items" (
    "pickup_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "pickup_request_items_pkey" PRIMARY KEY ("pickup_id","order_item_id")
);

-- CreateTable
CREATE TABLE "pickup_events" (
    "id" UUID NOT NULL,
    "pickup_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "from_status" "pickup_status",
    "to_status" "pickup_status",
    "note" VARCHAR(1000),
    "source" "event_source" NOT NULL DEFAULT 'MANUAL',
    "recorded_by_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pickup_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "pickup_id" UUID,
    "origin" "receipt_origin" NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "received_by_employee_id" UUID,
    "registered_by_id" UUID,
    "divergences" VARCHAR(2000),
    "notes" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" "piece_condition" NOT NULL,
    "condition_notes" VARCHAR(500),
    "location" VARCHAR(80) NOT NULL,

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "service_order_status" NOT NULL DEFAULT 'ABERTA',
    "technical_instructions" VARCHAR(4000),
    "notes" VARCHAR(2000),
    "promised_date" DATE,
    "priority" "priority" NOT NULL DEFAULT 'NORMAL',
    "technical_lead_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_items" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "piece_type" "piece_type" NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "service_type" "service_type" NOT NULL,
    "fabric_name" VARCHAR(120),
    "fabric_color" VARCHAR(80),
    "fabric_reference" VARCHAR(80),
    "foam_specs" VARCHAR(500),
    "technical_notes" VARCHAR(2000),
    "measurements" JSONB NOT NULL DEFAULT '[]',
    "measurement_notes" VARCHAR(1000),
    "measured_at" TIMESTAMPTZ(3),
    "measured_by_id" UUID,
    "measurement_kind" "measurement_kind",
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_revisions" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "item_id" UUID,
    "changes" JSONB NOT NULL,
    "reason" VARCHAR(300),
    "changed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_requirements" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "kind" "material_kind" NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,3),
    "unit" VARCHAR(20),
    "sourcing" "material_sourcing" NOT NULL,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "entity_type" "attachment_entity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "caption" VARCHAR(200),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_whatsapp_idx" ON "customers"("whatsapp");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customer_addresses_customer_id_idx" ON "customer_addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_orders_number_key" ON "commercial_orders"("number");

-- CreateIndex
CREATE INDEX "commercial_orders_customer_id_idx" ON "commercial_orders"("customer_id");

-- CreateIndex
CREATE INDEX "commercial_orders_status_idx" ON "commercial_orders"("status");

-- CreateIndex
CREATE INDEX "commercial_orders_created_at_idx" ON "commercial_orders"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "commercial_order_items_order_id_position_key" ON "commercial_order_items"("order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_requests_number_key" ON "pickup_requests"("number");

-- CreateIndex
CREATE INDEX "pickup_requests_order_id_idx" ON "pickup_requests"("order_id");

-- CreateIndex
CREATE INDEX "pickup_requests_status_idx" ON "pickup_requests"("status");

-- CreateIndex
CREATE INDEX "pickup_requests_scheduled_date_idx" ON "pickup_requests"("scheduled_date");

-- CreateIndex
CREATE INDEX "pickup_events_pickup_id_occurred_at_idx" ON "pickup_events"("pickup_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_number_key" ON "receipts"("number");

-- CreateIndex
CREATE INDEX "receipts_order_id_idx" ON "receipts"("order_id");

-- CreateIndex
CREATE INDEX "receipts_received_at_idx" ON "receipts"("received_at" DESC);

-- CreateIndex
CREATE INDEX "receipt_lines_order_item_id_idx" ON "receipt_lines"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_lines_receipt_id_order_item_id_key" ON "receipt_lines"("receipt_id", "order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_orders_number_key" ON "service_orders"("number");

-- CreateIndex
CREATE INDEX "service_orders_order_id_idx" ON "service_orders"("order_id");

-- CreateIndex
CREATE INDEX "service_orders_customer_id_idx" ON "service_orders"("customer_id");

-- CreateIndex
CREATE INDEX "service_orders_status_idx" ON "service_orders"("status");

-- CreateIndex
CREATE INDEX "service_order_items_order_item_id_idx" ON "service_order_items"("order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_items_service_order_id_position_key" ON "service_order_items"("service_order_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_revisions_service_order_id_revision_key" ON "service_order_revisions"("service_order_id", "revision");

-- CreateIndex
CREATE INDEX "material_requirements_service_order_id_idx" ON "material_requirements"("service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_file_id_key" ON "attachments"("file_id");

-- CreateIndex
CREATE INDEX "attachments_entity_type_entity_id_idx" ON "attachments"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_pickup_address_id_fkey" FOREIGN KEY ("pickup_address_id") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_order_items" ADD CONSTRAINT "commercial_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request_items" ADD CONSTRAINT "pickup_request_items_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_request_items" ADD CONSTRAINT "pickup_request_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_events" ADD CONSTRAINT "pickup_events_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_events" ADD CONSTRAINT "pickup_events_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_received_by_employee_id_fkey" FOREIGN KEY ("received_by_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_technical_lead_id_fkey" FOREIGN KEY ("technical_lead_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_measured_by_id_fkey" FOREIGN KEY ("measured_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_revisions" ADD CONSTRAINT "service_order_revisions_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_revisions" ADD CONSTRAINT "service_order_revisions_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fase 2 — regras de integridade adicionais
-- ─────────────────────────────────────────────────────────────────────────────

-- Clientes: documento só com dígitos, coerente com o tipo; único quando informado.
ALTER TABLE "customers" ADD CONSTRAINT "customers_document_format" CHECK (
  "document" IS NULL
  OR ("kind" = 'PF' AND "document" ~ '^[0-9]{11}$')
  OR ("kind" = 'PJ' AND "document" ~ '^[0-9]{14}$')
);
CREATE UNIQUE INDEX "customers_document_unique" ON "customers" ("document") WHERE "document" IS NOT NULL;
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "customers" ADD CONSTRAINT "customers_phones_digits" CHECK (
  ("phone" IS NULL OR "phone" ~ '^[0-9]{10,13}$') AND ("whatsapp" IS NULL OR "whatsapp" ~ '^[0-9]{10,13}$')
);
ALTER TABLE "customers" ADD CONSTRAINT "customers_version_positive" CHECK ("version" >= 1);
-- No máximo um endereço principal ativo por cliente.
CREATE UNIQUE INDEX "customer_addresses_one_primary" ON "customer_addresses" ("customer_id")
  WHERE "is_primary" AND "archived_at" IS NULL;
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_state" CHECK ("state" ~ '^[A-Z]{2}$');

-- Pedidos
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_value_positive"
  CHECK ("agreed_value_cents" IS NULL OR "agreed_value_cents" >= 0);
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_cancel_consistency" CHECK (
  ("status" = 'CANCELADO') = ("cancelled_at" IS NOT NULL)
);
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_version_positive" CHECK ("version" >= 1);
-- Nunca se recebe mais do que o pedido contém (bloqueia recebimento duplicado no próprio banco).
ALTER TABLE "commercial_order_items" ADD CONSTRAINT "commercial_order_items_quantities" CHECK (
  "quantity" >= 1 AND "received_quantity" >= 0 AND "received_quantity" <= "quantity"
);

-- Retiradas
ALTER TABLE "pickup_request_items" ADD CONSTRAINT "pickup_request_items_quantity" CHECK ("quantity" >= 1);
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_window" CHECK (
  ("window_start" IS NULL OR "window_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  AND ("window_end" IS NULL OR "window_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  AND ("window_start" IS NULL OR "window_end" IS NULL OR "window_end" > "window_start")
);
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_scheduled_requires_date" CHECK (
  "status" NOT IN ('AGENDADA', 'EM_EXECUCAO') OR "scheduled_date" IS NOT NULL
);
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_version_positive" CHECK ("version" >= 1);

-- Recebimentos
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_quantity" CHECK ("quantity" >= 1);
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_pickup_origin" CHECK (
  ("origin" = 'RETIRADA') = ("pickup_id" IS NOT NULL)
);

-- OS
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_quantity" CHECK ("quantity" >= 1);
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_cancel_consistency" CHECK (
  ("status" = 'CANCELADA') = ("cancelled_at" IS NOT NULL)
);
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_version_positive" CHECK ("version" >= 1);
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_fabric_per_os" CHECK (
  "kind" <> 'TECIDO' OR "sourcing" = 'EXCLUSIVO_OS'
);
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_quantity"
  CHECK ("quantity" IS NULL OR "quantity" > 0);

-- Registros históricos imutáveis: linha do tempo das retiradas, recebimentos e
-- histórico técnico das OS (correções geram novos registros, nunca edição).
CREATE TRIGGER "pickup_events_immutable" BEFORE UPDATE OR DELETE ON "pickup_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "receipts_immutable" BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "receipt_lines_immutable" BEFORE UPDATE OR DELETE ON "receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "service_order_revisions_immutable" BEFORE UPDATE OR DELETE ON "service_order_revisions"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- A função protegida Gestor recebe as novas permissões do catálogo.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES
  ('clientes.ver'), ('clientes.gerenciar'), ('pedidos.ver'), ('pedidos.gerenciar'),
  ('pedidos.valores'), ('pedidos.cancelar'), ('retiradas.ver'), ('retiradas.gerenciar'),
  ('recebimentos.registrar'), ('os.ver'), ('os.gerenciar'), ('medicoes.extraordinarias')
) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
