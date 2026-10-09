#!/usr/bin/env bash
# Comandos do OPERADOR (no seu computador, com o gcloud autenticado na sua conta), para a
# homologação no Google Cloud. Cada comando mostra o que vai fazer e pede confirmação.
#
#   operador.sh criar-segredos     # gera os 5 segredos no Secret Manager (valores aleatórios)
#   operador.sh build              # Cloud Build das imagens do commit atual → Artifact Registry
#   operador.sh enviar-pacote      # copia infra/homolog e os scripts de backup para a VM (via IAP)
#   operador.sh atualizar <tag>    # muda a etiqueta das imagens na VM e reinicia a pilha (com backup)
#   operador.sh senhas             # mostra a senha do proxy e a senha inicial do gestor de teste
#   operador.sh saude              # executa a verificação de saúde dentro da VM
#
# Infraestrutura (VM, bucket, IP, firewall…) é criada pelos comandos de
# docs/HOMOLOGACAO-GCP-PREPARACAO.md §9, somente após autorização.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROJECT="${CENARIO_PROJECT:-cenariogestao}"
REGION="${CENARIO_REGION:-us-east1}"
ZONE="${CENARIO_ZONE:-us-east1-b}"
VM="${CENARIO_VM:-cenario-homolog}"
SECRETS=(homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token)

confirma() {
  echo "Projeto: $PROJECT · Região: $REGION · VM: $VM"
  echo "Vai executar: $*"
  read -r -p "Confirma? (digite sim) " r
  [[ "$r" == sim ]] || { echo "Cancelado."; exit 1; }
}
ssh_vm() { gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="$1"; }

criar_segredos() {
  confirma "criar ${#SECRETS[@]} segredos no Secret Manager (${SECRETS[*]})"
  gen() {
    case "$1" in
      homolog-postgres-password) openssl rand -hex 24 ;;
      homolog-token-hash-secret) openssl rand -base64 48 | tr -d '\n' ;;
      homolog-admin-password) echo -n "Hml-$(openssl rand -hex 8)!" ;;
      homolog-proxy-password) openssl rand -base64 18 | tr -d '\n/+=' ;;
      homolog-gate-token) openssl rand -hex 32 ;;
    esac
  }
  for s in "${SECRETS[@]}"; do
    if gcloud secrets describe "$s" --project="$PROJECT" >/dev/null 2>&1; then
      echo "• $s já existe (mantido)"
    else
      gen "$s" | gcloud secrets create "$s" --project="$PROJECT" --replication-policy=user-managed \
        --locations="$REGION" --data-file=-
      echo "✔ $s criado"
    fi
  done
  echo "Os valores nunca são exibidos aqui. Para ver as senhas de uso: operador.sh senhas"
}

build() {
  local tag; tag="$(git rev-parse --short HEAD)"
  [[ -z "$(git status --porcelain)" ]] || { echo "Há mudanças não commitadas: faça commit antes (a etiqueta deve corresponder exatamente ao commit)." >&2; exit 2; }
  confirma "Cloud Build das imagens api/web com a etiqueta $tag"
  gcloud builds submit --project="$PROJECT" --region="$REGION" \
    --config infra/homolog/gcp/cloudbuild.yaml --substitutions="_TAG=$tag,_REGION=$REGION" .
  echo "✔ Imagens publicadas com a etiqueta $tag"
}

enviar_pacote() {
  confirma "copiar infra/homolog e scripts de backup do commit $(git rev-parse --short HEAD) para /opt/cenario na VM"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git archive --format=tar.gz -o "$tmp/cenario-homolog.tgz" HEAD infra/homolog scripts/backup.sh scripts/restore.sh
  gcloud compute scp "$tmp/cenario-homolog.tgz" "$VM:/tmp/" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap
  ssh_vm "sudo tar -xzf /tmp/cenario-homolog.tgz -C /opt/cenario && sudo chmod 755 /opt/cenario/infra/homolog/gcp/*.sh && rm /tmp/cenario-homolog.tgz && echo '✔ arquivos instalados em /opt/cenario'"
}

atualizar() {
  local tag="${1:-}"; [[ -n "$tag" ]] || { echo "Uso: operador.sh atualizar <etiqueta>" >&2; exit 2; }
  confirma "trocar as imagens da VM para a etiqueta $tag (backup automático antes)"
  gcloud compute instances add-metadata "$VM" --zone="$ZONE" --project="$PROJECT" --metadata=cenario-tag="$tag"
  ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh atualizar $tag"
}

senhas() {
  echo "Proxy (usuário 'homologacao' ou o definido em cenario-basic-user):"
  gcloud secrets versions access latest --secret=homolog-proxy-password --project="$PROJECT"; echo
  echo "Senha inicial do gestor de teste (trocar no primeiro acesso):"
  gcloud secrets versions access latest --secret=homolog-admin-password --project="$PROJECT"; echo
}

case "${1:-}" in
  criar-segredos) criar_segredos ;;
  build) build ;;
  enviar-pacote) enviar_pacote ;;
  atualizar) atualizar "${2:-}" ;;
  senhas) senhas ;;
  saude) ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh saude" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
