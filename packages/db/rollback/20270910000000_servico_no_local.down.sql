-- Reversão de 20270910000000_servico_no_local: tira a coluna "kind" das retiradas e o tipo novo.
-- Agendamentos "No local" voltam a aparecer como retirada comum (nenhuma retirada é apagada).
BEGIN;
ALTER TABLE "pickup_requests" DROP COLUMN IF EXISTS "kind";
DROP TYPE IF EXISTS "pickup_kind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270910000000_servico_no_local';
COMMIT;
