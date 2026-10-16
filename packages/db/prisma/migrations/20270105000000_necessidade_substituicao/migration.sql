-- Compras e materiais sem duplicidade — Etapa 2: substituição e cancelamento de necessidades.
-- Migration ADITIVA e sem perda: nenhuma coluna existente é alterada ou removida; nenhuma compra,
-- recebimento, reserva, movimento, sobra ou custo é tocado. Backfill único e não interpretativo:
-- toda necessidade existente fica ATIVA (sem predecessora); duplicidades antigas NÃO são inferidas.

CREATE TYPE "material_requirement_status" AS ENUM ('ATIVA', 'SUBSTITUIDA', 'CANCELADA');

ALTER TABLE "material_requirements"
  ADD COLUMN "status" "material_requirement_status" NOT NULL DEFAULT 'ATIVA',
  ADD COLUMN "replaces_requirement_id" UUID,
  ADD COLUMN "closed_at" TIMESTAMPTZ(3),
  ADD COLUMN "closed_by_id" UUID,
  ADD COLUMN "close_reason" VARCHAR(500);

-- Sucessora aponta para a predecessora; a predecessora nunca é apagada enquanto houver sucessora.
ALTER TABLE "material_requirements"
  ADD CONSTRAINT "material_requirements_replaces_requirement_id_fkey"
  FOREIGN KEY ("replaces_requirement_id") REFERENCES "material_requirements"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_requirements"
  ADD CONSTRAINT "material_requirements_closed_by_id_fkey"
  FOREIGN KEY ("closed_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- No máximo UMA sucessora direta por necessidade (duas aprovações concorrentes: só uma vence).
CREATE UNIQUE INDEX "material_requirements_replaces_requirement_id_key"
  ON "material_requirements"("replaces_requirement_id");
CREATE INDEX "material_requirements_service_order_id_status_idx"
  ON "material_requirements"("service_order_id", "status");

-- ATIVA ⇔ sem fechamento; nunca substitui a si mesma.
ALTER TABLE "material_requirements"
  ADD CONSTRAINT "material_requirements_closed_chk"
  CHECK (("status" = 'ATIVA') = ("closed_at" IS NULL));
ALTER TABLE "material_requirements"
  ADD CONSTRAINT "material_requirements_not_self_chk"
  CHECK ("replaces_requirement_id" IS NULL OR "replaces_requirement_id" <> "id");
