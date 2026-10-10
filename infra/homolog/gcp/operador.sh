#!/usr/bin/env bash
# Comandos do OPERADOR para DEPOIS da autorização de publicação (Cloud Shell, gcloud autenticado
# na sua conta). Cada comando que altera algo mostra o que vai fazer e pede confirmação.
# A preparação (auditoria, configuração, envio dos arquivos à VM, testes) é feita pelo
# infra/homolog/gcp/homolog.sh — veja docs/HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md.
#
#   operador.sh criar-segredos           # cria os segredos que faltarem (valores aleatórios; existentes mantidos)
#   operador.sh build                    # Cloud Build das imagens do commit atual → Artifact Registry
#   operador.sh atualizar <tag>          # DESATIVADO (migrava implicitamente na partida); use os passos abaixo
#   operador.sh auditar                  # SÓ LEITURA: projeto, VM, rede, segredos (sem valores), registro,
#                                        # bucket e a VM por dentro (auditoria-pre-deploy.sh)
#   ATUALIZAÇÃO CONTROLADA — um passo por vez (docs/EVOLUCAO-PRE-DEPLOY-HOMOLOGACAO.md):
#   operador.sh passo preparar-versao <tag>   # imagens + digests na VM (nada reiniciado)
#   operador.sh passo manutencao              # para API e web (proxy: 503 "em manutenção")
#   operador.sh passo ponto-recuperacao       # backup + restauração de teste idêntica + bucket
#   operador.sh passo migrar <tag>            # migrations explícitas (banco igual ao ponto)
#   operador.sh definir-etiqueta <tag>        # metadado cenario-tag (versão que sobe num reinício)
#   operador.sh passo ativar <tag>            # sobe a versão nova + saúde
#   operador.sh passo recuperar --sim         # volta ao ponto de recuperação (perde o posterior)
#   operador.sh mostrar-credencial proxy|gestor
#                                        # mostra UMA credencial de teste só no terminal interativo e
#                                        # limpa a tela em seguida (nunca em logs, relatórios ou pipes)
#   operador.sh trazer-backup <nome>     # copia um backup do bucket para a VM (teste de restauração)
#   operador.sh saude                    # executa a verificação de saúde dentro da VM
#   operador.sh acesso [horas]           # diagnóstico do acesso pelo navegador (só leitura, sem segredos;
#                                        # usa o vm.sh deste commit, sem alterar a VM)
#   operador.sh atualizar-config         # leva à VM a configuração deste commit (infra/homolog) e
#                                        # recria SÓ o proxy; cópia anterior guardada para reversão
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
  # Sem custo: recusa o envio se o .gcloudignore deixar de fora algum arquivo versionado.
  bash infra/homolog/gcp/conferir-contexto.sh || { echo "Build NÃO enviado (nada foi cobrado)." >&2; exit 2; }
  confirma "Cloud Build das imagens api/web com a etiqueta $tag"
  gcloud builds submit --project="$PROJECT" --region="$REGION" \
    --config infra/homolog/gcp/cloudbuild.yaml --substitutions="_TAG=$tag,_REGION=$REGION" .
  echo "✔ Imagens publicadas com a etiqueta $tag"
}

atualizar() {
  echo "operador.sh atualizar foi desativado: as imagens migravam o banco na partida, sem ponto de" >&2
  echo "recuperação validado. Use a sequência 'operador.sh passo …' (veja o cabeçalho deste arquivo)." >&2
  exit 2
}

# Um passo da atualização controlada, executado pelo vm.sh DENTRO da VM, com confirmação.
passo() {
  local p="${1:-}"; shift || true
  case "$p" in
    preparar-versao|manutencao|ponto-recuperacao|migrar|ativar|recuperar) ;;
    *) echo "Uso: operador.sh passo preparar-versao|manutencao|ponto-recuperacao|migrar|ativar|recuperar [args]" >&2; exit 2 ;;
  esac
  local a; for a in "$@"; do [[ "$a" =~ ^(--sim|[0-9a-f]{7,40})$ ]] || { echo "Argumento inválido: $a" >&2; exit 2; }; done
  confirma "vm.sh $p $* na VM $VM"
  ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh $p $*"
}

# Metadado que decide quais imagens sobem num reinício da VM (gerar-env). Só com confirmação.
definir_etiqueta() {
  local tag="${1:-}"; [[ "$tag" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Uso: operador.sh definir-etiqueta <sha>" >&2; exit 2; }
  local atual; atual="$(gcloud compute instances describe "$VM" --zone="$ZONE" --project="$PROJECT" --format=json \
    | jq -r '.metadata.items[]? | select(.key=="cenario-tag") | .value')"
  confirma "alterar o metadado cenario-tag da VM: ${atual:-?} → $tag"
  gcloud compute instances add-metadata "$VM" --zone="$ZONE" --project="$PROJECT" --metadata=cenario-tag="$tag"
}

# Leva à VM SÓ os arquivos de configuração e operação (infra/homolog + scripts de backup) do
# commit atual, guarda a cópia anterior e recria apenas o proxy. Não troca imagens, não mexe no
# banco nem em migrations. Reversão: a cópia /opt/cenario.anterior-<data> + "vm.sh aplicar-config".
atualizar_config() {
  [[ -z "$(git status --porcelain -- infra/homolog scripts/backup.sh scripts/restore.sh)" ]] \
    || { echo "Há mudanças não commitadas em infra/homolog ou scripts/: faça commit antes." >&2; exit 2; }
  local commit; commit="$(git rev-parse --short=12 HEAD)"
  confirma "copiar a configuração do commit $commit para /opt/cenario e recriar SÓ o proxy (banco, API e web intocados)"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git archive --format=tar.gz -o "$tmp/config.tgz" HEAD infra/homolog scripts/backup.sh scripts/restore.sh
  gcloud compute scp "$tmp/config.tgz" "$VM:/tmp/cenario-config.tgz" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap
  ssh_vm "sudo CENARIO_COMMIT=$commit bash -s" <<'REMOTO'
set -euo pipefail
copia="/opt/cenario.anterior-$(date -u +%Y%m%dT%H%M%S.%NZ)"
cp -a /opt/cenario "$copia" && echo "cópia anterior: $copia"
tar -xzf /tmp/cenario-config.tgz -C /opt/cenario
echo "$CENARIO_COMMIT" > /opt/cenario/VERSAO
chmod 755 /opt/cenario/infra/homolog/gcp/*.sh
rm -f /tmp/cenario-config.tgz
/opt/cenario/infra/homolog/gcp/vm.sh aplicar-config
REMOTO
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
  auditar) bash infra/homolog/gcp/auditoria-pre-deploy.sh ;;
  passo) shift; passo "$@" ;;
  definir-etiqueta) definir_etiqueta "${2:-}" ;;
  mostrar-credencial) mostrar_credencial "${2:-}" ;;
  senhas) echo "Removido (exibia segredos em sequência). Use: operador.sh mostrar-credencial proxy|gestor" >&2; exit 2 ;;
  trazer-backup) trazer_backup "${2:-}" ;;
  saude) ssh_vm "sudo /opt/cenario/infra/homolog/gcp/vm.sh saude" ;;
  acesso) h="${2:-24}"; [[ "$h" =~ ^[0-9]+$ ]] || { echo "Uso: operador.sh acesso [horas]" >&2; exit 2; }
    # O vm.sh deste commit vai pela entrada padrão: nada é gravado na VM.
    ssh_vm "sudo bash -s -- diagnosticar-acesso $h" < infra/homolog/gcp/vm.sh ;;
  atualizar-config) atualizar_config ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
