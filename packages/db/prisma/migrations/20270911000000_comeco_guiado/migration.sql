-- 2026-11-26: primeiro dia de uma empresa nova (lista de 53 melhorias, itens 1, 2, 4, 5, 6 e 42)
-- e avisos por e-mail do teste grátis. Só acrescenta: nenhuma linha é apagada. Reversão em
-- packages/db/rollback/20270911000000_comeco_guiado.down.sql.

-- AlterTable: respostas do primeiro acesso e o começo guiado.
ALTER TABLE "company_settings"
  ADD COLUMN "setup_done_at" TIMESTAMPTZ(3),
  ADD COLUMN "setup_answers" JSONB,
  ADD COLUMN "getting_started_hidden_at" TIMESTAMPTZ(3),
  ADD COLUMN "team_size" SMALLINT,
  ADD COLUMN "monthly_goal_cents" INTEGER,
  ADD COLUMN "serves_on_site" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "onboarding_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "platform_new_notice_at" TIMESTAMPTZ(3);

-- AlterTable: prazo de entrega que já vem preenchido no orçamento novo.
ALTER TABLE "quote_settings" ADD COLUMN "default_delivery_days" SMALLINT;

-- Empresas que já existem: nada de perguntas, começo guiado nem e-mails do teste.
SELECT set_config('app.bypass_rls', 'on', false);
UPDATE "company_settings"
   SET "setup_done_at" = "created_at",
       "getting_started_hidden_at" = CURRENT_TIMESTAMP,
       "onboarding_emails" = ARRAY['boas-vindas','dia-2','dia-5','fim-teste']::TEXT[],
       "platform_new_notice_at" = CURRENT_TIMESTAMP;
SELECT set_config('app.bypass_rls', 'off', false);

-- CreateTable: convite para o funcionário criar o próprio PIN e pôr a foto (item 4).
CREATE TABLE "employee_invites" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "employee_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_invites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "employee_invites_token_hash_key" ON "employee_invites"("token_hash");
CREATE INDEX "employee_invites_employee_id_idx" ON "employee_invites"("employee_id");
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: explicação de cada tela já vista por cada pessoa (item 5).
CREATE TABLE "user_seen_tips" (
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "user_id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_seen_tips_pkey" PRIMARY KEY ("user_id", "key")
);
ALTER TABLE "user_seen_tips" ADD CONSTRAINT "user_seen_tips_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_seen_tips" ADD CONSTRAINT "user_seen_tips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: "Quero ajuda para começar" (item 6) e, depois, as demonstrações do site (item 44).
CREATE TABLE "contact_requests" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "kind" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(30),
    "preferred_at" TIMESTAMPTZ(3) NOT NULL,
    "note" VARCHAR(500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDENTE',
    "done_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "contact_requests_status_preferred_at_idx" ON "contact_requests"("status", "preferred_at");
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trava do banco (Row-Level Security) nas tabelas novas, igual às demais.
ALTER TABLE "employee_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "employee_invites"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "user_seen_tips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_seen_tips" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "user_seen_tips"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "contact_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "contact_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_invites", "user_seen_tips", "contact_requests" TO cenario_app;
