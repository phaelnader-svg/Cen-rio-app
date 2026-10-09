#!/usr/bin/env bash
# Comandos do OPERADOR para DEPOIS da autorização de publicação (Cloud Shell, gcloud autenticado
# na sua conta). Cada comando que altera algo mostra o que vai fazer e pede confirmação.
# A preparação (auditoria, configuração, envio dos arquivos à VM, testes) é feita pelo
# infra/homolog/gcp/homolog.sh — veja docs/HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md.
#
#   operador.sh criar-segredos           # cria os segredos que faltarem (valores aleatórios; existentes mantidos)
#   operador.sh build                    # Cloud Build das imagens do commit atual → Artifact Registry
#   operador.sh atualizar <tag>          # muda a etiqueta das imagens na VM e reinicia a pilha (com backup)
#   operador.sh mostrar-credencial proxy|gestor
#                                        # mostra UMA credencial de teste só no terminal interativo e
#                                        # limpa a tela em seguida (nunca em logs, relatórios ou pipes)
#   operador.sh trazer-backup <nome>     # copia um backup do bucket para a VM (teste de restauração)
#   operador.sh saude                    # executa a verificação de saúde dentro da VM
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
  echo "Os valores nunca são exibidos aqui. Para ver uma credencial de teste: operador.sh mostrar-credencial proxy|gestor"
}

build() {
  local tag; tag="$(git rev-parse --short HEAD)"
  [[ -z "$(git status --porcelain)" ]] || { echo "Há mudanças não commitadas: faça commit antes (a etiqueta deve corresponder exatamente ao commit)." >&2; exit 2; }
  confirma "Cloud Build das imagens api/web com a etiqueta $tag"
  gcloud builds submit --project="$PROJECT" --region="$REGION" \
    --config infra/homolog/gcp/cloudbuild.yaml --substitutions="_TAG=$tag,_REGION=$REGION" .
  echo "✔ Imagens publicadas com a etiqueta $tag"
}

atualizar() {
  local tag="${1:-}"; [[ -n "$tag" ]] || { echo "Uso: operador.sh atualizar <etiqueta>" >&2; exit 2; }
  confirma "trocar as imagens da VM para a etiqueta $tag (backup automático antes)"
  gcloud compute instances add-metadata "$VM" --zone="$ZONE" --project="$PROJECT" --metadata=cenario-tag="$tag"
  ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh atualizar $tag"
}

# Exibe UMA credencial de teste (fictícia, só da homologação) no terminal e apaga a tela depois.
# Recusa se a entrada ou a saída não forem um terminal interativo (pipe, arquivo, "tee", script
# automático, relatório): assim o valor não cai em logs. Nenhum outro comando exibe segredos.
mostrar_credencial() {
  local qual="${1:-}" segredo rotulo
  case "$qual" in
    proxy) segredo=homolog-proxy-password; rotulo="Senha do proxy (usuário: o de cenario-basic-user, padrão 'homologacao')" ;;
    gestor) segredo=homolog-admin-password; rotulo="Senha inicial do gestor de teste (troque no primeiro acesso)" ;;
    *) echo "Uso: operador.sh mostrar-credencial proxy|gestor" >&2; exit 2 ;;
  esac
  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "Recusado: a credencial só é exibida num terminal interativo (sem pipe, arquivo ou registro)." >&2
    exit 2
  fi
  echo "ATENÇÃO: a credencial aparecerá na tela. Garanta que ninguém está vendo e que a sessão"
  echo "não está sendo gravada nem compartilhada. Depois de anotá-la, tecle Enter para apagar a tela."
  read -r -p "Exibir agora? (digite sim) " r
  [[ "$r" == sim ]] || { echo "Cancelado."; exit 1; }
  local valor
  valor="$(gcloud secrets versions access latest --secret="$segredo" --project="$PROJECT")"
  printf '\n%s:\n\n    %s\n\n' "$rotulo" "$valor"
  valor=""
  read -r -s -p "Tecle Enter para apagar a tela…" _
  # Limpa a tela E o histórico de rolagem do terminal.
  printf '\033[3J\033[H\033[2J'
  clear 2>/dev/null || true
  echo "Tela apagada."
}

# Copia um backup do bucket para a VM, para o teste de restauração. A leitura do bucket é feita
# pela SUA conta (a conta da VM não lê o bucket, por desenho). Nada é restaurado aqui.
trazer_backup() {
  local nome="${1:-}"; [[ "$nome" =~ ^cenario-[A-Za-z0-9._-]+$ ]] || { echo "Uso: operador.sh trazer-backup <cenario-…> (nome da pasta do backup)" >&2; exit 2; }
  confirma "copiar gs://cenariogestao-homolog-backups/backups/$nome.tar para a VM (/var/lib/cenario/restaurar/)"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  gcloud storage cp "gs://cenariogestao-homolog-backups/backups/$nome.tar" "$tmp/" --project="$PROJECT"
  gcloud compute scp "$tmp/$nome.tar" "$VM:/tmp/" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap
  ssh_vm "sudo install -d -m 700 /var/lib/cenario/restaurar && sudo tar -xf /tmp/$nome.tar -C /var/lib/cenario/restaurar && rm -f /tmp/$nome.tar && cd /var/lib/cenario/restaurar/$nome && sudo sha256sum --check --quiet SHA256SUMS && echo '✔ backup copiado e íntegro (SHA256SUMS conferido)'"
}

case "${1:-}" in
  criar-segredos) criar_segredos ;;
  build) build ;;
  enviar-pacote) echo "Substituído por: bash infra/homolog/gcp/homolog.sh preparar-vm" >&2; exit 2 ;;
  atualizar) atualizar "${2:-}" ;;
  mostrar-credencial) mostrar_credencial "${2:-}" ;;
  senhas) echo "Removido (exibia segredos em sequência). Use: operador.sh mostrar-credencial proxy|gestor" >&2; exit 2 ;;
  trazer-backup) trazer_backup "${2:-}" ;;
  saude) ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh saude" ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
