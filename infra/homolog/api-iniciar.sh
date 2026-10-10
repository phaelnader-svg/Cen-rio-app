#!/bin/sh
# Partida da API nas imagens de homologação (Evolução — pré-deploy).
#   MIGRATE_ON_START=1 (padrão da imagem; uso local): aplica as migrations pendentes e inicia.
#   MIGRATE_ON_START=0 (homologação, via docker-compose.homolog.yml): NÃO altera o banco. Só confere
#     o estado das migrations e RECUSA iniciar se houver pendente ou com falha — as migrations são
#     aplicadas explicitamente por "vm.sh migrar", depois do ponto de recuperação validado.
# "exec": o Node vira o processo principal e recebe o SIGTERM (encerramento seguro).
set -e
if [ "${MIGRATE_ON_START:-1}" = "1" ]; then
  pnpm db:migrate
elif ! pnpm --silent db:status > /tmp/migracoes.txt 2>&1; then
  echo "API NÃO iniciada: há migrations pendentes ou com falha (MIGRATE_ON_START=0)." >&2
  echo "Aplique-as com 'vm.sh migrar <etiqueta>' depois de 'vm.sh ponto-recuperacao'." >&2
  cat /tmp/migracoes.txt >&2
  exit 78
fi
exec node apps/api/dist/server.js
