#!/usr/bin/env bash
# Teste ISOLADO do backup e da restauração de ARQUIVOS, reproduzindo o contêiner de backup da
# homologação (infra/homolog/docker-compose.homolog.yml, serviço "backup"): imagem postgres:16,
# /scripts e /data/storage somente leitura, /data/backups gravável, os mesmos scripts/backup.sh e
# scripts/restore.sh e as mesmas formas de restaurar usadas por infra/homolog/gcp/vm.sh
# (restaurar-teste → --storage /tmp/rs; recuperar → --storage num volume gravável).
#
# Tudo é temporário e local: um arquivo de teste aleatório (e a miniatura) num diretório próprio, um
# banco LOCAL descartável e diretórios em $WORK. Nunca toca a homologação, seus volumes, banco ou
# backups. Compara SHA-256 antes e depois.
#
# Uso: PG_BASE=postgresql://usuario:senha@127.0.0.1:5432 [IMAGEM=postgres:16] [TAMANHO=24118] \
#        scripts/test-backup-arquivos-isolado.sh
set -euo pipefail
: "${PG_BASE:?PG_BASE não definido}"
IMAGEM="${IMAGEM:-postgres:16}"
TAMANHO="${TAMANHO:-24118}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /var/tmp/bk-isolado.XXXXXX)"
DB_ORIG="bk_isolado_origem_$$"
DB_REST="bk_isolado_restaurado_$$"
limpar() {
  psql -q "$PG_BASE/postgres" -c "DROP DATABASE IF EXISTS $DB_ORIG" -c "DROP DATABASE IF EXISTS $DB_REST" 2>/dev/null || true
  rm -rf "$WORK"
}
trap limpar EXIT
falha() { echo "✘ $*"; exit 1; }

echo "→ banco de origem descartável com 1 arquivo registrado ($TAMANHO bytes)"
psql -q "$PG_BASE/postgres" -c "CREATE DATABASE $DB_ORIG" -c "CREATE DATABASE $DB_REST"
psql -q "$PG_BASE/$DB_ORIG" -c "CREATE TABLE stored_files (id uuid primary key, storage_key text, size_bytes int, sha256 char(64))"
ID="$(cat /proc/sys/kernel/random/uuid)"
mkdir -p "$WORK/storage/attachment" "$WORK/storage/attachment-thumb" "$WORK/backups" "$WORK/volume-restaurado"
head -c "$TAMANHO" /dev/urandom > "$WORK/storage/attachment/$ID"
head -c 2048 /dev/urandom > "$WORK/storage/attachment-thumb/$ID"
# Como a API grava (LocalFileStorage.put): dono uid 1000 (usuário node da imagem), modo 0600,
# diretórios 0700. O contêiner de backup roda como root.
chown -R 1000:1000 "$WORK/storage"; chmod 700 "$WORK/storage/attachment" "$WORK/storage/attachment-thumb"
chmod 600 "$WORK/storage/attachment/$ID" "$WORK/storage/attachment-thumb/$ID"; chmod 755 "$WORK/storage"
chmod 777 "$WORK/backups" "$WORK/volume-restaurado"
SHA_A="$(sha256sum "$WORK/storage/attachment/$ID" | cut -d' ' -f1)"
SHA_T="$(sha256sum "$WORK/storage/attachment-thumb/$ID" | cut -d' ' -f1)"
psql -q "$PG_BASE/$DB_ORIG" -c "INSERT INTO stored_files VALUES ('$ID', 'attachment/$ID', $TAMANHO, '$SHA_A')"
echo "  arquivo  attachment/$ID  sha256 $SHA_A"
echo "  miniatura attachment-thumb/$ID  sha256 $SHA_T"

# O contêiner usa a rede do host para chegar ao PostgreSQL local (na VM, à rede interna da pilha).
URL_ORIG="${PG_BASE/127.0.0.1/127.0.0.1}/$DB_ORIG"
URL_REST="${PG_BASE/127.0.0.1/127.0.0.1}/$DB_REST"
base_run=(docker run --rm --network host -e APP_ENV=staging -e STORAGE_DIR=/data/storage
  -e BACKUP_RETENTION_DAYS=14 -v "$ROOT/scripts:/scripts:ro" -v "$WORK/storage:/data/storage:ro"
  -v "$WORK/backups:/data/backups" -w /tmp)

echo "→ backup como o serviço da homologação: bash /scripts/backup.sh /data/backups"
"${base_run[@]}" -e DATABASE_URL="$URL_ORIG" --entrypoint bash "$IMAGEM" -c 'bash /scripts/backup.sh /data/backups' \
  | sed 's/^/    /'
PASTA="$(ls -1 "$WORK/backups" | sort | tail -1)"
[[ -f "$WORK/backups/$PASTA/storage.tar.gz" ]] || falha "backup sem storage.tar.gz"
echo "  conteúdo do storage.tar.gz:"; tar -tzvf "$WORK/backups/$PASTA/storage.tar.gz" | grep -v '^d' | sed 's/^/    /'
( cd "$WORK/backups/$PASTA" && sha256sum --check --quiet SHA256SUMS ) || falha "SHA256SUMS do backup inválido"
echo "  ✔ SHA256SUMS do backup conferido"

echo "→ restauração como vm.sh restaurar-teste (arquivos em /tmp/rs, contados e com hash)"
SAIDA="$("${base_run[@]}" -e DATABASE_URL="$URL_ORIG" --entrypoint bash "$IMAGEM" -c \
  "bash /scripts/restore.sh /data/backups/$PASTA --target $URL_REST --storage /tmp/rs --yes >/dev/null && \
   echo arquivos restaurados: \$(find /tmp/rs -type f | wc -l) && \
   sha256sum /tmp/rs/attachment/$ID /tmp/rs/attachment-thumb/$ID")"
echo "$SAIDA" | sed 's/^/    /'
grep -q "arquivos restaurados: 2" <<<"$SAIDA" || falha "restauração de teste não trouxe os 2 arquivos"
grep -q "^$SHA_A " <<<"$SAIDA" || falha "SHA-256 do arquivo restaurado (teste) difere"
grep -q "^$SHA_T " <<<"$SAIDA" || falha "SHA-256 da miniatura restaurada (teste) difere"
echo "  ✔ restauração de teste: 2 arquivos, SHA-256 idênticos"

echo "→ restauração como vm.sh recuperar (arquivos num volume gravável)"
psql -q "$PG_BASE/postgres" -c "DROP DATABASE $DB_REST" -c "CREATE DATABASE $DB_REST"
"${base_run[@]}" -v "$WORK/volume-restaurado:/data/storage-rw" -e DATABASE_URL="$URL_ORIG" --entrypoint bash "$IMAGEM" -c \
  "bash /scripts/restore.sh /data/backups/$PASTA --target $URL_REST --storage /data/storage-rw --yes >/dev/null"
[[ "$(sha256sum "$WORK/volume-restaurado/attachment/$ID" | cut -d' ' -f1)" == "$SHA_A" ]] || falha "arquivo restaurado no volume difere"
[[ "$(sha256sum "$WORK/volume-restaurado/attachment-thumb/$ID" | cut -d' ' -f1)" == "$SHA_T" ]] || falha "miniatura restaurada no volume difere"
[[ "$(psql "$PG_BASE/$DB_REST" -Atc "SELECT sha256 FROM stored_files WHERE id = '$ID'")" == "$SHA_A" ]] || falha "registro restaurado difere"
[[ "$(stat -c '%u %a' "$WORK/volume-restaurado/attachment/$ID")" == "1000 600" ]] \
  || falha "arquivo restaurado sem o dono/permissão da API ($(stat -c '%u %a' "$WORK/volume-restaurado/attachment/$ID"))"
echo "  ✔ restauração para volume: arquivo, miniatura e registro idênticos (SHA-256); dono 1000, modo 600 (legível pela API)"

echo "→ origem intacta depois de tudo"
[[ "$(sha256sum "$WORK/storage/attachment/$ID" | cut -d' ' -f1)" == "$SHA_A" ]] || falha "origem alterada"
echo "  ✔ origem inalterada (montada somente leitura)"
echo "✔ Backup e restauração de arquivos verificados com a imagem $IMAGEM."
