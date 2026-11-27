-- Etapa 3 da lista de 53: lucro mínimo, cuidados com a peça, "Como ficou?", padrão da casa e aviso de chuva.
-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "rain_notice_for" DATE,
ADD COLUMN     "weather_lat" DOUBLE PRECISION,
ADD COLUMN     "weather_lon" DOUBLE PRECISION,
ADD COLUMN     "weather_place" VARCHAR(120);
-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "rated_at" TIMESTAMPTZ(3),
ADD COLUMN     "rating_comment" VARCHAR(500),
ADD COLUMN     "rating_stars" SMALLINT;
-- AlterTable
ALTER TABLE "quote_settings" ADD COLUMN     "care_texts" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "min_profit_bps" INTEGER;
-- CreateTable
CREATE TABLE "house_standards" (
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "activity" VARCHAR(30) NOT NULL,
    "text" VARCHAR(1500) NOT NULL DEFAULT '',
    "file_id" UUID,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "house_standards_pkey" PRIMARY KEY ("company_id","activity")
);
-- AddForeignKey
ALTER TABLE "house_standards" ADD CONSTRAINT "house_standards_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "house_standards" ADD CONSTRAINT "house_standards_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "house_standards" ADD CONSTRAINT "house_standards_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trava do banco (Row-Level Security) na tabela nova das empresas, igual às demais.
ALTER TABLE "house_standards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "house_standards" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "house_standards"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "house_standards" TO cenario_app;
