#!/usr/bin/env bash
# Teste de integração do etapa1-infra.sh com "gcloud" e "curl" FALSOS (nenhum recurso externo é
# tocado) e o catálogo de preços falso local. Prova que o "criar":
#   A. sem estimativa oficial válida (catálogo fora do ar, sem consulta guardada) → bloqueia;
#   B. com o catálogo fora do ar, reutiliza a consulta oficial recente e chega à confirmação manual;
#   C. com estimativa acima do limite → bloqueia;
#   D. com consulta oficial normal → chega à confirmação manual (que continua obrigatória);
# e que, em nenhum caso, chama comandos que criam/alteram recursos.
# Executar: bash infra/homolog/gcp/testes/test_etapa1_bloqueio.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'kill "${PID_CAT:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# gcloud falso: responde às leituras e REGISTRA tudo; comandos que alteram algo só são anotados.
cat > "$TMP/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GCLOUD_LOG"
a="$*"
case "$a" in
  *"config get-value account"*) echo "teste@exemplo.com" ;;
  *"config get-value project"*) echo "cenariogestao" ;;
  *"projects describe cenariogestao"*projectNumber*) echo "123456" ;;
  *"projects describe cenariogestao"*lifecycleState*) echo "ACTIVE" ;;
  *"billing projects describe"*billingEnabled*) echo "True" ;;
  *"billing projects describe"*billingAccountName*) echo "billingAccounts/0000-TESTE" ;;
  *"billing budgets list"*) echo '[{"displayName":"Cenário","amount":{"specifiedAmount":{"units":"30","currencyCode":"USD"}},"budgetFilter":{"projects":["projects/123456"]},"thresholdRules":[{"thresholdPercent":0.5},{"thresholdPercent":0.9},{"thresholdPercent":1.0}]}]' ;;
  *"auth print-access-token"*) echo "tok-falso" ;;
  *"services list --enabled"*) printf '%s\n' compute.googleapis.com iam.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com ;;
  *"networks subnets describe"*) echo "10.142.0.0/20" ;;
  *"storage buckets describe"*) exit 1 ;;
  *"projects list"*) printf '%s\n' cenariogestao verificapro-exemplo ;;
  *" list "*|*" list") : ;;
  *) : ;;
esac
EOF
# curl falso: só o teste de permissões passa por ele (todas concedidas).
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$GCLOUD_LOG"
echo '{"permissions":["compute.instances.create","compute.addresses.create","compute.firewalls.create","compute.resourcePolicies.create","iam.serviceAccounts.create","resourcemanager.projects.setIamPolicy","secretmanager.secrets.create","secretmanager.secrets.setIamPolicy","storage.buckets.create","serviceusage.services.enable","iap.tunnelInstances.accessViaIAP"]}'
EOF
chmod +x "$TMP/bin/gcloud" "$TMP/bin/curl"

MODO="$TMP/modo"; echo ok > "$MODO"
python3 "$AQUI/catalogo_falso.py" ok 3 "$MODO" > "$TMP/url" &
PID_CAT=$!
for _ in $(seq 1 50); do [[ -s "$TMP/url" ]] && break; sleep 0.1; done
URL="$(head -1 "$TMP/url")"

export PATH="$TMP/bin:$PATH" GCLOUD_LOG="$TMP/gcloud.log"
export CENARIO_CATALOGO_URL="$URL" CENARIO_PRECOS_PERMITIR_TESTE=1
export CENARIO_PRECOS_TIMEOUT=1 CENARIO_PRECOS_TENTATIVAS=2 CENARIO_PRECOS_PRAZO=10

FALHAS=0
afirma() { if grep -qF -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qF -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
sem_alteracoes() {
  if grep -E ' (create|enable|add-iam-policy-binding|remove-iam-policy-binding|update|delete|ssh|add-resource-policies)( |$)' "$GCLOUD_LOG" | grep -v 'billing budgets list' >/dev/null; then
    echo "  ✘ houve comando que altera recursos:"; grep -E ' (create|enable|add-iam|update|delete|ssh)' "$GCLOUD_LOG" | sed 's/^/      /'
    FALHAS=$((FALHAS + 1))
  else echo "  ✔ nenhum comando que cria/altera recursos foi chamado"; fi
}
roda() { # roda <saida> <stdin> <comando>
  local out="$1" entrada="$2"; shift 2
  : > "$GCLOUD_LOG"
  set +e
  ( cd "$RAIZ" && printf '%s\n' "$entrada" | bash infra/homolog/gcp/etapa1-infra.sh "$@" ) > "$out" 2>&1
  echo $? > "$out.rc"
  set -e
}

echo "A. catálogo fora do ar e nenhuma consulta guardada → criação bloqueada"
export CENARIO_PRECOS_CACHE="$TMP/cacheA/precos.json"; echo lento > "$MODO"
roda "$TMP/a.out" cenariogestao criar
afirma "$TMP/a.out" "Criação BLOQUEADA: sem estimativa oficial válida"
nega "$TMP/a.out" "Para criar, digite"
afirma "$TMP/a.out" "tempo esgotado"
[[ "$(cat "$TMP/a.out.rc")" != 0 ]] && echo "  ✔ saída com erro" || { echo "  ✘ saída 0"; FALHAS=$((FALHAS + 1)); }
sem_alteracoes

echo "B. 'verificar' consulta; depois o catálogo para → 'criar' reutiliza a consulta e pede confirmação"
export CENARIO_PRECOS_CACHE="$TMP/cacheB/precos.json"; echo ok > "$MODO"
roda "$TMP/b1.out" "" verificar
afirma "$TMP/b1.out" "consulta oficial agora"
afirma "$TMP/b1.out" "VERIFICAÇÃO: OK"
echo lento > "$MODO"
roda "$TMP/b2.out" "resposta-errada" criar
afirma "$TMP/b2.out" "consulta oficial GUARDADA"
afirma "$TMP/b2.out" "Consultado em:"
afirma "$TMP/b2.out" "Para criar, digite o nome do projeto"
afirma "$TMP/b2.out" "Cancelado. Nada foi criado."
nega "$TMP/b2.out" "Traceback"
sem_alteracoes

echo "C. estimativa acima do limite → bloqueada antes da confirmação"
export CENARIO_PRECOS_CACHE="$TMP/cacheC/precos.json"; echo alto > "$MODO"
roda "$TMP/c.out" cenariogestao criar
afirma "$TMP/c.out" "ACIMA do limite"
afirma "$TMP/c.out" "Verificação com problemas: nada foi criado."
nega "$TMP/c.out" "Para criar, digite"
sem_alteracoes

echo "C2. consulta guardada acima do limite e catálogo fora do ar → bloqueada"
echo lento > "$MODO"
roda "$TMP/c2.out" cenariogestao criar
afirma "$TMP/c2.out" "ACIMA do limite"
nega "$TMP/c2.out" "Para criar, digite"
sem_alteracoes

echo "D. consulta normal → confirmação manual continua obrigatória"
export CENARIO_PRECOS_CACHE="$TMP/cacheD/precos.json"; echo ok > "$MODO"
roda "$TMP/d.out" "não" criar
afirma "$TMP/d.out" "consulta oficial agora"
afirma "$TMP/d.out" "Para criar, digite o nome do projeto"
afirma "$TMP/d.out" "Cancelado. Nada foi criado."
sem_alteracoes

echo "E. 'planejar' com o catálogo fora do ar e sem consulta guardada: informa, sem preço inventado"
export CENARIO_PRECOS_CACHE="$TMP/cacheE/precos.json"; echo truncado > "$MODO"
roda "$TMP/e.out" "" planejar
afirma "$TMP/e.out" "Sem estimativa válida"
nega "$TMP/e.out" "TOTAL_USD="
sem_alteracoes

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
