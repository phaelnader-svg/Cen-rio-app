-- REVERSÃO MANUAL da migration 20261129000000_novo_servico (Simplificação, Fase 2).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (5cf5e03).
-- SEGURANÇA: só é permitida enquanto NENHUM pedido tiver sido criado pelo fluxo "Novo serviço"
-- e nenhuma OS tiver sido gerada automaticamente. Havendo qualquer um, aborta ANTES de qualquer
-- alteração (perderia o vínculo OS ↔ recebimento e as especificações do fechamento): recupere
-- pelo backup anterior à migration. O responsável padrão da equipe própria é apenas configuração.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "commercial_orders" WHERE "auto_service_order")
       + (SELECT count(*) FROM "service_orders" WHERE "source_receipt_id" IS NOT NULL)
       + (SELECT count(*) FROM "commercial_order_items"
           WHERE "service_type" IS NOT NULL OR "fabric_name" IS NOT NULL
              OR "fabric_color" IS NOT NULL OR "fabric_reference" IS NOT NULL
              OR "technical_notes" IS NOT NULL)
       + (SELECT count(*) FROM "commercial_orders"
           WHERE "promised_date" IS NOT NULL OR "technical_notes" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) do Novo serviço. Restaure o backup anterior à migration.', n;
  END IF;
END $$;
DROP TRIGGER IF EXISTS cenario_service_order_source_receipt ON "service_orders";
DROP FUNCTION IF EXISTS cenario_service_order_source_receipt_check();
ALTER TABLE "service_orders" DROP CONSTRAINT IF EXISTS "service_orders_source_receipt_id_fkey";
DROP INDEX IF EXISTS "service_orders_source_receipt_id_key";
ALTER TABLE "service_orders" DROP COLUMN IF EXISTS "source_receipt_id";
ALTER TABLE "company_settings" DROP CONSTRAINT IF EXISTS "company_settings_own_team_default_user_id_fkey";
ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "own_team_default_user_id";
ALTER TABLE "commercial_order_items" DROP COLUMN IF EXISTS "service_type",
  DROP COLUMN IF EXISTS "fabric_name", DROP COLUMN IF EXISTS "fabric_color",
  DROP COLUMN IF EXISTS "fabric_reference", DROP COLUMN IF EXISTS "technical_notes";
ALTER TABLE "commercial_orders" DROP COLUMN IF EXISTS "auto_service_order",
  DROP COLUMN IF EXISTS "promised_date", DROP COLUMN IF EXISTS "technical_notes";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129000000_novo_servico';
COMMIT;
