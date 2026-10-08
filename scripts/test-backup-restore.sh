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
    UNION ALL SELECT 'company_settings', count(*) FROM company_settings
    UNION ALL SELECT 'customers', count(*) FROM customers UNION ALL SELECT 'commercial_orders', count(*) FROM commercial_orders
    UNION ALL SELECT 'pickup_events', count(*) FROM pickup_events UNION ALL SELECT 'receipts', count(*) FROM receipts
    UNION ALL SELECT 'service_orders', count(*) FROM service_orders
    UNION ALL SELECT 'service_order_revisions', count(*) FROM service_order_revisions
    UNION ALL SELECT 'measurements', count(*) FROM measurements
    UNION ALL SELECT 'material_requests', count(*) FROM material_requests
    UNION ALL SELECT 'material_request_items', count(*) FROM material_request_items
    UNION ALL SELECT 'measurement_revisions', count(*) FROM measurement_revisions
    UNION ALL SELECT 'suppliers', count(*) FROM suppliers
    UNION ALL SELECT 'purchase_orders', count(*) FROM purchase_orders
    UNION ALL SELECT 'purchase_order_items', count(*) FROM purchase_order_items
    UNION ALL SELECT 'material_receipts', count(*) FROM material_receipts
    UNION ALL SELECT 'stock_items', count(*) FROM stock_items
    UNION ALL SELECT 'stock_movements', count(*) FROM stock_movements
    UNION ALL SELECT 'production_plans', count(*) FROM production_plans
    UNION ALL SELECT 'production_tasks', count(*) FROM production_tasks
    UNION ALL SELECT 'production_task_events', count(*) FROM production_task_events
    UNION ALL SELECT 'production_templates', count(*) FROM production_templates
    UNION ALL SELECT 'notifications', count(*) FROM notifications
    UNION ALL SELECT 'operational_attendances', count(*) FROM operational_attendances
    UNION ALL SELECT 'attendance_corrections', count(*) FROM attendance_corrections) x"
}

# Garante dados de referência na origem (seed idempotente + um registro de auditoria).
( cd packages/db && DATABASE_URL="$SOURCE" SEED_ADMIN_EMAIL=backup@teste.local \
    SEED_ADMIN_PASSWORD=SenhaBackup123 SEED_ADMIN_NAME="Teste Backup" pnpm exec tsx src/seed.ts > /dev/null )
psql "$SOURCE" -qc "INSERT INTO audit_logs (id, action, entity_type, summary)
  VALUES (gen_random_uuid(), 'backup.check', 'system', 'Marcador do teste de backup')" > /dev/null
# Dados fictícios da Fase 2 (cliente → pedido → recebimento) para validar essas tabelas.
psql "$SOURCE" -q > /dev/null <<'SQL'
WITH c AS (
  INSERT INTO customers (id, kind, name, search_text, updated_at)
  VALUES (gen_random_uuid(), 'PF', 'Cliente Fictício Backup', 'cliente ficticio backup', now()) RETURNING id
), o AS (
  INSERT INTO commercial_orders (id, customer_id, contracted_service, updated_at)
  SELECT gen_random_uuid(), c.id, 'Teste de backup', now() FROM c RETURNING id
), i AS (
  INSERT INTO commercial_order_items (id, order_id, position, piece_type, description, quantity, received_quantity, updated_at)
  SELECT gen_random_uuid(), o.id, 1, 'SOFA', 'Sofá fictício', 1, 1, now() FROM o RETURNING id, order_id
), r AS (
  INSERT INTO receipts (id, order_id, origin, received_at)
  SELECT gen_random_uuid(), i.order_id, 'ENTREGUE_PELO_CLIENTE', now() FROM i RETURNING id
)
INSERT INTO receipt_lines (id, receipt_id, order_item_id, quantity, condition, location)
SELECT gen_random_uuid(), r.id, i.id, 1, 'BOA', 'Teste' FROM r, i;
SQL
# Dados fictícios da Fase 3 (OS → medição → solicitação com tecido → histórico).
psql "$SOURCE" -q > /dev/null <<'SQL'
WITH so AS (
  INSERT INTO service_orders (id, order_id, customer_id, updated_at)
  SELECT gen_random_uuid(), o.id, o.customer_id, now() FROM commercial_orders o
  WHERE o.contracted_service = 'Teste de backup' ORDER BY o.created_at DESC LIMIT 1 RETURNING id
), m AS (
  INSERT INTO measurements (id, service_order_id, kind, status, assignee_user_id, due_date, completed_at, updated_at)
  SELECT gen_random_uuid(), so.id, 'ROTINA', 'CONCLUIDA', u.id, current_date, now(), now()
  FROM so, users u WHERE u.email = 'backup@teste.local' RETURNING id
), rq AS (
  INSERT INTO material_requests (id, measurement_id, status, submitted_at, updated_at)
  SELECT gen_random_uuid(), m.id, 'ENVIADA', now(), now() FROM m RETURNING id, measurement_id
), it AS (
  INSERT INTO material_request_items (id, request_id, position, kind, sourcing, description, quantity, unit)
  SELECT gen_random_uuid(), rq.id, 1, 'TECIDO', 'EXCLUSIVO_OS', 'Linho fictício', 12.5, 'METRO' FROM rq RETURNING id
)
INSERT INTO measurement_revisions (id, measurement_id, kind, to_status)
SELECT gen_random_uuid(), rq.measurement_id, 'ENVIADA', 'ENVIADA' FROM rq, it;
SQL
# Dados fictícios da Fase 4 (fornecedor → compra de estoque → recebimento → movimentação).
psql "$SOURCE" -q > /dev/null <<'SQL'
WITH s AS (
  INSERT INTO suppliers (id, name, updated_at) VALUES (gen_random_uuid(), 'Fornecedor Fictício Backup', now()) RETURNING id
), si AS (
  INSERT INTO stock_items (id, kind, description, unit, spec_key, on_hand, reserved, updated_at)
  VALUES (gen_random_uuid(), 'OUTRO', 'Grampos backup', 'EMBALAGEM', 'OUTRO|grampos backup|' || gen_random_uuid(), 3, 0, now())
  RETURNING id
), po AS (
  INSERT INTO purchase_orders (id, supplier_id, status, confirmed_at, updated_at)
  SELECT gen_random_uuid(), s.id, 'RECEBIDO', now(), now() FROM s RETURNING id
), it AS (
  INSERT INTO purchase_order_items (id, purchase_order_id, position, kind, sourcing, description, unit, quantity, received_quantity, unit_price_cents, stock_item_id)
  SELECT gen_random_uuid(), po.id, 1, 'OUTRO', 'ESTOQUE', 'Grampos backup', 'EMBALAGEM', 3, 3, 1890, si.id FROM po, si
  RETURNING id, purchase_order_id, stock_item_id
), rc AS (
  INSERT INTO material_receipts (id, purchase_order_id, received_by_id)
  SELECT gen_random_uuid(), it.purchase_order_id, u.id FROM it, users u WHERE u.email = 'backup@teste.local'
  RETURNING id
), ln AS (
  INSERT INTO material_receipt_lines (id, receipt_id, purchase_order_item_id, accepted_quantity, spec_confirmed)
  SELECT gen_random_uuid(), rc.id, it.id, 3, true FROM rc, it RETURNING id
)
INSERT INTO stock_movements (id, stock_item_id, type, quantity, balance_after, reserved_after, material_receipt_line_id)
SELECT gen_random_uuid(), it.stock_item_id, 'ENTRADA_COMPRA', 3, 3, 0, ln.id FROM it, ln;
SQL
# Dados fictícios da Fase 5 (planejamento publicado → tarefa concluída → evento imutável).
psql "$SOURCE" -q -v ON_ERROR_STOP=1 > /dev/null <<'SQL'
WITH p AS (
  INSERT INTO production_plans (id, week_start, status, revision, published_at, updated_at)
  VALUES (gen_random_uuid(), date '2031-01-06' + 7 * (random() * 5000)::int, 'PUBLICADO', 1, now(), now())
  RETURNING id
), t AS (
  INSERT INTO production_tasks (id, plan_id, service_order_id, activity, title, assignee_user_id, status, started_at, completed_at, progress_percent, updated_at)
  SELECT gen_random_uuid(), p.id, so.id, 'PREPARACAO', 'Preparação backup', u.id, 'CONCLUIDA', now(), now(), 100, now()
  FROM p, users u, (SELECT id FROM service_orders ORDER BY created_at DESC LIMIT 1) so
  WHERE u.email = 'backup@teste.local' RETURNING id
), ev AS (
  INSERT INTO production_task_events (id, task_id, kind, from_status, to_status)
  SELECT gen_random_uuid(), t.id, 'CONCLUIDA', 'EM_EXECUCAO', 'CONCLUIDA' FROM t RETURNING task_id
)
-- Fase 6: aviso persistente ligado à tarefa.
INSERT INTO notifications (id, user_id, kind, title, body, task_id, dedupe_key)
SELECT gen_random_uuid(), u.id, 'TAREFA_LIBERADA', 'Tarefa liberada', 'Preparação backup — pode começar.',
       ev.task_id, 'backup:' || ev.task_id
FROM ev, users u WHERE u.email = 'backup@teste.local';
SQL
# Dados fictícios da Fase 7 (presença operacional com histórico imutável).
psql "$SOURCE" -q -v ON_ERROR_STOP=1 > /dev/null <<'SQL'
WITH e AS (
  SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id WHERE u.email = 'backup@teste.local' LIMIT 1
), a AS (
  INSERT INTO operational_attendances (id, employee_id, date, situation, arrived_at, arrival_kind, late_minutes, availability, updated_at)
  SELECT gen_random_uuid(), e.id, date '2031-01-06' + (random() * 5000)::int, 'PRESENTE', now(), 'ATRASO', 12, 'DISPONIVEL', now() FROM e
  RETURNING id
)
INSERT INTO attendance_corrections (id, attendance_id, action, after)
SELECT gen_random_uuid(), a.id, 'CHEGADA', '{"situation":"PRESENTE"}'::jsonb FROM a;
SQL

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
if psql "$RESTORE_URL" -qc "DELETE FROM receipts" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade de recebimentos ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "DELETE FROM stock_movements" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade das movimentações de estoque ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "UPDATE stock_items SET on_hand = -1" > /dev/null 2>&1; then
  echo "✖ Restrição de estoque não negativo ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "INSERT INTO notifications (id, user_id, kind, title, body, dedupe_key) SELECT gen_random_uuid(), user_id, kind, title, body, dedupe_key FROM notifications LIMIT 1" > /dev/null 2>&1; then
  echo "✖ Unicidade dos avisos (usuário + chave) ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "DELETE FROM attendance_corrections" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade do histórico de presença ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "DELETE FROM production_task_events" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade do histórico de tarefas ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "UPDATE production_tasks SET progress_percent = 150" > /dev/null 2>&1; then
  echo "✖ Restrição de progresso das tarefas ausente no banco restaurado" >&2; exit 1
fi
if psql "$RESTORE_URL" -qc "DELETE FROM measurement_revisions" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade do histórico de medições ausente no banco restaurado" >&2; exit 1
fi
[[ "$(psql "$RESTORE_URL" -At -c "SELECT quantity FROM material_request_items WHERE description = 'Linho fictício' LIMIT 1")" == "12.500" ]] \
  || { echo "✖ Quantidade decimal não preservada" >&2; exit 1; }
if psql "$RESTORE_URL" -qc "DELETE FROM audit_logs" > /dev/null 2>&1; then
  echo "✖ Trigger de imutabilidade ausente no banco restaurado" >&2; exit 1
fi
echo "✔ Backup e restauração verificados."
