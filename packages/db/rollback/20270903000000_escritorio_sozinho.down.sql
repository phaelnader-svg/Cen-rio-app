-- Reversão de 20270903000000_escritorio_sozinho. Apaga os níveis das tarefas dos agentes (voltam
-- todos a pedir aprovação), a marca "feito pelo agente", o "parar tudo" e o link de avaliação.
BEGIN;
ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "autonomy";
ALTER TABLE "ai_agent_proposals" DROP COLUMN IF EXISTS "decided_by_agent";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "agents_paused_at";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "google_review_url";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270903000000_escritorio_sozinho';
COMMIT;
