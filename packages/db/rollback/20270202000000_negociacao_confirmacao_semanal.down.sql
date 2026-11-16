-- REVERSÃO MANUAL da migration 20270202000000_negociacao_confirmacao_semanal (R2).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se já existe alguma solicitação
-- de alteração de valor ou confirmação semanal (histórico imutável que se perderia) — nesse caso,
-- recupere pelo backup anterior à migration. Sem registros, as duas tabelas são removidas.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "value_change_requests")
       + (SELECT count(*) FROM "weekly_closing_confirmations")
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % solicitação(ões) de valor/confirmação(ões) semanal(is). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TABLE "weekly_closing_confirmations";
DROP TABLE "value_change_requests";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270202000000_negociacao_confirmacao_semanal';
COMMIT;
