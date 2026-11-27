-- 2026-11-27: etapa 2 da lista de 53 melhorias (painel da plataforma, PIX com QR Code e
-- comprovante pela tela, avisos no celular, demonstrações do site, origem e linha do tempo das
-- empresas, mensagens editáveis, preço de lançamento, telas usadas, encerrar empresa) e e-mails da
-- mensalidade, do resumo da semana e de segurança. Só acrescenta: nenhuma linha é apagada nem
-- alterada. Reversão em packages/db/rollback/20270913000000_painel_etapa2.down.sql.


-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "billing_price_until" TIMESTAMPTZ(3),
ADD COLUMN     "close_reason" VARCHAR(300),
ADD COLUMN     "closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "fee_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fee_emails_for" TIMESTAMPTZ(3),
ADD COLUMN     "late_notice_for" TIMESTAMPTZ(3),
ADD COLUMN     "purge_after" TIMESTAMPTZ(3),
ADD COLUMN     "signup_source" VARCHAR(20),
ADD COLUMN     "signup_source_detail" VARCHAR(160),
ADD COLUMN     "weekly_email_for" DATE;

-- AlterTable
ALTER TABLE "contact_requests" ADD COLUMN     "business_name" VARCHAR(120),
ADD COLUMN     "city" VARCHAR(80);

-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "message_templates" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "pix_city" VARCHAR(40);

-- CreateTable
CREATE TABLE "payment_proofs" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "amount_cents" INTEGER NOT NULL,
    "paid_on" DATE NOT NULL,
    "mime" VARCHAR(40) NOT NULL,
    "data" TEXT NOT NULL,
    "note" VARCHAR(300),
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDENTE',
    "reviewed_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(300),
    "invoice_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screen_views" (
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "screen" VARCHAR(60) NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "screen_views_pkey" PRIMARY KEY ("company_id","screen","day")
);

-- CreateTable
CREATE TABLE "platform_push_subscriptions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "endpoint" VARCHAR(1000) NOT NULL,
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_proofs_status_created_at_idx" ON "payment_proofs"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_proofs_company_id_created_at_idx" ON "payment_proofs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "screen_views_day_idx" ON "screen_views"("day");

-- CreateIndex
CREATE UNIQUE INDEX "platform_push_subscriptions_endpoint_key" ON "platform_push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "platform_push_subscriptions_admin_id_idx" ON "platform_push_subscriptions"("admin_id");

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screen_views" ADD CONSTRAINT "screen_views_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_push_subscriptions" ADD CONSTRAINT "platform_push_subscriptions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Trava do banco (Row-Level Security) nas tabelas novas das empresas, igual às demais.
ALTER TABLE "payment_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_proofs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "payment_proofs"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "screen_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "screen_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "screen_views"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_proofs", "screen_views", "platform_push_subscriptions" TO cenario_app;
