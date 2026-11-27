-- Reversão da etapa 4 do multi-empresa. Recusa se houver mais de uma empresa (a chave antiga de
-- module_settings não cabe com duas empresas).
BEGIN;
-- A contagem precisa ver todas as empresas, mesmo com a trava do banco (RLS) ativa.
SELECT set_config('app.bypass_rls', 'on', true);
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM company_settings) > 1 THEN
    RAISE EXCEPTION 'Há mais de uma empresa: a reversão da etapa 4 apagaria a separação dos módulos.';
  END IF;
END $$;

ALTER TABLE "company_settings" DROP COLUMN "blocked_reason";
ALTER TABLE "company_settings" DROP COLUMN "blocked_at";
ALTER TABLE "company_settings" DROP COLUMN "created_at";
ALTER TABLE "module_settings" DROP CONSTRAINT "module_settings_pkey";
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_pkey" PRIMARY KEY ("key");

DELETE FROM "_prisma_migrations" WHERE migration_name = '20270715000000_multi_empresa_etapa4';
COMMIT;
