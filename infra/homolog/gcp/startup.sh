#!/usr/bin/env bash
# Preparação da VM de homologação (Debian 12, Compute Engine), como root. Executado pelo
# "homolog.sh preparar-vm" (via IAP) e seguro para rodar de novo a qualquer momento. Idempotente:
#   - Docker Engine + Compose: instala SÓ se ausentes (na VM atual já existem: nada é alterado);
#   - swap: cria /swapfile de 2 GB SÓ se não houver NENHUMA swap ativa nem declarada no /etc/fstab
#     (a VM atual já tem 2 GB: nada é alterado);
#   - atualizações automáticas de segurança (unattended-upgrades): instala/ativa se ausentes;
#   - serviços systemd da pilha e do envio diário dos backups, COM PORTÃO DE PUBLICAÇÃO: só rodam
#     se existir /etc/cenario/publicacao-autorizada. Este script NUNCA cria esse arquivo e NUNCA
#     inicia a pilha sem ele (nem PostgreSQL, nem migrations, nem portas 80/443).
# Nenhum segredo é lido nem gravado aqui.
# CENARIO_RAIZ (só nos testes) prefixa os caminhos do sistema, para executar sem tocar na máquina.
set -euo pipefail
R="${CENARIO_RAIZ:-}"
PORTAO=/etc/cenario/publicacao-autorizada
exec > >(tee >(logger -t cenario-startup)) 2>&1

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker/Compose ausentes: instalando do repositório oficial da Docker"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d "$R/etc/apt/keyrings"
  curl -fsSL https://download.docker.com/linux/debian/gpg -o "$R/etc/apt/keyrings/docker.asc"
  chmod a+r "$R/etc/apt/keyrings/docker.asc"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > "$R/etc/apt/sources.list.d/docker.list"
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  echo "Docker $(docker --version | cut -d' ' -f3 | tr -d ,) e Compose $(docker compose version --short) já instalados: mantidos"
fi

# Swap: qualquer swap ativa (arquivo ou partição, com qualquer nome) já basta.
if [[ -n "$(swapon --show --noheadings 2>/dev/null)" ]]; then
  echo "swap já ativa: $(swapon --show=NAME,SIZE --noheadings | xargs): mantida"
elif grep -qE '^[^#[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]' "$R/etc/fstab" 2>/dev/null; then
  echo "swap declarada no /etc/fstab mas inativa: ativando (swapon -a)"
  swapon -a
else
  echo "sem swap: criando /swapfile de 2 GB"
  fallocate -l 2G "$R/swapfile" && chmod 600 "$R/swapfile" && mkswap "$R/swapfile"
  echo '/swapfile none swap sw 0 0' >> "$R/etc/fstab"
  swapon "$R/swapfile"
fi
if [[ ! -f "$R/etc/sysctl.d/90-cenario-swap.conf" ]]; then
  echo 'vm.swappiness=10' > "$R/etc/sysctl.d/90-cenario-swap.conf"
  sysctl -q -w vm.swappiness=10 || true
fi

# Atualizações automáticas de segurança (Debian security), sem reinício automático.
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  apt-get update && apt-get install -y unattended-upgrades
fi
if [[ ! -f "$R/etc/apt/apt.conf.d/20auto-upgrades" ]] || ! grep -q 'Unattended-Upgrade "1"' "$R/etc/apt/apt.conf.d/20auto-upgrades"; then
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > "$R/etc/apt/apt.conf.d/20auto-upgrades"
fi

install -d -m 755 "$R/opt/cenario" "$R/etc/cenario"
cat > "$R/etc/systemd/system/cenario-homolog.service" <<EOF
[Unit]
Description=Cenário Gestão — homologação (Docker Compose)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
ConditionPathExists=/opt/cenario/infra/homolog/gcp/vm.sh
# Portão: sem a autorização explícita do operador, o serviço não faz nada (nem no boot).
ConditionPathExists=$PORTAO

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '/opt/cenario/infra/homolog/gcp/vm.sh gerar-env && /opt/cenario/infra/homolog/gcp/vm.sh iniciar'
ExecStop=/opt/cenario/infra/homolog/gcp/vm.sh parar
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
cat > "$R/etc/systemd/system/cenario-backup-upload.service" <<EOF
[Unit]
Description=Cenário Gestão — envio dos backups ao Cloud Storage
After=cenario-homolog.service
ConditionPathExists=$PORTAO

[Service]
Type=oneshot
ExecStart=/opt/cenario/infra/homolog/gcp/vm.sh enviar-backups
EOF
cat > "$R/etc/systemd/system/cenario-backup-upload.timer" <<'EOF'
[Unit]
Description=Envio diário dos backups da homologação

[Timer]
OnCalendar=*-*-* 07:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable cenario-homolog.service cenario-backup-upload.timer
systemctl start cenario-backup-upload.timer # o serviço que ele aciona respeita o portão

if [[ -f "$R$PORTAO" && -x "$R/opt/cenario/infra/homolog/gcp/vm.sh" ]]; then
  echo "publicação autorizada ($PORTAO): (re)iniciando a pilha"
  systemctl restart cenario-homolog.service
else
  echo "publicação NÃO autorizada ($PORTAO ausente): nada foi iniciado"
fi
