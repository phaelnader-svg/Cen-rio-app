-- Reversão de 20270914000000_etapa3 (só o que a migration acrescentou).
-- Apaga a tabela do padrão da casa e as colunas novas (lucro mínimo, cuidados, avaliação, chuva).
BEGIN;
DROP TABLE IF EXISTS "house_standards";
ALTER TABLE "quote_settings" DROP COLUMN IF EXISTS "care_texts", DROP COLUMN IF EXISTS "min_profit_bps";
ALTER TABLE "deliveries"
  DROP COLUMN IF EXISTS "rated_at",
  DROP COLUMN IF EXISTS "rating_comment",
  DROP COLUMN IF EXISTS "rating_stars";
ALTER TABLE "company_settings"
  DROP COLUMN IF EXISTS "rain_notice_for",
  DROP COLUMN IF EXISTS "weather_lat",
  DROP COLUMN IF EXISTS "weather_lon",
  DROP COLUMN IF EXISTS "weather_place";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270914000000_etapa3';
COMMIT;
