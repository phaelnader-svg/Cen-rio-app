#!/usr/bin/env bash
# Melhoria 97: cópia dos backups FORA do Google e teste mensal de restauração.
#
# Os backups diários já vão para o Cloud Storage (vm.sh enviar-backups). Este script manda uma
# segunda cópia para um provedor de armazenamento compatível com S3 de outra empresa (por
# exemplo Cloudflare R2 ou Backblaze B2), para o caso de um problema na conta do Google.
#
# A chave de acesso NUNCA vai em argumento, chat ou arquivo do repositório: fica no Secret
# Manager do projeto da produção, no segredo "cenario-backup-fora" (JSON com endpoint, bucket,
# access_key_id e secret_access_key), criado pelo dono no painel do Google Cloud.
#
# Uso (na VM da produção, como root):
#   backup-fora.sh enviar      # copia a pasta de backups do dia (rodado pelo timer diário)
#   backup-fora.sh restaurar   # baixa o backup mais recente de lá e confere que ele restaura
#   backup-fora.sh instalar    # instala os timers (diário 08:00 UTC e mensal no dia 1, 09:00 UTC)
set -euo pipefail

SEGREDO="${CENARIO_SEGREDO_BACKUP_FORA:-cenario-backup-fora}"
# Pasta dos backups diários (volume do Docker da produção, o mesmo do vm.sh enviar-backups).
ORIGEM="${CENARIO_BACKUPS_DIR:-$(docker volume inspect -f '{{.Mountpoint}}' cenario-prod_backups 2>/dev/null || true)}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

credenciais() {
  local json
  json="$(gcloud secrets versions access latest --secret="$SEGREDO" 2>/dev/null)" || {
    echo "✘ Segredo $SEGREDO não encontrado no Secret Manager (a conta no outro provedor ainda não foi configurada)."
    exit 3
  }
  export RCLONE_CONFIG_FORA_TYPE=s3 RCLONE_CONFIG_FORA_PROVIDER=Other RCLONE_CONFIG_FORA_ACL=private
  RCLONE_CONFIG_FORA_ENDPOINT="$(jq -r .endpoint <<<"$json")"
  RCLONE_CONFIG_FORA_ACCESS_KEY_ID="$(jq -r .access_key_id <<<"$json")"
  RCLONE_CONFIG_FORA_SECRET_ACCESS_KEY="$(jq -r .secret_access_key <<<"$json")"
  BUCKET="$(jq -r .bucket <<<"$json")"
  export RCLONE_CONFIG_FORA_ENDPOINT RCLONE_CONFIG_FORA_ACCESS_KEY_ID RCLONE_CONFIG_FORA_SECRET_ACCESS_KEY
}

precisa() { command -v "$1" >/dev/null || { echo "✘ Falta o programa $1 na VM (apt-get install -y $1)."; exit 2; }; }

case "${1:-}" in
  enviar)
    precisa rclone; precisa jq; credenciais
    [[ -n "$ORIGEM" && -d "$ORIGEM" ]] || { echo "Sem pasta de backups: nada a enviar."; exit 0; }
    # Só acrescenta (nunca apaga do outro lado); a retenção é a do próprio bucket (ex.: 90 dias).
    rclone copy "$ORIGEM" "FORA:$BUCKET/producao" --max-age 48h --immutable --transfers 2
    echo "✔ Backups das últimas 48 h copiados para fora do Google ($BUCKET)"
    ;;
  restaurar)
    precisa rclone; precisa jq; precisa docker; credenciais
    TMP="$(mktemp -d)"; NOME_PG="cenario-restauracao-$$"
    trap 'docker rm -f "$NOME_PG" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
    ULTIMO="$(rclone lsf "FORA:$BUCKET/producao" --dirs-only | sort | tail -n1)"
    ULTIMO="${ULTIMO%/}"
    [[ -n "$ULTIMO" ]] || { echo "✘ Nenhum backup encontrado fora do Google."; exit 4; }
    rclone copy "FORA:$BUCKET/producao/$ULTIMO" "$TMP/b"
    ( cd "$TMP/b" && sha256sum -c --quiet SHA256SUMS ) || { echo "✘ $ULTIMO: arquivos diferentes do registrado (SHA256SUMS)."; exit 5; }
    # Restaura num PostgreSQL descartável (sem rede, apagado no fim) e confere o conteúdo.
    docker run -d --rm --name "$NOME_PG" --network none -e POSTGRES_PASSWORD=descartavel \
      -e POSTGRES_USER=cenario -e POSTGRES_DB=conferencia -v "$TMP/b:/b:ro" postgres:16 >/dev/null
    for _ in $(seq 1 60); do docker exec "$NOME_PG" pg_isready -U cenario -d conferencia >/dev/null 2>&1 && break; sleep 1; done
    docker exec "$NOME_PG" pg_restore --no-owner --no-privileges -U cenario -d conferencia /b/database.dump
    TABELAS="$(docker exec "$NOME_PG" psql -U cenario -d conferencia -Atc "select count(*) from information_schema.tables where table_schema='public'")"
    MIGRACOES="$(docker exec "$NOME_PG" psql -U cenario -d conferencia -Atc "select count(*) from _prisma_migrations where finished_at is not null")"
    EMPRESAS="$(docker exec "$NOME_PG" psql -U cenario -d conferencia -Atc "select count(*) from company_settings")"
    if (( TABELAS < 50 || MIGRACOES < 1 || EMPRESAS < 1 )); then
      echo "✘ Restauração incompleta: $TABELAS tabelas, $MIGRACOES migrations, $EMPRESAS empresas."; exit 6
    fi
    echo "✔ Teste mensal: o backup $ULTIMO (fora do Google) restaura ($TABELAS tabelas, $MIGRACOES migrations, $EMPRESAS empresas)"
    ;;
  instalar)
    cat >/etc/systemd/system/cenario-backup-fora.service <<EOF
[Unit]
Description=Cenário Gestão — cópia dos backups fora do Google
[Service]
Type=oneshot
ExecStart=$DIR/backup-fora.sh enviar
EOF
    cat >/etc/systemd/system/cenario-backup-fora.timer <<'EOF'
[Unit]
Description=Cópia diária dos backups fora do Google
[Timer]
OnCalendar=*-*-* 08:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
    cat >/etc/systemd/system/cenario-restauracao-mensal.service <<EOF
[Unit]
Description=Cenário Gestão — teste mensal de restauração do backup de fora
[Service]
Type=oneshot
ExecStart=$DIR/backup-fora.sh restaurar
EOF
    cat >/etc/systemd/system/cenario-restauracao-mensal.timer <<'EOF'
[Unit]
Description=Teste mensal de restauração
[Timer]
OnCalendar=*-*-01 09:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now cenario-backup-fora.timer cenario-restauracao-mensal.timer
    echo "✔ Timers instalados (cópia diária 08:00 UTC; restauração no dia 1 de cada mês)"
    ;;
  *)
    echo "uso: $0 enviar|restaurar|instalar"; exit 2 ;;
esac
