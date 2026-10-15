-- PRÉ-VERIFICAÇÃO (somente leitura) — DADOS que fariam uma migration conhecida FALHAR no meio.
-- Uma linha por verificação: <migration>|<verificação>|<valor>|<esperado>. O verificador
-- (preflight_migracoes.py) só considera as linhas das migrations AINDA PENDENTES; "esperado" = "-"
-- é informativo. A conferência de ESQUEMA (tabelas/colunas/índices/tipos que cada migration cria,
-- altera ou exige) é feita à parte, lendo o próprio SQL das migrations da imagem.
--
-- Cada consulta só roda se as tabelas/colunas de que depende já existirem (senão vale 0: a coluna
-- ainda vai ser criada por uma migration anterior pendente, que é conferida pelo esquema). Por isso
-- as consultas vão como texto constante a query_to_xml, protegidas por CASE: sem SQL montado a
-- partir de dados, sem parâmetros externos. Nada é gravado (transação somente leitura).
BEGIN TRANSACTION READ ONLY;

-- 20261025 — índice único novo sobre production_tasks (uma tarefa viva por peça + etapa do modelo).
SELECT '20261025000000_distribuicao_automatica', 'tarefas-geradas-duplicadas-por-peca-e-etapa',
  CASE WHEN EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.production_tasks')
                    AND attname = 'template_step_position' AND NOT attisdropped)
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM (SELECT 1 FROM production_tasks
              WHERE template_id IS NOT NULL AND status::text <> 'CANCELADA'
              GROUP BY service_order_item_id, template_id, template_step_position HAVING count(*) > 1) d$q$,
              false, true, '')))[1]::text
       ELSE '0' END, '0';

-- 20261101 — índices únicos novos sobre production_payables (uma obrigação viva por peça/OS e profissional).
SELECT '20261101000000_mao_de_obra_revisao', 'mao-de-obra-duplicada-por-peca-e-profissional',
  CASE WHEN to_regclass('public.production_payables') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM (SELECT 1 FROM production_payables
              WHERE status::text <> 'CANCELADO' AND service_order_item_id IS NOT NULL
              GROUP BY service_order_item_id, professional_user_id HAVING count(*) > 1) d$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';
SELECT '20261101000000_mao_de_obra_revisao', 'mao-de-obra-duplicada-por-os-e-profissional',
  CASE WHEN to_regclass('public.production_payables') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM (SELECT 1 FROM production_payables
              WHERE status::text <> 'CANCELADO' AND service_order_item_id IS NULL
              GROUP BY service_order_id, professional_user_id HAVING count(*) > 1) d$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';

-- 20261108 — restrições novas sobre logistics_costs / logistics_cost_allocations existentes.
SELECT '20261108000000_custos_logistica', 'custos-logistica-valor-nao-positivo',
  CASE WHEN to_regclass('public.logistics_costs') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM logistics_costs
              WHERE amount_cents <= 0$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';
SELECT '20261108000000_custos_logistica', 'custos-logistica-tipo-desconhecido',
  CASE WHEN to_regclass('public.logistics_costs') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM logistics_costs
              WHERE kind::text NOT IN ('RETIRADA', 'ENTREGA', 'INSTALACAO', 'TRANSPORTE_TERCEIRIZADO', 'DESLOCAMENTO',
                                       'TENTATIVA_FRUSTRADA')$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';
SELECT '20261108000000_custos_logistica', 'custos-logistica-rateio-tipo-desconhecido',
  CASE WHEN to_regclass('public.logistics_costs') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM logistics_costs
              WHERE split_method::text NOT IN ('IGUAL', 'POR_PECA', 'MANUAL')$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';
SELECT '20261108000000_custos_logistica', 'rateio-duplicado-por-custo-e-os',
  CASE WHEN to_regclass('public.logistics_cost_allocations') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM (SELECT 1 FROM logistics_cost_allocations
              GROUP BY logistics_cost_id, service_order_id HAVING count(*) > 1) d$q$, false, true, '')))[1]::text
       ELSE '0' END, '0';

-- 20261220 — INSERT … ON CONFLICT DO NOTHING em role_permissions: precisa da chave (role_id, permission),
-- senão duplicaria permissões em vez de ignorá-las.
SELECT '20261220000000_recebimentos_permissao_funcoes', 'role-permissions-sem-chave-funcao-permissao',
  CASE WHEN to_regclass('public.role_permissions') IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('public.role_permissions') AND k.contype IN ('p', 'u')
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)) = ARRAY['permission', 'role_id'])
       THEN '1' ELSE '0' END, '0';
SELECT '20261220000000_recebimentos_permissao_funcoes', 'funcoes-que-recebem-a-permissao',
  CASE WHEN to_regclass('public.roles') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM roles
              WHERE key IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante')$q$, false, true, '')))[1]::text
       ELSE '0' END, '-';

-- 20261230 — os modelos simplificados usam estes rótulos dos tipos enumerados (falta = erro no INSERT).
SELECT '20261230000000_modelos_simplificados', 'rotulos-de-enum-ausentes', count(*)::text, '0'
FROM (VALUES ('piece_type', 'SOFA'), ('piece_type', 'CANTO_ALEMAO'), ('piece_type', 'CABECEIRA'),
             ('service_type', 'REFORMA_COMPLETA'), ('service_type', 'FABRICACAO'),
             ('production_activity', 'DESMONTAGEM'), ('production_activity', 'CORTE_TECIDO'),
             ('production_activity', 'MONTAGEM'), ('production_activity', 'PREPARACAO_MDF'),
             ('production_activity', 'REVESTIMENTO'), ('task_role', 'APOIO'), ('task_role', 'PRINCIPAL'),
             ('step_class', 'PREPARACAO'), ('step_class', 'TAPECARIA')) AS v(tipo, rotulo)
WHERE to_regtype('public.' || v.tipo) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_enum e WHERE e.enumtypid = to_regtype('public.' || v.tipo) AND e.enumlabel = v.rotulo);
SELECT '20261230000000_modelos_simplificados', 'modelos-simplificados-ja-presentes',
  CASE WHEN to_regclass('public.production_templates') IS NOT NULL
       THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM production_templates
              WHERE id IN ('5f5e0000-0000-4000-8000-000000000001', '5f5e0000-0000-4000-8000-000000000002')$q$,
              false, true, '')))[1]::text
       ELSE '0' END, '-';

-- Informativo (qualquer migration pendente): tamanho do banco, para estimar tempo e bloqueios.
SELECT '*', 'tamanho-do-banco', pg_size_pretty(pg_database_size(current_database())), '-';
ROLLBACK;
