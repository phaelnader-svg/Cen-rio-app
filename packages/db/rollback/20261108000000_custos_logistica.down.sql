-- REVERSÃO MANUAL da migration 20261108000000_custos_logistica (Evolução, Fase 6).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código da Fase 5 (14af6e7).
--
-- SEGURANÇA: a reversão só é permitida enquanto NÃO existir nenhum dado da Fase 6 (custo de
-- viagem previsto/devido, recebedor vinculado, participante, ajuste, estorno, rateio revisado ou
-- padrão configurado). Havendo qualquer um, o bloco abaixo aborta ANTES de qualquer alteração:
-- a recuperação é pela restauração do backup anterior à migration (docs/EVOLUCAO-FASE-6-...).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "logistics_costs"
            WHERE "status" IN ('PREVISTO', 'DEVIDO') OR "payee_user_id" IS NOT NULL
               OR "adjustments_cents" <> 0 OR "allocation_revision" <> 1
               OR "allocation_mode" <> 'MANUAL' OR "kind" = 'TENTATIVA_FRUSTRADA'
               OR ("status" = 'CANCELADO' AND "cancelled_at" IS NULL))
       + (SELECT count(*) FROM "logistics_cost_participants")
       + (SELECT count(*) FROM "logistics_cost_adjustments")
       + (SELECT count(*) FROM "payable_payment_reversals")
       + (SELECT count(*) FROM "logistics_cost_allocations" WHERE "revision" <> 1)
       + (SELECT count(*) FROM "company_settings"
            WHERE "default_pickup_cost_cents" IS NOT NULL OR "default_delivery_cost_cents" IS NOT NULL
               OR "logistics_payee_user_id" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 6. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TRIGGER IF EXISTS "logistics_cost_adjustments_immutable" ON "logistics_cost_adjustments";
DROP TRIGGER IF EXISTS "payable_payment_reversals_immutable" ON "payable_payment_reversals";
DROP TABLE IF EXISTS "payable_payment_reversals";
DROP TABLE IF EXISTS "logistics_cost_adjustments";
DROP TABLE IF EXISTS "logistics_cost_participants";
ALTER TABLE "logistics_costs" DROP CONSTRAINT IF EXISTS "logistics_costs_phase6";
ALTER TABLE "logistics_costs" DROP CONSTRAINT IF EXISTS "logistics_costs_kind";
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_kind" CHECK (
  "amount_cents" > 0
  AND "kind" IN ('RETIRADA', 'ENTREGA', 'INSTALACAO', 'TRANSPORTE_TERCEIRIZADO', 'DESLOCAMENTO')
  AND "split_method" IN ('IGUAL', 'POR_PECA', 'MANUAL'));
ALTER TABLE "logistics_costs" DROP CONSTRAINT IF EXISTS "logistics_costs_payee_user_id_fkey";
DROP INDEX IF EXISTS "logistics_costs_payee_user_id_due_at_idx";
ALTER TABLE "logistics_costs"
  DROP COLUMN IF EXISTS "adjustments_cents",
  DROP COLUMN IF EXISTS "allocation_mode",
  DROP COLUMN IF EXISTS "allocation_revision",
  DROP COLUMN IF EXISTS "due_at",
  DROP COLUMN IF EXISTS "payee_user_id",
  DROP COLUMN IF EXISTS "pending_reason",
  DROP COLUMN IF EXISTS "status";
ALTER TABLE "logistics_cost_allocations" DROP CONSTRAINT IF EXISTS "logistics_cost_allocations_revision";
DROP INDEX IF EXISTS "logistics_cost_allocations_logistics_cost_id_revision_servi_key";
ALTER TABLE "logistics_cost_allocations" DROP COLUMN IF EXISTS "revision";
CREATE UNIQUE INDEX "logistics_cost_allocations_logistics_cost_id_service_order__key"
  ON "logistics_cost_allocations"("logistics_cost_id", "service_order_id");
ALTER TABLE "company_settings" DROP CONSTRAINT IF EXISTS "company_settings_logistics_defaults";
ALTER TABLE "company_settings" DROP CONSTRAINT IF EXISTS "company_settings_logistics_payee_user_id_fkey";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "default_delivery_cost_cents",
  DROP COLUMN IF EXISTS "default_pickup_cost_cents",
  DROP COLUMN IF EXISTS "logistics_payee_user_id";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261108000000_custos_logistica';
COMMIT;
