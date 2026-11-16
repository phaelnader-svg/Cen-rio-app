-- REVERSÃO MANUAL da migration 20270413000000_orcamentos (aplicação parada, com backup).
-- Remove o módulo Orçamentos: APAGA os orçamentos salvos, as O.S. dos orçamentos e a base de dados
-- de preços do orçamento. Nenhuma outra tabela é afetada.
BEGIN;
DROP TABLE IF EXISTS "quotes", "quote_settings", "quote_catalog_items";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270413000000_orcamentos';
COMMIT;
