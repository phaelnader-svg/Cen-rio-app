-- Reversão de 20270822000000_retrabalhos_receitas. Apaga os retrabalhos cadastrados (os pedidos,
-- retiradas e OS deles continuam, sem a marca de retrabalho) e as receitas avulsas lançadas.
BEGIN;
DROP TABLE IF EXISTS "reworks";
DROP TABLE IF EXISTS "manual_revenues";
DELETE FROM "company_counters" WHERE "key" = 'reworks';
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270822000000_retrabalhos_receitas';
COMMIT;
