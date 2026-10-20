#!/usr/bin/env bash
# Remediação pós-auditoria, Rodada 2 (F10-19) — prova da EVOLUÇÃO da migration
# 20270216000000_notificacoes_resolvidas sobre um banco com dados gerados pelo código anterior
# (base homologada da Rodada 1), com reversão condicionada. Somente bancos LOCAIS descartáveis.
#
# Uso: PG_BASE=postgresql://usuario:senha@127.0.0.1:5432 scripts/test-migration-notificacoes-resolvidas.sh
#   PG_BASE   servidor PostgreSQL local (sem o nome do banco); obrigatório.
#   BASE_REF  commit anterior à migration (padrão e4d6010, Rodada 1 homologada).
# Etapas:
#  1. worktree do código anterior; banco gerado pelas migrations dele + fluxo completo (dados);
#  2. fotografia: por tabela, contagem + md5 de todas as colunas; schema (pg_dump -s);
#  3. `prisma migrate deploy` do código atual: aplica SÓ a nova migration; dados idênticos,
#     nenhuma notificação "resolvida" inventada (resolved_at nulo em todas);
#  4. reversão sem dados novos: schema idêntico ao anterior e dados idênticos;
#  5. reaplica; com um aviso resolvido a reversão é RECUSADA sem alterar nada.
set -euo pipefail
: "${PG_BASE:?PG_BASE não definido (ex.: postgresql://cenario:senha@127.0.0.1:5432)}"
BASE_REF="${BASE_REF:-e4d6010}"
NAME=20270216000000_notificacoes_resolvidas
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="cenario_r2_migration_test"
URL="$PG_BASE/$DB"
WORK="$(mktemp -d)"
OLD="$WORK/base"
cleanup() {
  git -C "$ROOT" worktree remove --force "$OLD" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { echo; echo "■ $*"; }
q() { psql "$URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
columns() {
  q "SELECT table_name || '|' || string_agg(column_name, ',' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY 1"
}
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
schema_dump() { pg_dump -s "$URL" | grep -v '^\\restrict\|^\\unrestrict\|^$'; }

step "1. Código anterior ($BASE_REF) e banco gerado por ele, com dados"
git -C "$ROOT" worktree add -f "$OLD" "$BASE_REF" > /dev/null
( cd "$OLD" && pnpm install --offline --frozen-lockfile > "$WORK/install.log" 2>&1 )
psql "$PG_BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB" > /dev/null
psql "$PG_BASE/postgres" -qc "CREATE DATABASE $DB" > /dev/null
( cd "$OLD/apps/api" && TEST_DATABASE_URL="$URL" DATABASE_URL="$PG_BASE/cenario_nao_usado" \
    CHECKPOINT_DISABLE=1 npx vitest run test/full-flow.test.ts > "$WORK/fixture.log" 2>&1 ) \
  || { tail -40 "$WORK/fixture.log" >&2; echo "✖ Fixture do código anterior falhou" >&2; exit 1; }
echo "migrations aplicadas: $(q "SELECT count(*) FROM _prisma_migrations")"
echo "notificações (anteriores à coluna): $(q 'SELECT count(*) FROM notifications')"
[[ "$(q 'SELECT count(*) FROM notifications')" -gt 0 ]] || { echo "✖ Fixture sem notificações" >&2; exit 1; }

step "2. Fotografia"
COLS="$(columns | grep -v '^_prisma_migrations|')"
BEFORE="$(snapshot "$COLS")"
SCHEMA_BEFORE="$(schema_dump)"
M_BEFORE="$(q 'SELECT count(*) FROM _prisma_migrations')"
echo "tabelas fotografadas: $(echo "$BEFORE" | wc -l)"

step "3. Evolução: migrate deploy do código atual"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy 2>&1 | grep -E 'Applying|applied|Error' )
[[ "$(q 'SELECT count(*) FROM _prisma_migrations')" == "$((M_BEFORE + 1))" ]] \
  || { echo "✖ Era esperada exatamente uma migration nova" >&2; exit 1; }
[[ "$(q "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '$NAME' AND finished_at IS NOT NULL")" == 1 ]] \
  || { echo "✖ $NAME não registrada como aplicada" >&2; exit 1; }
AFTER="$(snapshot "$COLS")"
if [[ "$BEFORE" != "$AFTER" ]]; then diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true; echo "✖ Dados alterados pela migration" >&2; exit 1; fi
[[ "$(q 'SELECT count(*) FROM notifications WHERE resolved_at IS NOT NULL')" == 0 ]] \
  || { echo "✖ Histórico inventado: notificação antiga marcada como resolvida" >&2; exit 1; }
echo "✔ só a nova migration aplicada; dados idênticos (todas as colunas existentes); $(q 'SELECT count(*) FROM notifications') notificações antigas continuam ATIVAS (resolved_at nulo)"

step "4. Reversão sem avisos resolvidos"
psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$NAME.down.sql" > /dev/null
diff <(echo "$SCHEMA_BEFORE") <(schema_dump) > "$WORK/schema.diff" \
  || { cat "$WORK/schema.diff" >&2; echo "✖ Schema difere do anterior após a reversão" >&2; exit 1; }
[[ "$(snapshot "$COLS")" == "$BEFORE" ]] || { echo "✖ Dados diferem após a reversão" >&2; exit 1; }
[[ "$(q 'SELECT count(*) FROM _prisma_migrations')" == "$M_BEFORE" ]] || { echo "✖ Registro da migration não removido" >&2; exit 1; }
echo "✔ schema idêntico ao anterior (pg_dump -s) e dados idênticos"

step "5. Reaplica; com aviso resolvido a reversão é recusada"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy > /dev/null 2>&1 )
q "UPDATE notifications SET resolved_at = now() WHERE id = (SELECT id FROM notifications ORDER BY created_at LIMIT 1)" > /dev/null
S1="$(schema_dump | md5sum)"; D1="$(snapshot "$(columns | grep -v '^_prisma_migrations|')")"; M1="$(q 'SELECT count(*) FROM _prisma_migrations')"
if out="$(psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$NAME.down.sql" 2>&1)"; then
  echo "✖ Reversão ACEITA com aviso resolvido" >&2; exit 1
fi
echo "  recusada: $(echo "$out" | grep -o 'Reversão bloqueada[^.]*' | head -1)"
[[ "$(schema_dump | md5sum)" == "$S1" && "$(q 'SELECT count(*) FROM _prisma_migrations')" == "$M1" ]] \
  || { echo "✖ Schema/migrations mudaram após a recusa" >&2; exit 1; }
[[ "$(snapshot "$(columns | grep -v '^_prisma_migrations|')")" == "$D1" ]] || { echo "✖ Dados mudaram após a recusa" >&2; exit 1; }
echo "✔ recusa atômica (schema, migrations e dados inalterados)"

psql "$PG_BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB" > /dev/null
echo; echo "✔ Evolução, preservação de dados e reversão condicionada da $NAME verificadas."
