#!/usr/bin/env bash
# Homologação — prova do backup de ARQUIVOS na infraestrutura real, SEM alterar volumes, banco ou
# backups existentes. Executar no Cloud Shell (raiz do repositório, chave SSH no ssh-agent), só
# com autorização:
#
#   bash infra/homolog/gcp/testar-backup-arquivos-vm.sh
#
# O que faz (dentro de UM contêiner temporário do próprio serviço "backup" da pilha, criado com
# `docker compose run --rm --no-deps` e apagado no fim — nenhum contêiner existente é reiniciado):
#   1. cria um arquivo de teste aleatório (24.118 bytes) e uma miniatura em /tmp do contêiner,
#      com dono 1000 e modo 0600 como a API grava;
#   2. roda o MESMO /scripts/backup.sh da pilha com STORAGE_DIR=/tmp/origem e destino /tmp/saida
#      (o pg_dump do banco real é só LEITURA; o arquivo de dump fica em /tmp e some com o contêiner);
#   3. confere SHA256SUMS, extrai o storage.tar.gz como o restore.sh faz e compara os SHA-256;
#   4. confirma que /data/storage (volume real, montado só leitura) e /data/backups (backups reais)
#      não mudaram (contagem e lista antes/depois).
# Imagem, scripts, rede e banco são os da homologação; nada é gravado fora do /tmp do contêiner.
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck source=ssh-agente.sh
source infra/homolog/gcp/ssh-agente.sh

PROJECT=cenariogestao
ZONE=us-east1-b
VM=cenario-homolog
VM_ID=5606039017119619228
FRASE="TESTAR BACKUP DE ARQUIVOS NA $VM"
RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-homolog-relatorios}"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
g() { gcloud --project="$PROJECT" "$@"; }
pare() { echo "✘ $*"; exit 1; }

[[ "$(g compute instances describe "$VM" --zone="$ZONE" --format='value(id)')" == "$VM_ID" ]] \
  || pare "VM $VM não tem o id esperado $VM_ID"
conferir_chave_ssh || exit 1

# Executado DENTRO do contêiner temporário (bash do serviço backup).
CARGA='set -euo pipefail
falha() { echo "✘ $*"; exit 1; }
estado() { echo "storage: $(find /data/storage -type f 2>/dev/null | wc -l) arquivo(s)"; ls -1 /data/backups | sort | sha256sum | cut -c1-16 | sed "s/^/backups (lista): /"; }
estado > /tmp/antes
ID=$(cat /proc/sys/kernel/random/uuid)
mkdir -p /tmp/origem/attachment /tmp/origem/attachment-thumb /tmp/saida /tmp/rs
head -c 24118 /dev/urandom > /tmp/origem/attachment/$ID
head -c 2048 /dev/urandom > /tmp/origem/attachment-thumb/$ID
chown -R 1000:1000 /tmp/origem; chmod 600 /tmp/origem/attachment/$ID /tmp/origem/attachment-thumb/$ID
A=$(sha256sum /tmp/origem/attachment/$ID | cut -c1-64); M=$(sha256sum /tmp/origem/attachment-thumb/$ID | cut -c1-64)
echo "arquivo de teste attachment/$ID sha256 $A"
STORAGE_DIR=/tmp/origem BACKUP_RETENTION_DAYS=0 bash /scripts/backup.sh /tmp/saida
P=$(ls -1d /tmp/saida/cenario-* | tail -1)
(cd "$P" && sha256sum --check --quiet SHA256SUMS) || falha "SHA256SUMS inválido"
echo "✔ SHA256SUMS do backup de teste conferido"
tar -tzvf "$P/storage.tar.gz" | grep -v "^d"
tar -xzf "$P/storage.tar.gz" -C /tmp/rs
[ "$(find /tmp/rs -type f | wc -l)" = 2 ] || falha "restauração não trouxe 2 arquivos"
[ "$(sha256sum /tmp/rs/attachment/$ID | cut -c1-64)" = "$A" ] || falha "SHA-256 do arquivo restaurado difere"
[ "$(sha256sum /tmp/rs/attachment-thumb/$ID | cut -c1-64)" = "$M" ] || falha "SHA-256 da miniatura restaurada difere"
[ "$(stat -c "%u %a" /tmp/rs/attachment/$ID)" = "1000 600" ] || falha "dono/permissão restaurados diferentes"
echo "✔ restauração: 2 arquivos, SHA-256 idênticos, dono 1000 e modo 600"
estado > /tmp/depois
cat /tmp/antes; diff /tmp/antes /tmp/depois >/dev/null || falha "volume ou backups reais mudaram"
echo "✔ volume de arquivos e pasta de backups reais inalterados"
echo "✔ PROVA CONCLUÍDA (tudo ficou no /tmp deste contêiner temporário)"'

echo "Vai criar UM contêiner temporário do serviço backup (removido no fim), sem reiniciar nada e"
echo "sem gravar em volumes, banco ou backups reais."
printf '\nPara prosseguir, digite exatamente: %s\n> ' "$FRASE"
read -r r || true
[[ "$r" == "$FRASE" ]] || { echo "Cancelado. Nada foi alterado."; exit 1; }

REMOTO="set -e
C='sudo docker compose -f /opt/cenario/infra/homolog/docker-compose.homolog.yml --env-file /run/cenario/env'
\$C ps --format '{{.Name}} {{.ID}} {{.Status}}' | sort > /tmp/cenario-conteineres-antes
\$C run --rm --no-deps -T --entrypoint bash backup -c $(printf '%q' "$CARGA")
\$C ps --format '{{.Name}} {{.ID}} {{.Status}}' | sort > /tmp/cenario-conteineres-depois
sed 's/ Up .*//' /tmp/cenario-conteineres-antes > /tmp/a; sed 's/ Up .*//' /tmp/cenario-conteineres-depois > /tmp/b
diff /tmp/a /tmp/b >/dev/null && echo '✔ contêineres da pilha: mesmos ids, nenhum reiniciado' || { echo '✘ contêineres mudaram'; cat /tmp/a /tmp/b; exit 1; }
rm -f /tmp/cenario-conteineres-antes /tmp/cenario-conteineres-depois /tmp/a /tmp/b"

mkdir -p "$RELDIR"
g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" --command="$REMOTO" \
  | tee "$RELDIR/backup-arquivos-vm-$CARIMBO.txt"
echo "Registro: $RELDIR/backup-arquivos-vm-$CARIMBO.txt"
