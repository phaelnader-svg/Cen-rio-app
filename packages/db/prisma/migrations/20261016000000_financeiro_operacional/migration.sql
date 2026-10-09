-- AlterEnum
ALTER TYPE "attachment_entity" ADD VALUE 'FINANCE_PAYABLE';

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "tax_rate_bps" INTEGER;

-- AlterTable
ALTER TABLE "service_orders" ADD COLUMN     "revenue_cents" INTEGER;

-- CreateTable
CREATE TABLE "commercial_adjustments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commercial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receivables" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "service_order_id" UUID,
    "description" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "received_cents" INTEGER NOT NULL DEFAULT 0,
    "due_date" DATE NOT NULL,
    "expected_method" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ABERTO',
    "notes" VARCHAR(1000),
    "cancel_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_receivables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payments" (
    "id" UUID NOT NULL,
    "receivable_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "received_at" DATE NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "reversal_of_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_order_costs" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "category" VARCHAR(20) NOT NULL,
    "source" VARCHAR(30) NOT NULL,
    "source_key" VARCHAR(120) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,3),
    "unit_cost_cents" INTEGER,
    "amount_cents" INTEGER NOT NULL,
    "priced" BOOLEAN NOT NULL DEFAULT true,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "note" VARCHAR(500),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_order_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_payables" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "professional_user_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "service" VARCHAR(200) NOT NULL,
    "agreed_cents" INTEGER NOT NULL,
    "adjustments_cents" INTEGER NOT NULL DEFAULT 0,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "eligibility" VARCHAR(30) NOT NULL DEFAULT 'QUALIDADE_APROVADA',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PREVISTO',
    "eligible_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(500),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_adjustments" (
    "id" UUID NOT NULL,
    "production_payable_id" UUID,
    "amount_cents" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_payments" (
    "id" UUID NOT NULL,
    "production_payable_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_at" DATE NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "early_reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_monthly_costs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "notes" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "team_monthly_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_costs" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "delivery_id" UUID,
    "pickup_id" UUID,
    "beneficiary" VARCHAR(160),
    "split_method" VARCHAR(20) NOT NULL,
    "split_note" VARCHAR(500),
    "payable_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "logistics_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_cost_allocations" (
    "id" UUID NOT NULL,
    "logistics_cost_id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "service_order_item_id" UUID,
    "amount_cents" INTEGER NOT NULL,

    CONSTRAINT "logistics_cost_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_expenses" (
    "id" UUID NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "day_of_month" INTEGER NOT NULL,
    "beneficiary" VARCHAR(160),
    "start_month" DATE NOT NULL,
    "end_month" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_expenses" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "competence" DATE NOT NULL,
    "recurring_id" UUID,
    "payable_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "operational_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_payables" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "beneficiary" VARCHAR(160) NOT NULL,
    "supplier_id" UUID,
    "category" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "due_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ABERTO',
    "notes" VARCHAR(1000),
    "cancel_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_payments" (
    "id" UUID NOT NULL,
    "payable_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_at" DATE NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payable_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_events" (
    "id" UUID NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "note" VARCHAR(1000),
    "data" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commercial_adjustments_order_id_created_at_idx" ON "commercial_adjustments"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receivables_number_key" ON "customer_receivables"("number");

-- CreateIndex
CREATE INDEX "customer_receivables_order_id_idx" ON "customer_receivables"("order_id");

-- CreateIndex
CREATE INDEX "customer_receivables_status_due_date_idx" ON "customer_receivables"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_reversal_of_id_key" ON "customer_payments"("reversal_of_id");

-- CreateIndex
CREATE INDEX "customer_payments_receivable_id_idx" ON "customer_payments"("receivable_id");

-- CreateIndex
CREATE INDEX "customer_payments_received_at_idx" ON "customer_payments"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_order_costs_source_key_key" ON "service_order_costs"("source_key");

-- CreateIndex
CREATE INDEX "service_order_costs_service_order_id_occurred_at_idx" ON "service_order_costs"("service_order_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "production_payables_number_key" ON "production_payables"("number");

-- CreateIndex
CREATE INDEX "production_payables_professional_user_id_status_idx" ON "production_payables"("professional_user_id", "status");

-- CreateIndex
CREATE INDEX "production_payables_service_order_id_idx" ON "production_payables"("service_order_id");

-- CreateIndex
CREATE INDEX "financial_adjustments_production_payable_id_idx" ON "financial_adjustments"("production_payable_id");

-- CreateIndex
CREATE INDEX "professional_payments_production_payable_id_idx" ON "professional_payments"("production_payable_id");

-- CreateIndex
CREATE INDEX "professional_payments_paid_at_idx" ON "professional_payments"("paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "team_monthly_costs_user_id_month_key" ON "team_monthly_costs"("user_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_costs_number_key" ON "logistics_costs"("number");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_costs_payable_id_key" ON "logistics_costs"("payable_id");

-- CreateIndex
CREATE INDEX "logistics_costs_date_idx" ON "logistics_costs"("date");

-- CreateIndex
CREATE INDEX "logistics_cost_allocations_service_order_id_idx" ON "logistics_cost_allocations"("service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_cost_allocations_logistics_cost_id_service_order__key" ON "logistics_cost_allocations"("logistics_cost_id", "service_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "operational_expenses_number_key" ON "operational_expenses"("number");

-- CreateIndex
CREATE UNIQUE INDEX "operational_expenses_payable_id_key" ON "operational_expenses"("payable_id");

-- CreateIndex
CREATE INDEX "operational_expenses_competence_idx" ON "operational_expenses"("competence");

-- CreateIndex
CREATE UNIQUE INDEX "operational_expenses_recurring_id_competence_key" ON "operational_expenses"("recurring_id", "competence");

-- CreateIndex
CREATE UNIQUE INDEX "account_payables_number_key" ON "account_payables"("number");

-- CreateIndex
CREATE INDEX "account_payables_status_due_date_idx" ON "account_payables"("status", "due_date");

-- CreateIndex
CREATE INDEX "payable_payments_payable_id_idx" ON "payable_payments"("payable_id");

-- CreateIndex
CREATE INDEX "payable_payments_paid_at_idx" ON "payable_payments"("paid_at");

-- CreateIndex
CREATE INDEX "financial_events_entity_type_entity_id_created_at_idx" ON "financial_events"("entity_type", "entity_id", "created_at");

-- AddForeignKey
ALTER TABLE "commercial_adjustments" ADD CONSTRAINT "commercial_adjustments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_adjustments" ADD CONSTRAINT "commercial_adjustments_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_receivable_id_fkey" FOREIGN KEY ("receivable_id") REFERENCES "customer_receivables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_order_costs" ADD CONSTRAINT "service_order_costs_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_professional_user_id_fkey" FOREIGN KEY ("professional_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_service_order_item_id_fkey" FOREIGN KEY ("service_order_item_id") REFERENCES "service_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_production_payable_id_fkey" FOREIGN KEY ("production_payable_id") REFERENCES "production_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_payments" ADD CONSTRAINT "professional_payments_production_payable_id_fkey" FOREIGN KEY ("production_payable_id") REFERENCES "production_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_monthly_costs" ADD CONSTRAINT "team_monthly_costs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "account_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_allocations" ADD CONSTRAINT "logistics_cost_allocations_logistics_cost_id_fkey" FOREIGN KEY ("logistics_cost_id") REFERENCES "logistics_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_allocations" ADD CONSTRAINT "logistics_cost_allocations_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_expenses" ADD CONSTRAINT "operational_expenses_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_expenses" ADD CONSTRAINT "operational_expenses_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "account_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "account_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────── Fase 11: restrições ───────────────────────────
ALTER TABLE "commercial_adjustments" ADD CONSTRAINT "commercial_adjustments_kind" CHECK (
  ("kind" = 'DESCONTO' AND "amount_cents" < 0) OR ("kind" = 'ACRESCIMO' AND "amount_cents" > 0)
  OR ("kind" = 'AJUSTE' AND "amount_cents" <> 0));
ALTER TABLE "commercial_adjustments" ADD CONSTRAINT "commercial_adjustments_reason" CHECK (length(trim("reason")) >= 3);
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_amounts" CHECK (
  "amount_cents" > 0 AND "received_cents" >= 0 AND "received_cents" <= "amount_cents");
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_status" CHECK (
  "status" IN ('ABERTO', 'PARCIAL', 'RECEBIDO', 'CANCELADO')
  AND ("status" <> 'CANCELADO' OR ("received_cents" = 0 AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_method" CHECK (
  "expected_method" IN ('PIX', 'DINHEIRO', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'TRANSFERENCIA', 'CHEQUE', 'OUTRO'));
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amount" CHECK (
  ("reversal_of_id" IS NULL AND "amount_cents" > 0) OR ("reversal_of_id" IS NOT NULL AND "amount_cents" < 0));
ALTER TABLE "service_order_costs" ADD CONSTRAINT "service_order_costs_kind" CHECK (
  "category" IN ('MATERIAL', 'OUTRO_VARIAVEL')
  AND "source" IN ('COMPRA_EXCLUSIVA', 'ESTORNO_COMPRA', 'SAIDA_ESTOQUE', 'DEVOLUCAO_ESTOQUE', 'SOBRA_SAIDA', 'SOBRA_ENTRADA', 'AJUSTE_MANUAL'));
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_amounts" CHECK (
  "agreed_cents" > 0 AND "paid_cents" >= 0 AND "paid_cents" <= GREATEST("agreed_cents" + "adjustments_cents", 0));
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_status" CHECK (
  "status" IN ('PREVISTO', 'LIBERADO', 'PAGO_PARCIAL', 'PAGO', 'CANCELADO')
  AND "eligibility" IN ('PRODUCAO_CONCLUIDA', 'QUALIDADE_APROVADA', 'ENTREGA_CONCLUIDA')
  AND ("status" <> 'CANCELADO' OR ("paid_cents" = 0 AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_amount" CHECK ("amount_cents" <> 0 AND length(trim("reason")) >= 3);
ALTER TABLE "professional_payments" ADD CONSTRAINT "professional_payments_amount" CHECK ("amount_cents" > 0);
ALTER TABLE "team_monthly_costs" ADD CONSTRAINT "team_monthly_costs_amount" CHECK ("amount_cents" > 0 AND extract(day FROM "month") = 1);
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_kind" CHECK (
  "amount_cents" > 0
  AND "kind" IN ('RETIRADA', 'ENTREGA', 'INSTALACAO', 'TRANSPORTE_TERCEIRIZADO', 'DESLOCAMENTO')
  AND "split_method" IN ('IGUAL', 'POR_PECA', 'MANUAL'));
ALTER TABLE "logistics_cost_allocations" ADD CONSTRAINT "logistics_cost_allocations_amount" CHECK ("amount_cents" >= 0);
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_values" CHECK (
  "amount_cents" > 0 AND "day_of_month" BETWEEN 1 AND 31 AND extract(day FROM "start_month") = 1);
ALTER TABLE "operational_expenses" ADD CONSTRAINT "operational_expenses_values" CHECK (
  "amount_cents" > 0 AND extract(day FROM "competence") = 1);
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_amounts" CHECK (
  "amount_cents" > 0 AND "paid_cents" >= 0 AND "paid_cents" <= "amount_cents");
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_status" CHECK (
  "status" IN ('ABERTO', 'PARCIAL', 'PAGO', 'CANCELADO')
  AND ("status" <> 'CANCELADO' OR ("paid_cents" = 0 AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_amount" CHECK ("amount_cents" > 0);
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_revenue" CHECK ("revenue_cents" IS NULL OR "revenue_cents" >= 0);
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_tax_rate" CHECK ("tax_rate_bps" IS NULL OR "tax_rate_bps" BETWEEN 0 AND 5000);

-- Um tapeceiro principal por peça (ou pela OS inteira): nunca dois valores ativos para o mesmo serviço.
CREATE UNIQUE INDEX "production_payables_item_active" ON "production_payables" ("service_order_item_id")
  WHERE "service_order_item_id" IS NOT NULL AND "status" <> 'CANCELADO';
CREATE UNIQUE INDEX "production_payables_order_active" ON "production_payables" ("service_order_id")
  WHERE "service_order_item_id" IS NULL AND "status" <> 'CANCELADO';
-- Um custo ativo por tipo e viagem (entrega/retirada).
CREATE UNIQUE INDEX "logistics_costs_delivery_kind" ON "logistics_costs" ("delivery_id", "kind")
  WHERE "delivery_id" IS NOT NULL AND "cancelled_at" IS NULL;
CREATE UNIQUE INDEX "logistics_costs_pickup_kind" ON "logistics_costs" ("pickup_id", "kind")
  WHERE "pickup_id" IS NOT NULL AND "cancelled_at" IS NULL;

-- Lançamentos financeiros imutáveis (correções por estorno/ajuste, nunca por edição).
CREATE TRIGGER "commercial_adjustments_immutable" BEFORE UPDATE OR DELETE ON "commercial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "customer_payments_immutable" BEFORE UPDATE OR DELETE ON "customer_payments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "service_order_costs_immutable" BEFORE UPDATE OR DELETE ON "service_order_costs"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "financial_adjustments_immutable" BEFORE UPDATE OR DELETE ON "financial_adjustments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "professional_payments_immutable" BEFORE UPDATE OR DELETE ON "professional_payments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "payable_payments_immutable" BEFORE UPDATE OR DELETE ON "payable_payments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "financial_events_immutable" BEFORE UPDATE OR DELETE ON "financial_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "customer_receivables_no_delete" BEFORE DELETE ON "customer_receivables"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "production_payables_no_delete" BEFORE DELETE ON "production_payables"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "logistics_costs_no_delete" BEFORE DELETE ON "logistics_costs"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "logistics_cost_allocations_immutable" BEFORE UPDATE OR DELETE ON "logistics_cost_allocations"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "operational_expenses_no_delete" BEFORE DELETE ON "operational_expenses"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "account_payables_no_delete" BEFORE DELETE ON "account_payables"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();

-- Permissões do financeiro: o gestor recebe todas (o catálogo completo também é garantido no código).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('financeiro.ver'), ('financeiro.gerenciar'), ('financeiro.ajustes'),
                   ('financeiro.producao_propria')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
