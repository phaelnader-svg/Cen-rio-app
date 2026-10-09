#!/usr/bin/env bash
# Inspeção SOMENTE LEITURA da VM de homologação. Enviado pelo "homolog.sh auditar" via IAP e
# executado como root por "bash -s" (não precisa de nenhum arquivo na VM). Não instala, não
# inicia, não para e não altera nada; não lê segredos. Linhas com ✔ / ⚠ / ✘ são contadas no relatório.
set -uo pipefail
ok() { echo "✔ $*"; }
aviso() { echo "⚠ $*"; }
ruim() { echo "✘ $*"; }
PORTAO=/etc/cenario/publicacao-autorizada
META=http://metadata.google.internal/computeMetadata/v1

echo "• sistema: $(. /etc/os-release && echo "$PRETTY_NAME") · kernel $(uname -r) · ligada desde $(uptime -s)"
if [[ "$(. /etc/os-release && echo "$VERSION_ID")" == 12 ]]; then ok "Debian 12"; else aviso "sistema diferente do Debian 12"; fi

if command -v docker >/dev/null 2>&1; then
  ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ,) · Compose $(docker compose version --short 2>/dev/null || echo AUSENTE)"
  systemctl is-active --quiet docker && ok "serviço docker ativo" || aviso "serviço docker inativo"
  n="$(docker ps -q | wc -l)"; t="$(docker ps -aq | wc -l)"
  (( n == 0 )) && ok "nenhum contêiner em execução (total existentes: $t)" || ruim "$n contêiner(es) EM EXECUÇÃO: $(docker ps --format '{{.Names}}' | xargs)"
  (( t == 0 )) || echo "• contêineres existentes: $(docker ps -a --format '{{.Names}}({{.Status}})' | xargs)"
  echo "• imagens: $(docker images --format '{{.Repository}}:{{.Tag}}' | xargs echo -n) ($(docker images -q | wc -l))"
  v="$(docker volume ls -q | xargs)"; echo "• volumes: ${v:-nenhum}"
  [[ "$v" == *cenario-homolog_pgdata* ]] && aviso "volume do banco já existe (cenario-homolog_pgdata)" || ok "nenhum volume de banco da homologação (PostgreSQL nunca iniciado)"
else ruim "Docker ausente"; fi

sw="$(swapon --show=SIZE --noheadings --bytes 2>/dev/null | awk '{s+=$1} END {print int(s/1048576)}')"
(( ${sw:-0} >= 1024 )) && ok "swap ativa: ${sw} MB ($(swapon --show=NAME --noheadings | xargs))" || ruim "swap insuficiente: ${sw:-0} MB"
grep -qE '^[^#[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]' /etc/fstab && ok "swap declarada no /etc/fstab (sobrevive ao reinício)" || aviso "swap não declarada no /etc/fstab"
echo "• memória: $(free -m | awk '/^Mem:/ {print $2" MB total, "$7" MB disponível"}')"
uso="$(df --output=pcent / | tail -1 | tr -dc 0-9)"; echo "• disco /: $(df -h --output=size,used,avail / | tail -1 | xargs) (${uso}%)"
(( uso < 70 )) && ok "disco com folga (${uso}%)" || aviso "disco em ${uso}%"

portas="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed 's/.*://' | sort -un | xargs)"
[[ -z "$portas" || "$portas" == 22 ]] && ok "portas TCP escutando fora do loopback: ${portas:-nenhuma}" || ruim "portas TCP escutando fora do loopback: $portas (esperado só 22)"

[[ -f "$PORTAO" ]] && ruim "portão de publicação ABERTO ($PORTAO)" || ok "portão de publicação fechado"
if [[ -d /opt/cenario/infra ]]; then echo "• /opt/cenario: versão $(cat /opt/cenario/VERSAO 2>/dev/null || echo desconhecida)"
else echo "• /opt/cenario: sem arquivos do sistema (preparar-vm ainda não executado)"; fi
for u in cenario-homolog.service cenario-backup-upload.timer; do
  echo "• $u: $(systemctl is-enabled "$u" 2>/dev/null || echo ausente) / $(systemctl is-active "$u" 2>/dev/null || true)"
done

command -v gcloud >/dev/null 2>&1 && ok "gcloud presente na VM" || ruim "gcloud ausente na VM (necessário para os segredos)"
if dpkg -s unattended-upgrades >/dev/null 2>&1 && grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
  ok "atualizações automáticas de segurança ativas (unattended-upgrades)"
else aviso "atualizações automáticas de segurança não configuradas (o preparar-vm configura)"; fi
[[ -f /var/run/reboot-required ]] && aviso "reinício pendente após atualização" || ok "nenhum reinício pendente"

sa="$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/email" 2>/dev/null)"
esc="$(curl -fsS -m 3 -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/scopes" 2>/dev/null | sed 's#https://www.googleapis.com/auth/##' | xargs)"
echo "• conta de serviço vista de dentro: ${sa:-?} · escopos: ${esc:-?}"
[[ "$esc" == *cloud-platform* ]] && ok "escopo cloud-platform (o IAM decide o acesso)" || ruim "escopos sem cloud-platform: Secret Manager e gravação no bucket serão negados"
echo "FIM-INSPECAO"
