-- Reversão de 20270901000000_preparacao_livre. A migration só mexe em dados (preparações não
-- iniciadas ficaram sem responsável, para o primeiro ajudante livre pegar). Não há como saber quem
-- era o responsável automático antigo, então a reversão só tira o registro: as preparações livres
-- continuam livres e o gestor pode entregar a alguém pela tela da OS, se a versão antiga voltar.
BEGIN;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270901000000_preparacao_livre';
COMMIT;
