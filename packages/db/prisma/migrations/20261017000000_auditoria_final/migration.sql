-- AlterTable
ALTER TABLE "piece_returns" ADD COLUMN     "destination" VARCHAR(200);

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "closed_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "balance_close_reason" VARCHAR(500),
ADD COLUMN     "balance_closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "balance_closed_by_id" UUID;

-- CreateIndex
CREATE INDEX "customer_receivables_customer_id_idx" ON "customer_receivables"("customer_id");

-- CreateIndex
CREATE INDEX "customer_receivables_service_order_id_idx" ON "customer_receivables"("service_order_id");

-- CreateIndex
CREATE INDEX "deliveries_customer_id_idx" ON "deliveries"("customer_id");

-- CreateIndex
CREATE INDEX "help_requests_service_order_id_idx" ON "help_requests"("service_order_id");

-- CreateIndex
CREATE INDEX "logistics_occurrences_delivery_id_idx" ON "logistics_occurrences"("delivery_id");

-- CreateIndex
CREATE INDEX "material_leftover_transfers_leftover_id_idx" ON "material_leftover_transfers"("leftover_id");

-- CreateIndex
CREATE INDEX "material_receipt_lines_receipt_id_idx" ON "material_receipt_lines"("receipt_id");

-- CreateIndex
CREATE INDEX "material_requirements_service_order_item_id_idx" ON "material_requirements"("service_order_item_id");

-- CreateIndex
CREATE INDEX "notifications_task_id_idx" ON "notifications"("task_id");

-- CreateIndex
CREATE INDEX "pickup_request_items_order_item_id_idx" ON "pickup_request_items"("order_item_id");

-- CreateIndex
CREATE INDEX "piece_return_lines_order_item_id_idx" ON "piece_return_lines"("order_item_id");

-- CreateIndex
CREATE INDEX "production_issues_material_requirement_id_idx" ON "production_issues"("material_requirement_id");

-- CreateIndex
CREATE INDEX "production_plan_items_service_order_id_idx" ON "production_plan_items"("service_order_id");

-- CreateIndex
CREATE INDEX "production_tasks_service_order_item_id_idx" ON "production_tasks"("service_order_item_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_stock_item_id_idx" ON "purchase_order_items"("stock_item_id");

-- CreateIndex
CREATE INDEX "quality_inspections_service_order_id_idx" ON "quality_inspections"("service_order_id");

-- CreateIndex
CREATE INDEX "receipts_pickup_id_idx" ON "receipts"("pickup_id");

-- CreateIndex
CREATE INDEX "stock_movements_reservation_id_idx" ON "stock_movements"("reservation_id");

-- CreateIndex
CREATE INDEX "stock_movements_material_receipt_line_id_idx" ON "stock_movements"("material_receipt_line_id");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_balance_closed_by_id_fkey" FOREIGN KEY ("balance_closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Fase 12: regras de integridade do encerramento de saldo e da devolução.
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_closed_quantity"
  CHECK ("closed_quantity" >= 0 AND "closed_quantity" <= "quantity");
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_balance_closed"
  CHECK (
    ("balance_closed_at" IS NULL AND "balance_close_reason" IS NULL)
    OR ("balance_closed_at" IS NOT NULL AND length(trim("balance_close_reason")) >= 3)
  );
ALTER TABLE "piece_returns" ADD CONSTRAINT "piece_returns_destination"
  CHECK ("destination" IS NULL OR length(trim("destination")) >= 2);
