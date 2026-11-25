-- Reversão de 20270907000000_precos_material: apaga só a tabela nova dos preços lidos das notas
-- (as despesas e a tabela do orçamento continuam como estão).
BEGIN;
DROP TABLE IF EXISTS "material_prices";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270907000000_precos_material';
COMMIT;
