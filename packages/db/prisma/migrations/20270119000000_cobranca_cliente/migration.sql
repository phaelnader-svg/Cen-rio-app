-- Cobrança / pagamento do cliente (aditiva). Sem backfill interpretativo: só os padrões técnicos
-- (due_trigger = 'DATA' para as cobranças existentes, refund = false).

-- Valor fechado por peça (opcional; a soma é validada no domínio contra o valor final).
ALTER TABLE "commercial_order_items" ADD COLUMN "agreed_value_cents" INTEGER;
ALTER TABLE "commercial_order_items" ADD CONSTRAINT "commercial_order_items_agreed_value"
  CHECK ("agreed_value_cents" IS NULL OR "agreed_value_cents" >= 0);

-- Cobrança: vencimento por data ou por evento (retirada/entrega); parcelas do cartão.
ALTER TABLE "customer_receivables" ALTER COLUMN "due_date" DROP NOT NULL;
ALTER TABLE "customer_receivables" ADD COLUMN "due_trigger" VARCHAR(10) NOT NULL DEFAULT 'DATA';
ALTER TABLE "customer_receivables" ADD COLUMN "installments" SMALLINT;
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_due_trigger" CHECK (
  "due_trigger" IN ('DATA', 'RETIRADA', 'ENTREGA')
  AND ("due_trigger" <> 'DATA' OR "due_date" IS NOT NULL));
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_installments" CHECK (
  "installments" IS NULL
  OR ("installments" BETWEEN 1 AND 12 AND "expected_method" IN ('CARTAO_CREDITO', 'CARTAO_DEBITO')));

-- Recebimento: parcelas do cartão; reembolso explícito (dinheiro que entrou e saiu).
ALTER TABLE "customer_payments" ADD COLUMN "installments" SMALLINT;
ALTER TABLE "customer_payments" ADD COLUMN "refund" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customer_payments" DROP CONSTRAINT "customer_payments_amount";
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amount" CHECK (
  ("refund" = false AND "reversal_of_id" IS NULL AND "amount_cents" > 0)
  OR ("refund" = false AND "reversal_of_id" IS NOT NULL AND "amount_cents" < 0)
  OR ("refund" = true AND "reversal_of_id" IS NULL AND "amount_cents" < 0));
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_installments" CHECK (
  "installments" IS NULL
  OR ("installments" BETWEEN 1 AND 12 AND "method" IN ('CARTAO_CREDITO', 'CARTAO_DEBITO')));

-- Registro operacional da equipe (retirada/entrega): informa; o escritório confirma a baixa.
CREATE TABLE "customer_payment_reports" (
    "id" UUID NOT NULL,
    "receivable_id" UUID NOT NULL,
    "pickup_id" UUID,
    "delivery_id" UUID,
    "collected" BOOLEAN NOT NULL,
    "method" VARCHAR(20),
    "note" VARCHAR(500),
    "reported_by_id" UUID NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',
    "payment_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "customer_payment_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customer_payment_reports_payment_id_key" ON "customer_payment_reports"("payment_id");
CREATE INDEX "customer_payment_reports_receivable_id_idx" ON "customer_payment_reports"("receivable_id");
CREATE INDEX "customer_payment_reports_status_idx" ON "customer_payment_reports"("status");
-- No máximo um registro pendente por cobrança e parada.
CREATE UNIQUE INDEX "customer_payment_reports_pending_pickup" ON "customer_payment_reports" ("receivable_id", "pickup_id")
  WHERE "status" = 'PENDENTE' AND "pickup_id" IS NOT NULL;
CREATE UNIQUE INDEX "customer_payment_reports_pending_delivery" ON "customer_payment_reports" ("receivable_id", "delivery_id")
  WHERE "status" = 'PENDENTE' AND "delivery_id" IS NOT NULL;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_receivable_id_fkey" FOREIGN KEY ("receivable_id") REFERENCES "customer_receivables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_stop" CHECK (
  ("pickup_id" IS NULL) <> ("delivery_id" IS NULL));
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_status" CHECK (
  "status" IN ('PENDENTE', 'CONFIRMADO', 'DESCARTADO')
  AND ("status" <> 'CONFIRMADO' OR ("payment_id" IS NOT NULL AND "decided_by_id" IS NOT NULL))
  AND ("status" = 'PENDENTE' OR "decided_at" IS NOT NULL)
  AND ("status" <> 'PENDENTE' OR "payment_id" IS NULL));
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_method" CHECK (
  "method" IS NULL
  OR "method" IN ('PIX', 'DINHEIRO', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO', 'TRANSFERENCIA', 'CHEQUE', 'OUTRO'));
CREATE TRIGGER "customer_payment_reports_no_delete" BEFORE DELETE ON "customer_payment_reports"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
