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
#   bash infra/homolog/gcp/ampliar-disco.sh diagnosticar # SÓ LEITURA: distribuição, gerenciador de
#                                                         # pacotes, growpart/resize2fs (PATH de root),
#                                                         # pacotes, simulação de instalação, apt em uso
#   bash infra/homolog/gcp/ampliar-disco.sh instalar-dependencias
#                                                         # SÓ COM AUTORIZAÇÃO: confirmação digitada →
#                                                         # apt-get update → instala SÓ cloud-guest-utils
#                                                         # (e2fsprogs já é essencial no Debian) se o plano
#                                                         # do apt for só pacote NOVO; nada é atualizado,
#                                                         # removido ou reiniciado; inventário igual
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

identificar() {
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
}

# Utilitários procurados com o PATH de root (sudo usa secure_path com /usr/sbin): resize2fs fica em
# /usr/sbin e não aparece no PATH de um usuário comum — a 1ª versão deste script dava falso "ausente".
FERRAMENTAS='for t in growpart resize2fs; do
  p=$(sudo sh -c "command -v $t" 2>/dev/null || true); echo "$t:${p:-ausente}"; done'

# Leitura das partições pelo kernel (somente leitura): /sys/block/sda/<parte>/start e /size, em
# setores de 512 bytes; fim = início + tamanho − 1. Mais a tabela (sfdisk -l) para o registro.
PARTICOES='set -e; d=/sys/block/sda
echo "disco $(cat $d/size)"
echo "tabela $(sudo blkid -o value -s PTTYPE /dev/sda 2>/dev/null || echo desconhecida)"
for p in $d/sda[0-9]*; do n=$(basename $p); s=$(cat $p/start); z=$(cat $p/size); echo "part $n $s $((s + z - 1)) $z"; done
sudo sfdisk -l /dev/sda 2>/dev/null | sed "s/^/sfdisk| /"'

# particoes_ok "<saída de PARTICOES>": imprime a tabela em ordem FÍSICA e exige que /dev/sda1 exista,
# comece depois do fim de TODAS as outras, sem sobreposição entre elas, e termine dentro do disco
# (em GPT, antes da cópia de segurança do cabeçalho: 33 setores finais). Nada é alterado.
particoes_ok() {
  local dados="$1"
  printf '%s\n' "$dados" | grep '^sfdisk| ' | sed 's/^sfdisk| /    /' > "$T/sfdisk-l.txt" || true
  printf '%s\n' "$dados" | awk '
    $1 == "disco" { disco = $2 }
    $1 == "tabela" { tabela = $2 }
    $1 == "part" { n++; nome[n] = $2; ini[n] = $3; fim[n] = $4; tam[n] = $5; if ($2 == "sda1") alvo = n }
    END {
      erro = 0
      if (!disco) { print "✘ tamanho do disco não lido"; exit 1 }
      if (!alvo) { print "✘ /dev/sda1 não encontrada"; exit 1 }
      if (tabela != "gpt" && tabela != "dos") { printf "✘ tipo de tabela de partições não reconhecido (%s)\n", tabela; exit 1 }
      # ordem física (início crescente)
      for (i = 1; i <= n; i++) ord[i] = i
      for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (ini[ord[j]] < ini[ord[i]]) { t = ord[i]; ord[i] = ord[j]; ord[j] = t }
      printf "  tabela %s · disco %d setores (%.1f GiB)\n", tabela, disco, disco * 512 / 1073741824
      printf "  %-6s %12s %12s %12s\n", "parte", "início", "fim", "MiB"
      for (k = 1; k <= n; k++) { i = ord[k]; printf "  %-6s %12d %12d %12.1f\n", nome[i], ini[i], fim[i], tam[i] * 512 / 1048576 }
      for (k = 2; k <= n; k++) if (ini[ord[k]] <= fim[ord[k - 1]]) { printf "✘ %s sobrepõe %s\n", nome[ord[k]], nome[ord[k - 1]]; erro = 1 }
      for (i = 1; i <= n; i++) if (i != alvo && fim[i] >= ini[alvo]) { printf "✘ %s (setores %d–%d) fica DEPOIS do início de sda1 (%d): ampliar sda1 não é seguro\n", nome[i], ini[i], fim[i], ini[alvo]; erro = 1 }
      reserva = (tabela == "gpt") ? 33 : 0
      if (fim[alvo] > disco - 1 - reserva) { printf "✘ sda1 termina em %d, além do limite utilizável (%d)\n", fim[alvo], disco - 1 - reserva; erro = 1 }
      if (erro) exit 1
      printf "✔ sda1 é fisicamente a última partição (outras terminam antes do setor %d); espaço livre depois dela: %d setores\n", ini[alvo], disco - 1 - reserva - fim[alvo]
    }'
}

conferir() {
  identificar
  echo; echo "== Dentro da VM (somente leitura)"
  ssh_vm "set -e; findmnt -no SOURCE,FSTYPE /; lsblk -bno NAME,SIZE,TYPE /dev/sda; df -B1 --output=size,avail / | tail -1; $FERRAMENTAS" > "$T/vm-fs.txt" \
    || pare "não consegui ler a VM por SSH"
  cat "$T/vm-fs.txt"
  grep -qx '/dev/sda1 ext4' "$T/vm-fs.txt" || pare "raiz não é /dev/sda1 ext4 (procedimento não se aplica)"
  grep -q '^resize2fs:/' "$T/vm-fs.txt" || pare "resize2fs ausente mesmo no PATH de root (pacote e2fsprogs) — rode 'diagnosticar'"
  grep -q '^growpart:/' "$T/vm-fs.txt" \
    || pare "growpart ausente (pacote cloud-guest-utils) — rode 'diagnosticar' e, com autorização, 'instalar-dependencias'"
  # sda1 precisa ser FISICAMENTE a última partição (pelos setores, não pelo número): nas imagens
  # Debian do GCE, sda14 (BIOS boot) e sda15 (EFI) ficam ANTES de sda1 no disco.
  particoes_ok "$(ssh_vm "$PARTICOES")" || pare "posicionamento das partições não permite ampliar /dev/sda1 com segurança"
  mkdir -p "$RELDIR"; cp "$T/sfdisk-l.txt" "$RELDIR/disco-particoes-$CARIMBO.txt"
  echo "  (tabela completa, sfdisk -l: $RELDIR/disco-particoes-$CARIMBO.txt)"
  ok "raiz /dev/sda1 ext4, fisicamente a última partição; growpart e resize2fs disponíveis"

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
  particoes_ok "$(ssh_vm "$PARTICOES")" > "$T/part-depois.txt" || { cat "$T/part-depois.txt"; pare "tabela de partições inesperada após a ampliação"; }
  cat "$T/part-depois.txt"

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

# SÓ LEITURA. Nada é instalado, atualizado ou reiniciado (apt-get -s = simulação; apt-cache só lê).
DIAGNOSTICO='set -u
echo "## sistema"; . /etc/os-release; echo "$PRETTY_NAME (ID=$ID VERSION_ID=${VERSION_ID:-?} CODENAME=${VERSION_CODENAME:-?})"; uname -r
echo "## gerenciador de pacotes"; for c in apt-get dpkg dnf yum zypper apk; do command -v $c >/dev/null 2>&1 && echo "$c: $(command -v $c)"; done
echo "## utilitarios (usuario x root)"; for t in growpart resize2fs sfdisk partx; do
  echo "$t: usuario=$(command -v $t 2>/dev/null || echo -) root=$(sudo sh -c "command -v $t" 2>/dev/null || echo -)"; done
echo "PATH do usuario: $PATH"
echo "## pacotes"; for p in cloud-guest-utils e2fsprogs fdisk util-linux needrestart unattended-upgrades; do
  dpkg-query -W -f="\${Package} \${Version} [\${Status}]\n" $p 2>/dev/null || echo "$p: nao instalado"; done
echo "## candidatos (listas atuais, sem atualizar)"; apt-cache policy cloud-guest-utils e2fsprogs 2>/dev/null | grep -E "^[a-z0-9]|Installed|Candidate"
echo "## fontes do apt"; grep -rhsE "^[[:space:]]*(deb |URIs:|Suites:)" /etc/apt/sources.list /etc/apt/sources.list.d/ | sort -u
echo "## listas do apt"; echo "arquivos Packages: $(ls /var/lib/apt/lists/ 2>/dev/null | grep -c _Packages)"; echo "mais recente: $(ls -l --time-style=+%F_%T /var/lib/apt/lists/*_Packages* 2>/dev/null | awk "{print \$6}" | sort | tail -1)"
echo "## simulacao (nao altera nada)"; apt-get -s -o Debug::NoLocking=1 install --no-install-recommends --no-upgrade cloud-guest-utils e2fsprogs 2>&1 | grep -E "^(Inst|Remv|Purg)|newly installed|upgraded,|^E:|already the newest" || true
echo "## dependencias declaradas"; apt-cache depends cloud-guest-utils 2>/dev/null | grep -E "Depends|PreDepends" || echo "(sem dados nas listas atuais)"
echo "## apt/dpkg em uso"; pgrep -a "apt|dpkg|unattended-upgr" || echo "nenhum"
echo "## reinicio pendente"; if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required; else echo "nao"; fi
echo "## acesso aos repositorios"; timeout 8 bash -c "exec 3<>/dev/tcp/deb.debian.org/443" 2>/dev/null && echo "deb.debian.org:443 alcancavel" || echo "deb.debian.org:443 INACESSIVEL"
echo "## espaco"; df -h / | tail -1'

diagnosticar() {
  identificar
  echo; echo "== Diagnóstico dentro da VM (somente leitura)"
  ssh_vm "$DIAGNOSTICO" | tee "$T/diag.txt" || pare "não consegui ler a VM por SSH"
  mkdir -p "$RELDIR"; cp "$T/diag.txt" "$RELDIR/disco-diagnostico-$CARIMBO.txt"
  echo; ok "diagnóstico gravado em $RELDIR/disco-diagnostico-$CARIMBO.txt (nada foi alterado)"
}

# Estado de cada contêiner (id e início): se mudar, algo foi reiniciado.
CONTEINERES='sudo docker ps -a --no-trunc --format "{{.ID}}" | sort | xargs -r sudo docker inspect -f "{{.Name}} {{.Id}} {{.State.Status}} {{.State.StartedAt}}"'

INSTALACAO='set -eu
APT="sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get -o DPkg::Lock::Timeout=180 -q"
. /etc/os-release; [ "$ID" = debian ] || { echo "DISTRIBUICAO_INESPERADA $ID"; exit 10; }
dpkg-query -W -f="\${Status}" e2fsprogs 2>/dev/null | grep -q "install ok installed" || { echo "E2FSPROGS_AUSENTE"; exit 12; }
if dpkg-query -W -f="\${Status}" cloud-guest-utils 2>/dev/null | grep -q "install ok installed"; then echo "JA_INSTALADO"; sudo sh -c "command -v growpart"; exit 0; fi
echo "→ apt-get update (só atualiza as listas de pacotes)"; $APT update
plano=$(apt-get -s install --no-install-recommends --no-upgrade cloud-guest-utils e2fsprogs)
echo "$plano" | grep -E "^(Inst|Remv|Purg)" || true
echo "$plano" | grep -qE "^(Remv|Purg)" && { echo "PLANO_REMOVE_PACOTES"; exit 13; }
echo "$plano" | grep -qE "^Inst [^ ]+ \[" && { echo "PLANO_ATUALIZA_PACOTES"; exit 13; }
echo "$plano" | grep -qE "^Inst cloud-guest-utils " || { echo "PLANO_SEM_CLOUD_GUEST_UTILS"; exit 13; }
n=$(echo "$plano" | grep -c "^Inst "); [ "$n" -le 3 ] || { echo "PLANO_GRANDE $n pacotes"; exit 14; }
echo "→ instalando $n pacote(s) novo(s), sem recomendados e sem atualizar nenhum"
$APT install -y --no-install-recommends --no-upgrade cloud-guest-utils e2fsprogs
echo "growpart: $(sudo sh -c "command -v growpart")"; echo "resize2fs: $(sudo sh -c "command -v resize2fs")"
dpkg-query -W -f="\${Package} \${Version} [\${Status}]\n" cloud-guest-utils e2fsprogs
echo "arquivos de servico/cron do pacote: $(dpkg -L cloud-guest-utils | grep -cE "/(systemd|init\.d|cron)" || true)"
if [ -f /var/run/reboot-required ]; then echo "REINICIO_PENDENTE: $(cat /var/run/reboot-required)"; else echo "sem reinicio pendente"; fi'

instalar_dependencias() {
  identificar
  echo; echo "== Situação atual (somente leitura)"
  ssh_vm "$FERRAMENTAS" | tee "$T/ferr.txt" || pare "não consegui ler a VM por SSH"
  if grep -q '^growpart:/' "$T/ferr.txt" && grep -q '^resize2fs:/' "$T/ferr.txt"; then
    ok "growpart e resize2fs já disponíveis (PATH de root): nada a instalar"; return 0
  fi
  ssh_vm "apt-get -s -o Debug::NoLocking=1 install --no-install-recommends --no-upgrade cloud-guest-utils e2fsprogs 2>&1 | grep -E '^(Inst|Remv|Purg)|upgraded,|^E:' || true" | tee "$T/plano-antes.txt"
  ssh_vm "$INVENTARIO" > "$T/inv-antes.txt" || pare "não consegui fazer o inventário"
  ssh_vm "$CONTEINERES" > "$T/cont-antes.txt" || pare "não consegui ler os contêineres"
  mkdir -p "$RELDIR"; cp "$T/inv-antes.txt" "$RELDIR/pacotes-inventario-antes-$CARIMBO.txt"
  ok "inventário e contêineres registrados ($(grep -c . "$T/cont-antes.txt") contêineres)"
  echo
  echo "Vai: apt-get update e instalar SOMENTE pacotes novos (cloud-guest-utils; e2fsprogs só se já"
  echo "instalado — nunca atualizado). Para sem instalar se o apt planejar atualizar ou remover algo."
  local frase="INSTALAR cloud-guest-utils NA $VM"
  printf '\nPara prosseguir, digite exatamente: %s\n> ' "$frase"
  local r; read -r r || true
  [[ "$r" == "$frase" ]] || { echo "Cancelado. Nada foi alterado."; exit 1; }

  local rc=0
  ssh_vm "$INSTALACAO" | tee "$T/instalacao.txt" || rc=$?
  cp "$T/instalacao.txt" "$RELDIR/pacotes-instalacao-$CARIMBO.txt"
  ((rc == 0)) || pare "instalação interrompida (código $rc; ver acima). Se o plano era inesperado, nada foi instalado"
  grep -q '^REINICIO_PENDENTE' "$T/instalacao.txt" && echo "⚠ o sistema marcou reinício pendente — NÃO reinicie sem nova autorização"

  ssh_vm "$INVENTARIO" > "$T/inv-depois.txt" || pare "não consegui refazer o inventário"
  ssh_vm "$CONTEINERES" > "$T/cont-depois.txt" || pare "não consegui reler os contêineres"
  diff <(grep -v '^cenario-' "$T/inv-antes.txt") <(grep -v '^cenario-' "$T/inv-depois.txt") \
    || pare "imagens, volumes ou contêineres mudaram (ver acima)"
  comm -23 <(grep '^cenario-' "$T/inv-antes.txt" | sort) <(grep '^cenario-' "$T/inv-depois.txt" | sort) | grep . \
    && pare "pasta de backup sumiu (ver acima)" || true
  diff "$T/cont-antes.txt" "$T/cont-depois.txt" || pare "algum contêiner foi reiniciado ou mudou (ver acima)"
  ok "inventário preservado e nenhum contêiner reiniciado"
  ssh_vm "$FERRAMENTAS"
  echo; echo "CONCLUÍDO. Próximo (só com autorização): bash infra/homolog/gcp/ampliar-disco.sh conferir"
}

case "${1:-}" in
  conferir) conferir ;;
  verificar) verificar ;;
  executar) executar "${2:-}" ;;
  diagnosticar) diagnosticar ;;
  instalar-dependencias) instalar_dependencias ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
