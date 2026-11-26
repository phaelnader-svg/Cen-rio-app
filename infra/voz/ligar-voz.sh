#!/usr/bin/env bash
# Liga a voz da Conversar (segurar o microfone no app): o servidor manda o áudio ao Google
# Speech-to-Text e recebe o texto. Roda UMA vez, no Cloud Shell do dono:
#   cd ~/Cen-rio-app && git pull && bash infra/voz/ligar-voz.sh
# O que faz: liga a API Speech-to-Text no projeto, cria uma chave que SÓ serve para ela e guarda
# a chave no Secret Manager (homologação e produção). A chave vai direto do Google para o Secret
# Manager pela entrada padrão: nunca aparece na tela, em arquivo, em argumento ou em log.
# Rodar de novo reaproveita a mesma chave. Custo: os primeiros 60 minutos falados do mês são grátis.
set -euo pipefail
PROJECT=cenariogestao
NOME_CHAVE="cenario-voz-conversar"
declare -A REGIAO=([prod]=southamerica-east1 [homolog]=us-east1)
declare -A CONTA=([prod]="cenario-prod-vm@$PROJECT.iam.gserviceaccount.com" [homolog]="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com")
g() { gcloud --project="$PROJECT" --quiet "$@"; }

echo "1/3 Ligando a API de voz (Speech-to-Text)…"
g services enable speech.googleapis.com apikeys.googleapis.com

echo "2/3 Criando a chave só para a voz…"
chave="$(g services api-keys list --filter="displayName=$NOME_CHAVE" --format='value(name)' | head -n1)"
if [[ -z "$chave" ]]; then
  g services api-keys create --display-name="$NOME_CHAVE" \
    --api-target=service=speech.googleapis.com --format=none
  for _ in 1 2 3 4 5 6; do
    chave="$(g services api-keys list --filter="displayName=$NOME_CHAVE" --format='value(name)' | head -n1)"
    [[ -n "$chave" ]] && break
    sleep 5
  done
fi
[[ -n "$chave" ]] || { echo "✘ A chave não apareceu. Rode de novo em um minuto."; exit 1; }

echo "3/3 Guardando no Secret Manager (homologação e produção)…"
for amb in homolog prod; do
  nome="$amb-speech-api-key"
  antigas=""
  if g secrets describe "$nome" --format='value(name)' >/dev/null 2>&1; then
    antigas="$(g secrets versions list "$nome" --filter=state=ENABLED --format='value(name)')"
  else
    g secrets create "$nome" --replication-policy=user-managed --locations="${REGIAO[$amb]}" \
      --labels=ambiente="$amb",uso=voz --format=none
  fi
  g services api-keys get-key-string "$chave" --format='value(keyString)' | tr -d '\n' |
    g secrets versions add "$nome" --data-file=- --format=none
  for v in $antigas; do g secrets versions disable "$v" --secret="$nome" --format=none; done
  g secrets add-iam-policy-binding "$nome" --member="serviceAccount:${CONTA[$amb]}" \
    --role=roles/secretmanager.secretAccessor --format=none >/dev/null
  echo "✔ $amb: chave guardada (valor não exibido)"
done
unset chave
echo "Pronto. Pode fechar o Cloud Shell; a voz liga na próxima publicação."
