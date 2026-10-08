-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "device_kind" AS ENUM ('TABLET', 'COMPUTADOR', 'CELULAR');

-- CreateEnum
CREATE TYPE "device_status" AS ENUM ('PENDING_PAIRING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "session_kind" AS ENUM ('WEB', 'DEVICE');

-- CreateEnum
CREATE TYPE "file_visibility" AS ENUM ('PRIVATE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254),
    "password_hash" TEXT,
    "pin_hash" TEXT,
    "display_name" VARCHAR(60) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "credentials_changed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "display_name" VARCHAR(40) NOT NULL,
    "job_title" VARCHAR(80) NOT NULL,
    "responsibilities" VARCHAR(500),
    "phone" VARCHAR(30),
    "color" CHAR(7) NOT NULL,
    "photo_file_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(60),
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(300),
    "system" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "user_id" UUID NOT NULL,
    "permission" VARCHAR(80) NOT NULL,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("user_id","permission")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "kind" "device_kind" NOT NULL DEFAULT 'TABLET',
    "location" VARCHAR(80),
    "status" "device_status" NOT NULL DEFAULT 'PENDING_PAIRING',
    "assigned_employee_id" UUID,
    "restrict_to_assigned" BOOLEAN NOT NULL DEFAULT true,
    "credential_hash" CHAR(64),
    "pairing_code_hash" CHAR(64),
    "pairing_code_expires_at" TIMESTAMPTZ(3),
    "paired_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "kind" "session_kind" NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(40),
    "revoked_by_id" UUID,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(300),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_throttle" (
    "key" VARCHAR(200) NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "trade_name" VARCHAR(120) NOT NULL,
    "legal_name" VARCHAR(160),
    "document" VARCHAR(20),
    "phone" VARCHAR(30),
    "email" VARCHAR(254),
    "address" VARCHAR(240),
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
    "workday_start" CHAR(5) NOT NULL DEFAULT '08:30',
    "arrival_alert_at" CHAR(5) NOT NULL DEFAULT '09:30',
    "workday_end" CHAR(5) NOT NULL DEFAULT '18:00',
    "working_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "planning_weekday" INTEGER NOT NULL DEFAULT 5,
    "measurement_weekday" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "session_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(64),
    "summary" VARCHAR(300) NOT NULL,
    "changes" JSONB,
    "ip_address" VARCHAR(64),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "aggregate_type" VARCHAR(60) NOT NULL,
    "aggregate_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "audience" VARCHAR(120) NOT NULL DEFAULT 'all',
    "actor_user_id" UUID,
    "request_id" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_consumers" (
    "name" VARCHAR(80) NOT NULL,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "next_attempt_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_consumers_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "scope" VARCHAR(160) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(200) NOT NULL,
    "purpose" VARCHAR(40) NOT NULL,
    "original_name" VARCHAR(200) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "visibility" "file_visibility" NOT NULL DEFAULT 'PRIVATE',
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_photo_file_id_key" ON "employees"("photo_file_id");

-- CreateIndex
CREATE INDEX "employees_active_idx" ON "employees"("active");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_name_key" ON "devices"("name");

-- CreateIndex
CREATE UNIQUE INDEX "devices_credential_hash_key" ON "devices"("credential_hash");

-- CreateIndex
CREATE UNIQUE INDEX "devices_pairing_code_hash_key" ON "devices"("pairing_code_hash");

-- CreateIndex
CREATE INDEX "devices_status_idx" ON "devices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_device_id_revoked_at_idx" ON "sessions"("device_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_throttle_updated_at_idx" ON "auth_throttle"("updated_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_events_seq_key" ON "domain_events"("seq");

-- CreateIndex
CREATE INDEX "domain_events_aggregate_type_aggregate_id_idx" ON "domain_events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "domain_events_occurred_at_idx" ON "domain_events"("occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storage_key_key" ON "stored_files"("storage_key");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_photo_file_id_fkey" FOREIGN KEY ("photo_file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_assigned_employee_id_fkey" FOREIGN KEY ("assigned_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_by_id_fkey" FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Regras de integridade adicionais (não expressáveis no schema Prisma)
-- ─────────────────────────────────────────────────────────────────────────────

-- Registro único de configurações da empresa.
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_times_format"
  CHECK ("workday_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND "arrival_alert_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND "workday_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_weekdays"
  CHECK ("planning_weekday" BETWEEN 0 AND 6 AND "measurement_weekday" BETWEEN 0 AND 6
     AND "working_days" <@ ARRAY[0,1,2,3,4,5,6]);

-- E-mails sempre em minúsculas (unicidade sem ambiguidade de caixa).
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

ALTER TABLE "employees" ADD CONSTRAINT "employees_color_hex" CHECK ("color" ~ '^#[0-9A-Fa-f]{6}$');

ALTER TABLE "users" ADD CONSTRAINT "users_version_positive" CHECK ("version" >= 1);
ALTER TABLE "employees" ADD CONSTRAINT "employees_version_positive" CHECK ("version" >= 1);
ALTER TABLE "roles" ADD CONSTRAINT "roles_version_positive" CHECK ("version" >= 1);
ALTER TABLE "devices" ADD CONSTRAINT "devices_version_positive" CHECK ("version" >= 1);

-- Dispositivo ativo precisa de credencial; revogado não pode ter credencial.
ALTER TABLE "devices" ADD CONSTRAINT "devices_status_credential" CHECK (
  ("status" = 'ACTIVE' AND "credential_hash" IS NOT NULL)
  OR ("status" = 'REVOKED' AND "credential_hash" IS NULL)
  OR ("status" = 'PENDING_PAIRING')
);

-- Sessões de dispositivo precisam estar vinculadas a um dispositivo.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_binding" CHECK (
  ("kind" = 'DEVICE' AND "device_id" IS NOT NULL) OR ("kind" = 'WEB' AND "device_id" IS NULL)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoria imutável: registros não podem ser alterados nem apagados.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cenario_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é somente inserção (operação % bloqueada)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- Eventos de domínio não podem ser alterados (exclusão reservada a rotinas de retenção).
CREATE TRIGGER "domain_events_immutable"
  BEFORE UPDATE ON "domain_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Notificação de novos eventos (entregue somente após o COMMIT da transação).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cenario_notify_domain_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('cenario_domain_events', NEW."seq"::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "domain_events_notify"
  AFTER INSERT ON "domain_events"
  FOR EACH ROW EXECUTE FUNCTION cenario_notify_domain_event();
