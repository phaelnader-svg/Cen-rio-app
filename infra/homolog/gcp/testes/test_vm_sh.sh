#!/usr/bin/env bash
# Testes LOCAIS do lado da VM, sem Google Cloud e sem iniciar nada:
#   A. vm.sh enviar-backups contra um Cloud Storage FALSO em que a conta só CRIA objetos:
#      envia os novos, não reenvia, trata 412 como "já enviado", não registra 403, recusa
#      checksum inválido, nunca expõe o token;
#   B. portão de publicação: gerar-env e iniciar recusam sem /etc/cenario/publicacao-autorizada
#      (nem docker nem Secret Manager são chamados);
#   C. vm.sh verificar-preparo: Compose válido com valores fictícios, só 80/443 publicadas,
#      segredos conferidos sem exibir valor, bucket grava e nega regravar/ler/listar/apagar;
#   D. startup.sh (com CENARIO_RAIZ e comandos falsos): mantém a swap existente, cria só sem
#      nenhuma swap, serviços com o portão, nada iniciado sem autorização, idempotente.
# Executar: bash infra/homolog/gcp/testes/test_vm_sh.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
VMSH="$RAIZ/infra/homolog/gcp/vm.sh"
TMP="$(mktemp -d)"
trap 'kill "${PID_SRV:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
FALHAS=0
afirma() { if grep -qF -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qF -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
igual() { if [[ "$1" == "$2" ]]; then echo "  ✔ $3: $1"; else echo "  ✘ $3: '$1' (esperado '$2')"; FALHAS=$((FALHAS + 1)); fi; }

mkdir -p "$TMP/objetos" "$TMP/bin" "$TMP/backups" "$TMP/estado"
echo ok > "$TMP/modo"
python3 "$AQUI/gcp_vm_falso.py" "$TMP/objetos" "$TMP/modo" > "$TMP/url" &
PID_SRV=$!
for _ in $(seq 1 50); do [[ -s "$TMP/url" ]] && break; sleep 0.1; done
URL="$(head -1 "$TMP/url")"

# Comandos falsos (registram as chamadas). docker: "compose … config/version" usa o Docker real.
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
[[ "$*" == *"secrets versions access"* ]] && echo "VALOR-SECRETO-FALSO"
exit 0
EOF
printf '#!/usr/bin/env bash\necho 2147479552\n' > "$TMP/bin/swapon" # resposta de --show=SIZE --noheadings --bytes
printf '#!/usr/bin/env bash\necho "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"\necho "LISTEN 0 128 127.0.0.1:5000 0.0.0.0:*"\n' > "$TMP/bin/ss"
chmod +x "$TMP/bin/"*
export DOCKER_REAL; DOCKER_REAL="$(command -v docker)"
export PATH="$TMP/bin:$PATH" CHAMADAS="$TMP/chamadas.log"
export CENARIO_DIR="$RAIZ" CENARIO_META_URL="$URL/computeMetadata/v1" CENARIO_GCS_URL="$URL"
export CENARIO_BUCKET=gs://bucket-teste CENARIO_PROJECT=projeto-teste CENARIO_DOMAIN=teste.exemplo.invalid
export CENARIO_STATE_DIR="$TMP/estado" CENARIO_BACKUPS_DIR="$TMP/backups" CENARIO_PORTAO="$TMP/portao"
export CENARIO_ENV_FILE="$TMP/env-inexistente"

novo_backup() { # novo_backup <nome> [corromper]
  mkdir -p "$TMP/backups/$1"; echo "dump fictício $1" > "$TMP/backups/$1/db.dump"
  ( cd "$TMP/backups/$1" && sha256sum ./* > SHA256SUMS )
  [[ "${2:-}" == corromper ]] && echo "alterado" >> "$TMP/backups/$1/db.dump"
  return 0
}
roda() { local out="$1"; shift; : > "$CHAMADAS"; set +e; bash "$VMSH" "$@" > "$out" 2>&1; echo $? > "$out.rc"; set -e; }
n_objetos() { find "$TMP/objetos" -name 'backups__*' | wc -l | xargs; }

echo "A1. dois backups novos e um com checksum inválido"
novo_backup cenario-homolog-20261001T030000Z; novo_backup cenario-homolog-20261002T030000Z
novo_backup cenario-homolog-20261003T030000Z corromper
roda "$TMP/a1.out" enviar-backups
afirma "$TMP/a1.out" "✔ cenario-homolog-20261001T030000Z enviado a gs://bucket-teste/backups/"
afirma "$TMP/a1.out" "✔ cenario-homolog-20261002T030000Z enviado"
afirma "$TMP/a1.out" "✘ cenario-homolog-20261003T030000Z com checksum inválido: não enviado"
igual "$(cat "$TMP/a1.out.rc")" 1 "código de saída (há um erro)"
igual "$(n_objetos)" 2 "objetos no bucket"
igual "$(wc -l < "$TMP/estado/enviados" | xargs)" 2 "registrados como enviados"
afirma "$TMP/objetos/_requisicoes.log" "ifGenerationMatch=0"
nega "$TMP/a1.out" "tok-vm-falso"
nega "$CHAMADAS" "tok-vm-falso"
nega "$CHAMADAS" "gcloud storage"

echo "A2. nova execução: nada é reenviado"
rm -rf "$TMP/backups/cenario-homolog-20261003T030000Z"
: > "$TMP/objetos/_requisicoes.log"
roda "$TMP/a2.out" enviar-backups
igual "$(cat "$TMP/a2.out.rc")" 0 "código de saída"
igual "$(grep -c '^POST' "$TMP/objetos/_requisicoes.log" || true)" 0 "envios repetidos"

echo "A3. registro local perdido: o bucket responde 412 e os backups contam como enviados"
rm -f "$TMP/estado/enviados"
roda "$TMP/a3.out" enviar-backups
afirma "$TMP/a3.out" "já estava no bucket (HTTP 412): registrado como enviado"
igual "$(cat "$TMP/a3.out.rc")" 0 "código de saída"
igual "$(n_objetos)" 2 "objetos no bucket (nada sobrescrito)"

echo "A4. permissão negada (403): não registra e termina com erro"
echo proibido > "$TMP/modo"; novo_backup cenario-homolog-20261004T030000Z
roda "$TMP/a4.out" enviar-backups
afirma "$TMP/a4.out" "✘ cenario-homolog-20261004T030000Z NÃO enviado (HTTP 403)"
igual "$(cat "$TMP/a4.out.rc")" 1 "código de saída"
nega "$TMP/estado/enviados" "cenario-homolog-20261004T030000Z"
echo "A5. permissão restabelecida: o pendente é enviado no dia seguinte"
echo ok > "$TMP/modo"
roda "$TMP/a5.out" enviar-backups
afirma "$TMP/a5.out" "✔ cenario-homolog-20261004T030000Z enviado"
igual "$(n_objetos)" 3 "objetos no bucket"

echo "B. portão fechado: gerar-env e iniciar recusam sem chamar docker nem Secret Manager"
for c in gerar-env iniciar; do
  roda "$TMP/b-$c.out" "$c"
  afirma "$TMP/b-$c.out" "Publicação NÃO autorizada"
  igual "$(cat "$TMP/b-$c.out.rc")" 3 "código de saída de $c"
  igual "$(wc -c < "$CHAMADAS" | xargs)" 0 "chamadas a docker/gcloud em $c"
done

echo "C1. verificar-preparo com o portão fechado"
roda "$TMP/c1.out" verificar-preparo
afirma "$TMP/c1.out" "✔ portão de publicação fechado"
afirma "$TMP/c1.out" "✔ nenhum contêiner em execução"
afirma "$TMP/c1.out" "✔ swap ativa: 2047 MB"
afirma "$TMP/c1.out" "✔ portas escutando fora do loopback: 22"
afirma "$TMP/c1.out" "✔ docker-compose.homolog.yml válido (valores fictícios; nada iniciado)"
afirma "$TMP/c1.out" "✔ portas publicadas pelo Compose: só 80 e 443"
afirma "$TMP/c1.out" "✔ segredo homolog-gate-token: acessível pela conta da VM (valor não exibido)"
afirma "$TMP/c1.out" "✔ bucket: gravação permitida (HTTP 200"
afirma "$TMP/c1.out" "✔ bucket: regravação do mesmo nome recusada (HTTP 412)"
afirma "$TMP/c1.out" "✔ bucket: leitura negada (HTTP 403)"
afirma "$TMP/c1.out" "✔ bucket: listagem negada (HTTP 403)"
afirma "$TMP/c1.out" "✔ bucket: exclusão negada (HTTP 403)"
nega "$TMP/c1.out" "VALOR-SECRETO-FALSO"
nega "$TMP/c1.out" "tok-vm-falso"
nega "$CHAMADAS" "compose up"
nega "$CHAMADAS" " run "
echo "C2. verificar-preparo acusa o portão aberto"
touch "$TMP/portao"
roda "$TMP/c2.out" verificar-preparo
afirma "$TMP/c2.out" "✘ portão de publicação ABERTO"
igual "$(cat "$TMP/c2.out.rc")" 1 "código de saída"
rm -f "$TMP/portao"

echo "D. startup.sh com raiz falsa"
R="$TMP/raiz"; mkdir -p "$R/etc/systemd/system" "$R/etc/apt/apt.conf.d" "$R/etc/sysctl.d" "$R/opt"
SB="$TMP/bin-startup"; mkdir -p "$SB"
for c in systemctl apt-get fallocate mkswap sysctl; do printf '#!/usr/bin/env bash\necho "%s $*" >> "$CHAMADAS"\n' "$c" > "$SB/$c"; done
printf '#!/usr/bin/env bash\ncat > /dev/null\n' > "$SB/logger"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SB/dpkg"
cat > "$SB/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in "--version") echo "Docker version 29.9.0, build x" ;; "compose version --short") echo 5.6.0 ;; *) exit 0 ;; esac
EOF
cat > "$SB/swapon" <<'EOF'
#!/usr/bin/env bash
echo "swapon $*" >> "$CHAMADAS"
[[ "$*" == *--show* && "${FALSO_SWAP:-1}" == 1 ]] && echo "/swapfile file 2G 0B -2"
exit 0
EOF
chmod +x "$SB/"*
rodaS() { local out="$1"; shift; : > "$CHAMADAS"; set +e; env "$@" PATH="$SB:$PATH" CENARIO_RAIZ="$R" bash "$RAIZ/infra/homolog/gcp/startup.sh" > "$out" 2>&1; echo $? > "$out.rc"; set -e; }

echo "D1. swap já ativa e portão fechado"
echo "UUID=x / ext4 defaults 0 1" > "$R/etc/fstab"
rodaS "$TMP/d1.out" FALSO_SWAP=1
igual "$(cat "$TMP/d1.out.rc")" 0 "código de saída"
afirma "$TMP/d1.out" "swap já ativa"
afirma "$TMP/d1.out" "já instalados: mantidos"
nega "$CHAMADAS" "fallocate"
nega "$CHAMADAS" "apt-get"
afirma "$R/etc/systemd/system/cenario-homolog.service" "ConditionPathExists=/etc/cenario/publicacao-autorizada"
afirma "$R/etc/systemd/system/cenario-backup-upload.service" "ConditionPathExists=/etc/cenario/publicacao-autorizada"
afirma "$TMP/d1.out" "publicação NÃO autorizada"
nega "$CHAMADAS" "restart cenario-homolog"
nega "$CHAMADAS" "start cenario-homolog"
afirma "$R/etc/apt/apt.conf.d/20auto-upgrades" 'Unattended-Upgrade "1"'
[[ ! -e "$R/etc/cenario/publicacao-autorizada" ]] && echo "  ✔ portão continua fechado" || { echo "  ✘ portão criado"; FALHAS=$((FALHAS + 1)); }

echo "D2. swap declarada no fstab mas inativa → só ativa (não cria outra)"
echo "/swap.img none swap sw 0 0" >> "$R/etc/fstab"
rodaS "$TMP/d2.out" FALSO_SWAP=0
afirma "$CHAMADAS" "swapon -a"
nega "$CHAMADAS" "fallocate"

echo "D3. nenhuma swap → cria /swapfile uma única vez"
echo "UUID=x / ext4 defaults 0 1" > "$R/etc/fstab"
rodaS "$TMP/d3.out" FALSO_SWAP=0
afirma "$CHAMADAS" "fallocate -l 2G $R/swapfile"
igual "$(grep -c '^/swapfile none swap' "$R/etc/fstab")" 1 "linhas de swap no fstab"

echo "D4. repetido com swap ativa → idempotente (fstab sem duplicar)"
rodaS "$TMP/d4.out" FALSO_SWAP=1
igual "$(grep -c '^/swapfile none swap' "$R/etc/fstab")" 1 "linhas de swap no fstab"
nega "$CHAMADAS" "fallocate"

echo "D5. com o portão aberto (autorização dada) → reinicia o serviço"
mkdir -p "$R/opt/cenario/infra/homolog/gcp"; printf '#!/bin/sh\n' > "$R/opt/cenario/infra/homolog/gcp/vm.sh"; chmod +x "$R/opt/cenario/infra/homolog/gcp/vm.sh"
touch "$R/etc/cenario/publicacao-autorizada"
rodaS "$TMP/d5.out" FALSO_SWAP=1
afirma "$CHAMADAS" "systemctl restart cenario-homolog.service"

echo "E. diagnóstico de acesso: leitura do log do Caddy (linhas sintéticas, valores já REDACTED)"
L() { printf '{"level":"info","ts":%s,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","uri":"%s","headers":{"User-Agent":["%s"]%s}},"user_id":"%s","status":%s}\n' "$@"; }
SAF='Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
AUT=',"Authorization":["REDACTED"]'; CK=',"Cookie":["REDACTED"]'
{ L 1791566000 / "$SAF" "" "" 401; L 1791566001 / "$SAF" "$AUT" "" 401; L 1791566002 / "$SAF" "$AUT" "" 401; L 1791566003 /entrar "curl/8.5.0" "$CK" "" 200; } > "$TMP/log-recusa"
bash "$VMSH" resumir-acessos < "$TMP/log-recusa" > "$TMP/e1.out" 2>&1
afirma "$TMP/e1.out" "Safari: 0 aceitas · 2 recusadas COM senha enviada · 1 pedidos de senha"
afirma "$TMP/e1.out" "o Safari ENVIOU usuário/senha e o proxy RECUSOU"
afirma "$TMP/e1.out" "(+ 1 de testes internos)"
nega "$TMP/e1.out" "REDACTED"
{ L 1791566000 / "$SAF" "" "" 401; L 1791566001 / "$SAF" "$AUT" homologacao 307; L 1791566002 /entrar "$SAF" "$AUT$CK" "" 200; } > "$TMP/log-ok"
bash "$VMSH" resumir-acessos < "$TMP/log-ok" > "$TMP/e2.out" 2>&1
afirma "$TMP/e2.out" "Safari: 2 aceitas · 0 recusadas"
afirma "$TMP/e2.out" "o Safari passou pelo proxy"
: > "$TMP/log-vazio"; bash "$VMSH" resumir-acessos < "$TMP/log-vazio" > "$TMP/e3.out" 2>&1
afirma "$TMP/e3.out" "nenhum acesso de navegador chegou ao Caddy"

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
