-- Simplificação Fase 2 (estabilização) — Fase 1 §4.3 opção B: o fechamento do serviço registra
-- o tapeceiro titular e a mão de obra PREVISTA de cada peça como intenção técnica do item do
-- pedido. Nada financeiro nasce aqui: a obrigação (mão de obra combinada) só é criada quando a
-- OS é gerada na chegada, para a quantidade que chegou. Aditiva; pedidos existentes ficam sem
-- intenção (comportamento anterior).
ALTER TABLE "commercial_order_items"
  ADD COLUMN "planned_upholsterer_user_id" UUID,
  ADD COLUMN "planned_labor_unit_cents" INTEGER;

ALTER TABLE "commercial_order_items"
  ADD CONSTRAINT "commercial_order_items_planned_upholsterer_user_id_fkey"
  FOREIGN KEY ("planned_upholsterer_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mão de obra prevista é por unidade, positiva, e sempre do titular previsto.
ALTER TABLE "commercial_order_items"
  ADD CONSTRAINT "commercial_order_items_planned_labor_ck"
  CHECK ("planned_labor_unit_cents" IS NULL
         OR ("planned_labor_unit_cents" > 0 AND "planned_upholsterer_user_id" IS NOT NULL));

CREATE INDEX "commercial_order_items_planned_upholsterer_user_id_idx"
  ON "commercial_order_items"("planned_upholsterer_user_id");
