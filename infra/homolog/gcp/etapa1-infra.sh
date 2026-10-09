#!/usr/bin/env bash
# ETAPA 1 da homologação no Google Cloud: SOMENTE a infraestrutura mínima, sem publicar o sistema.
# Executar no Cloud Shell (ou num computador com o gcloud autenticado na conta dona do projeto),
# na raiz do repositório:
#
#   bash infra/homolog/gcp/etapa1-infra.sh verificar        # só leitura: conta, projeto, faturamento,
#                                                           # orçamentos, permissões, colisões, preços
#   bash infra/homolog/gcp/etapa1-infra.sh planejar         # mostra exatamente o que será criado e o custo
#   bash infra/homolog/gcp/etapa1-infra.sh criar            # cria (pede para digitar o nome do projeto)
#   bash infra/homolog/gcp/etapa1-infra.sh verificar-infra  # confere o que foi criado (nada exposto)
#   bash infra/homolog/gcp/etapa1-infra.sh encerrar         # apaga TUDO o que a Etapa 1 criou
#
# Cria apenas: APIs necessárias, conta de serviço exclusiva, 5 segredos (Secret Manager), bucket
# privado de backups, IP estático, firewall mínimo (só SSH pelo IAP; todo o resto bloqueado),
# VM e2-small com disco pd-balanced de 20 GB e agenda de snapshots. NÃO cria balanceador, Cloud SQL,
# Artifact Registry, regras 80/443 nem DNS; NÃO publica a aplicação (Etapa 2).
# Opera exclusivamente no projeto "cenariogestao" (recusa qualquer outro). Nenhum segredo é exibido.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROJECT=cenariogestao
REGION=us-east1
ZONE=us-east1-b
VM=cenario-homolog
SA_NAME=cenario-homolog-vm
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
BUCKET="gs://cenariogestao-homolog-backups"
DOMAIN=teste.cenariogestao.com.br
ADMIN_EMAIL=gestor@teste.cenariogestao.com.br
SECRETS=(homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token)
APIS=(compute.googleapis.com iam.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com)
LOG="etapa1-$(date -u +%Y%m%dT%H%M%SZ).log"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
ok() { echo "✔ $*"; }
aviso() { echo "⚠ $*"; }
falha() { echo "✘ $*"; FALHAS=$((FALHAS + 1)); }
FALHAS=0
token() { gcloud auth print-access-token 2>/dev/null; } # usado só em cabeçalhos; nunca exibido
api_get() { curl -fsS -H "Authorization: Bearer $(token)" "$1"; }

verificar() {
  echo "== Conta e projeto"
  local conta; conta="$(gcloud config get-value account 2>/dev/null || true)"
  [[ -n "$conta" ]] && ok "conta autenticada: $conta" || { falha "nenhuma conta autenticada (gcloud auth login)"; return; }
  local num estado
  num="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)"
  estado="$(gcloud projects describe "$PROJECT" --format='value(lifecycleState)' 2>/dev/null || true)"
  [[ -n "$num" && "$estado" == ACTIVE ]] && ok "projeto $PROJECT ativo (número $num)" || { falha "projeto $PROJECT inacessível"; return; }
  local ativo; ativo="$(gcloud config get-value project 2>/dev/null || true)"
  [[ "$ativo" == "$PROJECT" ]] || aviso "projeto padrão do gcloud é '${ativo:-nenhum}': este script usa sempre --project=$PROJECT"

  echo "== Faturamento"
  local fat conta_fat
  fat="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)"
  conta_fat="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#billingAccounts/##' || true)"
  [[ "$fat" == True ]] && ok "faturamento ativo; conta de faturamento $conta_fat" || falha "faturamento não ativo no projeto"
  if [[ -n "$conta_fat" ]]; then
    local orc
    if orc="$(gcloud billing budgets list --billing-account="$conta_fat" --format=json 2>/dev/null)"; then
      ORC="$orc" python3 - "$num" <<'EOF'
import json, os, sys
num = sys.argv[1]
b = json.loads(os.environ.get("ORC") or "[]")
if not b:
    print("⚠ nenhum orçamento na conta de faturamento")
for x in b:
    projs = (x.get("budgetFilter") or {}).get("projects") or []
    alvo = "TODOS os projetos da conta" if not projs else ", ".join(projs)
    so_cenario = projs == [f"projects/{num}"]
    amt = (x.get("amount") or {}).get("specifiedAmount") or {}
    limites = [str(round(t.get("thresholdPercent", 0) * 100)) + "%" for t in x.get("thresholdRules", [])]
    marca = "✔" if so_cenario else "⚠"
    print(f"{marca} orçamento '{x.get('displayName')}': {amt.get('units','?')} {amt.get('currencyCode','')}, alertas {limites}, escopo: {alvo}")
EOF
    else
      aviso "não foi possível ler os orçamentos (API billingbudgets ou permissão de leitura da conta de faturamento). Confira no console: Faturamento → Orçamentos e alertas → escopo = somente o projeto $PROJECT"
    fi
  fi

  echo "== Permissões da sua conta no projeto"
  local perms='["compute.instances.create","compute.addresses.create","compute.firewalls.create","compute.resourcePolicies.create","iam.serviceAccounts.create","resourcemanager.projects.setIamPolicy","secretmanager.secrets.create","secretmanager.secrets.setIamPolicy","storage.buckets.create","serviceusage.services.enable","iap.tunnelInstances.accessViaIAP"]'
  local tem
  tem="$(curl -fsS -X POST -H "Authorization: Bearer $(token)" -H 'content-type: application/json' \
    -d "{\"permissions\": $perms}" "https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT:testIamPermissions" 2>/dev/null || echo '{}')"
  python3 - "$perms" "$tem" <<'EOF'
import json, sys
pedidas = json.loads(sys.argv[1]); tem = set(json.loads(sys.argv[2]).get("permissions", []))
for p in pedidas:
    print(("✔ " if p in tem else "✘ FALTA ") + p)
EOF
  [[ "$(python3 -c "import json,sys;print(len(json.loads(sys.argv[1]).get('permissions',[])))" "$tem")" == 11 ]] || FALHAS=$((FALHAS + 1))

  echo "== APIs habilitadas (as que faltarem serão habilitadas no 'criar')"
  local hab; hab="$(g services list --enabled --format='value(config.name)' 2>/dev/null || true)"
  for a in "${APIS[@]}"; do grep -qx "$a" <<<"$hab" && ok "$a" || aviso "$a ainda não habilitada"; done

  echo "== Recursos com os nomes da homologação (colisões) e isolamento do VerificaPro"
  if grep -qx compute.googleapis.com <<<"$hab"; then
    g compute instances list --filter="name=$VM" --format='value(name,zone,status)' | sed 's/^/• já existe VM: /' || true
    g compute addresses list --filter="name=$VM-ip" --format='value(name,address)' | sed 's/^/• já existe IP: /' || true
    g compute firewall-rules list --filter="name~^$VM" --format='value(name)' | sed 's/^/• já existe regra: /' || true
    g compute networks subnets describe default --region="$REGION" --format='value(ipCidrRange)' >/dev/null 2>&1 \
      && ok "rede 'default' com sub-rede em $REGION" || falha "rede 'default' sem sub-rede em $REGION (o 'criar' não conseguirá criar a VM)"
    echo "• todas as VMs do projeto $PROJECT:"; g compute instances list --format='value(name,zone,status)' | sed 's/^/    /' || true
  fi
  if gcloud storage buckets describe "$BUCKET" --format='value(name)' >/dev/null 2>&1; then
    local dono; dono="$(gcloud storage buckets describe "$BUCKET" --format='value(project_number)' 2>/dev/null || true)"
    [[ "$dono" == "$num" ]] && aviso "bucket $BUCKET já existe neste projeto (será reaproveitado)" || falha "bucket $BUCKET existe em OUTRO projeto: escolha outro nome"
  else ok "nome do bucket $BUCKET disponível"; fi
  local outros; outros="$(gcloud projects list --format='value(projectId)' 2>/dev/null | grep -vx "$PROJECT" | tr '\n' ' ' || true)"
  ok "outros projetos visíveis (NÃO serão tocados: todo comando usa --project=$PROJECT): ${outros:-nenhum}"

  echo "== Preços oficiais (catálogo do Cloud Billing, US$, sem tributos)"
  precos || aviso "catálogo indisponível: confira na calculadora (entradas em docs/HOMOLOGACAO-GCP-ETAPA1.md §3)"

  echo; (( FALHAS == 0 )) && echo "VERIFICAÇÃO: OK" || echo "VERIFICAÇÃO: $FALHAS problema(s) — não prossiga"
  return "$FALHAS"
}

# Lê o catálogo oficial de SKUs do Compute Engine (preço de lista) e calcula o mês da Etapa 1.
precos() {
  local t; t="$(token)"; [[ -n "$t" ]] || return 1
  CENARIO_TOKEN="$t" python3 - <<'EOF'
import json, os, urllib.request
tok = os.environ["CENARIO_TOKEN"]
def get(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    return json.load(urllib.request.urlopen(req, timeout=30))
skus, page = [], ""
while True:
    d = get(f"https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?currencyCode=USD&pageSize=5000&pageToken={page}")
    skus += d.get("skus", []); page = d.get("nextPageToken", "")
    if not page: break
def unit(desc_pred, region="us-east1"):
    for s in skus:
        if desc_pred(s["description"]) and region in s.get("serviceRegions", []) and s["category"].get("usageType") == "OnDemand":
            p = s["pricingInfo"][0]["pricingExpression"]["tieredRates"][-1]["unitPrice"]
            return int(p.get("units", 0)) + p.get("nanos", 0) / 1e9, s["description"]
    return None, None
core, dc = unit(lambda d: d.startswith("E2 Instance Core running in"))
ram, dr = unit(lambda d: d.startswith("E2 Instance Ram running in"))
pd, dp = unit(lambda d: d.startswith("Balanced PD Capacity"))
snap, ds = unit(lambda d: "Snapshot" in d and "Regional" not in d and "Multi" not in d and "Archive" not in d)
ip, di = unit(lambda d: d.startswith("External IP Charge on a Standard VM"), region="global")
if ip is None: ip, di = unit(lambda d: "External IP Charge on a Standard VM" in d, region="us-east1")
h = 730
linhas = []
if core and ram: linhas.append(("VM e2-small (0,5 vCPU-equivalente + 2 GB)", (0.5 * core + 2 * ram) * h, f"{dc}; {dr}"))
if pd: linhas.append(("Disco pd-balanced 20 GB", 20 * pd, dp))
if ip: linhas.append(("IPv4 estático em uso", ip * h, di))
if snap: linhas.append(("Snapshots (~10 GB armazenados)", 10 * snap, ds))
total = sum(v for _, v, _ in linhas)
for n, v, d in linhas: print(f"  {n:45s} US$ {v:6.2f}   [{d}]")
print(f"  {'Bucket, segredos, IAP, logs (cotas gratuitas)':45s} US$   0.00")
print(f"  {'TOTAL Etapa 1 (sem tributos)':45s} US$ {total:6.2f}")
if total > 22: print("⚠ ACIMA do limite combinado (~US$ 20): NÃO prossiga sem nova autorização")
EOF
}

planejar() {
  cat <<EOF
Projeto: $PROJECT · Região: $REGION · Zona: $ZONE
Será criado (Etapa 1), apenas se ainda não existir:
  1. APIs: ${APIS[*]}
  2. Conta de serviço $SA (sem chaves), com:
     - secretmanager.secretAccessor somente nos 5 segredos
     - storage.objectCreator somente no bucket (cria; não lê nem apaga)
     - logging.logWriter no projeto
  3. Segredos (us-east1, valores aleatórios, nunca exibidos): ${SECRETS[*]}
  4. Bucket $BUCKET: us-east1, Standard, acesso uniforme, prevenção de acesso público, exclusão após 30 dias
  5. IP estático $VM-ip (us-east1)
  6. Firewall: $VM-iap-ssh (permite TCP 22 só de 35.235.240.0/20, prioridade 900) e
     $VM-bloqueio (nega TODO o resto de entrada para a VM, prioridade 1000 — neutraliza regras padrão da rede)
  7. VM $VM: e2-small, Debian 12, pd-balanced 20 GB, Shielded VM, OS Login, IP estático,
     conta de serviço exclusiva; script de partida instala Docker e swap (NENHUM serviço do sistema é iniciado)
  8. Agenda de snapshots $VM-diario (diária, 7 dias) no disco da VM
NÃO cria: Artifact Registry, Cloud Build, regras 80/443, balanceador, Cloud SQL, DNS.
EOF
  echo "Custo (preços oficiais do catálogo):"; precos || echo "  (catálogo indisponível — ver docs/HOMOLOGACAO-GCP-ETAPA1.md §3)"
}

criar() {
  FALHAS=0
  verificar || { echo "Verificação com problemas: nada foi criado."; exit 1; }
  planejar
  read -r -p "Para criar, digite o nome do projeto ($PROJECT): " r
  [[ "$r" == "$PROJECT" ]] || { echo "Cancelado. Nada foi criado."; exit 1; }
  exec > >(tee -a "$LOG") 2>&1
  echo "== $(date -u +%FT%TZ) início da criação (registro: $LOG)"

  g services enable "${APIS[@]}"
  ok "APIs habilitadas"

  g iam service-accounts describe "$SA" >/dev/null 2>&1 || g iam service-accounts create "$SA_NAME" --display-name="VM homologação Cenário (Etapa 1)"
  ok "conta de serviço $SA"

  printf 'sim\n' | CENARIO_PROJECT=$PROJECT CENARIO_REGION=$REGION bash infra/homolog/gcp/operador.sh criar-segredos
  for s in "${SECRETS[@]}"; do
    g secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --format=none
  done
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/logging.logWriter --condition=None --format=none
  ok "segredos e permissões"

  if ! gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1; then
    g storage buckets create "$BUCKET" --location="$REGION" --default-storage-class=STANDARD \
      --uniform-bucket-level-access --public-access-prevention
  fi
  g storage buckets update "$BUCKET" --lifecycle-file=infra/homolog/gcp/lifecycle-30d.json
  g storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectCreator --format=none
  ok "bucket privado $BUCKET"

  g compute addresses describe "$VM-ip" --region="$REGION" >/dev/null 2>&1 || g compute addresses create "$VM-ip" --region="$REGION"
  ok "IP estático $(g compute addresses describe "$VM-ip" --region="$REGION" --format='value(address)')"

  g compute firewall-rules describe "$VM-iap-ssh" >/dev/null 2>&1 || g compute firewall-rules create "$VM-iap-ssh" \
    --network=default --direction=INGRESS --priority=900 --action=ALLOW --rules=tcp:22 \
    --source-ranges=35.235.240.0/20 --target-tags="$VM"
  g compute firewall-rules describe "$VM-bloqueio" >/dev/null 2>&1 || g compute firewall-rules create "$VM-bloqueio" \
    --network=default --direction=INGRESS --priority=1000 --action=DENY --rules=all \
    --source-ranges=0.0.0.0/0 --target-tags="$VM"
  ok "firewall mínimo (SSH só pelo IAP; todo o resto bloqueado)"

  if ! g compute instances describe "$VM" --zone="$ZONE" >/dev/null 2>&1; then
    g compute instances create "$VM" --zone="$ZONE" --machine-type=e2-small \
      --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size=20GB --boot-disk-type=pd-balanced --boot-disk-auto-delete \
      --address="$VM-ip" --tags="$VM" --service-account="$SA" --scopes=cloud-platform \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
      --metadata="enable-oslogin=TRUE,cenario-project=$PROJECT,cenario-region=$REGION,cenario-repo=cenario-homolog,cenario-domain=$DOMAIN,cenario-bucket=$BUCKET,cenario-basic-user=homologacao,cenario-admin-email=$ADMIN_EMAIL" \
      --metadata-from-file=startup-script=infra/homolog/gcp/startup.sh
  fi
  ok "VM $VM"

  g compute resource-policies describe "$VM-diario" --region="$REGION" >/dev/null 2>&1 || \
    g compute resource-policies create snapshot-schedule "$VM-diario" --region="$REGION" \
      --daily-schedule --start-time=06:00 --max-retention-days=7 --on-source-disk-delete=apply-retention-policy
  g compute disks add-resource-policies "$VM" --zone="$ZONE" --resource-policies="$VM-diario" 2>/dev/null || true
  ok "snapshots diários (7 dias)"
  echo "== $(date -u +%FT%TZ) criação concluída. Aguarde ~3 min (instalação do Docker) e rode: verificar-infra"
}

verificar_infra() {
  FALHAS=0
  echo "== VM"
  local st mt sa sb ip sz tp rp pap ubla loc age
  read -r st mt sa sb ip < <(g compute instances describe "$VM" --zone="$ZONE" \
    --format='value(status,machineType.basename(),serviceAccounts[0].email,shieldedInstanceConfig.enableSecureBoot,networkInterfaces[0].accessConfigs[0].natIP)')
  [[ "$st" == RUNNING && "$mt" == e2-small && "$sa" == "$SA" && "$sb" == True ]] \
    && ok "VM RUNNING, e2-small, conta $sa, Secure Boot, IP $ip" || falha "VM: $st $mt $sa $sb"
  read -r sz tp rp < <(g compute disks describe "$VM" --zone="$ZONE" --format='value(sizeGb,type.basename(),resourcePolicies.len())')
  [[ "$sz" == 20 && "$tp" == pd-balanced && "${rp:-0}" -ge 1 ]] && ok "disco $sz GB $tp com agenda de snapshots" || falha "disco: $sz $tp $rp"
  echo "== Firewall que se aplica à VM"
  g compute firewall-rules list --filter="network~default AND disabled=false" \
    --format='table(name,direction,priority,sourceRanges.list(),allowed[].map().firewall_rule().list(),denied[].map().firewall_rule().list(),targetTags.list())'
  echo "== Acesso externo (deve FALHAR)"
  local ip; ip="$(g compute addresses describe "$VM-ip" --region="$REGION" --format='value(address)')"
  for p in 22 80 443; do
    if timeout 6 bash -c "</dev/tcp/$ip/$p" 2>/dev/null; then falha "porta $p ABERTA na internet"; else ok "porta $p fechada na internet"; fi
  done
  echo "== Dentro da VM (via IAP)"
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command='
    set -u
    docker --version && docker compose version
    swapon --show --noheadings | grep -q swapfile && echo "swap: $(free -m | awk "/Swap/ {print \$2}") MB" || echo "SEM SWAP"
    echo "portas escutando: $(sudo ss -tlnH | awk "{print \$4}" | tr "\n" " ")"
    echo "contêineres em execução: $(sudo docker ps -q | wc -l)"
    systemctl is-enabled cenario-homolog.service cenario-backup-upload.timer | tr "\n" " "; echo
    test -d /opt/cenario/infra && echo "/opt/cenario: com arquivos (inesperado na Etapa 1)" || echo "/opt/cenario: vazio (sistema não publicado)"
    for s in homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token; do
      gcloud secrets versions access latest --secret=$s >/dev/null 2>&1 && echo "segredo $s: legível pela conta da VM" || echo "segredo $s: SEM ACESSO"
    done
    f=etapa1-teste-$(date -u +%Y%m%dT%H%M%SZ).txt; echo "teste da Etapa 1 (dados fictícios)" > /tmp/$f
    gcloud storage cp --if-generation-match=0 /tmp/$f '"$BUCKET"'/$f >/dev/null 2>&1 && echo "bucket: gravação OK" || echo "bucket: gravação FALHOU"
    gcloud storage cat '"$BUCKET"'/$f >/dev/null 2>&1 && echo "bucket: LEITURA PERMITIDA (inesperado)" || echo "bucket: leitura negada (esperado)"
    gcloud storage rm '"$BUCKET"'/$f >/dev/null 2>&1 && echo "bucket: EXCLUSÃO PERMITIDA (inesperado)" || echo "bucket: exclusão negada (esperado)"
  '
  echo "== Bucket"
  read -r pap ubla loc age < <(gcloud storage buckets describe "$BUCKET" \
    --format='value(public_access_prevention,uniform_bucket_level_access,location,lifecycle_config.rule[0].condition.age)')
  [[ "$pap" == enforced && "$ubla" == True && "$age" == 30 ]] && ok "bucket privado ($pap), acesso uniforme, $loc, exclusão após $age dias" || falha "bucket: $pap $ubla $loc $age"
  gcloud storage buckets get-iam-policy "$BUCKET" --format=json | grep -qE 'allUsers|allAuthenticatedUsers' && falha "bucket com acesso público no IAM" || ok "IAM do bucket sem acesso público"
  echo; (( FALHAS == 0 )) && echo "INFRAESTRUTURA DA ETAPA 1: OK" || echo "INFRAESTRUTURA: $FALHAS problema(s)"
}

encerrar() {
  echo "Vai APAGAR tudo o que a Etapa 1 criou no projeto $PROJECT: VM e disco, snapshots, agenda, IP,"
  echo "regras de firewall $VM-*, bucket $BUCKET (com os backups), 5 segredos e a conta de serviço."
  read -r -p "Para confirmar, digite: apagar $PROJECT : " r
  [[ "$r" == "apagar $PROJECT" ]] || { echo "Cancelado."; exit 1; }
  g compute instances delete "$VM" --zone="$ZONE" || true
  for s in $(g compute snapshots list --filter="sourceDisk~/$VM\$" --format='value(name)'); do g compute snapshots delete "$s" || true; done
  g compute resource-policies delete "$VM-diario" --region="$REGION" || true
  g compute addresses delete "$VM-ip" --region="$REGION" || true
  g compute firewall-rules delete "$VM-iap-ssh" "$VM-bloqueio" || true
  gcloud storage rm -r "$BUCKET" --quiet || true
  for s in "${SECRETS[@]}"; do g secrets delete "$s" || true; done
  g projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/logging.logWriter --condition=None --format=none || true
  g iam service-accounts delete "$SA" || true
  echo "✔ Etapa 1 removida. (As APIs continuam habilitadas; não geram custo sem recursos.)"
}

case "${1:-}" in
  verificar) verificar ;;
  planejar) planejar ;;
  criar) criar ;;
  verificar-infra) verificar_infra ;;
  encerrar) encerrar ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
