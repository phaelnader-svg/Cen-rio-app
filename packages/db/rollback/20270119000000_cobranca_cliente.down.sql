-- REVERSÃO MANUAL da migration 20270119000000_cobranca_cliente (Cobrança do cliente).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se já existe algum dado da
-- cobrança — valor por peça, vencimento por retirada/entrega ou sem data, parcelas, reembolso ou
-- registro operacional de pagamento da equipe. Nesse caso, recupere pelo backup anterior à
-- migration. Sem esses dados a reversão é exata (os padrões técnicos 'DATA'/false são descartados).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "commercial_order_items" WHERE "agreed_value_cents" IS NOT NULL)
       + (SELECT count(*) FROM "customer_receivables"
           WHERE "due_trigger" <> 'DATA' OR "due_date" IS NULL OR "installments" IS NOT NULL)
       + (SELECT count(*) FROM "customer_payments" WHERE "installments" IS NOT NULL OR "refund")
       + (SELECT count(*) FROM "customer_payment_reports")
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da cobrança do cliente (valor por peça, vencimento por evento, parcelas, reembolso ou registro da equipe). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TABLE "customer_payment_reports";
ALTER TABLE "customer_payments" DROP CONSTRAINT "customer_payments_installments";
ALTER TABLE "customer_payments" DROP CONSTRAINT "customer_payments_amount";
-- Definição anterior (20261016000000_financeiro_operacional).
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_amount" CHECK (
  ("reversal_of_id" IS NULL AND "amount_cents" > 0) OR ("reversal_of_id" IS NOT NULL AND "amount_cents" < 0));
ALTER TABLE "customer_payments" DROP COLUMN "refund";
ALTER TABLE "customer_payments" DROP COLUMN "installments";
ALTER TABLE "customer_receivables" DROP CONSTRAINT "customer_receivables_installments";
ALTER TABLE "customer_receivables" DROP CONSTRAINT "customer_receivables_due_trigger";
ALTER TABLE "customer_receivables" DROP COLUMN "installments";
ALTER TABLE "customer_receivables" DROP COLUMN "due_trigger";
ALTER TABLE "customer_receivables" ALTER COLUMN "due_date" SET NOT NULL;
ALTER TABLE "commercial_order_items" DROP CONSTRAINT "commercial_order_items_agreed_value";
ALTER TABLE "commercial_order_items" DROP COLUMN "agreed_value_cents";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270119000000_cobranca_cliente';
COMMIT;
