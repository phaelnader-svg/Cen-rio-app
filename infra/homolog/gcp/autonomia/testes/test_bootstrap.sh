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
afirma "$TMP/1.out" "• conta LEGADA do Cloud Build 123456@cloudbuild.gserviceaccount.com · papéis no projeto: nenhum"
afirma "$TMP/1.out" "• conta 123456-compute@developer.gserviceaccount.com · papéis no projeto: roles/editor"
afirma "$TMP/1.out" "✔ Cloud Build: claude-operador só consegue iniciar builds como cenario-build@cenariogestao.iam.gserviceaccount.com"
afirma "$TMP/1.out" "◻ criar papel cenarioOperadorBuild: cloudbuild.builds.create,cloudbuild.builds.get,cloudbuild.builds.list"
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
afirma "$TMP/3.out" "✔ runner 2.0.0 publicado"
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
     ("sa:cenario-build@cenariogestao.iam.gserviceaccount.com", OP, "roles/iam.serviceAccountUser"),
     ("topico:cenario-homolog-comandos", OP, "roles/pubsub.publisher"),
     ("assinatura:cenario-homolog-comandos-vm", VM, "roles/pubsub.subscriber"),
     ("bucket:cenariogestao-homolog-operacoes", OP, "roles/storage.objectViewer"),
     ("bucket:cenariogestao-homolog-operacoes", VM, "roles/storage.objectCreator"),
     ("bucket:cenariogestao-homolog-build", OP, "roles/storage.objectAdmin"),
     ("bucket:cenariogestao-homolog-build", OP, "roles/storage.legacyBucketReader"),
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
assert not any("Admin" in l["papel"] or "admin" in l["papel"] for l in e["ligacoes"] if l["recurso"].startswith("projeto:"))
assert [l for l in e["ligacoes"] if "Admin" in l["papel"]] == [{"recurso": "bucket:cenariogestao-homolog-build", "membro": OP, "papel": "roles/storage.objectAdmin"}]
assert not any(l["membro"].startswith("user:") for l in e["ligacoes"]), "permissão temporária ficou"
assert e["papeis"]["cenarioAssinaJwt"] == ["iam.serviceAccounts.signJwt"]
assert sorted(e["papeis"]["cenarioOperadorBuild"]) == ["cloudbuild.builds.create", "cloudbuild.builds.get", "cloudbuild.builds.list"]
assert not any(l["papel"] == "roles/cloudbuild.builds.editor" for l in e["ligacoes"])
assert [l["recurso"] for l in e["ligacoes"] if l["membro"] == OP and l["papel"] == "roles/iam.serviceAccountUser"] == ["sa:cenario-build@cenariogestao.iam.gserviceaccount.com"]
assert "compute.instances.setMetadata" not in e["papeis"]["cenarioOperadorVm"]
assert not e["chaves"]
PY

echo "4. segunda rodada: idempotente (nada criado de novo, runner já publicado)"
roda "$TMP/4.out" "autorizar claude-operador na homologacao\nnao\n" bootstrap.sh
rc_e "$TMP/4.out" 0
afirma "$TMP/4.out" "✔ runner 2.0.0 já publicado (SHA-256 idêntico)"
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

echo "6e. Cloud Build: qualquer caminho para uma conta mais ampla BLOQUEIA antes de alterar algo"
novo cb
bloqueio() { # bloqueio <rótulo> <trecho esperado> <variável=valor>
  env "$3" bash -c "cd '$REPO' && printf 'autorizar claude-operador na homologacao\nnao\n' | bash infra/homolog/gcp/autonomia/bootstrap.sh" > "$TMP/cb-$1.out" 2>&1 && echo "  ✘ $1: terminou com 0" && FALHAS=$((FALHAS + 1))
  afirma "$TMP/cb-$1.out" "$2"
  afirma "$TMP/cb-$1.out" "Bootstrap interrompido ANTES de qualquer alteração"
  nega "$TMP/cb-$1.out" "Para prosseguir, digite"
  : > "$GCLOUD_LOG"
}
: > "$GCLOUD_LOG"
bloqueio legada-padrao "a conta padrão das builds é a LEGADA 123456@cloudbuild.gserviceaccount.com" FALSO_BUILD_PADRAO=projects/cenariogestao/serviceAccounts/123456@cloudbuild.gserviceaccount.com
bloqueio legada-com-papel "a conta LEGADA 123456@cloudbuild.gserviceaccount.com tem papéis no projeto (roles/cloudbuild.builds.builder)" FALSO_LEGADA=1
bloqueio actas-extra "claude-operador já tem roles/iam.serviceAccountUser sobre 123456-compute@developer.gserviceaccount.com" FALSO_ACTAS_EXTRA=1
bloqueio padrao-ilegivel "não consegui ler a conta padrão do Cloud Build" FALSO_BUILD_PADRAO_ERRO=1
bloqueio papel-perigoso "o papel roles/monitoring.viewer inclui iam.serviceAccounts.actAs" FALSO_PAPEL_PERIGOSO=1
bloqueio build-actas "cenario-build tem roles/iam.serviceAccountTokenCreator sobre 123456-compute@developer.gserviceaccount.com" FALSO_BUILD_ACTAS=1
python3 -c "import json,os; p='$FALSO_ESTADO'; e=json.load(open(p)) if os.path.exists(p) else {'ligacoes':[], 'sas':[]}; assert not e['ligacoes'] and 'claude-operador@cenariogestao.iam.gserviceaccount.com' not in e['sas']" \
  && echo "  ✔ nenhum recurso nem IAM criado em nenhum bloqueio" || { echo "  ✘ algo foi criado num bloqueio"; FALHAS=$((FALHAS + 1)); }
FALSO_LEGADA=1 roda "$TMP/6f.out" "" bootstrap.sh plano
afirma "$TMP/6f.out" "⛔ Cloud Build BLOQUEADO"; rc_e "$TMP/6f.out" 1; sem_escritas

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
afirma "$TMP/9c.out" "✔ runner 2.0.0 instalado e ativo"
afirma "$TMP/9d.out" "VERSAO difere do código"
[[ "$(stat -c %a "$RR/etc/cenario/runner.json")" == 600 ]] && echo "  ✔ runner.json com permissão 600" || { echo "  ✘ permissão de runner.json"; FALHAS=$((FALHAS + 1)); }
cmp -s "$SRC/cenario-runner.service" "$RR/etc/systemd/system/cenario-runner.service" && echo "  ✔ unidade systemd instalada" || { echo "  ✘ unidade"; FALHAS=$((FALHAS + 1)); }
afirma "$GCLOUD_LOG" "systemctl enable cenario-runner.service"

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
