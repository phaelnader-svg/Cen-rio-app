-- Remediação pós-auditoria, Rodada 2 (F10-19): notificação persistida ATIVA × RESOLVIDA.
-- Aditiva: coluna anulável, sem DEFAULT e sem backfill. Notificações anteriores ficam com
-- resolved_at NULL (= ativas, exatamente como eram mostradas antes); nenhum histórico é inventado.
ALTER TABLE "notifications" ADD COLUMN "resolved_at" TIMESTAMPTZ(3);
