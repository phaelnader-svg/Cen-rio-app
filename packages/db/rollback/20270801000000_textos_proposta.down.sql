-- Reversão de 20270801000000_textos_proposta. Os textos editados voltam ao padrão do sistema
-- (as propostas já salvas guardam a própria cópia e não mudam).
BEGIN;
ALTER TABLE "quote_settings" DROP COLUMN IF EXISTS "proposal_title",
DROP COLUMN IF EXISTS "proposal_intro",
DROP COLUMN IF EXISTS "proposal_thanks";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270801000000_textos_proposta';
COMMIT;
