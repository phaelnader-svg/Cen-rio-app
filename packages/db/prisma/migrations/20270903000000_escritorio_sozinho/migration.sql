-- Agentes do escritório trabalhando sozinhos (2026-11-25, pedido do Raphael). Só acrescenta
-- colunas com padrão neutro: nível de cada tarefa do agente (vazio = "pede aprovação", como hoje),
-- marca de decisão tomada pelo próprio agente, o "parar tudo" da empresa e o link de avaliação do
-- Google. Nada existente muda. Reversão em
-- packages/db/rollback/20270903000000_escritorio_sozinho.down.sql.
ALTER TABLE "ai_agents" ADD COLUMN "autonomy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ai_agent_proposals" ADD COLUMN "decided_by_agent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "company_settings" ADD COLUMN "agents_paused_at" TIMESTAMPTZ(3);
ALTER TABLE "company_settings" ADD COLUMN "google_review_url" VARCHAR(500);
