#!/usr/bin/env bash
# Teste LOCAL da conferência da restauração de teste (conferencia-restauracao.sh + sql/), com
# PostgreSQL 16 em contêiner descartável e dados SINTÉTICOS. Nada sai da máquina.
#
# Reproduz a condição da homologação: banco criado aplicando as migrations (como o "prisma migrate
# deploy"), nunca restaurado antes. Backup e restauração com os scripts REAIS (scripts/backup.sh e
# scripts/restore.sh) num contêiner postgres:16 (Debian), como o serviço "backup" da VM.
#
#   1. comparador ANTIGO (commit 4f9b1ae): acusa "NÃO idêntica" com dados idênticos (a falha real);
#   2. comparador novo: aprova, listando as definições reescritas pelo PostgreSQL;
#   3. configurações do banco (fuso, DateStyle) não mudam o resultado;
#   4. cada alteração real na restauração é RECUSADA e localizada (dados, financeiro, linha a
#      mais/a menos, índice, chave estrangeira, CHECK, gatilho, sequência, migration, padrão, enum);
#   5. gravação no original durante a conferência é detectada (não aprova nem culpa o backup);
#   6. backup corrompido é recusado pelo SHA-256 antes de restaurar;
#   7. a pasta do backup vem da saída do próprio backup, não da "última" por nome;
#   8. o diagnóstico não exibe valores de linhas.
# Uso: bash infra/homolog/gcp/testes/test_conferencia_restauracao.sh
set -uo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
C=conf-rest-teste-$$
W="$(mktemp -d)"; chmod 755 "$W"
FALHAS=0
ok() { echo "  ✔ $*"; }
ruim() { echo "  ✘ $*"; FALHAS=$((FALHAS + 1)); }
etapa() { echo; echo "■ $*"; }
fim() { docker rm -f "$C" >/dev/null 2>&1; rm -rf "$W"; }
trap fim EXIT

psql_em() { local db="$1"; shift; docker exec -i "$C" psql -U cenario -d "$db" -At -F'|' -v ON_ERROR_STOP=1 "$@"; }
pg_sh() { docker exec "$C" sh -c "$1"; }
CONF_SQL="$RAIZ/infra/homolog/gcp/sql"
# shellcheck source=../conferencia-restauracao.sh
source "$RAIZ/infra/homolog/gcp/conferencia-restauracao.sh"
backup_ctr() { docker run --rm --network "container:$C" -v "$W:/w" -v "$RAIZ/scripts:/scripts:ro" -w /tmp \
  -e APP_ENV=staging -e DATABASE_URL=postgresql://cenario:x@127.0.0.1:5432/original -e STORAGE_DIR=/w/storage \
  -e BACKUP_RETENTION_DAYS=0 postgres:16 "$@"; }
restaurar_em() { # restaurar_em <pasta> <banco>: banco recriado vazio + scripts/restore.sh (como vm.sh)
  psql_em postgres -q -c "DROP DATABASE IF EXISTS $2 WITH (FORCE)" -c "CREATE DATABASE $2 OWNER cenario" >/dev/null
  backup_ctr bash /scripts/restore.sh "/w/bk/$1" --target "postgresql://cenario:x@127.0.0.1:5432/$2" --storage /tmp/rs --yes >/dev/null
}
conferir() { # conferir <restaurado> → código; saída em $W/saida
  local d; d="$(mktemp -d)"; impressao_de original > "$d/antes"
  criar_referencia original ref >/dev/null 2>&1
  conferir_restauracao "$d/antes" original "$1" ref "$d" > "$W/saida" 2>&1; local rc=$?
  rm -rf "$d"; return "$rc"
}

etapa "Preparação: PostgreSQL 16 (alpine, como na VM), migrations aplicadas diretamente, dados sintéticos"
docker run -d --name "$C" -e POSTGRES_USER=cenario -e POSTGRES_PASSWORD=x -e POSTGRES_DB=original postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$C" pg_isready -U cenario -d original >/dev/null 2>&1 && break; sleep 1; done; sleep 2
psql_em original -q >/dev/null <<'SQL'
CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0);
SQL
n=0
for m in "$RAIZ"/packages/db/prisma/migrations/2*/; do
  nome="$(basename "$m")"; [[ "$nome" > 20261017999999 ]] && break   # as 12 da versão publicada
  psql_em original -q < "$m/migration.sql" >/dev/null 2>&1 || { ruim "migration $nome"; continue; }
  psql_em original -q -c "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
    VALUES (gen_random_uuid()::text, md5('$nome'), now(), '$nome', 1)" >/dev/null
  n=$((n + 1))
done
psql_em original -q >/dev/null <<'SQL' || ruim "dados sintéticos"
INSERT INTO users (id, email, display_name, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'gestor@teste.local', 'Gestor Fictício', now()),
  ('22222222-2222-4222-8222-222222222222', NULL, 'Tapeceiro Fictício', now());
INSERT INTO account_payables (id, beneficiary, category, description, amount_cents, due_date, updated_at, created_by_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Fornecedor Fictício A', 'LOGISTICA', 'Frete teste', 15000, '2026-10-17', now(), '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'Fornecedor Fictício B', 'LOGISTICA', 'Frete teste 2', 4990, '2026-10-24', now(), NULL);
INSERT INTO customers (id, kind, name, search_text, updated_at) VALUES ('cccccccc-0000-4000-8000-000000000001', 'PF', 'Cliente Fictício', 'cliente ficticio', now());
SQL
[[ "$n" == 12 ]] && ok "12 migrations aplicadas sem dump/restore; $(psql_em original -c 'select count(*) from pg_tables where schemaname = $$public$$') tabelas; dados fictícios" || ruim "migrations: $n"
mkdir -p "$W/storage" "$W/bk"; echo "arquivo fictício" > "$W/storage/foto-teste.txt"
backup_ctr bash /scripts/backup.sh /w/bk > "$W/backup.log" 2>&1 || { cat "$W/backup.log"; ruim "backup.sh"; }
PASTA="$(sed -n 's#^✔ Backup concluído: /w/bk/\(cenario-[A-Za-z0-9._-]*\)$#\1#p' "$W/backup.log")"
[[ -n "$PASTA" ]] && ok "backup.sh: $PASTA (SHA-256)" || ruim "pasta do backup"

etapa "1. Comparador ANTIGO reproduz a falha (dados idênticos, catálogo com texto reescrito)"
restaurar_em "$PASTA" restaurado
if git -C "$RAIZ" cat-file -e 4f9b1ae:infra/homolog/gcp/sql/impressao-digital.sql 2>/dev/null; then
  git -C "$RAIZ" show 4f9b1ae:infra/homolog/gcp/sql/impressao-digital.sql > "$W/antigo.sql"
  for db in original restaurado; do psql_em "$db" < "$W/antigo.sql" | grep -vE '^(BEGIN|ROLLBACK)$' > "$W/antigo-$db"; done
  if ! cmp -s "$W/antigo-original" "$W/antigo-restaurado"; then
    ok "antigo: restauração de teste NÃO idêntica"
    so="$(diff "$W/antigo-original" "$W/antigo-restaurado" | grep '^<' | cut -d'|' -f1 | sort -u | xargs)"
    [[ "$so" == "< catalogo" ]] && ok "única diferença: a linha agregada do catálogo (mesma contagem, md5 diferente)" || ruim "diferenças inesperadas: $so"
    [[ -z "$(diff <(cut -d'|' -f1-3 "$W/antigo-restaurado") <(cut -d'|' -f1-3 "$W/antigo-original"))" ]] \
      && ok "o diagnóstico antigo (cut -f1-3) não mostrava NADA" || ruim "diagnóstico antigo mostrava algo"
  else ruim "comparador antigo não reproduziu a falha"; fi
else echo "  • commit 4f9b1ae ausente neste clone: etapa 1 pulada"; fi

etapa "2. Comparador novo aprova a restauração fiel"
conferir restaurado; rc=$?
[[ "$rc" == 0 ]] && ok "aprovada (código 0)" || { ruim "código $rc"; cat "$W/saida"; }
grep -q 'IGUAIS ao original' "$W/saida" && ok "dados, estrutura, sequências, migrations e financeiro iguais" || ruim "mensagem de igualdade"
r="$(sed -n 's/.*• \([0-9]*\) definição(ões) com texto reescrito.*/\1/p' "$W/saida")"
[[ "${r:-0}" -gt 0 ]] && ok "$r definição(ões) reescrita(s) pelo PostgreSQL listadas (iguais à referência)" || ruim "reescritas não listadas"
grep -q '^  itens: [0-9]* · tabelas: [0-9]* · colunas financeiras: [0-9]* · migrations: 12' "$W/saida" && ok "$(grep '^  itens' "$W/saida" | sed 's/^ *//')" || ruim "resumo"

etapa "3. Configurações do banco original (fuso, DateStyle) não mudam o resultado"
psql_em postgres -q -c "ALTER DATABASE original SET TimeZone = 'America/Sao_Paulo'" -c "ALTER DATABASE original SET DateStyle = 'SQL, DMY'" >/dev/null
conferir restaurado && ok "aprovada com fuso America/Sao_Paulo e DateStyle SQL, DMY no original" || { ruim "falhou com configurações do banco"; cat "$W/saida"; }
psql_em postgres -q -c "ALTER DATABASE original RESET ALL" >/dev/null

etapa "4. Alterações reais na restauração são RECUSADAS e localizadas"
caso() { # caso <descrição> <sql no banco restaurado> <texto esperado no diagnóstico>
  restaurar_em "$PASTA" restaurado
  psql_em restaurado -q -c "$2" >/dev/null 2>&1 || { ruim "$1: SQL do teste falhou"; return; }
  conferir restaurado; local rc=$?
  if [[ "$rc" == 1 ]] && grep -qF -- "$3" "$W/saida"; then ok "$1 → recusada: $(grep -F -m1 -- "$3" "$W/saida" | sed 's/^ *//' | cut -c1-110)"
  else ruim "$1 (código $rc)"; cat "$W/saida"; fi
}
caso "valor financeiro +1 centavo" "UPDATE account_payables SET amount_cents = amount_cents + 1 WHERE description = 'Frete teste'" "financeiro account_payables.amount_cents"
caso "texto de uma linha" "UPDATE account_payables SET beneficiary = 'Outro' WHERE description = 'Frete teste 2'" "colunas com valores diferentes: beneficiary"
caso "linha a menos" "DELETE FROM customers WHERE id = 'cccccccc-0000-4000-8000-000000000001'" "linhas só no original 1 (chaves: cccccccc-0000-4000-8000-000000000001)"
caso "linha a mais" "INSERT INTO users (id, display_name, updated_at) VALUES ('33333333-3333-4333-8333-333333333333', 'Extra', now())" "linhas só na restauração 1"
caso "índice removido" "DROP INDEX users_email_key" "indice users_email_key: ausente em restaurado"
caso "chave estrangeira removida" "ALTER TABLE account_payables DROP CONSTRAINT account_payables_supplier_id_fkey" "restricao account_payables.account_payables_supplier_id_fkey: ausente"
caso "CHECK alterada (mesmo nome)" "ALTER TABLE account_payables DROP CONSTRAINT account_payables_status, ADD CONSTRAINT account_payables_status CHECK (status IN ('ABERTO', 'PAGO'))" "def-restricao account_payables.account_payables_status"
caso "gatilho desativado" "ALTER TABLE audit_logs DISABLE TRIGGER ALL" "gatilho audit_logs."
caso "sequência adiantada" "SELECT setval('account_payables_number_seq', 999)" "sequência account_payables_number_seq"
caso "migration desfeita" "UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name LIKE '20261017%'" "migrations aplicadas"
caso "padrão de coluna alterado" "ALTER TABLE account_payables ALTER COLUMN paid_cents SET DEFAULT 1" "def-padrao account_payables.paid_cents"
caso "tipo de coluna alterado" "ALTER TABLE account_payables ALTER COLUMN description TYPE varchar(300)" "coluna account_payables.description"
caso "tabela removida" "DROP TABLE auth_throttle" "tabela auth_throttle: ausente em restaurado"
caso "linha de outra tabela financeira" "UPDATE account_payables SET paid_cents = 100, status = 'PARCIAL' WHERE description = 'Frete teste'" "financeiro account_payables.paid_cents"
grep -qE 'Fornecedor Fictício|Frete teste|gestor@teste|Cliente Fictício' "$W/saida" && ruim "diagnóstico exibiu valores de linhas" || ok "diagnóstico sem valores de linhas (só nomes, contagens, somas e chaves técnicas)"

etapa "5. Gravação no ORIGINAL durante a conferência"
restaurar_em "$PASTA" restaurado
d="$(mktemp -d)"; impressao_de original > "$d/antes"; criar_referencia original ref >/dev/null 2>&1
psql_em original -q -c "UPDATE users SET display_name = 'Mudou' WHERE display_name = 'Tapeceiro Fictício'" >/dev/null
conferir_restauracao "$d/antes" original restaurado ref "$d" > "$W/saida" 2>&1; rc=$?
[[ "$rc" == 2 ]] && grep -q 'ORIGINAL mudou' "$W/saida" && grep -q 'tabela users' "$W/saida" \
  && ok "detectada (código 2): original mudou, tabela users apontada, sem aprovar nem reprovar o backup" || { ruim "código $rc"; cat "$W/saida"; }
grep -q 'sessão:' "$W/saida" || grep -q 'conexões ao banco' "$W/saida" && ok "lista as conexões ao banco (sem texto de consulta)" || ruim "conexões"
psql_em original -q -c "UPDATE users SET display_name = 'Tapeceiro Fictício' WHERE display_name = 'Mudou'" >/dev/null; rm -rf "$d"

etapa "6. Backup corrompido é recusado antes de restaurar"
cp -a "$W/bk/$PASTA" "$W/bk/$PASTA-corrompido"; printf 'x' >> "$W/bk/$PASTA-corrompido/database.dump"
psql_em postgres -q -c "DROP DATABASE IF EXISTS restaurado WITH (FORCE)" -c "CREATE DATABASE restaurado OWNER cenario" >/dev/null
if backup_ctr bash /scripts/restore.sh "/w/bk/$PASTA-corrompido" --target postgresql://cenario:x@127.0.0.1:5432/restaurado --yes > "$W/saida" 2>&1; then
  ruim "backup corrompido restaurado"
else
  [[ "$(psql_em restaurado -c 'select count(*) from pg_tables where schemaname = $$public$$')" == 0 ]] && ok "recusado pelo SHA-256; banco de destino intocado" || ruim "destino alterado"
fi
rm -rf "$W/bk/$PASTA-corrompido"

etapa "7. A pasta vem da saída do próprio backup (não da última por nome)"
mkdir -p "$W/bk/cenario-staging-29991231T235959Z" "$W/bk/cenario-zz-isca"
backup_ctr bash /scripts/backup.sh /w/bk > "$W/backup2.log" 2>&1
nova="$(sed -n 's#^✔ Backup concluído: /w/bk/\(cenario-[A-Za-z0-9._-]*\)$#\1#p' "$W/backup2.log")"
por_nome="$(ls -1d "$W"/bk/cenario-* | tail -1 | xargs basename)"
[[ -n "$nova" && -f "$W/bk/$nova/database.dump" && "$nova" != "$PASTA" ]] && ok "saída do backup: $nova" || ruim "pasta nova: '$nova'"
[[ "$por_nome" != "$nova" ]] && ok "a regra antiga (ls | tail -1) escolheria '$por_nome' — o erro que a correção evita" || ruim "isca não testou nada"
grep -q "sed -n 's#^✔ Backup concluído: /data/backups/" "$RAIZ/infra/homolog/gcp/vm.sh" && ! grep -q "ls -1d /data/backups/cenario-\* | tail -1" "$RAIZ/infra/homolog/gcp/vm.sh" \
  && ok "vm.sh usa a saída do backup e não usa mais 'ls | tail -1'" || ruim "vm.sh ainda escolhe por nome"

echo
(( FALHAS == 0 )) && echo "RESULTADO: todos os cenários OK" || { echo "RESULTADO: $FALHAS falha(s)"; exit 1; }
