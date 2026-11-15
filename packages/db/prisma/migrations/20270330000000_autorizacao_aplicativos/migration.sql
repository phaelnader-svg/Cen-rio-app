-- Autorização delegada e revogável para aplicativos externos (ex.: Firma Viva).
-- OAuth 2.0 com código de autorização + PKCE. O usuário digita a senha apenas na tela oficial
-- do Cenário Gestão; o aplicativo recebe tokens de acesso curtos e um token de renovação.
-- Aqui ficam só HASHES dos segredos/tokens. Cada concessão é ligada a uma sessão própria
-- (tipo WEB) para que auditoria e registros mostrem quem agiu e por qual aplicativo.

CREATE TABLE "oauth_clients" (
    "id" UUID NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "secret_hash" CHAR(64) NOT NULL,
    "redirect_uris" TEXT[] NOT NULL,
    "allowed_scopes" TEXT[] NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

CREATE TABLE "oauth_codes" (
    "id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "redirect_uri" VARCHAR(500) NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "code_challenge" VARCHAR(128) NOT NULL,
    "external_ref" VARCHAR(80),
    "external_label" VARCHAR(120),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_codes_code_hash_key" ON "oauth_codes"("code_hash");
CREATE INDEX "oauth_codes_expires_at_idx" ON "oauth_codes"("expires_at");

CREATE TABLE "oauth_grants" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "scopes" TEXT[] NOT NULL,
    -- Organização do aplicativo que recebeu a autorização (exibida em "Aplicativos conectados").
    "external_ref" VARCHAR(80),
    "external_label" VARCHAR(120),
    "refresh_hash" CHAR(64),
    "refresh_expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(40),
    "revoked_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_grants_session_id_key" ON "oauth_grants"("session_id");
CREATE UNIQUE INDEX "oauth_grants_refresh_hash_key" ON "oauth_grants"("refresh_hash");
CREATE INDEX "oauth_grants_user_id_revoked_at_idx" ON "oauth_grants"("user_id", "revoked_at");

CREATE TABLE "oauth_access_tokens" (
    "id" UUID NOT NULL,
    "grant_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_access_tokens_token_hash_key" ON "oauth_access_tokens"("token_hash");
CREATE INDEX "oauth_access_tokens_grant_id_idx" ON "oauth_access_tokens"("grant_id");
CREATE INDEX "oauth_access_tokens_expires_at_idx" ON "oauth_access_tokens"("expires_at");

ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "oauth_grants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
