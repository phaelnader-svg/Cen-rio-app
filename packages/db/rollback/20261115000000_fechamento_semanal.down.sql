-- REVERSÃO MANUAL da migration 20261115000000_fechamento_semanal (Evolução, Fase 7).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código da Fase 6 (05c0ae2).
-- SEGURANÇA: só é permitida enquanto NÃO existir nenhum dado da Fase 7 (conferência, evento,
-- pagamento em lote, estorno de pagamento por produção ou viagem gratuita confirmada). Havendo
-- qualquer um, aborta ANTES de qualquer alteração: recupere pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "weekly_closings") + (SELECT count(*) FROM "weekly_closing_events")
       + (SELECT count(*) FROM "closing_payments") + (SELECT count(*) FROM "closing_payment_parts")
       + (SELECT count(*) FROM "closing_payment_reversals")
       + (SELECT count(*) FROM "professional_payment_reversals")
       + (SELECT count(*) FROM "logistics_free_trips")
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 7. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TABLE IF EXISTS "closing_payment_reversals";
DROP TABLE IF EXISTS "closing_payment_parts";
DROP TABLE IF EXISTS "closing_payments";
DROP TABLE IF EXISTS "weekly_closing_events";
DROP TABLE IF EXISTS "weekly_closings";
DROP TABLE IF EXISTS "professional_payment_reversals";
DROP TABLE IF EXISTS "logistics_free_trips";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261115000000_fechamento_semanal';
COMMIT;
