-- Reversão de 20270823000000_orcamento_retirada. Apaga só o dia de retirada que o cliente escolheu
-- no link da proposta (as retiradas já agendadas no pedido continuam).
BEGIN;
ALTER TABLE "quotes" DROP COLUMN IF EXISTS "pickup_date";
ALTER TABLE "quotes" DROP COLUMN IF EXISTS "pickup_shift";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270823000000_orcamento_retirada';
COMMIT;
