-- Simplificação Fase 3 — recebimentos compartilhados (chegada única, confirmação por qualquer
-- funcionário autorizado) e participantes operacionais da logística. Somente ADITIVA.

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "device_id" UUID;

-- CreateTable
CREATE TABLE "logistics_trip_participants" (
    "id" UUID NOT NULL,
    "pickup_id" UUID,
    "delivery_id" UUID,
    "user_id" UUID NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logistics_trip_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_arrivals" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "lines" JSONB NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDENTE_CONFERENCIA',
    "problem_kind" VARCHAR(30),
    "problem_note" VARCHAR(500),
    "received_by_id" UUID NOT NULL,
    "device_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "material_receipt_id" UUID,
    "conferred_by_id" UUID,
    "conferred_at" TIMESTAMPTZ(3),

    CONSTRAINT "material_arrivals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "logistics_trip_participants_user_id_idx" ON "logistics_trip_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_trip_participants_pickup_id_user_id_key" ON "logistics_trip_participants"("pickup_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "logistics_trip_participants_delivery_id_user_id_key" ON "logistics_trip_participants"("delivery_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_arrivals_number_key" ON "material_arrivals"("number");

-- CreateIndex
CREATE UNIQUE INDEX "material_arrivals_material_receipt_id_key" ON "material_arrivals"("material_receipt_id");

-- CreateIndex
CREATE INDEX "material_arrivals_purchase_order_id_status_idx" ON "material_arrivals"("purchase_order_id", "status");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_trip_participants" ADD CONSTRAINT "logistics_trip_participants_pickup_id_fkey" FOREIGN KEY ("pickup_id") REFERENCES "pickup_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_trip_participants" ADD CONSTRAINT "logistics_trip_participants_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logistics_trip_participants" ADD CONSTRAINT "logistics_trip_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_conferred_by_id_fkey" FOREIGN KEY ("conferred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Participante pertence a exatamente UMA viagem (retirada ou entrega).
ALTER TABLE "logistics_trip_participants" ADD CONSTRAINT "logistics_trip_participants_one_trip"
  CHECK ((("pickup_id" IS NOT NULL)::int + ("delivery_id" IS NOT NULL)::int) = 1);

-- Situação da chegada física; conferida exige o recebimento que a encerrou.
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_status_check"
  CHECK ("status" IN ('PENDENTE_CONFERENCIA', 'CONFERIDA', 'CANCELADA'));
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_conferred_receipt"
  CHECK ("status" <> 'CONFERIDA' OR ("material_receipt_id" IS NOT NULL AND "conferred_at" IS NOT NULL));
ALTER TABLE "material_arrivals" ADD CONSTRAINT "material_arrivals_lines_array"
  CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") > 0);
