-- Atendimento do Escritório (2026-11-25, etapa 1 dos agentes aprovada pelo Raphael): aniversário do
-- cliente (dia e mês, sem ano), quem indicou o cliente e o desconto que a empresa dá no aniversário
-- e na indicação. Só acrescenta colunas opcionais; nada existente muda. Reversão em
-- packages/db/rollback/20270906000000_atendimento_cliente.down.sql.
ALTER TABLE "customers" ADD COLUMN "birth_day" SMALLINT;
ALTER TABLE "customers" ADD COLUMN "birth_month" SMALLINT;
ALTER TABLE "customers" ADD COLUMN "referred_by_id" UUID;
ALTER TABLE "customers" ADD CONSTRAINT "customers_birthday_check"
  CHECK ((birth_day IS NULL AND birth_month IS NULL)
      OR (birth_day BETWEEN 1 AND 31 AND birth_month BETWEEN 1 AND 12));
ALTER TABLE "customers" ADD CONSTRAINT "customers_referred_by_id_fkey"
  FOREIGN KEY ("referred_by_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "customers_referred_by_id_idx" ON "customers"("referred_by_id");
CREATE INDEX "customers_birth_month_birth_day_idx" ON "customers"("birth_month", "birth_day");
ALTER TABLE "company_settings" ADD COLUMN "customer_discount_pct" SMALLINT NOT NULL DEFAULT 10;
