-- Reformulação, Fase 1 — materiais simples na OS, estoque simples e entrega direta pela OS.
-- Mudança só ADITIVA: tabelas novas e vazias, uma coluna nova com padrão (deliveries.origin) e a
-- ampliação da lista de origens aceitas no livro de custos (uma origem a mais). Nada é apagado,
-- convertido ou reescrito; a versão anterior da aplicação ignora as tabelas novas, nunca grava a
-- origem nova e lê "deliveries" como antes (toda entrega existente fica com origem LOGISTICA).

-- ============================================================ estoque simples (independente da OS)
CREATE TABLE "inventory_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);
-- Nome único sem diferenciar maiúsculas (evita "Tecidos" e "tecidos").
CREATE UNIQUE INDEX "inventory_categories_name_key" ON "inventory_categories"(lower("name"));
ALTER TABLE "inventory_categories" ADD CONSTRAINT "inventory_categories_name_filled"
  CHECK (length(btrim("name")) >= 2);

CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "category_id" UUID,
    "unit" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reference_cost_cents" INTEGER,
    "location" VARCHAR(120),
    "notes" VARCHAR(500),
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_items_category_id_idx" ON "inventory_items"("category_id");
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_values" CHECK (
  "quantity" >= 0 AND ("reference_cost_cents" IS NULL OR "reference_cost_cents" >= 0)
  AND length(btrim("name")) >= 2 AND length(btrim("unit")) >= 1);

-- Rolos de tecido: metragem atualizada à mão; sem corte, lote, reserva ou consumo automático.
CREATE TABLE "fabric_rolls" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "color" VARCHAR(60),
    "reference" VARCHAR(80),
    "meters" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "notes" VARCHAR(500),
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fabric_rolls_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fabric_rolls_code_key" ON "fabric_rolls"(lower("code"));
CREATE INDEX "fabric_rolls_item_id_idx" ON "fabric_rolls"("item_id");
ALTER TABLE "fabric_rolls" ADD CONSTRAINT "fabric_rolls_values"
  CHECK ("meters" >= 0 AND length(btrim("code")) >= 1);

-- Ajustes manuais de quantidade (valor anterior e novo, quem, quando, motivo). Imutáveis.
CREATE TABLE "inventory_adjustments" (
    "id" UUID NOT NULL,
    "item_id" UUID,
    "roll_id" UUID,
    "previous_quantity" DECIMAL(12,3) NOT NULL,
    "new_quantity" DECIMAL(12,3) NOT NULL,
    "reason" VARCHAR(500),
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_adjustments_item_id_created_at_idx" ON "inventory_adjustments"("item_id", "created_at");
CREATE INDEX "inventory_adjustments_roll_id_created_at_idx" ON "inventory_adjustments"("roll_id", "created_at");
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_target"
  CHECK ((("item_id" IS NOT NULL)::int + ("roll_id" IS NOT NULL)::int) = 1
    AND "previous_quantity" >= 0 AND "new_quantity" >= 0);

-- ============================================================ materiais necessários da OS
-- Lista simples: "comprado" e "na oficina" independentes; custo opcional (NULL = não informado,
-- nunca zero). Remoção é lógica (removed_at): o histórico e a auditoria continuam íntegros.
CREATE TABLE "service_order_materials" (
    "id" UUID NOT NULL,
    "service_order_id" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "category_id" UUID,
    "inventory_item_id" UUID,
    "quantity" DECIMAL(12,3),
    "unit" VARCHAR(20),
    "notes" VARCHAR(500),
    "purchased" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "cost_cents" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_id" UUID,
    "reconciliation" VARCHAR(20),
    "linked_purchase_item_id" UUID,
    "linked_cost_id" UUID,
    "reconciled_by_id" UUID,
    "reconciled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_order_materials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "service_order_materials_service_order_id_idx" ON "service_order_materials"("service_order_id");
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_values" CHECK (
  length(btrim("description")) >= 2
  AND ("quantity" IS NULL OR "quantity" > 0)
  AND ("cost_cents" IS NULL OR "cost_cents" >= 0));
-- Conciliação explícita com o custo formal (nunca deduzida por valores iguais): VINCULADO aponta
-- exatamente UM registro formal (item de compra exclusiva ou lançamento formal do livro de custos);
-- DISTINTO e "pendente" (NULL) não apontam nenhum.
CREATE INDEX "service_order_materials_linked_purchase_item_id_idx" ON "service_order_materials"("linked_purchase_item_id");
CREATE INDEX "service_order_materials_linked_cost_id_idx" ON "service_order_materials"("linked_cost_id");
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_reconciliation" CHECK (
  ("reconciliation" IS NULL AND "linked_purchase_item_id" IS NULL AND "linked_cost_id" IS NULL)
  OR ("reconciliation" = 'DISTINTO' AND "linked_purchase_item_id" IS NULL AND "linked_cost_id" IS NULL)
  OR ("reconciliation" = 'VINCULADO'
      AND (("linked_purchase_item_id" IS NULL) <> ("linked_cost_id" IS NULL))));

-- ============================================================ chaves estrangeiras
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "fabric_rolls" ADD CONSTRAINT "fabric_rolls_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fabric_rolls" ADD CONSTRAINT "fabric_rolls_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_roll_id_fkey" FOREIGN KEY ("roll_id") REFERENCES "fabric_rolls"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "service_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_linked_purchase_item_id_fkey" FOREIGN KEY ("linked_purchase_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_linked_cost_id_fkey" FOREIGN KEY ("linked_cost_id") REFERENCES "service_order_costs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_order_materials" ADD CONSTRAINT "service_order_materials_reconciled_by_id_fkey" FOREIGN KEY ("reconciled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Histórico de ajustes nunca muda nem some.
CREATE TRIGGER "inventory_adjustments_immutable" BEFORE UPDATE OR DELETE ON "inventory_adjustments"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- ============================================================ entrega direta pela OS
-- Origem da entrega: LOGISTICA (todas as existentes) ou DIRETA (confirmada pela OS, sem viagem).
ALTER TABLE "deliveries" ADD COLUMN "origin" VARCHAR(20) NOT NULL DEFAULT 'LOGISTICA';
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_origin" CHECK ("origin" IN ('LOGISTICA', 'DIRETA'));

-- ============================================================ livro de custos: origem nova
-- MATERIAL_OS = custo informado no material da OS (marcado como comprado). A lista só cresce: as
-- origens anteriores continuam aceitas e nenhuma linha existente muda.
ALTER TABLE "service_order_costs" DROP CONSTRAINT "service_order_costs_kind";
ALTER TABLE "service_order_costs" ADD CONSTRAINT "service_order_costs_kind" CHECK (
  "category" IN ('MATERIAL', 'OUTRO_VARIAVEL')
  AND "source" IN ('COMPRA_EXCLUSIVA', 'ESTORNO_COMPRA', 'SAIDA_ESTOQUE', 'DEVOLUCAO_ESTOQUE', 'SOBRA_SAIDA', 'SOBRA_ENTRADA', 'AJUSTE_MANUAL', 'MATERIAL_OS'));
