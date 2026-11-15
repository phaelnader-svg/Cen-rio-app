-- Jogo de gestão (empresa virtual): planta editável, áreas, estações, endereçamento físico do
-- estoque e agentes do escritório. Puramente aditiva: nenhuma tabela existente é alterada.

-- CreateTable
CREATE TABLE "game_spaces" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "width_cm" INTEGER NOT NULL,
    "depth_cm" INTEGER NOT NULL,
    "grid_cm" INTEGER NOT NULL DEFAULT 50,
    "doc" JSONB NOT NULL DEFAULT '{}',
    "illustrative" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_areas" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "function" VARCHAR(30) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "x_cm" INTEGER NOT NULL,
    "y_cm" INTEGER NOT NULL,
    "w_cm" INTEGER NOT NULL,
    "d_cm" INTEGER NOT NULL,
    "color" VARCHAR(9),
    "item_location_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_stations" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "area_id" UUID,
    "kind" VARCHAR(30) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "x_cm" INTEGER NOT NULL,
    "y_cm" INTEGER NOT NULL,
    "w_cm" INTEGER NOT NULL,
    "d_cm" INTEGER NOT NULL,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "activities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_station_assignees" (
    "station_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_station_assignees_pkey" PRIMARY KEY ("station_id","user_id")
);

-- CreateTable
CREATE TABLE "game_storage_units" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "area_id" UUID,
    "kind" VARCHAR(30) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "x_cm" INTEGER NOT NULL,
    "y_cm" INTEGER NOT NULL,
    "w_cm" INTEGER NOT NULL,
    "d_cm" INTEGER NOT NULL,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_storage_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_storage_slots" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_storage_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_slot_materials" (
    "slot_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_slot_materials_pkey" PRIMARY KEY ("slot_id","stock_item_id")
);

-- CreateTable
CREATE TABLE "game_layout_revisions" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_layout_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agents" (
    "id" UUID NOT NULL,
    "desk_station_id" UUID,
    "name" VARCHAR(60) NOT NULL,
    "role_key" VARCHAR(40) NOT NULL,
    "role_label" VARCHAR(80) NOT NULL,
    "instructions" VARCHAR(4000) NOT NULL,
    "data_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action_policies" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(15) NOT NULL DEFAULT 'ATIVO',
    "color" VARCHAR(9) NOT NULL DEFAULT '#7c3aed',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_messages" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID,
    "author" VARCHAR(10) NOT NULL,
    "content" VARCHAR(20000) NOT NULL,
    "references" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_proposals" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "detail" VARCHAR(4000) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_spaces_key_key" ON "game_spaces"("key");

-- CreateIndex
CREATE INDEX "game_areas_space_id_idx" ON "game_areas"("space_id");

-- CreateIndex
CREATE INDEX "game_stations_space_id_idx" ON "game_stations"("space_id");

-- CreateIndex
CREATE INDEX "game_station_assignees_user_id_idx" ON "game_station_assignees"("user_id");

-- CreateIndex
CREATE INDEX "game_storage_units_space_id_idx" ON "game_storage_units"("space_id");

-- CreateIndex
CREATE INDEX "game_storage_slots_unit_id_idx" ON "game_storage_slots"("unit_id");

-- CreateIndex
CREATE INDEX "game_slot_materials_stock_item_id_idx" ON "game_slot_materials"("stock_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_layout_revisions_space_id_version_key" ON "game_layout_revisions"("space_id", "version");

-- CreateIndex
CREATE INDEX "ai_agent_messages_agent_id_created_at_idx" ON "ai_agent_messages"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_agent_proposals_agent_id_status_idx" ON "ai_agent_proposals"("agent_id", "status");

-- AddForeignKey
ALTER TABLE "game_areas" ADD CONSTRAINT "game_areas_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "game_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_stations" ADD CONSTRAINT "game_stations_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "game_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_stations" ADD CONSTRAINT "game_stations_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "game_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_station_assignees" ADD CONSTRAINT "game_station_assignees_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "game_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_storage_units" ADD CONSTRAINT "game_storage_units_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "game_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_storage_units" ADD CONSTRAINT "game_storage_units_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "game_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_storage_slots" ADD CONSTRAINT "game_storage_slots_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "game_storage_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_slot_materials" ADD CONSTRAINT "game_slot_materials_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "game_storage_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_layout_revisions" ADD CONSTRAINT "game_layout_revisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "game_spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_desk_station_id_fkey" FOREIGN KEY ("desk_station_id") REFERENCES "game_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_messages" ADD CONSTRAINT "ai_agent_messages_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "ai_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Vínculos com o cadastro oficial (sem relação Prisma, para não alterar modelos existentes).
ALTER TABLE "game_areas" ADD CONSTRAINT "game_areas_item_location_fkey"
  FOREIGN KEY ("item_location_id") REFERENCES "item_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "game_station_assignees" ADD CONSTRAINT "game_station_assignees_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_slot_materials" ADD CONSTRAINT "game_slot_materials_stock_item_fkey"
  FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "game_spaces" ADD CONSTRAINT "game_spaces_updated_by_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "game_layout_revisions" ADD CONSTRAINT "game_layout_revisions_created_by_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_created_by_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agent_messages" ADD CONSTRAINT "ai_agent_messages_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_decided_by_fkey"
  FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Regras de coerência.
ALTER TABLE "game_spaces" ADD CONSTRAINT "game_spaces_dims" CHECK (
  "width_cm" BETWEEN 100 AND 20000 AND "depth_cm" BETWEEN 100 AND 20000
  AND "grid_cm" BETWEEN 5 AND 200 AND "version" > 0
  AND "kind" IN ('OFICINA', 'ESCRITORIO', 'OUTRO'));
ALTER TABLE "game_areas" ADD CONSTRAINT "game_areas_dims" CHECK ("w_cm" > 0 AND "d_cm" > 0);
ALTER TABLE "game_stations" ADD CONSTRAINT "game_stations_dims" CHECK (
  "w_cm" > 0 AND "d_cm" > 0 AND "rotation" IN (0, 90, 180, 270));
ALTER TABLE "game_storage_units" ADD CONSTRAINT "game_storage_units_dims" CHECK (
  "w_cm" > 0 AND "d_cm" > 0 AND "rotation" IN (0, 90, 180, 270));
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_status" CHECK (
  "status" IN ('ATIVO', 'PAUSADO', 'DESATIVADO') AND "version" > 0);
ALTER TABLE "ai_agent_messages" ADD CONSTRAINT "ai_agent_messages_author" CHECK (
  "author" IN ('USUARIO', 'AGENTE'));
ALTER TABLE "ai_agent_proposals" ADD CONSTRAINT "ai_agent_proposals_status" CHECK (
  "status" IN ('PENDENTE', 'APROVADA', 'REJEITADA', 'EXECUTADA_TESTE')
  AND ("status" = 'PENDENTE') = ("decided_at" IS NULL));
-- Uma área física do sistema é representada por no máximo uma área ativa do jogo.
CREATE UNIQUE INDEX "game_areas_item_location_active" ON "game_areas"("item_location_id")
  WHERE "active" AND "item_location_id" IS NOT NULL;

-- Histórico de plantas e conversas: imutáveis (mesma função da auditoria).
CREATE TRIGGER "game_layout_revisions_immutable"
  BEFORE UPDATE OR DELETE ON "game_layout_revisions"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
CREATE TRIGGER "ai_agent_messages_immutable"
  BEFORE UPDATE OR DELETE ON "ai_agent_messages"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();
