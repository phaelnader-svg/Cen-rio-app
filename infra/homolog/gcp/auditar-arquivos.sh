#!/usr/bin/env bash
# Homologação — auditoria SOMENTE LEITURA dos arquivos privados (fotos/anexos/comprovantes).
# Para cada registro de stored_files: existe no banco? existe no volume (origem)? está no backup
# mais recente (storage.tar.gz)? Mesmo tamanho e SHA-256? Executar no Cloud Shell, na raiz do
# repositório, com a chave SSH no ssh-agent (ver ssh-agente.sh):
#
#   bash infra/homolog/gcp/auditar-arquivos.sh
#
# Garantias: só leituras (SELECT, find/stat/sha256sum, tar -t); nada é criado, alterado,
# restaurado ou reiniciado; nenhum nome original de arquivo ou dado pessoal é exibido (só a chave
# interna, finalidade, tamanho, hash e datas). Só a VM de homologação (ids conferidos).
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck source=ssh-agente.sh
source infra/homolog/gcp/ssh-agente.sh

PROJECT=cenariogestao
ZONE=us-east1-b
VM=cenario-homolog
VM_ID=5606039017119619228
RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-homolog-relatorios}"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
g() { gcloud --project="$PROJECT" "$@"; }
pare() { echo "✘ $*"; exit 1; }

[[ "$(g compute instances describe "$VM" --zone="$ZONE" --format='value(id)')" == "$VM_ID" ]] \
  || pare "VM $VM não tem o id esperado $VM_ID"
conferir_chave_ssh || exit 1

REMOTO='set -eu
C="sudo docker compose -f /opt/cenario/infra/homolog/docker-compose.homolog.yml --env-file /run/cenario/env"
B=$($C exec -T backup sh -c "ls -1d /data/backups/cenario-* | sort | tail -1")
echo "@@ BANCO"
$C exec -T postgres psql -U cenario -d cenario_homolog -At -F"|" -c "
  SELECT f.storage_key, f.purpose, f.size_bytes, f.sha256,
         to_char(f.created_at AT TIME ZONE '"'"'UTC'"'"', '"'"'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'"'"'),
         (SELECT count(*) FROM attachments a WHERE a.file_id = f.id)
    FROM stored_files f ORDER BY f.created_at"
echo "@@ ORIGEM"
$C exec -T api sh -c "cd /data/storage 2>/dev/null && find . -type f | sed s#^./## | sort | while read f; do echo \"\$f|\$(stat -c %s \"\$f\")|\$(sha256sum \"\$f\" | cut -c1-64)|\$(date -u -r \"\$f\" +%Y-%m-%dT%H:%M:%SZ)\"; done; true"
echo "@@ VOLUME"
$C exec -T api sh -c "ls -la /data/storage; df -h /data/storage | tail -1"
echo "@@ BACKUP $B"
$C exec -T backup sh -c "cd $B && ls -l && tar -tzvf storage.tar.gz | awk '"'"'\$1 !~ /^d/ {sub(/^\\.\\//, \"\", \$6); print \$6 \"|\" \$3}'"'"'"'

echo "Lendo a homologação (somente leitura)…"
g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" --command="$REMOTO" > "$T/saida.txt" \
  || pare "leitura pela VM falhou (nada foi alterado)"
mkdir -p "$RELDIR"; cp "$T/saida.txt" "$RELDIR/arquivos-auditoria-$CARIMBO.txt"

awk -F'|' '
  /^@@ / { secao = $0; sub(/^@@ /, "", secao); split(secao, s, " "); secao = s[1]; if (secao == "BACKUP") pasta = s[2]; next }
  secao == "BANCO" && NF >= 6 { n++; chave[n] = $1; fin[n] = $2; tam[n] = $3; sha[n] = $4; data[n] = $5; anexos[n] = $6 }
  secao == "ORIGEM" && NF >= 3 { otam[$1] = $2; osha[$1] = $3; odata[$1] = $4; norig++ }
  secao == "BACKUP" && NF >= 2 && $1 != "" { btam[$1] = $2; nback++ }
  END {
    printf "\nstored_files no banco: %d · arquivos na origem (volume): %d · arquivos no backup %s: %d\n\n", n, norig + 0, pasta, nback + 0
    ruim = 0
    for (i = 1; i <= n; i++) {
      k = chave[i]
      o = (k in otam) ? ((otam[k] == tam[i] && osha[k] == sha[i]) ? "OK" : "DIFERENTE") : "AUSENTE"
      b = (k in btam) ? ((btam[k] == tam[i]) ? "OK" : "DIFERENTE") : "AUSENTE"
      if (o == "AUSENTE") v = "ausente NA ORIGEM (o backup não tem como conter)"
      else if (o == "DIFERENTE") v = "arquivo da origem difere do registro (tamanho/hash)"
      else if (b != "OK") v = "presente na origem, ausente/diferente NO BACKUP"
      else v = "íntegro na origem e no backup"
      if (v != "íntegro na origem e no backup") ruim++
      mini = k; sub(/^attachment\//, "attachment-thumb/", mini)
      m = (mini != k) ? (((mini in otam) ? "origem OK" : "origem AUSENTE") " / " ((mini in btam) ? "backup OK" : "backup AUSENTE")) : "não se aplica"
      printf "• %s · %s · %s bytes · criado %s · anexos %s\n    origem: %s · backup: %s → %s\n    miniatura (derivada, sem registro próprio; fotos antigas podem não ter): %s\n", k, fin[i], tam[i], data[i], anexos[i], o, b, v, m
    }
    for (k in otam) {
      achou = 0; base = k; sub(/^attachment-thumb\//, "attachment/", base)
      for (i = 1; i <= n; i++) if (chave[i] == k || (base != k && chave[i] == base)) achou = 1
      if (!achou) { printf "• arquivo na origem SEM registro no banco: %s\n", k; ruim++ }
    }
    printf "\n%s\n", ruim ? "✘ divergências encontradas (ver acima)" : "✔ todos os arquivos registrados estão na origem e no backup"
  }' "$T/saida.txt"
echo "Saída completa: $RELDIR/arquivos-auditoria-$CARIMBO.txt (nada foi alterado)"
