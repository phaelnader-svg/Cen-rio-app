-- Diagnóstico SOMENTE LEITURA de UMA tabela, para localizar a divergência entre dois bancos SEM
-- exibir valores. Variável psql: tabela (nome em public). Linhas:
--   coluna|<coluna>|<md5 do multiconjunto de valores da coluna>
--   linha|<chave>|<md5 da linha>
-- A chave é a chave primária quando ela é só de colunas uuid/inteiras (identificadores técnicos,
-- não pessoais); senão aparece como "h:<md5 da chave>" (ou da linha, sem chave primária).
BEGIN TRANSACTION READ ONLY;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL search_path = public, pg_catalog;
SELECT 'coluna', a.attname,
       (xpath('/row/h/text()', query_to_xml(format(
         'SELECT md5(coalesce(string_agg(coalesce(%1$I::text, ''<nulo>''), ''/'' ORDER BY coalesce(%1$I::text, ''<nulo>'') COLLATE "C"), '''')) AS h FROM public.%2$I',
         a.attname, :'tabela'), false, true, '')))[1]::text
FROM pg_attribute a
WHERE a.attrelid = format('public.%I', :'tabela')::regclass AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;
WITH k AS (
  SELECT string_agg(format('%I::text', a.attname), ' || '','' || ' ORDER BY a.attnum) AS expr,
         bool_and(a.atttypid IN ('uuid'::regtype, 'int2'::regtype, 'int4'::regtype, 'int8'::regtype)) AS exibivel
  FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
  WHERE i.indrelid = format('public.%I', :'tabela')::regclass AND i.indisprimary
)
SELECT 'linha', (xpath('/row/k/text()', x))[1]::text, (xpath('/row/h/text()', x))[1]::text
FROM k, LATERAL unnest(xpath('/table/row', query_to_xml(format(
  'SELECT %s AS k, md5(r::text) AS h FROM public.%I r',
  CASE WHEN k.expr IS NULL THEN '''h:'' || md5(r::text)'
       WHEN k.exibivel THEN k.expr
       ELSE '''h:'' || md5(' || k.expr || ')' END,
  :'tabela'), false, false, ''))) x
ORDER BY 2;
ROLLBACK;
