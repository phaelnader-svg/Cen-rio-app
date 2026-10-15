#!/usr/bin/env bash
# Testes do bootstrap.sh, revogar.sh e instalar.sh com gcloud/ssh FALSOS (nada externo é tocado).
# Prova: plano só lê; confirmação errada não altera nada; aplica exatamente o IAM previsto, sem papel
# proibido e nada em outro projeto; idempotente na segunda rodada; permissão temporária removida;
# chave só com confirmação e destruída depois; recusas (conta de serviço, escopo, árvore suja);
# revogação; instalação do runner (configuração validada, 600, unidade, versão conferida).
# Executar: bash infra/homolog/gcp/autonomia/testes/test_bootstrap.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
ORIGEM="$(cd "$AQUI/../../../../.." && pwd)"
TMP="$(mktemp -d)"; [[ -n "${CENARIO_TESTE_MANTER:-}" ]] || trap 'rm -rf "$TMP"' EXIT; echo "tmp: $TMP"
REPO="$TMP/repo"; mkdir -p "$REPO"
cp -r "$ORIGEM/infra" "$REPO/"
mkdir -p "$REPO/scripts" && cp "$ORIGEM/scripts/backup.sh" "$ORIGEM/scripts/restore.sh" "$REPO/scripts/"
( cd "$REPO" && git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm teste )
mkdir -p "$TMP/bin" "$TMP/home/.ssh"
printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$AQUI/gcloud_bootstrap_falso.py" > "$TMP/bin/gcloud"
printf '#!/usr/bin/env bash\necho "operar $*" >> "$GCLOUD_LOG"\n[[ "$1" == verificar ]] && echo "CANAL: OK" >&2\nexit 0\n' > "$TMP/bin/operar-falso"
printf '#!/usr/bin/env bash\ncase "$1" in -y) exit 1;; -lf) echo "256 SHA256:x u (ED25519)";; esac\n' > "$TMP/bin/ssh-keygen"
printf '#!/usr/bin/env bash\necho "256 SHA256:x u (ED25519)"\n' > "$TMP/bin/ssh-add"
printf '#!/usr/bin/env bash\necho "systemctl $*" >> "$GCLOUD_LOG"\n[[ "$1" == is-active ]] && exit 0\nexit 0\n' > "$TMP/bin/systemctl"
printf '#!/usr/bin/env bash\necho "systemd-run $*" >> "$GCLOUD_LOG"\n' > "$TMP/bin/systemd-run"
: > "$TMP/home/.ssh/google_compute_engine"; : > "$TMP/home/.ssh/google_compute_engine.pub"
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" GCLOUD_LOG="$TMP/gcloud.log" CENARIO_RELATORIOS="$TMP/rel" HOME="$TMP/home" \
  CENARIO_CHAVE_SSH="$TMP/home/.ssh/google_compute_engine" SSH_AUTH_SOCK="$TMP/agente" CENARIO_OPERAR_CMD="$TMP/bin/operar-falso"

FALHAS=0
afirma() { if grep -qF -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qF -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
rc_e() { local r; r="$(cat "$1.rc")"; [[ "$r" == "$2" ]] && echo "  ✔ código $r" || { echo "  ✘ código $r (esperado $2)"; FALHAS=$((FALHAS + 1)); }; }
ESCRITAS=' (create|add-iam-policy-binding|remove-iam-policy-binding|enable|update|delete|disable|cp|scp|ssh)( |$)'
sem_escritas() { if grep -E "$ESCRITAS" "$GCLOUD_LOG" | grep -v '^services list' >/dev/null; then echo "  ✘ houve escrita:"; grep -E "$ESCRITAS" "$GCLOUD_LOG" | head -5 | sed 's/^/      /'; FALHAS=$((FALHAS + 1)); else echo "  ✔ nenhuma escrita"; fi; }
novo() { export FALSO_ESTADO="$TMP/estado-$1.json"; rm -f "$FALSO_ESTADO"; }
roda() { # roda <saida> <entrada> <script> <args…>
  local out="$1" entrada="$2" s="$3"; shift 3
  : > "$GCLOUD_LOG"; rm -f "$GCLOUD_LOG.ssh"
  set +e; ( cd "$REPO" && printf '%b' "$entrada" | bash "infra/homolog/gcp/autonomia/$s" "$@" ) > "$out" 2>&1; echo $? > "$out.rc"; set -e
}

echo "1. plano: só leitura, com Cloud Build, IAM existente, conflitos e outros projetos"
novo base
roda "$TMP/1.out" "" bootstrap.sh plano
afirma "$TMP/1.out" "• conta PADRÃO das builds em us-east1: 123456-compute@developer.gserviceaccount.com"
afirma "$TMP/1.out" "• conta LEGADA 123456@cloudbuild.gserviceaccount.com · papéis: nenhum"
afirma "$TMP/1.out" "• conta Compute padrão 123456-compute@developer.gserviceaccount.com · papéis: roles/editor"
afirma "$TMP/1.out" "• 123456-compute@developer.gserviceaccount.com · papéis no projeto: roles/editor · quem age sobre ela: só Owners"
afirma "$TMP/1.out" "• uso atual da conta legada: padrão=não · gatilhos=0 · builds recentes=0"
afirma "$TMP/1.out" "conta=123456-compute@developer.gserviceaccount.com status=SUCCESS"
afirma "$TMP/1.out" "• re-execução das builds antigas: exige cloudbuild.builds.create; claude-operador não tem"
afirma "$TMP/1.out" "✔ Cloud Build: claude-operador NÃO cria, re-executa nem gatilha builds com outra conta; builds autônomas só pelo gatilho cenario-homolog-build-autonomo com cenario-build@cenariogestao.iam.gserviceaccount.com"
afirma "$TMP/1.out" "◻ criar papel cenarioOperadorBuild: cloudbuild.builds.get,cloudbuild.builds.list"
afirma "$TMP/1.out" "◻ criar gatilho cenario-homolog-build-autonomo (Pub/Sub cenario-homolog-build → build com cenario-build@cenariogestao.iam.gserviceaccount.com"
afirma "$TMP/1.out" "◻ criar tópico cenario-homolog-build (pedidos de build)"
afirma "$TMP/1.out" "NENHUM cloudbuild.builds.create, NENHUM actAs"
nega "$TMP/1.out" "serviceAccountUser"
afirma "$TMP/1.out" "Nada é alterado neles."
afirma "$TMP/1.out" "✔ nenhum conflito com recursos existentes"
afirma "$TMP/1.out" "projeto: roles/compute.viewer roles/logging.viewer roles/monitoring.viewer projects/cenariogestao/roles/cenarioOperadorBuild roles/serviceusage.serviceUsageConsumer"
afirma "$TMP/1.out" "◻ criar conta claude-operador@cenariogestao.iam.gserviceaccount.com"
afirma "$TMP/1.out" "◻ criar papel cenarioOperadorVm: compute.instances.get,compute.instances.getSerialPortOutput,compute.instances.reset,compute.instances.start,compute.instances.stop"
afirma "$TMP/1.out" "gs://cenariogestao-homolog-runner-versoes: NENHUM (só você publica versões do runner)"
rc_e "$TMP/1.out" 0; sem_escritas

echo "2. tudo com confirmação errada: nada alterado"
roda "$TMP/2.out" "sim\n" bootstrap.sh
afirma "$TMP/2.out" "Cancelado"
rc_e "$TMP/2.out" 1; sem_escritas

echo "3. tudo confirmado, sem criar chave (tipo 'nao')"
roda "$TMP/3.out" "autorizar claude-operador na homologacao\nnao\n" bootstrap.sh
rc_e "$TMP/3.out" 0
afirma "$TMP/3.out" "✔ runner $(cat "$REPO/infra/homolog/gcp/autonomia/runner/VERSAO") publicado"
afirma "$TMP/3.out" "✔ gatilho cenario-homolog-build-autonomo criado e conferido"
afirma "$TMP/3.out" "✔ canal de ponta a ponta"
afirma "$TMP/3.out" "✔ permissão temporária de dono@gmail.com removida"
afirma "$TMP/3.out" "✔ verificapro-8d3c8: nenhuma das contas tem acesso"
afirma "$TMP/3.out" "• chave NÃO criada"
afirma "$GCLOUD_LOG" "operar verificar"
afirma "$GCLOUD_LOG" "operar teste-seguranca"
afirma "$GCLOUD_LOG" "--if-generation-match=0"
afirma "$GCLOUD_LOG.ssh" "CENARIO_RUNNER_ASSINANTE=claude-operador@cenariogestao.iam.gserviceaccount.com"
nega "$GCLOUD_LOG" "keys create"
python3 - "$FALSO_ESTADO" <<'PY' && echo "  ✔ IAM exatamente o previsto" || { echo "  ✘ IAM diferente do previsto"; exit 1; }
import json, sys
e = json.load(open(sys.argv[1]))
OP = "serviceAccount:claude-operador@cenariogestao.iam.gserviceaccount.com"
B = "serviceAccount:cenario-build@cenariogestao.iam.gserviceaccount.com"
VM = "serviceAccount:cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com"
esperado = {
  ("projeto:cenariogestao", OP, r) for r in ("roles/compute.viewer", "roles/logging.viewer", "roles/monitoring.viewer", "projects/cenariogestao/roles/cenarioOperadorBuild", "roles/serviceusage.serviceUsageConsumer")
} | {("projeto:cenariogestao", B, "roles/logging.logWriter"), ("projeto:cenariogestao", VM, "roles/logging.logWriter"),
     ("vm:cenario-homolog", OP, "projects/cenariogestao/roles/cenarioOperadorVm"),
     ("sa:claude-operador@cenariogestao.iam.gserviceaccount.com", OP, "projects/cenariogestao/roles/cenarioAssinaJwt"),
     ("topico:cenario-homolog-comandos", OP, "roles/pubsub.publisher"),
     ("topico:cenario-homolog-build", OP, "roles/pubsub.publisher"),
     ("assinatura:cenario-homolog-comandos-vm", VM, "roles/pubsub.subscriber"),
     ("bucket:cenariogestao-homolog-operacoes", OP, "roles/storage.objectViewer"),
     ("bucket:cenariogestao-homolog-operacoes", VM, "roles/storage.objectCreator"),
     ("bucket:cenariogestao-homolog-build", OP, "roles/storage.objectCreator"),
     ("bucket:cenariogestao-homolog-build", OP, "roles/storage.objectViewer"),
     ("bucket:cenariogestao-homolog-build", B, "roles/storage.objectViewer"),
     ("bucket:cenariogestao-homolog-runner-versoes", VM, "roles/storage.objectViewer"),
     ("repo:cenario-homolog", OP, "roles/artifactregistry.reader"),
     ("repo:cenario-homolog", B, "roles/artifactregistry.writer")}
atual = {(l["recurso"], l["membro"], l["papel"]) for l in e["ligacoes"]}
extra, falta = atual - esperado, esperado - atual
print("    extras:", sorted(extra)); print("    faltando:", sorted(falta))
assert not extra and not falta
assert not any("verificapro" in l["recurso"] for l in e["ligacoes"])
assert not any(l["papel"] in ("roles/owner", "roles/editor") for l in e["ligacoes"])
assert not any("Admin" in l["papel"] or "admin" in l["papel"] for l in e["ligacoes"])
assert not any(l["membro"].startswith("user:") for l in e["ligacoes"]), "permissão temporária ficou"
assert e["papeis"]["cenarioAssinaJwt"] == ["iam.serviceAccounts.signJwt"]
assert sorted(e["papeis"]["cenarioOperadorBuild"]) == ["cloudbuild.builds.get", "cloudbuild.builds.list"]
assert not any(l["papel"] == "roles/cloudbuild.builds.editor" for l in e["ligacoes"])
assert not any(l["membro"] == OP and l["recurso"].startswith("sa:") and l["papel"] != "projects/cenariogestao/roles/cenarioAssinaJwt" for l in e["ligacoes"]), "actAs para o operador"
gat = e["gatilhos"]["cenario-homolog-build-autonomo"]
assert gat["serviceAccount"] == "projects/cenariogestao/serviceAccounts/cenario-build@cenariogestao.iam.gserviceaccount.com"
assert gat["pubsubConfig"]["topic"] == "projects/cenariogestao/topics/cenario-homolog-build"
assert gat["substitutions"] == {"_TAG": "$(body.message.attributes.tag)", "_FONTE": "$(body.message.attributes.fonte)",
    "_BUCKET": "cenariogestao-homolog-build", "_REGION": "us-east1", "_REPO": "cenario-homolog"}, gat["substitutions"]
assert gat["build"]["options"]["logging"] == "CLOUD_LOGGING_ONLY" and "serviceAccount" not in gat["build"]
assert "compute.instances.setMetadata" not in e["papeis"]["cenarioOperadorVm"]
assert not e["chaves"]
PY

echo "4. segunda rodada: idempotente (nada criado de novo, runner já publicado)"
roda "$TMP/4.out" "autorizar claude-operador na homologacao\nnao\n" bootstrap.sh
rc_e "$TMP/4.out" 0
afirma "$TMP/4.out" "✔ runner $(cat "$REPO/infra/homolog/gcp/autonomia/runner/VERSAO") já publicado (SHA-256 idêntico)"
afirma "$TMP/4.out" "✔ gatilho cenario-homolog-build-autonomo existe e é idêntico ao do repositório"
afirma "$TMP/4.out" "✔ gatilho cenario-homolog-build-autonomo conferido"
nega "$GCLOUD_LOG" "triggers create"
if grep -E ' (service-accounts create|roles create|topics create|subscriptions create|buckets create|services enable)( |$)' "$GCLOUD_LOG" >/dev/null; then
  echo "  ✘ recriou recursos"; FALHAS=$((FALHAS + 1)); else echo "  ✔ nenhum recurso recriado"; fi
python3 -c "import json,sys; e=json.load(open('$FALSO_ESTADO')); l=[(x['recurso'],x['membro'],x['papel']) for x in e['ligacoes']]; assert len(l)==len(set(l)) and len(l)==20, len(l)" \
  && echo "  ✔ 20 ligações, sem duplicatas" || { echo "  ✘ ligações duplicadas"; FALHAS=$((FALHAS + 1)); }

echo "5. chave: só com 'existe', conteúdo nunca exibido, arquivo destruído"
roda "$TMP/5.out" "autorizar claude-operador na homologacao\nexiste\nconcluido\n" bootstrap.sh
rc_e "$TMP/5.out" 0
afirma "$TMP/5.out" "✔ chave criada (id chave1)"
afirma "$TMP/5.out" "✔ arquivo da chave destruído no Cloud Shell"
nega "$TMP/5.out" "SEGREDO-FALSO"
nega "$TMP/5.out" "BEGIN PRIVATE KEY"
[[ -z "$(find "$TMP/home" -name 'claude-operador.json')" ]] && echo "  ✔ nenhum arquivo de chave restou" || { echo "  ✘ arquivo de chave restou"; FALHAS=$((FALHAS + 1)); }
if grep -rq "SEGREDO-FALSO" "$TMP/rel" 2>/dev/null; then echo "  ✘ chave no registro"; FALHAS=$((FALHAS + 1)); else echo "  ✔ chave fora do registro"; fi

echo "6. recusas antes de qualquer alteração"
novo recusa
FALSO_CONTA=alguem@cenariogestao.iam.gserviceaccount.com roda "$TMP/6a.out" "autorizar claude-operador na homologacao\n" bootstrap.sh
afirma "$TMP/6a.out" "não por uma conta de serviço"; sem_escritas
FALSO_ESCOPOS=https://www.googleapis.com/auth/devstorage.read_only roda "$TMP/6b.out" "autorizar claude-operador na homologacao\n" bootstrap.sh
afirma "$TMP/6b.out" "escopo cloud-platform"; sem_escritas
FALSO_VM_SA=outra@cenariogestao.iam.gserviceaccount.com roda "$TMP/6c.out" "autorizar claude-operador na homologacao\n" bootstrap.sh
afirma "$TMP/6c.out" "não usa a conta"; sem_escritas
echo "# sujo" >> "$REPO/infra/homolog/gcp/autonomia/runner/instalar.sh"
roda "$TMP/6d.out" "autorizar claude-operador na homologacao\n" bootstrap.sh
afirma "$TMP/6d.out" "mudanças não commitadas"; sem_escritas
( cd "$REPO" && git checkout -q -- infra )

echo "6e. Cloud Build: qualquer capacidade do operador de criar build ou agir como outra conta BLOQUEIA antes de alterar algo"
novo cb
bloqueio() { # bloqueio <rótulo> <trecho esperado> <variável=valor>
  env "$3" bash -c "cd '$REPO' && printf 'autorizar claude-operador na homologacao\nnao\n' | bash infra/homolog/gcp/autonomia/bootstrap.sh" > "$TMP/cb-$1.out" 2>&1 && echo "  ✘ $1: terminou com 0" && FALHAS=$((FALHAS + 1))
  afirma "$TMP/cb-$1.out" "$2"
  afirma "$TMP/cb-$1.out" "Bootstrap interrompido ANTES de qualquer alteração"
  nega "$TMP/cb-$1.out" "Para prosseguir, digite"
  : > "$GCLOUD_LOG"
}
: > "$GCLOUD_LOG"
bloqueio actas-extra "claude-operador tem roles/iam.serviceAccountUser sobre 123456-compute@developer.gserviceaccount.com" FALSO_ACTAS_EXTRA=1
bloqueio op-builds-editor "o papel roles/cloudbuild.builds.editor inclui cloudbuild.builds.create cloudbuild.builds.update" FALSO_OP_BUILDS_EDITOR=1
bloqueio gatilho-divergente "o gatilho cenario-homolog-build-autonomo existe mas DIFERE do repositório" FALSO_GATILHO_DIVERGENTE=1
bloqueio gatilho-alheio "o gatilho gatilho-antigo escuta um tópico em que claude-operador publica" FALSO_GATILHO_ALHEIO=1
bloqueio papel-perigoso "o papel roles/monitoring.viewer inclui iam.serviceAccounts.actAs" FALSO_PAPEL_PERIGOSO=1
bloqueio build-actas "cenario-build tem roles/iam.serviceAccountTokenCreator sobre 123456-compute@developer.gserviceaccount.com" FALSO_BUILD_ACTAS=1
python3 -c "import json,os; p='$FALSO_ESTADO'; e=json.load(open(p)) if os.path.exists(p) else {'ligacoes':[], 'sas':[]}; assert not e['ligacoes'] and 'claude-operador@cenariogestao.iam.gserviceaccount.com' not in e['sas']" \
  && echo "  ✔ nenhum recurso nem IAM criado em nenhum bloqueio" || { echo "  ✘ algo foi criado num bloqueio"; FALHAS=$((FALHAS + 1)); }
FALSO_GATILHO_DIVERGENTE=1 roda "$TMP/6f.out" "" bootstrap.sh plano
afirma "$TMP/6f.out" "⛔ Cloud Build BLOQUEADO"; rc_e "$TMP/6f.out" 1; sem_escritas

echo "6g. conta legada/padrão: inalcançáveis pelo operador → informadas (com uso atual e recomendação), sem bloquear"
FALSO_LEGADA=1 FALSO_BUILD_PADRAO=projects/cenariogestao/serviceAccounts/123456@cloudbuild.gserviceaccount.com roda "$TMP/6g.out" "" bootstrap.sh plano
afirma "$TMP/6g.out" "• conta LEGADA 123456@cloudbuild.gserviceaccount.com · papéis: roles/cloudbuild.builds.builder"
afirma "$TMP/6g.out" "• uso atual da conta legada: padrão=SIM"
afirma "$TMP/6g.out" "⚠ recomendação (opcional, NÃO feita pelo bootstrap)"
afirma "$TMP/6g.out" "✔ Cloud Build: claude-operador NÃO cria"
rc_e "$TMP/6g.out" 0; sem_escritas
FALSO_BUILD_PADRAO_ERRO=1 roda "$TMP/6h.out" "" bootstrap.sh plano
afirma "$TMP/6h.out" "• conta padrão das builds em us-east1: não lida"
rc_e "$TMP/6h.out" 0; sem_escritas

echo "7. isolamento: conta presente em outro projeto é acusada"
export FALSO_ESTADO="$TMP/estado-base.json"
FALSO_OUTRO_COM_OP=1 roda "$TMP/7.out" "" bootstrap.sh verificar
afirma "$TMP/7.out" "✘ verificapro-8d3c8: uma das contas TEM papel"
rc_e "$TMP/7.out" 1

echo "8. revogação"
roda "$TMP/8a.out" "" revogar.sh estado
afirma "$TMP/8a.out" "projects/cenariogestao/roles/cenarioOperadorBuild"
roda "$TMP/8b.out" "" revogar.sh pausar-runner
afirma "$TMP/8b.out" "removido"
roda "$TMP/8c.out" "" revogar.sh suspender
afirma "$TMP/8c.out" "DESATIVADA"
roda "$TMP/8d.out" "" revogar.sh revogar-chaves
afirma "$TMP/8d.out" "chave chave1 apagada"
roda "$TMP/8e.out" "nao\n" revogar.sh remover-tudo
afirma "$TMP/8e.out" "Cancelado"
roda "$TMP/8f.out" "remover autonomia da homologacao\n" revogar.sh remover-tudo
rc_e "$TMP/8f.out" 0
python3 -c "import json; e=json.load(open('$FALSO_ESTADO')); assert not [l for l in e['ligacoes'] if 'claude-operador' in l['membro'] or 'cenario-build' in l['membro']], e['ligacoes']; assert 'claude-operador@cenariogestao.iam.gserviceaccount.com' not in e['sas']" \
  && echo "  ✔ contas e ligações removidas" || { echo "  ✘ restou acesso"; FALHAS=$((FALHAS + 1)); }
afirma "$GCLOUD_LOG.ssh" "systemctl disable --now cenario-runner.service"
afirma "$GCLOUD_LOG" "builds triggers delete --region=us-east1 cenario-homolog-build-autonomo"
afirma "$GCLOUD_LOG" "pubsub topics delete cenario-homolog-build"
python3 -c "import json; e=json.load(open('$FALSO_ESTADO')); assert not e.get('gatilhos')" && echo "  ✔ gatilho removido" || { echo "  ✘ gatilho restou"; FALHAS=$((FALHAS + 1)); }

echo "9. instalar.sh (raiz temporária)"
RR="$TMP/raiz"; mkdir -p "$RR"
SRC="$REPO/infra/homolog/gcp/autonomia/runner"
set +e
CENARIO_RAIZ="$RR" bash "$SRC/instalar.sh" "$SRC" > "$TMP/9a.out" 2>&1; echo $? > "$TMP/9a.out.rc"
CENARIO_RAIZ="$RR" CENARIO_RUNNER_PROJETO=cenariogestao CENARIO_RUNNER_VM=cenario-homolog CENARIO_RUNNER_ASSINANTE='x;rm -rf /' \
  CENARIO_RUNNER_ASSINATURA=projects/cenariogestao/subscriptions/s CENARIO_RUNNER_BUCKET=b-ops CENARIO_RUNNER_BUCKET_VERSOES=b-v \
  CENARIO_RUNNER_DOMINIO=teste.cenariogestao.com.br bash "$SRC/instalar.sh" "$SRC" > "$TMP/9b.out" 2>&1; echo $? > "$TMP/9b.out.rc"
CENARIO_RAIZ="$RR" CENARIO_RUNNER_PROJETO=cenariogestao CENARIO_RUNNER_VM=cenario-homolog CENARIO_RUNNER_ASSINANTE=claude-operador@cenariogestao.iam.gserviceaccount.com \
  CENARIO_RUNNER_ASSINATURA=projects/cenariogestao/subscriptions/cenario-homolog-comandos-vm CENARIO_RUNNER_BUCKET=cenariogestao-homolog-operacoes \
  CENARIO_RUNNER_BUCKET_VERSOES=cenariogestao-homolog-runner-versoes CENARIO_RUNNER_DOMINIO=teste.cenariogestao.com.br \
  bash "$SRC/instalar.sh" "$SRC" > "$TMP/9c.out" 2>&1; echo $? > "$TMP/9c.out.rc"
cp -r "$SRC" "$TMP/src-errada"; echo 9.9.9 > "$TMP/src-errada/VERSAO"
CENARIO_RAIZ="$RR" bash "$TMP/src-errada/instalar.sh" "$TMP/src-errada" > "$TMP/9d.out" 2>&1; echo $? > "$TMP/9d.out.rc"
set -e
afirma "$TMP/9a.out" "sem configuração"
afirma "$TMP/9b.out" "configuração inválida: assinante"
rc_e "$TMP/9c.out" 0
afirma "$TMP/9c.out" "✔ runner $(cat "$SRC/VERSAO") instalado e ativo"
afirma "$TMP/9d.out" "VERSAO difere do código"
[[ "$(stat -c %a "$RR/etc/cenario/runner.json")" == 600 ]] && echo "  ✔ runner.json com permissão 600" || { echo "  ✘ permissão de runner.json"; FALHAS=$((FALHAS + 1)); }
cmp -s "$SRC/cenario-runner.service" "$RR/etc/systemd/system/cenario-runner.service" && echo "  ✔ unidade systemd instalada" || { echo "  ✘ unidade"; FALHAS=$((FALHAS + 1)); }
afirma "$GCLOUD_LOG" "systemctl enable cenario-runner.service"

echo "10. publicar-runner: publica runner E scripts da VM (só no bucket de versões; nada na VM), idempotente"
novo publicar
roda "$TMP/10a.out" "" bootstrap.sh publicar-runner
roda "$TMP/10b.out" "" bootstrap.sh publicar-runner
SV="$(cd "$REPO" && git rev-parse HEAD | cut -c1-12)"
rc_e "$TMP/10a.out" 0
afirma "$TMP/10a.out" "scripts $SV publicados em gs://cenariogestao-homolog-runner-versoes"
afirma "$TMP/10a.out" "Nada muda na VM agora"
afirma "$TMP/10b.out" "scripts $SV já publicados (SHA-256 idêntico)"
afirma "$TMP/10b.out" "já publicado (SHA-256 idêntico)"
nega "$GCLOUD_LOG" "compute ssh"
nega "$GCLOUD_LOG" "compute scp"
python3 - "$FALSO_ESTADO" "$SV" "$REPO" <<'PY' && echo "  ✔ pacote = git archive do commit (só infra/homolog e scripts de backup; SHA-256 publicado confere)" || { echo "  ✘ pacote de scripts"; FALHAS=$((FALHAS + 1)); }
import hashlib, json, subprocess, sys
e = json.load(open(sys.argv[1])); sv, repo = sys.argv[2], sys.argv[3]
sha = e["objetos"][f"gs://cenariogestao-homolog-runner-versoes/scripts-{sv}.sha256"]
tar = subprocess.run(["git", "-C", repo, "archive", "--format=tar", "HEAD", "infra/homolog", "scripts/backup.sh", "scripts/restore.sh"], capture_output=True, check=True).stdout
gz = subprocess.run(["gzip", "-n", "-9"], input=tar, capture_output=True, check=True).stdout
assert hashlib.sha256(gz).hexdigest() == sha, "sha"
assert f"gs://cenariogestao-homolog-runner-versoes/scripts-{sv}.tar.gz" in e["objetos"]
PY
( cd "$REPO" && echo "# alteração local" >> scripts/backup.sh )
roda "$TMP/10c.out" "" bootstrap.sh publicar-runner
afirma "$TMP/10c.out" "há mudanças não commitadas em infra/homolog ou scripts/"
( cd "$REPO" && git checkout -q scripts/backup.sh )

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
