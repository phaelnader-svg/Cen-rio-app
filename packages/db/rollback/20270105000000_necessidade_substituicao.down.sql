-- REVERSÃO MANUAL da migration 20270105000000_necessidade_substituicao (Compras, Etapa 2).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. SEGURANÇA: aborta (sem alterar nada) se alguma necessidade já foi
-- substituída, cancelada ou fechada (status, predecessora e motivo se perderiam) — nesse caso,
-- recupere pelo backup anterior à migration. Necessidades ATIVAS sem predecessora voltam ao estado
-- anterior sem perda (o status ATIVA é o único valor que a versão anterior conhecia).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "material_requirements"
   WHERE "status" <> 'ATIVA' OR "replaces_requirement_id" IS NOT NULL OR "closed_at" IS NOT NULL
      OR "closed_by_id" IS NOT NULL OR "close_reason" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % necessidade(s) substituída(s), cancelada(s) ou fechada(s). Restaure o backup anterior à migration.', n;
  END IF;
END $$;
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_not_self_chk";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_closed_chk";
DROP INDEX "material_requirements_service_order_id_status_idx";
DROP INDEX "material_requirements_replaces_requirement_id_key";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_closed_by_id_fkey";
ALTER TABLE "material_requirements" DROP CONSTRAINT "material_requirements_replaces_requirement_id_fkey";
ALTER TABLE "material_requirements"
  DROP COLUMN "close_reason",
  DROP COLUMN "closed_by_id",
  DROP COLUMN "closed_at",
  DROP COLUMN "replaces_requirement_id",
  DROP COLUMN "status";
DROP TYPE "material_requirement_status";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270105000000_necessidade_substituicao';
COMMIT;
