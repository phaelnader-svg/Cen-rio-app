-- Reversão de 20270808000000_os_material_comprado. Perde só a marca "Material comprado" das OS
-- (a programação volta a aceitar qualquer OS aberta, como antes).
BEGIN;
ALTER TABLE "service_orders" DROP CONSTRAINT IF EXISTS "service_orders_material_purchased_by_id_fkey";
ALTER TABLE "service_orders" DROP COLUMN IF EXISTS "material_purchased_at",
DROP COLUMN IF EXISTS "material_purchased_by_id";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270808000000_os_material_comprado';
COMMIT;
