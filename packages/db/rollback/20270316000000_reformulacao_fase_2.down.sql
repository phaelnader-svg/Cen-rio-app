-- REVERSÃO MANUAL da migration 20270316000000_reformulacao_fase_2 (Reformulação, Fase 2).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior. SEGURANÇA:
-- aborta (sem alterar nada) se existe QUALQUER dado da Fase 2 — foto já tratada, material padrão
-- de modelo ou linha sugerida numa OS —, porque a reversão o apagaria. Nesse caso, NÃO
-- reverta o banco: volte só a aplicação para a versão de retorno que conhece esta migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "stored_files" WHERE "processed_at" IS NOT NULL)
       + (SELECT count(*) FROM "service_model_materials")
       + (SELECT count(*) FROM "service_order_materials" WHERE "source_model_material_id" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 2 (fotos tratadas, materiais padrão ou sugestões aplicadas). Use o rollback não destrutivo da aplicação.', n;
  END IF;
END $$;
DROP INDEX "service_order_materials_source_model_material_id_idx";
ALTER TABLE "service_order_materials" DROP CONSTRAINT "service_order_materials_source_model_material_id_fkey";
ALTER TABLE "service_order_materials" DROP COLUMN "source_model_material_id";
DROP TABLE "service_model_materials";
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_processed";
DROP INDEX "stored_files_thumb_key_key";
ALTER TABLE "stored_files" DROP COLUMN "original_size_bytes";
ALTER TABLE "stored_files" DROP COLUMN "thumb_size_bytes";
ALTER TABLE "stored_files" DROP COLUMN "thumb_key";
ALTER TABLE "stored_files" DROP COLUMN "height";
ALTER TABLE "stored_files" DROP COLUMN "width";
ALTER TABLE "stored_files" DROP COLUMN "processed_at";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270316000000_reformulacao_fase_2';
COMMIT;
