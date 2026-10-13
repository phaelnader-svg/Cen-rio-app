-- REVERSÃO MANUAL da migration 20261228000000_titular_mao_de_obra_prevista (estabilização da
-- Simplificação, Fase 2). Uso somente com backup recente e a aplicação PARADA, voltando ao
-- código anterior. SEGURANÇA: aborta se algum item de pedido já tem titular ou mão de obra
-- prevista (a intenção se perderia e a OS gerada na chegada sairia sem eles) — nesse caso,
-- recupere pelo backup anterior à migration. OS e mão de obra já geradas não são afetadas.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "commercial_order_items"
   WHERE "planned_upholsterer_user_id" IS NOT NULL OR "planned_labor_unit_cents" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % item(ns) com titular/mão de obra prevista. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP INDEX IF EXISTS "commercial_order_items_planned_upholsterer_user_id_idx";
ALTER TABLE "commercial_order_items" DROP CONSTRAINT IF EXISTS "commercial_order_items_planned_labor_ck";
ALTER TABLE "commercial_order_items" DROP CONSTRAINT IF EXISTS "commercial_order_items_planned_upholsterer_user_id_fkey";
ALTER TABLE "commercial_order_items" DROP COLUMN IF EXISTS "planned_labor_unit_cents";
ALTER TABLE "commercial_order_items" DROP COLUMN IF EXISTS "planned_upholsterer_user_id";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261228000000_titular_mao_de_obra_prevista';
COMMIT;
