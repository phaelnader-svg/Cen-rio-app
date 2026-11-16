-- REVERSÃO MANUAL da migration 20270112000000_compra_antes_da_chegada (Compras, Etapa 3).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se existe qualquer registro que
-- a versão anterior não sabe representar — previsão de compra, necessidade/alocação/item/sobra/
-- transferência sem OS ou ligada à peça do pedido. Nesse caso, recupere pelo backup anterior à
-- migration. Sem esses registros a reversão é exata: o valor de enum novo é retirado recriando o
-- tipo com os valores originais (o PostgreSQL não remove valor de enum diretamente).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "material_requirements"
           WHERE "service_order_id" IS NULL OR "order_item_id" IS NOT NULL OR "origin"::text = 'PREVISAO_COMPRA')
       + (SELECT count(*) FROM "purchase_allocations" WHERE "service_order_id" IS NULL)
       + (SELECT count(*) FROM "purchase_order_items" WHERE "sourcing" = 'EXCLUSIVO_OS' AND "service_order_id" IS NULL)
       + (SELECT count(*) FROM "material_leftovers"
           WHERE "service_order_id" IS NULL OR "order_item_id" IS NOT NULL OR "source_requirement_id" IS NOT NULL)
       + (SELECT count(*) FROM "material_leftover_transfers" WHERE "from_service_order_id" IS NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) de compra antes da chegada (previsão, alocação, item, sobra ou transferência sem OS). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
-- 7. Sobras e transferências.
ALTER TABLE "material_leftover_transfers" ALTER COLUMN "from_service_order_id" SET NOT NULL;
DROP INDEX "material_leftovers_order_item_id_idx";
ALTER TABLE "material_leftovers" DROP CONSTRAINT "material_leftovers_origin_chk";
ALTER TABLE "material_leftovers" DROP CONSTRAINT "material_leftovers_source_requirement_id_fkey";
ALTER TABLE "material_leftovers" DROP CONSTRAINT "material_leftovers_order_item_id_fkey";
ALTER TABLE "material_leftovers" DROP COLUMN "source_requirement_id";
ALTER TABLE "material_leftovers" DROP COLUMN "order_item_id";
ALTER TABLE "material_leftovers" ALTER COLUMN "service_order_id" SET NOT NULL;
-- 6. Regra de origem do item (definição de 20261009000000_compras_estoque).
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_sourcing";
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_sourcing" CHECK (
  ("kind" <> 'TECIDO' OR "sourcing" = 'EXCLUSIVO_OS') AND
  (("sourcing" = 'EXCLUSIVO_OS' AND "service_order_id" IS NOT NULL AND "stock_item_id" IS NULL) OR
   ("sourcing" = 'ESTOQUE' AND "stock_item_id" IS NOT NULL AND "service_order_id" IS NULL))
);
-- 5. Alocação.
ALTER TABLE "purchase_allocations" ALTER COLUMN "service_order_id" SET NOT NULL;
-- 4/3/2. Necessidade.
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_item_requires_os_chk";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_forecast_fields_chk";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_preos_forecast_chk";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_destination_chk";
DROP INDEX "material_requirements_order_item_id_status_idx";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_order_item_id_fkey";
ALTER TABLE "material_requirements" DROP COLUMN "order_item_id";
ALTER TABLE "material_requirements" ALTER COLUMN "service_order_id" SET NOT NULL;
-- 1. Enum com os valores originais (20261008200000_medicoes_materiais).
-- A regra de necessidade aprovada compara com um valor do enum: sai e volta igual.
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_approved_origin";
ALTER TYPE "material_requirement_origin" RENAME TO "material_requirement_origin_r4";
CREATE TYPE "material_requirement_origin" AS ENUM ('PREVISAO_MANUAL', 'SOLICITACAO_APROVADA');
ALTER TABLE "material_requirements" ALTER COLUMN "origin" DROP DEFAULT;
ALTER TABLE "material_requirements" ALTER COLUMN "origin" TYPE "material_requirement_origin"
  USING "origin"::text::"material_requirement_origin";
ALTER TABLE "material_requirements" ALTER COLUMN "origin" SET DEFAULT 'PREVISAO_MANUAL';
DROP TYPE "material_requirement_origin_r4";
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_approved_origin" CHECK (
  "origin" <> 'SOLICITACAO_APROVADA'
  OR ("material_request_item_id" IS NOT NULL AND "unit_code" IS NOT NULL AND "quantity" IS NOT NULL AND "approved_at" IS NOT NULL)
);
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270112000000_compra_antes_da_chegada';
COMMIT;
