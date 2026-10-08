-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('RASCUNHO', 'CONFIRMADO', 'PARCIALMENTE_RECEBIDO', 'RECEBIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "receipt_issue" AS ENUM ('INCORRETO', 'DANIFICADO', 'INCOMPLETO', 'OUTRO');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('ENTRADA_COMPRA', 'ESTORNO_RECEBIMENTO', 'SAIDA_OS', 'AJUSTE_ENTRADA', 'AJUSTE_SAIDA');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('ATIVA', 'CONSUMIDA', 'LIBERADA');

-- CreateEnum
CREATE TYPE "leftover_condition" AS ENUM ('BOA', 'AVARIADA');

-- CreateEnum
CREATE TYPE "leftover_status" AS ENUM ('DISPONIVEL', 'ESGOTADA', 'DESCARTADA');

-- CreateEnum
CREATE TYPE "material_readiness" AS ENUM ('SEM_LEVANTAMENTO', 'AGUARDANDO_APROVACAO', 'AGUARDANDO_COMPRA', 'AGUARDANDO_RECEBIMENTO', 'PARCIALMENTE_DISPONIVEL', 'COMPLETO', 'COM_DIVERGENCIA');

-- AlterTable
ALTER TABLE "service_orders" ADD COLUMN     "materials_readiness" "material_readiness" NOT NULL DEFAULT 'SEM_LEVANTAMENTO',
ADD COLUMN     "materials_readiness_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(120),
    "phone" VARCHAR(30),
    "email" VARCHAR(160),
    "address" VARCHAR(300),
    "categories" "material_kind"[],
    "notes" VARCHAR(1000),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" "material_kind" NOT NULL,
    "description" VARCHAR(160) NOT NULL,
    "foam_density" VARCHAR(30),
    "thickness_cm" DECIMAL(8,2),
    "length_cm" DECIMAL(8,2),
    "width_cm" DECIMAL(8,2),
    "unit" "material_unit" NOT NULL,
    "spec_key" VARCHAR(400) NOT NULL,
    "on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "min_quantity" DECIMAL(12,3),
    "location" VARCHAR(120),
    "notes" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "type" "stock_movement_type" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "balance_after" DECIMAL(12,3) NOT NULL,
    "reserved_after" DECIMAL(12,3) NOT NULL,
    "service_order_id" UUID,
    "material_receipt_line_id" UUID,
    "reservation_id" UUID,
    "reason" VARCHAR(500),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "material_requirement_id" UUID,
    "quantity" DECIMAL(12,3) NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'ATIVA',
    "notes" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "close_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "supplier_id" UUID,
    "status" "purchase_order_status" NOT NULL DEFAULT 'RASCUNHO',
    "expected_date" DATE,
    "notes" VARCHAR(2000),
    "created_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "material_kind" NOT NULL,
    "sourcing" "material_sourcing" NOT NULL,
    "description" VARCHAR(160) NOT NULL,
    "color" VARCHAR(60),
    "reference" VARCHAR(80),
    "foam_density" VARCHAR(30),
    "thickness_cm" DECIMAL(8,2),
    "length_cm" DECIMAL(8,2),
    "width_cm" DECIMAL(8,2),
    "unit" "material_unit" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "extra_authorized" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "received_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit_price_cents" INTEGER,
    "service_order_id" UUID,
    "stock_item_id" UUID,
    "notes" VARCHAR(500),

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_allocations" (
    "id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "material_requirement_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_history" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "note" VARCHAR(500),
    "changes" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_receipts" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_id" UUID NOT NULL,
    "device_id" UUID,
    "notes" VARCHAR(1000),

    CONSTRAINT "material_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "accepted_quantity" DECIMAL(12,3) NOT NULL,
    "rejected_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "spec_confirmed" BOOLEAN NOT NULL,
    "issue" "receipt_issue",
    "issue_note" VARCHAR(500),

    CONSTRAINT "material_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_receipt_reversals" (
    "id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "impact" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_receipt_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_leftovers" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "kind" "material_kind" NOT NULL,
    "description" VARCHAR(160) NOT NULL,
    "color" VARCHAR(60),
    "reference" VARCHAR(80),
    "foam_density" VARCHAR(30),
    "thickness_cm" DECIMAL(8,2),
    "quantity" DECIMAL(12,3) NOT NULL,
    "initial_quantity" DECIMAL(12,3) NOT NULL,
    "unit" "material_unit" NOT NULL,
    "location" VARCHAR(120) NOT NULL,
    "condition" "leftover_condition" NOT NULL,
    "reusable" BOOLEAN NOT NULL,
    "status" "leftover_status" NOT NULL DEFAULT 'DISPONIVEL',
    "notes" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "material_leftovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_leftover_transfers" (
    "id" UUID NOT NULL,
    "leftover_id" UUID NOT NULL,
    "from_service_order_id" UUID NOT NULL,
    "to_service_order_id" UUID NOT NULL,
    "to_requirement_id" UUID,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_leftover_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_name_idx" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_number_key" ON "stock_items"("number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_spec_key_key" ON "stock_items"("spec_key");

-- CreateIndex
CREATE INDEX "stock_movements_stock_item_id_created_at_idx" ON "stock_movements"("stock_item_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_service_order_id_idx" ON "stock_movements"("service_order_id");

-- CreateIndex
CREATE INDEX "stock_reservations_service_order_id_idx" ON "stock_reservations"("service_order_id");

-- CreateIndex
CREATE INDEX "stock_reservations_stock_item_id_status_idx" ON "stock_reservations"("stock_item_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_material_requirement_id_idx" ON "stock_reservations"("material_requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_number_key" ON "purchase_orders"("number");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_service_order_id_idx" ON "purchase_order_items"("service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_purchase_order_id_position_key" ON "purchase_order_items"("purchase_order_id", "position");

-- CreateIndex
CREATE INDEX "purchase_allocations_material_requirement_id_idx" ON "purchase_allocations"("material_requirement_id");

-- CreateIndex
CREATE INDEX "purchase_allocations_service_order_id_idx" ON "purchase_allocations"("service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_allocations_purchase_order_item_id_material_requir_key" ON "purchase_allocations"("purchase_order_item_id", "material_requirement_id");

-- CreateIndex
CREATE INDEX "purchase_order_history_purchase_order_id_created_at_idx" ON "purchase_order_history"("purchase_order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "material_receipts_number_key" ON "material_receipts"("number");

-- CreateIndex
CREATE INDEX "material_receipts_purchase_order_id_idx" ON "material_receipts"("purchase_order_id");

-- CreateIndex
CREATE INDEX "material_receipt_lines_purchase_order_item_id_idx" ON "material_receipt_lines"("purchase_order_item_id");

-- CreateIndex
CREATE INDEX "material_receipt_reversals_receipt_line_id_idx" ON "material_receipt_reversals"("receipt_line_id");

-- CreateIndex
CREATE INDEX "material_leftovers_service_order_id_idx" ON "material_leftovers"("service_order_id");

-- CreateIndex
CREATE INDEX "material_leftover_transfers_to_requirement_id_idx" ON "material_leftover_transfers"("to_requirement_id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_material_receipt_line_id_fkey" FOREIGN KEY ("material_receipt_line_id") REFERENCES "material_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "stock_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_material_requirement_id_fkey" FOREIGN KEY ("material_requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_allocations" ADD CONSTRAINT "purchase_allocations_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_allocations" ADD CONSTRAINT "purchase_allocations_material_requirement_id_fkey" FOREIGN KEY ("material_requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_allocations" ADD CONSTRAINT "purchase_allocations_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_history" ADD CONSTRAINT "purchase_order_history_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_history" ADD CONSTRAINT "purchase_order_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipts" ADD CONSTRAINT "material_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipts" ADD CONSTRAINT "material_receipts_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipt_lines" ADD CONSTRAINT "material_receipt_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "material_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipt_lines" ADD CONSTRAINT "material_receipt_lines_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipt_reversals" ADD CONSTRAINT "material_receipt_reversals_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "material_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_receipt_reversals" ADD CONSTRAINT "material_receipt_reversals_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_leftover_id_fkey" FOREIGN KEY ("leftover_id") REFERENCES "material_leftovers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_from_service_order_id_fkey" FOREIGN KEY ("from_service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_to_service_order_id_fkey" FOREIGN KEY ("to_service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_to_requirement_id_fkey" FOREIGN KEY ("to_requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────── Restrições de integridade da Fase 4 ───────────────

-- Fornecedores
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_version_positive" CHECK ("version" >= 1);

-- Estoque comum: nunca negativo, reserva nunca maior que o saldo físico; tecido não entra.
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_not_fabric" CHECK ("kind" <> 'TECIDO');
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_balance" CHECK (
  "on_hand" >= 0 AND "reserved" >= 0 AND "reserved" <= "on_hand"
);
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_min_quantity" CHECK ("min_quantity" IS NULL OR "min_quantity" >= 0);
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_unit_kind" CHECK (
  ("kind" = 'ESPUMA' AND "unit" IN ('PLACA', 'PECA', 'METRO_QUADRADO')) OR "kind" = 'OUTRO'
);
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_version_positive" CHECK ("version" >= 1);

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity" CHECK (
  "quantity" <> 0 AND "balance_after" >= 0 AND "reserved_after" >= 0 AND "reserved_after" <= "balance_after"
);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sign" CHECK (
  ("type" IN ('ENTRADA_COMPRA', 'AJUSTE_ENTRADA') AND "quantity" > 0) OR
  ("type" IN ('ESTORNO_RECEBIMENTO', 'SAIDA_OS', 'AJUSTE_SAIDA') AND "quantity" < 0)
);

ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_quantity" CHECK ("quantity" > 0);
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_closed" CHECK (
  ("status" = 'ATIVA') = ("closed_at" IS NULL)
);
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_version_positive" CHECK ("version" >= 1);

-- Pedidos de compra
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_when_confirmed" CHECK (
  "status" IN ('RASCUNHO', 'CANCELADO') OR ("supplier_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancel_consistency" CHECK (
  ("status" = 'CANCELADO') = ("cancelled_at" IS NOT NULL)
);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_version_positive" CHECK ("version" >= 1);

ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_quantities" CHECK (
  "quantity" > 0 AND "extra_authorized" >= 0 AND "received_quantity" >= 0
  AND "received_quantity" <= "quantity" + "extra_authorized"
);
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_price" CHECK (
  "unit_price_cents" IS NULL OR "unit_price_cents" >= 0
);
-- Tecido só como compra exclusiva; exclusivo sempre com OS; estoque sempre com material do catálogo.
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_sourcing" CHECK (
  ("kind" <> 'TECIDO' OR "sourcing" = 'EXCLUSIVO_OS') AND
  (("sourcing" = 'EXCLUSIVO_OS' AND "service_order_id" IS NOT NULL AND "stock_item_id" IS NULL) OR
   ("sourcing" = 'ESTOQUE' AND "stock_item_id" IS NOT NULL AND "service_order_id" IS NULL))
);
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_integer_units" CHECK (
  "unit" IN ('METRO', 'METRO_QUADRADO') OR ("quantity" = trunc("quantity") AND "extra_authorized" = trunc("extra_authorized"))
);
ALTER TABLE "purchase_allocations" ADD CONSTRAINT "purchase_allocations_quantity" CHECK ("quantity" > 0);

-- Recebimentos de materiais (imutáveis; correção somente por estorno)
ALTER TABLE "material_receipt_lines" ADD CONSTRAINT "material_receipt_lines_quantities" CHECK (
  "accepted_quantity" >= 0 AND "rejected_quantity" >= 0 AND "accepted_quantity" + "rejected_quantity" > 0
);
ALTER TABLE "material_receipt_lines" ADD CONSTRAINT "material_receipt_lines_conference" CHECK (
  ("accepted_quantity" = 0 OR "spec_confirmed") AND ("rejected_quantity" = 0 OR "issue" IS NOT NULL)
);
ALTER TABLE "material_receipt_reversals" ADD CONSTRAINT "material_receipt_reversals_quantity" CHECK ("quantity" > 0);

-- Sobras
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_quantity" CHECK (
  "quantity" >= 0 AND "initial_quantity" > 0 AND "quantity" <= "initial_quantity"
);
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_version_positive" CHECK ("version" >= 1);
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_quantity" CHECK ("quantity" > 0);
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_other_os" CHECK (
  "from_service_order_id" <> "to_service_order_id"
);

-- Registros imutáveis (histórico, recebimentos, estornos, movimentações, transferências).
CREATE TRIGGER "purchase_order_history_immutable" BEFORE UPDATE OR DELETE ON "purchase_order_history"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "material_receipts_immutable" BEFORE UPDATE OR DELETE ON "material_receipts"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "material_receipt_lines_immutable" BEFORE UPDATE OR DELETE ON "material_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "material_receipt_reversals_immutable" BEFORE UPDATE OR DELETE ON "material_receipt_reversals"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "stock_movements_immutable" BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "material_leftover_transfers_immutable" BEFORE UPDATE OR DELETE ON "material_leftover_transfers"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Função protegida Gestor recebe as novas permissões.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('compras.ver'), ('compras.gerenciar'), ('compras.aprovar'),
                   ('estoque.ver'), ('estoque.gerenciar'), ('estoque.autorizar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
