-- Reformulação, Fase 2 — somente aditiva (nenhuma linha existente muda).

-- ============================================================ fotos tratadas
-- Fotos novas são gravadas já orientadas, sem metadados (EXIF/GPS) e reduzidas, com miniatura.
-- processed_at NULL = arquivo anterior à Fase 2 (servido sem metadados pela rota comum, sem
-- regravar o original). A miniatura fica num arquivo próprio do armazenamento (thumb_key).
ALTER TABLE "stored_files" ADD COLUMN "processed_at" TIMESTAMPTZ(3);
ALTER TABLE "stored_files" ADD COLUMN "width" INTEGER;
ALTER TABLE "stored_files" ADD COLUMN "height" INTEGER;
ALTER TABLE "stored_files" ADD COLUMN "thumb_key" VARCHAR(200);
ALTER TABLE "stored_files" ADD COLUMN "thumb_size_bytes" INTEGER;
ALTER TABLE "stored_files" ADD COLUMN "original_size_bytes" INTEGER;
CREATE UNIQUE INDEX "stored_files_thumb_key_key" ON "stored_files"("thumb_key");
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_processed" CHECK (
  ("processed_at" IS NULL AND "width" IS NULL AND "height" IS NULL AND "thumb_key" IS NULL
     AND "thumb_size_bytes" IS NULL AND "original_size_bytes" IS NULL)
  OR ("processed_at" IS NOT NULL AND "width" > 0 AND "height" > 0 AND "original_size_bytes" >= 0
     AND ("thumb_key" IS NULL) = ("thumb_size_bytes" IS NULL)));
