#!/usr/bin/env bash
# Homologação LOCAL do Cenário Gestão (sem nuvem, sem deploy, só dados sintéticos).
#
#   bash scripts/homolog-local.sh preparar   # banco exclusivo, variáveis, migrations, seed, build
#   bash scripts/homolog-local.sh iniciar    # API (127.0.0.1:4200) e web (127.0.0.1:3200)
#   bash scripts/homolog-local.sh status
#   bash scripts/homolog-local.sh parar
#   bash scripts/homolog-local.sh apagar     # para e APAGA o banco e os arquivos de homologação
#
# Tudo fica em .homolog-local/ (ignorado pelo Git): variáveis com segredos gerados na hora,
# arquivos enviados, logs e PIDs. O banco é cenario_homolog_local no PostgreSQL local (o mesmo
# servidor do desenvolvimento, banco separado). Por padrão tudo escuta só em 127.0.0.1 — nada é
# exposto à rede. Acesso pelo iPhone na mesma Wi-Fi (só num computador seu, rede confiável):
#   HOMOLOG_BIND=<IP do computador na rede local> bash scripts/homolog-local.sh preparar
# (as variáveis são geradas uma vez: para mudar o endereço, apague .homolog-local/env antes).
# Mesmo assim a API continua em 127.0.0.1; só a web (que encaminha /api) fica na rede local.
# Detalhes e cuidados: docs/HOMOLOGACAO-LOCAL-RELATORIO.md, seção 9.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=.homolog-local
ENV_FILE="$DIR/env"
DB_NAME="${HOMOLOG_DB_NAME:-cenario_homolog_local}"
API_PORT="${HOMOLOG_API_PORT:-4200}"
WEB_PORT="${HOMOLOG_WEB_PORT:-3200}"
BIND="${HOMOLOG_BIND:-127.0.0.1}"

[[ "$DB_NAME" == *homolog* ]] || { echo "Recusado: o banco precisa ter 'homolog' no nome." >&2; exit 2; }

# URL do servidor PostgreSQL: a mesma credencial do DATABASE_URL do .env, com outro banco.
base_url() {
  local u="${HOMOLOG_PG_URL:-}"
  if [[ -z "$u" && -f .env ]]; then u="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"; fi
  [[ -n "$u" ]] || { echo "Defina HOMOLOG_PG_URL ou DATABASE_URL no .env." >&2; exit 2; }
  echo "${u%/*}"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || { echo "Rode primeiro: bash scripts/homolog-local.sh preparar" >&2; exit 2; }
  set -a; source "$ENV_FILE"; set +a
}

preparar() {
  mkdir -p "$DIR/storage" "$DIR/logs" "$DIR/backups"
  local server; server="$(base_url)"
  if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    cat > "$ENV_FILE" <<EOF
# Gerado por scripts/homolog-local.sh — homologação local. NÃO versionar.
APP_ENV=development
NODE_ENV=production
DATABASE_URL=$server/$DB_NAME
API_HOST=127.0.0.1
API_PORT=$API_PORT
ALLOWED_ORIGINS=http://$BIND:$WEB_PORT,http://127.0.0.1:$WEB_PORT,http://localhost:$WEB_PORT
COOKIE_SECURE=false
TOKEN_HASH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
LOG_LEVEL=info
STORAGE_DIR=$PWD/$DIR/storage
MAX_UPLOAD_MB=5
API_INTERNAL_URL=http://127.0.0.1:$API_PORT
SEED_ADMIN_EMAIL=gestor@homolog.local
SEED_ADMIN_PASSWORD=Homolog-$(openssl rand -hex 6)!
SEED_ADMIN_NAME="Gestor Homologação"
HOMOLOG_WEB_URL=http://$BIND:$WEB_PORT
EOF
    echo "✔ Variáveis geradas em $ENV_FILE"
  fi
  load_env
  if psql "$server/postgres" -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
    echo "• Banco $DB_NAME já existe (mantido)."
  else
    psql "$server/postgres" -qc "create database $DB_NAME"
    echo "✔ Banco $DB_NAME criado."
  fi
  pnpm --filter @cenario/db exec prisma migrate deploy
  pnpm --filter @cenario/db exec tsx src/seed.ts
  pnpm --filter @cenario/api build
  NEXT_DIST_DIR=.next-homolog pnpm --filter @cenario/web exec next build
  echo "✔ Pronto. Inicie com: bash scripts/homolog-local.sh iniciar"
}

iniciar() {
  load_env
  if [[ -f "$DIR/api.pid" ]] && kill -0 "$(cat "$DIR/api.pid")" 2>/dev/null; then
    echo "• Já está rodando."; status; return
  fi
  nohup node apps/api/dist/server.js > "$DIR/logs/api.log" 2>&1 &
  echo $! > "$DIR/api.pid"
  ( cd apps/web && NEXT_DIST_DIR=.next-homolog exec pnpm exec next start -H "$BIND" -p "$WEB_PORT" ) \
    > "$DIR/logs/web.log" 2>&1 &
  echo $! > "$DIR/web.pid"
  for _ in $(seq 1 60); do
    curl -fsS --noproxy '*' "http://127.0.0.1:$API_PORT/api/ready" >/dev/null 2>&1 \
      && curl -fsS --noproxy '*' -o /dev/null "$HOMOLOG_WEB_URL/entrar" 2>/dev/null && break
    sleep 1
  done
  status
}

status() {
  load_env
  for s in api web; do
    if [[ -f "$DIR/$s.pid" ]] && kill -0 "$(cat "$DIR/$s.pid")" 2>/dev/null; then
      echo "✔ $s rodando (pid $(cat "$DIR/$s.pid"))"
    else
      echo "✘ $s parado"
    fi
  done
  echo "  API:    $(curl -fsS --noproxy '*' "http://127.0.0.1:$API_PORT/api/ready" 2>/dev/null || echo indisponível)"
  echo "  Painel: $HOMOLOG_WEB_URL/painel   Tablet: $HOMOLOG_WEB_URL/tablet"
  echo "  Gestor: $SEED_ADMIN_EMAIL (senha em $ENV_FILE)"
}

parar() {
  for s in web api; do
    if [[ -f "$DIR/$s.pid" ]]; then
      local pid; pid="$(cat "$DIR/$s.pid")"
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      rm -f "$DIR/$s.pid"
    fi
  done
  echo "✔ Serviços parados."
}

apagar() {
  parar
  load_env
  psql "$(base_url)/postgres" -qc "drop database if exists $DB_NAME"
  rm -rf "$DIR"
  echo "✔ Banco $DB_NAME e $DIR apagados."
}

case "${1:-}" in
  preparar) preparar ;;
  iniciar) iniciar ;;
  status) status ;;
  parar) parar ;;
  apagar) apagar ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
