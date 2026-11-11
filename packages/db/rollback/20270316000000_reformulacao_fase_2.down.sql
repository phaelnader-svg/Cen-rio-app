-- REVERSÃO MANUAL da migration 20270316000000_reformulacao_fase_2 (Reformulação, Fase 2).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior. SEGURANÇA:
-- aborta (sem alterar nada) se existe QUALQUER dado da Fase 2 — foto já tratada (perderia a
-- referência da miniatura e as dimensões) —, porque a reversão o apagaria. Nesse caso, NÃO
-- reverta o banco: volte só a aplicação para a versão de retorno que conhece esta migration.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "stored_files" WHERE "processed_at" IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % registro(s) da Fase 2 (fotos tratadas). Use o rollback não destrutivo da aplicação.', n;
  END IF;
END $$;
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
