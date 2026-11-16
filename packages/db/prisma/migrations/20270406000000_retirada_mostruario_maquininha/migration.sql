-- Agenda de Retiradas: o que levar no compromisso com o cliente.
-- Aditiva: três colunas novas em pickup_requests, com padrão; nada é alterado nem apagado.
ALTER TABLE "pickup_requests"
    ADD COLUMN "bring_samples" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "samples_description" VARCHAR(200),
    ADD COLUMN "bring_card_machine" BOOLEAN NOT NULL DEFAULT false;
