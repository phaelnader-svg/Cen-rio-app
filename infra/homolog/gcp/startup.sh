#!/usr/bin/env bash
# Script de partida da VM de homologação (Debian 12, Compute Engine). Roda como root a cada boot,
# via metadata "startup-script". Idempotente:
#   - instala Docker Engine + Compose (repositório oficial da Docker), uma única vez;
#   - cria 2 GB de swap (rede de segurança para a e2-small de 2 GB);
#   - instala os serviços systemd (pilha na partida e envio diário dos backups ao bucket);
#   - se os arquivos do sistema já estiverem em /opt/cenario, gera as variáveis a partir do
#     Secret Manager e sobe a pilha.
# Nenhum segredo é gravado em disco: as variáveis ficam em /run/cenario/env (memória).
set -euo pipefail
exec > >(logger -t cenario-startup) 2>&1

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

if ! swapon --show | grep -q /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  swapon /swapfile
  sysctl -w vm.swappiness=10 >/dev/null
fi

install -d -m 755 /opt/cenario
cat > /etc/systemd/system/cenario-homolog.service <<'EOF'
[Unit]
Description=Cenário Gestão — homologação (Docker Compose)
After=docker.service network-online.target
Requires=docker.service
ConditionPathExists=/opt/cenario/infra/homolog/gcp/vm.sh

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c '/opt/cenario/infra/homolog/gcp/vm.sh gerar-env && /opt/cenario/infra/homolog/gcp/vm.sh iniciar'
ExecStop=/opt/cenario/infra/homolog/gcp/vm.sh parar
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/cenario-backup-upload.service <<'EOF'
[Unit]
Description=Cenário Gestão — envio dos backups ao Cloud Storage
After=cenario-homolog.service

[Service]
Type=oneshot
ExecStart=/opt/cenario/infra/homolog/gcp/vm.sh enviar-backups
EOF
cat > /etc/systemd/system/cenario-backup-upload.timer <<'EOF'
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
systemctl start cenario-backup-upload.timer
if [[ -x /opt/cenario/infra/homolog/gcp/vm.sh ]]; then
  systemctl restart cenario-homolog.service
fi
