-- Reversão de 20270909000000_plataforma_separada. Só funciona enquanto nada foi gravado no registro
-- da plataforma (e-mails do painel, pedidos de LGPD do site): se houver, a FK impede e nada muda.
BEGIN;
DELETE FROM "company_settings" WHERE "is_platform";
DROP TABLE IF EXISTS "platform_admin_resets";
DROP INDEX IF EXISTS "company_settings_one_server_connections";
DROP INDEX IF EXISTS "company_settings_one_platform";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "server_connections";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "is_platform";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270909000000_plataforma_separada';
COMMIT;
