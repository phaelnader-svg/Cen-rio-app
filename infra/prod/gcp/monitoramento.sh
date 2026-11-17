#!/usr/bin/env bash
# Melhoria 96: aviso automático por e-mail se o site cair.
#
# Cria (uma vez; rodar de novo não duplica) no projeto do Google Cloud da produção:
#   1. um canal de aviso por e-mail;
#   2. uma verificação de disponibilidade (uptime check) de https://<domínio>/api/health a cada
#      5 minutos, feita de 3 regiões do Google;
#   3. um alerta: se a verificação falhar por 5 minutos seguidos, manda e-mail (e outro quando
#      voltar ao normal).
#
# Uso (Cloud Shell do dono ou sessão "Cenário — Produção"):
#   infra/prod/gcp/monitoramento.sh <e-mail que recebe o aviso> [domínio]
# Precisa do papel "Monitoring Editor" (roles/monitoring.editor) na conta que roda.
set -euo pipefail

EMAIL="${1:?informe o e-mail que recebe o aviso}"
DOMINIO="${2:-cenariogestao.com.br}"
PROJETO="${CENARIO_PROJETO:-$(gcloud config get-value project 2>/dev/null)}"
[[ -n "$PROJETO" ]] || { echo "✘ Projeto do Google Cloud não definido (gcloud config set project …)"; exit 2; }
NOME="Cenário Gestão — site no ar ($DOMINIO)"

echo "Projeto: $PROJETO · domínio: $DOMINIO · aviso para: $EMAIL"
gcloud services enable monitoring.googleapis.com --project "$PROJETO" >/dev/null

# 1. Canal de e-mail (reaproveita se já existir para o mesmo endereço).
CANAL="$(gcloud beta monitoring channels list --project "$PROJETO" \
  --filter="type=email AND labels.email_address=\"$EMAIL\"" --format='value(name)' | head -n1)"
if [[ -z "$CANAL" ]]; then
  CANAL="$(gcloud beta monitoring channels create --project "$PROJETO" --type=email \
    --display-name="Aviso do Cenário Gestão ($EMAIL)" \
    --channel-labels="email_address=$EMAIL" --format='value(name)')"
  echo "✔ Canal de e-mail criado"
else
  echo "✔ Canal de e-mail já existia"
fi

# 2. Verificação de disponibilidade.
CHECK="$(gcloud monitoring uptime list-configs --project "$PROJETO" \
  --filter="displayName=\"$NOME\"" --format='value(name)' | head -n1)"
if [[ -z "$CHECK" ]]; then
  gcloud monitoring uptime create "$NOME" --project "$PROJETO" \
    --resource-type=uptime-url --resource-labels="host=$DOMINIO,project_id=$PROJETO" \
    --protocol=https --path=/api/health --port=443 --validate-ssl=true \
    --period=5 --timeout=10 --regions=usa-oregon,europe,south-america >/dev/null
  CHECK="$(gcloud monitoring uptime list-configs --project "$PROJETO" \
    --filter="displayName=\"$NOME\"" --format='value(name)' | head -n1)"
  echo "✔ Verificação a cada 5 minutos criada"
else
  echo "✔ Verificação já existia"
fi
CHECK_ID="${CHECK##*/}"

# 3. Alerta: falhou em pelo menos 2 regiões por 5 minutos.
EXISTE="$(gcloud alpha monitoring policies list --project "$PROJETO" \
  --filter="displayName=\"$NOME\"" --format='value(name)' | head -n1)"
if [[ -z "$EXISTE" ]]; then
  ARQ="$(mktemp)"
  trap 'rm -f "$ARQ"' EXIT
  cat >"$ARQ" <<JSON
{
  "displayName": "$NOME",
  "combiner": "OR",
  "conditions": [{
    "displayName": "O site não respondeu",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.\"check_id\"=\"$CHECK_ID\"",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "ALIGN_NEXT_OLDER",
        "crossSeriesReducer": "REDUCE_COUNT_FALSE",
        "groupByFields": ["resource.label.host"]
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 1,
      "duration": "300s",
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$CANAL"],
  "alertStrategy": { "autoClose": "1800s" },
  "documentation": {
    "content": "O Cenário Gestão ($DOMINIO) não respondeu à verificação por 5 minutos. Confira https://$DOMINIO/status e a VM da produção.",
    "mimeType": "text/markdown"
  }
}
JSON
  gcloud alpha monitoring policies create --project "$PROJETO" --policy-from-file="$ARQ" >/dev/null
  echo "✔ Alerta criado: e-mail para $EMAIL se o site ficar 5 minutos fora do ar"
else
  echo "✔ Alerta já existia"
fi
