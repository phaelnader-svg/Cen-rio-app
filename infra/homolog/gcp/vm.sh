#!/usr/bin/env bash
# Operação da homologação DENTRO da VM (Google Cloud) — também testável localmente.
#
#   vm.sh verificar-preparo    # SEM iniciar nada: Compose, swap, disco, portas, segredos (só código de
#                              # saída), bucket (cria um objeto de teste; leitura/listagem/exclusão negadas)
#   vm.sh gerar-env            # lê os segredos (Secret Manager) e grava /run/cenario/env (memória, 600)
#   vm.sh iniciar              # sobe a pilha (baixa as imagens da etiqueta configurada)
#   vm.sh status               # contêineres, memória e disco
#   vm.sh saude                # verificação completa (HTTPS, proxy com a senha real → cookie → /entrar,
#                              # API, banco, backup, disco, certificado)
#   vm.sh aplicar-config       # valida o Caddyfile e recria SÓ o proxy (banco, API e web intocados)
#   vm.sh diagnosticar-acesso [horas]  # SÓ LEITURA: por que um navegador não chega à tela de entrada
#                              # (senha do proxy × hash em uso, fluxo completo, tentativas no log do Caddy)
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
#
# PORTÃO DE PUBLICAÇÃO: "gerar-env" e "iniciar" (e os serviços systemd) só funcionam se existir
# /etc/cenario/publicacao-autorizada. Nenhum script de preparação cria esse arquivo: só o operador,
# depois da autorização explícita (docs/HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md §11).
set -euo pipefail

DIR="${CENARIO_DIR:-/opt/cenario}"
COMPOSE_FILE="$DIR/infra/homolog/docker-compose.homolog.yml"
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
  [[ -n "$PROJECT" && -n "$DOMAIN" ]] || { echo "Defina cenario-project e cenario-domain." >&2; exit 2; }
  local s; s() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT"; }
  local pw tk adm proxy gate hash
  pw="$(s homolog-postgres-password)"; tk="$(s homolog-token-hash-secret)"
  adm="$(s homolog-admin-password)"; proxy="$(s homolog-proxy-password)"; gate="$(s homolog-gate-token)"
  # Hash bcrypt da senha do proxy calculado na própria VM (a senha em texto fica só no Secret Manager).
  # Pela entrada padrão: a senha nunca aparece nos argumentos de processos (ps) nem em logs.
  hash="$(printf '%s\n' "$proxy" | docker run -i --rm caddy:2.10-alpine caddy hash-password)"
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
  need_portao
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
# Senha do proxy em texto (só para testes internos; NUNCA impressa). Secret Manager ou, em teste
# local, o arquivo CENARIO_PROXY_SENHA_ARQ.
senha_proxy() {
  if [[ -n "${CENARIO_PROXY_SENHA_ARQ:-}" ]]; then cat "$CENARIO_PROXY_SENHA_ARQ"
  else gcloud secrets versions access latest --secret=homolog-proxy-password --project="$PROJECT"; fi
}

# Percorre o fluxo do navegador sem nunca imprimir segredos:
#   sem credencial → 401 · senha do proxy → Set-Cookie do proxy · com esse cookie → /entrar.
# Imprime linhas "✔ …"/"✘ …". Uso: fluxo_navegador <base> <opções do curl…>
fluxo_navegador() {
  local base="$1"; shift
  local res=("$@") d r cod senha usuario="${HOMOLOG_BASIC_USER:-$BASIC_USER}"
  d="$(mktemp -d)"; chmod 700 "$d"
  senha="$(senha_proxy 2>/dev/null)" || senha=""
  if [[ -z "$senha" ]]; then echo "✘ senha do proxy não lida (Secret Manager)"; rm -rf "$d"; return 0; fi
  senha="${senha//\\/\\\\}"; senha="${senha//\"/\\\"}"
  printf 'user = "%s:%s"\n' "$usuario" "$senha" > "$d/cred"; senha=""
  r="$(curl -s -o /dev/null -D "$d/h0" -w '%{http_code}' "${res[@]}" "$base/" || true)"
  if [[ "$r" == 401 ]] && grep -qi '^www-authenticate: basic' "$d/h0"; then echo "✔ sem credencial: 401 com pedido de senha (Basic)"
  else echo "✘ sem credencial respondeu $r (esperado 401 + WWW-Authenticate)"; fi
  if grep -qi '^alt-svc:.*h3' "$d/h0"; then echo "✘ o proxy anuncia HTTP/3 (Alt-Svc h3), mas UDP 443 não está publicado nem liberado"
  else echo "✔ sem anúncio de HTTP/3 (só TCP)"; fi
  cod="$(curl -s -o /dev/null -D "$d/h1" -c "$d/jar" -K "$d/cred" -w '%{http_code}' "${res[@]}" "$base/" || true)"
  if [[ "$cod" =~ ^(200|30[1278])$ ]] && grep -qi '^set-cookie: cenario_homolog=' "$d/h1"; then
    echo "✔ senha do proxy ($usuario) aceita: $cod e cookie do proxy gravado"
  else echo "✘ senha do proxy ($usuario) recusada ou sem cookie: HTTP $cod — o hash no Caddy não corresponde ao segredo atual (rode: vm.sh gerar-env && vm.sh iniciar)"; fi
  rm -f "$d/cred"
  r="$(curl -s -L -b "$d/jar" -o "$d/pag" -w '%{http_code} %{url_effective}' "${res[@]}" "$base/entrar" || true)"
  if [[ "$r" == "200 "* ]] && grep -q 'Entrar' "$d/pag" && grep -q '/_next/static/' "$d/pag"; then echo "✔ com o cookie do proxy: /entrar 200 (tela de entrada do sistema)"
  else echo "✘ com o cookie do proxy: /entrar respondeu ${r%% *}"; fi
  local js; js="$(grep -o '/_next/static/[^"]*\.js' "$d/pag" | head -1)"
  if [[ -n "$js" ]]; then
    r="$(curl -s -b "$d/jar" -o /dev/null -w '%{http_code}' "${res[@]}" "$base$js" || true)"
    if [[ "$r" == 200 ]]; then echo "✔ JavaScript da tela carrega com o cookie ($js: 200)"; else echo "✘ JavaScript da tela: $r"; fi
  fi
  rm -rf "$d"
}

# Diagnóstico de acesso (SÓ LEITURA, nada é reiniciado e nenhum segredo é impresso):
# configuração, segredo do proxy × hash em uso, fluxo do navegador e as últimas tentativas
# registradas pelo Caddy (status, se o navegador enviou senha/cookie, navegador).
diagnosticar_acesso() {
  need_env
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  local horas="${1:-24}" base="https://$HOMOLOG_DOMAIN" res=(--resolve "$HOMOLOG_DOMAIN:443:127.0.0.1")
  [[ -n "${CENARIO_CACERT:-}" ]] && res+=(--cacert "$CENARIO_CACERT")
  echo "== Configuração"
  echo "• domínio: $HOMOLOG_DOMAIN · usuário do proxy: $HOMOLOG_BASIC_USER (minúsculo, sem acento)"
  local s; s="$(senha_proxy 2>/dev/null)" || s=""
  if [[ -n "$s" ]]; then
    local extras=""
    [[ "$s" =~ [[:space:]] ]] && extras+=" espaço/quebra de linha;"
    [[ "$s" == *$'\r'* ]] && extras+=" retorno de carro (\\r);"
    if (LC_ALL=C; [[ "$s" =~ [^\ -~] ]]); then extras+=" caracteres fora do ASCII;"; fi
    echo "• segredo homolog-proxy-password: ${#s} caracteres;${extras:- só caracteres imprimíveis comuns}"
  else echo "✘ segredo homolog-proxy-password não lido"; fi
  s=""
  echo "• /run/cenario/env gerado em: $(date -u -r "$ENV_FILE" +%FT%TZ) (o hash da senha do proxy é calculado nesse momento)"
  echo "== Fluxo do navegador (de dentro da VM)"
  fluxo_navegador "$base" "${res[@]}"
  echo "== Tentativas registradas pelo Caddy nas últimas ${horas} h"
  local id; id="$(compose ps -q caddy 2>/dev/null || true)"
  [[ -n "$id" ]] || { echo "✘ contêiner caddy não encontrado"; return 0; }
  docker logs --since "${horas}h" "$id" 2>&1 | grep '"http.log.access' | resumir_acessos
}

# Lê linhas de log de acesso do Caddy (JSON) e resume, sem valores de cabeçalhos (o Caddy já
# registra Authorization e Cookie como REDACTED; aqui só se mostra se foram enviados).
resumir_acessos() {
  local l st uri met ua nav auth ck uid ts n=0 fora=0 safari401a=0 safari401s=0 safariok=0 ultimas=()
  while IFS= read -r l; do
    [[ "$l" =~ \"status\":([0-9]+) ]] && st="${BASH_REMATCH[1]}" || continue
    [[ "$l" =~ \"uri\":\"([^\"]*)\" ]] && uri="${BASH_REMATCH[1]}" || uri="?"
    [[ "$l" =~ \"method\":\"([A-Z]+)\" ]] && met="${BASH_REMATCH[1]}" || met="?"
    [[ "$l" =~ \"User-Agent\":\[\"([^\"]*)\" ]] && ua="${BASH_REMATCH[1]}" || ua=""
    [[ "$l" =~ \"user_id\":\"([^\"]*)\" ]] && uid="${BASH_REMATCH[1]}" || uid=""
    [[ "$l" =~ \"ts\":([0-9]+) ]] && ts="$(date -u -d "@${BASH_REMATCH[1]}" +%m-%dT%H:%M:%S)" || ts="?"
    [[ "$l" == *'"Authorization":["REDACTED"]'* ]] && auth=senha || auth=-
    [[ "$l" == *'"Cookie":["REDACTED"]'* ]] && ck=cookie || ck=-
    case "$ua" in
      *curl*) fora=$((fora + 1)); continue ;; # testes internos (saude/diagnóstico)
      *CriOS*|*FxiOS*|*EdgiOS*|*Chrome*|*Android*) nav=outro ;;
      *Safari*|*iPhone*|*iPad*|*Macintosh*) nav=Safari ;;
      *) nav=outro ;;
    esac
    n=$((n + 1))
    if [[ "$nav" == Safari ]]; then
      if [[ "$st" == 401 && "$auth" == senha ]]; then safari401a=$((safari401a + 1))
      elif [[ "$st" == 401 ]]; then safari401s=$((safari401s + 1))
      elif [[ "$st" =~ ^[23] ]]; then safariok=$((safariok + 1)); fi
    fi
    ultimas+=("$ts $st $met ${uri:0:60} · $auth · $ck · ${uid:-} · $nav")
  done
  echo "• $n requisições de navegadores (+ $fora de testes internos)"
  echo "• Safari: $safariok aceitas · $safari401a recusadas COM senha enviada · $safari401s pedidos de senha (sem credencial)"
  echo "• últimas (hora UTC · status · método · caminho · senha enviada? · cookie? · usuário aceito · navegador):"
  local i ini=$(( ${#ultimas[@]} > 25 ? ${#ultimas[@]} - 25 : 0 ))
  for (( i = ini; i < ${#ultimas[@]}; i++ )); do echo "    ${ultimas[$i]}"; done
  echo "== Leitura"
  if (( n == 0 )); then echo "• nenhum acesso de navegador chegou ao Caddy no período (DNS, rede ou HTTP/3 no aparelho)"
  elif (( safari401a > 0 && safariok == 0 )); then echo "• o Safari ENVIOU usuário/senha e o proxy RECUSOU: credencial do proxy errada (usuário 'homologacao' + senha do proxy, não a do gestor) ou hash desatualizado"
  elif (( safariok > 0 )); then echo "• o Safari passou pelo proxy; se a tela não abriu, veja os status != 2xx/3xx acima"
  else echo "• o Safari só recebeu pedidos de senha (diálogo cancelado ou sem resposta)"; fi
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
  local base="https://$HOMOLOG_DOMAIN" res=(--resolve "$HOMOLOG_DOMAIN:443:127.0.0.1")
  # Cookie de acesso num arquivo temporário (600), não nos argumentos do curl.
  local hdr; hdr="$(mktemp)"; chmod 600 "$hdr"
  printf 'Cookie: cenario_homolog=%s\n' "$HOMOLOG_GATE_TOKEN" > "$hdr"
  trap 'rm -f "$hdr"' RETURN
  [[ -n "${CENARIO_CACERT:-}" ]] && res+=(--cacert "$CENARIO_CACERT")
  r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "$base/painel" || true)"
  [[ "$r" == 401 ]] && ok "proxy exige autenticação (sem credencial: $r)" || ruim "proxy sem credencial respondeu $r (esperado 401)"
  r="$(curl -s "${res[@]}" -H "@$hdr" "$base/api/ready" || true)"
  [[ "$r" == *ready* ]] && ok "HTTPS + API + banco: $r" || ruim "API não pronta: $r"
  r="$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" -H "@$hdr" "$base/entrar" || true)"
  [[ "$r" == 200 ]] && ok "web (tela de entrada): $r" || ruim "web respondeu $r"
  # O caminho REAL do navegador: senha do proxy → cookie → /entrar (o teste acima entra direto
  # com o cookie e não comprova que a senha do proxy funciona).
  local linha; while IFS= read -r linha; do
    case "$linha" in "✔ "*) ok "${linha#✔ }" ;; "✘ "*) ruim "${linha#✘ }" ;; *) echo "$linha" ;; esac
  done < <(fluxo_navegador "$base" "${res[@]}")
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
  if ! docker run --rm -v "$DIR/infra/homolog/Caddyfile.homolog:/etc/caddy/Caddyfile:ro" \
    -e HOMOLOG_DOMAIN -e HOMOLOG_BASIC_USER -e HOMOLOG_BASIC_HASH -e HOMOLOG_GATE_TOKEN \
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
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local vol="${CENARIO_BACKUPS_DIR:-}"
  [[ -n "$vol" ]] || vol="$(docker volume inspect -f '{{.Mountpoint}}' cenario-homolog_backups 2>/dev/null || true)"
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
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  cat > "$tmp/env" <<'FICTICIO'
HOMOLOG_DOMAIN='teste.exemplo.invalid'
POSTGRES_PASSWORD='ficticio'
TOKEN_HASH_SECRET='ficticio-ficticio-ficticio-ficticio'
HOMOLOG_BASIC_USER='homologacao'
HOMOLOG_BASIC_HASH='$2a$14$ficticio'
HOMOLOG_GATE_TOKEN='0000000000000000000000000000000000000000000000000000000000000000'
CENARIO_API_IMAGE='imagem-ficticia/api:0'
CENARIO_WEB_IMAGE='imagem-ficticia/web:0'
FICTICIO
  if docker compose -f "$COMPOSE_FILE" --env-file "$tmp/env" config -q 2>"$tmp/erro"; then
    ok "docker-compose.homolog.yml válido (valores fictícios; nada iniciado)"
    local pub
    pub="$(docker compose -f "$COMPOSE_FILE" --env-file "$tmp/env" config --format json 2>/dev/null \
      | grep -o '"published": *"*[0-9]*' | tr -dc '0-9\n' | sort -n | xargs || true)"
    [[ "$pub" == "80 443" ]] && ok "portas publicadas pelo Compose: só 80 e 443 (caddy); PostgreSQL, API e web sem porta" \
      || ruim "portas publicadas no Compose: ${pub:-?} (esperado 80 443)"
  else ruim "docker-compose.homolog.yml inválido: $(head -3 "$tmp/erro")"; fi
  [[ -f "$DIR/scripts/backup.sh" && -f "$DIR/scripts/restore.sh" ]] && ok "scripts de backup/restauração presentes" || ruim "scripts de backup ausentes em $DIR/scripts"
  if command -v gcloud >/dev/null 2>&1; then
    local s
    for s in homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token; do
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
  verificar-preparo) verificar_preparo ;;
  gerar-env) gerar_env ;;
  iniciar) iniciar ;;
  status) status ;;
  saude) saude ;;
  diagnosticar-acesso) diagnosticar_acesso "${2:-24}" ;;
  aplicar-config) aplicar_config ;;
  resumir-acessos) resumir_acessos ;; # lê o log de acesso do Caddy da entrada padrão (usado nos testes)
  semear) semear ;;
  backup) backup ;;
  enviar-backups) enviar_backups ;;
  restaurar-teste) restaurar_teste "${2:-}" ;;
  restaurar) restaurar "${2:-}" "${3:-}" ;;
  atualizar) atualizar "${2:-}" ;;
  parar) parar ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
