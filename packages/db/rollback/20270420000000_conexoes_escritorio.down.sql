-- REVERSÃO MANUAL da migration 20270420000000_conexoes_escritorio. Uso somente com backup recente e
-- a aplicação PARADA, voltando ao código anterior. Remove as tabelas da Central de Conexões, da
-- caixa de entrada e do escritório financeiro do jogo. ATENÇÃO: cobranças, contratos e notas
-- registrados aqui deixam de existir; as baixas oficiais (customer_payments) e pagamentos já
-- registrados no financeiro permanecem.
BEGIN;
DROP TABLE IF EXISTS "accounting_documents", "purchase_quotes", "card_settlements", "payment_orders",
  "bank_transactions", "bank_accounts", "fiscal_documents", "fiscal_profiles", "payment_charges",
  "contracts", "contract_templates", "marketing_posts", "agent_actions", "inbox_messages",
  "inbox_conversations", "integration_webhook_events", "integration_oauth_states",
  "integration_connections";
ALTER TABLE "ai_agents" DROP COLUMN IF EXISTS "auto_send_rules", DROP COLUMN IF EXISTS "channel_policies";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270420000000_conexoes_escritorio';
COMMIT;
