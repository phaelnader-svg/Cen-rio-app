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

-- ============================================================ modelos de serviço: materiais padrão
-- Lista padrão de materiais por tipo de peça e (opcionalmente) tipo de serviço. É só SUGESTÃO: ao
-- ser aplicada numa OS vira linhas da lista simples (service_order_materials) sem custo, não
-- compradas e não disponíveis — nada aqui cria compra, despesa, custo realizado ou movimento de
-- estoque. service_type NULL = vale para qualquer serviço daquele tipo de peça.
CREATE TABLE "service_model_materials" (
  "id" UUID NOT NULL,
  "piece_type" "piece_type" NOT NULL,
  "service_type" "service_type",
  "description" VARCHAR(200) NOT NULL,
  "category_id" UUID,
  "inventory_item_id" UUID,
  "quantity" DECIMAL(12,3),
  "unit" VARCHAR(20),
  "notes" VARCHAR(500),
  "position" INTEGER NOT NULL DEFAULT 0,
  "archived_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "service_model_materials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "service_model_materials_quantity" CHECK ("quantity" IS NULL OR "quantity" > 0),
  CONSTRAINT "service_model_materials_description" CHECK (length(btrim("description")) >= 2)
);
CREATE INDEX "service_model_materials_piece_type_service_type_idx"
  ON "service_model_materials"("piece_type", "service_type");
ALTER TABLE "service_model_materials" ADD CONSTRAINT "service_model_materials_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_model_materials" ADD CONSTRAINT "service_model_materials_inventory_item_id_fkey"
  FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_model_materials" ADD CONSTRAINT "service_model_materials_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_model_materials" ADD CONSTRAINT "service_model_materials_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Origem da linha da lista simples quando veio de uma sugestão do modelo (evita sugerir de novo
-- o mesmo material e deixa claro, no histórico, de onde a linha veio). NULL = lançada à mão.
ALTER TABLE "service_order_materials" ADD COLUMN "source_model_material_id" UUID;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_source_model_material_id_fkey"
  FOREIGN KEY ("source_model_material_id") REFERENCES "service_model_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "service_order_materials_source_model_material_id_idx"
  ON "service_order_materials"("source_model_material_id");
