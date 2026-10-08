#!/usr/bin/env bash
# Restauração de um backup gerado por scripts/backup.sh.
#
# Uso: scripts/restore.sh <diretório-do-backup> --target <DATABASE_URL> [--storage <dir>] --yes
#
# ATENÇÃO: substitui o conteúdo do banco de destino. Por segurança:
# - o destino precisa ser informado explicitamente (não usa DATABASE_URL);
# - exige a confirmação --yes;
# - verifica os checksums antes de qualquer alteração.
# Depois de restaurar, os clientes conectados recebem "resync.required" e
# recarregam os dados automaticamente.
set -euo pipefail

SRC="${1:-}"; shift || true
TARGET_URL=""; STORAGE_DEST=""; CONFIRM="no"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET_URL="$2"; shift 2 ;;
    --storage) STORAGE_DEST="$2"; shift 2 ;;
    --yes) CONFIRM="yes"; shift ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

[[ -d "$SRC" && -f "$SRC/database.dump" ]] || { echo "Backup inválido: $SRC" >&2; exit 2; }
[[ -n "$TARGET_URL" ]] || { echo "Informe --target <DATABASE_URL>." >&2; exit 2; }
[[ "$CONFIRM" == "yes" ]] || { echo "Confirme com --yes (o banco de destino será substituído)." >&2; exit 2; }

echo "→ Verificando integridade…"
( cd "$SRC" && sha256sum --check --quiet SHA256SUMS )

echo "→ Restaurando banco…"
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  --exit-on-error --dbname="$TARGET_URL" "$SRC/database.dump"

if [[ -n "$STORAGE_DEST" && -f "$SRC/storage.tar.gz" ]]; then
  echo "→ Restaurando arquivos em $STORAGE_DEST…"
  mkdir -p "$STORAGE_DEST"
  tar -xzf "$SRC/storage.tar.gz" -C "$STORAGE_DEST"
fi

echo "✔ Restauração concluída. Rode 'pnpm db:status' para conferir as migrations."
