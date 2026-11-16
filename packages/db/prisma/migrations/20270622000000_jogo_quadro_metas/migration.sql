-- Jogo de gestão: Quadro de Metas (caixa da empresa no escritório).
-- Saldo inicial por conta (com data e hora), lançamentos manuais enquanto não há integração,
-- metas, conquistas e fechamentos semanais. Recebimentos e pagamentos continuam nos registros
-- oficiais do financeiro: o quadro só os lê (nada é duplicado aqui).

-- Contas consideradas no caixa e de onde vem o dinheiro de cada uma.
ALTER TABLE "bank_accounts"
  ADD COLUMN "included_in_cash" BOOLEAN NOT NULL DEFAULT true,
  -- REGISTROS: recebimentos/pagamentos oficiais; EXTRATO: linhas do extrato importado (conciliadas).
  ADD COLUMN "cash_source" VARCHAR(10) NOT NULL DEFAULT 'REGISTROS',
  -- Conta que recebe os registros oficiais sem conta definida (um por empresa).
  ADD COLUMN "cash_default" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_cash_source" CHECK ("cash_source" IN ('REGISTROS', 'EXTRATO'));
CREATE UNIQUE INDEX "bank_accounts_one_cash_default" ON "bank_accounts"("cash_default") WHERE "cash_default";

CREATE TABLE "cash_snapshots" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,
    "source" VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
    "note" VARCHAR(300),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cash_snapshots_account_id_taken_at_idx" ON "cash_snapshots"("account_id", "taken_at");

CREATE TABLE "cash_entries" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "service_order_id" UUID,
    "payable_id" UUID,
    "transfer_group_id" UUID,
    "reversal_of_id" UUID,
    "reason" VARCHAR(500),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cash_entries_account_id_occurred_at_idx" ON "cash_entries"("account_id", "occurred_at");
CREATE UNIQUE INDEX "cash_entries_reversal_of_id_key" ON "cash_entries"("reversal_of_id");

CREATE TABLE "cash_goals" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "target_cents" INTEGER NOT NULL,
    "deadline" DATE,
    "account_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cash_goals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cash_goal_achievements" (
    "id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "achieved_at" TIMESTAMPTZ(3) NOT NULL,
    "balance_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_goal_achievements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cash_goal_achievements_goal_id_key" ON "cash_goal_achievements"("goal_id");

CREATE TABLE "cash_week_closings" (
    "id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "opening_cents" INTEGER NOT NULL,
    "closing_cents" INTEGER NOT NULL,
    "in_cents" INTEGER NOT NULL,
    "out_cents" INTEGER NOT NULL,
    "entries" JSONB NOT NULL DEFAULT '[]',
    "closed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_week_closings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cash_week_closings_week_start_key" ON "cash_week_closings"("week_start");

ALTER TABLE "cash_snapshots" ADD CONSTRAINT "cash_snapshots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "cash_snapshots" ADD CONSTRAINT "cash_snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT;
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "account_payables"("id") ON DELETE RESTRICT;
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "cash_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "cash_goals" ADD CONSTRAINT "cash_goals_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "cash_goal_achievements" ADD CONSTRAINT "cash_goal_achievements_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "cash_goals"("id") ON DELETE RESTRICT;

ALTER TABLE "cash_snapshots" ADD CONSTRAINT "cash_snapshots_source" CHECK ("source" IN ('MANUAL', 'EXTRATO'));
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_kind" CHECK (
  "kind" IN ('RECEBIMENTO', 'DESPESA', 'MATERIAL', 'MAO_DE_OBRA', 'TRANSFERENCIA', 'APORTE', 'RETIRADA', 'AJUSTE', 'ESTORNO')
  AND "amount_cents" <> 0);
ALTER TABLE "cash_goals" ADD CONSTRAINT "cash_goals_target" CHECK ("target_cents" > 0);

-- Saldos iniciais e lançamentos manuais: somente inserção (correção = novo saldo ou estorno).
DO $$ BEGIN
  EXECUTE 'CREATE TRIGGER cash_snapshots_immutable BEFORE UPDATE OR DELETE ON cash_snapshots FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation()';
  EXECUTE 'CREATE TRIGGER cash_entries_immutable BEFORE UPDATE OR DELETE ON cash_entries FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation()';
END $$;
