-- Fase 7: presença operacional (aditiva; não é registro de ponto eletrônico). Nenhuma migration anterior alterada.

-- CreateEnum
CREATE TYPE "attendance_situation" AS ENUM ('PRESENTE', 'AUSENCIA_PRESUMIDA', 'AUSENCIA_CONFIRMADA', 'AUSENCIA_JUSTIFICADA', 'ATESTADO', 'FOLGA', 'FERIAS', 'TRABALHO_EXTERNO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "arrival_kind" AS ENUM ('NO_HORARIO', 'ATRASO', 'APOS_AUSENCIA_PRESUMIDA');

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "arrival_window_start" CHAR(5) NOT NULL DEFAULT '07:00',
ADD COLUMN     "late_alert_minutes" INTEGER NOT NULL DEFAULT 15;

-- CreateTable
CREATE TABLE "operational_attendances" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "situation" "attendance_situation" NOT NULL,
    "arrived_at" TIMESTAMPTZ(3),
    "arrival_kind" "arrival_kind",
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "arrival_by_id" UUID,
    "arrival_device_id" UUID,
    "departed_at" TIMESTAMPTZ(3),
    "departure_by_id" UUID,
    "departure_device_id" UUID,
    "early_departure" BOOLEAN NOT NULL DEFAULT false,
    "departure_note" VARCHAR(500),
    "presumed_absent_at" TIMESTAMPTZ(3),
    "note" VARCHAR(300),
    "availability" VARCHAR(30) NOT NULL DEFAULT 'NAO_CONFIRMOU',
    "availability_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "operational_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(300),
    "before" JSONB,
    "after" JSONB NOT NULL,
    "actor_id" UUID,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_impacts" (
    "id" UUID NOT NULL,
    "attendance_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "affected_user_id" UUID,
    "due_date" DATE,
    "detail" VARCHAR(300) NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "resolution" VARCHAR(300),

    CONSTRAINT "attendance_impacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operational_attendances_date_situation_idx" ON "operational_attendances"("date", "situation");

-- CreateIndex
CREATE UNIQUE INDEX "operational_attendances_employee_id_date_key" ON "operational_attendances"("employee_id", "date");

-- CreateIndex
CREATE INDEX "attendance_corrections_attendance_id_created_at_idx" ON "attendance_corrections"("attendance_id", "created_at");

-- CreateIndex
CREATE INDEX "attendance_impacts_detected_at_idx" ON "attendance_impacts"("detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_impacts_attendance_id_task_id_kind_key" ON "attendance_impacts"("attendance_id", "task_id", "kind");

-- AddForeignKey
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_arrival_by_id_fkey" FOREIGN KEY ("arrival_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_departure_by_id_fkey" FOREIGN KEY ("departure_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "operational_attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_attendance_id_fkey" FOREIGN KEY ("attendance_id") REFERENCES "operational_attendances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "production_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_affected_user_id_fkey" FOREIGN KEY ("affected_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Regras de integridade
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_arrival_window_format" CHECK ("arrival_window_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_late_alert_range" CHECK ("late_alert_minutes" BETWEEN 0 AND 240);
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_late_positive" CHECK ("late_minutes" >= 0);
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_arrival_consistent" CHECK (("arrived_at" IS NULL) = ("arrival_kind" IS NULL));
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_present_arrived" CHECK ("situation" NOT IN ('PRESENTE', 'ENCERRADO') OR "arrived_at" IS NOT NULL);
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_departed" CHECK ("situation" <> 'ENCERRADO' OR "departed_at" IS NOT NULL);
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_departure_after_arrival" CHECK ("departed_at" IS NULL OR ("arrived_at" IS NOT NULL AND "departed_at" >= "arrived_at"));
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_presumed" CHECK ("situation" <> 'AUSENCIA_PRESUMIDA' OR "presumed_absent_at" IS NOT NULL);
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_availability" CHECK ("availability" IN ('NAO_CONFIRMOU', 'DISPONIVEL', 'OCUPADO', 'EM_PAUSA', 'EXTERNO', 'AUSENCIA_PRESUMIDA', 'AUSENTE', 'ENCERRADO'));
ALTER TABLE "operational_attendances" ADD CONSTRAINT "operational_attendances_version_positive" CHECK ("version" >= 1);
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_kind" CHECK ("kind" IN ('TAREFA_DO_AUSENTE', 'DEPENDENTE_AFETADA', 'ANDAMENTO_PENDENTE'));
ALTER TABLE "attendance_impacts" ADD CONSTRAINT "attendance_impacts_resolution" CHECK (("resolved_at" IS NULL) = ("resolution" IS NULL));

-- Histórico de presença imutável (correções preservam o registro original).
CREATE TRIGGER "attendance_corrections_immutable" BEFORE UPDATE OR DELETE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Permissões: o Gestor acompanha e corrige; as funções da oficina registram a própria presença.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", p.permission
FROM "roles" r
CROSS JOIN (VALUES ('presenca.ver'), ('presenca.gerenciar')) AS p(permission)
WHERE r."key" = 'gestor'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT r."id", 'presenca.registrar'
FROM "roles" r
WHERE r."key" IN ('tapeceiro', 'cabeceiras_qualidade', 'ajudante')
ON CONFLICT DO NOTHING;
