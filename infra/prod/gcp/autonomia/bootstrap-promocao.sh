#!/usr/bin/env bash
# AUTONOMIA DA PROMOÇÃO (homologação → produção), configuração ÚNICA no Cloud Shell com a SUA conta.
# Depois dela, o operador de produção (claude-operador-prod) pede a promoção sozinho:
#   CENARIO_AMBIENTE=prod python3 infra/homolog/gcp/autonomia/operar.py promover <sha-40> <digest-api> <digest-web>
#
#   bash infra/prod/gcp/autonomia/bootstrap-promocao.sh plano      # SÓ mostra o que existe e o que seria criado
#   bash infra/prod/gcp/autonomia/bootstrap-promocao.sh aplicar    # mostra o plano, pede confirmação, cria o que falta
#   bash infra/prod/gcp/autonomia/bootstrap-promocao.sh verificar  # confere tudo (só leitura)
#
# Desenho (o mesmo da build autônoma da homologação):
#   claude-operador-prod só PUBLICA um pedido no tópico cenario-prod-promocao (tag + 2 digests).
#   Quem copia é o gatilho do Cloud Build cenario-prod-promocao, com a conta cenario-promocao e os passos
#   FIXOS de cloudbuild-promocao.json (mesma lógica de promover-imagens.sh: exige o digest homologado na
#   origem, nunca sobrescreve etiqueta em produção, confere o digest do destino).
#   cenario-promocao: LEITURA em cenario-homolog e ESCRITA em cenario-prod (só o Artifact Registry).
#   claude-operador-prod: publicar no tópico. NÃO ganha papel na homologação nem permissão de build.
# Não cria chaves, não toca VM, banco, segredos, DNS nem a homologação (só concede leitura do repositório
# de imagens dela à conta da promoção).
set -euo pipefail
cd "$(dirname "$0")/../../../.."

PROJECT=cenariogestao
REGION_PROD=southamerica-east1
REGION_HOMOLOG=us-east1
SA_NOME=cenario-promocao
SA="$SA_NOME@$PROJECT.iam.gserviceaccount.com"
OPERADOR="claude-operador-prod@$PROJECT.iam.gserviceaccount.com"
TOPICO=cenario-prod-promocao
GATILHO=cenario-prod-promocao
REPO_ORIGEM=cenario-homolog
REPO_DESTINO=cenario-prod
ORIGEM="$REGION_HOMOLOG-docker.pkg.dev/$PROJECT/$REPO_ORIGEM"
DESTINO="$REGION_PROD-docker.pkg.dev/$PROJECT/$REPO_DESTINO"
CONFIG=infra/prod/gcp/autonomia/cloudbuild-promocao.json
SUBST="_TAG=\$(body.message.attributes.tag),_API=\$(body.message.attributes.api),_WEB=\$(body.message.attributes.web),_ORIGEM=$ORIGEM,_DESTINO=$DESTINO"
g() { gcloud --project="$PROJECT" --quiet "$@"; }
ok() { printf '  ✔ %s\n' "$*"; }
falta() { printf '  ◻ %s\n' "$*"; }

existe_sa() { g iam service-accounts describe "$SA" >/dev/null 2>&1; }
existe_topico() { g pubsub topics describe "$TOPICO" >/dev/null 2>&1; }
existe_gatilho() { g builds triggers describe "$GATILHO" --region="$REGION_PROD" >/dev/null 2>&1; }
tem_papel_repo() { # repo regiao papel membro
  g artifacts repositories get-iam-policy "$1" --location="$2" --format=json 2>/dev/null |
    jq -e --arg r "$3" --arg m "$4" '.bindings[]? | select(.role==$r) | .members[] | select(.==$m)' >/dev/null
}
tem_papel_topico() {
  g pubsub topics get-iam-policy "$TOPICO" --format=json 2>/dev/null |
    jq -e --arg m "serviceAccount:$OPERADOR" '.bindings[]? | select(.role=="roles/pubsub.publisher") | .members[] | select(.==$m)' >/dev/null
}
tem_log_writer() {
  g projects get-iam-policy "$PROJECT" --format=json |
    jq -e --arg m "serviceAccount:$SA" '.bindings[]? | select(.role=="roles/logging.logWriter") | .members[] | select(.==$m)' >/dev/null
}

plano() {
  echo "Projeto $PROJECT — autonomia da promoção de imagens (homologação → produção)"
  existe_sa && ok "conta $SA" || falta "criar conta $SA (sem chave)"
  tem_papel_repo "$REPO_ORIGEM" "$REGION_HOMOLOG" roles/artifactregistry.reader "serviceAccount:$SA" \
    && ok "$SA lê $REPO_ORIGEM" || falta "$SA: roles/artifactregistry.reader no repositório $REPO_ORIGEM ($REGION_HOMOLOG)"
  tem_papel_repo "$REPO_DESTINO" "$REGION_PROD" roles/artifactregistry.writer "serviceAccount:$SA" \
    && ok "$SA grava em $REPO_DESTINO" || falta "$SA: roles/artifactregistry.writer no repositório $REPO_DESTINO ($REGION_PROD)"
  tem_log_writer && ok "$SA grava logs da build" || falta "$SA: roles/logging.logWriter no projeto (logs da build)"
  existe_topico && ok "tópico $TOPICO" || falta "criar tópico $TOPICO"
  tem_papel_topico && ok "$OPERADOR publica em $TOPICO" || falta "$OPERADOR: roles/pubsub.publisher no tópico $TOPICO"
  existe_gatilho && ok "gatilho $GATILHO" || falta "criar gatilho $GATILHO (Pub/Sub $TOPICO → $CONFIG com $SA)"
  echo "Não concede nada na VM, no banco, nos segredos, no DNS, nem papel do operador na homologação."
}

aplicar() {
  plano
  printf '\nAplicar o que falta? (digite: autorizo a promoção autônoma)\n> '
  local r; read -r r || true
  [[ "$r" == "autorizo a promoção autônoma" ]] || { echo "nada foi feito"; exit 1; }
  g services enable cloudbuild.googleapis.com pubsub.googleapis.com artifactregistry.googleapis.com >/dev/null
  existe_sa || g iam service-accounts create "$SA_NOME" --display-name="Promoção de imagens homologadas (Cloud Build)"
  tem_papel_repo "$REPO_ORIGEM" "$REGION_HOMOLOG" roles/artifactregistry.reader "serviceAccount:$SA" ||
    g artifacts repositories add-iam-policy-binding "$REPO_ORIGEM" --location="$REGION_HOMOLOG" \
      --member="serviceAccount:$SA" --role=roles/artifactregistry.reader --format=none
  tem_papel_repo "$REPO_DESTINO" "$REGION_PROD" roles/artifactregistry.writer "serviceAccount:$SA" ||
    g artifacts repositories add-iam-policy-binding "$REPO_DESTINO" --location="$REGION_PROD" \
      --member="serviceAccount:$SA" --role=roles/artifactregistry.writer --format=none
  tem_log_writer || g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/logging.logWriter --condition=None --format=none
  existe_topico || g pubsub topics create "$TOPICO"
  tem_papel_topico || g pubsub topics add-iam-policy-binding "$TOPICO" \
    --member="serviceAccount:$OPERADOR" --role=roles/pubsub.publisher --format=none
  existe_gatilho || g builds triggers create pubsub --region="$REGION_PROD" --name="$GATILHO" \
    --topic="projects/$PROJECT/topics/$TOPICO" --inline-config="$CONFIG" \
    --service-account="projects/$PROJECT/serviceAccounts/$SA" --substitutions="$SUBST" \
    --description="Producao: promove por digest as imagens homologadas (pedido pelo claude-operador-prod)" --format=none
  echo; verificar
}

verificar() {
  local n=0
  existe_sa || { echo "✘ conta $SA ausente"; n=$((n+1)); }
  tem_papel_repo "$REPO_ORIGEM" "$REGION_HOMOLOG" roles/artifactregistry.reader "serviceAccount:$SA" || { echo "✘ leitura em $REPO_ORIGEM"; n=$((n+1)); }
  tem_papel_repo "$REPO_DESTINO" "$REGION_PROD" roles/artifactregistry.writer "serviceAccount:$SA" || { echo "✘ escrita em $REPO_DESTINO"; n=$((n+1)); }
  existe_topico || { echo "✘ tópico $TOPICO ausente"; n=$((n+1)); }
  tem_papel_topico || { echo "✘ $OPERADOR não publica em $TOPICO"; n=$((n+1)); }
  if existe_gatilho; then
    local d; d="$(g builds triggers describe "$GATILHO" --region="$REGION_PROD" --format=json)"
    [[ "$(jq -r '.serviceAccount' <<<"$d" | sed 's#.*/##')" == "$SA" ]] || { echo "✘ gatilho com outra conta"; n=$((n+1)); }
    [[ "$(jq -r '.pubsubConfig.topic' <<<"$d")" == "projects/$PROJECT/topics/$TOPICO" ]] || { echo "✘ gatilho com outro tópico"; n=$((n+1)); }
  else echo "✘ gatilho $GATILHO ausente"; n=$((n+1)); fi
  # Isolamento: o operador de produção continua sem papel nos repositórios da homologação.
  if tem_papel_repo "$REPO_ORIGEM" "$REGION_HOMOLOG" roles/artifactregistry.reader "serviceAccount:$OPERADOR" ||
     tem_papel_repo "$REPO_ORIGEM" "$REGION_HOMOLOG" roles/artifactregistry.writer "serviceAccount:$OPERADOR"; then
    echo "✘ $OPERADOR tem papel em $REPO_ORIGEM (isolamento quebrado)"; n=$((n+1))
  fi
  ((n == 0)) && echo "PROMOÇÃO AUTÔNOMA: OK" || { echo "PROMOÇÃO AUTÔNOMA: $n problema(s)"; return 1; }
}

case "${1:-plano}" in
  plano) plano ;;
  aplicar) aplicar ;;
  verificar) verificar ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
