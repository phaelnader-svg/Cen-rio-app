-- Plataforma separada das tapeçarias (pedido do dono em 25/11/2026): o Cenário Gestão (a plataforma)
-- e a Cenário Estofados (uma tapeçaria cliente) são empresas diferentes. Nada do painel depende de
-- uma conta de tapeçaria.
--
-- * company_settings.is_platform: um registro interno só da plataforma (id 0), onde ficam os e-mails do
--   painel, os pedidos de LGPD que chegam pelo site e os registros. Não é tapeçaria, ninguém entra.
-- * company_settings.server_connections: a tapeçaria que o painel liberou para usar as conexões
--   do servidor (chaves e webhooks únicos). No máximo uma. Começa na nº 1, que já as usava; o dono
--   troca no painel.
--
-- Só acrescenta: duas colunas, um registro novo e a marcação da nº 1 (comportamento de hoje).
-- Nenhuma linha é apagada; os dados das tapeçarias não mudam.

ALTER TABLE "company_settings" ADD COLUMN "is_platform" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "company_settings" ADD COLUMN "server_connections" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "company_settings_one_platform" ON "company_settings" ("is_platform") WHERE "is_platform";
CREATE UNIQUE INDEX "company_settings_one_server_connections" ON "company_settings" ("server_connections") WHERE "server_connections";

-- id 0: fora da numeração das empresas (a sequência continua de onde está).
INSERT INTO "company_settings" ("id", "trade_name", "is_platform", "billing_courtesy", "updated_at")
VALUES (0, 'Cenário Gestão (plataforma)', true, true, CURRENT_TIMESTAMP);

UPDATE "company_settings" SET "server_connections" = true WHERE "id" = 1;

-- "Esqueci a senha" do painel da plataforma (link por e-mail, 1 hora, uso único).
CREATE TABLE "platform_admin_resets" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_admin_resets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_admin_resets_token_hash_key" ON "platform_admin_resets"("token_hash");
CREATE INDEX "platform_admin_resets_admin_id_idx" ON "platform_admin_resets"("admin_id");
ALTER TABLE "platform_admin_resets" ADD CONSTRAINT "platform_admin_resets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admin_resets" TO cenario_app;
