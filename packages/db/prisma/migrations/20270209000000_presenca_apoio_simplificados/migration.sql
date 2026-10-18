-- AlterTable
ALTER TABLE "operational_attendances" ADD COLUMN     "departure_unrecorded_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "reschedule_proposals" ADD COLUMN     "requested_by_id" UUID;

-- CreateTable
CREATE TABLE "company_holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_leaves" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'ATIVA',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_leave_events" (
    "id" UUID NOT NULL,
    "leave_id" UUID NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_leave_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_holidays_date_key" ON "company_holidays"("date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_leaves_number_key" ON "attendance_leaves"("number");

-- CreateIndex
CREATE INDEX "attendance_leaves_employee_id_start_date_idx" ON "attendance_leaves"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "attendance_leaves_status_start_date_end_date_idx" ON "attendance_leaves"("status", "start_date", "end_date");

-- CreateIndex
CREATE INDEX "attendance_leave_events_leave_id_created_at_idx" ON "attendance_leave_events"("leave_id", "created_at");

-- AddForeignKey
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_holidays" ADD CONSTRAINT "company_holidays_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_holidays" ADD CONSTRAINT "company_holidays_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_leaves" ADD CONSTRAINT "attendance_leaves_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_leaves" ADD CONSTRAINT "attendance_leaves_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_leaves" ADD CONSTRAINT "attendance_leaves_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_leave_events" ADD CONSTRAINT "attendance_leave_events_leave_id_fkey" FOREIGN KEY ("leave_id") REFERENCES "attendance_leaves"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_leave_events" ADD CONSTRAINT "attendance_leave_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Simplificação Fase 7: regras no banco.
ALTER TABLE "company_holidays"
  ADD CONSTRAINT "company_holidays_name" CHECK (length(btrim("name")) >= 2);

ALTER TABLE "attendance_leaves"
  ADD CONSTRAINT "attendance_leaves_kind" CHECK ("kind" IN ('FOLGA', 'FERIAS')),
  ADD CONSTRAINT "attendance_leaves_status" CHECK ("status" IN ('ATIVA', 'CANCELADA')),
  ADD CONSTRAINT "attendance_leaves_range" CHECK ("end_date" >= "start_date" AND "end_date" - "start_date" <= 366),
  ADD CONSTRAINT "attendance_leaves_reason" CHECK (length(btrim("reason")) >= 3),
  ADD CONSTRAINT "attendance_leaves_cancel" CHECK (("status" = 'CANCELADA') = ("cancelled_at" IS NOT NULL));

ALTER TABLE "attendance_leave_events"
  ADD CONSTRAINT "attendance_leave_events_action" CHECK ("action" IN ('CRIADA', 'CORRIGIDA', 'CANCELADA'));

-- Folga/férias nunca é apagada (cancelamento com motivo); o histórico é imutável.
CREATE TRIGGER "attendance_leaves_no_delete" BEFORE DELETE ON "attendance_leaves"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_delete();
CREATE TRIGGER "attendance_leave_events_immutable" BEFORE UPDATE OR DELETE ON "attendance_leave_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Apoio prolongado (HelpRequest kind APOIO_PROLONGADO, até 5 dias de 8 h) e novos tipos de
-- proposta (transferência e apoio prolongado). Restrições ampliadas, nada removido.
ALTER TABLE "help_requests" DROP CONSTRAINT "help_requests_kind";
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_kind" CHECK ("kind" IN ('PARAFUSAR', 'MOVIMENTAR', 'AUXILIAR_MONTAGEM', 'POSICIONAR', 'OUTRO', 'APOIO_PROLONGADO'));
ALTER TABLE "help_requests" DROP CONSTRAINT "help_requests_minutes_range";
ALTER TABLE "help_requests" ADD CONSTRAINT "help_requests_minutes_range" CHECK (
  ("kind" <> 'APOIO_PROLONGADO' AND "estimated_minutes" BETWEEN 5 AND 240)
  OR ("kind" = 'APOIO_PROLONGADO' AND "estimated_minutes" BETWEEN 60 AND 2400)
);
ALTER TABLE "reschedule_proposals" DROP CONSTRAINT "reschedule_proposals_kind";
ALTER TABLE "reschedule_proposals" ADD CONSTRAINT "reschedule_proposals_kind" CHECK ("kind" IN ('AUSENCIA', 'BLOQUEIO', 'AJUDA_URGENTE', 'CONFLITO', 'TRANSFERENCIA', 'APOIO_PROLONGADO'));

-- Dia encerrado sem horário: continua com chegada, sem saída (nunca um horário inventado).
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_departure_unrecorded" CHECK ("departure_unrecorded_at" IS NULL OR ("arrived_at" IS NOT NULL AND "departed_at" IS NULL));
