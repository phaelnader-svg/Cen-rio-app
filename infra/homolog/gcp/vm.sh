#!/usr/bin/env bash
# Operação da homologação DENTRO da VM (Google Cloud) — também testável localmente.
#
#   vm.sh gerar-env            # lê os segredos (Secret Manager) e grava /run/cenario/env (memória, 600)
#   vm.sh iniciar              # sobe a pilha (baixa as imagens da etiqueta configurada)
#   vm.sh status               # contêineres, memória e disco
#   vm.sh saude                # verificação completa (HTTPS, proxy, API, banco, backup, disco, certificado)
#   vm.sh semear               # seed inicial (gestor de teste, equipe fictícia, checklists) — uma vez
#   vm.sh backup               # backup imediato + envio ao bucket
#   vm.sh enviar-backups       # envia ao bucket os backups ainda não enviados (usado pelo timer diário)
#   vm.sh restaurar-teste [pasta]   # restaura num banco SEPARADO e compara (não toca na homologação)
#   vm.sh restaurar <pasta> --sim   # restaura SOBRE a homologação (faz backup de segurança antes)
#   vm.sh atualizar <etiqueta>      # backup + troca de versão das imagens (reversão: etiqueta anterior)
#   vm.sh parar                # encerra os contêineres (dados preservados)
#
# Configuração não secreta: atributos da VM (metadata) "cenario-*" ou, fora do Google Cloud,
# variáveis de ambiente com o mesmo nome em maiúsculas (ex.: CENARIO_TAG). Segredos: só no
# Secret Manager (ou, em teste local, num arquivo indicado em CENARIO_ENV_FILE).
set -euo pipefail

DIR="${CENARIO_DIR:-/opt/cenario}"
COMPOSE_FILE="$DIR/infra/homolog/docker-compose.homolog.yml"
ENV_FILE="${CENARIO_ENV_FILE:-/run/cenario/env}"
STATE_DIR="${CENARIO_STATE_DIR:-/var/lib/cenario}"

meta() { # atributo da VM; vazio fora do Google Cloud
  curl -fsS -m 2 -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}
conf() { # conf <variável> <atributo> [padrão]
  local v="${!1:-}"
  [[ -n "$v" ]] || v="$(meta "$2")"
  echo "${v:-${3:-}}"
}
PROJECT="$(conf CENARIO_PROJECT cenario-project)"
REGION="$(conf CENARIO_REGION cenario-region us-east1)"
REPO="$(conf CENARIO_REPO cenario-repo cenario-homolog)"
TAG="$(conf CENARIO_TAG cenario-tag)"
DOMAIN="$(conf CENARIO_DOMAIN cenario-domain)"
BUCKET="$(conf CENARIO_BUCKET cenario-bucket)"
BASIC_USER="$(conf CENARIO_BASIC_USER cenario-basic-user homologacao)"
ADMIN_EMAIL="$(conf CENARIO_ADMIN_EMAIL cenario-admin-email)"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
log() { echo "[$(date -u +%FT%TZ)] $*"; }
need_env() { [[ -f "$ENV_FILE" ]] || { echo "Variáveis ausentes: rode 'vm.sh gerar-env'." >&2; exit 2; }; }

gerar_env() {
  [[ -n "$PROJECT" && -n "$DOMAIN" ]] || { echo "Defina cenario-project e cenario-domain." >&2; exit 2; }
  local s; s() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }
  local pw tk adm proxy gate hash
  pw="$(s homolog-postgres-password)"; tk="$(s homolog-token-hash-secret)"
  adm="$(s homolog-admin-password)"; proxy="$(s homolog-proxy-password)"; gate="$(s homolog-gate-token)"
  # Hash bcrypt da senha do proxy calculado na própria VM (a senha em texto fica só no Secret Manager).
  hash="$(docker run --rm caddy:2.10-alpine caddy hash-password --plaintext "$proxy")"
  install -d -m 700 "$(dirname "$ENV_FILE")"
  umask 077
  # Aspas simples: o Docker Compose não interpreta "$" dentro delas (o hash bcrypt contém "$").
  cat > "$ENV_FILE" <<EOF
HOMOLOG_DOMAIN='$DOMAIN'
POSTGRES_PASSWORD='$pw'
TOKEN_HASH_SECRET='$tk'
SEED_ADMIN_EMAIL='$ADMIN_EMAIL'
SEED_ADMIN_PASSWORD='$adm'
SEED_ADMIN_NAME='Gestor Homologação'
HOMOLOG_BASIC_USER='$BASIC_USER'
HOMOLOG_BASIC_HASH='$hash'
HOMOLOG_GATE_TOKEN='$gate'
CENARIO_API_IMAGE='$REGION-docker.pkg.dev/$PROJECT/$REPO/api:$TAG'
CENARIO_WEB_IMAGE='$REGION-docker.pkg.dev/$PROJECT/$REPO/web:$TAG'
EOF
  log "Variáveis geradas em $ENV_FILE (memória, permissão 600)."
}

iniciar() {
  need_env
  if [[ -n "$PROJECT" ]]; then
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
    compose pull --quiet api web
  fi
  compose up -d --no-build --remove-orphans
  for _ in $(seq 1 60); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null)" == healthy ]] && break
    sleep 5
  done
  status
}

status() {
  need_env
  compose ps --format 'table {{.Service}}\t{{.Status}}'
  echo; docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sed 's/cenario-homolog-//'
  echo; free -m | sed -n 1,3p; df -h / | tail -1
}

# Verificação de saúde completa. Sai com código 1 se algo crítico falhar.
saude() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local falhas=0 r
  ok() { echo "✔ $*"; }
  ruim() { echo "✘ $*"; falhas=$((falhas + 1)); }
  for s in postgres api web caddy backup; do
    local id st; id="$(compose ps -q "$s" 2>/dev/null || true)"
    st="$( [[ -n "$id" ]] && docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" || echo ausente)"
    [[ "$st" == running* && "$st" != *unhealthy* ]] && ok "contêiner $s: $st" || ruim "contêiner $s: $st"
  done
  local base="https://$HOMOLOG_DOMAIN" res=(--resolve "$HOMOLOG_DOMAIN:443:127.0.0.1")
  [[ -n "${CENARIO_CACERT:-}" ]] && res+=(--cacert "$CENARIO_CACERT")
  r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "$base/painel" || true)"
  [[ "$r" == 401 ]] && ok "proxy exige autenticação (sem credencial: $r)" || ruim "proxy sem credencial respondeu $r (esperado 401)"
  r="$(curl -s "${res[@]}" -b "cenario_homolog=$HOMOLOG_GATE_TOKEN" "$base/api/ready" || true)"
  [[ "$r" == *ready* ]] && ok "HTTPS + API + banco: $r" || ruim "API não pronta: $r"
  r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" -b "cenario_homolog=$HOMOLOG_GATE_TOKEN" "$base/entrar" || true)"
  [[ "$r" == 200 ]] && ok "web (tela de entrada): $r" || ruim "web respondeu $r"
  local fim; fim="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOMOLOG_DOMAIN" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [[ -n "$fim" ]]; then
    local dias=$(( ( $(date -d "$fim" +%s) - $(date +%s) ) / 86400 ))
    # Let's Encrypt: 90 dias, renovado pelo Caddy com ~30 dias de antecedência. Em teste local
    # (certificado interno de 12 h) use CENARIO_CERT_MIN_DIAS=0.
    (( dias >= ${CENARIO_CERT_MIN_DIAS:-10} )) && ok "certificado válido por mais $dias dias (até $fim)" || ruim "certificado vence em $dias dias"
  else ruim "certificado não lido"; fi
  local ultimo; ultimo="$(compose exec -T backup sh -c 'ls -1d /data/backups/cenario-* 2>/dev/null | tail -1' || true)"
  if [[ -n "$ultimo" ]]; then
    local idade; idade="$(compose exec -T backup sh -c "echo \$(( (\$(date +%s) - \$(stat -c %Y '$ultimo')) / 3600 ))")"
    (( idade <= 26 )) && ok "último backup há ${idade} h ($(basename "$ultimo"))" || ruim "último backup há ${idade} h"
  else ruim "nenhum backup encontrado"; fi
  local uso; uso="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
  (( uso < 85 )) && ok "disco em ${uso}%" || ruim "disco em ${uso}%"
  local livre; livre="$(free -m | awk '/^Mem:/ {print $7}')"
  (( livre > 150 )) && ok "memória disponível ${livre} MB" || ruim "memória disponível ${livre} MB"
  (( falhas == 0 )) && echo "Saúde: OK" || { echo "Saúde: $falhas problema(s)"; return 1; }
}

semear() { need_env; compose exec -T api pnpm db:seed; }

backup() {
  need_env
  compose exec -T backup bash /scripts/backup.sh /data/backups
  enviar_backups
}

# Envia ao bucket as pastas de backup ainda não enviadas. A conta da VM só CRIA objetos no bucket
# (não lê nem apaga), então os envios usam nomes novos e um registro local do que já foi enviado.
enviar_backups() {
  need_env
  if [[ -z "$BUCKET" ]]; then log "Sem bucket configurado (cenario-bucket): envio ignorado."; return 0; fi
  install -d -m 700 "$STATE_DIR"; touch "$STATE_DIR/enviados"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local vol; vol="$(docker volume inspect -f '{{.Mountpoint}}' cenario-homolog_backups)"
  for d in "$vol"/cenario-*; do
    [[ -d "$d" ]] || continue
    local nome; nome="$(basename "$d")"
    grep -qx "$nome" "$STATE_DIR/enviados" && continue
    ( cd "$d" && sha256sum --check --quiet SHA256SUMS ) || { log "✘ $nome com checksum inválido: não enviado"; continue; }
    tar -C "$vol" -cf "$tmp/$nome.tar" "$nome"
    gcloud storage cp --no-clobber "$tmp/$nome.tar" "$BUCKET/$nome.tar" --quiet
    echo "$nome" >> "$STATE_DIR/enviados"
    log "✔ $nome enviado a $BUCKET"
    rm -f "$tmp/$nome.tar"
  done
}

# Restauração de TESTE: banco separado, contagens comparadas, banco removido no fim.
restaurar_teste() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local pasta="${1:-}"
  [[ -n "$pasta" ]] || pasta="$(compose exec -T backup sh -c 'ls -1d /data/backups/cenario-* | tail -1' | xargs basename)"
  local db=cenario_restore_check
  compose exec -T postgres psql -qU cenario -d cenario_homolog -c "drop database if exists $db" -c "create database $db"
  compose run --rm -T --no-deps --entrypoint bash backup -c \
    "bash /scripts/restore.sh /data/backups/$pasta --target postgresql://cenario:$POSTGRES_PASSWORD@postgres:5432/$db --storage /tmp/rs --yes && echo arquivos restaurados: \$(find /tmp/rs -type f | wc -l)"
  local q="select (select count(*) from users),(select count(*) from customers),(select count(*) from service_orders),(select count(*) from production_tasks),(select count(*) from audit_logs),(select coalesce(max(seq),0) from domain_events),(select count(*) from stored_files),(select count(*) from _prisma_migrations)"
  local a b
  a="$(compose exec -T backup sh -c "psql -tA 'postgresql://cenario:$POSTGRES_PASSWORD@postgres:5432/$db' -c \"$q\"")"
  echo "restaurado ($pasta): $a"
  b="$(compose exec -T postgres psql -tAU cenario -d cenario_homolog -c "$q")"
  echo "atual:                 $b"
  compose exec -T postgres psql -qU cenario -d cenario_homolog -c "drop database $db"
  log "Restauração de teste concluída (banco temporário removido). Diferenças são esperadas se houve uso depois do backup."
}

# Restauração SOBRE a homologação. Exige --sim e faz um backup de segurança antes.
restaurar() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local pasta="${1:-}"; [[ -n "$pasta" && "${2:-}" == --sim ]] || {
    echo "Uso: vm.sh restaurar <pasta-do-backup> --sim   (substitui o banco e os arquivos da homologação)" >&2; exit 2; }
  log "Backup de segurança antes da restauração…"
  compose exec -T backup bash /scripts/backup.sh /data/backups
  compose stop api web
  compose run --rm -T --no-deps -v cenario-homolog_storage:/data/storage-rw --entrypoint bash backup -c \
    "bash /scripts/restore.sh /data/backups/$pasta --target postgresql://cenario:$POSTGRES_PASSWORD@postgres:5432/cenario_homolog --storage /data/storage-rw --yes"
  compose start api web
  log "Restauração concluída a partir de $pasta. Painéis e tablets recarregam sozinhos (resync)."
}

atualizar() {
  local nova="${1:-}"; [[ -n "$nova" ]] || { echo "Uso: vm.sh atualizar <etiqueta>" >&2; exit 2; }
  need_env
  log "Backup antes da atualização…"; backup
  local anterior; anterior="$(grep -oP "(?<=api:)[^']+" "$ENV_FILE" || true)"
  sed -i "s#\(/api:\|/web:\)[^']*'#\1$nova'#" "$ENV_FILE"
  log "Versão: $anterior → $nova (para voltar: vm.sh atualizar $anterior)"
  iniciar
  saude || log "ATENÇÃO: verificação falhou. Reverter com: vm.sh atualizar $anterior"
}

parar() { need_env; compose stop; log "Contêineres parados (volumes e dados preservados)."; }

case "${1:-}" in
  gerar-env) gerar_env ;;
  iniciar) iniciar ;;
  status) status ;;
  saude) saude ;;
  semear) semear ;;
  backup) backup ;;
  enviar-backups) enviar_backups ;;
  restaurar-teste) restaurar_teste "${2:-}" ;;
  restaurar) restaurar "${2:-}" "${3:-}" ;;
  atualizar) atualizar "${2:-}" ;;
  parar) parar ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
