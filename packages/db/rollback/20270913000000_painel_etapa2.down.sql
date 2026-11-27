-- Reversão de 20270913000000_painel_etapa2 (só o que a migration acrescentou).
-- Apaga as 3 tabelas novas (comprovantes, telas usadas, celulares do painel) e as colunas novas.
BEGIN;
DROP TABLE IF EXISTS "platform_push_subscriptions";
DROP TABLE IF EXISTS "screen_views";
DROP TABLE IF EXISTS "payment_proofs";
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "message_templates", DROP COLUMN IF EXISTS "pix_city";
ALTER TABLE "contact_requests" DROP COLUMN IF EXISTS "business_name", DROP COLUMN IF EXISTS "city";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "billing_price_until",
  DROP COLUMN IF EXISTS "close_reason",
  DROP COLUMN IF EXISTS "closed_at",
  DROP COLUMN IF EXISTS "fee_emails",
  DROP COLUMN IF EXISTS "fee_emails_for",
  DROP COLUMN IF EXISTS "late_notice_for",
  DROP COLUMN IF EXISTS "purge_after",
  DROP COLUMN IF EXISTS "signup_source",
  DROP COLUMN IF EXISTS "signup_source_detail",
  DROP COLUMN IF EXISTS "weekly_email_for";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270913000000_painel_etapa2';
COMMIT;
