-- REVERSÃO MANUAL da migration 20261227000000_servico_sem_retirada (estabilização da
-- Simplificação, Fase 2). Uso somente com backup recente e a aplicação PARADA, voltando ao
-- código anterior. SEGURANÇA: aborta se algum pedido já foi registrado como "cliente entrega"
-- (a informação se perderia e o pedido apareceria como aguardando retirada) — nesse caso,
-- recupere pelo backup anterior à migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "commercial_orders" WHERE "customer_drop_off";
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % pedido(s) com entrega pelo cliente. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
ALTER TABLE "commercial_orders" DROP COLUMN IF EXISTS "customer_drop_off";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261227000000_servico_sem_retirada';
COMMIT;
