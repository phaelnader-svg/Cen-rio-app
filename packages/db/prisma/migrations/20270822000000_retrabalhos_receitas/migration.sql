-- Retrabalhos e receitas avulsas (2026-11-18). Só acrescenta (duas tabelas novas); nenhum dado
-- existente muda. Reversão em packages/db/rollback/20270822000000_retrabalhos_receitas.down.sql.
--   reworks: retrabalho (RT-00001) — serviço já feito que volta para ser refeito; aponta para o
--            pedido do retrabalho (retirada e OS normais) e para o pedido original.
--   manual_revenues: dinheiro que entrou fora das cobranças de pedido (aba Receitas).

-- CreateTable
CREATE TABLE "manual_revenues" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "received_at" DATE NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "notes" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_revenues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reworks" (
    "id" UUID NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "number" INTEGER NOT NULL,
    "order_id" UUID NOT NULL,
    "original_order_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "cause" VARCHAR(30) NOT NULL,
    "extra_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "extra_cost_note" VARCHAR(300),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reworks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manual_revenues_received_at_idx" ON "manual_revenues"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "reworks_order_id_key" ON "reworks"("order_id");

-- CreateIndex
CREATE INDEX "reworks_original_order_id_idx" ON "reworks"("original_order_id");

-- CreateIndex
CREATE INDEX "reworks_created_at_idx" ON "reworks"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reworks_company_id_number_key" ON "reworks"("company_id", "number");

-- AddForeignKey
ALTER TABLE "manual_revenues" ADD CONSTRAINT "manual_revenues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reworks" ADD CONSTRAINT "reworks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reworks" ADD CONSTRAINT "reworks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reworks" ADD CONSTRAINT "reworks_original_order_id_fkey" FOREIGN KEY ("original_order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Numeração por empresa (RT-00001), igual às demais tabelas numeradas.
CREATE TRIGGER "reworks_company_number" BEFORE INSERT ON "reworks"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();

-- Trava do banco (Row-Level Security) nas tabelas de empresa novas, igual às demais.
ALTER TABLE "reworks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reworks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "reworks"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "manual_revenues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_revenues" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "manual_revenues"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "reworks" TO cenario_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "manual_revenues" TO cenario_app;
