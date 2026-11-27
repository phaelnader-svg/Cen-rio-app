-- Reversão de 20270906000000_atendimento_cliente: tira só as colunas novas (aniversário, quem
-- indicou e o desconto do aniversário e da indicação). Nada mais é tocado.
BEGIN;
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "customer_discount_pct";
DROP INDEX IF EXISTS "customers_birth_month_birth_day_idx";
DROP INDEX IF EXISTS "customers_referred_by_id_idx";
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_referred_by_id_fkey";
ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_birthday_check";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "referred_by_id";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "birth_month";
ALTER TABLE "customers" DROP COLUMN IF EXISTS "birth_day";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270906000000_atendimento_cliente';
COMMIT;
