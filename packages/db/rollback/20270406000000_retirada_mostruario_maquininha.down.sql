-- REVERSÃO MANUAL da migration 20270406000000_retirada_mostruario_maquininha (aplicação parada, com backup).
-- Remove as marcações "levar mostruário" e "levar maquininha" das retiradas.
-- SEGURANÇA: aborta (sem alterar nada) se alguma retirada tem mostruário ou maquininha marcados —
-- a versão anterior não tem onde guardar essa informação e ela se perderia.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "pickup_requests"
   WHERE "bring_samples" OR "bring_card_machine" OR "samples_description" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % retirada(s) com mostruário ou maquininha marcados.', n;
  END IF;
END $$;
ALTER TABLE "pickup_requests"
    DROP COLUMN "bring_samples",
    DROP COLUMN "samples_description",
    DROP COLUMN "bring_card_machine";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270406000000_retirada_mostruario_maquininha';
COMMIT;
