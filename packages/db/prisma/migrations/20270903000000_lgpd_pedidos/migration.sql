-- LGPD (2026-11-25): pedidos sobre dados pessoais (apagar, acessar, corrigir...).
-- Só cria a tabela; nenhum dado existente é alterado ou apagado.

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "user_id" UUID,
    "scope" VARCHAR(12) NOT NULL,
    "kind" VARCHAR(14) NOT NULL,
    "requester" VARCHAR(20),
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "company_name" VARCHAR(120),
    "message" VARCHAR(2000),
    "status" VARCHAR(14) NOT NULL DEFAULT 'NOVO',
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_requests_status_created_at_idx" ON "privacy_requests"("status", "created_at");

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trava do banco (Row-Level Security) na tabela de empresa nova, igual às demais.
ALTER TABLE "privacy_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privacy_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "privacy_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "privacy_requests" TO cenario_app;
