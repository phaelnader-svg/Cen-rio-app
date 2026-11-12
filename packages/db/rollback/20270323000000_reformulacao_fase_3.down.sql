-- REVERSÃO MANUAL da migration 20270323000000_reformulacao_fase_3 (Reformulação, Fase 3).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior. SEGURANÇA:
-- aborta (sem alterar nada) se existe QUALQUER dado da Fase 3 — autoaprovação justificada do
-- gestor (perderia a justificativa), peça aprovada sem embalagem (o código anterior voltaria a
-- exigir uma embalagem que nunca foi criada) ou entrega direta desfeita (o código anterior a
-- trataria como entregue de novo) —, porque a reversão o apagaria ou o tornaria
-- inconsistente. Nesse caso, NÃO reverta o banco: volte só a aplicação para a versão de retorno.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "quality_inspections" WHERE "self_approval_reason" IS NOT NULL)
       + (SELECT count(*) FROM "quality_inspections" WHERE NOT "packaging_required")
       + (SELECT count(*) FROM "deliveries" WHERE "reverted_at" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 3 (autoaprovação justificada, aprovação sem embalagem ou entrega direta desfeita). Use o rollback não destrutivo da aplicação.', n;
  END IF;
END $$;
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_revert";
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_reverted_by_id_fkey";
ALTER TABLE "deliveries" DROP COLUMN "revert_reason";
ALTER TABLE "deliveries" DROP COLUMN "reverted_by_id";
ALTER TABLE "deliveries" DROP COLUMN "reverted_at";
ALTER TABLE "quality_inspections" DROP COLUMN "packaging_required";
ALTER TABLE "quality_inspections" DROP CONSTRAINT "quality_inspections_self_approval";
ALTER TABLE "quality_inspections" DROP COLUMN "self_approval_reason";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270323000000_reformulacao_fase_3';
COMMIT;
