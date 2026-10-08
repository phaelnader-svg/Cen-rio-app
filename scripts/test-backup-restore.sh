#!/usr/bin/env bash
# Teste automatizado de backup e restauração: faz backup do banco de teste,
# restaura num banco temporário e compara a contagem de registros por tabela.
# Uso: scripts/test-backup-restore.sh  (requer TEST_DATABASE_URL e permissão CREATEDB)
set -euo pipefail
if [[ -f .env ]]; then set -a; source .env; set +a; fi
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL não definido}"
SOURCE="$TEST_DATABASE_URL"
BASE="${SOURCE%/*}"
RESTORE_DB="cenario_restore_check_test"
RESTORE_URL="$BASE/$RESTORE_DB"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS $RESTORE_DB" >/dev/null 2>&1 || true' EXIT

counts() {
  psql "$1" -At -c "SELECT string_agg(t || '=' || n, ',' ORDER BY t) FROM (
    SELECT 'users' t, count(*) n FROM users UNION ALL SELECT 'employees', count(*) FROM employees
    UNION ALL SELECT 'roles', count(*) FROM roles UNION ALL SELECT 'role_permissions', count(*) FROM role_permissions
    UNION ALL SELECT 'devices', count(*) FROM devices UNION ALL SELECT 'sessions', count(*) FROM sessions
    UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs UNION ALL SELECT 'domain_events', count(*) FROM domain_events
    UNION ALL SELECT 'company_settings', count(*) FROM company_settings) x"
}

# Garante dados de referência na origem (seed idempotente + um registro de auditoria).
( cd packages/db && DATABASE_URL="$SOURCE" SEED_ADMIN_EMAIL=backup@teste.local \
    SEED_ADMIN_PASSWORD=SenhaBackup123 SEED_ADMIN_NAME="Teste Backup" pnpm exec tsx src/seed.ts > /dev/null )
psql "$SOURCE" -qc "INSERT INTO audit_logs (id, action, entity_type, summary)
  VALUES (gen_random_uuid(), 'backup.check', 'system', 'Marcador do teste de backup')" > /dev/null

DATABASE_URL="$SOURCE" STORAGE_DIR="$WORK/none" BACKUP_RETENTION_DAYS=0 bash scripts/backup.sh "$WORK/out" > /dev/null
DIR="$(ls -d "$WORK"/out/cenario-*)"
psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS $RESTORE_DB" > /dev/null
psql "$BASE/postgres" -qc "CREATE DATABASE $RESTORE_DB" > /dev/null
bash scripts/restore.sh "$DIR" --target "$RESTORE_URL" --yes > /dev/null

A="$(counts "$SOURCE")"; B="$(counts "$RESTORE_URL")"
echo "origem:     $A"
echo "restaurado: $B"
[[ "$A" == "$B" ]] || { echo "✖ Divergência após restauração" >&2; exit 1; }
# A auditoria continua imutável no banco restaurado.
[[ "$(psql "$RESTORE_URL" -At -c "SELECT count(*) FROM audit_logs WHERE action = 'backup.check'")" -ge 1 ]] \
  || { echo "✖ Marcador de auditoria ausente" >&2; exit 1; }
if psql "$RESTORE_URL" -qc "DELETE FROM audit_logs" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade ausente no banco restaurado" >&2; exit 1
fi
echo "✔ Backup e restauração verificados."
