-- REVERSÃO MANUAL da migration 20261206000000_recebimentos_compartilhados (Simplificação, Fase 3).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (4dcc8ed).
-- SEGURANÇA: só é permitida enquanto NÃO existir participante operacional, chegada física de
-- material ou recebimento com dispositivo registrado. Havendo qualquer um, aborta ANTES de
-- qualquer alteração (perderia quem participou da viagem, chegadas aguardando conferência ou o
-- tablet que confirmou): recupere pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "logistics_trip_participants")
       + (SELECT count(*) FROM "material_arrivals")
       + (SELECT count(*) FROM "receipts" WHERE "device_id" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) dos recebimentos compartilhados. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TABLE IF EXISTS "material_arrivals";
DROP TABLE IF EXISTS "logistics_trip_participants";
ALTER TABLE "receipts" DROP CONSTRAINT IF EXISTS "receipts_device_id_fkey";
ALTER TABLE "receipts" DROP COLUMN IF EXISTS "device_id";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261206000000_recebimentos_compartilhados';
COMMIT;
