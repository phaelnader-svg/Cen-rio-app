#!/usr/bin/env bash
# Backup do Cenário Gestão: banco PostgreSQL (formato custom, comprimido) +
# arquivos privados (fotos/documentos), com checksum SHA-256.
#
# Uso: scripts/backup.sh [diretório-destino]
# Variáveis: DATABASE_URL (obrigatória), STORAGE_DIR (padrão ./storage),
#            BACKUP_RETENTION_DAYS (padrão 30; 0 desativa a limpeza).
set -euo pipefail

if [[ -f .env && -z "${DATABASE_URL:-}" ]]; then
  set -a; source .env; set +a
fi
: "${DATABASE_URL:?DATABASE_URL não definido}"
DEST="${1:-./backups}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ENV_NAME="${APP_ENV:-development}"
TARGET="$DEST/cenario-$ENV_NAME-$STAMP"

umask 077
mkdir -p "$TARGET"

echo "→ Banco de dados…"
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file="$TARGET/database.dump" "$DATABASE_URL"
# Valida que o arquivo pode ser lido (lista o conteúdo sem restaurar).
pg_restore --list "$TARGET/database.dump" > /dev/null

if [[ -d "$STORAGE_DIR" ]]; then
  echo "→ Arquivos privados ($STORAGE_DIR)…"
  tar -czf "$TARGET/storage.tar.gz" -C "$STORAGE_DIR" .
fi

( cd "$TARGET" && sha256sum ./* > SHA256SUMS )
echo "{\"createdAt\":\"$STAMP\",\"environment\":\"$ENV_NAME\"}" > "$TARGET/manifest.json"

if [[ "$RETENTION" != "0" ]]; then
  find "$DEST" -maxdepth 1 -type d -name 'cenario-*' -mtime "+$RETENTION" -exec rm -rf {} +
fi

echo "✔ Backup concluído: $TARGET"
