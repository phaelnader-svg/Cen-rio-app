#!/usr/bin/env bash
# REVOGAÇÃO da autonomia operacional (Cloud Shell, com a SUA conta). Cada nível é independente e
# idempotente; do mais leve ao definitivo:
#
#   bash infra/homolog/gcp/autonomia/revogar.sh estado          # mostra contas, chaves, ligações e fila (só leitura)
#   bash infra/homolog/gcp/autonomia/revogar.sh pausar-runner   # a VM deixa de ler a fila (remove o subscriber da conta da VM)
#   bash infra/homolog/gcp/autonomia/revogar.sh retomar-runner  # desfaz o anterior
#   bash infra/homolog/gcp/autonomia/revogar.sh suspender       # desativa claude-operador (nada assina nem publica; reversível)
#   bash infra/homolog/gcp/autonomia/revogar.sh reativar        # desfaz o anterior
#   bash infra/homolog/gcp/autonomia/revogar.sh revogar-chaves  # apaga TODAS as chaves de claude-operador (o Network Secret para de funcionar)
#   bash infra/homolog/gcp/autonomia/revogar.sh remover-tudo    # chaves, ligações IAM, contas, papéis personalizados, fila;
#                                                               # desinstala o runner da VM; os buckets ficam (auditoria)
# Efeito imediato do "suspender" ou "revogar-chaves": o proxy não obtém mais token; o runner recusa
# qualquer coisa não assinada pelo Google para claude-operador (falha fechada).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# shellcheck source=../ssh-agente.sh
source infra/homolog/gcp/ssh-agente.sh
PROJECT=cenariogestao
REGION=us-east1
ZONE=us-east1-b
VM=cenario-homolog
OP="claude-operador@$PROJECT.iam.gserviceaccount.com"
BUILD="cenario-build@$PROJECT.iam.gserviceaccount.com"
VM_SA="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com"
TOPICO=cenario-homolog-comandos
TOPICO_BUILD=cenario-homolog-build
GATILHO=cenario-homolog-build-autonomo
ASSINATURA=cenario-homolog-comandos-vm
B_OPS="$PROJECT-homolog-operacoes"
B_BUILD="$PROJECT-homolog-build"
B_VERSOES="$PROJECT-homolog-runner-versoes"
g() { gcloud --project="$PROJECT" "$@"; }
ok() { echo "✔ $*"; }
tira() { "$@" --quiet --format=none >/dev/null 2>&1 && ok "removido: ${*: -1}" || echo "• já ausente: ${*: -1}"; }
confirmar() { printf '\nPara prosseguir, digite exatamente: %s\n> ' "$1"; local r; read -r r || true; [[ "$r" == "$1" ]] || { echo "Cancelado."; exit 1; }; }

estado() {
  echo "== claude-operador"
  g iam service-accounts describe "$OP" --format='value(email,disabled)' 2>/dev/null | sed 's/^/• conta (email, desativada): /' || echo "• conta ausente"
  g iam service-accounts keys list --iam-account="$OP" --managed-by=user --format='value(name.basename(),validAfterTime)' 2>/dev/null | sed 's/^/• chave: /' || true
  echo "== ligações no projeto"
  g projects get-iam-policy "$PROJECT" --format=json | jq -r --arg a "serviceAccount:$OP" --arg b "serviceAccount:$BUILD" \
    '.bindings[]? | . as $x | .members[] | select(. == $a or . == $b) | "• \(.) → \($x.role)"'
  echo "== fila"
  g pubsub subscriptions get-iam-policy "$ASSINATURA" --format=json 2>/dev/null | jq -r '.bindings[]? | "• assinatura: \(.role) → \(.members | join(", "))"' || echo "• assinatura ausente"
  g pubsub topics get-iam-policy "$TOPICO" --format=json 2>/dev/null | jq -r '.bindings[]? | "• tópico: \(.role) → \(.members | join(", "))"' || echo "• tópico ausente"
  g builds triggers describe "$GATILHO" --region="$REGION" --format='value(name,serviceAccount,pubsubConfig.topic)' 2>/dev/null | sed 's/^/• gatilho (nome, conta, tópico): /' || echo "• gatilho ausente"
}

case "${1:-}" in
  estado) estado ;;
  pausar-runner)
    tira g pubsub subscriptions remove-iam-policy-binding "$ASSINATURA" --member="serviceAccount:$VM_SA" --role=roles/pubsub.subscriber
    echo "O runner continua instalado, mas não recebe operações (cada tentativa de leitura é negada e registrada)." ;;
  retomar-runner)
    g pubsub subscriptions add-iam-policy-binding "$ASSINATURA" --member="serviceAccount:$VM_SA" --role=roles/pubsub.subscriber --quiet --format=none && ok "runner volta a ler a fila" ;;
  suspender) g iam service-accounts disable "$OP" --quiet && ok "claude-operador DESATIVADA (reversível com 'reativar')" ;;
  reativar) g iam service-accounts enable "$OP" --quiet && ok "claude-operador reativada" ;;
  revogar-chaves)
    for k in $(g iam service-accounts keys list --iam-account="$OP" --managed-by=user --format='value(name.basename())'); do
      g iam service-accounts keys delete "$k" --iam-account="$OP" --quiet && ok "chave $k apagada"
    done
    echo "• apague também o Network Secret no ambiente do Claude Code (Edit → Network secrets)." ;;
  remover-tudo)
    confirmar "remover autonomia da homologacao"
    bash "$0" revogar-chaves
    for r in roles/compute.viewer roles/logging.viewer roles/monitoring.viewer "projects/$PROJECT/roles/cenarioOperadorBuild" roles/serviceusage.serviceUsageConsumer; do
      tira g projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$OP" --role="$r" --condition=None
    done
    tira g projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD" --role=roles/logging.logWriter --condition=None
    tira g projects remove-iam-policy-binding "$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/logging.logWriter --condition=None
    tira g compute instances remove-iam-policy-binding "$VM" --zone="$ZONE" --member="serviceAccount:$OP" --role="projects/$PROJECT/roles/cenarioOperadorVm"
    for b in "$B_OPS:serviceAccount:$OP:roles/storage.objectViewer" "$B_OPS:serviceAccount:$VM_SA:roles/storage.objectCreator" \
             "$B_BUILD:serviceAccount:$OP:roles/storage.objectCreator" "$B_BUILD:serviceAccount:$OP:roles/storage.objectViewer" \
             "$B_BUILD:serviceAccount:$BUILD:roles/storage.objectViewer" "$B_VERSOES:serviceAccount:$VM_SA:roles/storage.objectViewer"; do
      IFS=: read -r bk tipo conta papel <<<"$b"
      tira gcloud storage buckets remove-iam-policy-binding "gs://$bk" --project="$PROJECT" --member="$tipo:$conta" --role="$papel"
    done
    tira g artifacts repositories remove-iam-policy-binding cenario-homolog --location="$REGION" --member="serviceAccount:$OP" --role=roles/artifactregistry.reader
    tira g artifacts repositories remove-iam-policy-binding cenario-homolog --location="$REGION" --member="serviceAccount:$BUILD" --role=roles/artifactregistry.writer
    tira g pubsub subscriptions delete "$ASSINATURA"
    tira g builds triggers delete --region="$REGION" "$GATILHO"
    tira g pubsub topics delete "$TOPICO_BUILD"
    tira g pubsub topics delete "$TOPICO"
    tira g iam service-accounts delete "$OP"
    tira g iam service-accounts delete "$BUILD"
    tira g iam roles delete cenarioOperadorVm
    tira g iam roles delete cenarioAssinaJwt
    tira g iam roles delete cenarioOperadorBuild
    if conferir_chave_ssh 2>&1; then
      g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" \
        --command='sudo systemctl disable --now cenario-runner.service; sudo rm -f /etc/systemd/system/cenario-runner.service; sudo systemctl daemon-reload; echo runner desinstalado (estado e auditoria em /var/lib/cenario-runner e /var/log/cenario-runner mantidos)' \
        < /dev/null || echo "⚠ runner não desinstalado da VM (sem a fila e sem a conta ele não executa nada)"
    fi
    echo "Buckets mantidos para auditoria: gs://$B_OPS gs://$B_BUILD gs://$B_VERSOES (apague manualmente se quiser)." ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
