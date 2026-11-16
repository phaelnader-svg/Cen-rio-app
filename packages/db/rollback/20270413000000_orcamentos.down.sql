-- REVERSÃO MANUAL da migration 20270413000000_orcamentos (aplicação parada, com backup).
-- Remove o módulo Orçamentos: as tabelas de orçamentos, configurações e base de preços do orçamento.
-- Nenhuma outra tabela é afetada.
-- SEGURANÇA: aborta (sem alterar nada) se existe algum orçamento salvo (inclusive excluído) — a
-- versão anterior não tem onde guardar orçamentos nem O.S. e eles se perderiam.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "quotes";
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % orçamento(s) salvo(s).', n;
  END IF;
END $$;
DROP TABLE "quotes", "quote_settings", "quote_catalog_items";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270413000000_orcamentos';
COMMIT;
