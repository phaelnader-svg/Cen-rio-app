-- Impressão digital SOMENTE LEITURA do banco (Evolução — pré-deploy). Uma linha por item:
--   tabela|<nome>|<linhas>|<md5 do conteúdo inteiro, ordenado>
--   catalogo|gatilhos+indices+restricoes|<qtde>|<md5>
--   migracoes|aplicadas|<qtde>|<md5 dos nomes>   ·   migracoes|pendentes-ou-falhas|<qtde>|-
--   financeiro|<tabela.coluna>|<linhas>|<soma>     (todas as colunas *_cents)
-- Igualdade entre dois bancos = mesmo conteúdo, mesmos vínculos e os mesmos valores.
-- Uso: psql -At -F'|' -v ON_ERROR_STOP=1 -f impressao-digital.sql  (dentro de BEGIN READ ONLY)
BEGIN TRANSACTION READ ONLY;
SELECT 'tabela', t.tablename,
       (xpath('/row/n/text()', x))[1]::text,
       (xpath('/row/h/text()', x))[1]::text
FROM pg_tables t,
     LATERAL query_to_xml(format(
       'SELECT count(*) AS n, coalesce(md5(string_agg(r::text, ''/'' ORDER BY r::text)), ''-'') AS h FROM %I.%I r',
       t.schemaname, t.tablename), false, true, '') x
WHERE t.schemaname = 'public'
ORDER BY t.tablename;
SELECT 'catalogo', 'gatilhos+indices+restricoes', count(*)::text, md5(string_agg(x, ',' ORDER BY x))
FROM (
  SELECT 'trg:' || c.relname || '.' || g.tgname AS x FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT g.tgisinternal
  UNION ALL SELECT 'idx:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT 'con:' || conname || ':' || pg_get_constraintdef(o.oid) FROM pg_constraint o
    JOIN pg_namespace n ON n.oid = o.connamespace WHERE n.nspname = 'public'
) q;
SELECT 'migracoes', 'aplicadas', count(*)::text, md5(string_agg(migration_name, ',' ORDER BY migration_name))
FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'migracoes', 'pendentes-ou-falhas', count(*)::text, '-'
FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT 'financeiro', c.table_name || '.' || c.column_name,
       (xpath('/row/n/text()', x))[1]::text, (xpath('/row/s/text()', x))[1]::text
FROM information_schema.columns c,
     LATERAL query_to_xml(format('SELECT count(*) AS n, coalesce(sum(%I), 0) AS s FROM public.%I',
       c.column_name, c.table_name), false, true, '') x
WHERE c.table_schema = 'public' AND c.column_name LIKE '%\_cents' AND c.data_type IN ('integer', 'bigint')
ORDER BY 2;
ROLLBACK;
