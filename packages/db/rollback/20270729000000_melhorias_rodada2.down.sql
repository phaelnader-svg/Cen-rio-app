-- Reversão de 20270729000000_melhorias_rodada2. Apaga as sugestões enviadas, os avisos de
-- manutenção e as amostras da página de status; os orçamentos perdem a situação e o aceite;
-- a verificação em duas etapas e o acesso de suporte deixam de existir.
BEGIN;
DROP TABLE IF EXISTS "feedback_reports";
DROP TABLE IF EXISTS "system_notices";
DROP TABLE IF EXISTS "status_samples";
-- Usuários temporários do suporte: desativados (não são apagados, por causa da auditoria).
UPDATE "users" SET "active" = false WHERE "support_agent" = true;
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "support_agent",
  DROP COLUMN IF EXISTS "totp_enabled_at",
  DROP COLUMN IF EXISTS "totp_recovery_hashes",
  DROP COLUMN IF EXISTS "totp_secret";
ALTER TABLE "quotes"
  DROP COLUMN IF EXISTS "approved_at",
  DROP COLUMN IF EXISTS "approved_via",
  DROP COLUMN IF EXISTS "follow_up_at",
  DROP COLUMN IF EXISTS "link_viewed_at",
  DROP COLUMN IF EXISTS "lost_reason",
  DROP COLUMN IF EXISTS "order_id",
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "status_changed_at";
ALTER TABLE "pickup_requests" DROP COLUMN IF EXISTS "customer_scheduled_at";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "cancel_reason",
  DROP COLUMN IF EXISTS "canceled_at",
  DROP COLUMN IF EXISTS "is_demo",
  DROP COLUMN IF EXISTS "paused_until",
  DROP COLUMN IF EXISTS "support_access_until";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270729000000_melhorias_rodada2';
COMMIT;
