-- Reversão de 20270911000000_comeco_guiado: tira as 3 tabelas novas (convites, explicações vistas
-- e pedidos de ajuda) e as colunas novas. Nenhum dado que existia antes da migration é apagado;
-- somem só as respostas do começo, os convites, as explicações vistas e os pedidos de ajuda.
-- Antes, reverta 20270912000000_comeco_guiado_recentes, se ela estiver aplicada.
BEGIN;
DROP TABLE IF EXISTS "employee_invites";
DROP TABLE IF EXISTS "user_seen_tips";
DROP TABLE IF EXISTS "contact_requests";
ALTER TABLE "quote_settings" DROP COLUMN IF EXISTS "default_delivery_days";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "setup_done_at",
  DROP COLUMN IF EXISTS "setup_answers",
  DROP COLUMN IF EXISTS "getting_started_hidden_at",
  DROP COLUMN IF EXISTS "team_size",
  DROP COLUMN IF EXISTS "monthly_goal_cents",
  DROP COLUMN IF EXISTS "serves_on_site",
  DROP COLUMN IF EXISTS "onboarding_emails",
  DROP COLUMN IF EXISTS "platform_new_notice_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270911000000_comeco_guiado';
COMMIT;
