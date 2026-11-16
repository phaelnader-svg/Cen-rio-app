-- REVERSÃO MANUAL da migration 20270216000000_notificacoes_resolvidas (Remediação pós-auditoria,
-- Rodada 2 — F10-19). Uso somente com backup recente e a aplicação PARADA, voltando ao código
-- anterior. SEGURANÇA: aborta (sem alterar nada) se alguma notificação já foi resolvida (a data
-- da resolução se perderia e o aviso voltaria a parecer pendente) — nesse caso, recupere pelo
-- backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "notifications" WHERE "resolved_at" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % notificação(ões) resolvida(s). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "resolved_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270216000000_notificacoes_resolvidas';
COMMIT;
