#!/usr/bin/env bash
# Evolução, Fase 8 — prova da migração ENCADEADA das Fases 2–7 a partir do código anterior à
# Evolução, com rollback condicionado e backup/restauração. Somente bancos LOCAIS descartáveis.
#
# Uso: PG_BASE=postgresql://usuario:senha@127.0.0.1:55432 scripts/test-evolution-migrations.sh
#   PG_BASE   servidor PostgreSQL local (sem o nome do banco); obrigatório.
#   LEGACY_REF commit anterior à Evolução (padrão 839770a).
#   LEGACY_INSTALL_FLAGS flags extras do `pnpm install` do legado (padrão --offline).
# Etapas:
#  1. worktree do código legado; banco gerado pelas migrations legadas + fluxo completo (32 passos);
#  2. fotografia: por tabela, contagem + md5 das colunas EXISTENTES; índices; restrições;
#  3. `prisma migrate deploy` SÓ das migrations da Evolução (até EVOLUTION_LAST); idêntica;
#  4. rollbacks 7→6→5→3→2 sem dados novos: schema idêntico ao legado (pg_dump -s) e dados idênticos;
#  5. cadeia COMPLETA (todas as migrations, inclusive as posteriores à Evolução): dados legados
#     idênticos, salvo os acréscimos documentados (permissões); código atual lê o legado (`read`);
#     as migrations posteriores com reversão (LATE_DOWNS) revertem e reaplicam sem perda;
#  6. cria dados novos (check `write`); cada rollback da Evolução é RECUSADO sem mutação;
#  7. backup + restauração (scripts/test-backup-restore.sh) do banco com dados de todas as fases.
# Rodada 3 (F1-12a/F10-22): as migrations de 2027 (posteriores à Evolução) quebravam a etapa 3
# (acrescentam `financeiro.producao_propria` a funções existentes). A Evolução é provada no seu
# recorte e a cadeia completa à parte.
# Rodada 4 (F1-05/F1-04): as seis migrations de 2027 que não tinham reversão ganharam .down.sql
# condicionado. Etapa 5: TODAS as posteriores à Evolução revertem (schema idêntico ao da Evolução,
# dados legados idênticos) e reaplicam (schema e dados idênticos à cadeia completa). Etapa 6: cada
# uma é RECUSADA, sem mutação, quando existe dado que ela perderia (salvo a 20270126, só de
# permissão, como a 20261220).
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
# 20261220000000_recebimentos_permissao_funcoes fica fora de DOWNS (só em ALL_DOWNS): é migration
# só de dados cuja reversão é incondicional por desenho (limitação documentada no próprio .down.sql).
DOWNS=(20261230000000_modelos_simplificados 20261228000000_titular_mao_de_obra_prevista 20261227000000_servico_sem_retirada 20261213000000_pre_planejamento 20261206000000_recebimentos_compartilhados 20261129000000_novo_servico 20261115000000_fechamento_semanal 20261108000000_custos_logistica
  20261101000000_mao_de_obra_revisao 20261025000000_distribuicao_automatica
  20261018000000_fila_semanal)
# Correção global: roteiro (só a ordem das paradas; reversão sem perda de compromisso).
# Simplificação Fases 2–4: as mais recentes são revertidas primeiro (sem dados novos).
# Simplificação Fase 5: modelos simplificados (novos registros + colunas) é a mais recente.
# Última migration da Evolução (recorte das etapas 3–4).
EVOLUTION_LAST=20261230000000_modelos_simplificados
# Posteriores à Evolução com reversão própria (a mais recente primeiro). Sem dados novos.
LATE_DOWNS=(20270223000000_custo_operacional_equipe_propria 20270216000000_notificacoes_resolvidas
  20270209000000_presenca_apoio_simplificados 20270202000000_negociacao_confirmacao_semanal
  20270126000000_meus_ganhos_permissao 20270119000000_cobranca_cliente
  20270112000000_compra_antes_da_chegada 20270105000000_necessidade_substituicao)
# Recusadas com dados novos na etapa 6. A 20270126 (só concede uma permissão às duas funções da
# migration, sem dado de negócio) fica fora, como a 20261220 fica fora de DOWNS.
LATE_REFUSE=(20270223000000_custo_operacional_equipe_propria 20270216000000_notificacoes_resolvidas
  20270209000000_presenca_apoio_simplificados 20270202000000_negociacao_confirmacao_semanal
  20270119000000_cobranca_cliente 20270112000000_compra_antes_da_chegada
  20270105000000_necessidade_substituicao)
# Acréscimos documentados de permissão a funções existentes (função:permissão, regex):
#  - 20261220000000_recebimentos_permissao_funcoes: recebimentos.registrar (três funções);
#  - 20270126000000_meus_ganhos_permissao: financeiro.producao_propria (tapeceiro e logística).
RP_DOCUMENTED=':recebimentos\.registrar$|^(tapeceiro|logistica_terceirizada):financeiro\.producao_propria$'
ALL_DOWNS=(20261230000000_modelos_simplificados 20261228000000_titular_mao_de_obra_prevista 20261227000000_servico_sem_retirada 20261220000000_recebimentos_permissao_funcoes
  20261213000000_pre_planejamento
  20261206000000_recebimentos_compartilhados 20261129000000_novo_servico
  20261122000000_roteiro_logistica "${DOWNS[@]:6}")

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
# LEGACY_INSTALL_FLAGS: no CI a instalação do legado usa a rede (o cache local não tem as versões
# antigas); localmente o padrão é offline.
( cd "$LEGACY" && pnpm install ${LEGACY_INSTALL_FLAGS:---offline} --frozen-lockfile > "$WORK/install.log" 2>&1 ) \
  || { tail -20 "$WORK/install.log" >&2; echo "✖ Instalação do código legado falhou" >&2; exit 1; }
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
# role_permissions é conferida à parte: a migration 20261220000000_recebimentos_permissao_funcoes
# ACRESCENTA, por desenho, recebimentos.registrar a três funções da oficina.
# production_templates/_steps também: a migration 20261230000000_modelos_simplificados ACRESCENTA,
# por desenho, dois modelos (ids fixos) — os registros legados são conferidos à parte (tpl_rows).
COLS_RP="$(echo "$COLS" | grep -v -E '^(role_permissions|production_templates|production_template_steps)\|')"
rp_rows() { q "SELECT r.key || ':' || p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id ORDER BY 1"; }
RP_BEFORE="$(rp_rows)"
SIMPLIFIED="'5f5e0000-0000-4000-8000-000000000001','5f5e0000-0000-4000-8000-000000000002'"
TPL_COLS="$(echo "$COLS" | grep -E '^production_template(s|_steps)\|')"
tpl_rows() {
  while IFS='|' read -r t c; do
    local expr key
    expr="$(echo "$c" | sed 's/,/","/g')"
    [[ "$t" == production_templates ]] && key=id || key=template_id
    echo "$t|$(q "SELECT count(*) || ':' || coalesce(md5(string_agg(r::text, '/' ORDER BY r::text)), '-')
      FROM (SELECT (\"$expr\") AS r FROM \"$t\" WHERE \"$key\" NOT IN ($SIMPLIFIED)) x")"
  done <<< "$TPL_COLS"
}
TPL_BEFORE="$(tpl_rows)"
BEFORE="$(snapshot "$COLS_RP")"
IDX_BEFORE="$(indexes)"
SCHEMA_BEFORE="$(schema_dump)"
echo "tabelas fotografadas: $(echo "$BEFORE" | wc -l)"

# Diretório de migrations recortado até EVOLUTION_LAST (cópia dos mesmos arquivos; o Prisma
# não segue links simbólicos).
SUB="$WORK/prisma-evolucao"
mkdir -p "$SUB/migrations"
cp "$ROOT/packages/db/prisma/schema.prisma" "$SUB/schema.prisma"
cp "$ROOT/packages/db/prisma/migrations/migration_lock.toml" "$SUB/migrations/"
for m in "$ROOT"/packages/db/prisma/migrations/*/; do
  n="$(basename "$m")"
  [[ "$n" > "$EVOLUTION_LAST" ]] || cp -r "$m" "$SUB/migrations/$n"
done
check_legacy_preserved() {
  local label="$1" after rp_after rp_added
  after="$(snapshot "$COLS_RP")"
  if [[ "$BEFORE" != "$after" ]]; then diff <(echo "$BEFORE") <(echo "$after") >&2 || true; echo "✖ Dados legados alterados ($label)" >&2; exit 1; fi
  [[ "$(tpl_rows)" == "$TPL_BEFORE" ]] || { echo "✖ Modelos de produção legados alterados ($label)" >&2; exit 1; }
  rp_after="$(rp_rows)"
  [[ -z "$(comm -23 <(echo "$RP_BEFORE") <(echo "$rp_after"))" ]] \
    || { echo "✖ Permissões legadas removidas ($label)" >&2; exit 1; }
  rp_added="$(comm -13 <(echo "$RP_BEFORE") <(echo "$rp_after") | grep -v -E "$RP_DOCUMENTED" || true)"
  [[ -z "$rp_added" ]] || { echo "✖ Permissões inesperadas ($label): $rp_added" >&2; exit 1; }
  echo "✔ [$label] dados legados idênticos ($(echo "$after" | wc -l) tabelas); modelos simplificados: $(q "SELECT count(*) FROM production_templates WHERE id IN ($SIMPLIFIED)"); permissões acrescentadas (documentadas): $(comm -13 <(echo "$RP_BEFORE") <(echo "$rp_after") | tr '\n' ' ')"
}

step "3. Migrations da Evolução (Fases 2–7, até $EVOLUTION_LAST)"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy --schema "$SUB/schema.prisma" 2>&1 | grep -E 'Applying|applied|Error' )
check_legacy_preserved "Evolução"
SCHEMA_EVO="$(schema_dump)"
AFTER="$(snapshot "$COLS_RP")"
# Substituições DOCUMENTADAS (regra nova mais específica no lugar da antiga):
#  - Fase 5: production_payables_item_active/order_active → uma obrigação viva por
#    peça E profissional (production_payables_one_live_per_piece_professional/_os_professional);
#  - Fase 6: rateio único por (custo, OS) → por (custo, OS, revisão) (histórico de rateios).
REPLACED="logistics_cost_allocations_logistics_cost_id_service_order__key
production_payables_item_active
production_payables_order_active"
check_indexes() {
  local missing
  missing="$(comm -23 <(echo "$IDX_BEFORE") <(indexes) | comm -23 - <(echo "$REPLACED" | sort))"
  [[ -z "$missing" ]] || { echo "✖ Índices legados removidos sem substituição documentada: $missing" >&2; exit 1; }
  echo "✔ índices legados preservados (3 substituições documentadas); novos: $(comm -13 <(echo "$IDX_BEFORE") <(indexes) | wc -l)"
}
check_indexes
echo "valores derivados: planos=$(q "SELECT string_agg(mode || '=' || n, ',') FROM (SELECT mode, count(*) n FROM production_plans GROUP BY 1) x") \
custos_logistica=$(q "SELECT coalesce(string_agg(status || '=' || n, ','), 'nenhum') FROM (SELECT status, count(*) n FROM logistics_costs GROUP BY 1) x")"

step "4. Rollbacks sem dados novos (pré-planejamento → recebimentos → novo serviço → roteiro → 7 → 6 → 5 → 3 → 2)"
for d in "${ALL_DOWNS[@]}"; do
  psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$d.down.sql" > /dev/null
  echo "  revertida: $d"
done
diff <(echo "$SCHEMA_BEFORE") <(schema_dump) > "$WORK/schema.diff" \
  || { cat "$WORK/schema.diff" >&2; echo "✖ Schema difere do legado após rollback" >&2; exit 1; }
RB="$(snapshot "$COLS_RP")"
if [[ "$RB" != "$AFTER" ]]; then diff <(echo "$AFTER") <(echo "$RB") >&2 || true; echo "✖ Dados diferem após rollback" >&2; exit 1; fi
[[ "$(rp_rows)" == "$RP_BEFORE" ]] || { echo "✖ Permissões diferem do legado após rollback" >&2; exit 1; }
[[ "$(tpl_rows)" == "$TPL_BEFORE" && "$(q "SELECT count(*) FROM production_templates WHERE id IN ($SIMPLIFIED)")" == 0 ]] \
  || { echo "✖ Modelos de produção diferem do legado após rollback" >&2; exit 1; }
echo "✔ schema idêntico ao legado (pg_dump -s) e dados idênticos"

step "5. Cadeia completa (todas as migrations) sobre o legado"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy 2>&1 | grep -E 'Applying|applied|Error' )
check_legacy_preserved "cadeia completa"
check_indexes
echo "migrations aplicadas: $(q 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
( cd "$ROOT/apps/api" && MIGRATION_CHECK_STEP=read TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" \
    CHECKPOINT_DISABLE=1 npx vitest run --config vitest.migration.config.ts 2>&1 | grep -E 'MIGRACAO|✓|×|Tests|Error' )
# Reversão e reaplicação das posteriores que têm .down.sql (sem dados novos).
FULL_SCHEMA="$(schema_dump)"; FULL_DATA="$(snapshot "$(columns)")"
# Rodada 4: fotografia das colunas legadas logo antes de reverter (o `read` acima já gravou sessão
# e auditoria do login — dados legítimos que a reversão também não pode tocar).
PRE_LATE="$(snapshot "$COLS_RP")"; PRE_LATE_TPL="$(tpl_rows)"
for d in "${LATE_DOWNS[@]}"; do
  psql "$URL" -q -v ON_ERROR_STOP=1 -f "$ROOT/packages/db/rollback/$d.down.sql" > /dev/null
  [[ "$(q "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '$d'")" == 0 ]] \
    || { echo "✖ $d: registro da migration não removido" >&2; exit 1; }
  echo "  revertida: $d"
done
# Rodada 4 (F1-05): de volta exatamente ao esquema da Evolução, com os dados legados intactos.
diff <(echo "$SCHEMA_EVO") <(schema_dump) > "$WORK/late-evo.diff" \
  || { cat "$WORK/late-evo.diff" >&2; echo "✖ Schema difere do da Evolução após reverter as posteriores" >&2; exit 1; }
POST_LATE="$(snapshot "$COLS_RP")"
if [[ "$PRE_LATE" != "$POST_LATE" ]]; then diff <(echo "$PRE_LATE") <(echo "$POST_LATE") >&2 || true; echo "✖ Dados alterados ao reverter as posteriores" >&2; exit 1; fi
[[ "$(tpl_rows)" == "$PRE_LATE_TPL" ]] || { echo "✖ Modelos alterados ao reverter as posteriores" >&2; exit 1; }
# Permissões: só sai o que a 20270126 acrescentou (as da Evolução — 20261220 — continuam).
rp_late="$(comm -13 <(echo "$RP_BEFORE") <(rp_rows) | grep -v -E ':recebimentos\.registrar$' || true)"
[[ -z "$rp_late" ]] || { echo "✖ Permissões fora da Evolução após reverter as posteriores: $rp_late" >&2; exit 1; }
[[ -z "$(comm -23 <(echo "$RP_BEFORE") <(rp_rows))" ]] || { echo "✖ Permissões legadas removidas ao reverter as posteriores" >&2; exit 1; }
echo "✔ posteriores revertidas: dados idênticos aos de antes da reversão ($(echo "$POST_LATE" | wc -l) tabelas); permissões de volta às da Evolução"
echo "✔ posteriores revertidas: schema idêntico ao da Evolução ($(q 'SELECT count(*) FROM _prisma_migrations') migrations)"
( cd "$ROOT/packages/db" && DATABASE_URL="$URL" pnpm exec prisma migrate deploy > /dev/null 2>&1 )
diff <(echo "$FULL_SCHEMA") <(schema_dump) > "$WORK/late.diff" \
  || { cat "$WORK/late.diff" >&2; echo "✖ Schema difere após reverter e reaplicar as posteriores" >&2; exit 1; }
[[ "$(snapshot "$(columns)" | grep -v '^_prisma_migrations|')" == "$(echo "$FULL_DATA" | grep -v '^_prisma_migrations|')" ]] \
  || { echo "✖ Dados diferem após reverter e reaplicar as posteriores" >&2; exit 1; }
echo "✔ posteriores revertidas e reaplicadas: schema e dados idênticos"

step "6. Cria dados novos e prova a RECUSA de cada rollback (Evolução e posteriores)"
( cd "$ROOT/apps/api" && MIGRATION_CHECK_STEP=write TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" \
    CHECKPOINT_DISABLE=1 npx vitest run --config vitest.migration.config.ts 2>&1 | grep -E 'MIGRACAO|✓|×|Tests|Error' )
S1="$(schema_dump | md5sum)"; M1="$(q 'SELECT count(*) FROM _prisma_migrations')"
D1="$(snapshot "$(columns)")"
for d in "${DOWNS[@]}" "${LATE_REFUSE[@]}"; do
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
