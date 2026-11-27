-- Fluxo da OS (2026-11-18): o fechamento do serviço cria só o pedido e a retirada; a OS é gerada à
-- mão depois que a peça chega, e só entra na programação da semana depois de "Material comprado".
-- Só acrescenta colunas. As OS que já existem contam como "material comprado" (data = criação),
-- para nada sair da programação atual. Reversão em
-- packages/db/rollback/20270808000000_os_material_comprado.down.sql.

-- AlterTable
ALTER TABLE "service_orders" ADD COLUMN     "material_purchased_at" TIMESTAMPTZ(3),
ADD COLUMN     "material_purchased_by_id" UUID;

-- AddForeignKey
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_material_purchased_by_id_fkey" FOREIGN KEY ("material_purchased_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- OS existentes: material considerado comprado.
UPDATE "service_orders" SET "material_purchased_at" = "created_at" WHERE "material_purchased_at" IS NULL;
