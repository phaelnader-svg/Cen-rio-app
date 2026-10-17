-- R1 (DEC-9): quem recebe por produção vê os próprios ganhos no tablet (com PIN).
-- Aditiva e idempotente: só concede `financeiro.producao_propria` às funções do sistema
-- tapeceiro e logística terceirizada. Nenhuma permissão financeira geral; nenhum dado de valor
-- é lido ou alterado.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'financeiro.producao_propria'
FROM "roles" r
WHERE r."key" IN ('tapeceiro', 'logistica_terceirizada')
ON CONFLICT DO NOTHING;
