#!/usr/bin/env bash
# Guarda os números do app da Meta (não são segredos) e cria o token do webhook, para homologação e
# produção. Roda no Cloud Shell do dono:
#   cd ~/Cen-rio-app && bash infra/meta/guardar-ids-meta.sh <ID do app> [ID da configuração]
# O ID da configuração (Cadastro Incorporado do WhatsApp) só existe depois que a Meta aprova a
# empresa; rodar de novo com ele só acrescenta o que falta. O token do webhook é criado uma vez e
# aparece só aqui, para colar no campo "Verificar token" do webhook no painel da Meta.
set -euo pipefail
PROJECT=cenariogestao
declare -A REGIAO=([prod]=southamerica-east1 [homolog]=us-east1)
declare -A CONTA=([prod]="cenario-prod-vm@$PROJECT.iam.gserviceaccount.com" [homolog]="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com")
declare -A SITE=([prod]="cenariogestao.com.br" [homolog]="teste.cenariogestao.com.br")
g() { gcloud --project="$PROJECT" --quiet "$@"; }

APP_ID="${1:-}"; CONFIG_ID="${2:-}"
[[ "$APP_ID" =~ ^[0-9]{5,20}$ ]] || { echo "✘ Informe o ID do app (só números). Nada foi gravado."; exit 1; }
[[ -z "$CONFIG_ID" || "$CONFIG_ID" =~ ^[0-9]{5,20}$ ]] || { echo "✘ O ID da configuração tem que ser só números. Nada foi gravado."; exit 1; }

gravar() { # gravar <ambiente> <nome> <valor>
  local nome="$1-meta-$2"
  if ! g secrets describe "$nome" --format='value(name)' >/dev/null 2>&1; then
    g secrets create "$nome" --replication-policy=user-managed --locations="${REGIAO[$1]}" \
      --labels=ambiente="$1",uso=meta --format=none
  fi
  printf '%s' "$3" | g secrets versions add "$nome" --data-file=- --format=none
  g secrets add-iam-policy-binding "$nome" --member="serviceAccount:${CONTA[$1]}" \
    --role=roles/secretmanager.secretAccessor --format=none >/dev/null
}

for amb in homolog prod; do
  gravar "$amb" app-id "$APP_ID"
  [[ -n "$CONFIG_ID" ]] && gravar "$amb" wa-config-id "$CONFIG_ID"
  if ! tok="$(g secrets versions access latest --secret="$amb-meta-webhook-verify-token" 2>/dev/null)"; then
    tok="$(openssl rand -hex 24)"
    gravar "$amb" webhook-verify-token "$tok"
  fi
  echo "✔ $amb: ID do app${CONFIG_ID:+ e ID da configuração} guardados."
  if [[ "$amb" == prod ]]; then # o app da Meta tem um webhook só: o da produção
    echo "   Webhook para o painel da Meta: https://${SITE[$amb]}/api/webhooks/meta"
    echo "   Verificar token: $tok"
  fi
done
unset tok
echo "Pronto. O resto é com o Claude (entra na próxima publicação ou no aplicar-config)."
