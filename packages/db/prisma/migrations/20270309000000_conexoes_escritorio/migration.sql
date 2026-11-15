-- Central de Conexões, caixa de entrada (WhatsApp, Instagram, Messenger), ações dos agentes e
-- escritório financeiro (contratos, cobranças, notas, banco, pagamentos, maquininha, cotações e
-- documentos contábeis). Aditiva: só tabelas novas e duas colunas novas em ai_agents (tabela do
-- jogo). Chaves estrangeiras com NO ACTION na atualização (ids uuid nunca mudam).

-- AlterTable
ALTER TABLE "ai_agents" ADD COLUMN     "auto_send_rules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "channel_policies" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL,
    "provider_key" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DESCONECTADA',
    "mode" VARCHAR(20) NOT NULL DEFAULT 'PRODUCAO',
    "account_label" VARCHAR(160),
    "account_id" VARCHAR(160),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret_enc" TEXT,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(1000),
    "connected_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_oauth_states" (
    "state" VARCHAR(80) NOT NULL,
    "provider_key" VARCHAR(40) NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "integration_webhook_events" (
    "id" UUID NOT NULL,
    "provider_key" VARCHAR(40) NOT NULL,
    "event_id" VARCHAR(200) NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "result" VARCHAR(500),

    CONSTRAINT "integration_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_conversations" (
    "id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "external_thread_id" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(160),
    "contact_handle" VARCHAR(160),
    "customer_id" UUID,
    "service_order_id" UUID,
    "order_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'ABERTA',
    "human_takeover" BOOLEAN NOT NULL DEFAULT false,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "unread" INTEGER NOT NULL DEFAULT 0,
    "summary" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "external_id" VARCHAR(200),
    "kind" VARCHAR(20) NOT NULL DEFAULT 'TEXT',
    "text" VARCHAR(4096),
    "media" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL,
    "error" VARCHAR(500),
    "agent_id" UUID,
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_actions" (
    "id" UUID NOT NULL,
    "agent_id" UUID,
    "channel" VARCHAR(30) NOT NULL,
    "account_label" VARCHAR(160),
    "kind" VARCHAR(40) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "content" VARCHAR(4096),
    "status" VARCHAR(20) NOT NULL,
    "approved_by_id" UUID,
    "ref" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_posts" (
    "id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'INSTAGRAM',
    "caption" VARCHAR(2200) NOT NULL,
    "media_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scheduled_for" TIMESTAMPTZ(3),
    "status" VARCHAR(20) NOT NULL DEFAULT 'RASCUNHO',
    "external_id" VARCHAR(160),
    "agent_id" UUID,
    "approved_by_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marketing_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_templates" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "version" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "body" TEXT NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "service_order_id" UUID,
    "template_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "body" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RASCUNHO',
    "signers" JSONB NOT NULL DEFAULT '[]',
    "provider" VARCHAR(40),
    "provider_envelope_id" VARCHAR(160),
    "sent_at" TIMESTAMPTZ(3),
    "signed_at" TIMESTAMPTZ(3),
    "signed_file_id" UUID,
    "supersedes_id" UUID,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_charges" (
    "id" UUID NOT NULL,
    "receivable_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_charge_id" VARCHAR(160) NOT NULL,
    "billing_type" VARCHAR(20) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "installments" INTEGER,
    "due_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ABERTA',
    "pix_payload" TEXT,
    "payment_url" VARCHAR(500),
    "paid_at" TIMESTAMPTZ(3),
    "payment_id" UUID,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_profiles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "document_kind" VARCHAR(10) NOT NULL,
    "service_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "service_code" VARCHAR(20),
    "municipal_tax_code" VARCHAR(20),
    "cnae" VARCHAR(20),
    "iss_rate_percent" DECIMAL(5,2),
    "ncm" VARCHAR(10),
    "cfop" VARCHAR(10),
    "description_template" VARCHAR(1000) NOT NULL,
    "validated_by_accountant" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "service_order_id" UUID,
    "profile_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'RASCUNHO',
    "customer_data" JSONB NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "fiscal_data" JSONB NOT NULL DEFAULT '{}',
    "provider" VARCHAR(40),
    "provider_ref" VARCHAR(160),
    "number" VARCHAR(40),
    "access_key" VARCHAR(80),
    "files" JSONB NOT NULL DEFAULT '[]',
    "rejection_reason" VARCHAR(1000),
    "issued_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "approved_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "bank" VARCHAR(80) NOT NULL,
    "masked" VARCHAR(80),
    "provider" VARCHAR(20) NOT NULL DEFAULT 'IMPORTACAO',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "fit_id" VARCHAR(160) NOT NULL,
    "date" DATE NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "reconciled_kind" VARCHAR(20),
    "reconciled_ref" UUID,
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciled_by_id" UUID,
    "source" VARCHAR(10) NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "payable_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "beneficiary" VARCHAR(160) NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "method" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PREPARADO',
    "provider_ref" VARCHAR(160),
    "proof_file_id" UUID,
    "confirmed_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_settlements" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "external_id" VARCHAR(160) NOT NULL,
    "sale_date" DATE NOT NULL,
    "gross_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "net_cents" INTEGER NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "expected_date" DATE NOT NULL,
    "settled_at" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_quotes" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "material_requirement_ids" UUID[],
    "description" VARCHAR(300) NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "lead_days" INTEGER,
    "notes" VARCHAR(500),
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_documents" (
    "id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "file_id" UUID,
    "ref_type" VARCHAR(40),
    "ref_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_provider_key_key" ON "integration_connections"("provider_key");

-- CreateIndex
CREATE UNIQUE INDEX "integration_webhook_events_provider_key_event_id_key" ON "integration_webhook_events"("provider_key", "event_id");

-- CreateIndex
CREATE INDEX "inbox_conversations_status_last_message_at_idx" ON "inbox_conversations"("status", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_conversations_channel_external_thread_id_key" ON "inbox_conversations"("channel", "external_thread_id");

-- CreateIndex
CREATE INDEX "inbox_messages_conversation_id_created_at_idx" ON "inbox_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_messages_conversation_id_external_id_key" ON "inbox_messages"("conversation_id", "external_id");

-- CreateIndex
CREATE INDEX "agent_actions_agent_id_created_at_idx" ON "agent_actions"("agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "contract_templates_key_version_key" ON "contract_templates"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_number_key" ON "contracts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_provider_envelope_id_key" ON "contracts"("provider_envelope_id");

-- CreateIndex
CREATE INDEX "contracts_order_id_idx" ON "contracts"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_charges_provider_charge_id_key" ON "payment_charges"("provider_charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_charges_payment_id_key" ON "payment_charges"("payment_id");

-- CreateIndex
CREATE INDEX "payment_charges_receivable_id_idx" ON "payment_charges"("receivable_id");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_provider_ref_key" ON "fiscal_documents"("provider_ref");

-- CreateIndex
CREATE INDEX "fiscal_documents_order_id_idx" ON "fiscal_documents"("order_id");

-- CreateIndex
CREATE INDEX "bank_transactions_date_idx" ON "bank_transactions"("date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_account_id_fit_id_key" ON "bank_transactions"("account_id", "fit_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_ref_key" ON "payment_orders"("provider_ref");

-- CreateIndex
CREATE INDEX "payment_orders_payable_id_idx" ON "payment_orders"("payable_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_settlements_provider_external_id_key" ON "card_settlements"("provider", "external_id");

-- CreateIndex
CREATE INDEX "accounting_documents_month_idx" ON "accounting_documents"("month");

-- AddForeignKey
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL;

-- AddForeignKey
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE SET NULL;

-- AddForeignKey
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "inbox_conversations"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE SET NULL;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "contract_templates"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_receivable_id_fkey" FOREIGN KEY ("receivable_id") REFERENCES "customer_receivables"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "fiscal_profiles"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "account_payables"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT;

-- AddForeignKey
ALTER TABLE "purchase_quotes" ADD CONSTRAINT "purchase_quotes_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT;


-- Regras de coerência.
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_status" CHECK (
  "status" IN ('DESCONECTADA', 'CONECTADA', 'ERRO', 'PENDENTE') AND "mode" IN ('PRODUCAO', 'SANDBOX', 'TESTE_LOCAL'));
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_channel" CHECK (
  "channel" IN ('WHATSAPP', 'INSTAGRAM', 'MESSENGER') AND "unread" >= 0);
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_direction" CHECK ("direction" IN ('IN', 'OUT'));
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_amount" CHECK (
  "amount_cents" > 0 AND "status" IN ('ABERTA', 'PAGA', 'VENCIDA', 'CANCELADA', 'ESTORNADA'));
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amount" CHECK ("amount_cents" > 0);
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_status" CHECK (
  "status" IN ('RASCUNHO', 'ENVIADO', 'ASSINADO', 'RECUSADO', 'CANCELADO', 'SUBSTITUIDO'));
-- Uma cobrança aberta por conta a receber (cliques repetidos não geram duas).
CREATE UNIQUE INDEX "payment_charges_one_open" ON "payment_charges"("receivable_id") WHERE "status" = 'ABERTA';
-- Um contrato vigente por pedido.
CREATE UNIQUE INDEX "contracts_one_current" ON "contracts"("order_id")
  WHERE "status" IN ('RASCUNHO', 'ENVIADO', 'ASSINADO');
-- Uma versão vigente por modelo de contrato.
CREATE UNIQUE INDEX "contract_templates_one_current" ON "contract_templates"("key") WHERE "current";
-- Um pagamento preparado em aberto por conta a pagar.
CREATE UNIQUE INDEX "payment_orders_one_open" ON "payment_orders"("payable_id")
  WHERE "status" IN ('PREPARADO', 'AGUARDANDO_APP');

-- Histórico das ações dos agentes: somente inserção.
DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER agent_actions_immutable BEFORE UPDATE OR DELETE ON agent_actions FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation()';
END $$;
