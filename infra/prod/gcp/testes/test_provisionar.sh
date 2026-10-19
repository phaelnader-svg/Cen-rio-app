#!/usr/bin/env bash
# Testes LOCAIS do provisionamento da produção, sem Google Cloud (gcloud e dig falsos):
#   A. "plano" e "auditar" não alteram nada (nenhuma chamada de criação, ligação ou atualização);
#   B. "infraestrutura" cria exatamente os recursos de produção, com segredos NOVOS gerados localmente que
#      nunca aparecem em argumentos, log ou saída; nada da homologação é criado, ligado ou alterado;
#   C. idempotente: a segunda execução não cria nem troca nada (segredos existentes mantidos);
#   D. "verificar" aprova o isolamento limpo e REPROVA uma ligação cruzada (operador da homologação
#      com acesso a segredo de produção);
#   E. promover-imagens.sh: recusa digest diferente do homologado, copia pelo digest, é idempotente e
#      nunca sobrescreve uma etiqueta de produção existente com outro digest;
#   F. "canal": só o 403 de propagação (código 126) é repetido; uma falha do runner não reenvia jobs; a
#      permissão temporária é sempre removida; o isolamento não herda a falha do canal.
# Executar: bash infra/prod/gcp/testes/test_provisionar.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FALHAS=0
afirma() { if grep -qE -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qE -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; grep -E -- "$2" "$1" | head -3; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
igual() { if [[ "$1" == "$2" ]]; then echo "  ✔ $3: $1"; else echo "  ✘ $3: '$1' (esperado '$2')"; FALHAS=$((FALHAS + 1)); fi; }

mkdir -p "$TMP/bin"
printf '#!/bin/bash\nexec python3 %q "$@"\n' "$AQUI/gcloud_prod_falso.py" > "$TMP/bin/gcloud"
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/dig"
chmod +x "$TMP/bin/gcloud" "$TMP/bin/dig"
novo() { # novo <nome>: estado e log limpos
  export FALSO_ESTADO="$TMP/$1.json" GCLOUD_LOG="$TMP/$1.log" FALSO_SEGREDOS="$TMP/$1.segredos"
  rm -f "$FALSO_ESTADO" "$GCLOUD_LOG" "$FALSO_SEGREDOS"; touch "$GCLOUD_LOG" "$FALSO_SEGREDOS"
}
prov() { (cd "$RAIZ" && PATH="$TMP/bin:$PATH" CENARIO_RELATORIOS="$TMP/rel" GESTOR_EMAIL=gestor@exemplo.com \
  GESTOR_NOME='Gestor Exemplo' bash infra/prod/gcp/provisionar.sh "$@"); }
MUTA='(^| )(create|add-iam-policy-binding|remove-iam-policy-binding|update|add-resource-policies|enable|add-tag|versions add|keys)( |$)'

echo "A. plano e auditar só leem"
novo a
prov plano > "$TMP/a.out" 2>&1
prov auditar >> "$TMP/a.out" 2>&1
nega "$GCLOUD_LOG" "$MUTA"
afirma "$TMP/a.out" "a criar  vm cenario-prod"
afirma "$TMP/a.out" "TOTAL aproximado"

echo "B. infraestrutura"
novo b
echo "PROVISIONAR PRODUCAO" | prov infraestrutura > "$TMP/b.out" 2>&1 || { tail -20 "$TMP/b.out"; exit 1; }
for r in "compute networks create cenario-prod-vpc" "compute networks subnets create cenario-prod-subnet" \
         "compute firewall-rules create cenario-prod-web .*--rules=tcp:80,tcp:443" \
         "compute firewall-rules create cenario-prod-iap-ssh .*--rules=tcp:22 --source-ranges=35.235.240.0/20" \
         "compute addresses create cenario-prod-ip" "iam service-accounts create cenario-prod-vm" \
         "secrets create prod-postgres-password .*--locations=southamerica-east1" "secrets create prod-token-hash-secret" \
         "secrets create prod-admin-password" "storage buckets create gs://cenariogestao-prod-backups .*--public-access-prevention" \
         "artifacts repositories create cenario-prod .*--immutable-tags" "compute resource-policies create snapshot-schedule cenario-prod-diario" \
         "compute instances create cenario-prod .*--machine-type=e2-medium" "--boot-disk-size=50GB --boot-disk-type=pd-balanced" \
         "--shielded-secure-boot" "--deletion-protection" "block-project-ssh-keys=TRUE" "enable-oslogin=TRUE" \
         "cenario-domain=cenariogestao.com.br,cenario-domain-www=www.cenariogestao.com.br" \
         "--zone=southamerica-east1-b" "compute disks add-resource-policies cenario-prod --zone=southamerica-east1-b --resource-policies=cenario-prod-diario"; do
  afirma "$GCLOUD_LOG" "$r"
done
afirma "$GCLOUD_LOG" "secrets add-iam-policy-binding prod-admin-password --member=serviceAccount:cenario-prod-vm@"
afirma "$GCLOUD_LOG" "storage buckets add-iam-policy-binding gs://cenariogestao-prod-backups .*--role=roles/storage.objectCreator"
nega "$GCLOUD_LOG" "roles/(owner|editor|storage\.admin|storage\.objectAdmin|storage\.objectViewer)"
# Nada da homologação é criado, ligado ou alterado.
grep -E "$MUTA" "$GCLOUD_LOG" > "$TMP/b.muta" || true
nega "$TMP/b.muta" "homolog"
# Segredos: 3 valores novos, no formato esperado, e nunca em argumento, log ou saída.
igual "$(grep -c . "$FALSO_SEGREDOS")" 3 "segredos gerados"
mapfile -t SEG < <(grep . "$FALSO_SEGREDOS")
[[ "${SEG[0]}" =~ ^[0-9a-f]{64}$ ]] && echo "  ✔ senha do PostgreSQL: 64 hex" || { echo "  ✘ senha do PostgreSQL fora do formato"; FALHAS=$((FALHAS + 1)); }
[[ "${SEG[1]}" =~ ^[0-9a-f]{96}$ ]] && echo "  ✔ TOKEN_HASH_SECRET: 96 hex" || { echo "  ✘ TOKEN_HASH_SECRET fora do formato"; FALHAS=$((FALHAS + 1)); }
[[ "${SEG[2]}" =~ ^[A-Za-z0-9]{24}$ && "${SEG[2]}" =~ [A-Za-z] && "${SEG[2]}" =~ [0-9] ]] && echo "  ✔ senha do gestor: 24, letras e números" || { echo "  ✘ senha do gestor fora da política"; FALHAS=$((FALHAS + 1)); }
for v in "${SEG[@]}"; do
  if grep -qF -- "$v" "$GCLOUD_LOG" "$TMP/b.out" "$TMP"/rel/* 2>/dev/null; then echo "  ✘ um segredo apareceu em argumento/log/saída"; FALHAS=$((FALHAS + 1)); fi
done
echo "  ✔ segredos não aparecem em argumentos, log nem saída"

echo "C. idempotência"
cp "$GCLOUD_LOG" "$TMP/b1.log"; : > "$GCLOUD_LOG"
echo "PROVISIONAR PRODUCAO" | prov infraestrutura > "$TMP/c.out" 2>&1 || { tail -20 "$TMP/c.out"; exit 1; }
nega "$GCLOUD_LOG" "(^| )create "
igual "$(grep -c . "$FALSO_SEGREDOS")" 3 "segredos (nenhum trocado)"
afirma "$TMP/c.out" "segredo prod-admin-password já existe \(mantido"

echo "D. isolamento"
prov verificar > "$TMP/d.out" 2>&1 || true
afirma "$TMP/d.out" "ISOLAMENTO: OK"
novo d2
export FALSO_LIGACAO_CRUZADA=1
echo "PROVISIONAR PRODUCAO" | prov infraestrutura > /dev/null 2>&1
rc=0; prov verificar > "$TMP/d2.out" 2>&1 || rc=$?
unset FALSO_LIGACAO_CRUZADA
igual "$rc" 1 "verificar com ligação cruzada (código de saída)"
afirma "$TMP/d2.out" "segredo prod-admin-password: serviceAccount:claude-operador@cenariogestao.iam.gserviceaccount.com TEM acesso"

echo "E. promoção por digest"
mkdir -p "$TMP/reg" "$TMP/bin2"
cat > "$TMP/bin2/gcloud" <<'EOF'
#!/bin/bash
f="$REG/$(echo "${5:-$4}" | tr '/:@' '___')"
if [[ "$1 $2 $3 $4" == "artifacts docker images describe" ]]; then f="$REG/$(echo "$5" | tr '/:@' '___')"; [[ -f "$f" ]] && cat "$f" || exit 1; exit 0; fi
if [[ "$1 $2 $3" == "container images add-tag" ]]; then dst="$6"; d="${5#*@}"; echo "$d" > "$REG/$(echo "$dst" | tr '/:@' '___')"; echo "add-tag $5 $6" >> "$REG/log"; exit 0; fi
exit 9
EOF
chmod +x "$TMP/bin2/gcloud"
O=us-east1-docker.pkg.dev/cenariogestao/cenario-homolog; D=southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod
TAG=9fb1786beddae28c34b20a0922b42989ecb0fbf2; A="sha256:$(printf 'a%.0s' {1..64})"; W="sha256:$(printf 'b%.0s' {1..64})"; X="sha256:$(printf 'c%.0s' {1..64})"
echo "$A" > "$TMP/reg/$(echo "$O/api:$TAG" | tr '/:@' '___')"; echo "$W" > "$TMP/reg/$(echo "$O/web:$TAG" | tr '/:@' '___')"
promo() { PATH="$TMP/bin2:$PATH" REG="$TMP/reg" bash "$RAIZ/infra/prod/gcp/promover-imagens.sh" "$@"; }
rc=0; promo "$TAG" "$X" "$W" > "$TMP/e1.out" 2>&1 || rc=$?
igual "$rc" 1 "digest diferente do homologado (código de saída)"
[[ ! -f "$TMP/reg/log" ]] && echo "  ✔ nada copiado" || { echo "  ✘ copiou com digest divergente"; FALHAS=$((FALHAS + 1)); }
promo "$TAG" "$A" "$W" > "$TMP/e2.out" 2>&1
afirma "$TMP/e2.out" "api:$TAG promovida com o digest homologado $A"
afirma "$TMP/reg/log" "add-tag $O/web@$W $D/web:$TAG"
promo "$TAG" "$A" "$W" > "$TMP/e3.out" 2>&1
afirma "$TMP/e3.out" "já promovida"
igual "$(wc -l < "$TMP/reg/log")" 2 "cópias (a repetição não copia de novo)"
echo "$X" > "$TMP/reg/$(echo "$D/api:$TAG" | tr '/:@' '___')"
rc=0; promo "$TAG" "$A" "$W" > "$TMP/e4.out" 2>&1 || rc=$?
igual "$rc" 1 "etiqueta de produção com outro digest (código de saída)"
afirma "$TMP/e4.out" "nunca sobrescrito"
rc=0; promo 9fb1786 "$A" "$W" > /dev/null 2>&1 || rc=$?
igual "$rc" 2 "SHA abreviado recusado"

echo "F. canal (permissão temporária) e isolamento contados separadamente"
PY_REAL="$(command -v python3)"
mkdir -p "$TMP/bin3"
# operar.py falso: cada chamada "verificar" sai com o próximo código de FALSO_VERIFICAR (o último se repete).
cat > "$TMP/bin3/python3" <<EOF2
#!/bin/bash
if [[ "\${2:-}" == *operar.py ]]; then
  echo "operar \$3 ambiente=\${CENARIO_AMBIENTE:-} token=\${CLOUDSDK_AUTH_ACCESS_TOKEN-ausente}" >> "\$FALSO_OPERAR_LOG"
  [[ "\$3" == verificar ]] || exit 0
  read -ra cod <<< "\$FALSO_VERIFICAR"; n=\$(grep -c ' verificar ' "\$FALSO_OPERAR_LOG")
  (( n <= \${#cod[@]} )) && exit "\${cod[\$((n - 1))]}" || exit "\${cod[-1]}"
fi
exec "$PY_REAL" "\$@"
EOF2
chmod +x "$TMP/bin3/python3"
canal() { # canal <nome> <códigos do verificar…>
  novo "$1"; local nome="$1"; shift
  echo "PROVISIONAR PRODUCAO" | prov infraestrutura > /dev/null 2>&1
  PATH="$TMP/bin:$PATH" gcloud iam service-accounts create claude-operador-prod --project=cenariogestao
  export FALSO_OPERAR_LOG="$TMP/$nome.operar" FALSO_VERIFICAR="$*"; : > "$FALSO_OPERAR_LOG"; : > "$GCLOUD_LOG"
  rc=0; PATH="$TMP/bin3:$PATH" CENARIO_CANAL_ESPERA_S=0 CLOUDSDK_AUTH_ACCESS_TOKEN=marcador prov canal > "$TMP/$nome.out" 2>&1 || rc=$?
}
SA_OP="iam service-accounts (add|remove)-iam-policy-binding claude-operador-prod@cenariogestao.iam.gserviceaccount.com --member=user:dono@exemplo.com --role=projects/cenariogestao/roles/cenarioProdAssinaJwt"
# F1: signJwt 403 (código 126) enquanto a permissão temporária propaga, depois o canal responde.
canal f1 126 126 0
igual "$rc" 0 "canal após a propagação (código de saída)"
igual "$(grep -c ' verificar ' "$FALSO_OPERAR_LOG")" 3 "tentativas do verificar (só o 126 é repetido)"
afirma "$FALSO_OPERAR_LOG" "operar verificar ambiente=prod token=ausente"
afirma "$FALSO_OPERAR_LOG" "operar teste-seguranca ambiente=prod"
afirma "$GCLOUD_LOG" "${SA_OP/(add|remove)/add}"
afirma "$GCLOUD_LOG" "${SA_OP/(add|remove)/remove}"
afirma "$TMP/f1.out" "permissão temporária de dono@exemplo.com removida"
afirma "$TMP/f1.out" "ISOLAMENTO: OK"
afirma "$TMP/f1.out" "ETAPA OPERADOR: OK"
grep -E "$MUTA" "$GCLOUD_LOG" | grep -vE "$SA_OP" > "$TMP/f1.muta" || true
igual "$(grep -c . "$TMP/f1.muta")" 0 "outras mudanças no GCP além da permissão temporária"
# F2: o runner respondeu, mas a verificação falhou (código 1): NÃO repete (não reenvia jobs) e o
# isolamento NÃO herda a falha do canal.
canal f2 1
igual "$rc" 1 "canal com falha (código de saída)"
igual "$(grep -c ' verificar ' "$FALSO_OPERAR_LOG")" 1 "tentativas do verificar (sem repetição)"
nega "$FALSO_OPERAR_LOG" "teste-seguranca"
afirma "$TMP/f2.out" "canal: o runner respondeu, mas a verificação falhou \(código 1"
afirma "$TMP/f2.out" "ISOLAMENTO: OK"
nega "$TMP/f2.out" "ISOLAMENTO com"
afirma "$TMP/f2.out" "ETAPA OPERADOR incompleta: canal FALHOU · isolamento OK"
afirma "$GCLOUD_LOG" "${SA_OP/(add|remove)/remove}"
# F3: a assinatura nunca propaga: 32 tentativas, falha clara, permissão temporária removida.
canal f3 126
igual "$rc" 1 "assinatura sempre recusada (código de saída)"
igual "$(grep -c ' verificar ' "$FALSO_OPERAR_LOG")" 32 "tentativas do verificar"
afirma "$TMP/f3.out" "assinatura ainda recusada após 32 tentativas"
afirma "$TMP/f3.out" "ISOLAMENTO: OK"
afirma "$GCLOUD_LOG" "${SA_OP/(add|remove)/remove}"
unset FALSO_OPERAR_LOG FALSO_VERIFICAR

echo
if (( FALHAS == 0 )); then echo "PROVISIONAMENTO (testes locais): OK"; else echo "PROVISIONAMENTO (testes locais): $FALHAS falha(s)"; exit 1; fi
