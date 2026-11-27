-- 2026-11-25: preço pago por material, lido da nota da compra (despesa pela foto do Financeiro).
-- Compras compara os fornecedores e Orçamentos avisa quando o material subiu acima da tabela.

-- CreateTable
CREATE TABLE "material_prices" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "description" VARCHAR(200) NOT NULL,
    "unit" VARCHAR(20),
    "quantity" DECIMAL(12,3),
    "unit_price_cents" INTEGER NOT NULL,
    "supplier_name" VARCHAR(160) NOT NULL,
    "purchased_on" DATE NOT NULL,
    "expense_id" UUID,
    "file_id" UUID,
    "catalog_item_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "material_prices_unit_price_check" CHECK ("unit_price_cents" > 0)
);

-- CreateIndex
CREATE INDEX "material_prices_purchased_on_idx" ON "material_prices"("purchased_on");

-- CreateIndex
CREATE INDEX "material_prices_catalog_item_id_idx" ON "material_prices"("catalog_item_id");

-- AddForeignKey
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_prices" ADD CONSTRAINT "material_prices_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "quote_catalog_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- Trava do banco (Row-Level Security), igual às demais tabelas de empresa.
ALTER TABLE "material_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_prices"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
GRANT SELECT, INSERT, UPDATE, DELETE ON "material_prices" TO cenario_app;
