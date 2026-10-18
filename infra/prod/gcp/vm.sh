#!/usr/bin/env bash
# Operação da PRODUÇÃO DENTRO da VM cenario-prod (Google Cloud) — também testável localmente.
# Derivado do vm.sh homologado (infra/homolog/gcp/vm.sh): backup, ponto de recuperação, pré-verificação
# de migrations, migração, ativação e recuperação são a MESMA lógica, com os nomes da produção
# (projeto Compose cenario-prod, banco cenario_prod, segredos prod-*, Artifact Registry cenario-prod).
# Diferenças: sem a camada de usuário/senha do proxy (não existe na produção); "acesso" confere só
# leituras públicas (nada é criado); "semear" é o bootstrap mínimo (gestor; NUNCA a equipe de exemplo).
#
#   vm.sh verificar-preparo    # SEM iniciar nada: Compose, swap, disco, portas, segredos (só código de
#                              # saída), bucket (cria um objeto de teste; leitura/listagem/exclusão negadas)
#   vm.sh gerar-env            # lê os segredos (Secret Manager) e grava /run/cenario/env (memória, 600)
#   vm.sh iniciar              # sobe a pilha (baixa as imagens da etiqueta configurada)
#   vm.sh status               # contêineres, memória e disco
#   vm.sh saude                # verificação completa (HTTPS, HTTP→HTTPS, www→canônico, API, banco,
#                              # rotas protegidas recusam sem sessão, backup, disco, certificado)
#   vm.sh acesso               # SÓ LEITURA: rotas públicas e protegidas, redirecionamentos, HTTP/3
#   vm.sh aplicar-config       # valida o Caddyfile e recria SÓ o proxy (banco, API e web intocados)
#   vm.sh iniciar-banco        # PRIMEIRA publicação: sobe SÓ o PostgreSQL e o backup (API e web paradas),
#                              # para o ponto de recuperação e as migrations do banco novo
#   vm.sh semear               # bootstrap mínimo (funções, configurações, modelos, checklists e o
#                              # primeiro gestor); SEM equipe de exemplo; confere o resultado
#   vm.sh backup               # backup imediato + envio ao bucket
#   vm.sh enviar-backups       # envia ao bucket os backups ainda não enviados (usado pelo timer diário)
#   vm.sh restaurar-teste [pasta]   # restaura num banco SEPARADO e compara (não toca na produção)
#   vm.sh restaurar <pasta> --sim   # restaura SOBRE a produção (faz backup de segurança antes)
#   vm.sh parar                # encerra os contêineres (dados preservados)
#
# ATUALIZAÇÃO CONTROLADA, um passo por vez, cada um conferindo o anterior:
#   vm.sh preparar-versao <etiqueta>  # baixa/confere as imagens novas e os digests (nada reiniciado)
#   vm.sh manutencao                  # para API e web (o proxy responde 503 "em manutenção")
#   vm.sh ponto-recuperacao           # backup + checksum + restauração em banco SEPARADO + impressão
#                                     # digital idêntica + envio ao bucket; registra o ponto
#   vm.sh migrar <etiqueta>           # pré-verificação + migrations com a imagem nova, SÓ se o banco
#                                     # ainda for idêntico ao ponto de recuperação
#   vm.sh ativar <etiqueta>           # sobe a versão nova (exige CENARIO_TAG = etiqueta) + saúde
#   vm.sh recuperar --sim             # volta ao ponto: recria o banco, restaura, confere a impressão
#                                     # digital e sobe a versão anterior (perde o que veio depois)
#   vm.sh impressao-digital [banco]   # SÓ LEITURA: conteúdo, vínculos, catálogo e valores do banco
#   vm.sh preflight [etiqueta]        # SÓ LEITURA: cadeia de migrations do banco × imagem da versão
#
# Configuração não secreta: atributos da VM (metadata) "cenario-*" ou, fora do Google Cloud,
# variáveis de ambiente com o mesmo nome em maiúsculas (ex.: CENARIO_TAG). Segredos: só no
# Secret Manager (ou, em teste local, num arquivo indicado em CENARIO_ENV_FILE).
#
# PORTÃO DE PUBLICAÇÃO: "gerar-env" e "iniciar" (e os serviços systemd) só funcionam se existir
# /etc/cenario/publicacao-autorizada. Nenhum script de preparação cria esse arquivo: só o operador
# de produção (gate_open), dentro de uma publicação autorizada.
set -euo pipefail

DIR="${CENARIO_DIR:-/opt/cenario}"
COMPOSE_FILE="$DIR/infra/prod/docker-compose.prod.yml"
ENV_FILE="${CENARIO_ENV_FILE:-/run/cenario/env}"
STATE_DIR="${CENARIO_STATE_DIR:-/var/lib/cenario}"
PORTAO="${CENARIO_PORTAO:-/etc/cenario/publicacao-autorizada}"
# Endpoints (substituíveis só nos testes locais, por servidores falsos).
META_URL="${CENARIO_META_URL:-http://metadata.google.internal/computeMetadata/v1}"
GCS_URL="${CENARIO_GCS_URL:-https://storage.googleapis.com}"

meta() { # atributo da VM; vazio fora do Google Cloud
  curl -fsS -m 2 -H 'Metadata-Flavor: Google' "$META_URL/instance/attributes/$1" 2>/dev/null || true
}
conf() { # conf <variável> <atributo> [padrão]
  local v="${!1:-}"
  [[ -n "$v" ]] || v="$(meta "$2")"
  echo "${v:-${3:-}}"
}
PROJECT="$(conf CENARIO_PROJECT cenario-project)"
REGION="$(conf CENARIO_REGION cenario-region southamerica-east1)"
REPO="$(conf CENARIO_REPO cenario-repo cenario-prod)"
TAG="$(conf CENARIO_TAG cenario-tag)"
DOMAIN="$(conf CENARIO_DOMAIN cenario-domain)"
BUCKET="$(conf CENARIO_BUCKET cenario-bucket)"
DOMAIN_WWW="$(conf CENARIO_DOMAIN_WWW cenario-domain-www)"
ADMIN_NAME="$(conf CENARIO_ADMIN_NAME cenario-admin-name Gestor)"
ADMIN_EMAIL="$(conf CENARIO_ADMIN_EMAIL cenario-admin-email)"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
log() { echo "[$(date -u +%FT%TZ)] $*"; }
need_env() { [[ -f "$ENV_FILE" ]] || { echo "Variáveis ausentes: rode 'vm.sh gerar-env'." >&2; exit 2; }; }
need_portao() {
  [[ -f "$PORTAO" ]] || {
    echo "Publicação NÃO autorizada ($PORTAO ausente): nada foi iniciado nem lido do Secret Manager." >&2
    exit 3
  }
}

# Cabeçalho de autorização (token da conta de serviço da VM, pelo servidor de metadados) num
# arquivo 600: o token nunca aparece nos argumentos de processos nem em logs.
cabecalho_token() { # cabecalho_token <arquivo>
  local tok
  tok="$(curl -fsS -m 5 -H 'Metadata-Flavor: Google' "$META_URL/instance/service-accounts/default/token" \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')" || true
  [[ -n "$tok" ]] || { log "✘ sem token da conta de serviço (servidor de metadados)"; return 1; }
  ( umask 077; printf 'Authorization: Bearer %s\n' "$tok" > "$1" )
}

# Envio pela API JSON do Cloud Storage exigindo SÓ storage.objects.create (papel objectCreator):
# ifGenerationMatch=0 cria apenas se o nome ainda não existir (nunca sobrescreve, nunca lê).
# Imprime o código HTTP. Retorno: 0 criado · 10 já existia (412) · 1 erro (403, rede…).
gcs_criar() { # gcs_criar <arquivo-local> <nome-do-objeto> <arquivo-cabecalho>
  local codigo
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 600 -X POST -H "@$3" \
    -H 'Content-Type: application/octet-stream' --data-binary "@$1" \
    "$GCS_URL/upload/storage/v1/b/${BUCKET#gs://}/o?uploadType=media&ifGenerationMatch=0&name=$2" 2>/dev/null)" || true
  echo "${codigo:-000}"
  case "$codigo" in 200) return 0 ;; 412) return 10 ;; *) return 1 ;; esac
}

gerar_env() {
  need_portao
  [[ -n "$PROJECT" && -n "$DOMAIN" && -n "$DOMAIN_WWW" ]] || { echo "Defina cenario-project, cenario-domain e cenario-domain-www." >&2; exit 2; }
  [[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Etiqueta da versão inválida ou ausente (CENARIO_TAG): '$TAG'." >&2; exit 2; }
  local s; s() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }
  local pw tk adm
  pw="$(s prod-postgres-password)"; tk="$(s prod-token-hash-secret)"; adm="$(s prod-admin-password)"
  install -d -m 700 "$(dirname "$ENV_FILE")"
  umask 077
  # Aspas simples: o Docker Compose não interpreta "$" dentro delas.
  cat > "$ENV_FILE" <<EOF
PROD_DOMAIN='$DOMAIN'
PROD_DOMAIN_WWW='$DOMAIN_WWW'
POSTGRES_PASSWORD='$pw'
TOKEN_HASH_SECRET='$tk'
SEED_ADMIN_EMAIL='$ADMIN_EMAIL'
SEED_ADMIN_PASSWORD='$adm'
SEED_ADMIN_NAME='$ADMIN_NAME'
CENARIO_API_IMAGE='$REGION-docker.pkg.dev/$PROJECT/$REPO/api:$TAG'
CENARIO_WEB_IMAGE='$REGION-docker.pkg.dev/$PROJECT/$REPO/web:$TAG'
EOF
  log "Variáveis geradas em $ENV_FILE (memória, permissão 600)."
}

iniciar() {
  need_portao
  need_env
  if [[ -n "$PROJECT" ]]; then
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
    compose pull --quiet api web
  fi
  compose up -d --no-build --remove-orphans
  for _ in $(seq 1 "${CENARIO_ESPERA:-60}"); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null)" == healthy ]] && break
    sleep 5
  done
  status
}

status() {
  need_env
  compose ps --format 'table {{.Service}}\t{{.Status}}'
  echo; docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sed 's/cenario-prod-//'
  echo; free -m | sed -n 1,3p; df -h / | tail -1
}

# Rotas que NUNCA respondem sem sessão (gerencial, financeiro, auditoria, Central). Só GET: nada
# é criado nem alterado; sem sessão a API recusa antes de qualquer consulta.
ROTAS_PROTEGIDAS=(/api/v1/management/overview /api/v1/attention /api/v1/finance/receivables /api/v1/finance/labor /api/audit /api/employees)

# Verificações de acesso SÓ LEITURA (sem sessão, sem criar nada). Imprime "✔ …"/"✘ …".
verificar_acesso() { # verificar_acesso <base> <opções do curl…>
  local base="$1"; shift
  local res=("$@") r d rota js
  d="$(mktemp -d)"; chmod 700 "$d"
  r="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${res[@]}" "http://$PROD_DOMAIN/entrar" || true)"
  [[ "$r" =~ ^30[178]\ https://$PROD_DOMAIN/entrar$ ]] && echo "✔ HTTP redireciona para HTTPS ($r)" || echo "✘ HTTP sem redirecionamento para HTTPS: '$r'"
  r="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${res[@]}" "https://$PROD_DOMAIN_WWW/entrar" || true)"
  [[ "$r" == "301 https://$PROD_DOMAIN/entrar" ]] && echo "✔ www redireciona para o domínio canônico ($r)" || echo "✘ www: '$r' (esperado 301 para https://$PROD_DOMAIN/entrar)"
  r="$(curl -s -D "$d/h" -o "$d/pag" -w '%{http_code}' "${res[@]}" "$base/entrar" || true)"
  if [[ "$r" == 200 ]] && grep -q 'Entrar' "$d/pag" && grep -q '/_next/static/' "$d/pag"; then echo "✔ tela de entrada: 200"
  else echo "✘ tela de entrada respondeu $r"; fi
  if grep -qi '^alt-svc:.*h3' "$d/h"; then echo "✘ o proxy anuncia HTTP/3, mas UDP 443 não está liberado"; else echo "✔ sem anúncio de HTTP/3 (só TCP)"; fi
  grep -qi '^strict-transport-security:' "$d/h" && echo "✔ HSTS presente" || echo "✘ HSTS ausente"
  js="$(grep -o '/_next/static/[^"]*\.js' "$d/pag" | head -1)"
  if [[ -n "$js" ]]; then
    r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "$base$js" || true)"
    [[ "$r" == 200 ]] && echo "✔ JavaScript da tela carrega ($r)" || echo "✘ JavaScript da tela: $r"
  else echo "✘ tela de entrada sem JavaScript referenciado"; fi
  for rota in "${ROTAS_PROTEGIDAS[@]}"; do
    r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "$base$rota" || true)"
    [[ "$r" == 401 ]] && echo "✔ $rota sem sessão: 401" || echo "✘ $rota sem sessão respondeu $r (esperado 401)"
  done
  r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: Y2VuYXJpby1wcm9kLXRlc3Rl' -H "Origin: $base" "$base/api/realtime" || true)"
  [[ "$r" == 401 || "$r" == 101 ]] && echo "✔ WebSocket /api/realtime pelo proxy: $r (401 sem sessão)" || echo "✘ WebSocket /api/realtime: $r"
  rm -rf "$d"
}

acesso() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local base="https://$PROD_DOMAIN" res=(--resolve "$PROD_DOMAIN:443:127.0.0.1" --resolve "$PROD_DOMAIN:80:127.0.0.1" --resolve "$PROD_DOMAIN_WWW:443:127.0.0.1")
  [[ -n "${CENARIO_CACERT:-}" ]] && res+=(--cacert "$CENARIO_CACERT")
  local falhas=0 linha
  while IFS= read -r linha; do
    echo "$linha"; [[ "$linha" == "✘ "* ]] && falhas=$((falhas + 1))
  done < <(verificar_acesso "$base" "${res[@]}")
  (( falhas == 0 )) && echo "Acesso: OK" || { echo "Acesso: $falhas problema(s)"; return 1; }
}

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
  local base="https://$PROD_DOMAIN" res=(--resolve "$PROD_DOMAIN:443:127.0.0.1" --resolve "$PROD_DOMAIN:80:127.0.0.1" --resolve "$PROD_DOMAIN_WWW:443:127.0.0.1")
  [[ -n "${CENARIO_CACERT:-}" ]] && res+=(--cacert "$CENARIO_CACERT")
  r="$(curl -s "${res[@]}" "$base/api/ready" || true)"
  [[ "$r" == *ready* ]] && ok "HTTPS + API + banco: $r" || ruim "API não pronta: $r"
  r="$(curl -s "${res[@]}" "$base/api/health" || true)"
  [[ "$r" == *'"environment":"production"'* ]] && ok "API em APP_ENV=production" || ruim "API não informa APP_ENV=production: $r"
  local linha; while IFS= read -r linha; do
    case "$linha" in "✔ "*) ok "${linha#✔ }" ;; "✘ "*) ruim "${linha#✘ }" ;; *) echo "$linha" ;; esac
  done < <(verificar_acesso "$base" "${res[@]}")
  local fim; fim="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$PROD_DOMAIN" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [[ -n "$fim" ]]; then
    local dias=$(( ( $(date -d "$fim" +%s) - $(date +%s) ) / 86400 ))
    # Let's Encrypt: 90 dias, renovado pelo Caddy com ~30 dias de antecedência. Em teste local
    # (certificado interno de 12 h) use CENARIO_CERT_MIN_DIAS=0.
    (( dias >= ${CENARIO_CERT_MIN_DIAS:-10} )) && ok "certificado válido por mais $dias dias (até $fim)" || ruim "certificado vence em $dias dias"
  else ruim "certificado não lido"; fi
  local ultimo; ultimo="$(compose exec -T backup sh -c 'ls -1dt /data/backups/cenario-*/ 2>/dev/null | head -1' | sed 's#/$##' || true)"
  if [[ -n "$ultimo" ]]; then
    local idade; idade="$(compose exec -T backup sh -c "echo \$(( (\$(date +%s) - \$(stat -c %Y '$ultimo')) / 3600 ))")"
    (( idade <= 26 )) && ok "último backup há ${idade} h ($(basename "$ultimo"))" || ruim "último backup há ${idade} h"
  else ruim "nenhum backup encontrado"; fi
  local mig; mig="$(compose exec -T postgres psql -tAU cenario -d cenario_prod -c \
    "select count(*) filter (where finished_at is not null and rolled_back_at is null) || ' ' || count(*) filter (where finished_at is null and rolled_back_at is null) from _prisma_migrations" 2>/dev/null || true)"
  if [[ "$mig" =~ ^([0-9]+)\ 0$ ]]; then ok "migrations: ${BASH_REMATCH[1]} aplicadas, nenhuma pendente/com falha"
  else ruim "migrations: '${mig:-sem resposta}' (aplicadas pendentes/falhas)"; fi
  # Produção: alerta antes (80%) que a homologação (85%), com folga para uma versão nova.
  local uso; uso="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
  (( uso < ${CENARIO_DISCO_MAX:-80} )) && ok "disco em ${uso}%" || ruim "disco em ${uso}% (limite ${CENARIO_DISCO_MAX:-80}%)"
  local livre; livre="$(free -m | awk '/^Mem:/ {print $7}')"
  (( livre > 300 )) && ok "memória disponível ${livre} MB" || ruim "memória disponível ${livre} MB"
  (( falhas == 0 )) && echo "Saúde: OK" || { echo "Saúde: $falhas problema(s)"; return 1; }
}

# Bootstrap mínimo de produção (docs/PRODUCAO.md §Seed). O seed do repositório, SEM a equipe de
# exemplo (SEED_TEAM=false): funções e permissões, configurações da empresa, modelos de produção,
# checklists de qualidade, localizações e o primeiro gestor (só com SEED_ADMIN_* do Secret Manager).
# Recusa se o banco já tiver qualquer funcionário além do gestor (não é para rodar sobre dados reais)
# e confere o resultado: um único funcionário (o gestor), nenhum dado comercial.
semear() {
  need_env
  local n; n="$(compose exec -T postgres psql -tAU cenario -d cenario_prod -c 'select count(*) from employees' 2>/dev/null | tr -dc 0-9)"
  [[ -n "$n" ]] || { echo "✘ não consegui ler o banco (migrations aplicadas?)" >&2; return 1; }
  (( n <= 1 )) || { echo "✘ o banco já tem $n funcionários: o bootstrap é só para o banco novo. Nada foi feito." >&2; return 1; }
  compose exec -T -e SEED_TEAM=false api pnpm db:seed
  local q
  q="$(compose exec -T postgres psql -tAU cenario -d cenario_prod -F'|' -c "select
    (select count(*) from employees), (select count(*) from users), (select count(*) from customers),
    (select count(*) from commercial_orders), (select count(*) from service_orders), (select count(*) from devices),
    (select count(*) from roles), (select count(*) from production_templates), (select count(*) from quality_templates)")"
  echo "• funcionários|usuários|clientes|pedidos|OS|dispositivos|funções|modelos|checklists: $q"
  IFS='|' read -r fe us cl pe os dv fu mo ch <<<"$(tr -d '[:space:]' <<<"$q")"
  if [[ "$fe" == 1 && "$us" == 1 && "$cl" == 0 && "$pe" == 0 && "$os" == 0 && "$dv" == 0 && "$fu" -gt 0 && "$mo" -gt 0 && "$ch" -gt 0 ]]; then
    echo "✔ bootstrap mínimo: só o gestor; nenhum cliente, pedido, OS, dispositivo ou funcionário de exemplo"
  else echo "✘ resultado inesperado do bootstrap (veja as contagens acima)"; return 1; fi
}

# Aplica uma mudança no Caddyfile recriando SÓ o proxy (banco, API, web e dados intocados; os
# certificados ficam no volume caddy_data). Valida a configuração antes; segredos vão ao
# contêiner por nome de variável (nunca nos argumentos).
aplicar_config() {
  need_portao
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  if ! docker run --rm -v "$DIR/infra/prod/Caddyfile.prod:/etc/caddy/Caddyfile:ro" \
    -e PROD_DOMAIN -e PROD_DOMAIN_WWW \
    caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "✘ Caddyfile inválido: nada foi alterado no proxy em execução." >&2; return 1
  fi
  log "Caddyfile válido. Recriando só o proxy (caddy)…"
  compose up -d --no-deps --force-recreate caddy
  sleep 5
  saude
}

backup() {
  need_env
  compose exec -T backup bash /scripts/backup.sh /data/backups
  enviar_backups
}

# Envia ao bucket as pastas de backup ainda não enviadas. A conta da VM só CRIA objetos no bucket
# (não lê, não lista, não apaga), então os envios usam nomes novos e um registro local do que já foi
# enviado. Objeto já existente (412) conta como enviado; qualquer outro erro NÃO é registrado e o
# comando termina com erro (o timer tenta de novo no dia seguinte).
enviar_backups() {
  if [[ -z "$BUCKET" ]]; then log "Sem bucket configurado (cenario-bucket): envio ignorado."; return 0; fi
  install -d -m 700 "$STATE_DIR"; touch "$STATE_DIR/enviados"
  local tmp; tmp="$(mktemp -d)"; trap "rm -rf '$tmp'; trap - RETURN" RETURN
  local vol="${CENARIO_BACKUPS_DIR:-}"
  [[ -n "$vol" ]] || vol="$(docker volume inspect -f '{{.Mountpoint}}' cenario-prod_backups 2>/dev/null || true)"
  [[ -n "$vol" && -d "$vol" ]] || { log "Sem volume de backups: nada a enviar."; return 0; }
  cabecalho_token "$tmp/auth" || return 1
  local erros=0 d nome codigo rc
  for d in "$vol"/cenario-*; do
    [[ -d "$d" ]] || continue
    nome="$(basename "$d")"
    grep -qx "$nome" "$STATE_DIR/enviados" && continue
    ( cd "$d" && sha256sum --check --quiet SHA256SUMS ) || { log "✘ $nome com checksum inválido: não enviado"; erros=$((erros + 1)); continue; }
    tar -C "$vol" -cf "$tmp/envio.tar" "$nome" # o mesmo arquivo temporário é reaproveitado a cada pasta
    rc=0; codigo="$(gcs_criar "$tmp/envio.tar" "backups/$nome.tar" "$tmp/auth")" || rc=$?
    case "$rc" in
      0) echo "$nome" >> "$STATE_DIR/enviados"; log "✔ $nome enviado a $BUCKET/backups/" ;;
      10) echo "$nome" >> "$STATE_DIR/enviados"; log "• $nome já estava no bucket (HTTP $codigo): registrado como enviado" ;;
      *) log "✘ $nome NÃO enviado (HTTP $codigo)"; erros=$((erros + 1)) ;;
    esac
  done
  (( erros == 0 )) || { log "Envio com $erros erro(s)."; return 1; }
}

# Verificação da preparação, SEM iniciar contêineres, sem PostgreSQL, sem migrations e sem gravar
# segredos: lê o estado da VM, valida o Compose com valores FICTÍCIOS, confere o acesso aos
# segredos pelo código de saída (o valor vai para /dev/null) e testa as permissões do bucket com
# um objeto de teste fictício (gravar: permitido; regravar, ler, listar e apagar: negados).
verificar_preparo() {
  local falhas=0
  ok() { echo "✔ $*"; }
  ruim() { echo "✘ $*"; falhas=$((falhas + 1)); }
  if [[ -f "$PORTAO" ]]; then ruim "portão de publicação ABERTO ($PORTAO existe)"; else ok "portão de publicação fechado ($PORTAO ausente)"; fi
  local n; n="$(docker ps -q 2>/dev/null | wc -l)"
  (( n == 0 )) && ok "nenhum contêiner em execução" || ruim "$n contêiner(es) em execução"
  if docker compose version >/dev/null 2>&1; then ok "$(docker --version | cut -d, -f1) · Compose $(docker compose version --short)"
  else ruim "Docker Compose ausente"; fi
  local sw; sw="$(swapon --show=SIZE --noheadings --bytes 2>/dev/null | awk '{s+=$1} END {print int(s/1048576)}')"
  (( ${sw:-0} >= 1024 )) && ok "swap ativa: ${sw} MB" || ruim "swap insuficiente: ${sw:-0} MB"
  local uso; uso="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
  (( uso < 70 )) && ok "disco em ${uso}%" || ruim "disco em ${uso}% (imagens + volumes precisam de folga)"
  local portas; portas="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed 's/.*://' | sort -un | xargs || true)"
  [[ -z "$portas" || "$portas" == 22 ]] && ok "portas escutando fora do loopback: ${portas:-nenhuma}" \
    || ruim "portas escutando fora do loopback: $portas (esperado só 22)"
  local tmp; tmp="$(mktemp -d)"; trap "rm -rf '$tmp'; trap - RETURN" RETURN
  cat > "$tmp/env" <<'FICTICIO'
PROD_DOMAIN='prod.exemplo.invalid'
PROD_DOMAIN_WWW='www.prod.exemplo.invalid'
POSTGRES_PASSWORD='ficticio'
TOKEN_HASH_SECRET='ficticio-ficticio-ficticio-ficticio'
CENARIO_API_IMAGE='imagem-ficticia/api:0'
CENARIO_WEB_IMAGE='imagem-ficticia/web:0'
FICTICIO
  if docker compose -f "$COMPOSE_FILE" --env-file "$tmp/env" config -q 2>"$tmp/erro"; then
    ok "docker-compose.prod.yml válido (valores fictícios; nada iniciado)"
    local pub
    pub="$(docker compose -f "$COMPOSE_FILE" --env-file "$tmp/env" config --format json 2>/dev/null \
      | grep -o '"published": *"*[0-9]*' | tr -dc '0-9\n' | sort -n | xargs || true)"
    [[ "$pub" == "80 443" ]] && ok "portas publicadas pelo Compose: só 80 e 443 (caddy); PostgreSQL, API e web sem porta" \
      || ruim "portas publicadas no Compose: ${pub:-?} (esperado 80 443)"
  else ruim "docker-compose.prod.yml inválido: $(head -3 "$tmp/erro")"; fi
  [[ -f "$DIR/scripts/backup.sh" && -f "$DIR/scripts/restore.sh" ]] && ok "scripts de backup/restauração presentes" || ruim "scripts de backup ausentes em $DIR/scripts"
  if command -v gcloud >/dev/null 2>&1; then
    local s
    for s in prod-postgres-password prod-token-hash-secret prod-admin-password; do
      if gcloud secrets versions access latest --secret="$s" --project="$PROJECT" >/dev/null 2>&1; then ok "segredo $s: acessível pela conta da VM (valor não exibido)"
      else ruim "segredo $s: SEM acesso pela conta da VM"; fi
    done
  else ruim "gcloud ausente na VM (necessário para ler os segredos)"; fi
  local escopos; escopos="$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' "$META_URL/instance/service-accounts/default/scopes" 2>/dev/null | xargs || true)"
  [[ "$escopos" == *cloud-platform* ]] && ok "escopo de acesso da VM: cloud-platform" || ruim "escopos de acesso da VM sem cloud-platform: ${escopos:-?}"
  if [[ -n "$BUCKET" ]]; then
    local b="${BUCKET#gs://}" nome enc codigo rc
    nome="testes-preparo/$(hostname)-$(date -u +%Y%m%dT%H%M%SZ).txt"; enc="${nome//\//%2F}"
    echo "Objeto de TESTE da preparação (dados fictícios). Apagado pela regra de 30 dias do bucket." > "$tmp/teste.txt"
    if cabecalho_token "$tmp/auth"; then
      rc=0; codigo="$(gcs_criar "$tmp/teste.txt" "$nome" "$tmp/auth")" || rc=$?
      (( rc == 0 )) && ok "bucket: gravação permitida (HTTP $codigo, $nome)" || ruim "bucket: gravação FALHOU (HTTP $codigo)"
      rc=0; codigo="$(gcs_criar "$tmp/teste.txt" "$nome" "$tmp/auth")" || rc=$?
      (( rc == 10 )) && ok "bucket: regravação do mesmo nome recusada (HTTP $codigo): nada é sobrescrito" || ruim "bucket: regravação respondeu HTTP $codigo (esperado 412)"
      codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -H "@$tmp/auth" "$GCS_URL/storage/v1/b/$b/o/$enc?alt=media" 2>/dev/null)" || true
      [[ "$codigo" == 403 ]] && ok "bucket: leitura negada (HTTP 403)" || ruim "bucket: leitura respondeu HTTP ${codigo:-000} (esperado 403)"
      codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -H "@$tmp/auth" "$GCS_URL/storage/v1/b/$b/o?maxResults=1" 2>/dev/null)" || true
      [[ "$codigo" == 403 ]] && ok "bucket: listagem negada (HTTP 403)" || ruim "bucket: listagem respondeu HTTP ${codigo:-000} (esperado 403)"
      codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -X DELETE -H "@$tmp/auth" "$GCS_URL/storage/v1/b/$b/o/$enc" 2>/dev/null)" || true
      [[ "$codigo" == 403 ]] && ok "bucket: exclusão negada (HTTP 403)" || ruim "bucket: exclusão respondeu HTTP ${codigo:-000} (esperado 403)"
    else ruim "bucket: sem token da conta de serviço"; fi
  else ruim "cenario-bucket não configurado nos metadados da VM"; fi
  echo
  if (( falhas == 0 )); then echo "PREPARO DA VM: OK (nada foi iniciado)"
  else echo "PREPARO DA VM: $falhas problema(s) (nada foi iniciado)"; return 1; fi
}

# Impressão digital SÓ LEITURA de um banco, item a item (sql/impressao-digital.sql): conteúdo de
# todas as tabelas, colunas, restrições, índices, gatilhos, funções, tipos, sequências, definições,
# migrations e somas de todas as colunas *_cents. Conferência da restauração: conferencia-restauracao.sh.
psql_em() { local db="$1"; shift; compose exec -T postgres psql -U cenario -d "$db" -At -F'|' -v ON_ERROR_STOP=1 "$@"; }
pg_sh() { compose exec -T postgres sh -c "$1"; }
CONF_SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sql"
# shellcheck source=conferencia-restauracao.sh
source "$(dirname "${BASH_SOURCE[0]}")/conferencia-restauracao.sh"
impressao_digital() { # impressao_digital [banco]
  need_env
  impressao_de "${1:-cenario_prod}"
}
# Pré-verificação da cadeia de migrations (somente leitura) para a versão <etiqueta>: lê as
# migrations da IMAGEM (sem iniciar a aplicação) e, do banco, só o estado das migrations, o catálogo
# do esquema e as verificações de dados (consultas fixas em sql/preflight-*.sql). A comparação é do
# preflight_migracoes.py. Código 1 = bloqueio (nada foi alterado).
preflight() { # preflight [etiqueta]
  need_env
  local tag="${1:-}"
  [[ -n "$tag" ]] || tag="$(cat "$STATE_DIR/candidata" 2>/dev/null || true)"
  etiqueta_valida "$tag"
  local ref sqld="$DIR/infra/prod/gcp/sql" tmp
  ref="$(imagem api "$tag")"
  docker image inspect "$ref" >/dev/null 2>&1 || { echo "✘ imagem $ref ausente na VM: rode 'vm.sh preparar-versao $tag'." >&2; return 1; }
  tmp="$(mktemp -d)"; trap "rm -rf '$tmp'; trap - RETURN" RETURN
  docker run --rm --entrypoint tar "$ref" -C packages/db/prisma -cf - migrations > "$tmp/m.tar" \
    || { echo "✘ não consegui ler as migrations da imagem $ref" >&2; return 1; }
  mkdir "$tmp/img"
  tar -xf "$tmp/m.tar" -C "$tmp/img" --no-same-owner --no-same-permissions
  : > "$tmp/estado"
  if [[ "$(psql_em cenario_prod -c "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" == t ]]; then
    psql_em cenario_prod < "$sqld/preflight-estado.sql" | sed -E '/^(BEGIN|ROLLBACK|SET)$/d' > "$tmp/estado"
  fi
  psql_em cenario_prod < "$sqld/preflight-catalogo.sql" | sed -E '/^(BEGIN|ROLLBACK)$/d' > "$tmp/catalogo"
  psql_em cenario_prod < "$sqld/preflight-migracoes.sql" | sed -E '/^(BEGIN|ROLLBACK)$/d' > "$tmp/dados"
  python3 -I "$DIR/infra/prod/gcp/preflight_migracoes.py" --versao "$tag" --migracoes "$tmp/img/migrations" \
    --estado "$tmp/estado" --catalogo "$tmp/catalogo" --verificacoes "$tmp/dados"
}

# Restaura <pasta> num banco <destino> (recriado VAZIO antes: um pg_restore --clean sobre um schema
# mais novo deixaria tabelas/tipos novos para trás e falharia nas chaves estrangeiras deles).
restaurar_em() { # restaurar_em <pasta> <banco> [--com-arquivos]
  local pasta="$1" db="$2"
  compose exec -T postgres psql -qU cenario -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db OWNER cenario"
  if [[ "${3:-}" == --com-arquivos ]]; then
    compose run --rm -T --no-deps -v cenario-prod_storage:/data/storage-rw --entrypoint bash backup -c \
      "bash /scripts/restore.sh /data/backups/$pasta --target postgresql://cenario:$POSTGRES_PASSWORD@postgres:5432/$db --storage /data/storage-rw --yes"
  else
    compose run --rm -T --no-deps --entrypoint bash backup -c \
      "bash /scripts/restore.sh /data/backups/$pasta --target postgresql://cenario:$POSTGRES_PASSWORD@postgres:5432/$db --storage /tmp/rs --yes && echo arquivos restaurados: \$(find /tmp/rs -type f | wc -l)"
  fi
}

# Restauração de TESTE: bancos SEPARADOS (cenario_restore_check com o backup; cenario_restore_ref só
# com o esquema atual do original), conferidos item a item (conferencia-restauracao.sh) e removidos
# no fim. O banco original só é lido. Sem <pasta>: o backup mais RECENTE pela data de criação.
# Saída: 0 idêntica · 1 diverge · 2 o original mudou durante a conferência · 3 referência inválida.
restaurar_teste() { # restaurar_teste [pasta] [arquivo-impressao-do-original] [dir-de-saida]
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local pasta="${1:-}" antes="${2:-}" saida="${3:-}"
  [[ -n "$pasta" ]] || pasta="$(compose exec -T backup sh -c 'ls -1dt /data/backups/cenario-*/ | head -1' | sed 's#/$##' | xargs basename)"
  [[ "$pasta" =~ ^cenario-[A-Za-z0-9._-]+$ ]] || { echo "✘ pasta de backup inválida: '$pasta'" >&2; return 1; }
  echo "• backup conferido: $pasta"
  local db=cenario_restore_check ref=cenario_restore_ref tmp rc=0; tmp="$(mktemp -d)"
  if [[ -z "$antes" ]]; then impressao_digital > "$tmp/antes"; antes="$tmp/antes"; fi
  restaurar_em "$pasta" "$db" || { psql_em postgres -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)"; rm -rf "$tmp"; log "✘ restauração de teste de $pasta falhou"; return 1; }
  criar_referencia cenario_prod "$ref" || rc=3
  (( rc == 0 )) && { conferir_restauracao "$antes" cenario_prod "$db" "$ref" "$tmp" || rc=$?; }
  psql_em postgres -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "DROP DATABASE IF EXISTS $ref WITH (FORCE)"
  [[ -n "$saida" && -f "$tmp/restaurado" ]] && cp "$tmp/restaurado" "$saida/"
  rm -rf "$tmp"
  case "$rc" in
    0) log "✔ Restauração de teste de $pasta IDÊNTICA ao banco atual (conteúdo, vínculos, catálogo e valores)." ;;
    2) log "✘ o banco original foi ALTERADO durante a conferência: refaça com a aplicação parada." ;;
    3) log "✘ não foi possível montar a referência do esquema atual: conferência não concluída." ;;
    *) log "✘ Restauração de teste de $pasta NÃO idêntica (itens acima). Backup NÃO aprovado." ;;
  esac
  return "$rc"
}

# Restauração SOBRE a produção. Exige --sim e faz um backup de segurança antes. O banco é
# RECRIADO vazio antes do pg_restore (ver restaurar_em). Arquivos criados depois do backup ficam.
restaurar() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local pasta="${1:-}"; [[ -n "$pasta" && "${2:-}" == --sim ]] || {
    echo "Uso: vm.sh restaurar <pasta-do-backup> --sim   (substitui o banco e os arquivos da PRODUÇÃO)" >&2; exit 2; }
  log "Backup de segurança antes da restauração…"
  compose exec -T backup bash /scripts/backup.sh /data/backups || log "⚠ backup de segurança falhou (seguindo: a restauração foi pedida explicitamente)"
  compose stop api web
  restaurar_em "$pasta" cenario_prod --com-arquivos
  compose up -d --no-build api web
  log "Restauração concluída a partir de $pasta. Painéis e tablets recarregam sozinhos (resync)."
}

# DESATIVADO: trocava a etiqueta e iniciava a pilha, e a imagem aplicava as migrations NA PARTIDA,
# sem teste de restauração nem garantia de que nada foi gravado depois do backup.
atualizar() {
  echo "vm.sh atualizar foi desativado (migrava implicitamente). Use, nesta ordem:" >&2
  echo "  preparar-versao <etiqueta> → manutencao → ponto-recuperacao → migrar <etiqueta> → ativar <etiqueta>" >&2
  echo "  (falha: recuperar --sim). Veja docs/PRODUCAO.md." >&2
  exit 2
}

# ======================================================== ATUALIZAÇÃO CONTROLADA
imagem() { echo "${CENARIO_REGISTRY:-$REGION-docker.pkg.dev/$PROJECT/$REPO}/$1:$2"; }
etiqueta_valida() { [[ "${1:-}" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Etiqueta inválida: '${1:-}' (SHA do commit)." >&2; exit 2; }; }
etiqueta_ativa() { sed -n "s#^CENARIO_API_IMAGE='.*/api:\([^']*\)'#\1#p" "$ENV_FILE"; }
app_parada() { # API e web sem execução
  local s id
  for s in api web; do
    id="$(compose ps -q "$s" 2>/dev/null || true)"
    [[ -z "$id" || "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" != true ]] || return 1
  done
}
PONTO_ARQ() { echo "$STATE_DIR/ponto-recuperacao"; }

preparar_versao() {
  local tag="${1:-}"; etiqueta_valida "$tag"
  need_portao; need_env
  install -d -m 700 "$STATE_DIR"
  local ref falhas=0
  if [[ -z "${CENARIO_REGISTRY:-}" && -n "$PROJECT" ]]; then
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null 2>&1 || true
  fi
  for x in api web; do
    ref="$(imagem "$x" "$tag")"
    if [[ -z "${CENARIO_REGISTRY:-}" && -n "$PROJECT" ]]; then docker pull -q "$ref" >/dev/null || { echo "✘ não baixou $ref"; falhas=$((falhas + 1)); continue; }; fi
    if ! docker image inspect "$ref" >/dev/null 2>&1; then echo "✘ imagem ausente: $ref"; falhas=$((falhas + 1)); continue; fi
    echo "✔ $x: $ref"
    echo "    digest: $(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}(local, sem digest de registro){{end}}' "$ref")"
    echo "    id: $(docker image inspect -f '{{.Id}}' "$ref") · tamanho: $(( $(docker image inspect -f '{{.Size}}' "$ref") / 1048576 )) MB"
  done
  ref="$(imagem api "$tag")"
  if docker run --rm --entrypoint sh "$ref" -c 'test -f infra/homolog/api-iniciar.sh' 2>/dev/null; then
    echo "✔ a imagem nova NÃO migra na partida (infra/homolog/api-iniciar.sh presente)"
  else echo "✘ a imagem $tag é anterior à regra de migração explícita: migraria ao iniciar"; falhas=$((falhas + 1)); fi
  local novas; novas="$(docker run --rm --entrypoint ls "$ref" packages/db/prisma/migrations 2>/dev/null | grep -c '^[0-9]' || true)"
  echo "• migrations na imagem: $novas · aplicadas no banco: $(impressao_digital | sed -n 's/^migracoes|aplicadas|\([0-9]*\)|.*/\1/p')"
  local livre; livre="$(df --output=avail -BG / | tail -1 | tr -dc 0-9)"
  (( livre >= ${CENARIO_DISCO_LIVRE_MIN_GB:-10} )) && echo "✔ disco livre: ${livre} GB" || { echo "✘ disco livre: ${livre} GB (mínimo ${CENARIO_DISCO_LIVRE_MIN_GB:-10} GB)"; falhas=$((falhas + 1)); }
  (( falhas == 0 )) || { echo "PREPARAR-VERSÃO: $falhas problema(s). Nada foi alterado."; return 1; }
  echo "$tag" > "$STATE_DIR/candidata"
  echo "PREPARAR-VERSÃO: OK (imagens presentes; nada reiniciado; banco intocado)"
}

manutencao() {
  need_portao; need_env
  compose stop web api
  app_parada && log "✔ API e web paradas: o proxy responde 503 'em manutenção'; nenhuma operação chega ao banco." \
    || { log "✘ API ou web ainda em execução"; return 1; }
}

ponto_recuperacao() {
  need_portao; need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  app_parada || { echo "✘ API/web em execução: rode 'vm.sh manutencao' antes (o ponto precisa ser estável)." >&2; return 1; }
  install -d -m 700 "$STATE_DIR"
  local tmp; tmp="$(mktemp -d)"; trap "rm -rf '$tmp'; trap - RETURN" RETURN
  impressao_digital > "$tmp/antes"
  log "Impressão do banco antes do backup: $(md5sum < "$tmp/antes" | cut -d' ' -f1) ($(wc -l < "$tmp/antes") itens)"
  log "Backup completo (banco + arquivos + SHA-256)…"
  # A pasta é a que ESTE backup informou (não a "última" por nome, que pode ser outra).
  local saida pasta; saida="$(compose exec -T backup bash /scripts/backup.sh /data/backups)" || { echo "$saida"; log "✘ backup falhou"; return 1; }
  echo "$saida"
  pasta="$(sed -n 's#^✔ Backup concluído: /data/backups/\(cenario-[A-Za-z0-9._-]*\)$#\1#p' <<<"$saida")"
  [[ -n "$pasta" && "$(wc -l <<<"$pasta")" == 1 ]] || { log "✘ não identifiquei a pasta criada por este backup"; return 1; }
  compose exec -T backup test -s "/data/backups/$pasta/database.dump" || { log "✘ $pasta sem database.dump"; return 1; }
  log "• pasta deste backup: $pasta"
  compose exec -T backup sh -c "cd /data/backups/$pasta && sha256sum --check --quiet SHA256SUMS" \
    || { log "✘ checksum do backup $pasta inválido"; return 1; }
  log "✔ $pasta íntegro (SHA256SUMS). Restauração de teste em banco separado…"
  restaurar_teste "$pasta" "$tmp/antes" "$tmp" || { log "✘ ponto de recuperação NÃO registrado"; return 1; }
  local fp; fp="$(md5sum < "$tmp/antes" | cut -d' ' -f1)"
  # Impressão esperada de QUALQUER restauração deste backup (já conferida acima): é com ela que o
  # "recuperar" compara o banco restaurado.
  install -m 600 "$tmp/antes" "$STATE_DIR/ponto-original.impressao"
  install -m 600 "$tmp/restaurado" "$STATE_DIR/ponto-restaurado.impressao"
  if [[ -n "$BUCKET" ]]; then enviar_backups || { log "✘ cópia fora da VM falhou: ponto NÃO registrado"; return 1; }; fi
  umask 077
  cat > "$(PONTO_ARQ)" <<EOF
PASTA=$pasta
DATA=$(date -u +%s)
ETIQUETA=$(etiqueta_ativa)
IMPRESSAO=$fp
RESTAURADA=$(md5sum < "$tmp/restaurado" | cut -d' ' -f1)
EOF
  log "✔ PONTO DE RECUPERAÇÃO: $pasta (versão $(etiqueta_ativa), impressão $fp). Tudo o que for gravado depois dele se perde numa recuperação."
}

ponto_carregar() { # carrega PASTA, DATA, ETIQUETA, IMPRESSAO
  [[ -f "$(PONTO_ARQ)" ]] || { echo "✘ sem ponto de recuperação: rode 'vm.sh ponto-recuperacao'." >&2; return 1; }
  # shellcheck source=/dev/null
  source "$(PONTO_ARQ)"
  # Ponto anterior a esta versão do script (sem a impressão esperada da restauração): refazer.
  [[ -n "${RESTAURADA:-}" && -f "$STATE_DIR/ponto-restaurado.impressao" \
     && "$(md5sum < "$STATE_DIR/ponto-restaurado.impressao" | cut -d' ' -f1)" == "$RESTAURADA" ]] \
    || { echo "✘ ponto de recuperação incompleto ou de versão anterior do script: rode 'vm.sh ponto-recuperacao' de novo." >&2; return 1; }
}

migrar() {
  local tag="${1:-}"; etiqueta_valida "$tag"
  need_portao; need_env
  app_parada || { echo "✘ API/web em execução: rode 'vm.sh manutencao'." >&2; return 1; }
  ponto_carregar || return 1
  local idade=$(( ($(date -u +%s) - DATA) / 60 )) max="${CENARIO_PONTO_MAX_MIN:-240}"
  (( idade <= max )) || { echo "✘ ponto de recuperação com ${idade} min (máximo $max): faça outro." >&2; return 1; }
  [[ "$(impressao_digital | md5sum | cut -d' ' -f1)" == "$IMPRESSAO" ]] \
    || { echo "✘ o banco mudou depois do ponto de recuperação $PASTA: faça outro antes de migrar." >&2; return 1; }
  echo "✔ banco idêntico ao ponto de recuperação $PASTA (${idade} min)"
  preflight "$tag" || { echo "✘ pré-verificação da cadeia de migrations BLOQUEOU: nada foi aplicado." >&2; return 1; }
  local ref log_m; ref="$(imagem api "$tag")"; log_m="$STATE_DIR/migracao-$tag-$(date -u +%Y%m%dT%H%M%SZ).log"
  log "Aplicando as migrations com $ref (log: $log_m)…"
  local ini; ini="$(date +%s)"
  if CENARIO_API_IMAGE="$ref" compose run --rm --no-deps -T -e MIGRATE_ON_START=0 --entrypoint sh api \
      -c 'pnpm db:migrate && pnpm db:status' > "$log_m" 2>&1; then
    grep -E 'Applying|applied|up to date|Database schema' "$log_m" || true
    echo "$tag" > "$STATE_DIR/migrada"
    log "✔ migrations aplicadas em $(( $(date +%s) - ini )) s. Próximo: activate_version $tag"
  else
    tail -20 "$log_m"
    log "✘ MIGRATION FALHOU (banco pode estar em estado PARCIAL). NÃO inicie a API. Recupere com: vm.sh recuperar --sim (ponto $PASTA)."
    return 1
  fi
}

ativar() {
  local tag="${1:-}"; etiqueta_valida "$tag"
  need_portao; need_env
  [[ "$TAG" == "$tag" ]] || { echo "✘ CENARIO_TAG='$TAG' ≠ $tag: num reinício da VM a versão errada subiria (o runner fixa a etiqueta local antes de ativar)." >&2; return 1; }
  sed -i "s#^\(CENARIO_\(API\|WEB\)_IMAGE='.*/\(api\|web\):\)[^']*'#\1$tag'#" "$ENV_FILE"
  [[ "$(etiqueta_ativa)" == "$tag" ]] || { echo "✘ não consegui gravar a etiqueta no ambiente" >&2; return 1; }
  compose up -d --no-build --remove-orphans || log "⚠ o Compose relatou falha ao subir; conferindo a saúde da API…"
  local st=""
  for _ in $(seq 1 "${CENARIO_ESPERA:-60}"); do
    st="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null || true)"
    [[ "$st" == healthy ]] && break; sleep 5
  done
  [[ "$st" == healthy ]] || { compose logs --tail 30 api; log "✘ API não ficou saudável. Recuperação: vm.sh recuperar --sim"; return 1; }
  saude
}

recuperar() {
  [[ "${1:-}" == --sim ]] || { echo "Uso: vm.sh recuperar --sim   (volta ao ponto de recuperação; perde o que foi gravado depois)" >&2; exit 2; }
  need_portao; need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  ponto_carregar || return 1
  [[ "$TAG" == "$ETIQUETA" ]] || { echo "✘ CENARIO_TAG='$TAG' ≠ versão do ponto ($ETIQUETA)." >&2; return 1; }
  log "Recuperação para o ponto $PASTA (versão $ETIQUETA)…"
  compose stop web api
  log "Backup de segurança do estado atual (análise posterior)…"
  compose exec -T backup bash /scripts/backup.sh /data/backups || log "⚠ backup de segurança falhou (seguindo)"
  restaurar_em "$PASTA" cenario_prod --com-arquivos
  local agora; agora="$(mktemp)"; impressao_digital > "$agora"
  if cmp -s "$agora" "$STATE_DIR/ponto-restaurado.impressao"; then
    log "✔ banco IDÊNTICO ao ponto de recuperação (impressão $IMPRESSAO; restauração conferida no ponto)"; rm -f "$agora"
  else
    listar_diferencas "$STATE_DIR/ponto-restaurado.impressao" "$agora" esperado restaurado "" "" "$(dirname "$agora")"
    rm -f "$agora"; log "✘ banco restaurado difere do ponto: NÃO iniciado. Verifique antes de prosseguir."; return 1
  fi
  sed -i "s#^\(CENARIO_\(API\|WEB\)_IMAGE='.*/\(api\|web\):\)[^']*'#\1$ETIQUETA'#" "$ENV_FILE"
  # Recarrega: as variáveis exportadas acima (imagens antigas) teriam precedência sobre o
  # --env-file do Compose e subiriam de novo a versão nova.
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  [[ "$CENARIO_API_IMAGE" == *":$ETIQUETA" && "$CENARIO_WEB_IMAGE" == *":$ETIQUETA" ]] \
    || { log "✘ não consegui gravar a versão $ETIQUETA no ambiente"; return 1; }
  compose up -d --no-build --remove-orphans || log "⚠ o Compose relatou falha ao subir; conferindo a saúde da API…"
  local st=""
  for _ in $(seq 1 "${CENARIO_ESPERA:-60}"); do
    st="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null || true)"
    [[ "$st" == healthy ]] && break; sleep 5
  done
  log "Versão $ETIQUETA em execução (API: ${st:-?})."
  saude
}

# PRIMEIRA publicação (banco novo): sem a API (que recusa iniciar com migrations pendentes) o contêiner
# de backup não subiria pela dependência do Compose; aqui sobem SÓ o PostgreSQL e o backup (--no-deps),
# com API e web paradas, para que o ponto de recuperação, a pré-verificação e as migrations sigam
# exatamente o fluxo homologado. Num banco que já tem tabelas, só informa (o fluxo normal se aplica).
iniciar_banco() {
  need_portao; need_env
  compose up -d --no-build --no-deps postgres
  local st=""
  for _ in $(seq 1 "${CENARIO_ESPERA:-60}"); do
    st="$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q postgres)" 2>/dev/null || true)"
    [[ "$st" == healthy ]] && break; sleep 2
  done
  [[ "$st" == healthy ]] || { log "✘ PostgreSQL não ficou saudável"; return 1; }
  local n; n="$(compose exec -T postgres psql -tAU cenario -d cenario_prod -c "select count(*) from pg_tables where schemaname = 'public'" | tr -dc 0-9)"
  compose up -d --no-build --no-deps backup
  app_parada || { log "✘ API ou web em execução: use o fluxo normal (manutencao)"; return 1; }
  if [[ "$n" == 0 ]]; then log "✔ banco NOVO (nenhuma tabela): PostgreSQL e backup em execução; API e web paradas"
  else log "• o banco já tem $n tabela(s): siga o fluxo normal de atualização"; fi
}

parar() { need_env; compose stop; log "Contêineres parados (volumes e dados preservados)."; }

case "${1:-}" in
  verificar-preparo) verificar_preparo ;;
  gerar-env) gerar_env ;;
  iniciar) iniciar ;;
  status) status ;;
  saude) saude ;;
  acesso) acesso ;;
  aplicar-config) aplicar_config ;;
  semear) semear ;;
  iniciar-banco) iniciar_banco ;;
  backup) backup ;;
  enviar-backups) enviar_backups ;;
  restaurar-teste) restaurar_teste "${2:-}" ;;
  restaurar) restaurar "${2:-}" "${3:-}" ;;
  atualizar) atualizar "${2:-}" ;;
  preparar-versao) preparar_versao "${2:-}" ;;
  manutencao) manutencao ;;
  ponto-recuperacao) ponto_recuperacao ;;
  migrar) migrar "${2:-}" ;;
  ativar) ativar "${2:-}" ;;
  recuperar) recuperar "${2:-}" ;;
  impressao-digital) impressao_digital "${2:-}" ;;
  preflight) preflight "${2:-}" ;;
  parar) parar ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
