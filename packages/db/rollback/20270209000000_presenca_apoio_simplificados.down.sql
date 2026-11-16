-- REVERSÃO MANUAL da migration 20270209000000_presenca_apoio_simplificados (Simplificação Fase 7).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se já existe feriado, folga/
-- férias por intervalo (e seu histórico), expediente encerrado sem horário ou pedido de
-- reprogramação feito pelo funcionário, apoio prolongado ou transferência — nesse caso, recupere pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "company_holidays")
       + (SELECT count(*) FROM "attendance_leaves")
       + (SELECT count(*) FROM "attendance_leave_events")
       + (SELECT count(*) FROM "operational_attendances" WHERE "departure_unrecorded_at" IS NOT NULL)
       + (SELECT count(*) FROM "reschedule_proposals"
           WHERE "requested_by_id" IS NOT NULL OR "kind" IN ('TRANSFERENCIA', 'APOIO_PROLONGADO'))
       + (SELECT count(*) FROM "help_requests" WHERE "kind" = 'APOIO_PROLONGADO')
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) de presença/apoio simplificados (feriado, folga/férias, encerramento sem horário, apoio prolongado, transferência ou pedido de reprogramação). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
-- Regras ampliadas voltam às definições de 20261013000000_ajuda_reprogramacao.
ALTER TABLE "operational_attendances" DROP CONSTRAINT "operational_attendances_departure_unrecorded";
ALTER TABLE "reschedule_proposals" DROP CONSTRAINT "reschedule_proposals_kind";
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_kind" CHECK ("kind" IN ('AUSENCIA', 'BLOQUEIO', 'AJUDA_URGENTE', 'CONFLITO'));
ALTER TABLE "help_requests" DROP CONSTRAINT "help_requests_minutes_range";
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_minutes_range" CHECK ("estimated_minutes" BETWEEN 5 AND 240);
ALTER TABLE "help_requests" DROP CONSTRAINT "help_requests_kind";
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_kind" CHECK ("kind" IN ('PARAFUSAR', 'MOVIMENTAR', 'AUXILIAR_MONTAGEM', 'POSICIONAR', 'OUTRO'));
DROP TABLE "attendance_leave_events";
DROP TABLE "attendance_leaves";
DROP TABLE "company_holidays";
ALTER TABLE "reschedule_proposals" DROP CONSTRAINT "reschedule_proposals_requested_by_id_fkey";
ALTER TABLE "reschedule_proposals" DROP COLUMN "requested_by_id";
ALTER TABLE "operational_attendances" DROP COLUMN "departure_unrecorded_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270209000000_presenca_apoio_simplificados';
COMMIT;
