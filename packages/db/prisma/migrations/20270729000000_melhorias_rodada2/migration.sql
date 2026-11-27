-- Melhorias da segunda rodada (2026-11-17): situação e aceite do orçamento, sugestões enviadas de
-- dentro do sistema, aviso de manutenção, página de status, verificação em duas etapas, acesso de
-- suporte, cancelar/pausar a assinatura e empresa de demonstração.
-- Só acrescenta: nenhuma linha é apagada. Reversão em
-- packages/db/rollback/20270729000000_melhorias_rodada2.down.sql.

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "cancel_reason" VARCHAR(500),
ADD COLUMN     "canceled_at" TIMESTAMPTZ(3),
ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paused_until" TIMESTAMPTZ(3),
ADD COLUMN     "support_access_until" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "pickup_requests" ADD COLUMN     "customer_scheduled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_via" VARCHAR(10),
ADD COLUMN     "follow_up_at" TIMESTAMPTZ(3),
ADD COLUMN     "link_viewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "lost_reason" VARCHAR(300),
ADD COLUMN     "order_id" UUID,
ADD COLUMN     "status" VARCHAR(16) NOT NULL DEFAULT 'ENVIADO',
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "support_agent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_recovery_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totp_secret" VARCHAR(200);

-- CreateTable
CREATE TABLE "feedback_reports" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "user_id" UUID,
    "kind" VARCHAR(10) NOT NULL,
    "message" VARCHAR(4000) NOT NULL,
    "page_url" VARCHAR(500),
    "user_agent" VARCHAR(300),
    "screenshot" TEXT,
    "status" VARCHAR(10) NOT NULL DEFAULT 'NOVO',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feedback_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_notices" (
    "id" UUID NOT NULL,
    "message" VARCHAR(300) NOT NULL,
    "show_from" TIMESTAMPTZ(3) NOT NULL,
    "show_until" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_samples" (
    "id" BIGSERIAL NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "db_ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL,

    CONSTRAINT "status_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_reports_status_created_at_idx" ON "feedback_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "system_notices_show_until_idx" ON "system_notices"("show_until");

-- CreateIndex
CREATE INDEX "status_samples_checked_at_idx" ON "status_samples"("checked_at");

-- CreateIndex
CREATE INDEX "quotes_status_follow_up_at_idx" ON "quotes"("status", "follow_up_at");

-- AddForeignKey
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Trava do banco (Row-Level Security) na tabela de empresa nova, igual às demais.
ALTER TABLE "feedback_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feedback_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "feedback_reports"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "feedback_reports", "system_notices", "status_samples" TO cenario_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE "status_samples_id_seq" TO cenario_app;

-- Orçamentos já salvos: ficam como "enviado", com o lembrete 3 dias depois de salvos.
SELECT set_config('app.bypass_rls', 'on', false);
UPDATE "quotes" SET "follow_up_at" = "created_at" + INTERVAL '3 days', "status_changed_at" = "created_at";
SELECT set_config('app.bypass_rls', 'off', false);
