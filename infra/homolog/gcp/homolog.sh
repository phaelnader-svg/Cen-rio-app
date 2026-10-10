#!/usr/bin/env bash
# Homologação no Google Cloud — preparação AUTOMATIZADA a partir do Cloud Shell, sobre os recursos
# já criados manualmente (VM cenario-homolog na VPC cenario-homolog-vpc, conta de serviço, 5
# segredos e bucket de backups). Na raiz do repositório:
#
#   bash infra/homolog/gcp/homolog.sh auditar [--sem-ssh]   # SÓ LEITURA: tudo o que existe, custa ou expõe
#   bash infra/homolog/gcp/homolog.sh custos [--diagnosticar] # preços oficiais + itens adicionais/variáveis
#                                                           # (--diagnosticar: só lista as SKUs de disco/snapshot)
#   bash infra/homolog/gcp/homolog.sh configurar [--com-snapshots]
#                                                           # aplica SÓ o que falta e está autorizado
#                                                           # (pede para digitar a confirmação)
#   bash infra/homolog/gcp/homolog.sh preparar-vm           # copia os arquivos do commit para a VM e
#                                                           # instala os serviços COM o portão fechado
#   bash infra/homolog/gcp/homolog.sh testar-config         # valida tudo SEM iniciar nada
#   bash infra/homolog/gcp/homolog.sh relatorio             # resumo das etapas executadas
#   bash infra/homolog/gcp/homolog.sh tudo [--com-snapshots] # as etapas acima, em ordem; para na 1ª falha
#   bash infra/homolog/gcp/homolog.sh plano-publicacao      # SÓ IMPRIME os comandos da publicação futura
#   bash infra/homolog/gcp/homolog.sh plano-encerramento    # SÓ IMPRIME os comandos para zerar cobranças
#
# Garantias: opera só no projeto cenariogestao (todo comando leva --project); nunca cria VM, rede,
# firewall, IP, Artifact Registry, Cloud Build nem DNS; nunca abre portas; nunca inicia PostgreSQL,
# aplicação ou migrations; nunca apaga nem sobrescreve; nunca exibe segredos. Registros em
# ~/cenario-homolog-relatorios/ (sem segredos). Snapshots só com --com-snapshots e confirmação.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROJECT=cenariogestao
REGION=us-east1
ZONE=us-east1-b
VM=cenario-homolog
VPC=cenario-homolog-vpc
SUBNET=cenario-homolog-subnet
TAG_REDE=cenario-homolog
FW_IAP=cenario-homolog-iap-ssh
IAP_FAIXA=35.235.240.0/20
IP_EXTERNO=136.108.15.103
IP_INTERNO=10.50.0.2
SA="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com"
BUCKET=gs://cenariogestao-homolog-backups
SECRETS=(homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token)
SNAP_POLITICA=cenario-homolog-diario
LIMITE_USD=20.00
PORTAO=/etc/cenario/publicacao-autorizada
# Configuração NÃO secreta lida pela VM (vm.sh). O e-mail é fictício (domínio de teste).
METADADOS=(
  "cenario-project=$PROJECT" "cenario-region=$REGION" "cenario-repo=cenario-homolog"
  "cenario-domain=teste.cenariogestao.com.br" "cenario-bucket=$BUCKET"
  "cenario-basic-user=homologacao" "cenario-admin-email=gestor@teste.cenariogestao.com.br"
)
# Papéis que a conta da VM NUNCA deve ter (no projeto ou no bucket).
PAPEIS_PROIBIDOS='^roles/(owner|editor|storage\.admin|storage\.objectAdmin|storage\.objectViewer|storage\.objectUser|storage\.legacyBucket.*|secretmanager\.admin|compute\.admin|iam\..*[Aa]dmin.*|resourcemanager\..*)$'

RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-homolog-relatorios}"
OKS=0; AVISOS=0; FALHAS=0; PENDENTES=0; DECISOES=()
ok() { echo "✔ $*"; OKS=$((OKS + 1)); }
aviso() { echo "⚠ $*"; AVISOS=$((AVISOS + 1)); }
falha() { echo "✘ $*"; FALHAS=$((FALHAS + 1)); }
pendente() { echo "◻ $* — o 'configurar' resolve"; PENDENTES=$((PENDENTES + 1)); }
decisao() { echo "? $*"; DECISOES+=("$*"); }
secao() { echo; echo "== $*"; }
g() { gcloud --project="$PROJECT" "$@"; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# Chamada autenticada às APIs REST com o token da SUA conta num arquivo 600 (fora dos argumentos).
api() {
  ( umask 077; printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token 2>/dev/null)" > "$T/auth" )
  curl -fsS -m 60 -H "@$T/auth" "$@"
}
confirmar() { # confirmar <frase exata>
  printf '\nPara prosseguir, digite exatamente: %s\n> ' "$1"
  local r; read -r r || true
  [[ "$r" == "$1" ]] || { echo "Cancelado. Nada foi alterado."; exit 1; }
}
ssh_vm() { # comando remoto; a entrada padrão é repassada
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet --command="$1"
}

requisitos() {
  local c faltam=()
  for c in gcloud jq git python3 curl timeout; do command -v "$c" >/dev/null 2>&1 || faltam+=("$c"); done
  (( ${#faltam[@]} == 0 )) || { echo "✘ Ferramentas ausentes: ${faltam[*]} (use o Cloud Shell)"; exit 1; }
  local conta; conta="$(gcloud config get-value account 2>/dev/null || true)"
  [[ -n "$conta" ]] || { echo "✘ Nenhuma conta autenticada no gcloud (gcloud auth login)"; exit 1; }
  g projects describe "$PROJECT" --format=json > "$T/projeto.json" 2>/dev/null \
    || { echo "✘ Projeto $PROJECT inacessível com a conta $conta"; exit 1; }
  [[ "$(jq -r .lifecycleState "$T/projeto.json")" == ACTIVE ]] || { echo "✘ Projeto $PROJECT não está ativo"; exit 1; }
  NUM="$(jq -r .projectNumber "$T/projeto.json")"
  echo "Conta: $conta · Projeto: $PROJECT (nº $NUM) · Região: $REGION · Zona: $ZONE"
}

# ---------------------------------------------------------------- leituras reutilizadas
ler_vm() { g compute instances describe "$VM" --zone="$ZONE" --format=json > "$T/vm.json"; }
ler_bucket() {
  gcloud storage buckets describe "$BUCKET" --project="$PROJECT" --format=json > "$T/bucket.json"
  gcloud storage buckets get-iam-policy "$BUCKET" --project="$PROJECT" --format=json > "$T/bucket-iam.json"
}
# Regras esperadas (lifecycle-30d.json): apagar tudo aos 30 dias e os objetos de teste aos 1 dia.
JQ_REGRA_30='.action.type == "Delete" and ((.condition // {}) | keys) == ["age"] and (.condition.age | tostring) == "30"'
JQ_REGRA_TESTE='.action.type == "Delete" and (.condition.matchesPrefix // []) == ["testes-preparo/"]'
tem_lifecycle_30() {
  jq -e "[(.lifecycle_config.rule // .lifecycle.rule // [])[] | select($JQ_REGRA_30)] | length > 0" "$T/bucket.json" >/dev/null
}
outras_regras_lifecycle() {
  jq -r "[(.lifecycle_config.rule // .lifecycle.rule // [])[] | select((($JQ_REGRA_30) or ($JQ_REGRA_TESTE)) | not)] | length" "$T/bucket.json"
}
papeis_no_bucket() { jq -r --arg m "serviceAccount:$SA" '[.bindings[]? | select(.members | index($m)) | .role] | join(" ")' "$T/bucket-iam.json"; }
acessor_do_segredo() { # acessor_do_segredo <segredo> → 0 se a conta da VM tem secretAccessor nele
  g secrets get-iam-policy "$1" --format=json 2>/dev/null \
    | jq -e --arg m "serviceAccount:$SA" '[.bindings[]? | select(.role == "roles/secretmanager.secretAccessor" and (.members | index($m)))] | length > 0' >/dev/null
}
metadados_faltando() { # imprime "chave=valor" dos metadados cenario-* ausentes ou diferentes
  local kv k v atual
  for kv in "${METADADOS[@]}"; do
    k="${kv%%=*}"; v="${kv#*=}"
    atual="$(jq -r --arg k "$k" '[.metadata.items[]? | select(.key == $k) | .value][0] // ""' "$T/vm.json")"
    [[ "$atual" == "$v" ]] || echo "$kv"
  done
}
disco_boot() { jq -r '.disks[] | select(.boot) | .source | split("/") | last' "$T/vm.json"; }
sondar_portas() { # do Cloud Shell (internet) para o IP da VM: tudo deve estar fechado
  [[ "${CENARIO_SEM_SONDA:-0}" == 1 ]] && { echo "• sondagem externa desativada (CENARIO_SEM_SONDA=1)"; return 0; }
  local p
  for p in 22 80 443 5432 3000 4000; do
    if timeout 5 bash -c "</dev/tcp/$IP_EXTERNO/$p" 2>/dev/null; then falha "porta $p ABERTA na internet ($IP_EXTERNO)"
    else ok "porta $p fechada/filtrada a partir da internet"; fi
  done
}

# ================================================================ AUDITAR (somente leitura)
auditar() {
  local sem_ssh=0; [[ "${1:-}" == --sem-ssh ]] && sem_ssh=1
  requisitos

  secao "1. Faturamento e orçamentos"
  g billing projects describe "$PROJECT" --format=json > "$T/fat.json" 2>/dev/null || echo '{}' > "$T/fat.json"
  local conta_fat; conta_fat="$(jq -r '.billingAccountName // "" | sub("billingAccounts/"; "")' "$T/fat.json")"
  [[ "$(jq -r .billingEnabled "$T/fat.json")" == true ]] && ok "faturamento ativo (conta $conta_fat)" || falha "faturamento não ativo ou ilegível"
  if [[ -n "$conta_fat" ]] && gcloud billing budgets list --billing-account="$conta_fat" --format=json > "$T/orc.json" 2>/dev/null; then
    (( $(jq length "$T/orc.json") > 0 )) || aviso "nenhum orçamento na conta de faturamento"
    jq -r --arg p "projects/$NUM" '.[] | [(.displayName // "?"),
        ((.amount.specifiedAmount.units // "?") + " " + (.amount.specifiedAmount.currencyCode // "")),
        ([.thresholdRules[]?.thresholdPercent | . * 100 | round | tostring + "%"] | join(",")),
        (if ((.budgetFilter.projects // []) == [$p]) then "SÓ este projeto" elif ((.budgetFilter.projects // []) | length) == 0 then "TODOS os projetos da conta" else ((.budgetFilter.projects // []) | join(",")) end)] | @tsv' "$T/orc.json" \
      | while IFS=$'\t' read -r nome valor alertas escopo; do echo "• orçamento '$nome': $valor · alertas $alertas · escopo: $escopo"; done
    echo "  (orçamento só AVISA; não interrompe cobranças)"
  else
    aviso "orçamentos não lidos (API billingbudgets desabilitada ou sem permissão na conta de faturamento): confira no console Faturamento → Orçamentos e alertas"
  fi

  secao "2. Suas permissões no projeto (necessárias às etapas de preparação)"
  # O testIamPermissions do PROJETO só avalia permissões do tipo "projeto": as storage.buckets.*
  # voltavam sempre ausentes (falso negativo), mesmo com describe/get-iam-policy funcionando.
  # Por isso as do bucket são testadas NO PRÓPRIO BUCKET (API do Cloud Storage).
  local perms='["compute.instances.get","compute.instances.setMetadata","compute.firewalls.list","compute.disks.get","iap.tunnelInstances.accessViaIAP","secretmanager.secrets.getIamPolicy","secretmanager.secrets.setIamPolicy","resourcemanager.projects.getIamPolicy","iam.serviceAccountKeys.list","compute.resourcePolicies.create","compute.disks.addResourcePolicies"]'
  local perms_bucket='["storage.buckets.get","storage.buckets.update","storage.buckets.getIamPolicy","storage.buckets.setIamPolicy"]'
  local tem tem_b consulta
  tem="$(api -X POST -H 'content-type: application/json' -d "{\"permissions\": $perms}" \
    "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions" 2>/dev/null || echo '{}')"
  consulta="$(jq -r 'map("permissions=" + .) | join("&")' <<<"$perms_bucket")"
  tem_b="$(api "https://storage.googleapis.com/storage/v1/b/${BUCKET#gs://}/iam/testPermissions?$consulta" 2>/dev/null || echo '{}')"
  tem="$(jq -c --argjson b "$tem_b" '{permissions: ((.permissions // []) + ($b.permissions // []))}' <<<"$tem")"
  local p
  for p in $(jq -r '.[]' <<<"$perms") $(jq -r '.[]' <<<"$perms_bucket"); do
    if jq -e --arg p "$p" '(.permissions // []) | index($p)' <<<"$tem" >/dev/null; then ok "$p"
    elif [[ "$p" == compute.resourcePolicies.create || "$p" == compute.disks.addResourcePolicies ]]; then aviso "sem $p (só necessária para os snapshots opcionais)"
    else falha "sem $p"; fi
  done

  secao "3. APIs habilitadas"
  g services list --enabled --format=json > "$T/apis.json" 2>/dev/null || echo '[]' > "$T/apis.json"
  jq -r '.[] | (.config.name // (.name | split("/") | last))' "$T/apis.json" | sort > "$T/apis.txt"
  echo "• $(xargs < "$T/apis.txt")"
  local a
  for a in compute.googleapis.com secretmanager.googleapis.com storage.googleapis.com; do
    grep -qx "$a" "$T/apis.txt" && ok "$a" || falha "$a desabilitada"
  done
  for a in artifactregistry.googleapis.com cloudbuild.googleapis.com; do
    grep -qx "$a" "$T/apis.txt" && aviso "$a JÁ habilitada (confira se há recursos cobrando)" || ok "$a não habilitada (só será necessária na publicação, com nova autorização)"
  done

  secao "4. Recursos que geram cobrança no projeto (inventário completo)"
  g compute instances list --format=json > "$T/vms.json"
  jq -r '.[] | "• VM \(.name) · \(.zone | split("/") | last) · \(.machineType | split("/") | last) · \(.status)"' "$T/vms.json"
  local nvm; nvm="$(jq length "$T/vms.json")"
  if [[ "$nvm" == 1 && "$(jq -r '.[0].name' "$T/vms.json")" == "$VM" ]]; then ok "uma única VM no projeto ($VM)"
  else falha "VMs no projeto: $nvm (esperada só $VM) — confira cobranças"; fi
  g compute disks list --format=json > "$T/discos.json"
  jq -r '.[] | "• disco \(.name) · \(.sizeGb) GB · \(.type | split("/") | last) · \(if (.users // []) | length > 0 then "em uso por " + ((.users | map(split("/") | last)) | join(",")) else "SEM USO (cobra mesmo assim)" end)"' "$T/discos.json"
  (( $(jq '[.[] | select((.users // []) | length == 0)] | length' "$T/discos.json") == 0 )) && ok "nenhum disco órfão" || falha "há disco sem uso gerando cobrança"
  g compute addresses list --format=json > "$T/ips.json"
  jq -r '.[] | "• IP \(.name) · \(.address) · \(.addressType // "EXTERNAL") · \(.status) · \(.region // "global" | split("/") | last)"' "$T/ips.json"
  IP_NOME="$(jq -r --arg ip "$IP_EXTERNO" '[.[] | select(.address == $ip) | .name][0] // ""' "$T/ips.json")"
  if [[ -n "$IP_NOME" ]]; then
    [[ "$(jq -r --arg ip "$IP_EXTERNO" '.[] | select(.address == $ip) | .status' "$T/ips.json")" == IN_USE ]] \
      && ok "IP estático $IP_EXTERNO reservado como '$IP_NOME' e EM USO" || falha "IP $IP_EXTERNO reservado mas sem uso (cobra US\$ 0,01/h)"
  else falha "IP $IP_EXTERNO não aparece como endereço estático reservado (efêmero? mudaria ao parar a VM)"; fi
  (( $(jq '[.[] | select(.status == "RESERVED" and (.addressType // "EXTERNAL") == "EXTERNAL")] | length' "$T/ips.json") == 0 )) \
    && ok "nenhum IP externo reservado sem uso" || falha "há IP externo reservado sem uso (US\$ 0,01/h cada)"
  g compute snapshots list --format=json > "$T/snaps.json"
  echo "• snapshots: $(jq length "$T/snaps.json") ($(jq '[.[].storageBytes // "0" | tonumber] | add // 0 | . / 1073741824 * 100 | round / 100' "$T/snaps.json") GB armazenados)"
  g compute resource-policies list --format=json > "$T/politicas.json"
  echo "• políticas de recursos (agendas de snapshot): $(jq -r '[.[].name] | join(", ") | if . == "" then "nenhuma" else . end' "$T/politicas.json")"
  g compute images list --no-standard-images --format=json > "$T/imagens.json" 2>/dev/null || echo '[]' > "$T/imagens.json"
  g compute machine-images list --format=json > "$T/mimagens.json" 2>/dev/null || echo '[]' > "$T/mimagens.json"
  echo "• imagens próprias: $(jq length "$T/imagens.json") · machine images: $(jq length "$T/mimagens.json")"
  g compute forwarding-rules list --format=json > "$T/fr.json" 2>/dev/null || echo '[]' > "$T/fr.json"
  (( $(jq length "$T/fr.json") == 0 )) && ok "nenhum balanceador/forwarding rule" || falha "há forwarding rules (balanceador cobra por hora): $(jq -r '[.[].name] | join(", ")' "$T/fr.json")"
  g compute routers list --format=json > "$T/routers.json" 2>/dev/null || echo '[]' > "$T/routers.json"
  (( $(jq '[.[] | select((.nats // []) | length > 0)] | length' "$T/routers.json") == 0 )) && ok "nenhum Cloud NAT" || aviso "há Cloud NAT configurado (cobra por hora)"
  gcloud storage buckets list --project="$PROJECT" --format=json > "$T/buckets.json" 2>/dev/null || echo '[]' > "$T/buckets.json"
  echo "• buckets: $(jq -r '[.[] | (.name // .storage_url)] | join(", ")' "$T/buckets.json")"
  grep -qx sqladmin.googleapis.com "$T/apis.txt" && { g sql instances list --format='value(name)' 2>/dev/null | sed 's/^/✘ Cloud SQL: /' || true; }
  grep -qx run.googleapis.com "$T/apis.txt" && { g run services list --format='value(name)' 2>/dev/null | sed 's/^/⚠ Cloud Run: /' || true; }
  grep -qx artifactregistry.googleapis.com "$T/apis.txt" && { g artifacts repositories list --format='value(name)' 2>/dev/null | sed 's/^/• Artifact Registry: /' || true; }

  secao "5. VM $VM"
  ler_vm
  local v; v="$T/vm.json"
  [[ "$(jq -r .status "$v")" == RUNNING ]] && ok "status RUNNING" || aviso "status $(jq -r .status "$v")"
  [[ "$(jq -r '.machineType | split("/") | last' "$v")" == e2-small ]] && ok "tipo e2-small" || falha "tipo $(jq -r '.machineType | split("/") | last' "$v") (esperado e2-small)"
  local disco; disco="$(disco_boot)"
  g compute disks describe "$disco" --zone="$ZONE" --format=json > "$T/disco.json"
  echo "• disco de inicialização: $disco · $(jq -r '"\(.sizeGb) GB · \(.type | split("/") | last) · imagem \((.sourceImage // "?") | split("/") | last)"' "$T/disco.json") · apagar com a VM: $(jq -r '.disks[] | select(.boot) | .autoDelete' "$v")"
  [[ "$(jq -r '.sizeGb' "$T/disco.json")" == 20 && "$(jq -r '.type | split("/") | last' "$T/disco.json")" == pd-balanced ]] && ok "disco 20 GB pd-balanced" || aviso "disco diferente de 20 GB pd-balanced"
  if (( $(jq '(.resourcePolicies // []) | length' "$T/disco.json") > 0 )); then echo "• agenda de snapshots no disco: $(jq -r '.resourcePolicies | map(split("/") | last) | join(", ")' "$T/disco.json")"
  else decisao "snapshots diários (7 dias) NÃO configurados — opcionais, custo adicional (ver 'custos'); só com 'configurar --com-snapshots'"; fi
  local nic='.networkInterfaces[0]'
  [[ "$(jq -r "$nic.network | split(\"/\") | last" "$v")" == "$VPC" ]] && ok "rede $VPC (VPC exclusiva, não a 'default')" || falha "rede $(jq -r "$nic.network" "$v") (esperado $VPC)"
  [[ "$(jq -r "$nic.subnetwork | split(\"/\") | last" "$v")" == "$SUBNET" ]] && ok "sub-rede $SUBNET" || falha "sub-rede inesperada"
  [[ "$(jq -r "$nic.networkIP" "$v")" == "$IP_INTERNO" ]] && ok "IP interno $IP_INTERNO" || aviso "IP interno $(jq -r "$nic.networkIP" "$v")"
  [[ "$(jq -r "$nic.accessConfigs[0].natIP // \"\"" "$v")" == "$IP_EXTERNO" ]] && ok "IP externo $IP_EXTERNO" || falha "IP externo $(jq -r "$nic.accessConfigs[0].natIP // \"nenhum\"" "$v")"
  jq -e --arg t "$TAG_REDE" '(.tags.items // []) | index($t)' "$v" >/dev/null && ok "etiqueta de rede $TAG_REDE" || falha "VM sem a etiqueta de rede $TAG_REDE (a regra do IAP não se aplicaria)"
  [[ "$(jq -r '.serviceAccounts[0].email // ""' "$v")" == "$SA" ]] && ok "conta de serviço $SA" || falha "conta de serviço da VM: $(jq -r '.serviceAccounts[0].email // "nenhuma"' "$v")"
  local escopos; escopos="$(jq -r '(.serviceAccounts[0].scopes // []) | map(sub("https://www.googleapis.com/auth/"; "")) | join(" ")' "$v")"
  echo "• escopos de acesso: ${escopos:-nenhum}"
  if [[ " $escopos " == *" cloud-platform "* ]]; then ok "escopo cloud-platform (o acesso é limitado pelo IAM mínimo)"
  else
    falha "escopos sem cloud-platform: a VM NÃO conseguirá ler o Secret Manager nem gravar no bucket"
    decisao "trocar os escopos da VM para cloud-platform exige PARAR a VM (alguns minutos): comandos em plano-publicacao; não é feito automaticamente"
  fi
  [[ "$(jq -r '.shieldedInstanceConfig.enableSecureBoot // false' "$v")" == true ]] && ok "Secure Boot ativo" || aviso "Secure Boot desativado (Shielded VM recomendado; mudar exige parar a VM)"
  [[ "$(jq -r '.canIpForward // false' "$v")" == false ]] && ok "sem encaminhamento de IP" || aviso "canIpForward ativo"
  echo "• proteção contra exclusão: $(jq -r '.deletionProtection // false' "$v")"
  echo "• metadados (chaves): $(jq -r '[.metadata.items[]?.key] | join(", ") | if . == "" then "nenhuma" else . end' "$v")"
  local oslogin; oslogin="$(jq -r '[.metadata.items[]? | select(.key == "enable-oslogin") | .value][0] // ""' "$v")"
  if [[ "${oslogin,,}" == true ]]; then ok "OS Login ativo na VM"
  else decisao "OS Login não está ativo na VM (enable-oslogin=TRUE): recomendado (chaves SSH ligadas à sua conta Google); não é alterado automaticamente para não interromper o seu acesso atual"; fi
  jq -e '[.metadata.items[]? | select(.key == "serial-port-enable" and (.value | ascii_downcase) == "true")] | length > 0' "$v" >/dev/null && falha "porta serial interativa habilitada" || ok "porta serial interativa desabilitada"
  jq -e '[.metadata.items[]? | select(.key == "startup-script")] | length > 0' "$v" >/dev/null && aviso "existe startup-script nos metadados (conferir conteúdo; a preparação NÃO usa startup-script)" || ok "sem startup-script (nada roda automaticamente no boot além do sistema)"
  local falta; falta="$(metadados_faltando | xargs)"
  [[ -z "$falta" ]] && ok "metadados cenario-* completos" || pendente "metadados cenario-* ausentes/diferentes: $falta"

  secao "6. Rede, firewall e IAP"
  g compute networks describe "$VPC" --format=json > "$T/vpc.json"
  [[ "$(jq -r '.autoCreateSubnetworks // false' "$T/vpc.json")" == false ]] && ok "VPC $VPC em modo personalizado" || aviso "VPC em modo automático"
  (( $(jq '(.peerings // []) | length' "$T/vpc.json") == 0 )) && ok "VPC sem peering (isolada de outras redes/projetos)" || falha "VPC com peering: $(jq -r '[.peerings[].network] | join(", ")' "$T/vpc.json")"
  g compute networks subnets list --format=json > "$T/subnets.json"
  jq -r --arg n "$VPC" '.[] | select(.network | endswith("/" + $n)) | "• sub-rede \(.name) · \(.region | split("/") | last) · \(.ipCidrRange) · acesso privado Google: \(.privateIpGoogleAccess // false)"' "$T/subnets.json"
  g compute firewall-rules list --format=json > "$T/fw.json"
  jq -r --arg n "$VPC" '.[] | select(.network | endswith("/" + $n)) | "• regra \(.name) · \(.direction) · prioridade \(.priority) · \(if .allowed then "PERMITE " + ([.allowed[] | .IPProtocol + ":" + ((.ports // ["todas"]) | join(","))] | join(" ")) else "NEGA " + ([.denied[] | .IPProtocol] | join(" ")) end) · origens \((.sourceRanges // ["-"]) | join(",")) · alvos \((.targetTags // ["TODAS as VMs"]) | join(",")) · \(if .disabled then "DESATIVADA" else "ativa" end)"' "$T/fw.json"
  jq --arg n "$VPC" '[.[] | select((.network | endswith("/" + $n)) and .direction == "INGRESS" and (.disabled | not) and .allowed)]' "$T/fw.json" > "$T/fw-entrada.json"
  local iap; iap="$(jq -c --arg r "$FW_IAP" '.[] | select(.name == $r)' "$T/fw-entrada.json")"
  if [[ -n "$iap" ]] && jq -e --arg f "$IAP_FAIXA" --arg t "$TAG_REDE" '.sourceRanges == [$f] and (.targetTags // []) == [$t] and ([.allowed[] | .IPProtocol + ":" + ((.ports // []) | join(","))] == ["tcp:22"])' <<<"$iap" >/dev/null; then
    ok "regra $FW_IAP: só TCP 22, só de $IAP_FAIXA (IAP), só na etiqueta $TAG_REDE"
  else falha "regra $FW_IAP ausente ou diferente do esperado (TCP 22, origem $IAP_FAIXA, alvo $TAG_REDE)"; fi
  local abertas; abertas="$(jq -r --arg f "$IAP_FAIXA" '[.[] | select((.sourceRanges // []) | map(select(. != $f)) | length > 0) | .name] | join(", ")' "$T/fw-entrada.json")"
  [[ -z "$abertas" ]] && ok "nenhuma regra de entrada além do IAP (demais conexões negadas pela regra implícita da VPC)" || falha "regras de entrada com outras origens: $abertas"
  jq -e '[.[] | .allowed[]? | (.ports // ["todas"])[] | select(. == "80" or . == "443" or . == "todas")] | length == 0' "$T/fw-entrada.json" >/dev/null \
    && ok "portas 80/443 NÃO liberadas (correto nesta etapa)" || falha "há regra liberando 80/443 ou todas as portas"
  if jq -e '[.[] | select(.network | endswith("/default"))] | length > 0' "$T/fw.json" >/dev/null; then
    aviso "a rede 'default' existe com regras próprias (não afeta a VM, que está só na $VPC): $(jq -r '[.[] | select(.network | endswith("/default")) | .name] | join(", ")' "$T/fw.json")"
  fi
  sondar_portas

  secao "7. Conta de serviço e permissões efetivas"
  if g iam service-accounts describe "$SA" --format=json > "$T/sa.json" 2>/dev/null; then
    [[ "$(jq -r '.disabled // false' "$T/sa.json")" == false ]] && ok "conta $SA ativa" || falha "conta $SA desativada"
  else falha "conta $SA não encontrada"; fi
  g iam service-accounts keys list --iam-account="$SA" --managed-by=user --format=json > "$T/chaves.json" 2>/dev/null || echo '[]' > "$T/chaves.json"
  (( $(jq length "$T/chaves.json") == 0 )) && ok "nenhuma chave privada criada para a conta (usa só o servidor de metadados)" || falha "a conta tem $(jq length "$T/chaves.json") chave(s) privada(s) — risco de vazamento"
  g projects get-iam-policy "$PROJECT" --format=json > "$T/proj-iam.json"
  local papeis; papeis="$(jq -r --arg m "serviceAccount:$SA" '[.bindings[]? | select(.members | index($m)) | .role] | join(" ")' "$T/proj-iam.json")"
  echo "• papéis da conta da VM no PROJETO: ${papeis:-nenhum}"
  local r prob=0
  for r in $papeis; do [[ "$r" =~ $PAPEIS_PROIBIDOS ]] && { falha "papel amplo demais no projeto: $r"; prob=1; }; done
  (( prob == 0 )) && ok "nenhum papel amplo (Owner/Editor/Storage Admin…) no projeto"
  local externas; externas="$(jq -r --arg p "$PROJECT" '[.bindings[]?.members[]? | select(startswith("serviceAccount:") and (contains("@" + $p + ".iam.") | not) and (contains("gserviceaccount.com")) and (test("@(cloudservices|cloudbuild|compute-system|gcp-sa-|container-engine|serverless-robot|firebase|appspot)") | not))] | unique | join(", ")' "$T/proj-iam.json")"
  [[ -z "$externas" ]] && ok "nenhuma conta de serviço de OUTRO projeto com acesso a $PROJECT" || aviso "contas de serviço de outros projetos com acesso a $PROJECT: $externas"
  jq -e '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0' "$T/proj-iam.json" >/dev/null && ok "projeto sem acesso público" || falha "projeto com allUsers/allAuthenticatedUsers"

  secao "8. Segredos (sem ler valores)"
  g secrets list --format=json > "$T/segredos.json"
  local s
  for s in "${SECRETS[@]}"; do
    if ! jq -e --arg s "$s" '[.[] | select(.name | endswith("/secrets/" + $s))] | length == 1' "$T/segredos.json" >/dev/null; then falha "segredo $s ausente"; continue; fi
    local nver; nver="$(g secrets versions list "$s" --filter=state=ENABLED --format=json 2>/dev/null | jq length)"
    local rep; rep="$(jq -r --arg s "$s" '.[] | select(.name | endswith("/secrets/" + $s)) | if .replication.automatic then "automática" else ([.replication.userManaged.replicas[]?.location] | join(",")) end' "$T/segredos.json")"
    if acessor_do_segredo "$s"; then ok "segredo $s: $nver versão(ões) ativa(s) · réplica $rep · acesso da VM só a ele"
    else pendente "segredo $s: a conta da VM não tem secretAccessor"; fi
    g secrets get-iam-policy "$s" --format=json 2>/dev/null | jq -e '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0' >/dev/null \
      || falha "segredo $s com acesso público"
  done
  local extras; extras="$(jq -r '[.[] | .name | split("/") | last] | join(" ")' "$T/segredos.json")"
  echo "• segredos no projeto: $extras"

  secao "9. Bucket $BUCKET"
  ler_bucket
  local b="$T/bucket.json"
  echo "• $(jq -r '"local \(.location // "?") · classe \(.default_storage_class // .storageClass // "?") · versões \(.versioning_enabled // false) · retenção (soft delete) \(((.soft_delete_policy.retentionDurationSeconds // .softDeletePolicy.retentionDurationSeconds // "0") | tonumber / 86400)) dia(s)"' "$b")"
  [[ "$(jq -r '(.location // "") | ascii_downcase' "$b")" == "$REGION" ]] && ok "região $REGION" || aviso "região do bucket: $(jq -r .location "$b")"
  [[ "$(jq -r '.uniform_bucket_level_access // .iamConfiguration.uniformBucketLevelAccess.enabled // false' "$b")" == true ]] && ok "acesso uniforme (UBLA)" || falha "sem acesso uniforme"
  [[ "$(jq -r '.public_access_prevention // .iamConfiguration.publicAccessPrevention // ""' "$b")" == enforced ]] && ok "prevenção de acesso público: enforced" || falha "prevenção de acesso público não aplicada"
  jq -e '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0' "$T/bucket-iam.json" >/dev/null && ok "IAM do bucket sem acesso público" || falha "bucket com acesso público no IAM"
  if tem_lifecycle_30; then ok "exclusão automática após 30 dias configurada"
  else pendente "exclusão automática após 30 dias (lifecycle) ausente"; fi
  [[ "$(outras_regras_lifecycle)" == 0 ]] || aviso "o bucket tem outras regras de ciclo de vida (não serão alteradas)"
  local pb; pb="$(papeis_no_bucket)"
  echo "• papéis da conta da VM no bucket: ${pb:-nenhum}"
  [[ " $pb " == *" roles/storage.objectCreator "* ]] && ok "conta da VM pode CRIAR objetos (objectCreator)" || pendente "conta da VM sem objectCreator no bucket"
  prob=0; for r in $pb; do [[ "$r" =~ $PAPEIS_PROIBIDOS ]] && { falha "papel amplo demais no bucket: $r (a VM poderia ler/apagar backups)"; prob=1; }; done
  (( prob == 0 )) && ok "conta da VM sem leitura/listagem/exclusão no bucket"
  echo "• conteúdo: $(gcloud storage du -s "$BUCKET" --project="$PROJECT" 2>/dev/null | awk '{print $1" bytes"}' || echo "não lido")"

  secao "10. Isolamento do VerificaPro e de outros projetos"
  local outros; outros="$(gcloud projects list --format=json 2>/dev/null | jq -r --arg p "$PROJECT" '.[] | select(.projectId != $p) | .projectId' | xargs || true)"
  echo "• outros projetos visíveis (NÃO são alterados; todo comando usa --project=$PROJECT): ${outros:-nenhum}"
  local o
  for o in $outros; do
    if gcloud projects get-iam-policy "$o" --format=json > "$T/o.json" 2>/dev/null; then
      jq -e --arg m "serviceAccount:$SA" '[.bindings[]? | select(.members | index($m))] | length == 0' "$T/o.json" >/dev/null \
        && ok "$o: a conta da VM da homologação não tem acesso" || falha "$o: a conta da VM da homologação TEM papel nesse projeto"
    else aviso "$o: IAM não legível com a sua conta (isolamento não verificável daqui)"; fi
  done

  if (( sem_ssh == 0 )); then
    secao "11. Dentro da VM (via IAP, somente leitura)"
    if ssh_vm 'sudo bash -s' < infra/homolog/gcp/vm-inspecao.sh > "$T/inspecao.txt" 2>"$T/inspecao.err"; then
      cat "$T/inspecao.txt"
      OKS=$((OKS + $(grep -c '^✔' "$T/inspecao.txt" || true)))
      AVISOS=$((AVISOS + $(grep -c '^⚠' "$T/inspecao.txt" || true)))
      FALHAS=$((FALHAS + $(grep -c '^✘' "$T/inspecao.txt" || true)))
      grep -q FIM-INSPECAO "$T/inspecao.txt" || falha "inspeção da VM incompleta"
    else
      falha "não foi possível entrar na VM pelo IAP: $(tail -2 "$T/inspecao.err" | xargs)"
    fi
  else echo; echo "(inspeção dentro da VM omitida: --sem-ssh)"; fi

  resumo "AUDITORIA"
}

resumo() {
  secao "Resumo — $1"
  echo "✔ $OKS conferido(s) · ⚠ $AVISOS aviso(s) · ◻ $PENDENTES pendência(s) configurável(is) · ✘ $FALHAS problema(s)"
  if (( ${#DECISOES[@]} > 0 )); then
    echo "Decisões que dependem de você (nada disso é feito automaticamente):"
    printf '  ? %s\n' "${DECISOES[@]}"
  fi
  (( FALHAS == 0 )) || { echo "$1: COM PROBLEMAS — resolva antes de prosseguir"; return 1; }
  echo "$1: OK"
}

# ================================================================ CUSTOS
custos() {
  requisitos
  # Snapshots entram na estimativa SÓ se a agenda existir de fato (estão desativados).
  local snap=()
  if g compute resource-policies describe "$SNAP_POLITICA" --region="$REGION" --format=json >/dev/null 2>&1; then
    snap=(--com-snapshots); echo "• agenda de snapshots $SNAP_POLITICA EXISTE: incluída na estimativa"
  else echo "• snapshots desativados (agenda $SNAP_POLITICA inexistente): fora da estimativa"; fi
  if [[ "${1:-}" == --diagnosticar ]]; then
    secao "Diagnóstico das SKUs de disco e snapshot (só leitura; nenhuma estimativa)"
    CENARIO_TOKEN="$(gcloud auth print-access-token 2>/dev/null)" python3 infra/homolog/gcp/precos_catalogo.py diagnosticar
    return
  fi
  secao "Preços oficiais de lista (Cloud Billing Catalog API, US\$, sem tributos)"
  local rc=0
  CENARIO_TOKEN="$(gcloud auth print-access-token 2>/dev/null)" CENARIO_CONTA="$(gcloud config get-value account 2>/dev/null)" \
    python3 infra/homolog/gcp/precos_catalogo.py obter --limite "$LIMITE_USD" "${snap[@]}" || rc=$?
  cat <<'EOF'

Itens ADICIONAIS e VARIÁVEIS (preços públicos de lista; ver docs/HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md §7):
  Situação        Item                                         Estimativa/mês (US$)
  existente       Bucket de backups (≈1–2 GB, Standard us-east1)    0,02 – 0,05
  existente       Secret Manager (5 versões ativas; 6 gratuitas)    0,00
  existente       IAP (túnel SSH), VPC, firewall, conta de serviço  0,00
  existente       Cloud Logging (cota gratuita 50 GiB)              0,00
  adicional*      Artifact Registry (0,5 GB grátis; US$ 0,10/GB)    0,00 – 0,15
  adicional*      Cloud Build (2.500 min/mês grátis em e2-standard-2) 0,00
  adicional*      Bucket de origem do Cloud Build (alguns MB)       0,00 – 0,01
  variável        Tráfego de saída à internet (1 GB grátis; depois ~US$ 0,12–0,19/GB) 0,00 – 0,60
  variável        Operações de Storage/Secret Manager               < 0,01
  * só na publicação (exige nova autorização). Tributos/câmbio: IOF de 3,5% em cartão
    internacional e variação cambial; NÃO incluídos. O orçamento só avisa, não limita gastos.
EOF
  case "$rc" in
    0) echo; echo "CUSTOS: estimativa base dentro de US\$ $LIMITE_USD (margem pequena: ver variáveis acima)" ;;
    3) echo; echo "CUSTOS: ACIMA de US\$ $LIMITE_USD — alternativas no relatório §7 (sem snapshots, VM parada fora do uso, liberar IP ao encerrar). Nada é contratado."; return 3 ;;
    *) echo; echo "CUSTOS: sem estimativa oficial válida (nenhum preço é presumido)"; return 2 ;;
  esac
}

# ================================================================ CONFIGURAR (só o que falta)
configurar() {
  local com_snap=0; [[ "${1:-}" == --com-snapshots ]] && com_snap=1
  requisitos
  ler_vm; ler_bucket
  local plano=() s lifecycle_manual=0
  if ! tem_lifecycle_30; then
    if [[ "$(outras_regras_lifecycle)" == 0 ]]; then
      plano+=("lifecycle|bucket $BUCKET: excluir objetos após 30 dias (e testes-preparo/ após 1 dia)")
    else
      # Regras existentes nunca são sobrescritas: o ciclo de vida fica como está (ajuste manual) e
      # os demais itens, todos aditivos, seguem.
      lifecycle_manual=1
      echo "⚠ O bucket já tem outras regras de ciclo de vida: NÃO serão alteradas (confira manualmente a exclusão aos 30 dias):"
      jq -c '(.lifecycle_config.rule // .lifecycle.rule // [])[]' "$T/bucket.json" | sed 's/^/    /'
    fi
  fi
  local pb; pb="$(papeis_no_bucket)"
  for s in $pb; do [[ "$s" =~ $PAPEIS_PROIBIDOS ]] && { echo "✘ A conta da VM tem $s no bucket: remova manualmente (nada é removido automaticamente)."; exit 1; }; done
  [[ " $pb " == *" roles/storage.objectCreator "* ]] || plano+=("criador|bucket $BUCKET: conta da VM com roles/storage.objectCreator (só cria; não lê, não lista, não apaga)")
  for s in "${SECRETS[@]}"; do
    acessor_do_segredo "$s" || plano+=("segredo:$s|segredo $s: roles/secretmanager.secretAccessor para a conta da VM (só neste segredo)")
  done
  local falta; falta="$(metadados_faltando | paste -sd, -)"
  [[ -z "$falta" ]] || plano+=("metadados|VM $VM: metadados NÃO secretos: $falta")
  local disco; disco="$(disco_boot)"
  if (( com_snap == 1 )); then
    g compute resource-policies describe "$SNAP_POLITICA" --region="$REGION" --format=json >/dev/null 2>&1 \
      || plano+=("politica|agenda de snapshots $SNAP_POLITICA: diária 06:00 UTC, retenção 7 dias, armazenamento só em $REGION (CUSTO ADICIONAL ~US\$ 0,50–1,40/mês)")
    g compute disks describe "$disco" --zone="$ZONE" --format=json | jq -e --arg p "$SNAP_POLITICA" '(.resourcePolicies // []) | map(split("/") | last) | index($p)' >/dev/null \
      || plano+=("anexar|disco $disco: aplicar a agenda $SNAP_POLITICA")
  fi

  secao "Plano de configuração (somente recursos existentes; nada é criado além do listado)"
  if (( ${#plano[@]} == 0 )); then
    echo "✔ Nada a configurar: tudo já está como deveria."
    (( lifecycle_manual == 0 )) || echo "⚠ exceto o ciclo de vida do bucket (regras próprias mantidas; conferir manualmente)"
    echo "CONFIGURAÇÃO: OK"; return 0
  fi
  local i k; for i in "${plano[@]}"; do echo "  • ${i#*|}"; done
  echo "NÃO será feito: abrir portas, criar VM/IP/firewall/Artifact Registry, alterar DNS, iniciar serviços, ler segredos."
  confirmar "configurar $PROJECT"

  for i in "${plano[@]}"; do
    case "${i%%|*}" in
      lifecycle) gcloud storage buckets update "$BUCKET" --project="$PROJECT" --lifecycle-file=infra/homolog/gcp/lifecycle-30d.json --quiet ;;
      criador) gcloud storage buckets add-iam-policy-binding "$BUCKET" --project="$PROJECT" --member="serviceAccount:$SA" --role=roles/storage.objectCreator --format=none --quiet ;;
      segredo:*) k="${i%%|*}"; g secrets add-iam-policy-binding "${k#segredo:}" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --format=none --quiet ;;
      metadados) g compute instances add-metadata "$VM" --zone="$ZONE" --metadata="$falta" --quiet ;;
      politica) g compute resource-policies create snapshot-schedule "$SNAP_POLITICA" --region="$REGION" \
                  --daily-schedule --start-time=06:00 --max-retention-days=7 \
                  --on-source-disk-delete=apply-retention-policy --storage-location="$REGION" --quiet ;;
      anexar) g compute disks add-resource-policies "$disco" --zone="$ZONE" --resource-policies="$SNAP_POLITICA" --quiet ;;
    esac
    echo "✔ ${i#*|}"
  done
  # Confere relendo o estado real.
  ler_vm; ler_bucket
  local erros=0
  (( lifecycle_manual == 1 )) || tem_lifecycle_30 || { echo "✘ lifecycle não confirmado"; erros=$((erros + 1)); }
  [[ " $(papeis_no_bucket) " == *" roles/storage.objectCreator "* ]] || { echo "✘ objectCreator não confirmado"; erros=$((erros + 1)); }
  for s in "${SECRETS[@]}"; do acessor_do_segredo "$s" || { echo "✘ secretAccessor em $s não confirmado"; erros=$((erros + 1)); }; done
  [[ -z "$(metadados_faltando)" ]] || { echo "✘ metadados não confirmados"; erros=$((erros + 1)); }
  (( erros == 0 )) && echo "CONFIGURAÇÃO: OK (conferida relendo o estado real)" || { echo "CONFIGURAÇÃO: $erros problema(s)"; return 1; }
}

# ================================================================ PREPARAR A VM (sem iniciar nada)
preparar_vm() {
  requisitos
  [[ -z "$(git status --porcelain -- infra/homolog scripts/backup.sh scripts/restore.sh)" ]] \
    || { echo "✘ Há mudanças não commitadas em infra/homolog ou scripts/: faça commit antes (a VM recebe exatamente um commit)."; exit 1; }
  local commit; commit="$(git rev-parse --short=12 HEAD)"
  ler_vm
  [[ "$(jq -r .status "$T/vm.json")" == RUNNING ]] || { echo "✘ VM não está RUNNING"; exit 1; }
  local estado; estado="$(ssh_vm "test -f $PORTAO && echo PORTAO-ABERTO || echo PORTAO-FECHADO" < /dev/null 2>/dev/null | tail -1)"
  [[ "$estado" == PORTAO-FECHADO ]] || { echo "✘ Portão da VM: '${estado:-sem resposta}'. Com a publicação autorizada, use 'operador.sh atualizar-config' e a sequência 'operador.sh passo …'. Nada foi copiado."; exit 1; }
  secao "Preparação da VM $VM com o commit $commit"
  cat <<EOF
  • copia infra/homolog e scripts/backup.sh + restore.sh do commit para /opt/cenario
    (o conteúdo anterior, se houver, é guardado em /opt/cenario.anterior-<data> para reversão)
  • executa infra/homolog/gcp/startup.sh: mantém Docker e swap existentes, ativa atualizações
    automáticas de segurança e instala os serviços systemd COM o portão fechado
  NÃO inicia contêineres, PostgreSQL, migrations nem abre portas.
EOF
  confirmar "preparar $VM"
  git archive --format=tar.gz -o "$T/pacote.tgz" HEAD infra/homolog scripts/backup.sh scripts/restore.sh
  g compute scp "$T/pacote.tgz" "$VM:/tmp/cenario-pacote.tgz" --zone="$ZONE" --tunnel-through-iap --quiet
  ssh_vm "sudo CENARIO_COMMIT=$commit bash -s" <<'REMOTO'
set -euo pipefail
test ! -f /etc/cenario/publicacao-autorizada || { echo "portão aberto: abortado"; exit 1; }
rm -rf /opt/cenario.novo
install -d -m 755 /opt/cenario.novo
tar -xzf /tmp/cenario-pacote.tgz -C /opt/cenario.novo
echo "$CENARIO_COMMIT" > /opt/cenario.novo/VERSAO
chmod 755 /opt/cenario.novo/infra/homolog/gcp/*.sh
# Nada é apagado: uma versão anterior (ou qualquer conteúdo pré-existente) é guardada com data.
if [ -d /opt/cenario ]; then
  if [ -z "$(ls -A /opt/cenario)" ]; then rmdir /opt/cenario
  else mv -T /opt/cenario "/opt/cenario.anterior-$(date -u +%Y%m%dT%H%M%S.%NZ)"; fi
fi
mv -T /opt/cenario.novo /opt/cenario
rm -f /tmp/cenario-pacote.tgz
bash /opt/cenario/infra/homolog/gcp/startup.sh
echo "contêineres em execução: $(docker ps -q | wc -l)"
REMOTO
  echo "PREPARAÇÃO DA VM: OK (commit $commit; nada foi iniciado)"
}

# ================================================================ TESTAR CONFIGURAÇÕES (sem iniciar)
testar_config() {
  requisitos
  local erros=0 f
  secao "No Cloud Shell"
  for f in infra/homolog/gcp/*.sh scripts/backup.sh scripts/restore.sh; do
    bash -n "$f" && ok "sintaxe $f" || { falha "sintaxe $f"; erros=$((erros + 1)); }
  done
  jq -e '.rule | length > 0' infra/homolog/gcp/lifecycle-30d.json >/dev/null && ok "lifecycle-30d.json válido" || { falha "lifecycle-30d.json"; erros=$((erros + 1)); }
  if python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); assert d["steps"] and d["images"]' infra/homolog/gcp/cloudbuild.yaml \
      && ok "cloudbuild.yaml válido (não executado)" || { falha "cloudbuild.yaml"; erros=$((erros + 1)); }
  else aviso "PyYAML ausente: cloudbuild.yaml não validado aqui"; fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    printf '%s\n' "HOMOLOG_DOMAIN='teste.exemplo.invalid'" "POSTGRES_PASSWORD='ficticio'" "TOKEN_HASH_SECRET='ficticio-ficticio-ficticio-ficticio'" \
      "HOMOLOG_BASIC_USER='homologacao'" "HOMOLOG_BASIC_HASH='ficticio'" "HOMOLOG_GATE_TOKEN='0000'" > "$T/env-ficticio"
    docker compose -f infra/homolog/docker-compose.homolog.yml --env-file "$T/env-ficticio" config -q \
      && ok "docker-compose.homolog.yml válido (valores fictícios; nada iniciado)" || { falha "docker-compose.homolog.yml"; erros=$((erros + 1)); }
  else aviso "Docker Compose ausente no Cloud Shell: validação feita na VM"; fi
  sondar_portas
  secao "Na VM (via IAP; nada é iniciado)"
  if ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh verificar-preparo" < /dev/null > "$T/preparo.txt" 2>&1; then cat "$T/preparo.txt"
  else cat "$T/preparo.txt"; falha "verificação na VM com problemas (ou preparar-vm não executado)"; fi
  resumo "TESTE DAS CONFIGURAÇÕES"
}

# ================================================================ RELATÓRIO
relatorio() {
  secao "Etapas executadas (registros em $RELDIR)"
  local e linha
  for e in auditar custos configurar preparar-vm testar-config; do
    if [[ -f "$RELDIR/estado/$e" ]]; then read -r linha < "$RELDIR/estado/$e"; echo "  $e: $linha"
    else echo "  $e: não executada"; fi
  done
  # Sentinela: nenhum registro deve conter algo com cara de segredo (token hexadecimal de 64).
  if grep -lE '\b[0-9a-f]{64}\b' "$RELDIR"/*.log >/dev/null 2>&1; then echo "✘ algum registro contém sequência com formato de token: revise antes de compartilhar"
  else echo "✔ registros sem sequências com formato de token"; fi
  echo
  echo "NENHUMA PUBLICAÇÃO FOI FEITA: portas 80/443 fechadas, DNS inalterado, PostgreSQL e aplicação"
  echo "não iniciados. Próximo passo só com autorização explícita (veja: homolog.sh plano-publicacao)."
}

plano_publicacao() {
  cat <<EOF
SOMENTE APÓS AUTORIZAÇÃO EXPLÍCITA. Nada abaixo é executado por este script.
 0. (se a auditoria apontou) escopos da VM → cloud-platform (para a VM ~2 min; IP estático mantido):
      gcloud compute instances stop $VM --zone=$ZONE --project=$PROJECT
      gcloud compute instances set-service-account $VM --zone=$ZONE --project=$PROJECT --service-account=$SA --scopes=cloud-platform
      gcloud compute instances start $VM --zone=$ZONE --project=$PROJECT
 1. Artifact Registry + Cloud Build (custo adicional pequeno; ver §7):
      gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com --project=$PROJECT
      gcloud artifacts repositories create cenario-homolog --repository-format=docker --location=$REGION --project=$PROJECT
      gcloud artifacts repositories add-iam-policy-binding cenario-homolog --location=$REGION --project=$PROJECT \\
        --member=serviceAccount:$SA --role=roles/artifactregistry.reader
      bash infra/homolog/gcp/operador.sh build
 2. DNS na Hostinger: registro A  teste  →  $IP_EXTERNO  (TTL 300)
 3. Firewall 80/443 (necessário ao Let's Encrypt e ao acesso; a autenticação do proxy protege o resto):
      gcloud compute firewall-rules create cenario-homolog-web --project=$PROJECT --network=$VPC \\
        --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=$TAG_REDE
 4. Etiqueta das imagens e abertura do portão (inicia PostgreSQL, migrations e a aplicação):
      gcloud compute instances add-metadata $VM --zone=$ZONE --project=$PROJECT --metadata=cenario-tag=<commit>
      gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --tunnel-through-iap --command='sudo touch $PORTAO && sudo systemctl start cenario-homolog.service'
 5. Verificação: operador.sh saude · vm.sh semear (uma vez) · E2E · backup → bucket → restauração de teste
Despublicar (reversível, dados preservados):
      gcloud compute ssh $VM ... --command='sudo systemctl stop cenario-homolog.service && sudo rm -f $PORTAO'
      gcloud compute firewall-rules delete cenario-homolog-web --project=$PROJECT
      (opcional) remover o registro A na Hostinger
EOF
}

plano_encerramento() {
  cat <<EOF
SOMENTE IMPRIME. Execute item a item, conferindo, e só quando decidir encerrar.
Pausar (para de cobrar a VM; disco US\$ ~2/mês e o IP passa a US\$ 0,01/h ≈ US\$ 7,30/mês enquanto parado):
  gcloud compute instances stop $VM --zone=$ZONE --project=$PROJECT
Encerrar tudo (irreversível — baixe antes o que quiser guardar):
  gcloud storage cp -r $BUCKET/backups ./backups-homologacao --project=$PROJECT
  gcloud compute instances delete $VM --zone=$ZONE --project=$PROJECT          # disco apaga junto se autoDelete=true
  gcloud compute disks list --project=$PROJECT                                  # confirme: nenhum disco órfão
  gcloud compute addresses list --project=$PROJECT --filter="address=$IP_EXTERNO"  # e libere o IP pelo nome:
  gcloud compute addresses delete <nome-do-ip> --region=$REGION --project=$PROJECT
  gcloud compute snapshots list --project=$PROJECT  # apague os snapshots listados, se houver
  gcloud compute resource-policies delete $SNAP_POLITICA --region=$REGION --project=$PROJECT  # se criada
  gcloud storage rm -r $BUCKET --project=$PROJECT
  for s in ${SECRETS[*]}; do gcloud secrets delete \$s --project=$PROJECT; done
  gcloud iam service-accounts delete $SA --project=$PROJECT
  gcloud compute firewall-rules delete $FW_IAP --project=$PROJECT  (e cenario-homolog-web, se criada)
  gcloud compute networks subnets delete $SUBNET --region=$REGION --project=$PROJECT
  gcloud compute networks delete $VPC --project=$PROJECT
  (se publicados) gcloud artifacts repositories delete cenario-homolog --location=$REGION --project=$PROJECT
                  gcloud storage rm -r gs://${PROJECT}_cloudbuild --project=$PROJECT
  DNS: remover o registro A "teste" na Hostinger.
Conferência final: Faturamento → Relatórios, filtrando o projeto $PROJECT, por 2–3 dias.
EOF
}

# ================================================================ execução com registro
executar() { # executar <etapa> [args] — registra a saída e o código de saída da etapa
  local etapa="$1"; shift
  install -d -m 700 "$RELDIR/estado"
  local log; log="$RELDIR/$etapa-$(date -u +%Y%m%dT%H%M%SZ).log"
  local rc=0
  set +e
  ( "${etapa//-/_}" "$@" ) 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  set -e
  chmod 600 "$log"
  echo "rc=$rc em $(date -u +%FT%TZ) · $log" > "$RELDIR/estado/$etapa"
  return "$rc"
}

case "${1:-}" in
  auditar|custos|configurar|preparar-vm|testar-config) e="$1"; shift; executar "$e" "$@" ;;
  relatorio) relatorio ;;
  tudo)
    shift
    executar auditar
    executar custos
    executar configurar "$@"
    executar preparar-vm
    executar testar-config
    relatorio
    ;;
  plano-publicacao) plano_publicacao ;;
  plano-encerramento) plano_encerramento ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
