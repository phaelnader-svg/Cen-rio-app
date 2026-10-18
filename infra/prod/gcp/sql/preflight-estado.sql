-- PRÉ-VERIFICAÇÃO (somente leitura) — estado da tabela de migrations do Prisma, uma linha por registro:
--   <migration>|<checksum>|<concluída 0/1>|<revertida 0/1>|<passos>
-- Ordem: início de aplicação (a ordem em que o Prisma as aplicou). Só é executado quando a tabela
-- existe (o vm.sh confere antes; banco vazio = nenhuma aplicada). Lido por preflight_migracoes.py.
BEGIN TRANSACTION READ ONLY;
SET LOCAL TimeZone = 'UTC';
SELECT migration_name, coalesce(checksum, '-'), (finished_at IS NOT NULL)::int, (rolled_back_at IS NOT NULL)::int,
       applied_steps_count
FROM _prisma_migrations
ORDER BY started_at, migration_name COLLATE "C";
ROLLBACK;
