-- 2026-11-26 (pedido do dono): as empresas que se cadastraram pelo site a partir de 24/11 passam
-- pelo começo guiado e recebem os e-mails do teste grátis. A migration anterior marcou todas as
-- empresas existentes como "começo feito"; aqui voltam só as recentes que ainda não responderam
-- as perguntas (nada de plataforma nem demonstração). As boas-vindas contam como enviadas (elas
-- receberam o e-mail de confirmação no cadastro) e o aviso de empresa nova continua dado.
SELECT set_config('app.bypass_rls', 'on', false);
UPDATE "company_settings"
   SET "setup_done_at" = NULL,
       "getting_started_hidden_at" = NULL,
       "onboarding_emails" = ARRAY['boas-vindas']::TEXT[]
 WHERE "is_platform" = false
   AND "is_demo" = false
   AND "created_at" >= TIMESTAMPTZ '2026-11-24 00:00:00-03'
   AND "setup_answers" IS NULL
   AND "onboarding_emails" = ARRAY['boas-vindas','dia-2','dia-5','fim-teste']::TEXT[];
SELECT set_config('app.bypass_rls', 'off', false);
