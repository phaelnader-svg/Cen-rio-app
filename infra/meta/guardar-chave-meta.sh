#!/usr/bin/env bash
# Guarda a chave secreta do app da Meta ("Cenário Gestão", WhatsApp dos agentes) no Secret Manager.
# Onde achar a chave: developers.facebook.com → app Cenário Gestão → Configurações do app → Básico →
# "Chave secreta do app" → Mostrar (pede a senha do Facebook).
# Roda UMA vez, no Cloud Shell do dono:   cd ~/Cen-rio-app && bash infra/meta/guardar-chave-meta.sh
# A chave é digitada sem aparecer na tela e vai direto ao Secret Manager pela entrada padrão:
# nunca é exibida, gravada em arquivo, passada como argumento nem registrada em log.
# Grava a mesma chave para homologação e produção; cada VM só lê o próprio segredo.
# Rodar de novo troca a chave (nova versão; a anterior é desativada).
set -euo pipefail
PROJECT=cenariogestao
declare -A REGIAO=([prod]=southamerica-east1 [homolog]=us-east1)
declare -A CONTA=([prod]="cenario-prod-vm@$PROJECT.iam.gserviceaccount.com" [homolog]="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com")
g() { gcloud --project="$PROJECT" --quiet "$@"; }

printf 'Cole a chave secreta do app da Meta (32 letras e números) e aperte Enter. Ela não aparece na tela: '
IFS= read -rs CHAVE; echo
CHAVE="${CHAVE//[[:space:]]/}"
[[ "$CHAVE" =~ ^[0-9a-fA-F]{32}$ ]] || { echo "✘ Isso não parece a chave secreta do app (32 letras e números). Nada foi gravado."; exit 1; }

for amb in homolog prod; do
  nome="$amb-meta-app-secret"
  antigas=""
  if g secrets describe "$nome" --format='value(name)' >/dev/null 2>&1; then
    antigas="$(g secrets versions list "$nome" --filter=state=ENABLED --format='value(name)')"
  else
    g secrets create "$nome" --replication-policy=user-managed --locations="${REGIAO[$amb]}" \
      --labels=ambiente="$amb",uso=meta --format=none
  fi
  printf '%s' "$CHAVE" | g secrets versions add "$nome" --data-file=- --format=none
  for v in $antigas; do g secrets versions disable "$v" --secret="$nome" --format=none; done
  g secrets add-iam-policy-binding "$nome" --member="serviceAccount:${CONTA[$amb]}" \
    --role=roles/secretmanager.secretAccessor --format=none >/dev/null
  echo "✔ $amb: chave guardada (valor não exibido)"
done
unset CHAVE
echo "Pronto. Pode fechar o Cloud Shell; o resto é com o Claude."
