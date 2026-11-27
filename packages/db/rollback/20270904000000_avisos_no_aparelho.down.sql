-- Reversão de 20270904000000_avisos_no_aparelho. Apaga só os avisos no aparelho (as chaves e a
-- lista de aparelhos que aceitaram avisos); nenhum outro dado muda. Os aparelhos continuam
-- vinculados e funcionando, só param de receber avisos com o app fechado.
BEGIN;
DELETE FROM "event_consumers" WHERE "name" = 'avisos-no-aparelho';
DROP TABLE IF EXISTS "push_subscriptions";
DROP TABLE IF EXISTS "push_keys";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270904000000_avisos_no_aparelho';
COMMIT;
