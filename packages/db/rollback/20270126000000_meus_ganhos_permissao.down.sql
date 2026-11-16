-- REVERSÃO MANUAL da migration 20270126000000_meus_ganhos_permissao (R1 — Meus Ganhos).
-- Remediação pós-auditoria, Rodada 4 (F1-05). Uso somente com backup recente e a aplicação PARADA,
-- voltando ao código anterior. A migration só concedeu `financeiro.producao_propria` (permissão
-- que já existia desde a Fase 11, p.ex. na função Gestor) às funções do sistema tapeceiro e
-- logística terceirizada. A reversão remove exatamente essas duas concessões; nenhuma outra função
-- ou concessão individual é tocada. Não há dado de negócio envolvido.
-- Reversão INCONDICIONAL por desenho (como a 20261220000000_recebimentos_permissao_funcoes):
-- uma reconcessão manual às MESMAS duas funções é indistinguível da concessão da migration e
-- também é removida (é exatamente o efeito que a migration criou).
BEGIN;
DELETE FROM "role_permissions" p USING "roles" r
 WHERE r."id" = p."role_id" AND p."permission" = 'financeiro.producao_propria'
   AND r."key" IN ('tapeceiro', 'logistica_terceirizada');
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270126000000_meus_ganhos_permissao';
COMMIT;
