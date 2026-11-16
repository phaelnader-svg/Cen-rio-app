-- Remediação pós-auditoria, Rodada 3 (F2-18/F2-11, decisão do proprietário): custo OPERACIONAL
-- da viagem feita pela equipe própria — custeio real da OS, nunca dívida com o funcionário (sem
-- recebedor, sem conta a pagar, fora do fechamento e de Meus Ganhos).
-- Aditiva: só amplia a lista de situações aceitas pela regra da Fase 6. Nenhuma linha é alterada;
-- as demais condições da regra continuam idênticas.
ALTER TABLE "logistics_costs" DROP CONSTRAINT "logistics_costs_phase6";
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_phase6" CHECK (
  "status" IN ('LANCADO', 'PREVISTO', 'DEVIDO', 'CANCELADO', 'OPERACIONAL')
  AND ("status" = 'CANCELADO') = ("cancelled_at" IS NOT NULL)
  AND "allocation_mode" IN ('MANUAL', 'AUTO', 'ESCOLHIDA')
  AND "allocation_revision" >= 0
  AND "amount_cents" + "adjustments_cents" > 0
  AND ("status" <> 'DEVIDO' OR "due_at" IS NOT NULL));
