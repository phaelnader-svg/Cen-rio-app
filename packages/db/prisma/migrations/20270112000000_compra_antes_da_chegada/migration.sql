-- Compras e materiais sem duplicidade — Etapa 3: compra antes da chegada da peça.
-- Aditiva: nenhuma linha existente muda de significado (sem backfill). PREVISAO_MANUAL continua
-- anotação legada. Os CHECKs comparam origin::text para poder usar o valor novo na mesma transação.

-- 1. Nova origem: previsão de compra (pode existir antes da OS).
ALTER TYPE "material_requirement_origin" ADD VALUE IF NOT EXISTS 'PREVISAO_COMPRA';

-- 2/3. Necessidade: OS opcional (só para a previsão de compra) e a peça do pedido como identidade pré-OS.
ALTER TABLE "material_requirements" ALTER COLUMN "service_order_id" DROP NOT NULL;
ALTER TABLE "material_requirements" ADD COLUMN "order_item_id" UUID;
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "material_requirements_order_item_id_status_idx" ON "material_requirements"("order_item_id", "status");

-- 4. Destino válido e regras da previsão.
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_destination_chk"
  CHECK ("service_order_id" IS NOT NULL OR "order_item_id" IS NOT NULL);
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_preos_forecast_chk"
  CHECK ("service_order_id" IS NOT NULL OR "origin"::text = 'PREVISAO_COMPRA');
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_forecast_fields_chk"
  CHECK ("origin"::text <> 'PREVISAO_COMPRA'
    OR ("order_item_id" IS NOT NULL AND "unit_code" IS NOT NULL AND "quantity" IS NOT NULL));
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_item_requires_os_chk"
  CHECK ("service_order_item_id" IS NULL OR "service_order_id" IS NOT NULL);

-- 5. Alocação de compra pode existir antes da OS (o destino é a necessidade → peça do pedido).
ALTER TABLE "purchase_allocations" ALTER COLUMN "service_order_id" DROP NOT NULL;

-- 6. Item exclusivo pré-OS: o destino é a única alocação; a OS é preenchida na chegada.
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_sourcing";
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_sourcing" CHECK (
  ("kind" <> 'TECIDO' OR "sourcing" = 'EXCLUSIVO_OS') AND
  (("sourcing" = 'EXCLUSIVO_OS' AND "stock_item_id" IS NULL) OR
   ("sourcing" = 'ESTOQUE' AND "stock_item_id" IS NOT NULL AND "service_order_id" IS NULL))
);

-- 7. Sobra de origem pré-OS (pedido/peça cancelados com exclusivo recebido), sem OS inventada.
ALTER TABLE "material_leftovers" ALTER COLUMN "service_order_id" DROP NOT NULL;
ALTER TABLE "material_leftovers" ADD COLUMN "order_item_id" UUID;
ALTER TABLE "material_leftovers" ADD COLUMN "source_requirement_id" UUID;
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "commercial_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_source_requirement_id_fkey"
  FOREIGN KEY ("source_requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_origin_chk"
  CHECK ("service_order_id" IS NOT NULL OR ("order_item_id" IS NOT NULL AND "source_requirement_id" IS NOT NULL));
CREATE INDEX "material_leftovers_order_item_id_idx" ON "material_leftovers"("order_item_id");
ALTER TABLE "material_leftover_transfers" ALTER COLUMN "from_service_order_id" DROP NOT NULL;
