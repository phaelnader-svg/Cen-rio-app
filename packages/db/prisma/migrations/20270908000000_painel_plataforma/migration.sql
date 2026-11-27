-- 2026-11-25: painel da plataforma (/plataforma), separado das empresas. Login próprio do dono da
-- plataforma, histórico do painel, configuração (preços, teste, bloqueio, PIX) e campos de cobrança
-- manual na empresa (valor combinado, anotação, aviso de vencimento já mandado).

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "billing_price_cents" INTEGER,
ADD COLUMN     "due_notice_for" TIMESTAMPTZ(3),
ADD COLUMN     "platform_note" VARCHAR(500);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "credentials_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(300),

    CONSTRAINT "platform_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_company_id" INTEGER,
    "summary" VARCHAR(300) NOT NULL,
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "price_gestao_cents" INTEGER NOT NULL DEFAULT 39900,
    "price_jogo_cents" INTEGER NOT NULL DEFAULT 59900,
    "annual_discount_bps" INTEGER NOT NULL DEFAULT 1500,
    "trial_days" INTEGER NOT NULL DEFAULT 7,
    "grace_days" INTEGER NOT NULL DEFAULT 5,
    "auto_block" BOOLEAN NOT NULL DEFAULT false,
    "pix_key" VARCHAR(140),
    "pix_name" VARCHAR(120),
    "pix_bank" VARCHAR(80),
    "whatsapp" VARCHAR(30),
    "payment_message" VARCHAR(500),
    "notice_days" INTEGER NOT NULL DEFAULT 3,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_sessions_token_hash_key" ON "platform_admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_admin_sessions_admin_id_revoked_at_idx" ON "platform_admin_sessions"("admin_id", "revoked_at");

-- CreateIndex
CREATE INDEX "platform_admin_sessions_expires_at_idx" ON "platform_admin_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "platform_admin_sessions" ADD CONSTRAINT "platform_admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


-- Uma linha só de configuração, com os valores de hoje (R$ 399, R$ 599, 15% no anual, 7 dias de
-- teste, bloqueio 5 dias depois do vencimento). O bloqueio automático começa DESLIGADO: quem liga é
-- o dono da plataforma, no painel, depois de conferir as empresas.
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_one_row" CHECK ("id" = 1);
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_values_check" CHECK (
  "price_gestao_cents" > 0 AND "price_jogo_cents" > 0
  AND "annual_discount_bps" BETWEEN 0 AND 9000
  AND "trial_days" BETWEEN 0 AND 90 AND "grace_days" BETWEEN 0 AND 60
  AND "notice_days" BETWEEN 0 AND 30
);
INSERT INTO "platform_settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP);

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admins", "platform_admin_sessions", "platform_audit_logs", "platform_settings" TO cenario_app;
