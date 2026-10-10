#!/usr/bin/env bash
# Auditoria SOMENTE LEITURA da homologação real, para o Cloud Shell (Evolução — pré-deploy).
# Só comandos describe/list/get-iam-policy e a inspeção da VM via IAP (vm-auditoria.sh, também
# só leitura). NÃO cria, altera, inicia, para ou apaga nada; NÃO lê valores de segredos; NÃO
# executa Cloud Build, migrations, backup ou restauração. Resultado na tela e em
# auditoria-homolog-<data>.txt (diretório atual).
#
# Uso (na raiz do repositório, no commit a publicar):  bash infra/homolog/gcp/auditoria-pre-deploy.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
PROJECT="${CENARIO_PROJECT:-cenariogestao}"
REGION="${CENARIO_REGION:-us-east1}"
ZONE="${CENARIO_ZONE:-us-east1-b}"
VM="${CENARIO_VM:-cenario-homolog}"
REPO="${CENARIO_REPO:-cenario-homolog}"
DOMAIN="${CENARIO_DOMAIN:-teste.cenariogestao.com.br}"
PUBLICADA="${CENARIO_PUBLICADA:-fd6dc19}"
CANDIDATA="${CENARIO_CANDIDATA:-$(git rev-parse --short HEAD)}"
SECRETS=(homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token)
SAIDA="auditoria-homolog-$(date -u +%Y%m%dT%H%M%SZ).txt"
exec > >(tee "$SAIDA") 2>&1
g() { gcloud "$@" --project="$PROJECT"; }
secao() { echo; echo "================ $*"; }

secao "Conta e projeto"
echo "• conta ativa: $(gcloud config get-value account 2>/dev/null)"
echo "• projeto configurado: $(gcloud config get-value project 2>/dev/null) · auditado: $PROJECT"
g projects describe "$PROJECT" --format='value(lifecycleState,projectNumber)' | sed 's/^/• estado e número: /'
gcloud billing projects describe "$PROJECT" --format='value(billingEnabled,billingAccountName)' 2>/dev/null \
  | sed 's/^/• faturamento (ativo, conta): /' || echo "• faturamento: sem permissão de leitura (ok)"

secao "VM $VM"
g compute instances describe "$VM" --zone="$ZONE" --format=json > /tmp/aud-vm.json || { echo "✘ VM não encontrada"; }
if [[ -s /tmp/aud-vm.json ]]; then
  jq -r '"• estado: \(.status) · tipo: \(.machineType|split("/")|last) · criada: \(.creationTimestamp)",
         "• conta de serviço: \(.serviceAccounts[0].email) · escopos: \(.serviceAccounts[0].scopes|map(split("/")|last)|join(","))",
         "• rede: \(.networkInterfaces[0].network|split("/")|last) · IP externo: \(.networkInterfaces[0].accessConfigs[0].natIP // "nenhum") · tags: \(.tags.items // []|join(","))",
         "• discos: \([.disks[]|"\(.deviceName)(\(.diskSizeGb) GB)"]|join(", "))"' /tmp/aud-vm.json
  echo "• metadados cenario-* (sem valores pessoais):"
  jq -r '.metadata.items[]? | select(.key|startswith("cenario-")) |
    "    \(.key) = \(if (.key=="cenario-admin-email") then "(definido)" else .value end)"' /tmp/aud-vm.json
  echo "• cenario-tag esperado ANTES da atualização: $PUBLICADA"
fi
g compute disks list --filter="zone:($ZONE)" --format='table(name,sizeGb,type.basename(),status)'
g compute resource-policies list --format='table(name,region.basename(),snapshotSchedulePolicy.schedule)' 2>/dev/null || true

secao "Rede e firewall"
g compute firewall-rules list --format='table(name,network.basename(),direction,sourceRanges.list(),allowed[].map().firewall_rule().list(),targetTags.list(),disabled)'
echo "• DNS público de $DOMAIN: $(getent hosts "$DOMAIN" | awk '{print $1}' | xargs)"

secao "Secret Manager (nomes e permissões; valores NÃO lidos)"
SA="$(jq -r '.serviceAccounts[0].email' /tmp/aud-vm.json 2>/dev/null)"
for s in "${SECRETS[@]}"; do
  if g secrets describe "$s" --format='value(name)' >/dev/null 2>&1; then
    v="$(g secrets versions list "$s" --filter='state=ENABLED' --format='value(name)' | wc -l)"
    a="$(g secrets get-iam-policy "$s" --format=json | jq -r --arg sa "serviceAccount:$SA" \
      '[.bindings[]? | select(.members|index($sa)) | .role] | join(",")')"
    echo "• $s: $v versão(ões) ativa(s) · conta da VM: ${a:-SEM papel}"
  else echo "✘ $s: ausente"; fi
done

secao "Artifact Registry ($REGION/$REPO)"
g artifacts repositories describe "$REPO" --location="$REGION" --format='value(format,sizeBytes,createTime)' | sed 's/^/• formato, tamanho, criado: /'
g artifacts docker images list "$REGION-docker.pkg.dev/$PROJECT/$REPO" --include-tags \
  --format='table(package.basename(),tags,version.basename():label=DIGEST,createTime.date())' --sort-by=~createTime --limit=12
for t in "$PUBLICADA" "$CANDIDATA"; do
  for x in api web; do
    d="$(g artifacts docker images describe "$REGION-docker.pkg.dev/$PROJECT/$REPO/$x:$t" --format='value(image_summary.digest)' 2>/dev/null)"
    echo "• $x:$t → ${d:-NÃO PUBLICADA}"
  done
done
g artifacts repositories get-iam-policy "$REPO" --location="$REGION" --format=json \
  | jq -r '.bindings[]? | "• \(.role): \(.members|join(", "))"'

secao "Bucket de backups"
B="$(jq -r '.metadata.items[]? | select(.key=="cenario-bucket") | .value' /tmp/aud-vm.json 2>/dev/null)"
if [[ -n "$B" ]]; then
  gcloud storage buckets describe "$B" --format='value(location,storage_class,uniform_bucket_level_access,lifecycle_config.rule)' | sed 's/^/• local, classe, acesso uniforme, ciclo de vida: /'
  gcloud storage buckets get-iam-policy "$B" --format=json | jq -r '.bindings[]? | "• \(.role): \(.members|join(", "))"'
  echo "• backups no bucket (10 mais recentes):"
  gcloud storage ls -l "$B/backups/" 2>/dev/null | sort -k2 | tail -10 | sed 's/^/    /'
else echo "✘ metadado cenario-bucket ausente"; fi

secao "Dentro da VM (IAP, somente leitura)"
{ printf 'PREFLIGHT_SQL=$(cat <<'"'"'SQLFIM'"'"'\n'; cat infra/homolog/gcp/sql/preflight-evolucao.sql; printf 'SQLFIM\n)\n'
  cat infra/homolog/gcp/vm-auditoria.sh; } \
  | g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command='sudo bash -s'

secao "Resumo"
echo "✔ $(grep -c '^✔\|^    ✔' "$SAIDA") · ⚠ $(grep -c '^⚠' "$SAIDA") · ✘ $(grep -c '^✘\|^    ✘' "$SAIDA")"
echo "Relatório: $SAIDA (não contém segredos). Nada foi alterado."
