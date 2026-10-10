#!/usr/bin/env bash
# Evolução, Fase 8 — prova da migração ENCADEADA das Fases 2–7 a partir do código anterior à
# Evolução, com rollback condicionado e backup/restauração. Somente bancos LOCAIS descartáveis.
#
# Uso: PG_BASE=postgresql://usuario:senha@127.0.0.1:55432 scripts/test-evolution-migrations.sh
#   PG_BASE   servidor PostgreSQL local (sem o nome do banco); obrigatório.
#   LEGACY_REF commit anterior à Evolução (padrão 839770a).
# Etapas:
#  1. worktree do código legado; banco gerado pelas migrations legadas + fluxo completo (32 passos);
#  2. fotografia: por tabela, contagem + md5 das colunas EXISTENTES; índices; restrições;
#  3. `prisma migrate deploy` das 5 migrations da Evolução + roteiro (correção global); idêntica;
#  4. código atual lê o legado (check `read`);
#  5. rollbacks 7→6→5→3→2 sem dados novos: schema idêntico ao legado (pg_dump -s) e dados idênticos;
#  6. reaplica; cria dados novos (check `write`); cada rollback é RECUSADO sem mutação;
#  7. backup + restauração (scripts/test-backup-restore.sh) do banco com dados de todas as fases.
set -euo pipefail
: "${PG_BASE:?PG_BASE não definido (ex.: postgresql://cenario:senha@127.0.0.1:55432)}"
LEGACY_REF="${LEGACY_REF:-839770a}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="cenario_evo_migration_test"
URL="$PG_BASE/$DB"
WORK="$(mktemp -d)"
LEGACY="$WORK/legacy"
cleanup() {
  git -C "$ROOT" worktree remove --force "$LEGACY" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
DOWNS=(20261115000000_fechamento_semanal 20261108000000_custos_logistica
  20261101000000_mao_de_obra_revisao 20261025000000_distribuicao_automatica
  20261018000000_fila_semanal)
# Correção global: roteiro (só a ordem das paradas; reversão sem perda de compromisso).
ALL_DOWNS=(20261122000000_roteiro_logistica "${DOWNS[@]}")

step() { echo; echo "■ $*"; }
q() { psql "$URL" -At -v ON_ERROR_STOP=1 -c "$1"; }

# Fotografia por valor das tabelas/colunas listadas em $1 (formato tabela|col1,col2,...).
snapshot() {
  local cols="$1"
  while IFS='|' read -r t c; do
    [[ -z "$t" ]] && continue
    local expr
    expr="$(echo "$c" | sed 's/,/","/g')"
    echo "$t|$(q "SELECT count(*) || ':' || coalesce(md5(string_agg(r::text, '/' ORDER BY r::text)), '-')
      FROM (SELECT (\"$expr\") AS r FROM \"$t\") x")"
  done <<< "$cols"
}
columns() {
  q "SELECT table_name || '|' || string_agg(column_name, ',' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY 1"
}
schema_dump() { pg_dump -s "$URL" | grep -v '^\\restrict\|^\\unrestrict\|^$'; }
indexes() { q "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"; }

step "1. Código legado ($LEGACY_REF) e banco gerado por ele"
git -C "$ROOT" worktree add -f "$LEGACY" "$LEGACY_REF" > /dev/null
( cd "$LEGACY" && pnpm install --offline --frozen-lockfile > "$WORK/install.log" 2>&1 )
psql "$PG_BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB" > /dev/null
psql "$PG_BASE/postgres" -qc "CREATE DATABASE $DB" > /dev/null
( cd "$LEGACY/apps/api" && TEST_DATABASE_URL="$URL" DATABASE_URL="$PG_BASE/cenario_nao_usado" \
    CHECKPOINT_DISABLE=1 npx vitest run test/full-flow.test.ts > "$WORK/legacy-fixture.log" 2>&1 ) \
  || { tail -40 "$WORK/legacy-fixture.log" >&2; echo "✖ Fixture legada falhou" >&2; exit 1; }
echo "migrations legadas: $(q "SELECT count(*) FROM _prisma_migrations")"
echo "linhas por tabela (com dados): $(q "SELECT count(*) FROM pg_stat_user_tables WHERE n_live_tup > 0")"
echo "totais legados: OS=$(q 'SELECT count(*) FROM service_orders') tarefas=$(q 'SELECT count(*) FROM production_tasks') \
pagamentos=$(q 'SELECT count(*) FROM payable_payments')+$(q 'SELECT count(*) FROM professional_payments')+$(q 'SELECT count(*) FROM customer_payments') \
auditoria=$(q 'SELECT count(*) FROM audit_logs') soma_contas=$(q 'SELECT coalesce(sum(amount_cents),0) FROM account_payables') \
soma_mo=$(q 'SELECT coalesce(sum(agreed_cents),0) FROM production_payables') soma_receber=$(q 'SELECT coalesce(sum(amount_cents),0) FROM customer_receivables')"

step "2. Fotografia do legado"
COLS="$(columns | grep -v '^_prisma_migrations|')"
BEFORE="$(snapshot "$COLS")"
IDX_BEFORE="$(indexes)"
SCHEMA_BEFORE="$(schema_dump)"
echo "tabelas fotografadas: $(echo "$BEFORE" | wc -l)"

step "3. Migrations da Evolução (Fases 2–7)"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy 2>&1 | grep -E 'Applying|applied|Error' )
AFTER="$(snapshot "$COLS")"
if [[ "$BEFORE" != "$AFTER" ]]; then diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true; echo "✖ Dados legados alterados" >&2; exit 1; fi
echo "✔ dados legados idênticos (todas as colunas existentes, $(echo "$AFTER" | wc -l) tabelas)"
# Substituições DOCUMENTADAS (regra nova mais específica no lugar da antiga):
#  - Fase 5: production_payables_item_active/order_active → uma obrigação viva por
#    peça E profissional (production_payables_one_live_per_piece_professional/_os_professional);
#  - Fase 6: rateio único por (custo, OS) → por (custo, OS, revisão) (histórico de rateios).
REPLACED="logistics_cost_allocations_logistics_cost_id_service_order__key
production_payables_item_active
production_payables_order_active"
MISSING="$(comm -23 <(echo "$IDX_BEFORE") <(indexes) | comm -23 - <(echo "$REPLACED" | sort))"
[[ -z "$MISSING" ]] || { echo "✖ Índices legados removidos sem substituição documentada: $MISSING" >&2; exit 1; }
echo "✔ índices legados preservados (3 substituições documentadas); novos: $(comm -13 <(echo "$IDX_BEFORE") <(indexes) | wc -l)"
echo "valores derivados: planos=$(q "SELECT string_agg(mode || '=' || n, ',') FROM (SELECT mode, count(*) n FROM production_plans GROUP BY 1) x") \
custos_logistica=$(q "SELECT coalesce(string_agg(status || '=' || n, ','), 'nenhum') FROM (SELECT status, count(*) n FROM logistics_costs GROUP BY 1) x")"

step "4. Código atual sobre o legado migrado (leitura)"
( cd "$ROOT/apps/api" && MIGRATION_CHECK_STEP=read TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" \
    CHECKPOINT_DISABLE=1 npx vitest run --config vitest.migration.config.ts 2>&1 | grep -E 'MIGRACAO|✓|×|Tests|Error' )

# A leitura pelo código atual grava sessão/auditoria (login) e pode recalcular a situação da mão
# de obra; registra o que mudou e passa a comparar o rollback com o estado imediatamente anterior.
PRE_RB="$(snapshot "$COLS")"
echo "tabelas alteradas pela etapa 4 (uso normal do sistema): $(diff <(echo "$AFTER") <(echo "$PRE_RB") | grep '^>' | cut -d'|' -f1 | sed 's/^> //' | tr '\n' ' ')"

step "5. Rollbacks sem dados novos (roteiro → 7 → 6 → 5 → 3 → 2)"
for d in "${ALL_DOWNS[@]}"; do
  psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$d.down.sql" > /dev/null
  echo "  revertida: $d"
done
diff <(echo "$SCHEMA_BEFORE") <(schema_dump) > "$WORK/schema.diff" \
  || { cat "$WORK/schema.diff" >&2; echo "✖ Schema difere do legado após rollback" >&2; exit 1; }
RB="$(snapshot "$COLS")"
if [[ "$RB" != "$PRE_RB" ]]; then diff <(echo "$PRE_RB") <(echo "$RB") >&2 || true; echo "✖ Dados diferem após rollback" >&2; exit 1; fi
echo "✔ schema idêntico ao legado (pg_dump -s) e dados idênticos"

step "6. Reaplica, cria dados novos e prova a RECUSA de cada rollback"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy > /dev/null 2>&1 )
( cd "$ROOT/apps/api" && MIGRATION_CHECK_STEP=write TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" \
    CHECKPOINT_DISABLE=1 npx vitest run --config vitest.migration.config.ts 2>&1 | grep -E 'MIGRACAO|✓|×|Tests|Error' )
S1="$(schema_dump | md5sum)"; M1="$(q 'SELECT count(*) FROM _prisma_migrations')"
D1="$(snapshot "$(columns)")"
for d in "${DOWNS[@]}"; do
  if out="$(psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$d.down.sql" 2>&1)"; then
    echo "✖ $d: rollback ACEITO com dados novos" >&2; exit 1
  fi
  echo "  recusado: $d — $(echo "$out" | grep -o 'Reversão bloqueada[^.]*' | head -1)"
done
[[ "$(schema_dump | md5sum)" == "$S1" && "$(q 'SELECT count(*) FROM _prisma_migrations')" == "$M1" ]] \
  || { echo "✖ Schema/migrations mudaram após recusas" >&2; exit 1; }
[[ "$(snapshot "$(columns)")" == "$D1" ]] || { echo "✖ Dados mudaram após recusas" >&2; exit 1; }
echo "✔ todas as recusas foram atômicas (schema, migrations e dados inalterados)"

step "7. Backup e restauração do banco com dados de todas as fases"
( cd "$ROOT" && TEST_DATABASE_URL="$URL" bash scripts/test-backup-restore.sh 2>&1 | grep -E '✔|✖|tabelas comparadas' )

psql "$PG_BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB" > /dev/null
echo; echo "✔ Migração encadeada, rollback condicionado e backup verificados."
