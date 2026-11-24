-- O que a tela inicial de cada aparelho mostra (2026-11-24, pedido do Raphael): ex.: o celular do
-- Thiago só com entregas e retiradas e o tablet dele só com a produção. Só acrescenta um tipo e
-- uma coluna com padrão "TUDO" (todos os aparelhos continuam exatamente como estão). Reversão em
-- packages/db/rollback/20270902000000_aparelho_mostra.down.sql.
CREATE TYPE "device_shows" AS ENUM ('TUDO', 'PRODUCAO', 'LOGISTICA');
ALTER TABLE "devices" ADD COLUMN "shows" "device_shows" NOT NULL DEFAULT 'TUDO';
