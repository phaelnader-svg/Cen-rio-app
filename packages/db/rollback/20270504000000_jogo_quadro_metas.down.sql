-- REVERSÃO MANUAL da migration 20270504000000_jogo_quadro_metas (aplicação parada, com backup).
-- Remove o Quadro de Metas: saldos iniciais, lançamentos manuais, metas, conquistas e fechamentos
-- semanais. Recebimentos e pagamentos oficiais do financeiro NÃO são afetados.
BEGIN;
DROP TABLE IF EXISTS "cash_week_closings", "cash_goal_achievements", "cash_goals", "cash_entries", "cash_snapshots";
DROP INDEX IF EXISTS "bank_accounts_one_cash_default";
ALTER TABLE "bank_accounts" DROP CONSTRAINT IF EXISTS "bank_accounts_cash_source";
ALTER TABLE "bank_accounts" DROP COLUMN IF EXISTS "included_in_cash", DROP COLUMN IF EXISTS "cash_source", DROP COLUMN IF EXISTS "cash_default";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270504000000_jogo_quadro_metas';
COMMIT;
