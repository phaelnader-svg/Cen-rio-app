-- R2 — negociação de valores (value_change_requests) e confirmação semanal do profissional
-- (weekly_closing_confirmations). Aditiva: duas tabelas novas; nenhum dado existente é lido,
-- alterado ou criado (sem confirmações nem solicitações retroativas).

-- CreateTable
CREATE TABLE "value_change_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "target_kind" VARCHAR(20) NOT NULL,
    "production_payable_id" UUID,
    "logistics_cost_id" UUID,
    "beneficiary_user_id" UUID NOT NULL,
    "current_cents" INTEGER NOT NULL,
    "requested_cents" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    "decision_note" VARCHAR(500),
    "applied_as" VARCHAR(20),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "session_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "value_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_closing_confirmations" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "beneficiary_user_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "items" JSONB NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "reason" VARCHAR(500),
    "public_note" VARCHAR(300),
    "created_by_id" UUID,
    "session_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_closing_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "value_change_requests_number_key" ON "value_change_requests"("number");

-- CreateIndex
CREATE INDEX "value_change_requests_status_created_at_idx" ON "value_change_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "value_change_requests_beneficiary_user_id_created_at_idx" ON "value_change_requests"("beneficiary_user_id", "created_at");

-- CreateIndex
CREATE INDEX "value_change_requests_production_payable_id_idx" ON "value_change_requests"("production_payable_id");

-- CreateIndex
CREATE INDEX "value_change_requests_logistics_cost_id_idx" ON "value_change_requests"("logistics_cost_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_closing_confirmations_number_key" ON "weekly_closing_confirmations"("number");

-- CreateIndex
CREATE INDEX "weekly_closing_confirmations_beneficiary_user_id_week_start_idx" ON "weekly_closing_confirmations"("beneficiary_user_id", "week_start", "created_at");

-- CreateIndex
CREATE INDEX "weekly_closing_confirmations_week_start_idx" ON "weekly_closing_confirmations"("week_start");

-- AddForeignKey
ALTER TABLE "value_change_requests" ADD CONSTRAINT "value_change_requests_production_payable_id_fkey" FOREIGN KEY ("production_payable_id") REFERENCES "production_payables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_change_requests" ADD CONSTRAINT "value_change_requests_logistics_cost_id_fkey" FOREIGN KEY ("logistics_cost_id") REFERENCES "logistics_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_change_requests" ADD CONSTRAINT "value_change_requests_beneficiary_user_id_fkey" FOREIGN KEY ("beneficiary_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_change_requests" ADD CONSTRAINT "value_change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing_confirmations" ADD CONSTRAINT "weekly_closing_confirmations_beneficiary_user_id_fkey" FOREIGN KEY ("beneficiary_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_closing_confirmations" ADD CONSTRAINT "weekly_closing_confirmations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Regras de integridade (fora do modelo do Prisma).
ALTER TABLE "value_change_requests"
  ADD CONSTRAINT "value_change_requests_target" CHECK (
    ("target_kind" = 'PRODUCAO' AND "production_payable_id" IS NOT NULL AND "logistics_cost_id" IS NULL)
    OR ("target_kind" = 'LOGISTICA' AND "logistics_cost_id" IS NOT NULL AND "production_payable_id" IS NULL)),
  ADD CONSTRAINT "value_change_requests_status" CHECK ("status" IN ('PENDENTE', 'APROVADA', 'RECUSADA', 'OBSOLETA')),
  ADD CONSTRAINT "value_change_requests_values" CHECK ("current_cents" >= 0 AND "requested_cents" > 0 AND "requested_cents" <> "current_cents"),
  ADD CONSTRAINT "value_change_requests_applied" CHECK ("applied_as" IS NULL OR "applied_as" IN ('VALOR_COMBINADO', 'AJUSTE')),
  ADD CONSTRAINT "value_change_requests_decision" CHECK (("status" = 'PENDENTE') = ("decided_at" IS NULL));
-- No máximo uma solicitação pendente por alvo.
CREATE UNIQUE INDEX "value_change_requests_one_open_payable" ON "value_change_requests"("production_payable_id") WHERE "status" = 'PENDENTE';
CREATE UNIQUE INDEX "value_change_requests_one_open_cost" ON "value_change_requests"("logistics_cost_id") WHERE "status" = 'PENDENTE';
CREATE TRIGGER "value_change_requests_no_delete" BEFORE DELETE ON "value_change_requests"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();

ALTER TABLE "weekly_closing_confirmations"
  ADD CONSTRAINT "weekly_closing_confirmations_kind" CHECK ("kind" IN ('PROFISSIONAL', 'EXCECAO_ADMINISTRATIVA')),
  ADD CONSTRAINT "weekly_closing_confirmations_reason" CHECK ("kind" <> 'EXCECAO_ADMINISTRATIVA' OR ("reason" IS NOT NULL AND length("reason") >= 3 AND "created_by_id" IS NOT NULL)),
  ADD CONSTRAINT "weekly_closing_confirmations_week" CHECK (extract(isodow FROM "week_start") = 1),
  ADD CONSTRAINT "weekly_closing_confirmations_hash" CHECK ("hash" ~ '^[0-9a-f]{64}$');
-- Retrato imutável: nunca alterado nem apagado (a validade é recalculada ao vivo).
CREATE TRIGGER "weekly_closing_confirmations_immutable" BEFORE UPDATE OR DELETE ON "weekly_closing_confirmations"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
