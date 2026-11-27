-- Retrato de integridade histórica (Reformulação por remoção real — S0). SOMENTE LEITURA.
-- Uso: psql "$DATABASE_URL" -X -q -At -F'|' -v ON_ERROR_STOP=1 -f retrato-historico.sql > retrato.txt
-- Saída: uma linha por medida, ordenável e comparável (retrato-comparar.py). Só NÚMEROS e nomes de
-- tabela/coluna/situação: nenhum texto livre, nome, documento, telefone, e-mail ou credencial.
--   contagem|<tabela>|<linhas>
--   soma|<tabela>|<coluna_cents>|<soma>
--   situacao|<tabela>|<coluna>|<valor>|<linhas>       (colunas status/kind/origin/category/due_trigger/fulfillment_stage)
--   orfaos|<tabela>|<restrição FK>|<linhas sem pai>    (integridade referencial; esperado 0)
--   migracoes|aplicadas|<n>
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';

-- 1. Contagem exata de todas as tabelas do esquema public
SELECT format('SELECT ''contagem'', %L, count(*) FROM public.%I', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname
\gexec

-- 2. Somas de todas as colunas monetárias (*_cents)
SELECT format('SELECT ''soma'', %L, %L, coalesce(sum(%I), 0) FROM public.%I', table_name, column_name, column_name, table_name)
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name LIKE '%\_cents' AND data_type IN ('integer', 'bigint', 'numeric')
ORDER BY table_name, column_name
\gexec

-- 3. Distribuição por situação (valores de domínio, nunca texto livre)
SELECT format('SELECT ''situacao'', %L, %L, coalesce(%I::text, ''(nulo)''), count(*) FROM public.%I GROUP BY 4 ORDER BY 4',
              table_name, column_name, column_name, table_name)
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN ('status', 'kind', 'origin', 'category', 'due_trigger', 'fulfillment_stage')
ORDER BY table_name, column_name
\gexec

-- 4. Integridade referencial: filhos cujo pai não existe (por restrição FK de coluna única)
SELECT format('SELECT ''orfaos'', %L, %L, count(*) FROM public.%I f WHERE f.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = f.%I)',
              cl.relname, con.conname, cl.relname, a.attname, rf.relname, af.attname, a.attname)
FROM pg_constraint con
JOIN pg_class cl ON cl.oid = con.conrelid
JOIN pg_class rf ON rf.oid = con.confrelid
JOIN pg_namespace n ON n.oid = cl.relnamespace
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = con.confkey[1]
WHERE con.contype = 'f' AND n.nspname = 'public' AND array_length(con.conkey, 1) = 1
ORDER BY cl.relname, con.conname
\gexec

-- 5. Migrations aplicadas
SELECT 'migracoes', 'aplicadas', count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
ROLLBACK;
