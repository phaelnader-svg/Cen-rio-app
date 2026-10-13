-- REVERSÃO MANUAL da migration 20261220000000_recebimentos_permissao_funcoes (estabilização da
-- Simplificação, Fase 3). Uso somente com backup recente e a aplicação PARADA.
-- Efeito: as funções Tapeceiro, Cabeceiras/qualidade e Ajudante deixam de confirmar chegadas no
-- tablet. ATENÇÃO: a tabela não distingue a concessão da migration de uma concessão manual feita
-- antes dela — se o gestor já tinha concedido a permissão a essas funções, ela também é removida
-- (conceda de novo em Funções e permissões). Nenhum outro dado é tocado.
BEGIN;
DELETE FROM "role_permissions"
 WHERE "permission" = 'recebimentos.registrar'
   AND "role_id" IN (SELECT "id" FROM "roles" WHERE "key" IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante'));
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261220000000_recebimentos_permissao_funcoes';
COMMIT;
