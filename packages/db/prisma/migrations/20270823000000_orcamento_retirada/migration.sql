-- Cliente escolhe o dia da retirada no link da proposta (2026-11-18, revisão geral item 10).
-- Só acrescenta duas colunas opcionais; nenhum dado existente muda. Reversão em
-- packages/db/rollback/20270823000000_orcamento_retirada.down.sql.
ALTER TABLE "quotes" ADD COLUMN "pickup_date" DATE;
ALTER TABLE "quotes" ADD COLUMN "pickup_shift" VARCHAR(10);
