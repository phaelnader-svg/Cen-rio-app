-- Simplificação Fase 3 (estabilização): as funções da oficina confirmam a chegada de peças na
-- central compartilhada. A Fase 3 incluiu 'recebimentos.registrar' nas funções padrão
-- (shared/permissions.ts), mas o seed só preenche funções SEM permissões — instalações
-- existentes não a receberiam. Mesmo padrão das migrations anteriores (produção, presença):
-- concede às funções de sistema pela chave; idempotente; só dados (nenhuma tabela alterada).
-- O gestor já a possui desde 20261008100000_comercial_oficina.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'recebimentos.registrar'
FROM "roles" r
WHERE r."key" IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante')
ON CONFLICT DO NOTHING;
