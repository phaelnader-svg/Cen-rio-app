-- Jogo de gestão: propostas dos agentes podem ficar OBSOLETAS quando os dados mudam
-- (ex.: "Planejar OS" de uma OS já planejada). A regra CHECK é recriada com a mesma condição
-- e um status a mais; nenhuma linha é alterada nem apagada.
ALTER TABLE "ai_agent_proposals" DROP CONSTRAINT "ai_agent_proposals_status";
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_status" CHECK (
  "status" IN ('PENDENTE', 'APROVADA', 'REJEITADA', 'EXECUTADA_TESTE', 'OBSOLETA')
  AND ("status" = 'PENDENTE') = ("decided_at" IS NULL));
