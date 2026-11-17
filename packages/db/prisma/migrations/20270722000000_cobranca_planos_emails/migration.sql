-- Cobrança e planos, confirmação de e-mail, "esqueci minha senha" e fila de e-mails (2026-11-17).
-- Só acrescenta: nenhuma linha é apagada. Reversão em
-- packages/db/rollback/20270722000000_cobranca_planos_emails.down.sql.

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "asaas_customer_id" VARCHAR(60),
ADD COLUMN     "asaas_subscription_id" VARCHAR(60),
ADD COLUMN     "billing_courtesy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "billing_cycle" VARCHAR(10) NOT NULL DEFAULT 'MENSAL',
ADD COLUMN     "paid_until" TIMESTAMPTZ(3),
ADD COLUMN     "plan" VARCHAR(20) NOT NULL DEFAULT 'gestao',
ADD COLUMN     "trial_ends_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_confirmed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "to" VARCHAR(254) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT,
    "kind" VARCHAR(40) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "next_try_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "provider" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(80),
    "plan" VARCHAR(20) NOT NULL,
    "cycle" VARCHAR(10) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'PENDENTE',
    "payment_url" VARCHAR(500),
    "paid_at" TIMESTAMPTZ(3),
    "period_end" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_user_id_purpose_idx" ON "email_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "outbound_emails_sent_at_next_try_at_idx" ON "outbound_emails"("sent_at", "next_try_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_external_id_key" ON "subscription_invoices"("external_id");

-- CreateIndex
CREATE INDEX "subscription_invoices_company_id_due_date_idx" ON "subscription_invoices"("company_id", "due_date");

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Trava do banco (Row-Level Security), igual às demais tabelas de empresa e de acesso.
ALTER TABLE "email_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "email_tokens"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

ALTER TABLE "outbound_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_emails" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "outbound_emails"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "subscription_invoices"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_tokens", "outbound_emails", "subscription_invoices" TO cenario_app;

-- Dados atuais. A trava do banco (FORCE ROW LEVEL SECURITY) vale também para o dono das tabelas
-- quando ele não é superusuário: liga a passagem só para estes UPDATEs e desliga em seguida.
SELECT set_config('app.bypass_rls', 'on', false);
-- Dados atuais:
-- * Cenário Estofados (empresa 1): cortesia no plano superior (o jogo continua ligado).
-- * Demais empresas já criadas: 7 dias de teste grátis a partir de hoje, no plano básico.
-- * Usuários que já existem: e-mail considerado confirmado (foram cadastrados pelo gestor).
UPDATE "company_settings" SET "plan" = 'gestao_jogo', "billing_courtesy" = true WHERE "id" = 1;
UPDATE "company_settings" SET "trial_ends_at" = CURRENT_TIMESTAMP + INTERVAL '7 days' WHERE "id" <> 1;
UPDATE "users" SET "email_confirmed_at" = CURRENT_TIMESTAMP WHERE "email" IS NOT NULL;
SELECT set_config('app.bypass_rls', 'off', false);
