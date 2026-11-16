-- REVERSÃO MANUAL da migration 20270330000000_autorizacao_aplicativos (aplicação parada, com backup).
-- Remove a autorização delegada de aplicativos: todos os aplicativos conectados (ex.: Firma Viva)
-- perdem o acesso imediatamente. Revoga as sessões ligadas às concessões antes de apagá-las.
BEGIN;
UPDATE "sessions" SET "revoked_at" = now(), "revoked_reason" = 'APP_REMOVIDO'
 WHERE "id" IN (SELECT "session_id" FROM "oauth_grants") AND "revoked_at" IS NULL;
DROP TABLE IF EXISTS "oauth_access_tokens", "oauth_grants", "oauth_codes", "oauth_clients";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270330000000_autorizacao_aplicativos';
COMMIT;
