-- Impressão digital SOMENTE LEITURA do banco (Evolução — pré-deploy). Uma linha por item, 4 campos:
--   tabela|<tabela>|<linhas>|<md5 de todas as linhas, em ordem binária>
--   coluna|<tabela.coluna>|<posição>|<tipo, nulidade, identidade, gerada, collation>
--   restricao|<tabela.nome>|<tipo>|<colunas, referência, ações, adiamento, validação>   (sem texto)
--   indice|<nome>|<tabela>|<método, único, primário, colunas, opclasses, opções, parcial>  (sem texto)
--   gatilho|<tabela.nome>|-|<momento/eventos, ativo, função, colunas, argumentos, WHEN>   (sem texto)
--   funcao|<nome(args)>|-|<linguagem, volatilidade, retorno, md5 do corpo>
--   tipo|<nome>|<tipo>|<rótulos do enum, em ordem>
--   sequencia|<nome>|<last_value>|<is_called>
--   def-*|<objeto>|-|<definição em texto do PostgreSQL>  (CHECK/FK/índice/gatilho/default/visão)
--   migracoes|aplicadas|<qtde>|<md5 dos nomes>   ·   migracoes|pendentes-ou-falhas|<qtde>|-
--   financeiro|<tabela.coluna>|<linhas>|<soma>     (todas as colunas *_cents)
-- As linhas def-* vêm do "deparse" do PostgreSQL: um dump/restore pode reescrever o texto de uma
-- expressão equivalente (ex.: "= ANY ((ARRAY['A'::varchar])::text[])" → "= ANY (ARRAY[('A'::varchar)::text])").
-- Por isso a conferência da restauração compara def-* com uma restauração SÓ DE ESQUEMA do banco
-- original feita na mesma hora, e todo o resto diretamente com o original (ver conferencia-restauracao.sh).
-- Saída determinística: fuso, formatos e ordenação fixos na sessão (não dependem do banco).
-- Uso: psql -At -F'|' -v ON_ERROR_STOP=1 -f impressao-digital.sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL search_path = public, pg_catalog;
SELECT 'tabela', t.tablename,
       (xpath('/row/n/text()', x))[1]::text,
       (xpath('/row/h/text()', x))[1]::text
FROM pg_tables t,
     LATERAL query_to_xml(format(
       'SELECT count(*) AS n, coalesce(md5(string_agg(r::text, ''/'' ORDER BY r::text COLLATE "C")), ''-'') AS h FROM %I.%I r',
       t.schemaname, t.tablename), false, true, '') x
WHERE t.schemaname = 'public'
ORDER BY t.tablename COLLATE "C";
WITH cls AS (
  SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
), itens AS (
  -- Colunas (posição entre as não removidas: é a ordem que define o texto de cada linha).
  SELECT 'coluna' AS k, c.relname || '.' || a.attname AS nome,
         (row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum))::text AS v1,
         format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' identity=' || a.attidentity::text
           || ' generated=' || a.attgenerated::text || ' collation=' || coalesce(co.collname, '-') AS v2
  FROM cls c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
  WHERE c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'def-padrao', c.relname || '.' || a.attname, '-', pg_get_expr(d.adbin, d.adrelid)
  FROM cls c JOIN pg_attrdef d ON d.adrelid = c.oid
  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  UNION ALL
  -- Restrições: estrutura sem depender do texto (colunas, referência, ações, validação).
  SELECT 'restricao', coalesce(r.relname, '-') || '.' || o.conname, o.contype::text,
         'cols=' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.i) FROM unnest(o.conkey) WITH ORDINALITY k(n, i)
                               JOIN pg_attribute a ON a.attrelid = o.conrelid AND a.attnum = k.n), '-')
         || ' ref=' || coalesce(f.relname || '(' || (SELECT string_agg(a.attname, ',' ORDER BY k.i)
                               FROM unnest(o.confkey) WITH ORDINALITY k(n, i)
                               JOIN pg_attribute a ON a.attrelid = o.confrelid AND a.attnum = k.n) || ')', '-')
         || ' upd=' || o.confupdtype::text || ' del=' || o.confdeltype::text || ' match=' || o.confmatchtype::text
         || ' deferrable=' || o.condeferrable || ' deferred=' || o.condeferred
         || ' validated=' || o.convalidated || ' noinherit=' || o.connoinherit
  FROM pg_constraint o JOIN pg_namespace n ON n.oid = o.connamespace
  LEFT JOIN pg_class r ON r.oid = o.conrelid LEFT JOIN pg_class f ON f.oid = o.confrelid
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'def-restricao', coalesce(r.relname, '-') || '.' || o.conname, '-', pg_get_constraintdef(o.oid)
  FROM pg_constraint o JOIN pg_namespace n ON n.oid = o.connamespace LEFT JOIN pg_class r ON r.oid = o.conrelid
  WHERE n.nspname = 'public'
  UNION ALL
  -- Índices: estrutura sem depender do texto.
  SELECT 'indice', ic.relname, t.relname,
         'am=' || am.amname || ' unique=' || i.indisunique || ' primary=' || i.indisprimary
         || ' nullsnotdistinct=' || i.indnullsnotdistinct || ' nkey=' || i.indnkeyatts
         || ' cols=' || (SELECT string_agg(CASE WHEN k.n = 0 THEN '(expr)' ELSE a.attname END, ',' ORDER BY k.i)
                         FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, i)
                         LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n)
         || ' opclass=' || (SELECT string_agg(op.opcname, ',' ORDER BY k.i)
                            FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(o, i) JOIN pg_opclass op ON op.oid = k.o)
         || ' options=' || i.indoption::text || ' parcial=' || (i.indpred IS NOT NULL)
         || ' expressoes=' || (i.indexprs IS NOT NULL) || ' valid=' || i.indisvalid
  FROM pg_index i JOIN cls ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_class ix ON ix.oid = i.indexrelid JOIN pg_am am ON am.oid = ix.relam
  UNION ALL
  SELECT 'def-indice', ic.relname, '-', pg_get_indexdef(i.indexrelid)
  FROM pg_index i JOIN cls ic ON ic.oid = i.indexrelid
  UNION ALL
  -- Gatilhos (os internos das chaves estrangeiras ficam de fora: são cobertos pelas restrições).
  SELECT 'gatilho', c.relname || '.' || g.tgname, '-',
         'tipo=' || g.tgtype || ' ativo=' || g.tgenabled::text || ' funcao=' || p.proname
         || ' cols=' || g.tgattr::text || ' args=' || encode(g.tgargs, 'hex') || ' when=' || (g.tgqual IS NOT NULL)
         || ' deferrable=' || g.tgdeferrable || ' deferred=' || g.tginitdeferred
  FROM pg_trigger g JOIN cls c ON c.oid = g.tgrelid JOIN pg_proc p ON p.oid = g.tgfoid
  WHERE NOT g.tgisinternal
  UNION ALL
  SELECT 'def-gatilho', c.relname || '.' || g.tgname, '-', pg_get_triggerdef(g.oid)
  FROM pg_trigger g JOIN cls c ON c.oid = g.tgrelid WHERE NOT g.tgisinternal
  UNION ALL
  SELECT 'funcao', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', '-',
         'lang=' || l.lanname || ' volatil=' || p.provolatile::text || ' retorno=' || format_type(p.prorettype, NULL)
         || ' corpo=' || md5(coalesce(p.prosrc, ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'tipo', t.typname, t.typtype::text,
         coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '-')
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c')
    AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
  UNION ALL
  SELECT 'def-visao', c.relname, '-', pg_get_viewdef(c.oid)
  FROM cls c WHERE c.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'sequencia', c.relname, (xpath('/row/v/text()', x))[1]::text, (xpath('/row/c/text()', x))[1]::text
  FROM cls c, LATERAL query_to_xml(format('SELECT last_value AS v, is_called AS c FROM public.%I', c.relname),
                                   false, true, '') x
  WHERE c.relkind = 'S'
)
SELECT k, nome, v1, replace(replace(v2, E'\n', ' '), '|', '¦') FROM itens
ORDER BY k COLLATE "C", nome COLLATE "C", v1 COLLATE "C";
SELECT 'migracoes', 'aplicadas', count(*)::text, md5(string_agg(migration_name, ',' ORDER BY migration_name COLLATE "C"))
FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'migracoes', 'pendentes-ou-falhas', count(*)::text, '-'
FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT 'financeiro', c.table_name || '.' || c.column_name,
       (xpath('/row/n/text()', x))[1]::text, (xpath('/row/s/text()', x))[1]::text
FROM information_schema.columns c,
     LATERAL query_to_xml(format('SELECT count(*) AS n, coalesce(sum(%I), 0) AS s FROM public.%I',
       c.column_name, c.table_name), false, true, '') x
WHERE c.table_schema = 'public' AND c.column_name LIKE '%\_cents' AND c.data_type IN ('integer', 'bigint')
ORDER BY (c.table_name || '.' || c.column_name) COLLATE "C";
ROLLBACK;
