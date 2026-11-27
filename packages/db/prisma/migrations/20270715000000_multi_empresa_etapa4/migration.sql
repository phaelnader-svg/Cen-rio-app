-- Multi-empresa — etapa 4: criar conta (empresa nova) e painel do dono da plataforma.
-- Só acrescenta: nenhuma linha é apagada ou alterada.

-- Módulos ligados/desligados: a chave passa a ser por empresa (cada empresa escolhe os seus).
-- A chave antiga (só "key") impediria a segunda empresa de gravar o mesmo módulo.
ALTER TABLE "module_settings" DROP CONSTRAINT "module_settings_pkey";
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_pkey" PRIMARY KEY ("company_id", "key");

-- Empresas: quando foi criada e bloqueio pelo dono da plataforma.
ALTER TABLE "company_settings" ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "company_settings" ADD COLUMN "blocked_at" TIMESTAMPTZ(3);
ALTER TABLE "company_settings" ADD COLUMN "blocked_reason" VARCHAR(200);
