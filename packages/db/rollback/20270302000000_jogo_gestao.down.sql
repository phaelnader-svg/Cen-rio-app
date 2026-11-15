-- REVERSÃO MANUAL da migration 20270302000000_jogo_gestao (jogo de gestão). Uso somente com
-- backup recente e a aplicação PARADA, voltando ao código anterior. Remove apenas as tabelas do
-- jogo; nenhum dado operacional (OS, tarefas, estoque, compras) é tocado. A localização textual
-- gravada em stock_items.location pelo jogo permanece (é campo do cadastro oficial).
BEGIN;
DROP TABLE IF EXISTS "ai_agent_proposals";
DROP TABLE IF EXISTS "ai_agent_messages";
DROP TABLE IF EXISTS "ai_agents";
DROP TABLE IF EXISTS "game_layout_revisions";
DROP TABLE IF EXISTS "game_slot_materials";
DROP TABLE IF EXISTS "game_storage_slots";
DROP TABLE IF EXISTS "game_storage_units";
DROP TABLE IF EXISTS "game_station_assignees";
DROP TABLE IF EXISTS "game_stations";
DROP TABLE IF EXISTS "game_areas";
DROP TABLE IF EXISTS "game_spaces";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270302000000_jogo_gestao';
COMMIT;
