-- Reversão de 20270908000000_painel_plataforma: apaga só o que o painel da plataforma criou
-- (acesso do painel, sessões, histórico, configuração de preços/PIX e as 3 colunas novas de
-- company_settings). Nenhum dado das empresas é tocado.
BEGIN;
DROP TABLE IF EXISTS "platform_audit_logs";
DROP TABLE IF EXISTS "platform_admin_sessions";
DROP TABLE IF EXISTS "platform_admins";
DROP TABLE IF EXISTS "platform_settings";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "billing_price_cents",
  DROP COLUMN IF EXISTS "due_notice_for",
  DROP COLUMN IF EXISTS "platform_note";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270908000000_painel_plataforma';
COMMIT;
