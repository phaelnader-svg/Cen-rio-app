-- Correção global de interface, OS e logística: roteiro diário das retiradas e entregas.
-- ADITIVA: duas colunas anuláveis (posição no roteiro do dia). Nenhum dado existente é alterado:
-- registros antigos ficam sem posição (NULL) e aparecem ordenados pelo horário de chegada.
-- O horário de chegada combinado continua em window_start; window_end (janela antiga) é mantido
-- e não é convertido. O histórico de alterações da sequência fica no registro de auditoria.
ALTER TABLE "pickup_requests" ADD COLUMN "route_sequence" INTEGER;
ALTER TABLE "deliveries" ADD COLUMN "route_sequence" INTEGER;
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_route_sequence_positive" CHECK ("route_sequence" IS NULL OR "route_sequence" >= 1);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_route_sequence_positive" CHECK ("route_sequence" IS NULL OR "route_sequence" >= 1);
