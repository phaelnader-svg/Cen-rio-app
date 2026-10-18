-- PRÉ-VERIFICAÇÃO (somente leitura) — catálogo do esquema public, para conferir se as migrations
-- pendentes encontram o que precisam (tabelas, colunas, tipos) e não colidem com o que já existe.
-- Uma linha por objeto: <tipo>|<nome>|<detalhe>. Só nomes e tipos: nenhum dado é lido.
--   relacao|<nome>|<relkind>   coluna|<tabela.coluna>|-   restricao|<tabela.nome>|<contype>
--   tipo|<nome>|<typtype>      rotulo|<tipo.rótulo>|-     gatilho|<tabela.nome>|-   funcao|<nome>|-
BEGIN TRANSACTION READ ONLY;
SELECT 'relacao', c.relname, c.relkind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'i', 'I', 'S', 'v', 'm', 'f');
SELECT 'coluna', c.relname || '.' || a.attname, '-'
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped;
SELECT 'restricao', c.relname || '.' || k.conname, k.contype
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public';
SELECT 'tipo', t.typname, t.typtype
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') ;
SELECT 'rotulo', t.typname || '.' || e.enumlabel, '-'
FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public';
SELECT 'gatilho', c.relname || '.' || g.tgname, '-'
FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT g.tgisinternal;
SELECT 'funcao', p.proname, '-'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public';
ROLLBACK;
