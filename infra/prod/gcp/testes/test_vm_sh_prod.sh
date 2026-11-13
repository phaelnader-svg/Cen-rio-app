#!/usr/bin/env bash
# Testes LOCAIS do vm.sh e do startup.sh de PRODUÇÃO, sem Google Cloud e sem iniciar nada:
#   A. envio de backups ao bucket só-criação (o mesmo comportamento homologado, volume cenario-prod);
#   B. portão fechado: gerar-env, iniciar e iniciar-banco recusam sem chamar docker nem Secret Manager;
#   C. gerar-env: lê SÓ os segredos prod-* (nunca homolog-*), grava o ambiente 600 sem camada de senha do
#      proxy, com domínio canônico + www, gestor e imagens de produção pela etiqueta; recusa etiqueta inválida;
#   D. verificar-preparo: Compose de produção válido, só 80/443, segredos prod-* (sem exibir valor), bucket;
#   D2. verificar-preparo REPROVA LLMNR (5355), mDNS (5353, UDP) e serviço inesperado (8080), com o processo;
#   A2/A3. alerta da cópia externa (> 36 h): último envio e backups não enviados; modo aviso nas operações;
#   E. startup.sh: serviço cenario-prod (portão), envio de backups SEM portão, caminho infra/prod, nada iniciado;
#      LLMNR/mDNS desativados de forma persistente e idempotente (reinício do resolved só quando muda).
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
# ss falso: sem FALSO_SS, só o sshd em 22; com FALSO_SS=<arquivo>, as linhas "tcp|udp <colunas do ss>"
# do arquivo (-tulnH mantém a coluna Netid; -tlnH/-tlnpH só TCP, sem ela).
cat > "$TMP/bin/ss" <<'EOF2'
#!/usr/bin/env bash
if [[ -z "${FALSO_SS:-}" ]]; then echo "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"; exit 0; fi
case "$1" in -tulnH) cat "$FALSO_SS" ;; *) grep '^tcp ' "$FALSO_SS" | cut -d' ' -f2- ;; esac
EOF2
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
[[ ! -e "$TMP/portao" ]] && echo "  ✔ envio feito com o portão FECHADO" || { echo "  ✘ portão aberto no cenário A"; FALHAS=$((FALHAS + 1)); }
[[ -s "$TMP/estado/ultimo-envio" ]] && echo "  ✔ carimbo do último envio gravado" || { echo "  ✘ sem carimbo do último envio"; FALHAS=$((FALHAS + 1)); }

echo "A2. alerta da cópia externa (envio-externo, limite 36 h)"
roda "$TMP/a2a.out" envio-externo
igual "$(cat "$TMP/a2a.out.rc")" 0 "em dia logo após o envio"
afirma "$TMP/a2a.out" "✔ último envio ao bucket há 0 h"
afirma "$TMP/a2a.out" "✔ nenhum backup local sem cópia externa há mais de 36 h"
igual "$(wc -c < "$CHAMADAS" | xargs)" 0 "chamadas a docker/gcloud (só leitura local)"
echo $(( $(date -u +%s) - 40 * 3600 )) > "$TMP/estado/ultimo-envio"
roda "$TMP/a2b.out" envio-externo
igual "$(cat "$TMP/a2b.out.rc")" 1 "último envio há 40 h reprova"
afirma "$TMP/a2b.out" "✘ último envio ao bucket há 40 h (limite 36 h)"
VELHO="cenario-production-$(date -u -d '-3 days' +%Y%m%dT%H%M%SZ)"; NOVO="cenario-production-$(date -u -d '-1 hour' +%Y%m%dT%H%M%SZ)"
for n in "$VELHO" "$NOVO"; do mkdir -p "$TMP/backups/$n"; echo d > "$TMP/backups/$n/database.dump"; ( cd "$TMP/backups/$n" && sha256sum ./* > SHA256SUMS ); done
date -u +%s > "$TMP/estado/ultimo-envio"
roda "$TMP/a2c.out" envio-externo
igual "$(cat "$TMP/a2c.out.rc")" 1 "backup de 3 dias sem cópia externa reprova"
afirma "$TMP/a2c.out" "✘ 1 backup(s) local(is) sem cópia externa há mais de 36 h (mais antigo: $VELHO)"
nega "$TMP/a2c.out" "$NOVO"
rm -f "$TMP/estado/ultimo-envio"
roda "$TMP/a2d.out" envio-externo
afirma "$TMP/a2d.out" "✘ nenhum envio ao bucket registrado"
roda "$TMP/a2e.out" enviar-backups
afirma "$TMP/a2e.out" "✔ $VELHO enviado"
afirma "$TMP/a2e.out" "✔ $NOVO enviado"
roda "$TMP/a2f.out" envio-externo
igual "$(cat "$TMP/a2f.out.rc")" 0 "em dia depois de enviar os pendentes"
CENARIO_BUCKET= roda "$TMP/a2g.out" envio-externo
afirma "$TMP/a2g.out" "• envio externo desativado (sem cenario-bucket)"
echo $(( $(date -u +%s) - 40 * 3600 )) > "$TMP/estado/ultimo-envio"
echo ok > "$TMP/modo.salvo"; echo proibido > "$TMP/modo"
mkdir -p "$TMP/backups/cenario-production-20261021T030000Z"; echo e > "$TMP/backups/cenario-production-20261021T030000Z/database.dump"
( cd "$TMP/backups/cenario-production-20261021T030000Z" && sha256sum ./* > SHA256SUMS )
roda "$TMP/a2h.out" enviar-backups
igual "$(cat "$TMP/a2h.out.rc")" 1 "envio com erro sai com 1"
igual "$(( ( $(date -u +%s) - $(cat "$TMP/estado/ultimo-envio") ) / 3600 ))" 40 "carimbo NÃO atualizado quando o envio falha"
cp "$TMP/modo.salvo" "$TMP/modo"
roda "$TMP/a2i.out" enviar-backups
igual "$(cat "$TMP/a2i.out.rc")" 0 "reenvio depois da falha"
echo "A3. saúde: o alerta conta no smoke e só avisa nas operações internas"
igual "$(grep -c '^  CENARIO_ENVIO_SO_AVISO=1 saude$' "$VMSH")" 3 "ativar, aplicar-config e recuperar chamam a saúde em modo aviso"
igual "$(grep -c '^  saude$' "$VMSH")" 0 "nenhuma chamada interna à saúde estrita"
afirma "$VMSH" '"✘ "*) if [[ "${CENARIO_ENVIO_SO_AVISO:-0}" == 1 ]]'
afirma "$VMSH" "done < <(verificar_envio_externo || true)"

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
afirma "$TMP/d.out" "✔ portas escutando fora do loopback: 22"
afirma "$TMP/d.out" "✔ LLMNR/mDNS desativados"

echo "D2. verificar-preparo reprova escutas inesperadas"
SSHD='LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))'
printf 'tcp %s\ntcp LISTEN 0 4096 0.0.0.0:5355 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=12))\nudp UNCONN 0 0 0.0.0.0:5355 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=11))\n' "$SSHD" > "$TMP/ss-llmnr"
printf 'tcp %s\ntcp LISTEN 0 5 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=3,fd=4))\ntcp LISTEN 0 4096 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=20))\n' "$SSHD" > "$TMP/ss-8080"
printf 'tcp %s\nudp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:(("avahi-daemon",pid=4,fd=12))\n' "$SSHD" > "$TMP/ss-mdns"
printf 'tcp %s\nudp UNCONN 0 0 127.0.0.1:323 0.0.0.0:* users:(("chronyd",pid=5,fd=5))\n' "$SSHD" > "$TMP/ss-limpo"
FALSO_SS="$TMP/ss-llmnr" roda "$TMP/d2.out" verificar-preparo
igual "$(cat "$TMP/d2.out.rc")" 1 "LLMNR do systemd-resolved (código de saída)"
afirma "$TMP/d2.out" "✘ portas escutando fora do loopback: 22 5355 (esperado só 22)"
afirma "$TMP/d2.out" '· 0.0.0.0:5355 users:(("systemd-resolve"'
afirma "$TMP/d2.out" "✘ LLMNR/mDNS escutando: 0.0.0.0:5355"
FALSO_SS="$TMP/ss-8080" roda "$TMP/d3.out" verificar-preparo
igual "$(cat "$TMP/d3.out.rc")" 1 "serviço inesperado em 8080 (código de saída)"
afirma "$TMP/d3.out" "✘ portas escutando fora do loopback: 22 8080 (esperado só 22)"
afirma "$TMP/d3.out" '· 0.0.0.0:8080 users:(("python3"'
nega "$TMP/d3.out" "· 127.0.0.53:53"
FALSO_SS="$TMP/ss-mdns" roda "$TMP/d4.out" verificar-preparo
igual "$(cat "$TMP/d4.out.rc")" 1 "mDNS só em UDP (código de saída)"
afirma "$TMP/d4.out" "✔ portas escutando fora do loopback: 22"
afirma "$TMP/d4.out" "✘ LLMNR/mDNS escutando: 0.0.0.0:5353"
FALSO_SS="$TMP/ss-limpo" roda "$TMP/d5.out" verificar-preparo
afirma "$TMP/d5.out" "✔ LLMNR/mDNS desativados"
nega "$TMP/d5.out" "✘ portas"

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
nega "$R/etc/systemd/system/cenario-backup-upload.service" "ConditionPathExists=/etc/cenario/publicacao-autorizada"
afirma "$R/etc/systemd/system/cenario-backup-upload.service" "ConditionPathExists=/opt/cenario/infra/prod/gcp/vm.sh"
afirma "$R/etc/systemd/system/cenario-backup-upload.timer" "OnCalendar=*-*-* 07:30:00 UTC"
afirma "$CHAMADAS" "systemctl start cenario-backup-upload.timer"
[[ ! -e "$R/etc/systemd/system/cenario-homolog.service" ]] && echo "  ✔ nenhum serviço de homologação" || { echo "  ✘ serviço de homologação criado"; FALHAS=$((FALHAS + 1)); }
afirma "$TMP/e.out" "publicação NÃO autorizada"
nega "$CHAMADAS" "restart cenario-prod"
CONF="$R/etc/systemd/resolved.conf.d/90-cenario-sem-llmnr.conf"
afirma "$CONF" "LLMNR=no"
afirma "$CONF" "MulticastDNS=no"
igual "$(stat -c %a "$CONF")" 644 "permissão do drop-in do systemd-resolved"
afirma "$CHAMADAS" "systemctl restart systemd-resolved"
afirma "$TMP/e.out" "LLMNR e mDNS desativados"
echo "E2. startup.sh de novo (idempotente)"
: > "$CHAMADAS"; env PATH="$SB:$PATH" CENARIO_RAIZ="$R" bash "$RAIZ/infra/prod/gcp/startup.sh" > "$TMP/e2.out" 2>&1
afirma "$TMP/e2.out" "LLMNR e mDNS já desativados: mantido"
nega "$CHAMADAS" "restart systemd-resolved"
nega "$CHAMADAS" "restart cenario-prod"
igual "$(grep -c . "$CONF")" 4 "drop-in sem duplicação"

echo
if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
