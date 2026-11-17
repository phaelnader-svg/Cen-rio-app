-- Melhoria 141 (2026-11-17): textos fixos da proposta editáveis na Base de dados do orçamento.
-- Só acrescenta colunas vazias (vazio = texto padrão do sistema). Reversão em
-- packages/db/rollback/20270801000000_textos_proposta.down.sql.

-- AlterTable
ALTER TABLE "quote_settings" ADD COLUMN     "proposal_title" VARCHAR(120),
ADD COLUMN     "proposal_intro" VARCHAR(400),
ADD COLUMN     "proposal_thanks" VARCHAR(600);
