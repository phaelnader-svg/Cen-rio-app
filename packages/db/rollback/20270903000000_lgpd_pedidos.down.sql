-- Reversão de 20270903000000_lgpd_pedidos. Tira a tabela de pedidos sobre dados pessoais.
-- ATENÇÃO: os pedidos registrados depois da publicação somem junto (copie antes, se houver).
BEGIN;
DROP TABLE IF EXISTS "privacy_requests";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270903000000_lgpd_pedidos';
COMMIT;
