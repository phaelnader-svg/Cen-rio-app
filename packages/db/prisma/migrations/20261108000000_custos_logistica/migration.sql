-- Evolução, Fase 6: custos de retirada e entrega (valor total por viagem, recebedor único,
-- participantes, realização, ajustes, estornos e rateio por revisão).
-- Migration ADITIVA: nenhum valor, rateio, pagamento ou obrigação existente é alterado. O texto
-- livre do recebedor legado (`beneficiary`) é preservado; nenhum vínculo é inferido por nome.

-- DropIndex
DROP INDEX "logistics_cost_allocations_logistics_cost_id_service_order__key";

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "default_delivery_cost_cents" INTEGER,
ADD COLUMN     "default_pickup_cost_cents" INTEGER,
ADD COLUMN     "logistics_payee_user_id" UUID;

-- AlterTable
ALTER TABLE "logistics_cost_allocations" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "logistics_costs" ADD COLUMN     "adjustments_cents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "allocation_mode" VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "allocation_revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "due_at" TIMESTAMPTZ(3),
ADD COLUMN     "payee_user_id" UUID,
ADD COLUMN     "pending_reason" VARCHAR(40),
ADD COLUMN     "status" VARCHAR(20) NOT NULL DEFAULT 'LANCADO';

-- CreateTable
CREATE TABLE "logistics_cost_participants" (
    "logistics_cost_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logistics_cost_participants_pkey" PRIMARY KEY ("logistics_cost_id","user_id")
);

-- CreateTable
CREATE TABLE "logistics_cost_adjustments" (
    "id" UUID NOT NULL,
    "logistics_cost_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "authorized_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logistics_cost_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_payment_reversals" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payable_payment_reversals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "logistics_cost_adjustments_logistics_cost_id_idx" ON "logistics_cost_adjustments"("logistics_cost_id");

-- CreateIndex
CREATE UNIQUE INDEX "payable_payment_reversals_payment_id_key" ON "payable_payment_reversals"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_cost_allocations_logistics_cost_id_revision_servi_key" ON "logistics_cost_allocations"("logistics_cost_id", "revision", "service_order_id");

-- CreateIndex
CREATE INDEX "logistics_costs_payee_user_id_due_at_idx" ON "logistics_costs"("payee_user_id", "due_at");

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_logistics_payee_user_id_fkey" FOREIGN KEY ("logistics_payee_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_payee_user_id_fkey" FOREIGN KEY ("payee_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_participants" ADD CONSTRAINT "logistics_cost_participants_logistics_cost_id_fkey" FOREIGN KEY ("logistics_cost_id") REFERENCES "logistics_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_participants" ADD CONSTRAINT "logistics_cost_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_adjustments" ADD CONSTRAINT "logistics_cost_adjustments_logistics_cost_id_fkey" FOREIGN KEY ("logistics_cost_id") REFERENCES "logistics_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_cost_adjustments" ADD CONSTRAINT "logistics_cost_adjustments_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_payment_reversals" ADD CONSTRAINT "payable_payment_reversals_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payable_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Situação dos custos já lançados (Fase 11): LANCADO; os cancelados, CANCELADO.
UPDATE "logistics_costs" SET "status" = 'CANCELADO' WHERE "cancelled_at" IS NOT NULL;

ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_phase6" CHECK (
  "status" IN ('LANCADO', 'PREVISTO', 'DEVIDO', 'CANCELADO')
  AND ("status" = 'CANCELADO') = ("cancelled_at" IS NOT NULL)
  AND "allocation_mode" IN ('MANUAL', 'AUTO', 'ESCOLHIDA')
  AND "allocation_revision" >= 0
  AND "amount_cents" + "adjustments_cents" > 0
  AND ("status" <> 'DEVIDO' OR "due_at" IS NOT NULL));
-- Taxa de tentativa frustrada: custo próprio, autorizado pelo gestor (amplia a lista de tipos).
ALTER TABLE "logistics_costs" DROP CONSTRAINT "logistics_costs_kind";
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_kind" CHECK (
  "amount_cents" > 0
  AND "kind" IN ('RETIRADA', 'ENTREGA', 'INSTALACAO', 'TRANSPORTE_TERCEIRIZADO', 'DESLOCAMENTO', 'TENTATIVA_FRUSTRADA')
  AND "split_method" IN ('IGUAL', 'POR_PECA', 'MANUAL'));
ALTER TABLE "logistics_cost_allocations" ADD CONSTRAINT "logistics_cost_allocations_revision" CHECK ("revision" >= 1);
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_logistics_defaults" CHECK (
  ("default_pickup_cost_cents" IS NULL OR "default_pickup_cost_cents" BETWEEN 1 AND 10000000)
  AND ("default_delivery_cost_cents" IS NULL OR "default_delivery_cost_cents" BETWEEN 1 AND 10000000));
ALTER TABLE "logistics_cost_adjustments" ADD CONSTRAINT "logistics_cost_adjustments_amount" CHECK (
  "amount_cents" <> 0 AND length(trim("reason")) >= 3);
ALTER TABLE "payable_payment_reversals" ADD CONSTRAINT "payable_payment_reversals_reason" CHECK (
  length(trim("reason")) >= 3);

-- Ajustes e estornos são imutáveis (correção = novo lançamento).
CREATE TRIGGER "logistics_cost_adjustments_immutable" BEFORE UPDATE OR DELETE ON "logistics_cost_adjustments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "payable_payment_reversals_immutable" BEFORE UPDATE OR DELETE ON "payable_payment_reversals"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
