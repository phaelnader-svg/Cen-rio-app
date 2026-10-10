-- PRÉ-VERIFICAÇÃO SOMENTE LEITURA para as 5 migrations da Evolução (20261018…–20261115…).
-- Cada linha: verificação|valor|esperado. Qualquer "valor" diferente do "esperado" (exceto as
-- linhas "volume|…", informativas) indica dado que faria uma migration FALHAR no meio — não
-- publique sem decidir o que fazer. Nada é gravado (transação somente leitura).
BEGIN TRANSACTION READ ONLY;
-- Estado das migrations: as 12 da versão publicada aplicadas, nenhuma pendente/falha, nenhuma nova.
SELECT 'migracoes-aplicadas', count(*), '12' FROM _prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT 'migracoes-com-falha-ou-pendentes', count(*), '0' FROM _prisma_migrations
  WHERE finished_at IS NULL AND rolled_back_at IS NULL;
SELECT 'migracoes-da-evolucao-ja-presentes', count(*), '0' FROM _prisma_migrations
  WHERE migration_name >= '20261018000000';
-- Objetos que as migrations CRIAM não podem existir antes (falha "already exists").
SELECT 'objetos-novos-ja-existentes', count(*), '0' FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relname IN ('service_order_item_owner_changes', 'labor_reviews', 'logistics_cost_participants',
    'logistics_cost_adjustments', 'payable_payment_reversals', 'weekly_closings', 'weekly_closing_events',
    'closing_payments', 'closing_payment_parts', 'closing_payment_reversals',
    'professional_payment_reversals', 'logistics_free_trips');
SELECT 'tipos-novos-ja-existentes', count(*), '0' FROM pg_type WHERE typname IN ('plan_mode', 'step_class');
-- Regras novas sobre tabelas EXISTENTES (a migration falharia se o dado as violasse).
SELECT 'mao-de-obra-duplicada-por-peca-e-profissional', count(*), '0' FROM (
  SELECT 1 FROM production_payables WHERE status <> 'CANCELADO' AND service_order_item_id IS NOT NULL
  GROUP BY service_order_item_id, professional_user_id HAVING count(*) > 1) d;
SELECT 'mao-de-obra-duplicada-por-os-e-profissional', count(*), '0' FROM (
  SELECT 1 FROM production_payables WHERE status <> 'CANCELADO' AND service_order_item_id IS NULL
  GROUP BY service_order_id, professional_user_id HAVING count(*) > 1) d;
SELECT 'custos-logistica-valor-nao-positivo', count(*), '0' FROM logistics_costs WHERE amount_cents <= 0;
SELECT 'custos-logistica-tipo-desconhecido', count(*), '0' FROM logistics_costs
  WHERE kind NOT IN ('RETIRADA', 'ENTREGA', 'INSTALACAO', 'TRANSPORTE_TERCEIRIZADO', 'DESLOCAMENTO');
SELECT 'custos-logistica-rateio-tipo-desconhecido', count(*), '0' FROM logistics_costs
  WHERE split_method NOT IN ('IGUAL', 'POR_PECA', 'MANUAL');
SELECT 'rateio-duplicado-por-custo-e-os', count(*), '0' FROM (
  SELECT 1 FROM logistics_cost_allocations GROUP BY logistics_cost_id, service_order_id HAVING count(*) > 1) d;
SELECT 'configuracao-da-empresa-linhas', count(*), '1' FROM company_settings;
-- Volume (informativo): estimativa do tempo das migrations e dos bloqueios.
SELECT 'volume|' || relname, n_live_tup, '-' FROM pg_stat_user_tables
  WHERE relname IN ('production_tasks', 'production_payables', 'logistics_costs',
    'logistics_cost_allocations', 'service_order_items', 'production_template_steps', 'audit_logs')
  ORDER BY relname;
SELECT 'volume|tamanho-do-banco', pg_size_pretty(pg_database_size(current_database())), '-';
ROLLBACK;
