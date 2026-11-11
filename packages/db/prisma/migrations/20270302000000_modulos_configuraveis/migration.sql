-- Reformulação, Fase 0 — funcionalidades operacionais configuráveis (logística, pedidos de ajuda,
-- embalagem obrigatória). Mudança só ADITIVA: uma tabela nova e vazia. Sem linha = valor padrão
-- (tudo ligado), então nenhuma instalação muda de comportamento ao aplicar esta migration; a
-- versão anterior da aplicação simplesmente ignora a tabela. Nada é apagado nem alterado.

-- CreateTable
CREATE TABLE "module_settings" (
    "key" VARCHAR(40) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID,

    CONSTRAINT "module_settings_pkey" PRIMARY KEY ("key")
);

-- Chave no formato do catálogo (minúsculas) e versão de concorrência sempre positiva.
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_key_format"
  CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_version_positive"
  CHECK ("version" >= 1);

-- AddForeignKey
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
