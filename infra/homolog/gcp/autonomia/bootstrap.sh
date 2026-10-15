#!/usr/bin/env bash
# BOOTSTRAP ÚNICO da autonomia operacional da homologação (Cloud Shell, na raiz do repositório,
# com a SUA conta e a chave SSH carregada no ssh-agent). Só homologação; produção não é tocada.
#
#   bash infra/homolog/gcp/autonomia/bootstrap.sh            # tudo: confere → mostra o plano → confirma → aplica → testa
#   bash infra/homolog/gcp/autonomia/bootstrap.sh plano      # SÓ mostra o que existe e o que seria criado (nada muda)
#   bash infra/homolog/gcp/autonomia/bootstrap.sh publicar-runner   # publica a versão do runner deste commit (gravação humana)
#   bash infra/homolog/gcp/autonomia/bootstrap.sh verificar  # isolamento + teste do canal (sem criar nada)
#
# Cria (se ausente; nunca duplica nem remove o que já existe):
#   contas claude-operador (operador) e cenario-build (Cloud Build); papéis personalizados
#   cenarioOperadorVm (get/start/stop/reset SÓ na VM), cenarioAssinaJwt (signJwt) e cenarioOperadorBuild
#   (só consultar builds); tópicos e assinatura Pub/Sub; o GATILHO de build (conta cenario-build e
#   passos fixos, criado por você); buckets de operações (auditoria, 90 d), de fonte do build (7 d) e de
#   versões do runner (só você grava); as ligações IAM listadas no plano; o runner na VM (pela SUA sessão SSH).
# claude-operador NÃO cria builds: só envia a fonte de um commit e publica o pedido no tópico do gatilho.
# Não cria: chave da conta antes da sua confirmação explícita no final; nada em outros projetos;
# Owner/Editor/IAM Admin; permissão de metadados da VM; acesso a segredos.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
# shellcheck source=../ssh-agente.sh
source infra/homolog/gcp/ssh-agente.sh

PROJECT=cenariogestao
REGION=us-east1
ZONE=us-east1-b
VM=cenario-homolog
DOMINIO=teste.cenariogestao.com.br
OUTRO_PROJETO=verificapro-8d3c8
OP_NOME=claude-operador
OP="$OP_NOME@$PROJECT.iam.gserviceaccount.com"
BUILD_NOME=cenario-build
BUILD="$BUILD_NOME@$PROJECT.iam.gserviceaccount.com"
VM_SA="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com"
TOPICO=cenario-homolog-comandos
ASSINATURA=cenario-homolog-comandos-vm
B_OPS="$PROJECT-homolog-operacoes"
B_BUILD="$PROJECT-homolog-build"
B_VERSOES="$PROJECT-homolog-runner-versoes"
REPO_AR=cenario-homolog
PAPEL_VM=cenarioOperadorVm
PAPEL_JWT=cenarioAssinaJwt
PAPEL_BUILD=cenarioOperadorBuild
PERM_VM="compute.instances.get,compute.instances.getSerialPortOutput,compute.instances.reset,compute.instances.start,compute.instances.stop"
PERM_JWT="iam.serviceAccounts.signJwt"
# claude-operador só CONSULTA builds. Quem cria a build é o gatilho Pub/Sub (definido por você, com a
# conta cenario-build e os passos de cloudbuild-autonomo.json fixos nele). Sem cloudbuild.builds.create,
# o operador não consegue criar, re-executar nem gatilhar builds com outra conta (legada, Compute, VM…).
PERM_BUILD="cloudbuild.builds.get,cloudbuild.builds.list"
TOPICO_BUILD=cenario-homolog-build
GATILHO=cenario-homolog-build-autonomo
CONFIG_BUILD=infra/homolog/gcp/autonomia/cloudbuild-autonomo.json
SUBST_BUILD="_TAG=\$(body.message.attributes.tag),_FONTE=\$(body.message.attributes.fonte),_BUCKET=$B_BUILD,_REGION=$REGION,_REPO=$REPO_AR"
APIS=(pubsub.googleapis.com iamcredentials.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com logging.googleapis.com iam.googleapis.com)
RUNNER_DIR=infra/homolog/gcp/autonomia/runner
OPERAR=(python3 -I infra/homolog/gcp/autonomia/operar.py)
[[ -n "${CENARIO_OPERAR_CMD:-}" ]] && read -r -a OPERAR <<<"$CENARIO_OPERAR_CMD"  # só nos testes

# Papéis concedidos (o plano mostra exatamente estes). Nada além disto é concedido.
PROJ_OP=(roles/compute.viewer roles/logging.viewer roles/monitoring.viewer "projects/$PROJECT/roles/$PAPEL_BUILD" roles/serviceusage.serviceUsageConsumer)
PROJ_BUILD=(roles/logging.logWriter)
PROJ_VMSA=(roles/logging.logWriter)
PROIBIDOS='^roles/(owner|editor|iam\.securityAdmin|iam\.serviceAccountAdmin|iam\.roleAdmin|resourcemanager\..*|secretmanager\..*|compute\.admin|compute\.instanceAdmin.*|storage\.admin)$'

RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-homolog-relatorios}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
g() { gcloud --project="$PROJECT" "$@"; }
ok() { echo "✔ $*"; }
falha() { echo "✘ $*"; FALHAS=$((FALHAS + 1)); }
secao() { echo; echo "== $*"; }
FALHAS=0
confirmar() { # confirmar <frase exata>
  printf '\nPara prosseguir, digite exatamente: %s\n> ' "$1"
  local r; read -r r || true
  [[ "$r" == "$1" ]] || { echo "Cancelado. Nada foi alterado depois deste ponto."; exit 1; }
}

# Permissões que permitiriam agir como outra conta, mudar IAM ou executar código fora do desenho.
PERIGOSAS='^(cloudbuild\.builds\.(create|update)|iam\.serviceAccounts\.(actAs|getAccessToken|getOpenIdToken|signBlob|signJwt|implicitDelegation)|iam\.serviceAccountKeys\.create|iam\.roles\.(create|update|delete)|[A-Za-z0-9.]+\.setIamPolicy|compute\.instances\.(setMetadata|setServiceAccount)|compute\.projects\.setCommonInstanceMetadata|cloudbuild\.builds\.approve|cloudbuild\.workerpools\.(create|update)|deploymentmanager\..*|cloudfunctions\.functions\.(create|update)|run\.(services|jobs)\.(create|update)|container\.clusters\.(create|update)|composer\.environments\.(create|update)|dataflow\.jobs\.create|notebooks\.instances\.create)$'
BLOQUEIOS=()

# ============================================================ 1. conferências (só leitura)
requisitos() {
  local c faltam=()
  for c in gcloud jq python3 openssl git tar sha256sum; do command -v "$c" >/dev/null 2>&1 || faltam+=("$c"); done
  (( ${#faltam[@]} == 0 )) || { echo "✘ ferramentas ausentes: ${faltam[*]} (use o Cloud Shell)"; exit 1; }
  CONTA="$(gcloud config get-value account 2>/dev/null || true)"
  [[ -n "$CONTA" ]] || { echo "✘ nenhuma conta no gcloud (gcloud auth login)"; exit 1; }
  [[ "$CONTA" != *.gserviceaccount.com ]] || { echo "✘ o bootstrap é feito pela SUA conta, não por uma conta de serviço ($CONTA)"; exit 1; }
  g projects describe "$PROJECT" --format=json > "$T/projeto.json" 2>/dev/null || { echo "✘ projeto $PROJECT inacessível com $CONTA"; exit 1; }
  [[ "$(jq -r .lifecycleState "$T/projeto.json")" == ACTIVE ]] || { echo "✘ projeto $PROJECT não está ativo"; exit 1; }
  NUM="$(jq -r .projectNumber "$T/projeto.json")"
  g compute instances describe "$VM" --zone="$ZONE" --format=json > "$T/vm.json" 2>/dev/null || { echo "✘ VM $VM não encontrada em $ZONE"; exit 1; }
  [[ "$(jq -r '.serviceAccounts[0].email // ""' "$T/vm.json")" == "$VM_SA" ]] || { echo "✘ a VM não usa a conta $VM_SA"; exit 1; }
  jq -e '.serviceAccounts[0].scopes | index("https://www.googleapis.com/auth/cloud-platform")' "$T/vm.json" >/dev/null \
    || { echo "✘ a VM não tem o escopo cloud-platform (o runner não alcançaria o Pub/Sub)"; exit 1; }
  [[ -z "$(git status --porcelain -- infra/homolog)" ]] || { echo "✘ há mudanças não commitadas em infra/homolog: o runner publicado precisa ser um commit"; exit 1; }
  COMMIT="$(git rev-parse HEAD)"
  RVER="$(tr -dc '0-9.' < "$RUNNER_DIR/VERSAO")"
  [[ "$(python3 -I "$RUNNER_DIR/cenario_runner.py" --versao)" == "$RVER" ]] || { echo "✘ VERSAO do runner difere do código"; exit 1; }
  echo "Conta: $CONTA · Projeto: $PROJECT (nº $NUM) · VM: $VM ($ZONE, $(jq -r .status "$T/vm.json")) · commit $COMMIT · runner $RVER"
}

existe() { # existe <tipo> <nome>
  case "$1" in
    sa) g iam service-accounts describe "$2" >/dev/null 2>&1 ;;
    papel) g iam roles describe "$2" >/dev/null 2>&1 ;;
    topico) g pubsub topics describe "$2" >/dev/null 2>&1 ;;
    assinatura) g pubsub subscriptions describe "$2" >/dev/null 2>&1 ;;
    bucket) gcloud storage buckets describe "gs://$2" --project="$PROJECT" >/dev/null 2>&1 ;;
    repo) g artifacts repositories describe "$2" --location="$REGION" >/dev/null 2>&1 ;;
    gatilho) g builds triggers describe "$2" --region="$REGION" >/dev/null 2>&1 ;;
    api) grep -qx "$2" "$T/apis.txt" ;;
  esac
}

bloquear() { echo "⛔ $*"; BLOQUEIOS+=("$*"); }

permissoes() { # permissoes <papel> → uma permissão por linha. Os papéis deste desenho valem pela definição
  local p="$1" c="$T/perm-${1//[\/.]/_}"  # planejada (o bootstrap atualiza um papel existente para ela).
  if [[ ! -f "$c" ]]; then
    case "$p" in
      "projects/$PROJECT/roles/$PAPEL_VM") tr ',' '\n' <<<"$PERM_VM" ;;
      "projects/$PROJECT/roles/$PAPEL_JWT") tr ',' '\n' <<<"$PERM_JWT" ;;
      "projects/$PROJECT/roles/$PAPEL_BUILD") tr ',' '\n' <<<"$PERM_BUILD" ;;
      projects/*) g iam roles describe "${p##*/}" --format=json 2>/dev/null | jq -r '.includedPermissions[]?' ;;
      *) gcloud iam roles describe "$p" --format=json 2>/dev/null | jq -r '.includedPermissions[]?' ;;
    esac > "$c" || true
  fi
  cat "$c"
}
papeis_no_projeto() { jq -r --arg m "$1" '[.bindings[]? | select(.members | index($m)) | .role] | unique | .[]' "$T/proj-iam.json"; }

# Cloud Build: quem CRIA uma build escolhe a conta em que ela roda (ou a padrão do projeto); o Cloud Build
# exige iam.serviceAccounts.actAs na conta, EXCETO na conta legada (NUM@cloudbuild.gserviceaccount.com).
# Por isso claude-operador não recebe cloudbuild.builds.create em lugar nenhum: as builds autônomas só
# nascem do gatilho Pub/Sub que VOCÊ define (conta cenario-build e passos fixos). Esta auditoria prova
# que o operador não consegue criar, re-executar nem gatilhar builds com outra conta; senão o bootstrap
# PARA, explica e NÃO altera IAM para contornar.
config_esperada() { # forma normalizada do gatilho esperado (conta, tópico, substituições, passos, imagens)
  jq -S -c --arg sa "projects/$PROJECT/serviceAccounts/$BUILD" --arg t "projects/$PROJECT/topics/$TOPICO_BUILD" \
    --arg subst "$SUBST_BUILD" '
    {sa: $sa, topico: $t,
     subst: ($subst | gsub("\\\\"; "") | split(",") | map(split("=") | {(.[0]): (.[1:] | join("="))}) | add),
     passos: [.steps[] | {id, name, entrypoint, env, args, dir, waitFor} | with_entries(select(.value != null))],
     imagens: .images, etiquetas: .tags, logging: .options.logging}' "$CONFIG_BUILD"
}
config_do_gatilho() { # mesma forma, lida do gatilho existente
  jq -S -c '{sa: .serviceAccount, topico: .pubsubConfig.topic, subst: .substitutions,
     passos: [.build.steps[] | {id, name, entrypoint, env, args, dir, waitFor} | with_entries(select(.value != null))],
     imagens: .build.images, etiquetas: .build.tags, logging: .build.options.logging}' "$1"
}

auditar_cloud_build() {
  secao "Cloud Build: o que claude-operador e as builds conseguem fazer (só leitura)"
  BLOQUEIOS=()
  : > "$T/bloq.txt"
  g projects get-iam-policy "$PROJECT" --format=json > "$T/proj-iam.json" 2>/dev/null \
    || { bloquear "política IAM do projeto ilegível com $CONTA"; return; }
  local legada="$NUM@cloudbuild.gserviceaccount.com" compute="$NUM-compute@developer.gserviceaccount.com" padrao="" r sa
  jq -e '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length == 0' "$T/proj-iam.json" >/dev/null \
    || bloquear "o projeto tem papel concedido a allUsers/allAuthenticatedUsers"

  echo "-- contas de serviço do projeto e quem pode agir sobre cada uma"
  g iam service-accounts list --format='value(email)' > "$T/sas.txt" 2>/dev/null || { bloquear "contas de serviço do projeto ilegíveis"; return; }
  while read -r sa; do
    [[ -n "$sa" ]] || continue
    g iam service-accounts get-iam-policy "$sa" --format=json > "$T/sa-iam.json" 2>/dev/null || echo '{}' > "$T/sa-iam.json"
    local quem; quem="$(jq -r '[.bindings[]? | "\(.role) → \(.members | join(", "))"] | join("; ")' "$T/sa-iam.json")"
    local psa; psa="$(papeis_no_projeto "serviceAccount:$sa" | paste -sd' ' -)"
    echo "• $sa · papéis no projeto: ${psa:-nenhum} · quem age sobre ela: ${quem:-só Owners}"
    jq -e '[.bindings[]?.members[]? | select(. == "allUsers" or . == "allAuthenticatedUsers" or startswith("domain:"))] | length == 0' "$T/sa-iam.json" >/dev/null \
      || echo "$sa: ligação pública ou de domínio na política da conta" >> "$T/bloq.txt"
    while read -r r; do  # claude-operador: só a assinatura do próprio JWT; actAs em NENHUMA conta
      [[ -z "$r" || "$sa:$r" == "$OP:projects/$PROJECT/roles/$PAPEL_JWT" ]] && continue
      echo "claude-operador tem $r sobre $sa (poderia agir como ela)" >> "$T/bloq.txt"
    done < <(jq -r --arg m "serviceAccount:$OP" '.bindings[]? | select(.members | index($m)) | .role' "$T/sa-iam.json")
    while read -r r; do  # cenario-build (conta das builds) não pode agir sobre nenhuma conta
      [[ -n "$r" ]] && echo "cenario-build tem $r sobre $sa (uma build poderia agir como ela)" >> "$T/bloq.txt"
    done < <(jq -r --arg m "serviceAccount:$BUILD" '.bindings[]? | select(.members | index($m)) | .role' "$T/sa-iam.json")
  done < "$T/sas.txt"

  local conta planejados atuais
  for conta in "$OP" "$BUILD"; do  # papéis no projeto (atuais + planejados): sem criar build e sem escalada
    if [[ "$conta" == "$OP" ]]; then planejados="${PROJ_OP[*]}"; else planejados="${PROJ_BUILD[*]}"; fi
    atuais="$(papeis_no_projeto "serviceAccount:$conta" | paste -sd' ' -)"
    for r in $atuais; do [[ " $planejados " == *" $r "* ]] || echo "$conta já tem no projeto o papel $r, fora do desenho" >> "$T/bloq.txt"; done
    for r in $(printf '%s\n' $atuais $planejados | sort -u); do
      local perms; perms="$(permissoes "$r")"
      [[ -n "$perms" ]] || { echo "permissões do papel $r ilegíveis (falha fechada)" >> "$T/bloq.txt"; continue; }
      local ruins; ruins="$(grep -E "$PERIGOSAS" <<<"$perms" | paste -sd' ' - || true)"
      [[ -z "$ruins" ]] || echo "$conta: o papel $r inclui $ruins" >> "$T/bloq.txt"
    done
  done

  echo "-- gatilhos do Cloud Build (região $REGION e global)"
  { g builds triggers list --region="$REGION" --format=json 2>/dev/null || echo '[]'; g builds triggers list --format=json 2>/dev/null || echo '[]'; } \
    | jq -s 'add // []' > "$T/gatilhos.json"
  jq -r '.[] | "• gatilho \(.name) · conta: \(.serviceAccount // "PADRÃO DO PROJETO") · evento: \(if .pubsubConfig then "Pub/Sub " + .pubsubConfig.topic elif .webhookConfig then "webhook" elif .github or .repositoryEventConfig or .triggerTemplate then "repositório" else "manual" end)"' "$T/gatilhos.json"
  [[ "$(jq length "$T/gatilhos.json")" == 0 ]] && echo "• nenhum gatilho existente"
  jq -r --arg a "projects/$PROJECT/topics/$TOPICO" --arg b "projects/$PROJECT/topics/$TOPICO_BUILD" --arg g "$GATILHO" \
    '.[] | select(.name != $g and (.pubsubConfig.topic == $a or .pubsubConfig.topic == $b)) | "o gatilho \(.name) escuta um tópico em que claude-operador publica"' "$T/gatilhos.json" >> "$T/bloq.txt"
  jq -r --arg g "$GATILHO" '.[] | select(.name == $g)' "$T/gatilhos.json" > "$T/gatilho.json"
  if [[ -s "$T/gatilho.json" ]]; then
    if [[ "$(config_do_gatilho "$T/gatilho.json")" == "$(config_esperada)" ]]; then ok "gatilho $GATILHO existe e é idêntico ao do repositório (conta $BUILD, passos fixos)"
    else echo "o gatilho $GATILHO existe mas DIFERE do repositório (conta, tópico, substituições ou passos): não é reutilizado nem alterado automaticamente" >> "$T/bloq.txt"; fi
  else echo "• gatilho $GATILHO: será criado (conta $BUILD, tópico $TOPICO_BUILD, passos de $CONFIG_BUILD)"; fi

  while read -r r; do [[ -n "$r" ]] && bloquear "$r"; done < "$T/bloq.txt"

  echo "-- contas padrão e legada (informação: inalcançáveis por claude-operador sem cloudbuild.builds.create)"
  if padrao="$(g builds get-default-service-account --region="$REGION" --format='value(serviceAccountEmail)' 2>/dev/null)" && [[ -n "$padrao" ]]; then
    padrao="${padrao##*/}"; echo "• conta PADRÃO das builds em $REGION: $padrao"
  else padrao=""; echo "• conta padrão das builds em $REGION: não lida"; fi
  local pl pc; pl="$(papeis_no_projeto "serviceAccount:$legada" | paste -sd' ' -)"; pc="$(papeis_no_projeto "serviceAccount:$compute" | paste -sd' ' -)"
  echo "• conta LEGADA $legada · papéis: ${pl:-nenhum}"
  echo "• conta Compute padrão $compute · papéis: ${pc:-nenhum}"
  g builds list --region="$REGION" --limit=100 --format=json > "$T/builds.json" 2>/dev/null || echo '[]' > "$T/builds.json"
  echo "• builds anteriores em $REGION: $(jq length "$T/builds.json")"
  jq -r '.[] | "    \(.createTime // "?") \(.id[0:8]) conta=\(.serviceAccount // "padrão" | split("/") | last) status=\(.status) gatilho=\(.buildTriggerId // "nenhum") fonte=\(.source.storageSource.bucket // "-")"' "$T/builds.json"
  local usa_legada; usa_legada="$(jq -r --arg l "$legada" '[.[] | select((.serviceAccount // "") | endswith($l))] | length' "$T/builds.json")"
  local gat_legada; gat_legada="$(jq -r --arg l "$legada" '[.[] | select((.serviceAccount // "") | endswith($l))] | length' "$T/gatilhos.json")"
  echo "• uso atual da conta legada: padrão=$([[ "$padrao" == "$legada" ]] && echo SIM || echo não) · gatilhos=$gat_legada · builds recentes=$usa_legada"
  if [[ -n "$pl" ]]; then
    echo "  ⚠ recomendação (opcional, NÃO feita pelo bootstrap): a conta legada tem $pl sem uso atual detectado; remover reduz"
    echo "    a superfície para OUTRAS identidades com cloudbuild.builds.create (não para claude-operador, que não tem)."
  fi
  echo "• re-execução das builds antigas: exige cloudbuild.builds.create; claude-operador não tem"

  if (( ${#BLOQUEIOS[@]} == 0 )); then
    ok "Cloud Build: claude-operador NÃO cria, re-executa nem gatilha builds com outra conta; builds autônomas só pelo gatilho $GATILHO com $BUILD"
  else
    echo "⛔ Cloud Build BLOQUEADO: ${#BLOQUEIOS[@]} problema(s) acima. O bootstrap NÃO continua e NÃO altera IAM para contorná-los."
  fi
}

conflitos() {
  secao "Conflitos e recursos existentes"
  local n=0 c
  if existe sa "$OP"; then
    c="$(g iam service-accounts keys list --iam-account="$OP" --managed-by=user --format='value(name.basename())' | wc -l | tr -d ' ')"
    (( c == 0 )) && ok "$OP existe, sem chaves" || { echo "⚠ $OP já tem $c chave(s) (o bootstrap só cria outra se você pedir; revogue as antigas)"; n=$((n + 1)); }
  fi
  local id perm alvo
  for id in "$PAPEL_VM:$PERM_VM" "$PAPEL_JWT:$PERM_JWT" "$PAPEL_BUILD:$PERM_BUILD"; do
    perm="${id#*:}"; id="${id%%:*}"
    existe papel "$id" || continue
    alvo="$(tr ',' '\n' <<<"$perm" | sort | paste -sd, -)"
    [[ "$(g iam roles describe "$id" --format='value(includedPermissions)' | tr ';' '\n' | sort | paste -sd, -)" == "$alvo" ]] \
      && ok "papel $id existe com as permissões previstas" || { echo "⚠ papel $id existe com OUTRAS permissões: será ajustado para $perm"; n=$((n + 1)); }
  done
  local tp pubs
  for tp in "$TOPICO" "$TOPICO_BUILD"; do
    existe topico "$tp" || continue
    pubs="$(g pubsub topics get-iam-policy "$tp" --format=json | jq -r '[.bindings[]? | select(.role == "roles/pubsub.publisher") | .members[]] | join(", ")')"
    echo "• publicadores atuais de $tp: ${pubs:-nenhum}"
    [[ -z "$pubs" || "$pubs" == "serviceAccount:$OP" ]] || { echo "⚠ há outros publicadores em $tp (quem publica ali pede operações/builds; confira)"; n=$((n + 1)); }
  done
  (( n == 0 )) && ok "nenhum conflito com recursos existentes"
  cat <<EOF
• Outros projetos: o bootstrap só ESCREVE com --project=$PROJECT. Em $OUTRO_PROJETO e nos demais projetos ele apenas
  LÊ a política IAM, para provar que as contas claude-operador e cenario-build não têm acesso. Nada é alterado neles.
• Produção: nenhum recurso de produção é lido, criado ou alterado.
EOF
}

plano() {
  secao "Plano (✔ já existe · ◻ será criado/aplicado)"
  g services list --enabled --format='value(config.name)' > "$T/apis.txt" 2>/dev/null || : > "$T/apis.txt"
  local a; for a in "${APIS[@]}"; do existe api "$a" && ok "API $a" || echo "◻ ativar API $a"; done
  existe sa "$OP" && ok "conta $OP" || echo "◻ criar conta $OP (identidade técnica do operador; sem chave até o fim)"
  existe sa "$BUILD" && ok "conta $BUILD" || echo "◻ criar conta $BUILD (Cloud Build: só publica imagens no repositório $REPO_AR)"
  existe papel "$PAPEL_VM" && ok "papel $PAPEL_VM" || echo "◻ criar papel $PAPEL_VM: $PERM_VM"
  existe papel "$PAPEL_JWT" && ok "papel $PAPEL_JWT" || echo "◻ criar papel $PAPEL_JWT: $PERM_JWT"
  existe papel "$PAPEL_BUILD" && ok "papel $PAPEL_BUILD" || echo "◻ criar papel $PAPEL_BUILD: $PERM_BUILD (no lugar de roles/cloudbuild.builds.editor)"
  existe topico "$TOPICO" && ok "tópico $TOPICO" || echo "◻ criar tópico $TOPICO"
  existe topico "$TOPICO_BUILD" && ok "tópico $TOPICO_BUILD" || echo "◻ criar tópico $TOPICO_BUILD (pedidos de build)"
  existe gatilho "$GATILHO" && ok "gatilho $GATILHO" || echo "◻ criar gatilho $GATILHO (Pub/Sub $TOPICO_BUILD → build com $BUILD e os passos de $CONFIG_BUILD)"
  existe assinatura "$ASSINATURA" && ok "assinatura $ASSINATURA" || echo "◻ criar assinatura $ASSINATURA (confirmação 60 s, retenção 10 min, sem expiração)"
  local b; for b in "$B_OPS" "$B_BUILD" "$B_VERSOES"; do existe bucket "$b" && ok "bucket gs://$b" || echo "◻ criar bucket gs://$b ($REGION, acesso uniforme, sem acesso público)"; done
  existe repo "$REPO_AR" || { echo "✘ repositório Artifact Registry $REPO_AR ausente (criado na preparação da homologação)"; exit 1; }
  cat <<EOF
◻ IAM (idempotente; nada é removido):
    $OP
      projeto: ${PROJ_OP[*]}
               ($PAPEL_BUILD = $PERM_BUILD: só consulta; NENHUM cloudbuild.builds.create, NENHUM actAs)
      VM $VM: projects/$PROJECT/roles/$PAPEL_VM          (sem metadados, sem SSH, sem troca de conta)
      conta $OP: projects/$PROJECT/roles/$PAPEL_JWT      (assina o próprio JWT; não cria tokens nem chaves)
      tópico $TOPICO: roles/pubsub.publisher             (operações para o runner)
      tópico $TOPICO_BUILD: roles/pubsub.publisher       (pedidos de build ao gatilho $GATILHO)
      gs://$B_OPS: roles/storage.objectViewer            (lê resultados e auditoria)
      gs://$B_BUILD: roles/storage.objectCreator + roles/storage.objectViewer (envia a fonte; não apaga nem sobrescreve)
      repositório $REPO_AR: roles/artifactregistry.reader
      gs://$B_VERSOES: NENHUM (só você publica versões do runner)
    $BUILD
      projeto: ${PROJ_BUILD[*]} · repositório $REPO_AR: roles/artifactregistry.writer · gs://$B_BUILD: roles/storage.objectViewer
    $VM_SA (conta da VM)
      projeto: ${PROJ_VMSA[*]} · assinatura $ASSINATURA: roles/pubsub.subscriber
      gs://$B_OPS: roles/storage.objectCreator (só cria; não lê nem sobrescreve) · gs://$B_VERSOES: roles/storage.objectViewer
◻ publicar runner $RVER em gs://$B_VERSOES (imutável, com SHA-256) e instalar na VM pela sua sessão SSH
◻ teste do canal: permissão TEMPORÁRIA de assinatura para $CONTA (removida no fim), status/version e testes de segurança
◻ isolamento: nenhuma das duas contas em $OUTRO_PROJETO nem em outro projeto visível
◻ chave JSON de $OP: SÓ depois da sua confirmação de que o Network Secret do tipo
  "GCP access token (with Service Account Key)" existe no ambiente; nunca exibida
EOF
  conflitos
  auditar_cloud_build
}

# ============================================================ 2. aplicação (idempotente)
ligar() { # ligar <descrição> <comando…> — add-iam-policy-binding é idempotente
  local d="$1"; shift
  [[ "$*" =~ --role=([^ ]+) ]] && [[ "${BASH_REMATCH[1]}" =~ $PROIBIDOS ]] && { echo "✘ papel proibido: ${BASH_REMATCH[1]}"; exit 1; }
  "$@" --quiet --format=none >/dev/null && ok "$d" || { falha "$d"; return 1; }
}

papel() { # papel <id> <título> <permissões>
  if existe papel "$1"; then
    local atuais; atuais="$(g iam roles describe "$1" --format='value(includedPermissions)' | tr ';' '\n' | sort | paste -sd,)"
    if [[ "$atuais" == "$(tr ',' '\n' <<<"$3" | sort | paste -sd,)" ]]; then ok "papel $1 (permissões conferidas)"
    else g iam roles update "$1" --permissions="$3" --quiet --format=none && ok "papel $1 atualizado para: $3"; fi
  else g iam roles create "$1" --title="$2" --permissions="$3" --stage=GA --format=none && ok "papel $1 criado"; fi
}

bucket() { # bucket <nome> <dias-de-retenção|0>
  if existe bucket "$1"; then ok "bucket gs://$1"
  else
    gcloud storage buckets create "gs://$1" --project="$PROJECT" --location="$REGION" --uniform-bucket-level-access \
      --public-access-prevention --format=none && ok "bucket gs://$1 criado"
  fi
  if [[ "$2" != 0 ]]; then
    printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}' "$2" > "$T/ciclo.json"
    gcloud storage buckets update "gs://$1" --project="$PROJECT" --lifecycle-file="$T/ciclo.json" --format=none && ok "gs://$1: exclusão após $2 dias"
  fi
}

aplicar() {
  secao "Aplicando"
  local a; for a in "${APIS[@]}"; do existe api "$a" || { g services enable "$a" --format=none && ok "API $a ativada"; }; done
  existe sa "$OP" || g iam service-accounts create "$OP_NOME" --display-name="Claude - operador da homologacao" \
    --description="Opera SO a homologacao do Cenario Gestao (operacoes nomeadas). Sem acesso a producao." --format=none
  ok "conta $OP"
  existe sa "$BUILD" || g iam service-accounts create "$BUILD_NOME" --display-name="Cenario - Cloud Build da homologacao" \
    --description="Executa o Cloud Build das imagens da homologacao" --format=none
  ok "conta $BUILD"
  papel "$PAPEL_VM" "Cenario - operar a VM da homologacao" "$PERM_VM"
  papel "$PAPEL_JWT" "Cenario - assinar JWT do operador" "$PERM_JWT"
  papel "$PAPEL_BUILD" "Cenario - iniciar e consultar builds" "$PERM_BUILD"
  # Antes de QUALQUER ligação IAM, a auditoria é refeita (o estado pode ter mudado desde o plano).
  auditar_cloud_build
  (( ${#BLOQUEIOS[@]} == 0 )) || { echo "✘ nenhuma ligação IAM foi feita."; exit 1; }
  existe topico "$TOPICO" || g pubsub topics create "$TOPICO" --format=none
  ok "tópico $TOPICO"
  existe topico "$TOPICO_BUILD" || g pubsub topics create "$TOPICO_BUILD" --format=none
  ok "tópico $TOPICO_BUILD"
  existe assinatura "$ASSINATURA" || g pubsub subscriptions create "$ASSINATURA" --topic="$TOPICO" --ack-deadline=60 \
    --message-retention-duration=10m --expiration-period=never --format=none
  ok "assinatura $ASSINATURA"
  bucket "$B_OPS" 90
  bucket "$B_BUILD" 7
  bucket "$B_VERSOES" 0

  local r
  for r in "${PROJ_OP[@]}"; do ligar "$OP: $r (projeto)" g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$OP" --role="$r" --condition=None; done
  for r in "${PROJ_BUILD[@]}"; do ligar "$BUILD: $r (projeto)" g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD" --role="$r" --condition=None; done
  for r in "${PROJ_VMSA[@]}"; do ligar "$VM_SA: $r (projeto)" g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$VM_SA" --role="$r" --condition=None; done
  ligar "$OP: $PAPEL_VM só na VM $VM" g compute instances add-iam-policy-binding "$VM" --zone="$ZONE" --member="serviceAccount:$OP" --role="projects/$PROJECT/roles/$PAPEL_VM"
  ligar "$OP: assinar o próprio JWT" g iam service-accounts add-iam-policy-binding "$OP" --member="serviceAccount:$OP" --role="projects/$PROJECT/roles/$PAPEL_JWT"
  ligar "$OP: publicar em $TOPICO" g pubsub topics add-iam-policy-binding "$TOPICO" --member="serviceAccount:$OP" --role=roles/pubsub.publisher
  ligar "$OP: pedir builds em $TOPICO_BUILD" g pubsub topics add-iam-policy-binding "$TOPICO_BUILD" --member="serviceAccount:$OP" --role=roles/pubsub.publisher
  ligar "$VM_SA: ler $ASSINATURA" g pubsub subscriptions add-iam-policy-binding "$ASSINATURA" --member="serviceAccount:$VM_SA" --role=roles/pubsub.subscriber
  ligar "$OP: ler gs://$B_OPS" gcloud storage buckets add-iam-policy-binding "gs://$B_OPS" --project="$PROJECT" --member="serviceAccount:$OP" --role=roles/storage.objectViewer
  ligar "$VM_SA: criar em gs://$B_OPS" gcloud storage buckets add-iam-policy-binding "gs://$B_OPS" --project="$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/storage.objectCreator
  ligar "$OP: enviar fonte a gs://$B_BUILD" gcloud storage buckets add-iam-policy-binding "gs://$B_BUILD" --project="$PROJECT" --member="serviceAccount:$OP" --role=roles/storage.objectCreator
  ligar "$OP: conferir fonte em gs://$B_BUILD" gcloud storage buckets add-iam-policy-binding "gs://$B_BUILD" --project="$PROJECT" --member="serviceAccount:$OP" --role=roles/storage.objectViewer
  ligar "$BUILD: ler gs://$B_BUILD" gcloud storage buckets add-iam-policy-binding "gs://$B_BUILD" --project="$PROJECT" --member="serviceAccount:$BUILD" --role=roles/storage.objectViewer
  ligar "$VM_SA: ler versões gs://$B_VERSOES" gcloud storage buckets add-iam-policy-binding "gs://$B_VERSOES" --project="$PROJECT" --member="serviceAccount:$VM_SA" --role=roles/storage.objectViewer
  ligar "$OP: ler imagens $REPO_AR" g artifacts repositories add-iam-policy-binding "$REPO_AR" --location="$REGION" --member="serviceAccount:$OP" --role=roles/artifactregistry.reader
  ligar "$BUILD: publicar imagens $REPO_AR" g artifacts repositories add-iam-policy-binding "$REPO_AR" --location="$REGION" --member="serviceAccount:$BUILD" --role=roles/artifactregistry.writer
  (( FALHAS == 0 )) || { echo "✘ $FALHAS ligação(ões) falharam: corrija e rode de novo (idempotente)"; exit 1; }
  gatilho
}

gatilho() { # o gatilho é criado pela SUA conta (você tem actAs em cenario-build); nunca alterado depois
  if existe gatilho "$GATILHO"; then
    g builds triggers describe "$GATILHO" --region="$REGION" --format=json > "$T/gatilho.json"
    [[ "$(config_do_gatilho "$T/gatilho.json")" == "$(config_esperada)" ]] && { ok "gatilho $GATILHO conferido"; return 0; }
    echo "✘ o gatilho $GATILHO difere do repositório: nada foi alterado nele (remova-o com revogar.sh para recriar)"; exit 1
  fi
  g builds triggers create pubsub --region="$REGION" --name="$GATILHO" --topic="projects/$PROJECT/topics/$TOPICO_BUILD"     --inline-config="$CONFIG_BUILD" --service-account="projects/$PROJECT/serviceAccounts/$BUILD"     --substitutions="$SUBST_BUILD" --description="Homologacao: build das imagens api/web de um commit (pedido pelo claude-operador)" --format=none
  g builds triggers describe "$GATILHO" --region="$REGION" --format=json > "$T/gatilho.json"
  [[ "$(config_do_gatilho "$T/gatilho.json")" == "$(config_esperada)" ]] && ok "gatilho $GATILHO criado e conferido"     || { echo "✘ o gatilho criado não corresponde ao esperado: confira com revogar.sh estado"; exit 1; }
}

# ============================================================ 3. runner: publicação (humana) e instalação
pacote_runner() { # gera o pacote determinístico em $T/runner-$RVER.tar.gz
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -C "$RUNNER_DIR" -czf "$T/runner-$RVER.tar.gz" \
    VERSAO cenario-runner.service cenario_runner.py instalar.sh
  sha256sum "$T/runner-$RVER.tar.gz" | cut -d' ' -f1 > "$T/runner-$RVER.sha256"
}

publicar_runner() {
  secao "Versão $RVER do runner (commit $COMMIT)"
  pacote_runner
  local local_sha; local_sha="$(cat "$T/runner-$RVER.sha256")"
  local remoto; remoto="$(gcloud storage cat "gs://$B_VERSOES/runner-$RVER.sha256" --project="$PROJECT" 2>/dev/null | tr -dc '0-9a-f' || true)"
  if [[ -n "$remoto" ]]; then
    [[ "$remoto" == "$local_sha" ]] && { ok "runner $RVER já publicado (SHA-256 idêntico)"; return 0; }
    echo "✘ runner $RVER já foi publicado com OUTRO conteúdo: aumente VERSAO (versões são imutáveis)"; exit 1
  fi
  gcloud storage cp "$T/runner-$RVER.tar.gz" "$T/runner-$RVER.sha256" "gs://$B_VERSOES/" --project="$PROJECT" \
    --if-generation-match=0 --format=none && ok "runner $RVER publicado em gs://$B_VERSOES (SHA-256 $local_sha)"
}

instalar_runner() {
  secao "Instalação do runner $RVER na VM (pela sua sessão SSH)"
  conferir_chave_ssh 2>&1 || exit 1
  pacote_runner
  # Entrada fechada: o ssh/scp não pode consumir o restante das respostas deste script.
  g compute scp "$T/runner-$RVER.tar.gz" "$VM:/tmp/cenario-runner.tar.gz" --zone="$ZONE" --tunnel-through-iap --quiet "${SCP_SEM_PERGUNTA[@]}" < /dev/null
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" --command="set -euo pipefail
D=\$(mktemp -d); tar -xzf /tmp/cenario-runner.tar.gz -C \"\$D\"; rm -f /tmp/cenario-runner.tar.gz
sudo CENARIO_RUNNER_PROJETO=$PROJECT CENARIO_RUNNER_VM=$VM CENARIO_RUNNER_ASSINANTE=$OP \
  CENARIO_RUNNER_ASSINATURA=projects/$PROJECT/subscriptions/$ASSINATURA CENARIO_RUNNER_BUCKET=$B_OPS \
  CENARIO_RUNNER_BUCKET_VERSOES=$B_VERSOES CENARIO_RUNNER_DOMINIO=$DOMINIO bash \"\$D/instalar.sh\" \"\$D\"
rm -rf \"\$D\"" < /dev/null
}

# ============================================================ 4. testes do canal e isolamento
teste_canal() {
  secao "Teste do canal (permissão temporária de assinatura para $CONTA)"
  ligar "TEMPORÁRIO: $CONTA pode assinar como $OP" g iam service-accounts add-iam-policy-binding "$OP" --member="user:$CONTA" --role="projects/$PROJECT/roles/$PAPEL_JWT"
  local rc=0
  remover_temp() { g iam service-accounts remove-iam-policy-binding "$OP" --member="user:$CONTA" --role="projects/$PROJECT/roles/$PAPEL_JWT" --quiet --format=none >/dev/null 2>&1 \
    && ok "permissão temporária de $CONTA removida" || echo "⚠ remova manualmente: gcloud iam service-accounts remove-iam-policy-binding $OP --member=user:$CONTA --role=projects/$PROJECT/roles/$PAPEL_JWT --project=$PROJECT"; }
  trap 'remover_temp; rm -rf "$T"' EXIT
  local tentativa
  for tentativa in $(seq 1 12); do  # a propagação do IAM leva até ~2 min
    if env -u CLOUDSDK_AUTH_ACCESS_TOKEN "${OPERAR[@]}" verificar; then rc=0; break; fi
    rc=$?; echo "  (tentativa $tentativa: aguardando a propagação do IAM…)"; sleep 15
  done
  (( rc == 0 )) && ok "canal de ponta a ponta: assinatura → fila → runner → resultado no bucket" || falha "canal não respondeu"
  if (( rc == 0 )); then env -u CLOUDSDK_AUTH_ACCESS_TOKEN "${OPERAR[@]}" teste-seguranca && ok "testes de segurança do runner" || falha "testes de segurança"; fi
  remover_temp
  trap 'rm -rf "$T"' EXIT
}

isolamento() {
  secao "Isolamento das identidades"
  local p n=0
  if gcloud projects get-iam-policy "$OUTRO_PROJETO" --format=json > "$T/outro.json" 2>/dev/null; then
    jq -e --arg a "serviceAccount:$OP" --arg b "serviceAccount:$BUILD" '[.bindings[]?.members[]? | select(. == $a or . == $b)] | length == 0' "$T/outro.json" >/dev/null \
      && ok "$OUTRO_PROJETO: nenhuma das contas tem acesso" || falha "$OUTRO_PROJETO: uma das contas TEM papel"
  else echo "• $OUTRO_PROJETO: política não legível com $CONTA (sem como as contas terem sido ligadas por este script)"; fi
  for p in $(gcloud projects list --format='value(projectId)' 2>/dev/null); do
    [[ "$p" == "$PROJECT" ]] && continue
    n=$((n + 1))
    gcloud projects get-iam-policy "$p" --format=json > "$T/p.json" 2>/dev/null || continue
    jq -e --arg a "serviceAccount:$OP" --arg b "serviceAccount:$BUILD" '[.bindings[]?.members[]? | select(. == $a or . == $b)] | length == 0' "$T/p.json" >/dev/null \
      || falha "projeto $p: uma das contas TEM papel"
  done
  ok "$n outro(s) projeto(s) visível(is) conferido(s)"
  g projects get-iam-policy "$PROJECT" --format=json > "$T/proj.json"
  local papeis; papeis="$(jq -r --arg m "serviceAccount:$OP" '[.bindings[]? | select(.members | index($m)) | .role] | sort | join(" ")' "$T/proj.json")"
  local r; for r in $papeis; do [[ "$r" =~ $PROIBIDOS ]] && falha "$OP tem papel proibido: $r"; done
  echo "• papéis de $OP no projeto: ${papeis:-nenhum}"
  local quem; quem="$(g iam service-accounts get-iam-policy "$OP" --format=json | jq -r '[.bindings[]? | "\(.role)=\(.members | join(","))"] | join("; ")')"
  echo "• quem pode agir sobre $OP: ${quem:-ninguém além dos Owners}"
  [[ "$quem" == *"user:"* ]] && falha "há usuário com papel sobre $OP (permissão temporária não removida?)" || true
  local chaves; chaves="$(g iam service-accounts keys list --iam-account="$OP" --managed-by=user --format='value(name.basename())' | paste -sd' ')"
  echo "• chaves de $OP: ${chaves:-nenhuma}"
  (( FALHAS == 0 )) && ok "isolamento conferido" || echo "✘ isolamento com $FALHAS problema(s)"
}

# ============================================================ 5. credencial (Network Secret)
credencial() {
  secao "Credencial do operador (Network Secret do ambiente do Claude Code)"
  local chaves; chaves="$(g iam service-accounts keys list --iam-account="$OP" --managed-by=user --format='value(name.basename())' | wc -l | tr -d ' ')"
  cat <<EOF
Antes de criar a chave, abra o ambiente do Claude Code (menu do ambiente na barra de título da sessão
→ Edit → Network secrets → Add secret) e confira se a lista "Secret type" tem EXATAMENTE:
    GCP access token (with Service Account Key)
Se NÃO tiver, responda "nao": nada é criado e o restante da autonomia fica pronto, sem credencial.
EOF
  (( chaves > 0 )) && echo "⚠ $OP já tem $chaves chave(s). Criar outra é uma ROTAÇÃO: apague a antiga depois (revogar.sh revogar-chaves)."
  printf '\nO tipo existe? (digite "existe" ou "nao")\n> '
  local r; read -r r || true
  [[ "$r" == existe ]] || { echo "• chave NÃO criada. Rode de novo quando o tipo estiver disponível: bash infra/homolog/gcp/autonomia/bootstrap.sh"; return 0; }
  local dir; dir="$(mktemp -d "$HOME/.cenario-chave-XXXXXX")"; chmod 700 "$dir"
  local arq="$dir/claude-operador.json"
  ( umask 077; g iam service-accounts keys create "$arq" --iam-account="$OP" --format=none ) 2>"$dir/erro" \
    || { cat "$dir/erro"; rm -rf "$dir"; echo "✘ chave não criada"; return 1; }
  local id; id="$(jq -r .private_key_id "$arq")"
  cat <<EOF

✔ chave criada (id $id) em: $arq   (o conteúdo NÃO é exibido)
  1. Baixe:   cloudshell download $arq
  2. No formulário "Add secret": Secret type = GCP access token (with Service Account Key);
     Allowed websites = *.googleapis.com ; carregue/cole o arquivo baixado; Add.
  3. Apague o arquivo baixado do seu computador.
EOF
  printf '\nQuando o Network Secret estiver salvo, digite "concluido" (o arquivo aqui será destruído)\n> '
  read -r r || true
  shred -u "$arq" 2>/dev/null || rm -f "$arq"; rm -rf "$dir"
  [[ ! -e "$arq" ]] && ok "arquivo da chave destruído no Cloud Shell"
  echo "• para revogar esta chave: bash infra/homolog/gcp/autonomia/revogar.sh revogar-chaves"
  cat <<EOF

Rede do ambiente do Claude Code (mesma tela, Network access): inclua em Allowed domains:
    $DOMINIO
Senha do proxy da homologação como Network Secret (tipo Username and password / Basic, host $DOMINIO,
usuário homologacao): para ver a senha só neste terminal, rode
    bash infra/homolog/gcp/operador.sh mostrar-credencial proxy
EOF
}

# ============================================================ execução
registrar() { # registro sem segredos (a etapa da chave fica fora dele); criado já com permissão 600
  install -d -m 700 "$RELDIR"
  LOG="$RELDIR/autonomia-$1-$(date -u +%Y%m%dT%H%M%SZ).log"
  install -m 600 /dev/null "$LOG"
  exec > >(tee -a "$LOG") 2>&1
}

case "${1:-tudo}" in
  plano) requisitos; plano; (( ${#BLOQUEIOS[@]} == 0 )) || exit 1 ;;
  publicar-runner) registrar publicar; requisitos; publicar_runner ;;
  verificar) registrar verificar; requisitos; isolamento; teste_canal ;;
  tudo)
    registrar tudo
    requisitos
    plano
    if (( ${#BLOQUEIOS[@]} > 0 )); then
      echo; echo "✘ Bootstrap interrompido ANTES de qualquer alteração: resolva os bloqueios do Cloud Build acima e rode de novo."
      exit 1
    fi
    confirmar "autorizar claude-operador na homologacao"
    aplicar
    publicar_runner
    instalar_runner
    teste_canal
    isolamento
    if [[ -t 0 && -w /dev/tty ]]; then exec >/dev/tty 2>&1; fi  # a etapa da chave não vai para o registro
    credencial
    echo; echo "Bootstrap concluído. Registro (sem segredos): $LOG"
    ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
(( FALHAS == 0 ))
