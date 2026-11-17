-- Multi-empresa, etapa 2: cada linha do banco passa a ter a empresa dona dela.
--
-- * company_settings vira a tabela de empresas (id passa a ser automático). A empresa 1 é a
--   Cenário Estofados e recebe TODOS os dados existentes.
-- * 159 tabelas ganham company_id (NOT NULL, FK para company_settings). O valor padrão vem de
--   app_company_id(): a empresa definida na transação (SET LOCAL app.company_id), ou 1 enquanto a
--   etapa 3 não liga essa definição em cada requisição.
-- * Numerações (pedido nº, OS nº…) passam a ser por empresa: company_counters + gatilho.
-- * Unicidades de nomes/códigos/datas passam a valer por empresa.
--
-- Só acrescenta: nenhum registro é removido ou alterado além de ganhar company_id = 1.
-- Reversão: packages/db/rollback/20270701000000_multi_empresa_etapa2.down.sql

-- 1. A empresa nº 1 existe antes de qualquer chave estrangeira apontar para ela.
INSERT INTO "company_settings" ("id", "trade_name", "updated_at")
VALUES (1, 'Cenário Estofados', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Até aqui só podia existir a empresa 1.
ALTER TABLE "company_settings" DROP CONSTRAINT "company_settings_singleton";
CREATE SEQUENCE "company_settings_id_seq" AS INTEGER OWNED BY "company_settings"."id";
SELECT setval('"company_settings_id_seq"', GREATEST((SELECT MAX("id") FROM "company_settings"), 1));
ALTER TABLE "company_settings" ALTER COLUMN "id" SET DEFAULT nextval('"company_settings_id_seq"');

-- 2. Empresa da transação. Etapa 3 troca o "1" de reserva por erro (sem empresa = sem acesso).
CREATE FUNCTION app_company_id() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.company_id', true), '')::INTEGER, 1)
$$;

-- 3. Numeração por empresa.
CREATE TABLE "company_counters" (
    "company_id" INTEGER NOT NULL DEFAULT app_company_id(),
    "key" VARCHAR(64) NOT NULL,
    "last_value" INTEGER NOT NULL,
    CONSTRAINT "company_counters_pkey" PRIMARY KEY ("company_id", "key")
);
ALTER TABLE "company_counters" ADD CONSTRAINT "company_counters_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION next_company_number(p_company INTEGER, p_key TEXT) RETURNS INTEGER
LANGUAGE sql AS $$
  INSERT INTO "company_counters" AS c ("company_id", "key", "last_value")
  VALUES (p_company, p_key, 1)
  ON CONFLICT ("company_id", "key") DO UPDATE SET "last_value" = c."last_value" + 1
  RETURNING c."last_value"
$$;

CREATE FUNCTION assign_company_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS NULL THEN
    NEW."number" := next_company_number(NEW."company_id", TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END
$$;

-- 4. company_id em todas as tabelas de empresa. O DEFAULT 1 constante não reescreve a tabela;
--    em seguida o padrão vira app_company_id() para as linhas novas.
ALTER TABLE "users" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "users" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sessions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "devices" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "devices" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "devices" ADD CONSTRAINT "devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "oauth_codes" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "oauth_codes" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "oauth_grants" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "oauth_grants" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "oauth_access_tokens" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employees" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "employees" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "roles" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "roles" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "role_permissions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "user_roles" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_permissions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "user_permissions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_skills" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "employee_skills" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "module_settings" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "module_settings" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_holidays" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "company_holidays" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "company_holidays" ADD CONSTRAINT "company_holidays_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "audit_logs" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "domain_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "domain_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "idempotency_keys" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stored_files" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "stored_files" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "attachments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "notifications" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customers" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customers" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_addresses" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customer_addresses" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commercial_orders" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "commercial_orders" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commercial_order_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "commercial_order_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "commercial_order_items" ADD CONSTRAINT "commercial_order_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commercial_adjustments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "commercial_adjustments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "commercial_adjustments" ADD CONSTRAINT "commercial_adjustments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pickup_requests" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "pickup_requests" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pickup_request_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "pickup_request_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "pickup_request_items" ADD CONSTRAINT "pickup_request_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pickup_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "pickup_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "pickup_events" ADD CONSTRAINT "pickup_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "receipts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_lines" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "receipt_lines" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "receipt_lines" ADD CONSTRAINT "receipt_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_corrections" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "receipt_corrections" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "receipt_corrections" ADD CONSTRAINT "receipt_corrections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "piece_returns" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "piece_returns" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "piece_return_lines" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "piece_return_lines" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "piece_return_lines" ADD CONSTRAINT "piece_return_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_orders" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_orders" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_revisions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order_revisions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_order_revisions" ADD CONSTRAINT "service_order_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_item_owner_changes" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order_item_owner_changes" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_order_item_owner_changes" ADD CONSTRAINT "service_order_item_owner_changes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "measurements" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "measurements" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "measurement_pieces" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "measurement_pieces" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "measurement_pieces" ADD CONSTRAINT "measurement_pieces_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "measurement_revisions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "measurement_revisions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "measurement_revisions" ADD CONSTRAINT "measurement_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_model_materials" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_model_materials" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_model_materials" ADD CONSTRAINT "service_model_materials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order_materials" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_requirements" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_requirements" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_requests" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_requests" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_request_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_request_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_request_items" ADD CONSTRAINT "material_request_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "suppliers" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "suppliers" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "stock_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "stock_movements" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_reservations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "stock_reservations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_orders" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_order_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_allocations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_allocations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "purchase_allocations" ADD CONSTRAINT "purchase_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_history" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_order_history" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "purchase_order_history" ADD CONSTRAINT "purchase_order_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_receipts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_receipts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_receipts" ADD CONSTRAINT "material_receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_receipt_lines" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_receipt_lines" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_receipt_lines" ADD CONSTRAINT "material_receipt_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_receipt_reversals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_receipt_reversals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_receipt_reversals" ADD CONSTRAINT "material_receipt_reversals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_arrivals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_arrivals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_leftovers" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_leftovers" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_leftovers" ADD CONSTRAINT "material_leftovers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_leftover_transfers" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "material_leftover_transfers" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "material_leftover_transfers" ADD CONSTRAINT "material_leftover_transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_categories" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inventory_categories" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inventory_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fabric_rolls" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fabric_rolls" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "fabric_rolls" ADD CONSTRAINT "fabric_rolls_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inventory_adjustments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_templates" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_templates" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_templates" ADD CONSTRAINT "production_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_template_steps" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_template_steps" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_template_steps" ADD CONSTRAINT "production_template_steps_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_plans" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_plans" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_plan_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_plan_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_plan_items" ADD CONSTRAINT "production_plan_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_plan_revisions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_plan_revisions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_plan_revisions" ADD CONSTRAINT "production_plan_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_tasks" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_tasks" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_task_dependencies" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_task_dependencies" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_task_dependencies" ADD CONSTRAINT "production_task_dependencies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_task_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_task_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_task_events" ADD CONSTRAINT "production_task_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_task_materials" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_task_materials" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_task_materials" ADD CONSTRAINT "production_task_materials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_actions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "planning_actions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "planning_actions" ADD CONSTRAINT "planning_actions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reschedule_proposals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "reschedule_proposals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "help_requests" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "help_requests" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "help_request_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "help_request_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "help_request_events" ADD CONSTRAINT "help_request_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_issues" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_issues" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_issues" ADD CONSTRAINT "production_issues_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_issue_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_issue_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_issue_events" ADD CONSTRAINT "production_issue_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "labor_reviews" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "labor_reviews" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "labor_reviews" ADD CONSTRAINT "labor_reviews_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operational_attendances" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "operational_attendances" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_corrections" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "attendance_corrections" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_impacts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "attendance_impacts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_leaves" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "attendance_leaves" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "attendance_leaves" ADD CONSTRAINT "attendance_leaves_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attendance_leave_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "attendance_leave_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "attendance_leave_events" ADD CONSTRAINT "attendance_leave_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_templates" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quality_templates" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quality_templates" ADD CONSTRAINT "quality_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_template_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quality_template_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quality_template_items" ADD CONSTRAINT "quality_template_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_inspections" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quality_inspections" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_inspection_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quality_inspection_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quality_inspection_items" ADD CONSTRAINT "quality_inspection_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quality_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quality_events" ADD CONSTRAINT "quality_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "packaging_records" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "packaging_records" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "packaging_records" ADD CONSTRAINT "packaging_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item_locations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "item_locations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "item_locations" ADD CONSTRAINT "item_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "item_location_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "item_location_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "item_location_events" ADD CONSTRAINT "item_location_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deliveries" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "deliveries" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "delivery_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "delivery_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_occurrences" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_occurrences" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_occurrences" ADD CONSTRAINT "logistics_occurrences_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_occurrence_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_occurrence_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_occurrence_events" ADD CONSTRAINT "logistics_occurrence_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_free_trips" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_free_trips" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_free_trips" ADD CONSTRAINT "logistics_free_trips_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_trip_participants" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_trip_participants" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_trip_participants" ADD CONSTRAINT "logistics_trip_participants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_catalog_items" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quote_catalog_items" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quote_catalog_items" ADD CONSTRAINT "quote_catalog_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quote_settings" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quote_settings" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quote_settings" ADD CONSTRAINT "quote_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "quotes" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_receivables" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customer_receivables" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "customer_receivables" ADD CONSTRAINT "customer_receivables_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customer_payments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_payment_reports" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "customer_payment_reports" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "customer_payment_reports" ADD CONSTRAINT "customer_payment_reports_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_costs" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order_costs" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "service_order_costs" ADD CONSTRAINT "service_order_costs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_payables" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "production_payables" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "production_payables" ADD CONSTRAINT "production_payables_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_adjustments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "financial_adjustments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "professional_payments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "professional_payments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "professional_payments" ADD CONSTRAINT "professional_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "professional_payment_reversals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "professional_payment_reversals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "professional_payment_reversals" ADD CONSTRAINT "professional_payment_reversals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "team_monthly_costs" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "team_monthly_costs" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "team_monthly_costs" ADD CONSTRAINT "team_monthly_costs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_costs" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_costs" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_costs" ADD CONSTRAINT "logistics_costs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_cost_allocations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_cost_allocations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_cost_allocations" ADD CONSTRAINT "logistics_cost_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_cost_participants" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_cost_participants" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_cost_participants" ADD CONSTRAINT "logistics_cost_participants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "logistics_cost_adjustments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "logistics_cost_adjustments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "logistics_cost_adjustments" ADD CONSTRAINT "logistics_cost_adjustments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_payables" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "account_payables" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "account_payables" ADD CONSTRAINT "account_payables_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_payments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payable_payments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "payable_payments" ADD CONSTRAINT "payable_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_payment_reversals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payable_payment_reversals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "payable_payment_reversals" ADD CONSTRAINT "payable_payment_reversals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_expenses" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "recurring_expenses" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operational_expenses" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "operational_expenses" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "operational_expenses" ADD CONSTRAINT "operational_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "financial_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "financial_events" ADD CONSTRAINT "financial_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "value_change_requests" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "value_change_requests" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "value_change_requests" ADD CONSTRAINT "value_change_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "weekly_closings" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "weekly_closings" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "weekly_closings" ADD CONSTRAINT "weekly_closings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "weekly_closing_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "weekly_closing_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "weekly_closing_events" ADD CONSTRAINT "weekly_closing_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "weekly_closing_confirmations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "weekly_closing_confirmations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "weekly_closing_confirmations" ADD CONSTRAINT "weekly_closing_confirmations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "closing_payments" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "closing_payments" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "closing_payments" ADD CONSTRAINT "closing_payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "closing_payment_parts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "closing_payment_parts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "closing_payment_parts" ADD CONSTRAINT "closing_payment_parts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "closing_payment_reversals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "closing_payment_reversals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "closing_payment_reversals" ADD CONSTRAINT "closing_payment_reversals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_spaces" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_spaces" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_spaces" ADD CONSTRAINT "game_spaces_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_areas" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_areas" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_areas" ADD CONSTRAINT "game_areas_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_stations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_stations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_stations" ADD CONSTRAINT "game_stations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_station_assignees" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_station_assignees" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_station_assignees" ADD CONSTRAINT "game_station_assignees_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_storage_units" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_storage_units" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_storage_units" ADD CONSTRAINT "game_storage_units_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_storage_slots" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_storage_slots" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_storage_slots" ADD CONSTRAINT "game_storage_slots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_slot_materials" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_slot_materials" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_slot_materials" ADD CONSTRAINT "game_slot_materials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_layout_revisions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "game_layout_revisions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "game_layout_revisions" ADD CONSTRAINT "game_layout_revisions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ai_agents" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_agent_messages" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ai_agent_messages" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "ai_agent_messages" ADD CONSTRAINT "ai_agent_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_agent_proposals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ai_agent_proposals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_actions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "agent_actions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_connections" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "integration_connections" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_oauth_states" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "integration_oauth_states" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_webhook_events" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "integration_webhook_events" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "integration_webhook_events" ADD CONSTRAINT "integration_webhook_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbox_conversations" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inbox_conversations" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "inbox_messages" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_posts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "marketing_posts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "marketing_posts" ADD CONSTRAINT "marketing_posts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_templates" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "contract_templates" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contracts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "contracts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_charges" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payment_charges" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_profiles" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fiscal_profiles" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "fiscal_profiles" ADD CONSTRAINT "fiscal_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_documents" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "fiscal_documents" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_accounts" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "bank_accounts" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "bank_transactions" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_orders" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "payment_orders" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "card_settlements" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "card_settlements" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "card_settlements" ADD CONSTRAINT "card_settlements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_quotes" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "purchase_quotes" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "accounting_documents" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "accounting_documents" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "accounting_documents" ADD CONSTRAINT "accounting_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_snapshots" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cash_snapshots" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "cash_snapshots" ADD CONSTRAINT "cash_snapshots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_entries" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cash_entries" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "cash_entries" ADD CONSTRAINT "cash_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_goals" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cash_goals" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "cash_goals" ADD CONSTRAINT "cash_goals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_goal_achievements" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cash_goal_achievements" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "cash_goal_achievements" ADD CONSTRAINT "cash_goal_achievements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_week_closings" ADD COLUMN "company_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "cash_week_closings" ALTER COLUMN "company_id" SET DEFAULT app_company_id();
ALTER TABLE "cash_week_closings" ADD CONSTRAINT "cash_week_closings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Numerações: o contador da empresa 1 continua de onde a sequência global parou.
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'commercial_orders', GREATEST(
  COALESCE((SELECT MAX("number") FROM "commercial_orders"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "commercial_orders_number_seq"));
ALTER TABLE "commercial_orders" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "commercial_orders_number_seq";
DROP INDEX "commercial_orders_number_key";
CREATE UNIQUE INDEX "commercial_orders_company_id_number_key" ON "commercial_orders"("company_id", "number");
CREATE TRIGGER "commercial_orders_company_number" BEFORE INSERT ON "commercial_orders"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'pickup_requests', GREATEST(
  COALESCE((SELECT MAX("number") FROM "pickup_requests"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "pickup_requests_number_seq"));
ALTER TABLE "pickup_requests" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "pickup_requests_number_seq";
DROP INDEX "pickup_requests_number_key";
CREATE UNIQUE INDEX "pickup_requests_company_id_number_key" ON "pickup_requests"("company_id", "number");
CREATE TRIGGER "pickup_requests_company_number" BEFORE INSERT ON "pickup_requests"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'receipts', GREATEST(
  COALESCE((SELECT MAX("number") FROM "receipts"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "receipts_number_seq"));
ALTER TABLE "receipts" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "receipts_number_seq";
DROP INDEX "receipts_number_key";
CREATE UNIQUE INDEX "receipts_company_id_number_key" ON "receipts"("company_id", "number");
CREATE TRIGGER "receipts_company_number" BEFORE INSERT ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'piece_returns', GREATEST(
  COALESCE((SELECT MAX("number") FROM "piece_returns"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "piece_returns_number_seq"));
ALTER TABLE "piece_returns" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "piece_returns_number_seq";
DROP INDEX "piece_returns_number_key";
CREATE UNIQUE INDEX "piece_returns_company_id_number_key" ON "piece_returns"("company_id", "number");
CREATE TRIGGER "piece_returns_company_number" BEFORE INSERT ON "piece_returns"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'service_orders', GREATEST(
  COALESCE((SELECT MAX("number") FROM "service_orders"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "service_orders_number_seq"));
ALTER TABLE "service_orders" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "service_orders_number_seq";
DROP INDEX "service_orders_number_key";
CREATE UNIQUE INDEX "service_orders_company_id_number_key" ON "service_orders"("company_id", "number");
CREATE TRIGGER "service_orders_company_number" BEFORE INSERT ON "service_orders"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'measurements', GREATEST(
  COALESCE((SELECT MAX("number") FROM "measurements"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "measurements_number_seq"));
ALTER TABLE "measurements" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "measurements_number_seq";
DROP INDEX "measurements_number_key";
CREATE UNIQUE INDEX "measurements_company_id_number_key" ON "measurements"("company_id", "number");
CREATE TRIGGER "measurements_company_number" BEFORE INSERT ON "measurements"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'stock_items', GREATEST(
  COALESCE((SELECT MAX("number") FROM "stock_items"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "stock_items_number_seq"));
ALTER TABLE "stock_items" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "stock_items_number_seq";
DROP INDEX "stock_items_number_key";
CREATE UNIQUE INDEX "stock_items_company_id_number_key" ON "stock_items"("company_id", "number");
CREATE TRIGGER "stock_items_company_number" BEFORE INSERT ON "stock_items"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'purchase_orders', GREATEST(
  COALESCE((SELECT MAX("number") FROM "purchase_orders"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "purchase_orders_number_seq"));
ALTER TABLE "purchase_orders" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "purchase_orders_number_seq";
DROP INDEX "purchase_orders_number_key";
CREATE UNIQUE INDEX "purchase_orders_company_id_number_key" ON "purchase_orders"("company_id", "number");
CREATE TRIGGER "purchase_orders_company_number" BEFORE INSERT ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'material_receipts', GREATEST(
  COALESCE((SELECT MAX("number") FROM "material_receipts"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "material_receipts_number_seq"));
ALTER TABLE "material_receipts" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "material_receipts_number_seq";
DROP INDEX "material_receipts_number_key";
CREATE UNIQUE INDEX "material_receipts_company_id_number_key" ON "material_receipts"("company_id", "number");
CREATE TRIGGER "material_receipts_company_number" BEFORE INSERT ON "material_receipts"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'material_arrivals', GREATEST(
  COALESCE((SELECT MAX("number") FROM "material_arrivals"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "material_arrivals_number_seq"));
ALTER TABLE "material_arrivals" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "material_arrivals_number_seq";
DROP INDEX "material_arrivals_number_key";
CREATE UNIQUE INDEX "material_arrivals_company_id_number_key" ON "material_arrivals"("company_id", "number");
CREATE TRIGGER "material_arrivals_company_number" BEFORE INSERT ON "material_arrivals"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'production_tasks', GREATEST(
  COALESCE((SELECT MAX("number") FROM "production_tasks"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "production_tasks_number_seq"));
ALTER TABLE "production_tasks" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "production_tasks_number_seq";
DROP INDEX "production_tasks_number_key";
CREATE UNIQUE INDEX "production_tasks_company_id_number_key" ON "production_tasks"("company_id", "number");
CREATE TRIGGER "production_tasks_company_number" BEFORE INSERT ON "production_tasks"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'reschedule_proposals', GREATEST(
  COALESCE((SELECT MAX("number") FROM "reschedule_proposals"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "reschedule_proposals_number_seq"));
ALTER TABLE "reschedule_proposals" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "reschedule_proposals_number_seq";
DROP INDEX "reschedule_proposals_number_key";
CREATE UNIQUE INDEX "reschedule_proposals_company_id_number_key" ON "reschedule_proposals"("company_id", "number");
CREATE TRIGGER "reschedule_proposals_company_number" BEFORE INSERT ON "reschedule_proposals"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'help_requests', GREATEST(
  COALESCE((SELECT MAX("number") FROM "help_requests"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "help_requests_number_seq"));
ALTER TABLE "help_requests" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "help_requests_number_seq";
DROP INDEX "help_requests_number_key";
CREATE UNIQUE INDEX "help_requests_company_id_number_key" ON "help_requests"("company_id", "number");
CREATE TRIGGER "help_requests_company_number" BEFORE INSERT ON "help_requests"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'production_issues', GREATEST(
  COALESCE((SELECT MAX("number") FROM "production_issues"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "production_issues_number_seq"));
ALTER TABLE "production_issues" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "production_issues_number_seq";
DROP INDEX "production_issues_number_key";
CREATE UNIQUE INDEX "production_issues_company_id_number_key" ON "production_issues"("company_id", "number");
CREATE TRIGGER "production_issues_company_number" BEFORE INSERT ON "production_issues"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'labor_reviews', GREATEST(
  COALESCE((SELECT MAX("number") FROM "labor_reviews"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "labor_reviews_number_seq"));
ALTER TABLE "labor_reviews" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "labor_reviews_number_seq";
DROP INDEX "labor_reviews_number_key";
CREATE UNIQUE INDEX "labor_reviews_company_id_number_key" ON "labor_reviews"("company_id", "number");
CREATE TRIGGER "labor_reviews_company_number" BEFORE INSERT ON "labor_reviews"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'attendance_leaves', GREATEST(
  COALESCE((SELECT MAX("number") FROM "attendance_leaves"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "attendance_leaves_number_seq"));
ALTER TABLE "attendance_leaves" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "attendance_leaves_number_seq";
DROP INDEX "attendance_leaves_number_key";
CREATE UNIQUE INDEX "attendance_leaves_company_id_number_key" ON "attendance_leaves"("company_id", "number");
CREATE TRIGGER "attendance_leaves_company_number" BEFORE INSERT ON "attendance_leaves"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'quality_inspections', GREATEST(
  COALESCE((SELECT MAX("number") FROM "quality_inspections"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "quality_inspections_number_seq"));
ALTER TABLE "quality_inspections" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "quality_inspections_number_seq";
DROP INDEX "quality_inspections_number_key";
CREATE UNIQUE INDEX "quality_inspections_company_id_number_key" ON "quality_inspections"("company_id", "number");
CREATE TRIGGER "quality_inspections_company_number" BEFORE INSERT ON "quality_inspections"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'packaging_records', GREATEST(
  COALESCE((SELECT MAX("number") FROM "packaging_records"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "packaging_records_number_seq"));
ALTER TABLE "packaging_records" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "packaging_records_number_seq";
DROP INDEX "packaging_records_number_key";
CREATE UNIQUE INDEX "packaging_records_company_id_number_key" ON "packaging_records"("company_id", "number");
CREATE TRIGGER "packaging_records_company_number" BEFORE INSERT ON "packaging_records"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'deliveries', GREATEST(
  COALESCE((SELECT MAX("number") FROM "deliveries"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "deliveries_number_seq"));
ALTER TABLE "deliveries" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "deliveries_number_seq";
DROP INDEX "deliveries_number_key";
CREATE UNIQUE INDEX "deliveries_company_id_number_key" ON "deliveries"("company_id", "number");
CREATE TRIGGER "deliveries_company_number" BEFORE INSERT ON "deliveries"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'logistics_occurrences', GREATEST(
  COALESCE((SELECT MAX("number") FROM "logistics_occurrences"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "logistics_occurrences_number_seq"));
ALTER TABLE "logistics_occurrences" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "logistics_occurrences_number_seq";
DROP INDEX "logistics_occurrences_number_key";
CREATE UNIQUE INDEX "logistics_occurrences_company_id_number_key" ON "logistics_occurrences"("company_id", "number");
CREATE TRIGGER "logistics_occurrences_company_number" BEFORE INSERT ON "logistics_occurrences"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'quotes', GREATEST(
  COALESCE((SELECT MAX("number") FROM "quotes"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "quotes_number_seq"));
ALTER TABLE "quotes" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "quotes_number_seq";
DROP INDEX "quotes_number_key";
CREATE UNIQUE INDEX "quotes_company_id_number_key" ON "quotes"("company_id", "number");
CREATE TRIGGER "quotes_company_number" BEFORE INSERT ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'customer_receivables', GREATEST(
  COALESCE((SELECT MAX("number") FROM "customer_receivables"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "customer_receivables_number_seq"));
ALTER TABLE "customer_receivables" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "customer_receivables_number_seq";
DROP INDEX "customer_receivables_number_key";
CREATE UNIQUE INDEX "customer_receivables_company_id_number_key" ON "customer_receivables"("company_id", "number");
CREATE TRIGGER "customer_receivables_company_number" BEFORE INSERT ON "customer_receivables"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'production_payables', GREATEST(
  COALESCE((SELECT MAX("number") FROM "production_payables"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "production_payables_number_seq"));
ALTER TABLE "production_payables" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "production_payables_number_seq";
DROP INDEX "production_payables_number_key";
CREATE UNIQUE INDEX "production_payables_company_id_number_key" ON "production_payables"("company_id", "number");
CREATE TRIGGER "production_payables_company_number" BEFORE INSERT ON "production_payables"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'logistics_costs', GREATEST(
  COALESCE((SELECT MAX("number") FROM "logistics_costs"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "logistics_costs_number_seq"));
ALTER TABLE "logistics_costs" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "logistics_costs_number_seq";
DROP INDEX "logistics_costs_number_key";
CREATE UNIQUE INDEX "logistics_costs_company_id_number_key" ON "logistics_costs"("company_id", "number");
CREATE TRIGGER "logistics_costs_company_number" BEFORE INSERT ON "logistics_costs"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'account_payables', GREATEST(
  COALESCE((SELECT MAX("number") FROM "account_payables"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "account_payables_number_seq"));
ALTER TABLE "account_payables" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "account_payables_number_seq";
DROP INDEX "account_payables_number_key";
CREATE UNIQUE INDEX "account_payables_company_id_number_key" ON "account_payables"("company_id", "number");
CREATE TRIGGER "account_payables_company_number" BEFORE INSERT ON "account_payables"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'operational_expenses', GREATEST(
  COALESCE((SELECT MAX("number") FROM "operational_expenses"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "operational_expenses_number_seq"));
ALTER TABLE "operational_expenses" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "operational_expenses_number_seq";
DROP INDEX "operational_expenses_number_key";
CREATE UNIQUE INDEX "operational_expenses_company_id_number_key" ON "operational_expenses"("company_id", "number");
CREATE TRIGGER "operational_expenses_company_number" BEFORE INSERT ON "operational_expenses"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'value_change_requests', GREATEST(
  COALESCE((SELECT MAX("number") FROM "value_change_requests"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "value_change_requests_number_seq"));
ALTER TABLE "value_change_requests" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "value_change_requests_number_seq";
DROP INDEX "value_change_requests_number_key";
CREATE UNIQUE INDEX "value_change_requests_company_id_number_key" ON "value_change_requests"("company_id", "number");
CREATE TRIGGER "value_change_requests_company_number" BEFORE INSERT ON "value_change_requests"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'weekly_closing_confirmations', GREATEST(
  COALESCE((SELECT MAX("number") FROM "weekly_closing_confirmations"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "weekly_closing_confirmations_number_seq"));
ALTER TABLE "weekly_closing_confirmations" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "weekly_closing_confirmations_number_seq";
DROP INDEX "weekly_closing_confirmations_number_key";
CREATE UNIQUE INDEX "weekly_closing_confirmations_company_id_number_key" ON "weekly_closing_confirmations"("company_id", "number");
CREATE TRIGGER "weekly_closing_confirmations_company_number" BEFORE INSERT ON "weekly_closing_confirmations"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'closing_payments', GREATEST(
  COALESCE((SELECT MAX("number") FROM "closing_payments"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "closing_payments_number_seq"));
ALTER TABLE "closing_payments" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "closing_payments_number_seq";
DROP INDEX "closing_payments_number_key";
CREATE UNIQUE INDEX "closing_payments_company_id_number_key" ON "closing_payments"("company_id", "number");
CREATE TRIGGER "closing_payments_company_number" BEFORE INSERT ON "closing_payments"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();
INSERT INTO "company_counters" ("company_id", "key", "last_value")
SELECT 1, 'contracts', GREATEST(
  COALESCE((SELECT MAX("number") FROM "contracts"), 0),
  (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "contracts_number_seq"));
ALTER TABLE "contracts" ALTER COLUMN "number" DROP DEFAULT;
DROP SEQUENCE "contracts_number_seq";
DROP INDEX "contracts_number_key";
CREATE UNIQUE INDEX "contracts_company_id_number_key" ON "contracts"("company_id", "number");
CREATE TRIGGER "contracts_company_number" BEFORE INSERT ON "contracts"
  FOR EACH ROW EXECUTE FUNCTION assign_company_number();

-- 6. Outras unicidades que passam a valer por empresa.
DROP INDEX "devices_name_key";
CREATE UNIQUE INDEX "devices_company_id_name_key" ON "devices"("company_id", "name");
DROP INDEX "roles_key_key";
CREATE UNIQUE INDEX "roles_company_id_key_key" ON "roles"("company_id", "key");
DROP INDEX "roles_name_key";
CREATE UNIQUE INDEX "roles_company_id_name_key" ON "roles"("company_id", "name");
DROP INDEX "company_holidays_date_key";
CREATE UNIQUE INDEX "company_holidays_company_id_date_key" ON "company_holidays"("company_id", "date");
DROP INDEX "stock_items_spec_key_key";
CREATE UNIQUE INDEX "stock_items_company_id_spec_key_key" ON "stock_items"("company_id", "spec_key");
DROP INDEX "production_plans_week_start_key";
CREATE UNIQUE INDEX "production_plans_company_id_week_start_key" ON "production_plans"("company_id", "week_start");
DROP INDEX "item_locations_key_key";
CREATE UNIQUE INDEX "item_locations_company_id_key_key" ON "item_locations"("company_id", "key");
DROP INDEX "weekly_closings_week_start_key";
CREATE UNIQUE INDEX "weekly_closings_company_id_week_start_key" ON "weekly_closings"("company_id", "week_start");
DROP INDEX "game_spaces_key_key";
CREATE UNIQUE INDEX "game_spaces_company_id_key_key" ON "game_spaces"("company_id", "key");
DROP INDEX "integration_connections_provider_key_key";
CREATE UNIQUE INDEX "integration_connections_company_id_provider_key_key" ON "integration_connections"("company_id", "provider_key");
DROP INDEX "cash_week_closings_week_start_key";
CREATE UNIQUE INDEX "cash_week_closings_company_id_week_start_key" ON "cash_week_closings"("company_id", "week_start");
-- Orçamentos: uma configuração por empresa (o id deixa de ser fixo em 1).
CREATE SEQUENCE "quote_settings_id_seq" AS INTEGER OWNED BY "quote_settings"."id";
SELECT setval('"quote_settings_id_seq"', GREATEST((SELECT MAX("id") FROM "quote_settings"), 1));
ALTER TABLE "quote_settings" ALTER COLUMN "id" SET DEFAULT nextval('"quote_settings_id_seq"');
CREATE UNIQUE INDEX "quote_settings_company_id_key" ON "quote_settings"("company_id");
DROP INDEX "customers_document_unique";
CREATE UNIQUE INDEX "customers_document_unique" ON "customers"("company_id", "document") WHERE "document" IS NOT NULL;
DROP INDEX "inventory_categories_name_key";
CREATE UNIQUE INDEX "inventory_categories_name_key" ON "inventory_categories"("company_id", lower("name"::text));
DROP INDEX "fabric_rolls_code_key";
CREATE UNIQUE INDEX "fabric_rolls_code_key" ON "fabric_rolls"("company_id", lower("code"::text));
-- Jogo, escritório e conexões (64c238f): unicidades compostas e parciais por empresa.
DROP INDEX "integration_webhook_events_provider_key_event_id_key";
CREATE UNIQUE INDEX "integration_webhook_events_company_id_provider_key_event_id_key" ON "integration_webhook_events"("company_id", "provider_key", "event_id");
DROP INDEX "inbox_conversations_channel_external_thread_id_key";
CREATE UNIQUE INDEX "inbox_conversations_company_id_channel_external_thread_id_key" ON "inbox_conversations"("company_id", "channel", "external_thread_id");
DROP INDEX "contract_templates_key_version_key";
CREATE UNIQUE INDEX "contract_templates_company_id_key_version_key" ON "contract_templates"("company_id", "key", "version");
DROP INDEX "card_settlements_provider_external_id_key";
CREATE UNIQUE INDEX "card_settlements_company_id_provider_external_id_key" ON "card_settlements"("company_id", "provider", "external_id");
DROP INDEX "contract_templates_one_current";
CREATE UNIQUE INDEX "contract_templates_one_current" ON "contract_templates"("company_id", "key") WHERE "current";
DROP INDEX "bank_accounts_one_cash_default";
CREATE UNIQUE INDEX "bank_accounts_one_cash_default" ON "bank_accounts"("company_id", "cash_default") WHERE "cash_default";
