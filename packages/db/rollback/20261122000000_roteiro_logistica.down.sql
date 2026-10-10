-- REVERSÃO MANUAL da migration 20261122000000_roteiro_logistica (correção global).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior.
-- Perde apenas a ordem manual das paradas (o histórico continua no registro de auditoria);
-- datas, horários de chegada e demais dados das retiradas e entregas não são tocados.
BEGIN;
ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "deliveries_route_sequence_positive";
ALTER TABLE "pickup_requests" DROP CONSTRAINT IF EXISTS "pickup_requests_route_sequence_positive";
ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "route_sequence";
ALTER TABLE "pickup_requests" DROP COLUMN IF EXISTS "route_sequence";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122000000_roteiro_logistica';
COMMIT;
