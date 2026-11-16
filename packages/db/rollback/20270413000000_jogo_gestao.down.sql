-- REVERSÃO MANUAL da migration 20270413000000_jogo_gestao (jogo de gestão). Uso somente com
-- backup recente e a aplicação PARADA, voltando ao código anterior. Remove apenas as tabelas do
-- jogo (com suas chaves e gatilhos); nenhum dado operacional (OS, tarefas, estoque, compras) é
-- tocado. A planta desenhada no jogo se perde (refaça-a no jogo depois de reaplicar).
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
-- Permissões do jogo deixam de existir no código anterior; remova-as das funções.
DELETE FROM "role_permissions" WHERE "permission" IN ('jogo.acessar', 'jogo.construir', 'agentes.usar', 'agentes.gerenciar');
DELETE FROM "user_permissions" WHERE "permission" IN ('jogo.acessar', 'jogo.construir', 'agentes.usar', 'agentes.gerenciar');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270413000000_jogo_gestao';
COMMIT;
