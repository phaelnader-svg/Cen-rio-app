-- Simplificação Fase 2 (estabilização): o cliente pode entregar as peças diretamente na
-- tapeçaria (Novo serviço sem retirada). Marca explícita no pedido — nunca inferida — para que a
-- situação "aguardando" diga "entrega do cliente" e não "retirada". Aditiva; pedidos existentes
-- ficam com false (comportamento anterior). Agendar uma retirada depois desmarca.
ALTER TABLE "commercial_orders" ADD COLUMN "customer_drop_off" BOOLEAN NOT NULL DEFAULT false;
