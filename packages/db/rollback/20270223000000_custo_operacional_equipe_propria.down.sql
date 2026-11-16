-- REVERSÃO MANUAL da migration 20270223000000_custo_operacional_equipe_propria (Remediação
-- pós-auditoria, Rodada 3 — F2-18/F2-11). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se existe custo operacional
-- da equipe própria ainda ativo (a regra anterior não o aceita e ele não pode ser convertido em
-- custo com recebedor) — nesse caso, recupere pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "logistics_costs" WHERE "status" = 'OPERACIONAL';
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % custo(s) operacional(is) da equipe própria. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
ALTER TABLE "logistics_costs" DROP CONSTRAINT "logistics_costs_phase6";
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_phase6" CHECK (
  "status" IN ('LANCADO', 'PREVISTO', 'DEVIDO', 'CANCELADO')
  AND ("status" = 'CANCELADO') = ("cancelled_at" IS NOT NULL)
  AND "allocation_mode" IN ('MANUAL', 'AUTO', 'ESCOLHIDA')
  AND "allocation_revision" >= 0
  AND "amount_cents" + "adjustments_cents" > 0
  AND ("status" <> 'DEVIDO' OR "due_at" IS NOT NULL));
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270223000000_custo_operacional_equipe_propria';
COMMIT;
