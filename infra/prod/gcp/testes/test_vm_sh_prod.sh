#!/usr/bin/env bash
# Testes LOCAIS do vm.sh e do startup.sh de PRODUÇÃO, sem Google Cloud e sem iniciar nada:
#   A. envio de backups ao bucket só-criação (o mesmo comportamento homologado, volume cenario-prod);
#   B. portão fechado: gerar-env, iniciar e iniciar-banco recusam sem chamar docker nem Secret Manager;
#   C. gerar-env: lê SÓ os segredos prod-* (nunca homolog-*), grava o ambiente 600 sem camada de senha do
#      proxy, com domínio canônico + www, gestor e imagens de produção pela etiqueta; recusa etiqueta inválida;
#   D. verificar-preparo: Compose de produção válido, só 80/443, segredos prod-* (sem exibir valor), bucket;
#   E. startup.sh: serviço cenario-prod (portão), caminho infra/prod, nada iniciado sem autorização.
# Executar: bash infra/prod/gcp/testes/test_vm_sh_prod.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
VMSH="$RAIZ/infra/prod/gcp/vm.sh"
TMP="$(mktemp -d)"
trap 'kill "${PID_SRV:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
FALHAS=0
afirma() { if grep -qF -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qF -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
igual() { if [[ "$1" == "$2" ]]; then echo "  ✔ $3: $1"; else echo "  ✘ $3: '$1' (esperado '$2')"; FALHAS=$((FALHAS + 1)); fi; }

mkdir -p "$TMP/objetos" "$TMP/bin" "$TMP/backups" "$TMP/estado"
echo ok > "$TMP/modo"
python3 "$RAIZ/infra/homolog/gcp/testes/gcp_vm_falso.py" "$TMP/objetos" "$TMP/modo" > "$TMP/url" &
PID_SRV=$!
for _ in $(seq 1 50); do [[ -s "$TMP/url" ]] && break; sleep 0.1; done
URL="$(head -1 "$TMP/url")"
cat > "$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$CHAMADAS"
case "$1 ${2:-}" in
  "ps "*|"ps") exit 0 ;;
  "compose "*) for a in "$@"; do [[ "$a" == config || "$a" == version ]] && exec "$DOCKER_REAL" "$@"; done; exit 0 ;;
  "--version "*) exec "$DOCKER_REAL" --version ;;
  *) exit 0 ;;
esac
EOF
cat > "$TMP/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
echo "gcloud $*" >> "$CHAMADAS"
[[ "$*" == *"secrets versions access latest --secret=prod-"* ]] && echo "VALOR-SECRETO-$(echo "$*" | sed 's/.*--secret=\([a-z-]*\).*/\1/')"
exit 0
EOF
printf '#!/usr/bin/env bash\necho 2147479552\n' > "$TMP/bin/swapon"
printf '#!/usr/bin/env bash\necho "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"\n' > "$TMP/bin/ss"
chmod +x "$TMP/bin/"*
export DOCKER_REAL; DOCKER_REAL="$(command -v docker)"
export PATH="$TMP/bin:$PATH" CHAMADAS="$TMP/chamadas.log"
export CENARIO_DIR="$RAIZ" CENARIO_META_URL="$URL/computeMetadata/v1" CENARIO_GCS_URL="$URL"
export CENARIO_BUCKET=gs://cenariogestao-prod-backups CENARIO_PROJECT=cenariogestao CENARIO_DOMAIN=cenariogestao.com.br
export CENARIO_DOMAIN_WWW=www.cenariogestao.com.br CENARIO_ADMIN_EMAIL=gestor@exemplo.com CENARIO_ADMIN_NAME='Gestor Exemplo'
export CENARIO_STATE_DIR="$TMP/estado" CENARIO_BACKUPS_DIR="$TMP/backups" CENARIO_PORTAO="$TMP/portao"
export CENARIO_ENV_FILE="$TMP/run/env" CENARIO_TAG=9fb1786beddae28c34b20a0922b42989ecb0fbf2
roda() { local out="$1"; shift; : > "$CHAMADAS"; set +e; bash "$VMSH" "$@" > "$out" 2>&1; echo $? > "$out.rc"; set -e; }

echo "A. envio de backups (só criação)"
mkdir -p "$TMP/backups/cenario-production-20261020T030000Z"; echo d > "$TMP/backups/cenario-production-20261020T030000Z/database.dump"
( cd "$TMP/backups/cenario-production-20261020T030000Z" && sha256sum ./* > SHA256SUMS )
roda "$TMP/a.out" enviar-backups
afirma "$TMP/a.out" "✔ cenario-production-20261020T030000Z enviado a gs://cenariogestao-prod-backups/backups/"
afirma "$TMP/objetos/_requisicoes.log" "ifGenerationMatch=0"
nega "$TMP/a.out" "tok-vm-falso"

echo "B. portão fechado"
for c in gerar-env iniciar iniciar-banco; do
  roda "$TMP/b-$c.out" "$c"
  igual "$(cat "$TMP/b-$c.out.rc")" 3 "código de saída de $c"
  igual "$(wc -c < "$CHAMADAS" | xargs)" 0 "chamadas a docker/gcloud em $c"
done

echo "C. gerar-env (portão aberto)"
touch "$TMP/portao"
roda "$TMP/c.out" gerar-env
igual "$(cat "$TMP/c.out.rc")" 0 "código de saída"
for s in prod-postgres-password prod-token-hash-secret prod-admin-password; do afirma "$CHAMADAS" "--secret=$s"; done
nega "$CHAMADAS" "homolog"
igual "$(stat -c %a "$TMP/run/env")" 600 "permissão do ambiente"
afirma "$TMP/run/env" "PROD_DOMAIN='cenariogestao.com.br'"
afirma "$TMP/run/env" "PROD_DOMAIN_WWW='www.cenariogestao.com.br'"
afirma "$TMP/run/env" "SEED_ADMIN_EMAIL='gestor@exemplo.com'"
afirma "$TMP/run/env" "SEED_ADMIN_NAME='Gestor Exemplo'"
afirma "$TMP/run/env" "SEED_ADMIN_PASSWORD='VALOR-SECRETO-prod-admin-password'"
afirma "$TMP/run/env" "CENARIO_API_IMAGE='southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod/api:9fb1786beddae28c34b20a0922b42989ecb0fbf2'"
afirma "$TMP/run/env" "CENARIO_WEB_IMAGE='southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod/web:9fb1786beddae28c34b20a0922b42989ecb0fbf2'"
nega "$TMP/run/env" "HOMOLOG"
nega "$TMP/run/env" "BASIC"
nega "$TMP/c.out" "VALOR-SECRETO"
CENARIO_TAG=latest roda "$TMP/c2.out" gerar-env
igual "$(cat "$TMP/c2.out.rc")" 2 "etiqueta 'latest' recusada"
CENARIO_TAG= roda "$TMP/c3.out" gerar-env
igual "$(cat "$TMP/c3.out.rc")" 2 "etiqueta ausente recusada"
rm -f "$TMP/portao"

echo "D. verificar-preparo"
roda "$TMP/d.out" verificar-preparo
afirma "$TMP/d.out" "✔ docker-compose.prod.yml válido (valores fictícios; nada iniciado)"
afirma "$TMP/d.out" "✔ portas publicadas pelo Compose: só 80 e 443"
afirma "$TMP/d.out" "✔ segredo prod-admin-password: acessível pela conta da VM (valor não exibido)"
afirma "$TMP/d.out" "✔ bucket: leitura negada (HTTP 403)"
nega "$TMP/d.out" "homolog-"
nega "$TMP/d.out" "VALOR-SECRETO"

echo "E. startup.sh com raiz falsa"
R="$TMP/raiz"; mkdir -p "$R/etc/systemd/system" "$R/etc/apt/apt.conf.d" "$R/etc/sysctl.d" "$R/opt"
SB="$TMP/bin-startup"; mkdir -p "$SB"
for c in systemctl apt-get fallocate mkswap sysctl; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$CHAMADAS"\n' "$c" > "$SB/$c"; done
printf '#!/usr/bin/env bash\ncat > /dev/null\n' > "$SB/logger"; printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/dpkg"
printf 'case "$*" in "--version") echo "Docker version 29.9.0, build x" ;; "compose version --short") echo 5.6.0 ;; *) exit 0 ;; esac\n' > "$SB/docker"
printf 'echo "swapon $*" >> "$CHAMADAS"; [[ "$*" == *--show* ]] && echo "/swapfile file 2G 0B -2"; exit 0\n' > "$SB/swapon"
chmod +x "$SB/"*
echo "UUID=x / ext4 defaults 0 1" > "$R/etc/fstab"
: > "$CHAMADAS"; env PATH="$SB:$PATH" CENARIO_RAIZ="$R" bash "$RAIZ/infra/prod/gcp/startup.sh" > "$TMP/e.out" 2>&1
afirma "$R/etc/systemd/system/cenario-prod.service" "ConditionPathExists=/etc/cenario/publicacao-autorizada"
afirma "$R/etc/systemd/system/cenario-prod.service" "/opt/cenario/infra/prod/gcp/vm.sh gerar-env"
afirma "$R/etc/systemd/system/cenario-backup-upload.service" "/opt/cenario/infra/prod/gcp/vm.sh enviar-backups"
[[ ! -e "$R/etc/systemd/system/cenario-homolog.service" ]] && echo "  ✔ nenhum serviço de homologação" || { echo "  ✘ serviço de homologação criado"; FALHAS=$((FALHAS + 1)); }
afirma "$TMP/e.out" "publicação NÃO autorizada"
nega "$CHAMADAS" "restart cenario-prod"

echo
if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
