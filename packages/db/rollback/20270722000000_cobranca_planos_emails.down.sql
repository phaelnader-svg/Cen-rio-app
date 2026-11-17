-- Reversão de 20270722000000_cobranca_planos_emails. Apaga as cobranças da assinatura, os links
-- de e-mail e a fila de e-mails; as empresas voltam a não ter plano (o jogo segue a chave
-- "ambiente_interativo" da versão anterior).
BEGIN;
DROP TABLE IF EXISTS "subscription_invoices";
DROP TABLE IF EXISTS "outbound_emails";
DROP TABLE IF EXISTS "email_tokens";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_confirmed_at";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "plan",
  DROP COLUMN IF EXISTS "billing_cycle",
  DROP COLUMN IF EXISTS "billing_courtesy",
  DROP COLUMN IF EXISTS "trial_ends_at",
  DROP COLUMN IF EXISTS "paid_until",
  DROP COLUMN IF EXISTS "asaas_customer_id",
  DROP COLUMN IF EXISTS "asaas_subscription_id";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270722000000_cobranca_planos_emails';
COMMIT;
