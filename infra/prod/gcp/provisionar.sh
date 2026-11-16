#!/usr/bin/env bash
# PROVISIONAMENTO DA PRODUÇÃO do Cenário Gestão — Cloud Shell, na raiz do repositório, com a SUA conta
# (Owner do projeto). Cria SÓ recursos de produção (prefixo/sufixo "prod"), idempotente: o que já existe
# é conferido, nunca recriado, sobrescrito ou apagado. Não toca em NENHUM recurso da homologação (só lê o
# repositório de imagens cenario-homolog para promover as imagens homologadas e confere o isolamento).
#
#   bash infra/prod/gcp/provisionar.sh auditar        # SÓ LEITURA: conta, projeto, o que existe, DNS atual
#   bash infra/prod/gcp/provisionar.sh plano          # SÓ LEITURA: o que seria criado (nada muda)
#   bash infra/prod/gcp/provisionar.sh infraestrutura # rede, firewall, IP, conta da VM, segredos NOVOS,
#                                                     # bucket de backups, Artifact Registry, VM, snapshots
#   bash infra/prod/gcp/provisionar.sh promover       # copia as imagens HOMOLOGADAS de 9fb1786 por digest
#   bash infra/prod/gcp/provisionar.sh preparar-vm    # copia infra/prod (este commit) e instala os serviços
#                                                     # com o PORTÃO FECHADO (nada é iniciado)
#   bash infra/prod/gcp/provisionar.sh operador       # claude-operador-prod, fila, buckets, runner (perfil prod),
#                                                     # teste do canal e isolamento
#   bash infra/prod/gcp/provisionar.sh canal          # SÓ o teste do canal (permissão temporária) + isolamento,
#                                                     # sem criar, publicar ou instalar nada
#   bash infra/prod/gcp/provisionar.sh dns            # mostra o DNS atual, os registros a criar na Hostinger e
#                                                     # espera a propagação (nunca altera DNS)
#   bash infra/prod/gcp/provisionar.sh verificar      # SÓ LEITURA: isolamento homologação × produção
#   bash infra/prod/gcp/provisionar.sh credencial     # chave do claude-operador-prod para o Network Secret de um
#                                                     # AMBIENTE NOVO do Claude Code (só após confirmação)
#   bash infra/prod/gcp/provisionar.sh tudo           # as etapas acima, em ordem; para na 1ª falha
#   bash infra/prod/gcp/provisionar.sh emergencia     # desativa claude-operador-prod e pausa o runner da VM
#
# SSH: carregue antes a chave no ssh-agent (eval "$(ssh-agent -s)"; ssh-add -t 1h ~/.ssh/google_compute_engine).
# Garantias: todo comando leva --project; segredos gerados aqui vão direto ao Secret Manager pela entrada
# padrão (nunca em argumento, arquivo, log ou tela); nada de homologação é criado, alterado ou ligado;
# o banco de produção nasce vazio na VM (nenhum dado é copiado da homologação); nunca inicia a aplicação
# (o primeiro deploy é do operador de produção, depois de todos os portões). Registros sem segredos em
# ~/cenario-prod-relatorios/.
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck source=ssh-agente.sh
source infra/prod/gcp/ssh-agente.sh

PROJECT=cenariogestao
REGION=southamerica-east1
ZONE=southamerica-east1-b
VM=cenario-prod
MAQUINA=e2-medium
DISCO_GB=50
DISCO_TIPO=pd-balanced
VPC=cenario-prod-vpc
SUBNET=cenario-prod-subnet
FAIXA=10.60.0.0/24
TAG_REDE=cenario-prod
FW_WEB=cenario-prod-web
FW_IAP=cenario-prod-iap-ssh
IAP_FAIXA=35.235.240.0/20
IP_NOME=cenario-prod-ip
VM_SA_NOME=cenario-prod-vm
VM_SA="$VM_SA_NOME@$PROJECT.iam.gserviceaccount.com"
SECRETS=(prod-postgres-password prod-token-hash-secret prod-admin-password)
B_BACKUPS=cenariogestao-prod-backups
REPO=cenario-prod
SNAP=cenario-prod-diario
DOMINIO=cenariogestao.com.br
DOMINIO_WWW=www.cenariogestao.com.br
# Versão funcional autorizada para o primeiro deploy e os digests HOMOLOGADOS (build d45323b6, ativa
# na homologação em 2026-10-18; docs/FASE-10-GESTAO-FECHAMENTO-RELATORIO.md §52–60).
TAG_APP=9fb1786beddae28c34b20a0922b42989ecb0fbf2
DIGEST_API=sha256:6e4a225dc8fb8619d0165627f65828b0950f481f93b440cc95f1fbf5cac5f848
DIGEST_WEB=sha256:7b99ebc11fbf700f4eee81acb0100d4ae1cdbdca24198b0bd166ad40fa0cf822
# Operador automático de produção (identidade SEPARADA do claude-operador da homologação).
OP_NOME=claude-operador-prod
OP="$OP_NOME@$PROJECT.iam.gserviceaccount.com"
TOPICO=cenario-prod-comandos
ASSINATURA=cenario-prod-comandos-vm
B_OPS=cenariogestao-prod-operacoes
B_VERSOES=cenariogestao-prod-runner-versoes
PAPEL_VM=cenarioProdOperadorVm
PAPEL_JWT=cenarioProdAssinaJwt
PERM_VM="compute.instances.get,compute.instances.getSerialPortOutput,compute.instances.reset,compute.instances.start,compute.instances.stop"
PERM_JWT="iam.serviceAccounts.signJwt"
AUD=cenario-prod-runner
RUNNER_DIR=infra/homolog/gcp/autonomia/runner
OPERAR=(python3 -I infra/homolog/gcp/autonomia/operar.py)
APIS=(compute.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com storage.googleapis.com
      pubsub.googleapis.com iamcredentials.googleapis.com iam.googleapis.com logging.googleapis.com)
# Recursos da homologação: só LIDOS (isolamento), nunca alterados por este script.
H_VM=cenario-homolog
H_ZONE=us-east1-b
H_VM_SA="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com"
H_OP="claude-operador@$PROJECT.iam.gserviceaccount.com"
H_SECRETS=(homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token)
H_BUCKETS=(cenariogestao-homolog-backups cenariogestao-homolog-operacoes cenariogestao-homolog-runner-versoes cenariogestao-homolog-build)
PROIBIDOS='^roles/(owner|editor|iam\..*[Aa]dmin.*|resourcemanager\..*|secretmanager\.admin|compute\.admin|compute\.instanceAdmin.*|storage\.admin|storage\.objectAdmin)$'
PORTAO=/etc/cenario/publicacao-autorizada

RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-prod-relatorios}"
OKS=0; AVISOS=0; FALHAS=0; CANAL_OK=0
ok() { echo "✔ $*"; OKS=$((OKS + 1)); }
aviso() { echo "⚠ $*"; AVISOS=$((AVISOS + 1)); }
falha() { echo "✘ $*"; FALHAS=$((FALHAS + 1)); }
secao() { echo; echo "== $*"; }
g() { gcloud --project="$PROJECT" "$@"; }
T="$(mktemp -d)"; chmod 700 "$T"; trap 'rm -rf "$T"' EXIT

confirmar() { # confirmar <frase exata>
  printf '\nPara prosseguir, digite exatamente: %s\n> ' "$1"
  local r; read -r r || true
  [[ "$r" == "$1" ]] || { echo "Cancelado. Nada foi alterado nesta etapa."; exit 1; }
}
ssh_vm() { # comando remoto; entrada padrão repassada. Nunca pede passphrase (ssh-agente.sh).
  conferir_chave_ssh || return 1
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" --command="$1"
}
existe() { # existe <tipo> <nome…> → 0 se existe (só leitura)
  case "$1" in
    rede) g compute networks describe "$2" >/dev/null 2>&1 ;;
    subrede) g compute networks subnets describe "$2" --region="$REGION" >/dev/null 2>&1 ;;
    firewall) g compute firewall-rules describe "$2" >/dev/null 2>&1 ;;
    ip) g compute addresses describe "$2" --region="$REGION" >/dev/null 2>&1 ;;
    sa) g iam service-accounts describe "$2" >/dev/null 2>&1 ;;
    segredo) g secrets describe "$2" >/dev/null 2>&1 ;;
    bucket) gcloud storage buckets describe "gs://$2" --project="$PROJECT" >/dev/null 2>&1 ;;
    repo) g artifacts repositories describe "$2" --location="$REGION" >/dev/null 2>&1 ;;
    vm) g compute instances describe "$2" --zone="$ZONE" >/dev/null 2>&1 ;;
    snap) g compute resource-policies describe "$2" --region="$REGION" >/dev/null 2>&1 ;;
    papel) g iam roles describe "$2" >/dev/null 2>&1 ;;
    topico) g pubsub topics describe "$2" >/dev/null 2>&1 ;;
    assinatura) g pubsub subscriptions describe "$2" >/dev/null 2>&1 ;;
    *) return 2 ;;
  esac
}
ligar() { # ligar <descrição> <comando…> — add-iam-policy-binding é idempotente; papéis proibidos recusados
  local d="$1"; shift
  [[ "$*" =~ --role=([^ ]+) ]] && [[ "${BASH_REMATCH[1]}" =~ $PROIBIDOS ]] && { echo "✘ papel proibido: ${BASH_REMATCH[1]}"; exit 1; }
  [[ "$*" == *homolog* ]] && { echo "✘ ligação em recurso de homologação recusada: $d"; exit 1; }
  "$@" --format=none >/dev/null && ok "$d"
}
# Segredo NOVO: gerado aqui (/dev/urandom) e enviado ao Secret Manager pela entrada padrão; nunca é
# exibido, gravado em arquivo nem passado como argumento. Um segredo já existente NUNCA é trocado.
criar_segredo() { # criar_segredo <nome> <gerador>
  if existe segredo "$1"; then ok "segredo $1 já existe (mantido; valor não lido)"; return 0; fi
  g secrets create "$1" --replication-policy=user-managed --locations="$REGION" --labels=ambiente=prod --format=none
  "$2" | g secrets versions add "$1" --data-file=- --format=none
  ok "segredo $1 criado (valor novo, aleatório, não exibido)"
}
gerar_hex32() { openssl rand -hex 32 | tr -d '\n'; }
gerar_hex48() { openssl rand -hex 48 | tr -d '\n'; }
gerar_senha_gestor() { # ≥ 10 caracteres com letras e números (política do sistema); 24 caracteres
  local s
  while :; do
    s="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
    [[ ${#s} == 24 && "$s" =~ [A-Za-z] && "$s" =~ [0-9] ]] && { printf '%s' "$s"; return 0; }
  done
}

requisitos() {
  local c faltam=()
  for c in gcloud jq git python3 curl openssl dig; do command -v "$c" >/dev/null 2>&1 || faltam+=("$c"); done
  (( ${#faltam[@]} == 0 )) || { echo "✘ Ferramentas ausentes: ${faltam[*]} (use o Cloud Shell)"; exit 1; }
  CONTA="$(gcloud config get-value account 2>/dev/null || true)"
  [[ -n "$CONTA" ]] || { echo "✘ Nenhuma conta autenticada no gcloud (gcloud auth login)"; exit 1; }
  [[ "$CONTA" != *gserviceaccount.com ]] || { echo "✘ Use a SUA conta (não uma conta de serviço)."; exit 1; }
  g projects describe "$PROJECT" --format=json > "$T/projeto.json" 2>/dev/null \
    || { echo "✘ Projeto $PROJECT inacessível com a conta $CONTA"; exit 1; }
  [[ "$(jq -r .lifecycleState "$T/projeto.json")" == ACTIVE ]] || { echo "✘ Projeto $PROJECT não está ativo"; exit 1; }
  echo "Conta: $CONTA · Projeto: $PROJECT · Região: $REGION · Zona: $ZONE"
  mkdir -p "$RELDIR"
}

# ======================================================================== auditar / plano (só leitura)
inventario() {
  local r
  for r in "rede $VPC" "subrede $SUBNET" "firewall $FW_WEB" "firewall $FW_IAP" "ip $IP_NOME" "sa $VM_SA" \
           "segredo ${SECRETS[0]}" "segredo ${SECRETS[1]}" "segredo ${SECRETS[2]}" "bucket $B_BACKUPS" "repo $REPO" \
           "snap $SNAP" "vm $VM" "sa $OP" "papel projects/$PROJECT/roles/$PAPEL_VM" "papel projects/$PROJECT/roles/$PAPEL_JWT" \
           "topico $TOPICO" "assinatura $ASSINATURA" "bucket $B_OPS" "bucket $B_VERSOES"; do
    # shellcheck disable=SC2086
    if existe $r; then echo "  ✔ existe   $r"; else echo "  ◻ a criar  $r"; fi
  done
}

dns_atual() {
  local n t
  for n in "$DOMINIO" "$DOMINIO_WWW" "teste.$DOMINIO"; do
    for t in A AAAA CNAME CAA MX TXT; do
      local r1 r2
      r1="$(dig +short "$n" "$t" @8.8.8.8 2>/dev/null | paste -sd' ' || true)"
      r2="$(dig +short "$n" "$t" @1.1.1.1 2>/dev/null | paste -sd' ' || true)"
      [[ -n "$r1$r2" ]] && echo "  $n $t → ${r1:-∅} (8.8.8.8) · ${r2:-∅} (1.1.1.1)"
    done
  done
  echo "  NS de $DOMINIO → $(dig +short NS "$DOMINIO" @8.8.8.8 | paste -sd' ')"
}

auditar() {
  requisitos
  secao "Recursos de produção"
  inventario
  secao "Homologação (só leitura: precisa continuar intacta)"
  g compute instances describe "$H_VM" --zone="$H_ZONE" --format='value(status,machineType.basename())' 2>/dev/null \
    | sed 's/^/  VM cenario-homolog: /' || aviso "VM de homologação não lida"
  secao "DNS atual de $DOMINIO (resolvedores públicos)"
  dns_atual
  if existe ip "$IP_NOME"; then echo "  IP reservado da produção: $(g compute addresses describe "$IP_NOME" --region="$REGION" --format='value(address)')"; fi
  secao "Estimativa de custo mensal (aproximada, preços de lista em USD; confira na calculadora do Google)"
  custos
}

custos() {
  cat <<'EOF'
  VM e2-medium (2 vCPU compartilhadas, 4 GB) em southamerica-east1 ........ ~ US$ 39,00
  Disco de inicialização 50 GB pd-balanced ................................... ~ US$  7,50
  IPv4 externo estático em uso ............................................... ~ US$  3,65
  Snapshots diários do disco (incrementais, retenção 14 dias; ~5–10 GB) ...... ~ US$  0,50–1,00
  Bucket de backups (Standard, região SP; ~1–5 GB nos primeiros meses) ....... ~ US$  0,05–0,25
  Artifact Registry cenario-prod (~4–8 GB: versão ativa + anterior) .......... ~ US$  0,40–0,80
  Secret Manager (3 segredos; acessos na partida) ............................ ~ US$  0,20
  Pub/Sub, Cloud Logging, IAM ............................................... ~ US$  0 (cotas gratuitas)
  Tráfego de saída para a internet (algumas dezenas de GB/mês) .............. ~ US$  1–5
  TOTAL aproximado .......................................................... ~ US$ 52–58 / mês
  Premissas: VM ligada 24 h, sem descontos de uso contínuo nem créditos; preços de lista de 2026.
EOF
}

plano() {
  requisitos
  secao "O que 'infraestrutura' cria (só o que faltar)"
  cat <<EOF
  • APIs: ${APIS[*]}
  • rede $VPC (modo personalizado) + sub-rede $SUBNET $FAIXA em $REGION (acesso privado ao Google)
  • firewall $FW_WEB: tcp:80,443 de 0.0.0.0/0 só para a tag $TAG_REDE
  • firewall $FW_IAP: tcp:22 SÓ do IAP ($IAP_FAIXA) para a tag $TAG_REDE (nenhum SSH público)
  • IP externo estático $IP_NOME (região $REGION)
  • conta da VM $VM_SA (papel no projeto: logging.logWriter; nada mais)
  • segredos NOVOS ${SECRETS[*]} (gerados aqui, réplica em $REGION; secretAccessor só para $VM_SA)
  • bucket gs://$B_BACKUPS ($REGION, acesso uniforme, prevenção de acesso público, versões apagadas
    após 90 dias; $VM_SA só CRIA objetos: não lê, não lista, não apaga)
  • Artifact Registry $REPO (docker, $REGION, etiquetas IMUTÁVEIS; $VM_SA só lê)
  • VM $VM: $MAQUINA, disco $DISCO_GB GB $DISCO_TIPO, Debian 12, VM protegida (inicialização segura, vTPM,
    integridade), proteção contra exclusão, OS Login, chaves SSH do projeto bloqueadas, IP $IP_NOME,
    tag $TAG_REDE, conta $VM_SA; metadados não secretos cenario-* (projeto, região, repositório, domínios,
    bucket, e-mail e nome do gestor)
  • política de snapshots $SNAP (diária, retenção 14 dias) no disco da VM
EOF
  secao "O que 'operador' cria"
  cat <<EOF
  • conta $OP; papéis personalizados $PAPEL_VM (get/start/stop/reset SÓ na VM $VM) e $PAPEL_JWT (signJwt
    só da própria conta); serviceusage.serviceUsageConsumer no projeto
  • tópico $TOPICO + assinatura $ASSINATURA (confirmação 60 s, retenção 10 min; só $VM_SA lê)
  • buckets gs://$B_OPS (resultados, 90 dias; o operador lê, a VM só cria) e gs://$B_VERSOES (versões do
    runner e dos scripts; SÓ VOCÊ grava; a VM só lê)
  • leitura do repositório $REPO pelo operador (conferir imagens)
  • runner (perfil prod) publicado em gs://$B_VERSOES e instalado na VM pela SUA sessão SSH
  NÃO concede: Owner/Editor/IAM Admin, metadados da VM, SSH, segredos, backups, Cloud Build, nada na homologação.
EOF
  secao "Situação atual"
  inventario
}

# ======================================================================== infraestrutura
pedir_gestor() {
  if [[ -z "${GESTOR_EMAIL:-}" ]]; then printf 'E-mail do primeiro gestor (login do sistema): '; read -r GESTOR_EMAIL; fi
  if [[ -z "${GESTOR_NOME:-}" ]]; then printf 'Nome do primeiro gestor: '; read -r GESTOR_NOME; fi
  [[ "$GESTOR_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "✘ e-mail inválido"; exit 1; }
  [[ "$GESTOR_NOME" =~ ^[[:alpha:][:space:].\'-]{2,60}$ ]] || { echo "✘ nome inválido (letras, 2–60)"; exit 1; }
}

infraestrutura() {
  requisitos
  pedir_gestor
  plano >/dev/null
  secao "Infraestrutura de produção (só o que falta)"
  inventario
  confirmar "PROVISIONAR PRODUCAO"
  g services enable "${APIS[@]}" --format=none && ok "APIs habilitadas"
  existe rede "$VPC" || g compute networks create "$VPC" --subnet-mode=custom --format=none
  ok "rede $VPC"
  existe subrede "$SUBNET" || g compute networks subnets create "$SUBNET" --network="$VPC" --region="$REGION" \
    --range="$FAIXA" --enable-private-ip-google-access --format=none
  ok "sub-rede $SUBNET ($FAIXA)"
  existe firewall "$FW_WEB" || g compute firewall-rules create "$FW_WEB" --network="$VPC" --direction=INGRESS \
    --action=ALLOW --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags="$TAG_REDE" --format=none
  ok "firewall $FW_WEB (tcp:80,443)"
  existe firewall "$FW_IAP" || g compute firewall-rules create "$FW_IAP" --network="$VPC" --direction=INGRESS \
    --action=ALLOW --rules=tcp:22 --source-ranges="$IAP_FAIXA" --target-tags="$TAG_REDE" --format=none
  ok "firewall $FW_IAP (tcp:22 só do IAP)"
  existe ip "$IP_NOME" || g compute addresses create "$IP_NOME" --region="$REGION" --network-tier=PREMIUM --format=none
  local ip; ip="$(g compute addresses describe "$IP_NOME" --region="$REGION" --format='value(address)')"
  ok "IP estático $IP_NOME: $ip"
  existe sa "$VM_SA" || g iam service-accounts create "$VM_SA_NOME" --display-name="Cenario Gestao - VM de producao" --format=none
  ok "conta $VM_SA"
  ligar "$VM_SA: logging.logWriter (projeto)" g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/logging.logWriter --condition=None
  criar_segredo prod-postgres-password gerar_hex32
  criar_segredo prod-token-hash-secret gerar_hex48
  criar_segredo prod-admin-password gerar_senha_gestor
  local s
  for s in "${SECRETS[@]}"; do
    ligar "$VM_SA: secretAccessor em $s" g secrets add-iam-policy-binding "$s" --member="serviceAccount:$VM_SA" --role=roles/secretmanager.secretAccessor
  done
  if ! existe bucket "$B_BACKUPS"; then
    gcloud storage buckets create "gs://$B_BACKUPS" --project="$PROJECT" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention --default-storage-class=STANDARD --format=none
  fi
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}},{"action":{"type":"Delete"},"condition":{"matchesPrefix":["testes-preparo/"],"age":1}}]}' > "$T/lc.json"
  gcloud storage buckets update "gs://$B_BACKUPS" --project="$PROJECT" --lifecycle-file="$T/lc.json" --format=none
  ok "bucket gs://$B_BACKUPS (uniforme, sem acesso público, retenção 90 dias)"
  ligar "$VM_SA: objectCreator em gs://$B_BACKUPS" gcloud storage buckets add-iam-policy-binding "gs://$B_BACKUPS" --project="$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/storage.objectCreator
  existe repo "$REPO" || g artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" \
    --description="Cenario Gestao - imagens de PRODUCAO (promovidas por digest)" --immutable-tags --format=none
  ok "Artifact Registry $REPO (etiquetas imutáveis)"
  ligar "$VM_SA: artifactregistry.reader em $REPO" g artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" --member="serviceAccount:$VM_SA" --role=roles/artifactregistry.reader
  existe snap "$SNAP" || g compute resource-policies create snapshot-schedule "$SNAP" --region="$REGION" \
    --daily-schedule --start-time=06:00 --max-retention-days=14 --on-source-disk-delete=keep-auto-snapshots \
    --storage-location="$REGION" --format=none
  ok "política de snapshots $SNAP (diária 06:00 UTC, 14 dias)"
  if ! existe vm "$VM"; then
    g compute instances create "$VM" --zone="$ZONE" --machine-type="$MAQUINA" \
      --network-interface="subnet=$SUBNET,address=$ip,network-tier=PREMIUM" \
      --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size="${DISCO_GB}GB" --boot-disk-type="$DISCO_TIPO" --no-boot-disk-auto-delete \
      --service-account="$VM_SA" --scopes=cloud-platform --tags="$TAG_REDE" \
      --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring --deletion-protection \
      --labels=ambiente=prod,sistema=cenario-gestao \
      --metadata="enable-oslogin=TRUE,block-project-ssh-keys=TRUE,cenario-project=$PROJECT,cenario-region=$REGION,cenario-repo=$REPO,cenario-domain=$DOMINIO,cenario-domain-www=$DOMINIO_WWW,cenario-bucket=gs://$B_BACKUPS,cenario-admin-email=$GESTOR_EMAIL,cenario-admin-name=$GESTOR_NOME" \
      --format=none
  fi
  ok "VM $VM ($MAQUINA, $DISCO_GB GB $DISCO_TIPO)"
  local disco; disco="$(g compute instances describe "$VM" --zone="$ZONE" --format='value(disks[0].source.basename())')"
  if ! g compute disks describe "$disco" --zone="$ZONE" --format='value(resourcePolicies)' | grep -q "$SNAP"; then
    g compute disks add-resource-policies "$disco" --zone="$ZONE" --resource-policies="$SNAP" --format=none
  fi
  ok "snapshots diários ligados ao disco $disco"
  echo "$(date -u +%FT%TZ) infraestrutura ok · IP $ip" >> "$RELDIR/provisionamento.log"
}

# ======================================================================== promoção das imagens
promover() {
  requisitos
  existe repo "$REPO" || { echo "✘ repositório $REPO ausente: rode 'infraestrutura' antes"; exit 1; }
  secao "Promoção das imagens homologadas de $TAG_APP (por digest)"
  bash infra/prod/gcp/promover-imagens.sh "$TAG_APP" "$DIGEST_API" "$DIGEST_WEB"
  ok "imagens $TAG_APP em $REGION-docker.pkg.dev/$PROJECT/$REPO com os digests homologados"
}

# ======================================================================== preparação da VM (portão fechado)
preparar_vm() {
  requisitos
  [[ -z "$(git status --porcelain -- infra/prod scripts/backup.sh scripts/restore.sh)" ]] \
    || { echo "✘ Há mudanças não commitadas em infra/prod ou scripts/: a VM recebe exatamente um commit."; exit 1; }
  local commit; commit="$(git rev-parse --short=12 HEAD)"
  [[ "$(g compute instances describe "$VM" --zone="$ZONE" --format='value(status)')" == RUNNING ]] || { echo "✘ VM $VM não está RUNNING"; exit 1; }
  conferir_chave_ssh 2>&1 || exit 1
  local estado; estado="$(ssh_vm "test -f $PORTAO && echo PORTAO-ABERTO || echo PORTAO-FECHADO" < /dev/null 2>/dev/null | tail -1)"
  [[ "$estado" == PORTAO-FECHADO ]] || { echo "✘ Portão da VM: '${estado:-sem resposta}'. Nada foi copiado."; exit 1; }
  secao "Preparação da VM $VM com o commit $commit (portão fechado)"
  echo "  • copia infra/prod e scripts/{backup,restore}.sh do commit para /opt/cenario"
  echo "  • executa infra/prod/gcp/startup.sh: Docker, swap de 2 GB, atualizações de segurança e serviços"
  echo "    systemd COM o portão fechado. NÃO inicia contêineres, banco nem migrations."
  confirmar "preparar $VM"
  git archive --format=tar.gz -o "$T/pacote.tgz" HEAD infra/prod scripts/backup.sh scripts/restore.sh
  g compute scp "$T/pacote.tgz" "$VM:/tmp/cenario-pacote.tgz" --zone="$ZONE" --tunnel-through-iap --quiet "${SCP_SEM_PERGUNTA[@]}" < /dev/null
  ssh_vm "sudo CENARIO_COMMIT=$commit bash -s" <<'REMOTO'
set -euo pipefail
test ! -f /etc/cenario/publicacao-autorizada || { echo "portão aberto: abortado"; exit 1; }
rm -rf /opt/cenario.novo
install -d -m 755 /opt/cenario.novo
tar -xzf /tmp/cenario-pacote.tgz -C /opt/cenario.novo
echo "$CENARIO_COMMIT" > /opt/cenario.novo/VERSAO
chmod 755 /opt/cenario.novo/infra/prod/gcp/*.sh
if [ -d /opt/cenario ]; then
  if [ -z "$(ls -A /opt/cenario)" ]; then rmdir /opt/cenario
  else mv -T /opt/cenario "/opt/cenario.anterior-$(date -u +%Y%m%dT%H%M%S.%NZ)"; fi
fi
mv -T /opt/cenario.novo /opt/cenario
rm -f /tmp/cenario-pacote.tgz
bash /opt/cenario/infra/prod/gcp/startup.sh
bash /opt/cenario/infra/prod/gcp/vm.sh verificar-preparo
REMOTO
  ok "VM preparada com $commit (nada iniciado)"
  echo "$(date -u +%FT%TZ) preparar-vm $commit" >> "$RELDIR/provisionamento.log"
}

# ======================================================================== operador de produção
pacote_runner() {
  [[ -z "$(git status --porcelain -- "$RUNNER_DIR")" ]] || { echo "✘ runner com mudanças não commitadas"; exit 1; }
  RVER="$(tr -dc '0-9.' < "$RUNNER_DIR/VERSAO")"
  tar --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' -C "$RUNNER_DIR" \
    -czf "$T/runner-$RVER.tar.gz" cenario_runner.py cenario-runner.service instalar.sh VERSAO
  sha256sum "$T/runner-$RVER.tar.gz" | cut -d' ' -f1 > "$T/runner-$RVER.sha256"
}
publicar_versoes() {
  pacote_runner
  local remoto local_sha; local_sha="$(cat "$T/runner-$RVER.sha256")"
  remoto="$(gcloud storage cat "gs://$B_VERSOES/runner-$RVER.sha256" --project="$PROJECT" 2>/dev/null | tr -dc '0-9a-f' || true)"
  if [[ -n "$remoto" ]]; then
    [[ "$remoto" == "$local_sha" ]] && ok "runner $RVER já publicado em gs://$B_VERSOES" || { echo "✘ runner $RVER já publicado com OUTRO conteúdo"; exit 1; }
  else
    gcloud storage cp "$T/runner-$RVER.tar.gz" "$T/runner-$RVER.sha256" "gs://$B_VERSOES/" --project="$PROJECT" --if-generation-match=0 --format=none
    ok "runner $RVER publicado em gs://$B_VERSOES (SHA-256 $local_sha)"
  fi
  [[ -z "$(git status --porcelain -- infra/prod scripts/backup.sh scripts/restore.sh)" ]] || { echo "✘ infra/prod com mudanças não commitadas"; exit 1; }
  local sver; sver="$(git rev-parse HEAD | cut -c1-12)"
  git archive --format=tar HEAD infra/prod scripts/backup.sh scripts/restore.sh | gzip -n -9 > "$T/scripts-$sver.tar.gz"
  sha256sum "$T/scripts-$sver.tar.gz" | cut -d' ' -f1 > "$T/scripts-$sver.sha256"
  remoto="$(gcloud storage cat "gs://$B_VERSOES/scripts-$sver.sha256" --project="$PROJECT" 2>/dev/null | tr -dc '0-9a-f' || true)"
  if [[ -z "$remoto" ]]; then
    gcloud storage cp "$T/scripts-$sver.tar.gz" "$T/scripts-$sver.sha256" "gs://$B_VERSOES/" --project="$PROJECT" --if-generation-match=0 --format=none
  fi
  ok "scripts da VM $sver publicados em gs://$B_VERSOES"
}

operador() {
  requisitos
  existe vm "$VM" || { echo "✘ VM $VM ausente: rode 'infraestrutura' antes"; exit 1; }
  plano | sed -n '/O que .operador. cria/,/Situação atual/p' | sed '$d'
  confirmar "CRIAR OPERADOR DE PRODUCAO"
  existe sa "$OP" || g iam service-accounts create "$OP_NOME" --display-name="Claude - operador da PRODUCAO (operacoes nomeadas)" --format=none
  ok "conta $OP"
  existe papel "projects/$PROJECT/roles/$PAPEL_VM" || g iam roles create "$PAPEL_VM" --title="Cenario prod - operador da VM" --permissions="$PERM_VM" --stage=GA --format=none
  existe papel "projects/$PROJECT/roles/$PAPEL_JWT" || g iam roles create "$PAPEL_JWT" --title="Cenario prod - assina o proprio JWT" --permissions="$PERM_JWT" --stage=GA --format=none
  ok "papéis $PAPEL_VM e $PAPEL_JWT"
  existe topico "$TOPICO" || g pubsub topics create "$TOPICO" --labels=ambiente=prod --format=none
  existe assinatura "$ASSINATURA" || g pubsub subscriptions create "$ASSINATURA" --topic="$TOPICO" --ack-deadline=60 \
    --message-retention-duration=10m --expiration-period=never --labels=ambiente=prod --format=none
  ok "fila $TOPICO → $ASSINATURA"
  local b
  for b in "$B_OPS" "$B_VERSOES"; do
    existe bucket "$b" || gcloud storage buckets create "gs://$b" --project="$PROJECT" --location="$REGION" \
      --uniform-bucket-level-access --public-access-prevention --format=none
  done
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}' > "$T/lc90.json"
  gcloud storage buckets update "gs://$B_OPS" --project="$PROJECT" --lifecycle-file="$T/lc90.json" --format=none
  ok "buckets gs://$B_OPS (90 dias) e gs://$B_VERSOES"
  ligar "$OP: serviceUsageConsumer (projeto)" g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$OP" --role=roles/serviceusage.serviceUsageConsumer --condition=None
  ligar "$OP: $PAPEL_VM só na VM $VM" g compute instances add-iam-policy-binding "$VM" --zone="$ZONE" --member="serviceAccount:$OP" --role="projects/$PROJECT/roles/$PAPEL_VM"
  ligar "$OP: assinar o próprio JWT" g iam service-accounts add-iam-policy-binding "$OP" --member="serviceAccount:$OP" --role="projects/$PROJECT/roles/$PAPEL_JWT"
  ligar "$OP: publicar em $TOPICO" g pubsub topics add-iam-policy-binding "$TOPICO" --member="serviceAccount:$OP" --role=roles/pubsub.publisher
  ligar "$VM_SA: ler $ASSINATURA" g pubsub subscriptions add-iam-policy-binding "$ASSINATURA" --member="serviceAccount:$VM_SA" --role=roles/pubsub.subscriber
  ligar "$OP: ler gs://$B_OPS" gcloud storage buckets add-iam-policy-binding "gs://$B_OPS" --project="$PROJECT" --member="serviceAccount:$OP" --role=roles/storage.objectViewer
  ligar "$VM_SA: criar em gs://$B_OPS" gcloud storage buckets add-iam-policy-binding "gs://$B_OPS" --project="$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/storage.objectCreator
  ligar "$VM_SA: ler gs://$B_VERSOES" gcloud storage buckets add-iam-policy-binding "gs://$B_VERSOES" --project="$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/storage.objectViewer
  ligar "$OP: ler imagens $REPO" g artifacts repositories add-iam-policy-binding "$REPO" --location="$REGION" --member="serviceAccount:$OP" --role=roles/artifactregistry.reader
  publicar_versoes
  secao "Instalação do runner $RVER (perfil prod) na VM pela sua sessão SSH"
  conferir_chave_ssh 2>&1 || exit 1
  g compute scp "$T/runner-$RVER.tar.gz" "$VM:/tmp/cenario-runner.tar.gz" --zone="$ZONE" --tunnel-through-iap --quiet "${SCP_SEM_PERGUNTA[@]}" < /dev/null
  ssh_vm "set -euo pipefail
D=\$(mktemp -d); tar -xzf /tmp/cenario-runner.tar.gz -C \"\$D\"; rm -f /tmp/cenario-runner.tar.gz
sudo CENARIO_RUNNER_PROJETO=$PROJECT CENARIO_RUNNER_VM=$VM CENARIO_RUNNER_ASSINANTE=$OP \
  CENARIO_RUNNER_ASSINATURA=projects/$PROJECT/subscriptions/$ASSINATURA CENARIO_RUNNER_BUCKET=$B_OPS \
  CENARIO_RUNNER_BUCKET_VERSOES=$B_VERSOES CENARIO_RUNNER_DOMINIO=$DOMINIO CENARIO_RUNNER_AMBIENTE=prod \
  CENARIO_RUNNER_AUD=$AUD bash \"\$D/instalar.sh\" \"\$D\"
rm -rf \"\$D\"" < /dev/null
  teste_canal
  concluir_operador
}
concluir_operador() { # canal e isolamento contados SEPARADAMENTE; a etapa só passa com os dois
  local iso=0; verificar || iso=1
  (( CANAL_OK == 1 && iso == 0 )) && { ok "ETAPA OPERADOR: OK"; return 0; }
  echo "✘ ETAPA OPERADOR incompleta: canal $( ((CANAL_OK == 1)) && echo OK || echo FALHOU ) · isolamento $( ((iso == 0)) && echo OK || echo 'com problema' )"
  return 1
}

teste_canal() {
  secao "Teste do canal (permissão TEMPORÁRIA de assinatura para $CONTA)"
  g iam service-accounts add-iam-policy-binding "$OP" --member="user:$CONTA" --role="projects/$PROJECT/roles/$PAPEL_JWT" --format=none >/dev/null
  remover_temp() { g iam service-accounts remove-iam-policy-binding "$OP" --member="user:$CONTA" --role="projects/$PROJECT/roles/$PAPEL_JWT" --quiet --format=none >/dev/null 2>&1 \
    && ok "permissão temporária de $CONTA removida" || falha "remova manualmente a permissão temporária de $CONTA sobre $OP"; }
  trap 'remover_temp; rm -rf "$T"' EXIT
  # Só o código 126 do operar.py (API do Google recusou, p.ex. signJwt 403 enquanto a permissão temporária
  # propaga; o Google documenta até ~7 min) é repetido. Qualquer outro resultado já passou pela fila e pelo
  # runner: repetir só reenviaria jobs.
  local rc=126 n espera="${CENARIO_CANAL_ESPERA_S:-15}"
  CANAL_OK=0
  for n in $(seq 1 32); do
    rc=0; env -u CLOUDSDK_AUTH_ACCESS_TOKEN CENARIO_AMBIENTE=prod "${OPERAR[@]}" verificar || rc=$?
    (( rc == 126 )) || break
    echo "  (tentativa $n: assinatura/API ainda recusada — propagação do IAM; nova tentativa em ${espera} s)"; sleep "$espera"
  done
  if (( rc == 0 )); then
    ok "canal de ponta a ponta: assinatura → fila → runner (prod) → resultado no bucket"
    if env -u CLOUDSDK_AUTH_ACCESS_TOKEN CENARIO_AMBIENTE=prod "${OPERAR[@]}" teste-seguranca; then ok "testes de segurança do runner"; CANAL_OK=1
    else falha "testes de segurança"; fi
  elif (( rc == 126 )); then falha "assinatura ainda recusada após 32 tentativas (propagação do IAM): rode de novo 'provisionar.sh canal'"
  else falha "canal: o runner respondeu, mas a verificação falhou (código $rc; veja as operações acima)"; fi
  remover_temp
  trap 'rm -rf "$T"' EXIT
}

# ======================================================================== isolamento (só leitura)
membros_de() { jq -r '[.bindings[]? | .members[]?] | unique | join(" ")' "$1"; }
sem_membro() { # sem_membro <descrição> <arquivo-política> <membro…>
  local d="$1" arq="$2" m; shift 2
  for m in "$@"; do
    if jq -e --arg m "$m" '[.bindings[]?.members[]? | select(. == $m)] | length > 0' "$arq" >/dev/null; then
      falha "$d: $m TEM acesso"; return 0
    fi
  done
  ok "$d: sem acesso de ${*//serviceAccount:/}"
}
verificar() {
  [[ -n "${CONTA:-}" ]] || requisitos
  secao "Isolamento homologação × produção (só leitura)"
  local s b antes=$FALHAS  # conta só os problemas DESTA verificação (não os de etapas anteriores)
  for s in "${SECRETS[@]}"; do
    g secrets get-iam-policy "$s" --format=json > "$T/p.json" 2>/dev/null || { falha "segredo $s ilegível"; continue; }
    sem_membro "segredo $s" "$T/p.json" "serviceAccount:$H_VM_SA" "serviceAccount:$H_OP" "serviceAccount:$OP"
  done
  for s in "${H_SECRETS[@]}"; do
    g secrets get-iam-policy "$s" --format=json > "$T/p.json" 2>/dev/null || continue
    sem_membro "segredo $s (homologação)" "$T/p.json" "serviceAccount:$VM_SA" "serviceAccount:$OP"
  done
  for b in "$B_BACKUPS" "$B_OPS" "$B_VERSOES"; do
    gcloud storage buckets get-iam-policy "gs://$b" --project="$PROJECT" --format=json > "$T/p.json" 2>/dev/null || continue
    sem_membro "gs://$b" "$T/p.json" "serviceAccount:$H_VM_SA" "serviceAccount:$H_OP" allUsers allAuthenticatedUsers
    [[ "$(gcloud storage buckets describe "gs://$b" --project="$PROJECT" --format='value(public_access_prevention)')" == enforced ]] \
      && ok "gs://$b: prevenção de acesso público" || falha "gs://$b SEM prevenção de acesso público"
  done
  for b in "${H_BUCKETS[@]}"; do
    gcloud storage buckets get-iam-policy "gs://$b" --project="$PROJECT" --format=json > "$T/p.json" 2>/dev/null || continue
    sem_membro "gs://$b (homologação)" "$T/p.json" "serviceAccount:$VM_SA" "serviceAccount:$OP"
  done
  g artifacts repositories get-iam-policy cenario-homolog --location=us-east1 --format=json > "$T/p.json" 2>/dev/null \
    && sem_membro "repositório cenario-homolog" "$T/p.json" "serviceAccount:$VM_SA" "serviceAccount:$OP"
  g artifacts repositories get-iam-policy "$REPO" --location="$REGION" --format=json > "$T/p.json" 2>/dev/null \
    && sem_membro "repositório $REPO" "$T/p.json" "serviceAccount:$H_VM_SA" "serviceAccount:$H_OP"
  if existe vm "$VM"; then
    g compute instances get-iam-policy "$VM" --zone="$ZONE" --format=json > "$T/p.json"
    sem_membro "VM $VM" "$T/p.json" "serviceAccount:$H_OP" "serviceAccount:$H_VM_SA"
    local meta; meta="$(g compute instances describe "$VM" --zone="$ZONE" --format=json)"
    [[ "$(jq -r '[.metadata.items[]? | select(.key == "ssh-keys")] | length' <<<"$meta")" == 0 ]] && ok "VM $VM sem chaves SSH nos metadados" || falha "VM $VM com ssh-keys nos metadados"
    [[ "$(jq -r '.metadata.items[]? | select(.key == "enable-oslogin") | .value' <<<"$meta")" == TRUE ]] && ok "VM $VM com OS Login" || falha "VM $VM sem OS Login"
    [[ "$(jq -r '.serviceAccounts[0].email' <<<"$meta")" == "$VM_SA" ]] && ok "VM $VM roda como $VM_SA" || falha "VM $VM com outra conta"
  fi
  g compute instances get-iam-policy "$H_VM" --zone="$H_ZONE" --format=json > "$T/p.json" 2>/dev/null \
    && sem_membro "VM $H_VM (homologação)" "$T/p.json" "serviceAccount:$OP" "serviceAccount:$VM_SA"
  if existe topico "$TOPICO"; then
    g pubsub topics get-iam-policy "$TOPICO" --format=json > "$T/p.json"
    sem_membro "tópico $TOPICO" "$T/p.json" "serviceAccount:$H_OP"
  fi
  g pubsub topics get-iam-policy cenario-homolog-comandos --format=json > "$T/p.json" 2>/dev/null \
    && sem_membro "tópico cenario-homolog-comandos" "$T/p.json" "serviceAccount:$OP"
  if existe sa "$OP"; then
    g iam service-accounts get-iam-policy "$OP" --format=json > "$T/p.json"
    sem_membro "quem assina como $OP" "$T/p.json" "serviceAccount:$H_OP" "user:$CONTA"
  fi
  g iam service-accounts get-iam-policy "$H_OP" --format=json > "$T/p.json" 2>/dev/null \
    && sem_membro "quem assina como $H_OP" "$T/p.json" "serviceAccount:$OP"
  g projects get-iam-policy "$PROJECT" --format=json > "$T/proj.json"
  local quem r
  for quem in "$OP" "$VM_SA"; do
    for r in $(jq -r --arg m "serviceAccount:$quem" '[.bindings[]? | select(.members | index($m)) | .role] | .[]' "$T/proj.json"); do
      [[ "$r" =~ $PROIBIDOS ]] && falha "$quem tem papel proibido no projeto: $r"
    done
  done
  g compute firewall-rules list --filter="network~/$VPC\$" --format='value(name,sourceRanges.list())' > "$T/fw.txt"
  local linhas; linhas="$(wc -l < "$T/fw.txt")"
  if grep -qvE "^($FW_WEB|$FW_IAP)[[:space:]]" "$T/fw.txt"; then falha "regras de firewall inesperadas em $VPC: $(cat "$T/fw.txt")"
  else ok "firewall de $VPC: só $FW_WEB (80/443) e $FW_IAP (22 do IAP) — $linhas regra(s)"; fi
  local problemas=$((FALHAS - antes))
  (( problemas == 0 )) && ok "ISOLAMENTO: OK" || echo "✘ ISOLAMENTO com $problemas problema(s)"
  (( problemas == 0 ))
}

# ======================================================================== DNS (nunca alterado aqui)
dns() {
  requisitos
  existe ip "$IP_NOME" || { echo "✘ IP $IP_NOME ausente: rode 'infraestrutura' antes"; exit 1; }
  local ip; ip="$(g compute addresses describe "$IP_NOME" --region="$REGION" --format='value(address)')"
  secao "DNS atual"
  dns_atual
  local raiz www; raiz="$(dig +short "$DOMINIO" A @8.8.8.8 | paste -sd' ')"; www="$(dig +short "$DOMINIO_WWW" A @8.8.8.8 | paste -sd' ')"
  if [[ "$raiz" == "$ip" && "$www" == "$ip" ]]; then ok "$DOMINIO e $DOMINIO_WWW já apontam para $ip"; return 0; fi
  if [[ -n "$raiz" && "$raiz" != "$ip" ]]; then
    aviso "$DOMINIO aponta HOJE para: $raiz. Antes de trocar, confirme no painel da Hostinger que esse destino"
    echo "  NÃO é um serviço em uso (site, loja, e-mail web). Registros MX/TXT (e-mail, verificações) NÃO são alterados."
    confirmar "O DESTINO ATUAL NAO E UM SERVICO EM USO"
  fi
  local caa; caa="$(dig +short "$DOMINIO" CAA @8.8.8.8)"
  secao "Na Hostinger (hPanel → Domínios → $DOMINIO → DNS), crie/ajuste SOMENTE:"
  echo "  • A     @      → $ip   (substitua apenas registros A/AAAA/ALIAS do '@'; TTL 300)"
  echo "  • CNAME www    → $DOMINIO   (ou A www → $ip; remova outro A/AAAA/CNAME do 'www')"
  [[ -n "$caa" && "$caa" != *letsencrypt.org* ]] && echo "  • CAA   @      0 issue \"letsencrypt.org\"   (há CAA que hoje impediria o certificado)"
  echo "  NÃO altere: 'teste' (homologação), MX, TXT, NS."
  printf '\nQuando terminar, pressione Enter: a propagação é conferida a cada 30 s (até 30 min).'; read -r _ || true
  local n
  for n in $(seq 1 60); do
    raiz="$(dig +short "$DOMINIO" A @8.8.8.8 | paste -sd' ')"; www="$(dig +short "$DOMINIO_WWW" A @1.1.1.1 | tail -1)"
    if [[ "$raiz" == "$ip" && "$www" == "$ip" && "$(dig +short "$DOMINIO" A @1.1.1.1 | paste -sd' ')" == "$ip" ]]; then
      ok "DNS propagado: $DOMINIO e $DOMINIO_WWW → $ip (8.8.8.8 e 1.1.1.1)"
      [[ "$(dig +short "teste.$DOMINIO" A @8.8.8.8)" == 136.108.15.103 ]] && ok "teste.$DOMINIO (homologação) inalterado" || aviso "confira teste.$DOMINIO"
      echo "$(date -u +%FT%TZ) dns ok $ip" >> "$RELDIR/provisionamento.log"
      return 0
    fi
    echo "  (tentativa $n: $DOMINIO → ${raiz:-∅} · www → ${www:-∅})"; sleep 30
  done
  falha "DNS ainda não aponta para $ip; rode 'dns' de novo mais tarde"; return 1
}

# ======================================================================== credencial (Network Secret)
credencial() {
  requisitos
  existe sa "$OP" || { echo "✘ $OP ausente: rode 'operador' antes"; exit 1; }
  secao "Credencial do operador de produção para um AMBIENTE NOVO do Claude Code"
  cat <<EOF
  A chave vale SÓ para $OP (operações nomeadas da VM $VM; nenhuma permissão na homologação).
  Ela deve ir para um ambiente do Claude Code SEPARADO (ex.: "Cenário — Produção"), nunca para o ambiente
  da homologação (que injeta a credencial do claude-operador). No ambiente novo: Editar → Network secrets →
  tipo "GCP access token (with Service Account Key)" para *.googleapis.com.
EOF
  printf '\nO tipo "GCP access token (with Service Account Key)" aparece nos Network secrets do ambiente novo? (digite existe) > '
  local r; read -r r || true
  [[ "$r" == existe ]] || { echo "Nada criado."; return 1; }
  local d; d="$(mktemp -d)"; chmod 700 "$d"
  g iam service-accounts keys create "$d/claude-operador-prod.json" --iam-account="$OP" --format=none
  chmod 600 "$d/claude-operador-prod.json"
  echo "  Arquivo criado (conteúdo NÃO exibido): $d/claude-operador-prod.json"
  command -v cloudshell >/dev/null && cloudshell download "$d/claude-operador-prod.json" || echo "  Baixe o arquivo pelo menu do Cloud Shell."
  printf '\nQuando o Network Secret estiver salvo no ambiente novo, digite "concluido" (o arquivo aqui será destruído) > '
  read -r r || true
  shred -u "$d/claude-operador-prod.json" 2>/dev/null || rm -f "$d/claude-operador-prod.json"; rmdir "$d"
  ok "arquivo local destruído; a chave só existe no Network Secret do ambiente de produção"
}

emergencia() {
  requisitos
  confirmar "DESATIVAR OPERADOR DE PRODUCAO"
  g iam service-accounts disable "$OP" --format=none && ok "$OP desativado (nada assina como ele)"
  ssh_vm "sudo touch /etc/cenario/runner-desativado && echo runner pausado" < /dev/null && ok "runner da VM pausado (/etc/cenario/runner-desativado)"
  echo "Reativar: gcloud iam service-accounts enable $OP --project=$PROJECT; e na VM: sudo rm /etc/cenario/runner-desativado"
}

case "${1:-}" in
  auditar) auditar ;;
  plano) plano ;;
  custos) custos ;;
  infraestrutura) infraestrutura ;;
  promover) promover ;;
  preparar-vm) preparar_vm ;;
  operador) operador ;;
  canal) requisitos; existe sa "$OP" || { echo "✘ $OP ausente: rode 'operador'"; exit 1; }
         teste_canal; concluir_operador ;;
  dns) dns ;;
  verificar) verificar ;;
  credencial) credencial ;;
  emergencia) emergencia ;;
  tudo) infraestrutura; promover; preparar_vm; operador; dns; verificar; credencial
        echo; echo "PROVISIONAMENTO CONCLUÍDO. Próximo passo (sessão no ambiente de PRODUÇÃO do Claude Code): primeiro deploy de $TAG_APP." ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
