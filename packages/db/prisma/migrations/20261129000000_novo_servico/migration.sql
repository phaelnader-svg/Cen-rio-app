-- Simplificação Fase 2 — "Novo serviço" (cliente + serviço fechado + retirada em um fluxo).
-- Somente ADITIVA: nenhuma linha existente é alterada; pedidos antigos continuam com
-- auto_service_order = false (comportamento anterior: OS criada manualmente).

-- Pedido = registro do serviço fechado antes da chegada das peças.
ALTER TABLE "commercial_orders" ADD COLUMN     "auto_service_order" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promised_date" DATE,
ADD COLUMN     "technical_notes" VARCHAR(4000);

-- Especificações conhecidas no fechamento (opcionais), copiadas para a OS gerada.
ALTER TABLE "commercial_order_items" ADD COLUMN     "fabric_color" VARCHAR(80),
ADD COLUMN     "fabric_name" VARCHAR(120),
ADD COLUMN     "fabric_reference" VARCHAR(80),
ADD COLUMN     "service_type" "service_type",
ADD COLUMN     "technical_notes" VARCHAR(2000);

-- Responsável padrão da retirada pela equipe própria (referência ao usuário real).
ALTER TABLE "company_settings" ADD COLUMN     "own_team_default_user_id" UUID;
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_own_team_default_user_id_fkey" FOREIGN KEY ("own_team_default_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- OS gerada automaticamente: no máximo UMA por recebimento (idempotência no banco).
ALTER TABLE "service_orders" ADD COLUMN     "source_receipt_id" UUID;
CREATE UNIQUE INDEX "service_orders_source_receipt_id_key" ON "service_orders"("source_receipt_id");
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_source_receipt_id_fkey" FOREIGN KEY ("source_receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A OS gerada pertence ao MESMO pedido do recebimento (vínculo verificado no banco).
CREATE OR REPLACE FUNCTION cenario_service_order_source_receipt_check() RETURNS trigger AS $$
BEGIN
  IF NEW.source_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM receipts r WHERE r.id = NEW.source_receipt_id AND r.order_id = NEW.order_id
  ) THEN
    RAISE EXCEPTION 'OS gerada por recebimento de outro pedido.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.source_receipt_id IS DISTINCT FROM OLD.source_receipt_id THEN
    RAISE EXCEPTION 'O recebimento de origem da OS não pode ser alterado.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cenario_service_order_source_receipt
  BEFORE INSERT OR UPDATE OF source_receipt_id, order_id ON "service_orders"
  FOR EACH ROW EXECUTE FUNCTION cenario_service_order_source_receipt_check();
