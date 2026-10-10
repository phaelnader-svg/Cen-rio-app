#!/usr/bin/env bash
# ENSAIO LOCAL da atualização controlada da homologação (Evolução — pré-deploy). Usa a pilha REAL
# (docker-compose.homolog.yml, Caddy, PostgreSQL 16, contêiner de backup) e o vm.sh deste commit,
# com dados SINTÉTICOS. Nada sai da máquina: sem Google Cloud, sem bucket, sem Secret Manager.
#
# Requisitos: Docker; portas 80/443 livres; imagens locais
#   local/cenario/{api,web}:$PUB   (versão publicada — ex.: fd6dc19)
#   local/cenario/{api,web}:$CAND  (candidata — construída deste commit)
# e FIXTURE = pg_dump -Fc de um banco no schema de $PUB com dados sintéticos.
#
# Uso: PUB=fd6dc19 CAND=<sha> FIXTURE=/caminho/fixture.dump OUT=/dir/evidencias \
#        bash infra/homolog/gcp/testes/ensaio-atualizacao.sh
# ATENÇÃO: apaga e recria os volumes LOCAIS do projeto Compose "cenario-homolog". Recusa rodar
# dentro de uma VM do Google Cloud.
set -uo pipefail
: "${PUB:?PUB}" "${CAND:?CAND}" "${FIXTURE:?FIXTURE}" "${OUT:?OUT}"
if curl -fsS -m 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/ >/dev/null 2>&1; then
  echo "Recusado: isto parece uma VM do Google Cloud. O ensaio é só local." >&2; exit 2
fi
RAIZ="$(cd "$(dirname "$0")/../../../.." && pwd)"
VMSH="$RAIZ/infra/homolog/gcp/vm.sh"
W="$(mktemp -d)"; mkdir -p "$OUT"
FALHAS=0
ok() { echo "  ✔ $*"; }
ruim() { echo "  ✘ $*"; FALHAS=$((FALHAS + 1)); }
etapa() { echo; echo "■ $*"; }
espera_codigo() { # espera_codigo <esperado> <comando…>: o comando deve sair com esse código
  local esp="$1"; shift; local rc=0; "$@" > "$W/ultimo.log" 2>&1 || rc=$?
  if [[ "$rc" == "$esp" ]]; then ok "saída $rc: $(grep -m1 -E '✘|✔|recusad|Uso' "$W/ultimo.log" | cut -c1-140)"
  else ruim "saída $rc (esperado $esp)"; tail -15 "$W/ultimo.log"; fi
}

# Ambiente sintético (valores aleatórios locais; nunca os reais).
PROXY="$(openssl rand -hex 12)"; echo "$PROXY" > "$W/proxy"; chmod 600 "$W/proxy"
HASH="$(printf '%s\n' "$PROXY" | docker run -i --rm caddy:2.10-alpine caddy hash-password)"
cat > "$W/env" <<EOF
HOMOLOG_DOMAIN='homolog.localhost'
POSTGRES_PASSWORD='$(openssl rand -hex 16)'
TOKEN_HASH_SECRET='$(openssl rand -hex 32)'
SEED_ADMIN_EMAIL='gestor@teste.local'
SEED_ADMIN_PASSWORD='SenhaDeTeste123'
SEED_ADMIN_NAME='Gestor Ensaio'
HOMOLOG_BASIC_USER='homologacao'
HOMOLOG_BASIC_HASH='$HASH'
HOMOLOG_GATE_TOKEN='$(openssl rand -hex 32)'
CENARIO_API_IMAGE='local/cenario/api:$PUB'
CENARIO_WEB_IMAGE='local/cenario/web:$PUB'
EOF
chmod 600 "$W/env"; touch "$W/portao"
export CENARIO_DIR="$RAIZ" CENARIO_ENV_FILE="$W/env" CENARIO_PORTAO="$W/portao" CENARIO_STATE_DIR="$W/estado"
export CENARIO_META_URL="http://127.0.0.1:9" CENARIO_PROJECT="" CENARIO_BUCKET="" CENARIO_REGISTRY="local/cenario"
export CENARIO_DOMAIN="homolog.localhost" CENARIO_PROXY_SENHA_ARQ="$W/proxy" CENARIO_CERT_MIN_DIAS=0 CENARIO_ESPERA=36
COMPOSE=(docker compose -f "$RAIZ/infra/homolog/docker-compose.homolog.yml" --env-file "$W/env")
vm() { bash "$VMSH" "$@"; }
psqlh() { "${COMPOSE[@]}" exec -T postgres psql -U cenario -d cenario_homolog -At "$@"; }
psqlp() { "${COMPOSE[@]}" exec -T postgres psql -U cenario -d postgres -At "$@"; }
BASE="https://homolog.localhost"; RES=(--resolve "homolog.localhost:443:127.0.0.1")
gate() { sed -n "s/^HOMOLOG_GATE_TOKEN='\(.*\)'/\1/p" "$W/env"; }
http() { curl -s --cacert "$W/ca.crt" "${RES[@]}" -H "Cookie: cenario_homolog=$(gate)" "$@"; }
fim() {
  "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$W"
}
trap fim EXIT
saude_ok() { if vm saude > "$W/saude.log" 2>&1; then ok "vm.sh saude: OK ($(grep -c '^✔' "$W/saude.log") verificações)"; else ruim "vm.sh saude falhou"; grep '^✘' "$W/saude.log"; fi; }
login() { # login → cookie da sessão do gestor em $W/jar
  rm -f "$W/jar"
  http -c "$W/jar" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE" \
    -d '{"email":"gestor@teste.local","password":"SenhaDeTeste123"}' "$BASE/api/auth/login"
}
api_get() { http -b "$W/jar" -o "$W/resp.json" -w '%{http_code}' -H "origin: $BASE" "$BASE$1"; }

etapa "0. Pilha limpa com a versão PUBLICADA ($PUB) e o banco de dados sintético"
"${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
CENARIO_TAG="$PUB" vm iniciar > "$OUT/00-iniciar-publicada.log" 2>&1 || true
"${COMPOSE[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$W/ca.crt" > /dev/null 2>&1
export CENARIO_CACERT="$W/ca.crt"
"${COMPOSE[@]}" stop api web > /dev/null 2>&1
# Como na VM real: o esquema é o criado pelas migrations da imagem publicada (NUNCA passou por um
# dump/restore — o texto de algumas CHECK muda na 1ª restauração). Só os DADOS vêm do FIXTURE.
psqlh -q -c "DO \$\$ BEGIN EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' CASCADE'
  FROM pg_tables WHERE schemaname = 'public'); END \$\$" > /dev/null
"${COMPOSE[@]}" exec -T postgres pg_restore -U cenario -d cenario_homolog --no-owner --data-only --disable-triggers --exit-on-error < "$FIXTURE"
"${COMPOSE[@]}" up -d --no-build > /dev/null 2>&1
sleep 25
for _ in $(seq 1 30); do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q api)")" == healthy ]] && break; sleep 5; done
"${COMPOSE[@]}" exec -T backup bash /scripts/backup.sh /data/backups > /dev/null 2>&1
[[ "$(psqlh -c "select count(*) from pg_constraint where pg_get_constraintdef(oid) like '%])::text[])%'")" -gt 0 ]] \
  && ok "esquema criado pelas migrations (CHECKs com o texto original, nunca restaurado)" || ruim "esquema já normalizado: o ensaio não reproduz a VM"
[[ "$(psqlh -c 'select count(*) from _prisma_migrations')" == 12 ]] && ok "banco publicado: 12 migrations" || ruim "banco publicado sem 12 migrations"
saude_ok
[[ "$(login)" == 200 ]] && ok "login do gestor na versão publicada (via proxy)" || ruim "login na versão publicada"
vm impressao-digital > "$OUT/01-impressao-publicada.txt"

etapa "0b. Auditoria SOMENTE LEITURA (como no Cloud Shell → VM): nada muda"
fp0="$(vm impressao-digital | md5sum)"; ids0="$("${COMPOSE[@]}" ps -q | sort | xargs)"
{ printf 'PREFLIGHT_SQL=$(cat <<'"'"'SQLFIM'"'"'\n'; cat "$RAIZ/infra/homolog/gcp/sql/preflight-evolucao.sql"; printf 'SQLFIM\n)\n'
  echo 'auditoria() {'; cat "$RAIZ/infra/homolog/gcp/vm-auditoria.sh"; echo '}'; echo 'auditoria < /dev/null'; } | bash -s > "$OUT/00-auditoria-somente-leitura.txt" 2>&1
grep -q FIM-AUDITORIA "$OUT/00-auditoria-somente-leitura.txt" && ok "auditoria concluída ($(grep -c '✔' "$OUT/00-auditoria-somente-leitura.txt") ✔ · $(grep -c '✘' "$OUT/00-auditoria-somente-leitura.txt") ✘)" || ruim "auditoria incompleta"
grep -E '✘' "$OUT/00-auditoria-somente-leitura.txt" | head -5 | sed 's/^/    /'
[[ "$(vm impressao-digital | md5sum)" == "$fp0" && "$("${COMPOSE[@]}" ps -q | sort | xargs)" == "$ids0" ]] \
  && ok "banco e contêineres idênticos após a auditoria" || ruim "a auditoria alterou algo"

etapa "0c. Script ANTERIOR (4f9b1ae) no mesmo banco: reproduz 'restauração de teste NÃO idêntica'"
if git -C "$RAIZ" cat-file -e 4f9b1ae:infra/homolog/gcp/vm.sh 2>/dev/null; then
  mkdir -p "$W/antigo"; git -C "$RAIZ" archive 4f9b1ae infra/homolog scripts | tar -x -C "$W/antigo"
  vm manutencao > /dev/null 2>&1
  CENARIO_DIR="$W/antigo" CENARIO_STATE_DIR="$W/estado-antigo" bash "$W/antigo/infra/homolog/gcp/vm.sh" ponto-recuperacao > "$OUT/00c-ponto-script-antigo.log" 2>&1
  rc=$?
  [[ "$rc" != 0 ]] && grep -q 'NÃO idêntica' "$OUT/00c-ponto-script-antigo.log" \
    && ok "script antigo: 'restauração de teste NÃO idêntica' e ponto NÃO registrado (saída $rc) — a falha da homologação" \
    || ruim "script antigo não reproduziu (saída $rc)"
  sed -n '/^Diferenças/,/NÃO/p' "$OUT/00c-ponto-script-antigo.log" | sed 's/^/    /'
  "${COMPOSE[@]}" exec -T postgres psql -U cenario -d postgres -qc 'DROP DATABASE IF EXISTS cenario_restore_check WITH (FORCE)'
  CENARIO_TAG="$PUB" vm ativar "$PUB" > /dev/null 2>&1 && ok "versão publicada de volta (nada migrado)" || ruim "reativar $PUB"
else echo "  • commit 4f9b1ae ausente neste clone: etapa pulada"; fi

etapa "1. Recusas de segurança antes de começar"
CENARIO_TAG="$PUB" espera_codigo 2 vm atualizar "$CAND"
espera_codigo 1 vm migrar "$CAND"   # API em execução
mkdir -p "$W/sem-portao"; CENARIO_PORTAO="$W/sem-portao/x" espera_codigo 3 vm manutencao

etapa "2. preparar-versao $CAND (imagens, digests, regra de migração explícita; nada reiniciado)"
ids_antes="$("${COMPOSE[@]}" ps -q | sort | xargs)"
vm preparar-versao "$CAND" | tee "$OUT/02-preparar-versao.log" | sed 's/^/    /'
[[ "$("${COMPOSE[@]}" ps -q | sort | xargs)" == "$ids_antes" ]] && ok "nenhum contêiner recriado" || ruim "contêineres mudaram"
espera_codigo 1 vm preparar-versao "$PUB" # imagem antiga: migraria na partida → recusada

etapa "3. Manutenção: API e web paradas; proxy 503"
vm manutencao > "$OUT/03-manutencao.log" 2>&1 && ok "manutencao" || ruim "manutencao"
r="$(http -o "$W/m.json" -w '%{http_code}' "$BASE/api/v1/service-orders")"
[[ "$r" == 503 ]] && grep -q MANUTENCAO "$W/m.json" && ok "API pelo proxy: 503 JSON MANUTENCAO" || ruim "API pelo proxy: $r"
r="$(http -o "$W/m.html" -w '%{http_code}' "$BASE/painel")"
[[ "$r" == 503 ]] && grep -q 'em manutenção' "$W/m.html" && ok "painel pelo proxy: 503 'em manutenção'" || ruim "painel pelo proxy: $r"
espera_codigo 1 vm migrar "$CAND"   # sem ponto de recuperação

etapa "4. Falha INTERMEDIÁRIA de migration (objeto conflitante só na 4ª migration da Evolução)"
# Isca: cópia íntegra (SHA-256 válido) de um backup ANTIGO com nome que ordena por último. A regra
# antiga ("ls | tail -1") a escolheria no ponto de recuperação e acusaria divergência.
"${COMPOSE[@]}" exec -T backup sh -c 'cp -a "$(ls -1d /data/backups/cenario-* | tail -1)" /data/backups/cenario-staging-29991231T235959Z'
psqlh -c 'CREATE INDEX "logistics_costs_payee_user_id_due_at_idx" ON audit_logs (created_at)' > /dev/null
vm ponto-recuperacao > "$OUT/04-ponto-com-conflito.log" 2>&1 && ok "ponto de recuperação (inclui o objeto conflitante)" || ruim "ponto de recuperação"
espera_codigo 1 vm migrar "$CAND"
cp "$W/ultimo.log" "$OUT/04-migracao-falhou.log"
psqlh -F' ' -c "select migration_name, finished_at is not null, rolled_back_at is not null from _prisma_migrations where migration_name >= '20261018' order by 1" > "$OUT/04-estado-parcial.txt"
sed 's/^/    /' "$OUT/04-estado-parcial.txt"
parc="$(psqlh -c "select count(*) from information_schema.columns where table_name='logistics_costs' and column_name='status'")"
echo "    coluna logistics_costs.status criada pela migration que falhou: $parc (estado parcial)"
etapa "4b. Ativar com migration falha: a API RECUSA iniciar (nada sobe em estado parcial)"
CENARIO_TAG="$CAND" CENARIO_ESPERA=12 espera_codigo 1 vm ativar "$CAND"
"${COMPOSE[@]}" logs --tail 20 api 2>/dev/null | grep -m2 -E 'NÃO iniciada|migrations pendentes|P3009|failed' | sed 's/^/    /'
etapa "4c. Recuperação para o ponto (versão $PUB)"
CENARIO_TAG="$CAND" espera_codigo 1 vm recuperar --sim   # metadado ainda na versão nova: recusa
CENARIO_TAG="$PUB" vm recuperar --sim > "$OUT/04-recuperar.log" 2>&1 && ok "recuperar --sim" || ruim "recuperar --sim"
grep -E 'IDÊNTICO|difere' "$OUT/04-recuperar.log" | sed 's/^/    /'
[[ "$(psqlh -c 'select count(*) from _prisma_migrations')" == 12 ]] && ok "de volta a 12 migrations" || ruim "migrations após recuperar"
saude_ok
psqlh -c 'DROP INDEX "logistics_costs_payee_user_id_due_at_idx"' > /dev/null && ok "objeto conflitante removido (correção do operador)"

etapa "5. Caminho feliz: manutenção → ponto → migrar → ativar"
vm manutencao > /dev/null 2>&1
vm ponto-recuperacao > "$OUT/05-ponto-recuperacao.log" 2>&1 && ok "ponto de recuperação" || ruim "ponto de recuperação"
grep -E 'IDÊNTICA|PONTO|itens:|pasta deste backup|reescrito' "$OUT/05-ponto-recuperacao.log" | sed 's/^/    /'
grep -q 'pasta deste backup: cenario-staging-29991231T235959Z' "$OUT/05-ponto-recuperacao.log" && ruim "o ponto usou a isca" || ok "o ponto usou a pasta do próprio backup (não a isca)"
psqlh -c "insert into audit_logs (id, action, entity_type, summary) values (gen_random_uuid(), 'ensaio.escrita', 'system', 'Escrita depois do ponto')" > /dev/null
espera_codigo 1 vm migrar "$CAND"     # banco mudou depois do ponto: recusa
vm ponto-recuperacao > /dev/null 2>&1
t0="$(date +%s)"
vm migrar "$CAND" > "$OUT/05-migrar.log" 2>&1 && ok "migrar em $(( $(date +%s) - t0 )) s" || { ruim "migrar"; tail "$OUT/05-migrar.log"; }
grep -E 'Applying|aplicadas|pré-verificação' "$OUT/05-migrar.log" | sed 's/^/    /'
CENARIO_TAG="$PUB" espera_codigo 1 vm ativar "$CAND"   # metadado não atualizado: recusa
CENARIO_TAG="$CAND" vm ativar "$CAND" > "$OUT/05-ativar.log" 2>&1 && ok "ativar $CAND + saúde" || { ruim "ativar"; tail -20 "$OUT/05-ativar.log"; }
[[ "$(psqlh -c 'select count(*) from _prisma_migrations')" == 17 ]] && ok "17 migrations" || ruim "migrations após ativar"
vm impressao-digital > "$OUT/05-impressao-candidata.txt"

etapa "6. Testes após a publicação (HTTP real pelo proxy, dados sintéticos)"
[[ "$(login)" == 200 ]] && ok "login do gestor" || ruim "login"
semana="$(date -d "$(date +%F) -$(( ($(date +%u) + 6) % 7 )) days" +%F)"
for p in /api/v1/service-orders /api/v1/production-plans "/api/v1/finance/weekly-closings/$semana" \
  /api/v1/finance/labor /api/v1/finance/logistics-costs /api/v1/finance/dashboard /api/v1/quality/inspections; do
  r="$(api_get "$p")"; [[ "$r" == 200 ]] && ok "GET $p: 200" || ruim "GET $p: $r"
done
r="$(http -o /dev/null -w '%{http_code}' "$BASE/painel/financeiro")"; [[ "$r" =~ ^(200|307)$ ]] && ok "web /painel/financeiro: $r" || ruim "web: $r"
echo "    memória dos contêineres:"; docker stats --no-stream --format '      {{.Name}} {{.MemUsage}}' | grep cenario-homolog | tee "$OUT/06-memoria.txt"

etapa "7. Reaplicação e guarda contra migrar de novo"
"${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api -c 'pnpm db:migrate' > "$OUT/07-reaplicar.log" 2>&1
grep -q 'No pending migrations' "$OUT/07-reaplicar.log" && ok "migrate deploy repetido: nenhuma pendente (idempotente)" || ruim "reaplicação"
vm manutencao > /dev/null 2>&1
espera_codigo 1 vm migrar "$CAND"     # banco mudou desde o ponto (17 migrations) → recusa

etapa "8. Falha de INICIALIZAÇÃO (configuração errada) e correção sem tocar no banco"
cp "$W/env" "$W/env.bom"
sed -i "s/^TOKEN_HASH_SECRET=.*/TOKEN_HASH_SECRET='curto'/" "$W/env"
CENARIO_TAG="$CAND" CENARIO_ESPERA=8 espera_codigo 1 vm ativar "$CAND"
cp "$W/env.bom" "$W/env"
CENARIO_TAG="$CAND" vm ativar "$CAND" > /dev/null 2>&1 && ok "configuração corrigida: ativar OK (banco intocado)" || ruim "ativar após correção"

etapa "9. Recuperação DEPOIS do uso: registro novo é perdido (risco documentado)"
login > /dev/null
http -b "$W/jar" -o /dev/null -w '' -H 'content-type: application/json' -H "origin: $BASE" -H "idempotency-key: $(openssl rand -hex 16)" \
  -d '{"kind":"PF","name":"Cliente Criado Depois Do Ponto","phone":null,"allowSimilar":true,"addresses":[]}' "$BASE/api/v1/customers"
antes="$(psqlh -c "select count(*) from customers where name = 'Cliente Criado Depois Do Ponto'")"
CENARIO_TAG="$PUB" vm recuperar --sim > "$OUT/09-recuperar-depois-do-uso.log" 2>&1 && ok "recuperar --sim" || ruim "recuperar"
depois="$(psqlh -c "select count(*) from customers where name = 'Cliente Criado Depois Do Ponto'")"
[[ "$antes" == 1 && "$depois" == 0 ]] && ok "cliente criado após o ponto: existia ($antes) e foi PERDIDO na recuperação ($depois)" || ruim "antes=$antes depois=$depois"
[[ "$(psqlh -c 'select count(*) from _prisma_migrations')" == 12 ]] && ok "versão $PUB com 12 migrations" || ruim "migrations"
saude_ok

etapa "Resultado"
echo "Evidências em $OUT"
(( FALHAS == 0 )) && echo "ENSAIO: OK" || { echo "ENSAIO: $FALHAS falha(s)"; exit 1; }
