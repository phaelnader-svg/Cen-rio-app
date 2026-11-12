#!/usr/bin/env bash
# Homologação — ampliação do disco da VM cenario-homolog de 20 GB para 30 GB, SEM reinício e SEM
# parar a aplicação. Executar no Cloud Shell, na raiz do repositório, com a chave SSH no ssh-agent
# (ver ssh-agente.sh). Só HOMOLOGAÇÃO: os identificadores esperados estão fixos abaixo e qualquer
# diferença para o script antes de alterar algo.
#
#   bash infra/homolog/gcp/ampliar-disco.sh conferir     # SÓ LEITURA: identifica VM/disco, produção à
#                                                         # parte, sistema de arquivos e inventário
#   bash infra/homolog/gcp/ampliar-disco.sh executar     # conferir → confirmação digitada → snapshot
#                                                         # do disco → resize 30 GB → growpart +
#                                                         # resize2fs (online) → verificação
#   bash infra/homolog/gcp/ampliar-disco.sh executar --sem-snapshot   # idem, sem o snapshot prévio
#   bash infra/homolog/gcp/ampliar-disco.sh verificar    # SÓ LEITURA: tamanho do disco, partição,
#                                                         # sistema de arquivos e inventário
#
# Garantias: nunca reinicia a VM nem os contêineres; nunca remove imagem, volume, backup ou
# snapshot; nunca toca a VM ou o disco de produção (outra zona, outro nome — conferidos); para no
# primeiro resultado inesperado. Aumentar um disco é IRREVERSÍVEL (o Google Cloud não reduz discos).
# O inventário (imagens, volumes, contêineres e pastas de backup) é gravado antes e comparado depois.
set -euo pipefail
cd "$(dirname "$0")/../../.."
# shellcheck source=ssh-agente.sh
source infra/homolog/gcp/ssh-agente.sh

PROJECT=cenariogestao
ZONE=us-east1-b
VM=cenario-homolog
VM_ID=5606039017119619228
DISK=cenario-homolog
DISK_ID=4754767015764629660
DISK_TYPE=pd-balanced
SIZE_ATUAL=20
SIZE_NOVO=30
PROD_ZONE=southamerica-east1-b
FRASE="AMPLIAR $DISK PARA $SIZE_NOVO GB"
RELDIR="${CENARIO_RELATORIOS:-$HOME/cenario-homolog-relatorios}"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

g() { gcloud --project="$PROJECT" "$@"; }
pare() { echo "✘ $* — NADA mais será feito."; exit 1; }
ok() { echo "✔ $*"; }
ssh_vm() {
  conferir_chave_ssh || exit 1
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --quiet "${SSH_SEM_PERGUNTA[@]}" --command="$1"
}

# Inventário que NÃO pode mudar com a ampliação (sem tamanhos/datas de uso).
INVENTARIO='set -e
echo "## imagens"; sudo docker image ls --no-trunc --format "{{.Repository}}:{{.Tag}} {{.ID}}" | sort
echo "## volumes"; sudo docker volume ls --format "{{.Name}}" | sort
echo "## conteineres"; sudo docker ps -a --no-trunc --format "{{.Names}} {{.Image}} {{.ID}}" | sort
echo "## backups"; sudo docker compose -f /opt/cenario/infra/homolog/docker-compose.homolog.yml --env-file /run/cenario/env exec -T backup ls -1 /data/backups | sort'

conferir() {
  local conta; conta="$(gcloud config get-value account 2>/dev/null || true)"
  [[ -n "$conta" ]] || pare "nenhuma conta no gcloud (gcloud auth login)"
  echo "Conta: $conta · Projeto: $PROJECT · Zona: $ZONE"

  g compute instances describe "$VM" --zone="$ZONE" --format=json > "$T/vm.json" || pare "VM $VM não encontrada em $ZONE"
  [[ "$(jq -r .id "$T/vm.json")" == "$VM_ID" ]] || pare "id da VM $(jq -r .id "$T/vm.json") ≠ $VM_ID esperado"
  [[ "$(jq -r .status "$T/vm.json")" == RUNNING ]] || pare "VM não está RUNNING"
  [[ "$(jq -r '[.disks[] | select(.boot)][0].source | split("/") | last' "$T/vm.json")" == "$DISK" ]] \
    || pare "o disco de inicialização da VM não é $DISK"
  [[ "$(jq '.disks | length' "$T/vm.json")" == 1 ]] || pare "a VM tem mais de um disco (inesperado)"
  ok "VM $VM (id $VM_ID) em $ZONE, RUNNING, disco de inicialização $DISK"

  g compute disks describe "$DISK" --zone="$ZONE" --format=json > "$T/disco.json" || pare "disco $DISK não encontrado"
  [[ "$(jq -r .id "$T/disco.json")" == "$DISK_ID" ]] || pare "id do disco ≠ $DISK_ID"
  [[ "$(jq -r '.type | split("/") | last' "$T/disco.json")" == "$DISK_TYPE" ]] || pare "tipo do disco ≠ $DISK_TYPE"
  [[ "$(jq -r '.users | length' "$T/disco.json")" == 1 && "$(jq -r '.users[0] | split("/") | last' "$T/disco.json")" == "$VM" ]] \
    || pare "o disco não está anexado só à VM $VM"
  local tam; tam="$(jq -r .sizeGb "$T/disco.json")"
  ok "disco $DISK (id $DISK_ID), $DISK_TYPE, ${tam} GB, anexado só a $VM"
  echo "$tam" > "$T/tamanho"

  # Produção: outra zona, outro disco; nunca referenciada pelos comandos deste script.
  [[ "$ZONE" != "$PROD_ZONE" && "$VM" != *prod* && "$DISK" != *prod* ]] || pare "alvo parece ser de produção"
  ok "produção (cenario-prod, $PROD_ZONE) não é alvo de nenhum comando"

  echo; echo "== Dentro da VM (somente leitura)"
  ssh_vm 'set -e; findmnt -no SOURCE,FSTYPE /; lsblk -bno NAME,SIZE,TYPE /dev/sda; df -B1 --output=size,avail / | tail -1;
          command -v growpart >/dev/null && echo growpart:ok || echo growpart:ausente;
          command -v resize2fs >/dev/null && echo resize2fs:ok || echo resize2fs:ausente' > "$T/vm-fs.txt" \
    || pare "não consegui ler a VM por SSH"
  cat "$T/vm-fs.txt"
  grep -qx '/dev/sda1 ext4' "$T/vm-fs.txt" || pare "raiz não é /dev/sda1 ext4 (procedimento não se aplica)"
  grep -q '^growpart:ok' "$T/vm-fs.txt" || pare "growpart ausente na VM (pacote cloud-guest-utils)"
  grep -q '^resize2fs:ok' "$T/vm-fs.txt" || pare "resize2fs ausente na VM"
  # sda1 precisa ser a ÚLTIMA partição do disco (layout das imagens Debian do GCE).
  ssh_vm "sudo sfdisk -d /dev/sda | awk '/^\\/dev\\/sda[0-9]+ :/ {split(\$4,a,\"=\"); gsub(/[ ,]/,\"\",a[2]); print a[2], \$1}' | sort -n | tail -1" > "$T/ultima.txt" \
    || pare "não consegui ler a tabela de partições"
  grep -q '/dev/sda1$' "$T/ultima.txt" || pare "/dev/sda1 não é a última partição: $(cat "$T/ultima.txt")"
  ok "raiz /dev/sda1 ext4, última partição; growpart e resize2fs disponíveis"

  ssh_vm "$INVENTARIO" > "$T/inventario-antes.txt" || pare "não consegui fazer o inventário"
  mkdir -p "$RELDIR"; cp "$T/inventario-antes.txt" "$RELDIR/disco-inventario-antes-$CARIMBO.txt"
  ok "inventário: $(grep -c . "$T/inventario-antes.txt") linhas (imagens, volumes, contêineres, backups) → $RELDIR"
}

verificar() {
  local tam; tam="$(g compute disks describe "$DISK" --zone="$ZONE" --format='value(sizeGb)')"
  echo "disco $DISK: ${tam} GB"
  ssh_vm 'set -e; lsblk -bno NAME,SIZE /dev/sda; df -h /; sudo docker ps --format "{{.Names}} {{.Status}}"'
}

executar() {
  local snapshot=1; [[ "${1:-}" == --sem-snapshot ]] && snapshot=0
  conferir
  [[ "$(cat "$T/tamanho")" == "$SIZE_ATUAL" ]] || pare "disco com $(cat "$T/tamanho") GB (esperado $SIZE_ATUAL)"
  echo
  echo "Vai: $( ((snapshot)) && echo "1) snapshot do disco; ")2) aumentar $DISK de $SIZE_ATUAL para $SIZE_NOVO GB (online,"
  echo "IRREVERSÍVEL); 3) growpart /dev/sda 1 + resize2fs /dev/sda1 (online). Sem reiniciar nada."
  printf '\nPara prosseguir, digite exatamente: %s\n> ' "$FRASE"
  local r; read -r r || true
  [[ "$r" == "$FRASE" ]] || { echo "Cancelado. Nada foi alterado."; exit 1; }

  if ((snapshot)); then
    local nome="cenario-homolog-antes-${SIZE_NOVO}gb-$(date -u +%Y%m%d%H%M)"
    echo "→ snapshot $nome (o disco continua em uso; consistente como numa queda de energia; o backup"
    echo "  da aplicação já é diário)…"
    g compute snapshots create "$nome" --source-disk="$DISK" --source-disk-zone="$ZONE" \
      --storage-location=us-east1 --description="Antes da ampliação para ${SIZE_NOVO} GB" --quiet \
      || pare "snapshot falhou (o disco NÃO foi alterado)"
    [[ "$(g compute snapshots describe "$nome" --format='value(status)')" == READY ]] || pare "snapshot não ficou READY"
    ok "snapshot $nome READY"
  fi

  echo "→ aumentando o disco para $SIZE_NOVO GB…"
  g compute disks resize "$DISK" --zone="$ZONE" --size="$SIZE_NOVO" --quiet || pare "resize do disco falhou"
  [[ "$(g compute disks describe "$DISK" --zone="$ZONE" --format='value(sizeGb)')" == "$SIZE_NOVO" ]] \
    || pare "o disco não ficou com $SIZE_NOVO GB"
  ok "disco com $SIZE_NOVO GB"

  echo "→ ampliando a partição e o sistema de arquivos (online)…"
  ssh_vm 'set -e
    for i in $(seq 1 12); do
      [ "$(lsblk -bno SIZE -d /dev/sda)" -ge '"$((SIZE_NOVO * 1073741824))"' ] && break; sleep 5
    done
    out=$(sudo growpart /dev/sda 1 2>&1) || { echo "$out" | grep -q NOCHANGE || { echo "$out"; exit 11; }; }
    echo "$out"
    sudo resize2fs /dev/sda1
    df -B1 --output=size,avail / | tail -1' > "$T/amplia.txt" || { cat "$T/amplia.txt"; pare "growpart/resize2fs falhou (o disco já tem $SIZE_NOVO GB; dados intactos; sem reinício)"; }
  cat "$T/amplia.txt"
  local tam_fs; tam_fs="$(tail -1 "$T/amplia.txt" | awk '{print $1}')"
  (( tam_fs >= (SIZE_NOVO - 1) * 1000000000 )) || pare "sistema de arquivos com $tam_fs bytes (esperado ~$SIZE_NOVO GB)"
  ok "sistema de arquivos ampliado"

  ssh_vm "$INVENTARIO" > "$T/inventario-depois.txt" || pare "não consegui refazer o inventário"
  cp "$T/inventario-depois.txt" "$RELDIR/disco-inventario-depois-$CARIMBO.txt"
  # Backups novos podem surgir (rotina diária às 17:14 UTC); nenhum pode sumir.
  diff <(grep -v '^cenario-' "$T/inventario-antes.txt") <(grep -v '^cenario-' "$T/inventario-depois.txt") \
    || pare "imagens, volumes ou contêineres mudaram (ver acima)"
  comm -23 <(grep '^cenario-' "$T/inventario-antes.txt" | sort) <(grep '^cenario-' "$T/inventario-depois.txt" | sort) | grep . \
    && pare "pasta de backup sumiu (ver acima)" || true
  ok "inventário preservado: mesmas imagens, volumes, contêineres e backups"
  verificar
  echo; echo "CONCLUÍDO. Relatórios em $RELDIR."
}

case "${1:-}" in
  conferir) conferir ;;
  verificar) verificar ;;
  executar) executar "${2:-}" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
