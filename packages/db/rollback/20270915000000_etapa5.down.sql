-- Reversão de 20270915000000_etapa5 (só o que a migration acrescentou).
-- Apaga a data de fim do teste de 7 dias do Firma Viva.
BEGIN;
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "game_trial_ends_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270915000000_etapa5';
COMMIT;
