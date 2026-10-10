-- Evolução, Fase 7: fechamento semanal geral (tapeceiros + logística).
-- Migration ADITIVA. O fechamento é uma VISÃO sobre as fontes de verdade existentes
-- (production_payables/professional_payments e logistics_costs/account_payables/payable_payments):
-- nenhuma obrigação é criada ou consolidada; o pagamento em lote liquida as obrigações originais.


-- CreateTable
CREATE TABLE "professional_payment_reversals" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "professional_payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_closings" (
    "id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "note" VARCHAR(1000),
    "reopen_reason" VARCHAR(500),
    "snapshot" JSONB NOT NULL,
    "due_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL,
    "open_cents" INTEGER NOT NULL,
    "checked_by_id" UUID,
    "checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "weekly_closings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_closing_events" (
    "id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "note" VARCHAR(1000),
    "data" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_closing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closing_payments" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "week_start" DATE NOT NULL,
    "beneficiary_user_id" UUID NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "paid_at" DATE NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "reference" VARCHAR(120),
    "note" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closing_payment_parts" (
    "id" UUID NOT NULL,
    "closing_payment_id" UUID NOT NULL,
    "professional_payment_id" UUID,
    "payable_payment_id" UUID,
    "amount_cents" INTEGER NOT NULL,

    CONSTRAINT "closing_payment_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closing_payment_reversals" (
    "id" UUID NOT NULL,
    "closing_payment_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closing_payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_free_trips" (
    "id" UUID NOT NULL,
    "pickup_id" UUID,
    "delivery_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "confirmed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logistics_free_trips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "professional_payment_reversals_payment_id_key" ON "professional_payment_reversals"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_closings_week_start_key" ON "weekly_closings"("week_start");

-- CreateIndex
CREATE INDEX "weekly_closing_events_week_start_created_at_idx" ON "weekly_closing_events"("week_start", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "closing_payments_number_key" ON "closing_payments"("number");

-- CreateIndex
CREATE INDEX "closing_payments_week_start_idx" ON "closing_payments"("week_start");

-- CreateIndex
CREATE INDEX "closing_payments_beneficiary_user_id_paid_at_idx" ON "closing_payments"("beneficiary_user_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "closing_payment_parts_professional_payment_id_key" ON "closing_payment_parts"("professional_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "closing_payment_parts_payable_payment_id_key" ON "closing_payment_parts"("payable_payment_id");

-- CreateIndex
CREATE INDEX "closing_payment_parts_closing_payment_id_idx" ON "closing_payment_parts"("closing_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "closing_payment_reversals_closing_payment_id_key" ON "closing_payment_reversals"("closing_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_free_trips_pickup_id_key" ON "logistics_free_trips"("pickup_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_free_trips_delivery_id_key" ON "logistics_free_trips"("delivery_id");

-- AddForeignKey
ALTER TABLE "professional_payment_reversals" ADD CONSTRAINT "professional_payment_reversals_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "professional_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closings" ADD CONSTRAINT "weekly_closings_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_payments" ADD CONSTRAINT "closing_payments_beneficiary_user_id_fkey" FOREIGN KEY ("beneficiary_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_payment_parts" ADD CONSTRAINT "closing_payment_parts_closing_payment_id_fkey" FOREIGN KEY ("closing_payment_id") REFERENCES "closing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_payment_parts" ADD CONSTRAINT "closing_payment_parts_professional_payment_id_fkey" FOREIGN KEY ("professional_payment_id") REFERENCES "professional_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_payment_parts" ADD CONSTRAINT "closing_payment_parts_payable_payment_id_fkey" FOREIGN KEY ("payable_payment_id") REFERENCES "payable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closing_payment_reversals" ADD CONSTRAINT "closing_payment_reversals_closing_payment_id_fkey" FOREIGN KEY ("closing_payment_id") REFERENCES "closing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "weekly_closings" ADD CONSTRAINT "weekly_closings_values" CHECK (
  "status" IN ('CONFERIDO', 'REABERTO')
  AND extract(isodow FROM "week_start") = 1
  AND "due_cents" >= 0 AND "paid_cents" >= 0 AND "open_cents" >= 0
  AND ("status" <> 'REABERTO' OR length(trim(coalesce("reopen_reason", ''))) >= 3));
ALTER TABLE "closing_payments" ADD CONSTRAINT "closing_payments_values" CHECK (
  "amount_cents" > 0 AND "category" IN ('TAPECARIA', 'LOGISTICA')
  AND extract(isodow FROM "week_start") = 1);
ALTER TABLE "closing_payment_parts" ADD CONSTRAINT "closing_payment_parts_one_source" CHECK (
  "amount_cents" > 0
  AND (("professional_payment_id" IS NOT NULL)::int + ("payable_payment_id" IS NOT NULL)::int) = 1);
ALTER TABLE "logistics_free_trips" ADD CONSTRAINT "logistics_free_trips_one_trip" CHECK (
  (("pickup_id" IS NOT NULL)::int + ("delivery_id" IS NOT NULL)::int) = 1
  AND length(trim("reason")) >= 3);
ALTER TABLE "professional_payment_reversals" ADD CONSTRAINT "professional_payment_reversals_reason" CHECK (length(trim("reason")) >= 3);
ALTER TABLE "closing_payment_reversals" ADD CONSTRAINT "closing_payment_reversals_reason" CHECK (length(trim("reason")) >= 3);

-- Registros financeiros imutáveis (correção = novo lançamento/estorno).
CREATE TRIGGER "professional_payment_reversals_immutable" BEFORE UPDATE OR DELETE ON "professional_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "weekly_closing_events_immutable" BEFORE UPDATE OR DELETE ON "weekly_closing_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "closing_payments_immutable" BEFORE UPDATE OR DELETE ON "closing_payments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "closing_payment_parts_immutable" BEFORE UPDATE OR DELETE ON "closing_payment_parts"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "closing_payment_reversals_immutable" BEFORE UPDATE OR DELETE ON "closing_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "weekly_closings_no_delete" BEFORE DELETE ON "weekly_closings"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "logistics_free_trips_immutable" BEFORE UPDATE OR DELETE ON "logistics_free_trips"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
