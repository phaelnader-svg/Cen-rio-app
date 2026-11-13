#!/usr/bin/env bash
# ENSAIO LOCAL do deploy de produção COM BANCO LIMPO (volume novo pgdata_2026_11), com a pilha REAL de
# produção (Compose, Caddyfile, PostgreSQL 16, backup) e os vm.sh reais ANTES (scripts atuais da VM) e
# DEPOIS (pacote do deploy). A troca de CENARIO_DIR entre os dois simula vm_scripts_update/restore.
# Nada sai da máquina; recusa rodar numa VM do Google. Apaga e recria os volumes LOCAIS do projeto
# Compose "cenario-prod" desta máquina (só no início e no fim).
#
#   E1. "Produção atual": versão ANTIGA no volume pgdata, com dados (gestor + registros marcadores).
#   E2. Deploy: manutenção → scripts novos → banco NOVO no volume novo → ponto → preflight (37) →
#       migrar → ativar → semear (só o gestor) → login → saúde/acesso.  [cronometrado]
#   E3. Falha simulada depois da ativação (API derrubada) → saúde reprova.
#   E4. Retorno: manutenção → scripts antigos → PostgreSQL no volume ANTIGO → versão antiga →
#       dados antigos IDÊNTICOS; volume antigo intocado durante o deploy; volume novo preservado.
#   E5. Novo deploy (depois de "corrigir"): volta ao volume novo, banco novo intacto, gestor presente.
#
# Uso: TAG_ANTIGA=<sha> TAG_NOVA=<sha> ANTES=<checkout dos scripts atuais> OUT=<dir> \
#      bash infra/prod/gcp/testes/ensaio-deploy-banco-limpo.sh
set -uo pipefail
: "${TAG_ANTIGA:?}" "${TAG_NOVA:?}" "${ANTES:?}" "${OUT:?}"
if curl -fsS -m 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/ >/dev/null 2>&1; then
  echo "Recusado: isto parece uma VM do Google Cloud. O ensaio é só local." >&2; exit 2
fi
DEPOIS="$(cd "$(dirname "$0")/../../../.." && pwd)"
W="$(mktemp -d)"; mkdir -p "$OUT"
FALHAS=0
ok() { echo "  ✔ $*"; }
ruim() { echo "  ✘ $*"; FALHAS=$((FALHAS + 1)); }
etapa() { echo; echo "■ $*"; }
DOM=cenario-prod.localhost; WWW=www.cenario-prod.localhost
SENHA_GESTOR="Ensaio$(openssl rand -hex 8)9"
cat > "$W/env" <<EOF
PROD_DOMAIN='$DOM'
PROD_DOMAIN_WWW='$WWW'
POSTGRES_PASSWORD='$(openssl rand -hex 32)'
TOKEN_HASH_SECRET='$(openssl rand -hex 48)'
SEED_ADMIN_EMAIL='gestor@ensaio.local'
SEED_ADMIN_PASSWORD='$SENHA_GESTOR'
SEED_ADMIN_NAME='Gestor Ensaio'
CENARIO_API_IMAGE='local/cenario/api:$TAG_ANTIGA'
CENARIO_WEB_IMAGE='local/cenario/web:$TAG_ANTIGA'
EOF
chmod 600 "$W/env"; touch "$W/portao"
export CENARIO_ENV_FILE="$W/env" CENARIO_PORTAO="$W/portao" CENARIO_STATE_DIR="$W/estado"
export CENARIO_META_URL="http://127.0.0.1:9" CENARIO_PROJECT="" CENARIO_BUCKET="" CENARIO_REGISTRY="local/cenario"
export CENARIO_DOMAIN="$DOM" CENARIO_DOMAIN_WWW="$WWW" CENARIO_CERT_MIN_DIAS=0 CENARIO_ESPERA=40
export CENARIO_DISCO_LIVRE_MIN_GB="${CENARIO_DISCO_LIVRE_MIN_GB:-3}" CENARIO_DISCO_MAX="${CENARIO_DISCO_MAX:-95}"
SCRIPTS="$ANTES"   # diretório de scripts "instalado" (troca = vm_scripts_update / vm_scripts_restore)
vm() { local tag="$1"; shift; CENARIO_DIR="$SCRIPTS" CENARIO_TAG="$tag" bash "$SCRIPTS/infra/prod/gcp/vm.sh" "$@"; }
dc() { docker compose -f "$SCRIPTS/infra/prod/docker-compose.prod.yml" --env-file "$W/env" "$@"; }
psqlp() { dc exec -T postgres psql -U cenario -d cenario_prod -At "$@"; }
BASE="https://$DOM"; RES=(--resolve "$DOM:443:127.0.0.1" --resolve "$WWW:443:127.0.0.1")
http() { curl -s --cacert "$W/ca.crt" "${RES[@]}" "$@"; }
login() { http -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"gestor@ensaio.local\",\"password\":\"$SENHA_GESTOR\"}" "$BASE/api/auth/login"; }
hash_volume() { docker run --rm -v "$1":/v:ro postgres:16-alpine sh -c 'cd /v && find . -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16'; }
negocio() { grep -E '^tabela\|' "$1" | grep -vE '\|(notifications|domain_events|sessions|audit_logs|idempotency_keys|auth_throttles?|_prisma_migrations)\|'; }
passo() { local nome="$1"; shift; if "$@" > "$OUT/$nome.log" 2>&1; then ok "$nome"; else ruim "$nome"; grep -E '✘' "$OUT/$nome.log" | head -5; tail -5 "$OUT/$nome.log"; fi; }
fim() { dc down -v --remove-orphans > /dev/null 2>&1 || true; rm -rf "$W"; }
trap fim EXIT

etapa "0. Pilha local limpa (projeto cenario-prod)"
dc down -v --remove-orphans > /dev/null 2>&1 || true
for v in pgdata pgdata_2026_11; do docker volume rm "cenario-prod_$v" > /dev/null 2>&1 || true; done

etapa "E1. Produção atual simulada: $TAG_ANTIGA no volume pgdata, com dados"
passo e1-iniciar-banco vm "$TAG_ANTIGA" iniciar-banco
sleep 5
passo e1-preparar-antiga vm "$TAG_ANTIGA" preparar-versao "$TAG_ANTIGA"
for _ in $(seq 1 20); do dc exec -T backup sh -c 'ls -d /data/backups/cenario-*' >/dev/null 2>&1 && break; sleep 2; done
passo e1-ponto vm "$TAG_ANTIGA" ponto-recuperacao
passo e1-migrar vm "$TAG_ANTIGA" migrar "$TAG_ANTIGA"
N_ANTIGA="$(psqlp -c 'select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null')"
echo "    migrations da versão antiga: $N_ANTIGA"
dc up -d --no-build --no-deps caddy > /dev/null 2>&1
for _ in $(seq 1 30); do dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$W/ca.crt" > /dev/null 2>&1 && break; sleep 1; done
export CENARIO_CACERT="$W/ca.crt"
passo e1-ativar-antiga vm "$TAG_ANTIGA" ativar "$TAG_ANTIGA"
passo e1-semear vm "$TAG_ANTIGA" semear
psqlp -v ON_ERROR_STOP=1 -c "insert into customers (id, kind, name, search_text, updated_at) select gen_random_uuid(), 'PF', 'HML-Cliente marcador ' || g, 'hml-cliente marcador ' || g, now() from generate_series(1,3) g" > /dev/null \
  && ok "3 clientes marcadores no banco antigo" || ruim "marcadores"
[[ "$(login)" == 200 ]] && ok "login do gestor na versão antiga" || ruim "login na versão antiga"
vm "$TAG_ANTIGA" impressao-digital > "$OUT/e1-impressao.txt"
ok "impressão digital do banco antigo: $(wc -l < "$OUT/e1-impressao.txt") itens"

etapa "E2. Deploy com banco limpo ($TAG_NOVA)"
passo e2-preparar-nova vm "$TAG_ANTIGA" preparar-versao "$TAG_NOVA"   # antes da janela (sem indisponibilidade)
T0=$(date +%s)
passo e2-manutencao vm "$TAG_ANTIGA" manutencao
SCRIPTS="$DEPOIS"; ok "scripts do deploy instalados (CENARIO_DIR → pacote novo)"
passo e2-iniciar-banco vm "$TAG_NOVA" iniciar-banco
grep -q 'banco NOVO (nenhuma tabela)' "$OUT/e2-iniciar-banco.log" && ok "PostgreSQL no volume NOVO: nenhuma tabela" || ruim "o banco não estava vazio"
H1="$(hash_volume cenario-prod_pgdata)"; ok "volume antigo fora de uso; hash do conteúdo: $H1"
for _ in $(seq 1 20); do dc exec -T backup sh -c 'pg_isready -h postgres -U cenario' >/dev/null 2>&1 && break; sleep 2; done
passo e2-ponto vm "$TAG_NOVA" ponto-recuperacao
passo e2-preflight vm "$TAG_NOVA" preflight "$TAG_NOVA"
grep -E 'pendentes|PREFLIGHT' "$OUT/e2-preflight.log" | sed 's/^/    /'
passo e2-migrar vm "$TAG_NOVA" migrar "$TAG_NOVA"
N_NOVA="$(psqlp -c 'select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null')"
[[ "$N_NOVA" == 37 ]] && ok "37/37 migrations no banco novo" || ruim "migrations no banco novo: $N_NOVA"
passo e2-ativar vm "$TAG_NOVA" ativar "$TAG_NOVA"
T1=$(date +%s)
passo e2-semear vm "$TAG_NOVA" semear
T2=$(date +%s)
q="$(psqlp -F'|' -c 'select (select count(*) from users), (select count(*) from customers), (select count(*) from service_orders)')"
[[ "$q" == "1|0|0" ]] && ok "banco novo: 1 usuário (gestor), 0 clientes, 0 OS" || ruim "contagens do banco novo: $q"
[[ "$(login)" == 200 ]] && ok "login do gestor na versão nova (senha do bootstrap)" || ruim "login na versão nova"
passo e2-saude vm "$TAG_NOVA" saude
passo e2-acesso vm "$TAG_NOVA" acesso
echo "    indisponibilidade: manutenção → ativar = $((T1 - T0)) s; com o semear = $((T2 - T0)) s" | tee "$OUT/e2-tempo.txt"
vm "$TAG_NOVA" impressao-digital > "$OUT/e2-impressao.txt"

etapa "E3. Falha simulada depois da ativação"
dc kill api > /dev/null 2>&1
if vm "$TAG_NOVA" saude > "$OUT/e3-saude.log" 2>&1; then ruim "saúde não detectou a falha"; else ok "saúde reprova: $(grep -m1 '✘' "$OUT/e3-saude.log")"; fi

etapa "E4. Retorno ao banco antigo e à versão antiga"
T3=$(date +%s)
passo e4-manutencao vm "$TAG_NOVA" manutencao
SCRIPTS="$ANTES"; ok "scripts anteriores restaurados (vm_scripts_restore)"
H2="$(hash_volume cenario-prod_pgdata)"
[[ "$H2" == "$H1" ]] && ok "volume antigo intocado durante o deploy (hash $H2)" || ruim "volume antigo mudou: $H1 → $H2"
passo e4-iniciar-banco vm "$TAG_ANTIGA" iniciar-banco
grep -q 'já tem' "$OUT/e4-iniciar-banco.log" && ok "PostgreSQL de volta ao volume antigo ($(grep -o 'já tem [0-9]* tabela' "$OUT/e4-iniciar-banco.log"))" || ruim "PostgreSQL não voltou ao volume antigo"
passo e4-preflight-antiga vm "$TAG_ANTIGA" preflight "$TAG_ANTIGA"
passo e4-ativar-antiga vm "$TAG_ANTIGA" ativar "$TAG_ANTIGA"
T4=$(date +%s)
vm "$TAG_ANTIGA" impressao-digital > "$OUT/e4-impressao.txt"
if diff <(negocio "$OUT/e1-impressao.txt") <(negocio "$OUT/e4-impressao.txt") > "$OUT/e4-diff.txt"; then
  ok "dados antigos IDÊNTICOS aos de antes do deploy ($(negocio "$OUT/e4-impressao.txt" | wc -l) tabelas de negócio)"
else ruim "dados antigos diferentes"; head "$OUT/e4-diff.txt"; fi
[[ "$(psqlp -c "select count(*) from customers where name like 'HML-Cliente marcador%'")" == 3 ]] && ok "os 3 marcadores estão no banco antigo" || ruim "marcadores ausentes"
[[ "$(login)" == 200 ]] && ok "login do gestor na versão antiga (retorno)" || ruim "login após o retorno"
docker volume inspect cenario-prod_pgdata_2026_11 > /dev/null 2>&1 && ok "volume novo preservado (nada apagado no retorno)" || ruim "volume novo sumiu"
echo "    retorno: manutenção → versão antiga ativa = $((T4 - T3)) s" | tee "$OUT/e4-tempo.txt"

etapa "E5. Novo deploy depois da correção: banco novo intacto"
passo e5-manutencao vm "$TAG_ANTIGA" manutencao
SCRIPTS="$DEPOIS"
passo e5-iniciar-banco vm "$TAG_NOVA" iniciar-banco
passo e5-ativar vm "$TAG_NOVA" ativar "$TAG_NOVA"
vm "$TAG_NOVA" impressao-digital > "$OUT/e5-impressao.txt"
diff <(negocio "$OUT/e2-impressao.txt") <(negocio "$OUT/e5-impressao.txt") > /dev/null \
  && ok "banco novo idêntico ao de antes do retorno" || ruim "banco novo mudou"
[[ "$(login)" == 200 ]] && ok "login do gestor (banco novo)" || ruim "login no banco novo"
docker volume ls --format '{{.Name}}' | grep '^cenario-prod_' | sed 's/^/    volume: /'

etapa "Resultado"
echo "Evidências em $OUT"
(( FALHAS == 0 )) && echo "ENSAIO DO DEPLOY COM BANCO LIMPO: OK" || { echo "ENSAIO DO DEPLOY COM BANCO LIMPO: $FALHAS falha(s)"; exit 1; }
