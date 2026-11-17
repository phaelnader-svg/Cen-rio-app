-- Entrada direta no Firma Viva com a conta do Cenário Gestão (botão "Acessar ambiente interativo").
-- Aditiva: estados de autorização podem não ter pessoa/organização (entrada) e ganham o vínculo
-- com o navegador; nova tabela liga a pessoa do Cenário à conta do Firma Viva.

ALTER TABLE "oauth_states" ADD COLUMN "purpose" VARCHAR(10) NOT NULL DEFAULT 'CONEXAO';
ALTER TABLE "oauth_states" ADD COLUMN "browser_hash" CHAR(64);
ALTER TABLE "oauth_states" ALTER COLUMN "org_id" DROP NOT NULL;
ALTER TABLE "oauth_states" ALTER COLUMN "user_id" DROP NOT NULL;

CREATE TABLE "cenario_logins" (
    "id" UUID NOT NULL,
    "company_key" VARCHAR(300) NOT NULL,
    "cenario_user_id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cenario_logins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cenario_logins_company_key_cenario_user_id_key" ON "cenario_logins"("company_key", "cenario_user_id");
CREATE INDEX "cenario_logins_user_id_idx" ON "cenario_logins"("user_id");

ALTER TABLE "cenario_logins" ADD CONSTRAINT "cenario_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
