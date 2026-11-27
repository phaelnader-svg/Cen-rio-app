-- Reverte 20270912000000_comeco_guiado_recentes: as empresas reabertas voltam a "começo feito"
-- (como a 20270911000000_comeco_guiado deixou). Quem já respondeu as perguntas não muda.
BEGIN;
SELECT set_config('app.bypass_rls', 'on', true);
UPDATE "company_settings"
   SET "setup_done_at" = "created_at",
       "getting_started_hidden_at" = CURRENT_TIMESTAMP,
       "onboarding_emails" = ARRAY['boas-vindas','dia-2','dia-5','fim-teste']::TEXT[]
 WHERE "is_platform" = false
   AND "is_demo" = false
   AND "created_at" >= TIMESTAMPTZ '2026-11-24 00:00:00-03'
   AND "setup_answers" IS NULL
   AND "setup_done_at" IS NULL;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270912000000_comeco_guiado_recentes';
COMMIT;
