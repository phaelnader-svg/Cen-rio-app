-- App instalado no celular e no tablet (2026-11-25, pedido do Raphael): avisos chegam no aparelho
-- mesmo com o app fechado. Só acrescenta duas tabelas; nada existente muda. Reversão em
-- packages/db/rollback/20270904000000_avisos_no_aparelho.down.sql.
--   push_keys: as chaves dos avisos (VAPID), criadas sozinhas pela API na primeira vez, iguais
--              para todas as empresas (nenhum passo manual por empresa).
--   push_subscriptions: aparelho que aceitou receber avisos (por empresa, com trava de empresa).

-- CreateTable
CREATE TABLE "push_keys" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "public_key" VARCHAR(120) NOT NULL,
    "private_key" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "device_id" UUID NOT NULL,
    "user_id" UUID,
    "endpoint" VARCHAR(1000) NOT NULL,
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "last_error" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "push_subscriptions_device_id_idx" ON "push_subscriptions"("device_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Trava do banco (Row-Level Security) na tabela de empresa nova, igual às demais.
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "push_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "push_subscriptions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "push_subscriptions", "push_keys" TO cenario_app;

-- O leitor de eventos dos avisos começa do evento atual (não relê o histórico antigo).
INSERT INTO "event_consumers" ("name", "last_seq", "updated_at")
SELECT 'avisos-no-aparelho', COALESCE(MAX("seq"), 0), CURRENT_TIMESTAMP FROM "domain_events"
ON CONFLICT ("name") DO NOTHING;
