#!/usr/bin/env bash
# Auditoria SOMENTE LEITURA da homologação JÁ PUBLICADA (Evolução — pré-deploy). Enviada pelo
# "auditoria-pre-deploy.sh" via IAP e executada como root por "bash -s": não depende dos arquivos
# que estão na VM (podem ser de outra versão). Não inicia, não para, não reinicia, não grava no
# banco (transações READ ONLY), não lê o Secret Manager e não imprime segredos (do arquivo de
# ambiente só as linhas das IMAGENS). Linhas ✔ / ⚠ / ✘ são contadas no resumo.
# Variáveis opcionais: PREFLIGHT_SQL (conteúdo de sql/preflight-evolucao.sql, enviado junto).
set -uo pipefail
ok() { echo "✔ $*"; }
aviso() { echo "⚠ $*"; }
ruim() { echo "✘ $*"; }
secao() { echo; echo "== $*"; }
PORTAO=/etc/cenario/publicacao-autorizada
ENV_FILE=/run/cenario/env
META=http://metadata.google.internal/computeMetadata/v1
meta() { curl -fsS -m 2 -H 'Metadata-Flavor: Google' "$META/instance/attributes/$1" 2>/dev/null || true; }

secao "Sistema e recursos"
echo "• $(. /etc/os-release && echo "$PRETTY_NAME") · kernel $(uname -r) · ligada desde $(uptime -s)"
echo "• memória: $(free -m | awk '/^Mem:/ {print $2" MB total, "$3" usados, "$7" disponíveis"}') · swap: $(free -m | awk '/^Swap:/ {print $2" MB, "$3" usados"}')"
uso="$(df --output=pcent / | tail -1 | tr -dc 0-9)"; livre="$(df --output=avail -BG / | tail -1 | tr -dc 0-9)"
echo "• disco /: $(df -h --output=size,used,avail / | tail -1 | xargs) (${uso}%)"
(( livre >= 5 )) && ok "disco livre ${livre} GB (imagens novas ~3,6 GB cada, camadas comuns compartilhadas)" \
  || ruim "disco livre ${livre} GB: insuficiente para baixar as imagens novas com folga (mínimo 5 GB)"
[[ -f /var/run/reboot-required ]] && aviso "reinício pendente após atualização do sistema" || ok "nenhum reinício pendente"

secao "Versões"
echo "• /opt/cenario/VERSAO (configuração na VM): $(cat /opt/cenario/VERSAO 2>/dev/null || echo desconhecida)"
echo "• metadado cenario-tag (imagens que sobem num reinício): $(meta cenario-tag)"
echo "• metadados: domínio=$(meta cenario-domain) · repo=$(meta cenario-repo) · região=$(meta cenario-region) · bucket=$(meta cenario-bucket)"
if [[ -f "$ENV_FILE" ]]; then
  echo "• imagens no ambiente gerado ($ENV_FILE, só estas linhas):"
  grep -E "^CENARIO_(API|WEB)_IMAGE=" "$ENV_FILE" | sed 's/^/    /'
  grep -q '^CENARIO_MIGRATE_ON_START=' "$ENV_FILE" && aviso "CENARIO_MIGRATE_ON_START definido no ambiente" || true
else aviso "ambiente $ENV_FILE ausente (pilha não iniciada desde o último boot?)"; fi
[[ -f "$PORTAO" ]] && ok "portão de publicação aberto (pilha publicada)" || aviso "portão de publicação FECHADO ($PORTAO ausente)"
for u in cenario-homolog.service cenario-backup-upload.timer; do
  echo "• $u: $(systemctl is-enabled "$u" 2>/dev/null || echo ausente) / $(systemctl is-active "$u" 2>/dev/null || true)"
done

secao "Contêineres"
if ! command -v docker >/dev/null 2>&1; then ruim "Docker ausente"; else
  echo "• Docker $(docker --version | cut -d' ' -f3 | tr -d ,) · Compose $(docker compose version --short 2>/dev/null || echo ?)"
  for s in postgres api web caddy backup; do
    id="$(docker ps -aq --filter "label=com.docker.compose.project=cenario-homolog" --filter "label=com.docker.compose.service=$s" | head -1)"
    if [[ -z "$id" ]]; then ruim "$s: contêiner ausente"; continue; fi
    st="$(docker inspect -f '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}} · desde {{.State.StartedAt}} · reinícios {{.RestartCount}}' "$id")"
    img="$(docker inspect -f '{{.Config.Image}}' "$id")"; iid="$(docker inspect -f '{{.Image}}' "$id")"
    dig="$(docker image inspect -f '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$iid" 2>/dev/null)"
    [[ "$st" == running* && "$st" != *unhealthy* ]] && ok "$s: $st" || ruim "$s: $st"
    echo "    imagem $img · ${dig:-$iid}"
  done
  echo "• memória por contêiner:"; docker stats --no-stream --format '    {{.Name}} {{.MemUsage}} {{.CPUPerc}}' 2>/dev/null | sed 's/cenario-homolog-//'
  echo "• imagens locais: $(docker images --format '{{.Repository}}:{{.Tag}} ({{.Size}})' | xargs echo -n)"
  echo "• espaço do Docker:"; docker system df 2>/dev/null | sed 's/^/    /'
fi

secao "Volumes persistentes"
for v in cenario-homolog_pgdata cenario-homolog_storage cenario-homolog_backups cenario-homolog_caddy_data; do
  mp="$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null)"
  if [[ -n "$mp" ]]; then ok "$v: $(du -sh "$mp" 2>/dev/null | cut -f1) ($(find "$mp" -type f 2>/dev/null | wc -l) arquivos)"
  else ruim "$v: ausente"; fi
done

secao "Banco de dados (somente leitura)"
pg="$(docker ps -q --filter label=com.docker.compose.project=cenario-homolog --filter label=com.docker.compose.service=postgres | head -1)"
if [[ -z "$pg" ]]; then ruim "PostgreSQL não está em execução: banco não auditado"; else
  q() { docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$pg" psql -U cenario -d cenario_homolog -At -F'|' "$@"; }
  docker exec "$pg" pg_isready -U cenario -d cenario_homolog >/dev/null && ok "PostgreSQL aceita conexões ($(q -c 'show server_version'))" || ruim "pg_isready falhou"
  echo "• tamanho do banco: $(q -c "select pg_size_pretty(pg_database_size('cenario_homolog'))") · conexões: $(q -c "select count(*) from pg_stat_activity where datname = 'cenario_homolog'")"
  echo "• migrations aplicadas (nome · concluída):"
  q -c "select migration_name, coalesce(finished_at::text, 'NÃO CONCLUÍDA'), coalesce(rolled_back_at::text, '') from _prisma_migrations order by migration_name" | sed 's/^/    /'
  pend="$(q -c 'select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null')"
  [[ "$pend" == 0 ]] && ok "nenhuma migration pendente/com falha" || ruim "$pend migration(s) com falha ou incompletas"
  echo "• linhas (estimativa) das tabelas principais:"
  q -c "select relname, n_live_tup from pg_stat_user_tables where relname in ('users','customers','service_orders','production_tasks','production_payables','logistics_costs','account_payables','audit_logs','stored_files') order by relname" | sed 's/^/    /'
  if [[ -n "${PREFLIGHT_SQL:-}" ]]; then
    echo "• pré-verificação das migrations da Evolução (verificação|valor|esperado):"
    printf '%s\n' "$PREFLIGHT_SQL" | q -v ON_ERROR_STOP=1 | grep -vE '^(BEGIN|ROLLBACK)$' | while IFS='|' read -r n v e; do
      if [[ "$n" == volume* || "$e" == "$v" ]]; then echo "    ✔ $n|$v|$e"; else echo "    ✘ $n|$v|$e"; fi
    done
  fi
fi

secao "Backups"
bk="$(docker volume inspect -f '{{.Mountpoint}}' cenario-homolog_backups 2>/dev/null)"
if [[ -n "$bk" && -d "$bk" ]]; then
  n="$(find "$bk" -maxdepth 1 -type d -name 'cenario-*' | wc -l)"
  echo "• $n pasta(s) de backup; as 5 mais recentes:"
  find "$bk" -maxdepth 1 -type d -name 'cenario-*' -printf '%T@ %f\n' | sort -n | tail -5 | while read -r t f; do
    echo "    $f · $(du -sh "$bk/$f" | cut -f1) · há $(( ($(date +%s) - ${t%.*}) / 3600 )) h"
  done
  ult="$(find "$bk" -maxdepth 1 -type d -name 'cenario-*' -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
  if [[ -n "$ult" ]]; then
    ( cd "$ult" && sha256sum --check --quiet SHA256SUMS ) && ok "último backup íntegro (SHA256SUMS): $(basename "$ult")" || ruim "último backup com checksum inválido"
  else ruim "nenhum backup encontrado"; fi
  echo "• enviados ao bucket (registro local): $(wc -l < /var/lib/cenario/enviados 2>/dev/null || echo 0)"
else ruim "volume de backups ausente"; fi

secao "Rede e certificado"
portas="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed 's/.*://' | sort -un | xargs)"
echo "• portas TCP escutando fora do loopback: ${portas:-nenhuma} (esperado: 22 80 443)"
dom="$(meta cenario-domain)"
if [[ -n "$dom" ]]; then
  fim="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$dom" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [[ -n "$fim" ]] && ok "certificado de $dom válido até $fim" || ruim "certificado não lido em 127.0.0.1:443"
  r="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$dom:443:127.0.0.1" "https://$dom/painel" || true)"
  [[ "$r" == 401 ]] && ok "proxy exige autenticação (HTTP $r)" || aviso "proxy sem credencial respondeu $r (esperado 401)"
fi
echo "FIM-AUDITORIA"
