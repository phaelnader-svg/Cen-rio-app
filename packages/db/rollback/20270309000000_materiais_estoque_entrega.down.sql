-- REVERSÃO MANUAL da migration 20270309000000_materiais_estoque_entrega (Reformulação, Fase 1).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (que ignora as
-- tabelas novas). SEGURANÇA: aborta (sem alterar nada) se existe QUALQUER dado da Fase 1 —
-- material de OS, estoque simples, entrega direta ou custo informado na OS —, porque o código
-- anterior não sabe exibi-lo e a reversão o apagaria. Nesse caso, NÃO reverta o banco: volte só a
-- aplicação para a versão de retorno que conhece esta migration (rollback não destrutivo).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "service_order_materials") + (SELECT count(*) FROM "inventory_categories")
       + (SELECT count(*) FROM "inventory_items") + (SELECT count(*) FROM "fabric_rolls")
       + (SELECT count(*) FROM "inventory_adjustments")
       + (SELECT count(*) FROM "deliveries" WHERE "origin" <> 'LOGISTICA')
       + (SELECT count(*) FROM "service_order_costs" WHERE "source" = 'MATERIAL_OS')
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 1 (materiais da OS, estoque simples, entrega direta ou custo informado). Use o rollback não destrutivo da aplicação.', n;
  END IF;
END $$;
ALTER TABLE "service_order_costs" DROP CONSTRAINT "service_order_costs_kind";
ALTER TABLE "service_order_costs" ADD CONSTRAINT "service_order_costs_kind" CHECK (
  "category" IN ('MATERIAL', 'OUTRO_VARIAVEL')
  AND "source" IN ('COMPRA_EXCLUSIVA', 'ESTORNO_COMPRA', 'SAIDA_ESTOQUE', 'DEVOLUCAO_ESTOQUE', 'SOBRA_SAIDA', 'SOBRA_ENTRADA', 'AJUSTE_MANUAL'));
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_origin";
ALTER TABLE "deliveries" DROP COLUMN "origin";
DROP TABLE "service_order_materials";
DROP TABLE "inventory_adjustments";
DROP TABLE "fabric_rolls";
DROP TABLE "inventory_items";
DROP TABLE "inventory_categories";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270309000000_materiais_estoque_entrega';
COMMIT;
