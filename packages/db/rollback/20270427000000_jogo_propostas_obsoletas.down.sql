BEGIN;
-- REVERSÃO MANUAL da migration 20270427000000_jogo_propostas_obsoletas (aplicação parada, com backup).
-- Reversão: propostas obsoletas voltam a ser registradas como rejeitadas (com o motivo já gravado)
-- e a regra CHECK retorna aos quatro status originais.
UPDATE "ai_agent_proposals" SET "status" = 'REJEITADA' WHERE "status" = 'OBSOLETA';
ALTER TABLE "ai_agent_proposals" DROP CONSTRAINT "ai_agent_proposals_status";
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_status" CHECK (
  "status" IN ('PENDENTE', 'APROVADA', 'REJEITADA', 'EXECUTADA_TESTE')
  AND ("status" = 'PENDENTE') = ("decided_at" IS NULL));
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270427000000_jogo_propostas_obsoletas';
COMMIT;
