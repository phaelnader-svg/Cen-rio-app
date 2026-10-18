#!/usr/bin/env bash
# ENSAIO LOCAL do PRIMEIRO DEPLOY da produção num banco NOVO, com a pilha REAL de produção
# (docker-compose.prod.yml, Caddyfile.prod, PostgreSQL 16, contêiner de backup) e o vm.sh de produção
# deste commit. Domínio de teste (.localhost, certificado interno do Caddy), segredos aleatórios locais.
# Nada sai da máquina: sem Google Cloud, sem bucket, sem Secret Manager. Recusa rodar numa VM do Google.
#
# Sequência (a mesma do runner): iniciar-banco → preparar-versao → ponto-recuperacao (banco vazio) →
# preflight → migrar → ativar → semear (bootstrap mínimo) → saude/acesso → impressão digital →
# restauração de teste → recuperação ao ponto (rollback) → reativar.
#
# Requisitos: Docker; portas 80/443 livres; imagens locais local/cenario/{api,web}:$TAG.
# Uso: TAG=<sha> OUT=/dir/evidencias bash infra/prod/gcp/testes/ensaio-primeiro-deploy.sh
# ATENÇÃO: apaga e recria os volumes LOCAIS do projeto Compose "cenario-prod" desta máquina.
set -uo pipefail
: "${TAG:?TAG}" "${OUT:?OUT}"
if curl -fsS -m 2 -H 'Metadata-Flavor: Google' http://metadata.google.internal/ >/dev/null 2>&1; then
  echo "Recusado: isto parece uma VM do Google Cloud. O ensaio é só local." >&2; exit 2
fi
RAIZ="$(cd "$(dirname "$0")/../../../.." && pwd)"
VMSH="$RAIZ/infra/prod/gcp/vm.sh"
W="$(mktemp -d)"; mkdir -p "$OUT"
FALHAS=0
ok() { echo "  ✔ $*"; }
ruim() { echo "  ✘ $*"; FALHAS=$((FALHAS + 1)); }
etapa() { echo; echo "■ $*"; }
espera_codigo() { # espera_codigo <esperado> <comando…>
  local esp="$1"; shift; local rc=0; "$@" > "$W/ultimo.log" 2>&1 || rc=$?
  if [[ "$rc" == "$esp" ]]; then ok "saída $rc: $(grep -m1 -E '✘|✔|recusad|Uso' "$W/ultimo.log" | cut -c1-140)"
  else ruim "saída $rc (esperado $esp)"; tail -15 "$W/ultimo.log"; fi
}

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
CENARIO_API_IMAGE='local/cenario/api:$TAG'
CENARIO_WEB_IMAGE='local/cenario/web:$TAG'
EOF
chmod 600 "$W/env"; touch "$W/portao"
export CENARIO_DIR="$RAIZ" CENARIO_ENV_FILE="$W/env" CENARIO_PORTAO="$W/portao" CENARIO_STATE_DIR="$W/estado"
export CENARIO_META_URL="http://127.0.0.1:9" CENARIO_PROJECT="" CENARIO_BUCKET="" CENARIO_REGISTRY="local/cenario"
export CENARIO_DOMAIN="$DOM" CENARIO_DOMAIN_WWW="$WWW" CENARIO_CERT_MIN_DIAS=0 CENARIO_ESPERA=40 CENARIO_TAG="$TAG"
export CENARIO_DISCO_LIVRE_MIN_GB="${CENARIO_DISCO_LIVRE_MIN_GB:-3}" CENARIO_DISCO_MAX="${CENARIO_DISCO_MAX:-95}"
COMPOSE=(docker compose -f "$RAIZ/infra/prod/docker-compose.prod.yml" --env-file "$W/env")
vm() { bash "$VMSH" "$@"; }
psqlp() { "${COMPOSE[@]}" exec -T postgres psql -U cenario -d cenario_prod -At "$@"; }
BASE="https://$DOM"; RES=(--resolve "$DOM:443:127.0.0.1" --resolve "$WWW:443:127.0.0.1")
http() { curl -s --cacert "$W/ca.crt" "${RES[@]}" "$@"; }
fim() { "${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true; rm -rf "$W"; }
trap fim EXIT
saude_ok() { if vm saude > "$W/saude.log" 2>&1; then ok "vm.sh saude: OK ($(grep -c '^✔' "$W/saude.log") verificações)"; cp "$W/saude.log" "$OUT/$1"; else ruim "vm.sh saude falhou"; grep '^✘' "$W/saude.log"; fi; }

etapa "0. Pilha de produção limpa (volumes locais do projeto cenario-prod recriados)"
"${COMPOSE[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
pub="$(docker compose -f "$RAIZ/infra/prod/docker-compose.prod.yml" --env-file "$W/env" config --format json | grep -o '"published": *"*[0-9]*' | tr -dc '0-9\n' | sort -n | xargs)"
[[ "$pub" == "80 443" ]] && ok "portas publicadas: só 80 e 443 (Caddy); PostgreSQL, API e web sem porta" || ruim "portas publicadas: $pub"

etapa "1. Recusas antes de começar"
mkdir -p "$W/sem-portao"; CENARIO_PORTAO="$W/sem-portao/x" espera_codigo 3 vm iniciar-banco
espera_codigo 1 vm migrar "$TAG"   # sem ponto de recuperação (e sem banco)

etapa "2. iniciar-banco: SÓ PostgreSQL e backup (banco NOVO)"
vm iniciar-banco > "$OUT/02-iniciar-banco.log" 2>&1 && ok "iniciar-banco" || { ruim "iniciar-banco"; cat "$OUT/02-iniciar-banco.log"; }
grep -q 'banco NOVO (nenhuma tabela)' "$OUT/02-iniciar-banco.log" && ok "banco novo: nenhuma tabela (nada copiado da homologação)" || ruim "o banco não estava vazio"
[[ -z "$("${COMPOSE[@]}" ps -q api)$("${COMPOSE[@]}" ps -q web)" ]] && ok "API e web não iniciadas" || ruim "API/web em execução"
sleep 5

etapa "3. preparar-versao $TAG"
vm preparar-versao "$TAG" > "$OUT/03-preparar-versao.log" 2>&1 && ok "preparar-versao" || { ruim "preparar-versao"; cat "$OUT/03-preparar-versao.log"; }
grep -E '✔|•' "$OUT/03-preparar-versao.log" | sed 's/^/    /'

etapa "4. Ponto de recuperação no banco VAZIO (o mecanismo é validado já no primeiro deploy)"
for _ in $(seq 1 20); do "${COMPOSE[@]}" exec -T backup sh -c 'ls -d /data/backups/cenario-*' >/dev/null 2>&1 && break; sleep 2; done
vm ponto-recuperacao > "$OUT/04-ponto-recuperacao.log" 2>&1 && ok "ponto de recuperação" || { ruim "ponto de recuperação"; tail -20 "$OUT/04-ponto-recuperacao.log"; }
grep -E 'IDÊNTICA|PONTO|pasta deste backup' "$OUT/04-ponto-recuperacao.log" | sed 's/^/    /'
PASTA="$(sed -n 's/.*PONTO DE RECUPERAÇÃO: \(cenario-[^ ]*\).*/\1/p' "$OUT/04-ponto-recuperacao.log")"
"${COMPOSE[@]}" exec -T backup sh -c "cd /data/backups/$PASTA && sha256sum --check --quiet SHA256SUMS" && ok "backup $PASTA: SHA256SUMS conferido" || ruim "SHA256SUMS"

etapa "5. Pré-verificação e migrations"
vm preflight "$TAG" > "$OUT/05-preflight.log" 2>&1 && ok "preflight: OK" || { ruim "preflight"; tail "$OUT/05-preflight.log"; }
grep -E 'pendentes|PREFLIGHT' "$OUT/05-preflight.log" | sed 's/^/    /'
vm migrar "$TAG" > "$OUT/05-migrar.log" 2>&1 && ok "migrar" || { ruim "migrar"; tail -20 "$OUT/05-migrar.log"; }
n="$(psqlp -c 'select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null')"
[[ "$n" == 31 ]] && ok "31/31 migrations aplicadas" || ruim "migrations aplicadas: $n"

etapa "6. ativar $TAG (+ saúde completa)"
# Só no ensaio: o certificado é o da CA interna do Caddy (.localhost), criada na 1ª partida do proxy;
# o proxy sobe antes para extrair a raiz. Na VM, o certificado é público (Let's Encrypt).
"${COMPOSE[@]}" up -d --no-build --no-deps caddy > /dev/null 2>&1
for _ in $(seq 1 30); do "${COMPOSE[@]}" cp caddy:/data/caddy/pki/authorities/local/root.crt "$W/ca.crt" > /dev/null 2>&1 && break; sleep 1; done
export CENARIO_CACERT="$W/ca.crt"
espera_codigo 1 env CENARIO_TAG=0000000 bash "$VMSH" ativar "$TAG"   # etiqueta local diferente: recusa
vm ativar "$TAG" > "$OUT/06-ativar.log" 2>&1 && ok "ativar $TAG + saúde (dentro do ativar)" || { ruim "ativar"; grep '✘' "$OUT/06-ativar.log"; }
saude_ok 06-saude.log

etapa "7. Bootstrap mínimo (semear): só o gestor e a configuração estrutural"
vm semear > "$OUT/07-semear.log" 2>&1 && ok "semear" || { ruim "semear"; tail -20 "$OUT/07-semear.log"; }
grep -E '✔|•|✘' "$OUT/07-semear.log" | tail -4 | sed 's/^/    /'
[[ "$(psqlp -c "select count(*) from employees where display_name in ('Ricardo','Márcio','Thiago','João','André','Izaías')")" == 0 ]] \
  && ok "nenhum funcionário de exemplo (Ricardo, Márcio, Thiago, João, André, Izaías)" || ruim "funcionário de exemplo criado"
espera_codigo 0 vm semear   # idempotente: com só o gestor, roda de novo sem criar nada
[[ "$(psqlp -c 'select count(*) from users')" == 1 ]] && ok "continua um único usuário" || ruim "usuários duplicados"
psqlp -v ON_ERROR_STOP=1 -c "insert into users (id, display_name, updated_at) values (gen_random_uuid(), 'Pessoa real 1', now()), (gen_random_uuid(), 'Pessoa real 2', now())" > /dev/null \
  && psqlp -v ON_ERROR_STOP=1 -c "insert into employees (id, user_id, full_name, display_name, job_title, color, updated_at) select gen_random_uuid(), id, display_name, display_name, 'x', '#000000', now() from users where display_name like 'Pessoa real%'" > /dev/null \
  && ok "2 funcionários inseridos (simulando um banco em uso)" || ruim "inserção de teste falhou"
espera_codigo 1 vm semear   # banco com funcionários: recusa (nunca roda sobre dados reais)
psqlp -c "delete from employees where display_name like 'Pessoa real%'; delete from users where display_name like 'Pessoa real%'" > /dev/null

etapa "8. Acesso e segurança (SÓ LEITURA, sem sessão)"
vm acesso > "$OUT/08-acesso.log" 2>&1 && ok "vm.sh acesso: OK" || ruim "vm.sh acesso"
sed 's/^/    /' "$OUT/08-acesso.log"
r="$(http -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"gestor@ensaio.local\",\"password\":\"$SENHA_GESTOR\"}" "$BASE/api/auth/login")"
[[ "$r" == 200 ]] && ok "login do primeiro gestor (credencial do bootstrap)" || ruim "login do gestor: $r"
r="$(http -o "$W/h.json" -w '%{http_code}' "$BASE/api/health")"
grep -q '"environment":"production"' "$W/h.json" && ok "/api/health: APP_ENV=production" || ruim "/api/health: $(cat "$W/h.json")"

etapa "9. Impressão digital e restauração de teste em banco SEPARADO"
vm impressao-digital > "$OUT/09-impressao.txt" && ok "impressão digital ($(wc -l < "$OUT/09-impressao.txt") itens)" || ruim "impressão digital"
"${COMPOSE[@]}" exec -T backup bash /scripts/backup.sh /data/backups > /dev/null 2>&1
vm restaurar-teste > "$OUT/09-restaurar-teste.log" 2>&1 && ok "restauração de teste IDÊNTICA" || { ruim "restauração de teste"; tail "$OUT/09-restaurar-teste.log"; }
[[ "$(psqlp -c "select count(*) from pg_database where datname like 'cenario_restore%'")" == 0 ]] && ok "bancos de teste removidos; produção só lida" || ruim "bancos de teste ficaram"

etapa "10. Rollback: manutenção → novo ponto → escrita → recuperar ao ponto"
vm manutencao > /dev/null 2>&1 && ok "manutenção (API e web paradas)" || ruim "manutenção"
r="$(http -o "$W/m.json" -w '%{http_code}' "$BASE/api/v1/attention")"
[[ "$r" == 503 ]] && grep -q MANUTENCAO "$W/m.json" && ok "API pelo proxy: 503 MANUTENCAO" || ruim "API em manutenção respondeu $r"
vm ponto-recuperacao > "$OUT/10-ponto.log" 2>&1 && ok "ponto de recuperação (com o gestor)" || ruim "ponto de recuperação"
psqlp -c "insert into audit_logs (id, action, entity_type, summary) values (gen_random_uuid(), 'ensaio.escrita', 'system', 'Escrita depois do ponto')" > /dev/null
espera_codigo 1 vm migrar "$TAG"   # o banco mudou depois do ponto: recusa
vm recuperar --sim > "$OUT/10-recuperar.log" 2>&1 && ok "recuperar --sim" || { ruim "recuperar --sim"; tail -20 "$OUT/10-recuperar.log"; }
grep -E 'IDÊNTICO|difere' "$OUT/10-recuperar.log" | sed 's/^/    /'
[[ "$(psqlp -c "select count(*) from audit_logs where action = 'ensaio.escrita'")" == 0 ]] && ok "escrita posterior ao ponto desfeita" || ruim "escrita posterior permaneceu"
saude_ok 10-saude-apos-recuperar.log

etapa "11. Isolamento local: só o projeto cenario-prod, nenhum recurso de homologação"
docker ps --format '{{.Names}}' | grep -q homolog && ruim "contêiner de homologação em execução" || ok "nenhum contêiner de homologação"
docker volume ls --format '{{.Name}}' | grep '^cenario-prod_' | sed 's/^/    /'
echo "    memória dos contêineres:"; docker stats --no-stream --format '      {{.Name}} {{.MemUsage}}' | grep cenario-prod | tee "$OUT/11-memoria.txt"

etapa "Resultado"
echo "Evidências em $OUT"
(( FALHAS == 0 )) && echo "ENSAIO DO PRIMEIRO DEPLOY: OK" || { echo "ENSAIO DO PRIMEIRO DEPLOY: $FALHAS falha(s)"; exit 1; }
