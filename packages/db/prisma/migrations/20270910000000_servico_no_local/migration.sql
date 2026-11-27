-- 2026-11-25: agendamento "No local" (serviço feito na casa do cliente) ao lado da Retirada.
-- Aditiva: todas as retiradas existentes ficam como RETIRADA (padrão). Nenhum dado muda.

-- CreateEnum
CREATE TYPE "pickup_kind" AS ENUM ('RETIRADA', 'NO_LOCAL');

-- AlterTable
ALTER TABLE "pickup_requests" ADD COLUMN "kind" "pickup_kind" NOT NULL DEFAULT 'RETIRADA';
