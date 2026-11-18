-- Reversão de 20270815000000_despesas_prazos_alertas. Apaga as categorias de despesa cadastradas
-- pelas empresas (as despesas que usam uma delas continuam com o nome gravado) e o prazo em dias
-- úteis dos pedidos (a data do prazo continua gravada).
BEGIN;
DROP TABLE IF EXISTS "expense_categories";
ALTER TABLE "commercial_orders" DROP COLUMN IF EXISTS "delivery_business_days";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270815000000_despesas_prazos_alertas';
COMMIT;
