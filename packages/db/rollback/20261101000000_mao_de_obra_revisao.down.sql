-- REVERSÃO MANUAL da migration 20261101000000_mao_de_obra_revisao (Evolução, Fase 5).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código da Fase 4 (581e03e).
-- Remove apenas o que a migration criou. Perdem-se: revisões financeiras (abertas e
-- resolvidas) e o vínculo obrigação→revisão. Obrigações, ajustes e pagamentos gravados pelas
-- resoluções PERMANECEM (são linhas do financeiro existente) — confira-os antes de reverter.
BEGIN;
DROP TRIGGER IF EXISTS "labor_reviews_guard" ON "labor_reviews";
DROP FUNCTION IF EXISTS cenario_labor_review_guard();
DROP INDEX IF EXISTS "production_payables_one_live_per_piece_professional";
DROP INDEX IF EXISTS "production_payables_one_live_per_os_professional";
ALTER TABLE "production_payables" DROP CONSTRAINT IF EXISTS "production_payables_review_id_fkey";
ALTER TABLE "production_payables" DROP COLUMN IF EXISTS "review_id";
DROP TABLE IF EXISTS "labor_reviews";
-- Restaura a regra da Fase 11 (uma obrigação viva por peça/OS). Se alguma revisão resolvida
-- deixou dois profissionais na mesma peça, o índice falha e TODA a reversão é desfeita
-- (BEGIN/COMMIT): nesse caso, não reverter — decidir com o gestor antes.
CREATE UNIQUE INDEX "production_payables_item_active" ON "production_payables" ("service_order_item_id")
  WHERE "service_order_item_id" IS NOT NULL AND "status" <> 'CANCELADO';
CREATE UNIQUE INDEX "production_payables_order_active" ON "production_payables" ("service_order_id")
  WHERE "service_order_item_id" IS NULL AND "status" <> 'CANCELADO';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101000000_mao_de_obra_revisao';
COMMIT;
