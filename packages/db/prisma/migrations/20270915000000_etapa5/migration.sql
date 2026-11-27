-- Etapa 5 da lista de 53 (item 34): teste de 7 dias do Firma Viva para quem assina o plano de R$ 399.
-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "game_trial_ends_at" TIMESTAMPTZ(3);
