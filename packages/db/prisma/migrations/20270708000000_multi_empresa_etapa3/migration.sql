-- Multi-empresa, etapa 3: a trava no banco (Row-Level Security).
--
-- A API passa a trabalhar com o papel cenario_app (sem superusuário, sem BYPASSRLS): cada
-- transação dela começa com set_config('role', 'cenario_app', true) e grava app.company_id
-- (apps/api/src/core/tenant.ts). As políticas abaixo só deixam ver e gravar linhas da empresa da
-- transação. O cliente "do sistema" (login, fila de eventos, testes) liga app.bypass_rls.
-- Conexões sem esse prelúdio (migrations, backup, psql do operador) seguem como antes.
--
-- Não altera nenhuma linha. Reversão: packages/db/rollback/20270708000000_multi_empresa_etapa3.down.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cenario_app') THEN
    CREATE ROLE cenario_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
-- Quem roda a API (e as migrations) pode assumir o papel.
GRANT cenario_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO cenario_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cenario_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO cenario_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cenario_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cenario_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO cenario_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO cenario_app;

-- Sem empresa definida: NULL (a etapa 2 devolvia 1 enquanto esta trava não existia).
CREATE OR REPLACE FUNCTION app_company_id() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::INTEGER
$$;

CREATE FUNCTION app_rls_bypass() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
$$;

-- A própria tabela de empresas: cada empresa só enxerga a si mesma.
ALTER TABLE "company_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "company_settings"
  USING ("id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("id" = app_company_id() OR app_rls_bypass());

ALTER TABLE "account_payables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_payables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "account_payables"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "accounting_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounting_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "accounting_documents"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "agent_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "agent_actions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "ai_agent_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_agent_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "ai_agent_messages"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "ai_agent_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_agent_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "ai_agent_proposals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "ai_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_agents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "ai_agents"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "attachments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "attendance_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "attendance_corrections"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "attendance_impacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_impacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "attendance_impacts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "attendance_leave_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_leave_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "attendance_leave_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "attendance_leaves" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_leaves" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "attendance_leaves"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "audit_logs"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "bank_accounts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "bank_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_transactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "bank_transactions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "card_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "card_settlements"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "cash_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "cash_entries"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "cash_goal_achievements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_goal_achievements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "cash_goal_achievements"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "cash_goals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_goals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "cash_goals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "cash_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "cash_snapshots"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "cash_week_closings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_week_closings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "cash_week_closings"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "closing_payment_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "closing_payment_parts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "closing_payment_parts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "closing_payment_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "closing_payment_reversals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "closing_payment_reversals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "closing_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "closing_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "closing_payments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "commercial_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "commercial_adjustments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "commercial_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "commercial_order_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "commercial_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commercial_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "commercial_orders"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "company_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "company_counters"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "company_holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_holidays" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "company_holidays"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "contract_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contract_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "contract_templates"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contracts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "contracts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "customer_addresses"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "customer_payment_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_payment_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "customer_payment_reports"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "customer_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "customer_payments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "customer_receivables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_receivables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "customer_receivables"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "customers"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "deliveries"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "delivery_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "delivery_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "delivery_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "delivery_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "devices"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "domain_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "domain_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "employee_skills" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_skills" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "employee_skills"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "employees"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "fabric_rolls" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fabric_rolls" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "fabric_rolls"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "financial_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "financial_adjustments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "financial_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "financial_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "financial_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "fiscal_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "fiscal_documents"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "fiscal_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "fiscal_profiles"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_areas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_areas" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_areas"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_layout_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_layout_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_layout_revisions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_slot_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_slot_materials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_slot_materials"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_spaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_spaces"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_station_assignees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_station_assignees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_station_assignees"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_stations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_storage_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_storage_slots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_storage_slots"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "game_storage_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "game_storage_units" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "game_storage_units"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "help_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "help_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "help_request_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "help_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "help_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "help_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "idempotency_keys"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "inbox_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "inbox_conversations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "inbox_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "inbox_messages"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "integration_connections"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "integration_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_oauth_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "integration_oauth_states"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "integration_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "integration_webhook_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "inventory_adjustments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "inventory_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "inventory_categories"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "inventory_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "item_location_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_location_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "item_location_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "item_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "item_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "item_locations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "labor_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "labor_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "labor_reviews"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_cost_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_cost_adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_cost_adjustments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_cost_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_cost_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_cost_allocations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_cost_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_cost_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_cost_participants"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_costs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_costs"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_free_trips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_free_trips" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_free_trips"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_occurrence_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_occurrence_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_occurrence_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_occurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_occurrences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_occurrences"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "logistics_trip_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistics_trip_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "logistics_trip_participants"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "marketing_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_posts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "marketing_posts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_arrivals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_arrivals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_arrivals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_leftover_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_leftover_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_leftover_transfers"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_leftovers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_leftovers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_leftovers"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_receipt_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_receipt_lines"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_receipt_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_receipt_reversals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_receipt_reversals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_receipts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_request_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_request_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_request_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "material_requirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "material_requirements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "material_requirements"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "measurement_pieces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "measurement_pieces" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "measurement_pieces"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "measurement_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "measurement_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "measurement_revisions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "measurements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "measurements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "measurements"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "module_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "module_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "module_settings"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "notifications"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "oauth_access_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_access_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "oauth_access_tokens"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "oauth_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "oauth_codes"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "oauth_grants"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "operational_attendances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operational_attendances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "operational_attendances"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "operational_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operational_expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "operational_expenses"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "packaging_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "packaging_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "packaging_records"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "payable_payment_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payable_payment_reversals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "payable_payment_reversals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "payable_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payable_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "payable_payments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "payment_charges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_charges" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "payment_charges"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "payment_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "payment_orders"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "pickup_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pickup_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "pickup_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "pickup_request_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pickup_request_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "pickup_request_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "pickup_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pickup_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "pickup_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "piece_return_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "piece_return_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "piece_return_lines"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "piece_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "piece_returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "piece_returns"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "planning_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "planning_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "planning_actions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_issue_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_issue_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_issue_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_issues" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_issues" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_issues"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_payables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_payables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_payables"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_plan_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_plan_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_plan_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_plan_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_plan_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_plan_revisions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_plans"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_task_dependencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_task_dependencies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_task_dependencies"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_task_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_task_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_task_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_task_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_task_materials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_task_materials"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_tasks"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_template_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_template_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_template_steps"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "production_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "production_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "production_templates"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "professional_payment_reversals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professional_payment_reversals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "professional_payment_reversals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "professional_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "professional_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "professional_payments"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "purchase_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "purchase_allocations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "purchase_order_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "purchase_order_history"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "purchase_order_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "purchase_orders"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "purchase_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "purchase_quotes"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quality_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quality_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quality_inspection_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_inspection_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quality_inspection_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quality_inspections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_inspections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quality_inspections"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quality_template_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_template_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quality_template_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quality_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quality_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quality_templates"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quote_catalog_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_catalog_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quote_catalog_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quote_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quote_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quote_settings"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "quotes"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "receipt_corrections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_corrections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "receipt_corrections"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipt_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "receipt_lines"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "receipts"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "recurring_expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "recurring_expenses"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "reschedule_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reschedule_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "reschedule_proposals"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "role_permissions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "roles"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_model_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_model_materials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_model_materials"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_order_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_order_costs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_order_costs"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_order_item_owner_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_order_item_owner_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_order_item_owner_changes"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_order_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_order_materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_order_materials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_order_materials"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_order_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_order_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_order_revisions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "service_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "service_orders"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "sessions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "stock_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "stock_items"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "stock_movements"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "stock_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "stock_reservations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "stored_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stored_files" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "stored_files"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "suppliers"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "team_monthly_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_monthly_costs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "team_monthly_costs"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "user_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "user_permissions"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "user_roles"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "users"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "value_change_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "value_change_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "value_change_requests"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "weekly_closing_confirmations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_closing_confirmations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "weekly_closing_confirmations"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "weekly_closing_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_closing_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "weekly_closing_events"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
ALTER TABLE "weekly_closings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_closings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "empresa" ON "weekly_closings"
  USING ("company_id" = app_company_id() OR app_rls_bypass())
  WITH CHECK ("company_id" = app_company_id() OR app_rls_bypass());
