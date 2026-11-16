-- REVERSÃO MANUAL da migration 20270406000000_retirada_mostruario_maquininha (aplicação parada, com backup).
-- Remove as marcações "levar mostruário" e "levar maquininha" das retiradas.
BEGIN;
ALTER TABLE "pickup_requests"
    DROP COLUMN IF EXISTS "bring_samples",
    DROP COLUMN IF EXISTS "samples_description",
    DROP COLUMN IF EXISTS "bring_card_machine";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270406000000_retirada_mostruario_maquininha';
COMMIT;
