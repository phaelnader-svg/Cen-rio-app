#!/usr/bin/env bash
# Teste de integração do homolog.sh com "gcloud" e "curl" FALSOS (gcloud_falso.py imita a
# infraestrutura real criada manualmente). Nenhum recurso externo é tocado. Prova que:
#   - a auditoria só lê, encontra as pendências reais e acusa problemas (escopos, firewall aberto,
#     segunda VM, disco órfão, papel amplo no bucket, VM inacessível);
#   - o "configurar" pede confirmação, aplica SÓ o que falta, confere o resultado e é idempotente;
#     snapshots só com --com-snapshots;
#   - o "preparar-vm" exige commit limpo e portão fechado e não inicia nada;
#   - "custos" bloqueia acima do limite e sem preço oficial;
#   - os planos só imprimem; e NENHUM comando proibido é chamado em nenhum cenário.
# Executar: bash infra/homolog/gcp/testes/test_homolog_sh.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
ORIGEM="$(cd "$AQUI/../../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'kill "${PID_CAT:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT

# Cópia mínima do repositório num git temporário (o homolog.sh empacota o commit atual).
REPO="$TMP/repo"; mkdir -p "$REPO/scripts"
cp -r "$ORIGEM/infra" "$REPO/"; cp "$ORIGEM/scripts/backup.sh" "$ORIGEM/scripts/restore.sh" "$REPO/scripts/"
( cd "$REPO" && git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm teste )

mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$AQUI/gcloud_falso.py" > "$TMP/bin/gcloud"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$GCLOUD_LOG"
echo '{"permissions":["compute.instances.get","compute.instances.setMetadata","compute.firewalls.list","compute.disks.get","iap.tunnelInstances.accessViaIAP","storage.buckets.get","storage.buckets.update","storage.buckets.getIamPolicy","storage.buckets.setIamPolicy","secretmanager.secrets.getIamPolicy","secretmanager.secrets.setIamPolicy","resourcemanager.projects.getIamPolicy","iam.serviceAccountKeys.list","compute.resourcePolicies.create","compute.disks.addResourcePolicies"]}'
EOF
chmod +x "$TMP/bin/gcloud" "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH" GCLOUD_LOG="$TMP/gcloud.log" CENARIO_SEM_SONDA=1 CENARIO_RELATORIOS="$TMP/rel"

FALHAS=0
afirma() { if grep -qF -- "$2" "$1"; then echo "  ✔ contém: $2"; else echo "  ✘ NÃO contém: $2"; FALHAS=$((FALHAS + 1)); fi; }
nega() { if grep -qF -- "$2" "$1"; then echo "  ✘ contém (não deveria): $2"; FALHAS=$((FALHAS + 1)); else echo "  ✔ não contém: $2"; fi; }
rc_e() { local r; r="$(cat "$1.rc")"; if [[ "$r" == "$2" ]]; then echo "  ✔ código de saída $r"; else echo "  ✘ código de saída $r (esperado $2)"; FALHAS=$((FALHAS + 1)); fi; }
rc_nao0() { local r; r="$(cat "$1.rc")"; if [[ "$r" != 0 ]]; then echo "  ✔ código de saída $r (erro)"; else echo "  ✘ código de saída 0 (esperado erro)"; FALHAS=$((FALHAS + 1)); fi; }
# Comandos que NUNCA podem aparecer (criar/apagar/parar infraestrutura, abrir portas, publicar, ler segredos).
PROIBIDOS=' (instances (create|delete|stop|start|reset|set-service-account|set-machine-type)|firewall-rules (create|delete|update)|addresses (create|delete)|services enable|builds submit|artifacts repositories create|networks (create|delete)|storage rm|storage cp|secrets (create|delete)|versions access|dns|disks (create|delete|resize)|snapshots delete)( |$)'
sem_proibidos() {
  if grep -E "$PROIBIDOS" "$GCLOUD_LOG" >/dev/null; then echo "  ✘ comando proibido:"; grep -E "$PROIBIDOS" "$GCLOUD_LOG" | sed 's/^/      /'; FALHAS=$((FALHAS + 1))
  else echo "  ✔ nenhum comando proibido"; fi
  if [[ -f "$GCLOUD_LOG.ssh" ]] && grep -E 'publicacao-autorizada *&&|touch /etc/cenario|systemctl (start|restart) cenario-homolog|vm\.sh (iniciar|gerar-env|semear)|compose up' "$GCLOUD_LOG.ssh" | grep -v '^###.*test -f' >/dev/null; then
    echo "  ✘ comando remoto que inicia/publica:"; FALHAS=$((FALHAS + 1))
  else echo "  ✔ nenhum comando remoto inicia ou publica"; fi
}
ESCRITAS=' (add-iam-policy-binding|add-metadata|buckets update|resource-policies create|add-resource-policies|compute scp)( |$)'
sem_escritas() { if grep -E "$ESCRITAS" "$GCLOUD_LOG" >/dev/null; then echo "  ✘ houve escrita:"; grep -E "$ESCRITAS" "$GCLOUD_LOG" | sed 's/^/      /'; FALHAS=$((FALHAS + 1)); else echo "  ✔ nenhuma escrita"; fi; }
conta_escritas() { grep -cE "$ESCRITAS" "$GCLOUD_LOG" || true; }
novo_estado() { export FALSO_ESTADO="$TMP/estado-$1.json"; rm -f "$FALSO_ESTADO"; }
roda() { # roda <saida> <stdin> <args…>
  local out="$1" entrada="$2"; shift 2
  : > "$GCLOUD_LOG"; rm -f "$GCLOUD_LOG.ssh"
  set +e
  ( cd "$REPO" && printf '%s\n' "$entrada" | bash infra/homolog/gcp/homolog.sh "$@" ) > "$out" 2>&1
  echo $? > "$out.rc"
  set -e
}

echo "1. auditar (estado real): pendências encontradas, só leitura, termina OK"
novo_estado base
roda "$TMP/1.out" "" auditar
afirma "$TMP/1.out" "◻ exclusão automática após 30 dias (lifecycle) ausente"
afirma "$TMP/1.out" "◻ conta da VM sem objectCreator no bucket"
afirma "$TMP/1.out" "◻ metadados cenario-* ausentes/diferentes: cenario-project=cenariogestao"
afirma "$TMP/1.out" "✔ rede cenario-homolog-vpc (VPC exclusiva, não a 'default')"
afirma "$TMP/1.out" "✔ regra cenario-homolog-iap-ssh: só TCP 22, só de 35.235.240.0/20"
afirma "$TMP/1.out" "✔ portas 80/443 NÃO liberadas"
afirma "$TMP/1.out" "IP estático 136.108.15.103 reservado como 'cenario-homolog-ip' e EM USO"
afirma "$TMP/1.out" "✔ uma única VM no projeto"
afirma "$TMP/1.out" "✔ segredo homolog-gate-token: 1 versão(ões) ativa(s)"
afirma "$TMP/1.out" "✔ verificapro-exemplo: a conta da VM da homologação não tem acesso"
afirma "$TMP/1.out" "? snapshots diários (7 dias) NÃO configurados"
afirma "$TMP/1.out" "FIM-INSPECAO"
afirma "$TMP/1.out" "AUDITORIA: OK"
rc_e "$TMP/1.out" 0
sem_escritas; sem_proibidos
afirma "$GCLOUD_LOG.ssh" "### sudo bash -s"
afirma "$GCLOUD_LOG.ssh" "Inspeção SOMENTE LEITURA"

echo "2. auditar: escopos padrão (sem cloud-platform) → problema e decisão, sem alterar nada"
novo_estado escopos
FALSO_ESCOPOS="https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write" roda "$TMP/2.out" "" auditar --sem-ssh
afirma "$TMP/2.out" "✘ escopos sem cloud-platform"
afirma "$TMP/2.out" "? trocar os escopos da VM para cloud-platform exige PARAR a VM"
afirma "$TMP/2.out" "AUDITORIA: COM PROBLEMAS"
rc_nao0 "$TMP/2.out"; sem_escritas; sem_proibidos

echo "3. auditar: firewall aberto, segunda VM e disco órfão → problemas"
novo_estado riscos
FALSO_FW_ABERTO=1 FALSO_SEGUNDA_VM=1 FALSO_DISCO_ORFAO=1 roda "$TMP/3.out" "" auditar --sem-ssh
afirma "$TMP/3.out" "✘ regras de entrada com outras origens: liberou-web"
afirma "$TMP/3.out" "✘ há regra liberando 80/443"
afirma "$TMP/3.out" "✘ VMs no projeto: 2"
afirma "$TMP/3.out" "✘ há disco sem uso gerando cobrança"
rc_nao0 "$TMP/3.out"; sem_escritas; sem_proibidos

echo "4. auditar: VM inacessível pelo IAP → problema relatado"
novo_estado ssh
FALSO_SSH_FALHA=1 roda "$TMP/4.out" "" auditar
afirma "$TMP/4.out" "✘ não foi possível entrar na VM pelo IAP"
rc_nao0 "$TMP/4.out"; sem_escritas

echo "5. configurar com confirmação errada → nada alterado"
novo_estado config
roda "$TMP/5.out" "sim" configurar
afirma "$TMP/5.out" "bucket gs://cenariogestao-homolog-backups: excluir objetos após 30 dias"
afirma "$TMP/5.out" "conta da VM com roles/storage.objectCreator (só cria; não lê, não lista, não apaga)"
afirma "$TMP/5.out" "Cancelado. Nada foi alterado."
nega "$TMP/5.out" "agenda de snapshots"
rc_nao0 "$TMP/5.out"; sem_escritas; sem_proibidos

echo "6. configurar confirmado → aplica SÓ o que falta e confere"
roda "$TMP/6.out" "configurar cenariogestao" configurar
afirma "$TMP/6.out" "CONFIGURAÇÃO: OK (conferida relendo o estado real)"
rc_e "$TMP/6.out" 0
afirma "$GCLOUD_LOG" "storage buckets update gs://cenariogestao-homolog-backups --project=cenariogestao --lifecycle-file=infra/homolog/gcp/lifecycle-30d.json"
afirma "$GCLOUD_LOG" "--role=roles/storage.objectCreator"
afirma "$GCLOUD_LOG" "compute instances add-metadata cenario-homolog"
nega "$GCLOUD_LOG" "secrets add-iam-policy-binding"
nega "$GCLOUD_LOG" "resource-policies create"
[[ "$(conta_escritas)" == 3 ]] && echo "  ✔ exatamente 3 escritas" || { echo "  ✘ $(conta_escritas) escritas (esperado 3)"; FALHAS=$((FALHAS + 1)); }
sem_proibidos

echo "7. configurar de novo → idempotente (nada a fazer, nenhuma escrita) e auditoria sem pendências"
roda "$TMP/7.out" "" configurar
afirma "$TMP/7.out" "Nada a configurar"
rc_e "$TMP/7.out" 0; sem_escritas
roda "$TMP/7b.out" "" auditar --sem-ssh
afirma "$TMP/7b.out" "✔ exclusão automática após 30 dias configurada"
afirma "$TMP/7b.out" "✔ conta da VM pode CRIAR objetos (objectCreator)"
afirma "$TMP/7b.out" "✔ metadados cenario-* completos"
afirma "$TMP/7b.out" "0 pendência(s)"

echo "8. snapshots só com --com-snapshots (e confirmação); depois, idempotente"
roda "$TMP/8.out" "configurar cenariogestao" configurar --com-snapshots
afirma "$TMP/8.out" "CUSTO ADICIONAL"
afirma "$GCLOUD_LOG" "compute resource-policies create snapshot-schedule cenario-homolog-diario --region=us-east1 --daily-schedule --start-time=06:00 --max-retention-days=7 --on-source-disk-delete=apply-retention-policy --storage-location=us-east1"
afirma "$GCLOUD_LOG" "compute disks add-resource-policies cenario-homolog"
rc_e "$TMP/8.out" 0
roda "$TMP/8b.out" "" configurar --com-snapshots
afirma "$TMP/8b.out" "Nada a configurar"; sem_escritas

echo "9. conta da VM com objectAdmin no bucket → configurar recusa (nada é removido automaticamente)"
novo_estado admin
FALSO_BUCKET_ADMIN=1 roda "$TMP/9.out" "configurar cenariogestao" configurar
afirma "$TMP/9.out" "A conta da VM tem roles/storage.objectAdmin no bucket"
rc_nao0 "$TMP/9.out"; sem_escritas
FALSO_BUCKET_ADMIN=1 roda "$TMP/9b.out" "" auditar --sem-ssh
afirma "$TMP/9b.out" "✘ papel amplo demais no bucket: roles/storage.objectAdmin"

echo "10. preparar-vm: confirmação errada → nada copiado"
novo_estado prep
roda "$TMP/10.out" "não" preparar-vm
afirma "$TMP/10.out" "Cancelado. Nada foi alterado."
nega "$GCLOUD_LOG" "compute scp"
rc_nao0 "$TMP/10.out"

echo "11. preparar-vm confirmado → copia o commit e instala com portão fechado, sem iniciar"
roda "$TMP/11.out" "preparar cenario-homolog" preparar-vm
afirma "$TMP/11.out" "PREPARAÇÃO DA VM: OK"
afirma "$GCLOUD_LOG" "compute scp"
afirma "$GCLOUD_LOG.ssh" "bash /opt/cenario/infra/homolog/gcp/startup.sh"
afirma "$GCLOUD_LOG.ssh" "test ! -f /etc/cenario/publicacao-autorizada"
nega "$GCLOUD_LOG.ssh" "rm -rf /opt/cenario;"
rc_e "$TMP/11.out" 0; sem_proibidos

echo "11b. o script remoto do preparar-vm, executado numa raiz temporária: instala, guarda a versão anterior, não apaga nada"
RR="$TMP/raiz-vm"; mkdir -p "$RR/opt/cenario" "$RR/tmp" "$RR/etc/cenario"
echo "conteúdo pré-existente" > "$RR/opt/cenario/ARQUIVO-DO-USUARIO"
awk '/^### sudo CENARIO_COMMIT=/{f=1; next} /^### /{f=0} f' "$GCLOUD_LOG.ssh" \
  | sed -e "s#/opt/cenario#$RR/opt/cenario#g" -e "s#/tmp/cenario-pacote.tgz#$RR/tmp/cenario-pacote.tgz#g" \
        -e "s#/etc/cenario/publicacao-autorizada#$RR/etc/cenario/publicacao-autorizada#g" \
        -e "s#^bash $RR/opt/cenario/infra/homolog/gcp/startup.sh#echo startup-executado#" \
        -e 's#$(docker ps -q | wc -l)#0#' > "$TMP/remoto.sh"
grep -q "startup-executado" "$TMP/remoto.sh" && echo "  ✔ script remoto extraído" || { echo "  ✘ script remoto não extraído"; FALHAS=$((FALHAS + 1)); }
instala() { ( cd "$REPO" && git archive --format=tar.gz -o "$RR/tmp/cenario-pacote.tgz" HEAD infra/homolog scripts/backup.sh scripts/restore.sh ); CENARIO_COMMIT="$1" bash "$TMP/remoto.sh" > "$TMP/remoto-$1.out" 2>&1; }
instala versao1 && instala versao2 && echo "  ✔ duas instalações sem erro" || { echo "  ✘ instalação falhou"; FALHAS=$((FALHAS + 1)); }
[[ "$(cat "$RR/opt/cenario/VERSAO")" == versao2 && -x "$RR/opt/cenario/infra/homolog/gcp/vm.sh" ]] && echo "  ✔ versão atual: versao2" || { echo "  ✘ versão atual errada"; FALHAS=$((FALHAS + 1)); }
ls -d "$RR"/opt/cenario.anterior-* > "$TMP/anteriores.txt" 2>/dev/null || true
[[ "$(wc -l < "$TMP/anteriores.txt" | xargs)" == 2 ]] && echo "  ✔ duas cópias anteriores guardadas (reversão possível)" || { echo "  ✘ cópias anteriores: $(wc -l < "$TMP/anteriores.txt")"; FALHAS=$((FALHAS + 1)); }
grep -rqs "conteúdo pré-existente" "$RR"/opt/cenario.anterior-*/ARQUIVO-DO-USUARIO && echo "  ✔ conteúdo pré-existente preservado" || { echo "  ✘ conteúdo pré-existente perdido"; FALHAS=$((FALHAS + 1)); }
grep -qs versao1 "$RR"/opt/cenario.anterior-*/VERSAO && echo "  ✔ versao1 preservada para reversão" || { echo "  ✘ versao1 perdida"; FALHAS=$((FALHAS + 1)); }
touch "$RR/etc/cenario/publicacao-autorizada"
( cd "$REPO" && git archive --format=tar.gz -o "$RR/tmp/cenario-pacote.tgz" HEAD infra/homolog ); set +e; CENARIO_COMMIT=versao3 bash "$TMP/remoto.sh" > "$TMP/remoto-3.out" 2>&1; r=$?; set -e
[[ "$r" != 0 && "$(cat "$RR/opt/cenario/VERSAO")" == versao2 ]] && echo "  ✔ com o portão aberto, aborta sem trocar a versão" || { echo "  ✘ trocou a versão com o portão aberto"; FALHAS=$((FALHAS + 1)); }

echo "12. preparar-vm com o portão ABERTO → recusa sem copiar"
FALSO_PORTAO=ABERTO roda "$TMP/12.out" "preparar cenario-homolog" preparar-vm
afirma "$TMP/12.out" "Nada foi copiado"
nega "$GCLOUD_LOG" "compute scp"
rc_nao0 "$TMP/12.out"

echo "13. preparar-vm com mudança não commitada → recusa"
echo "# alteração local" >> "$REPO/infra/homolog/gcp/vm.sh"
roda "$TMP/13.out" "preparar cenario-homolog" preparar-vm
afirma "$TMP/13.out" "Há mudanças não commitadas"
nega "$GCLOUD_LOG" "compute scp"
rc_nao0 "$TMP/13.out"
( cd "$REPO" && git checkout -q -- infra/homolog/gcp/vm.sh )

echo "14. testar-config → valida sem iniciar"
roda "$TMP/14.out" "" testar-config
afirma "$TMP/14.out" "✔ sintaxe infra/homolog/gcp/homolog.sh"
afirma "$TMP/14.out" "✔ lifecycle-30d.json válido"
afirma "$TMP/14.out" "PREPARO DA VM: OK (nada foi iniciado)"
afirma "$TMP/14.out" "TESTE DAS CONFIGURAÇÕES: OK"
rc_e "$TMP/14.out" 0; sem_escritas; sem_proibidos

echo "15. planos só imprimem (nenhuma chamada ao gcloud)"
roda "$TMP/15a.out" "" plano-publicacao
roda "$TMP/15b.out" "" plano-encerramento
afirma "$TMP/15a.out" "SOMENTE APÓS AUTORIZAÇÃO EXPLÍCITA"
afirma "$TMP/15b.out" "SOMENTE IMPRIME"
[[ ! -s "$GCLOUD_LOG" ]] && echo "  ✔ nenhuma chamada ao gcloud" || { echo "  ✘ houve chamadas ao gcloud"; FALHAS=$((FALHAS + 1)); }

echo "16. relatório: etapas registradas, sem sequência com formato de token"
roda "$TMP/16.out" "" relatorio
afirma "$TMP/16.out" "auditar: rc="
afirma "$TMP/16.out" "testar-config: rc=0"
afirma "$TMP/16.out" "✔ registros sem sequências com formato de token"
afirma "$TMP/16.out" "NENHUMA PUBLICAÇÃO FOI FEITA"

echo "17. custos: catálogo oficial (falso) dentro do limite → 0; acima → 3; fora do ar sem cache → 2"
MODO="$TMP/modo"; echo ok > "$MODO"
python3 "$AQUI/catalogo_falso.py" ok 3 "$MODO" > "$TMP/url" &
PID_CAT=$!
for _ in $(seq 1 50); do [[ -s "$TMP/url" ]] && break; sleep 0.1; done
CENARIO_CATALOGO_URL="$(head -1 "$TMP/url")"
export CENARIO_CATALOGO_URL CENARIO_PRECOS_PERMITIR_TESTE=1
export CENARIO_PRECOS_TIMEOUT=1 CENARIO_PRECOS_TENTATIVAS=2 CENARIO_PRECOS_PRAZO=10
export CENARIO_PRECOS_CACHE="$TMP/cache1/p.json"
roda "$TMP/17a.out" "" custos
afirma "$TMP/17a.out" "CUSTOS: estimativa base dentro de US\$ 20.00"
afirma "$TMP/17a.out" "Artifact Registry"
rc_e "$TMP/17a.out" 0
echo alto > "$MODO"; export CENARIO_PRECOS_CACHE="$TMP/cache2/p.json"
roda "$TMP/17b.out" "" custos
afirma "$TMP/17b.out" "CUSTOS: ACIMA de US\$ 20.00"
rc_e "$TMP/17b.out" 3
echo lento > "$MODO"; export CENARIO_PRECOS_CACHE="$TMP/cache3/p.json"
roda "$TMP/17c.out" "" custos
afirma "$TMP/17c.out" "CUSTOS: sem estimativa oficial válida"
rc_e "$TMP/17c.out" 2
sem_escritas; sem_proibidos

echo "18. tudo: para na primeira etapa com problema (custos acima do limite) sem configurar"
novo_estado tudo; echo alto > "$MODO"; export CENARIO_PRECOS_CACHE="$TMP/cache4/p.json"
roda "$TMP/18.out" "configurar cenariogestao" tudo
afirma "$TMP/18.out" "AUDITORIA: OK"
afirma "$TMP/18.out" "CUSTOS: ACIMA"
nega "$TMP/18.out" "Plano de configuração"
rc_nao0 "$TMP/18.out"; sem_escritas

echo "19. operador.sh mostrar-credencial: recusa fora de terminal interativo; 'senhas' removido"
: > "$GCLOUD_LOG"
set +e
( cd "$REPO" && echo sim | bash infra/homolog/gcp/operador.sh mostrar-credencial proxy ) > "$TMP/19a.out" 2>&1; echo $? > "$TMP/19a.out.rc"
( cd "$REPO" && bash infra/homolog/gcp/operador.sh mostrar-credencial gestor < /dev/null | cat ) > "$TMP/19b.out" 2>&1
( cd "$REPO" && bash infra/homolog/gcp/operador.sh senhas ) > "$TMP/19c.out" 2>&1; echo $? > "$TMP/19c.out.rc"
set -e
afirma "$TMP/19a.out" "Recusado: a credencial só é exibida num terminal interativo"
afirma "$TMP/19b.out" "Recusado"
afirma "$TMP/19c.out" "Removido"
rc_nao0 "$TMP/19a.out"; rc_nao0 "$TMP/19c.out"
nega "$GCLOUD_LOG" "versions access"
if command -v script >/dev/null 2>&1; then
  # Terminal real (pseudo-TTY): exibe e, depois do Enter, limpa a tela e o histórico de rolagem.
  ( cd "$REPO" && printf 'sim\n\n' | script -qec "bash infra/homolog/gcp/operador.sh mostrar-credencial proxy" /dev/null ) > "$TMP/19d.out" 2>&1 || true
  afirma "$GCLOUD_LOG" "secrets versions access latest --secret=homolog-proxy-password --project=cenariogestao"
  afirma "$TMP/19d.out" "Tela apagada."
  grep -q $'\033\[3J' "$TMP/19d.out" && echo "  ✔ sequência de limpeza do histórico enviada" || { echo "  ✘ sem limpeza do histórico"; FALHAS=$((FALHAS + 1)); }
else echo "  (script(1) ausente: caminho interativo não testado)"; fi

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
