-- Reversão de 20270902000000_aparelho_mostra. Apaga só a escolha "o que este aparelho mostra"
-- (todos os aparelhos voltam a mostrar tudo o que o cargo da pessoa permite).
BEGIN;
ALTER TABLE "devices" DROP COLUMN IF EXISTS "shows";
DROP TYPE IF EXISTS "device_shows";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270902000000_aparelho_mostra';
COMMIT;
