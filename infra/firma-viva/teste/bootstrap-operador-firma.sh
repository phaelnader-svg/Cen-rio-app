#!/usr/bin/env bash
# OPERADOR DO FIRMA VIVA — configuração ÚNICA no Cloud Shell com a SUA conta. Cria uma identidade
# própria (claude-operador-firma) que só alcança a VM do Firma Viva (firma-teste) por SSH via IAP, para o
# Claude rodar firma-teste.sh (atualizar, validar, status, homologacao/producao com segredo já gravado)
# sem depender do seu Cloud Shell. A credencial vai para um ambiente PRÓPRIO do Claude Code
# ("Firma Viva — Operação"), separado dos ambientes de homologação e produção do Cenário.
#
#   bash infra/firma-viva/teste/bootstrap-operador-firma.sh plano     # só mostra
#   bash infra/firma-viva/teste/bootstrap-operador-firma.sh aplicar   # confirma, cria e (opcional) gera a chave
#   bash infra/firma-viva/teste/bootstrap-operador-firma.sh verificar
#
# Papéis (só estes): na INSTÂNCIA firma-teste: roles/compute.osAdminLogin e IAP-secured Tunnel User;
# no projeto: roles/compute.viewer (listar/descrever) e roles/iam.serviceAccountUser SÓ na conta da VM
# (exigido pelo OS Login para entrar como administrador). Nenhum papel no Cenário (VMs, banco, buckets,
# Artifact Registry, Pub/Sub), em segredos ou em IAM.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROJECT="${FIRMA_PROJECT:-cenariogestao}"
ZONE="${FIRMA_ZONE:-southamerica-east1-a}"
VM="${FIRMA_VM:-firma-teste}"
SA_NOME=claude-operador-firma
SA="$SA_NOME@$PROJECT.iam.gserviceaccount.com"
g() { gcloud --project="$PROJECT" --quiet "$@"; }
ok() { printf '  ✔ %s\n' "$*"; }
falta() { printf '  ◻ %s\n' "$*"; }

vm_sa() { g compute instances describe "$VM" --zone="$ZONE" --format='value(serviceAccounts[0].email)'; }
tem_inst() { g compute instances get-iam-policy "$VM" --zone="$ZONE" --format=json | jq -e --arg r "$1" --arg m "serviceAccount:$SA" '.bindings[]? | select(.role==$r) | .members[] | select(.==$m)' >/dev/null; }
tem_iap() { g iap tcp iam get-iam-policy --resource-type=compute --zone="$ZONE" --instance="$VM" --format=json 2>/dev/null | jq -e --arg m "serviceAccount:$SA" '.bindings[]? | select(.role=="roles/iap.tunnelResourceAccessor") | .members[] | select(.==$m)' >/dev/null; }
tem_proj() { g projects get-iam-policy "$PROJECT" --format=json | jq -e --arg r "$1" --arg m "serviceAccount:$SA" '.bindings[]? | select(.role==$r) | .members[] | select(.==$m)' >/dev/null; }
tem_actas() { local v; v="$(vm_sa)"; [[ -z "$v" ]] && return 0; g iam service-accounts get-iam-policy "$v" --format=json | jq -e --arg m "serviceAccount:$SA" '.bindings[]? | select(.role=="roles/iam.serviceAccountUser") | .members[] | select(.==$m)' >/dev/null; }

plano() {
  echo "Operador do Firma Viva — projeto $PROJECT, VM $VM ($ZONE)"
  g iam service-accounts describe "$SA" >/dev/null 2>&1 && ok "conta $SA" || falta "criar conta $SA"
  tem_inst roles/compute.osAdminLogin && ok "OS Login admin na VM" || falta "roles/compute.osAdminLogin na instância $VM"
  tem_iap && ok "túnel IAP na VM" || falta "roles/iap.tunnelResourceAccessor na instância $VM"
  tem_proj roles/compute.viewer && ok "compute.viewer" || falta "roles/compute.viewer no projeto (ler a VM e o IP)"
  tem_actas && ok "serviceAccountUser na conta da VM" || falta "roles/iam.serviceAccountUser na conta da VM ($(vm_sa))"
}

aplicar() {
  plano
  printf '\nAplicar o que falta? (digite: autorizo o operador do firma viva)\n> '
  local r; read -r r || true
  [[ "$r" == "autorizo o operador do firma viva" ]] || { echo "nada foi feito"; exit 1; }
  g services enable iap.googleapis.com oslogin.googleapis.com >/dev/null
  g iam service-accounts describe "$SA" >/dev/null 2>&1 || g iam service-accounts create "$SA_NOME" --display-name="Claude — operador do Firma Viva"
  tem_inst roles/compute.osAdminLogin || g compute instances add-iam-policy-binding "$VM" --zone="$ZONE" --member="serviceAccount:$SA" --role=roles/compute.osAdminLogin --format=none
  tem_iap || g iap tcp iam add-iam-policy-binding --resource-type=compute --zone="$ZONE" --instance="$VM" --member="serviceAccount:$SA" --role=roles/iap.tunnelResourceAccessor --format=none
  tem_proj roles/compute.viewer || g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/compute.viewer --condition=None --format=none
  local v; v="$(vm_sa)"; [[ -n "$v" ]] && { tem_actas || g iam service-accounts add-iam-policy-binding "$v" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser --format=none; }
  echo; verificar || true
  cat <<EOF

Credencial (Network Secret) para o ambiente "Firma Viva — Operação" do Claude Code:
  Secret type: GCP access token (with Service Account Key) · Allowed websites: *.googleapis.com
Gerar a chave agora? (digite "gerar" ou Enter para pular)
EOF
  read -r r || true
  if [[ "$r" == gerar ]]; then
    local dir arq; dir="$(mktemp -d "$HOME/.firma-chave-XXXXXX")"; chmod 700 "$dir"; arq="$dir/$SA_NOME.json"
    ( umask 077; g iam service-accounts keys create "$arq" --iam-account="$SA" --format=none )
    echo "✔ chave criada (conteúdo não exibido): cloudshell download $arq"
    echo "Depois de salvar o Network Secret, digite concluido (o arquivo será destruído)"; read -r r || true
    shred -u "$arq" 2>/dev/null || rm -f "$arq"; rmdir "$dir" 2>/dev/null || true
  fi
}

verificar() {
  local n=0
  g iam service-accounts describe "$SA" >/dev/null 2>&1 || { echo "✘ conta ausente"; n=$((n+1)); }
  tem_inst roles/compute.osAdminLogin || { echo "✘ osAdminLogin"; n=$((n+1)); }
  tem_iap || { echo "✘ túnel IAP"; n=$((n+1)); }
  tem_proj roles/compute.viewer || { echo "✘ compute.viewer"; n=$((n+1)); }
  ((n == 0)) && echo "OPERADOR DO FIRMA VIVA: OK" || { echo "OPERADOR DO FIRMA VIVA: $n problema(s)"; return 1; }
}

case "${1:-plano}" in
  plano) plano ;;
  aplicar) aplicar ;;
  verificar) verificar ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
