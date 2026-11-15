#!/usr/bin/env bash
# Pacote "/conheca ligada" (sobre o banco limpo 9ff142e274b1): prova que a ÚNICA mudança efetiva é
# SITE_COMERCIAL='1' no serviço web, igual ao Compose de 696e3e9 (commit 16d17f4).
#   A. Compose resolvido (docker compose config, valores fictícios): web ganha só SITE_COMERCIAL=1 e
#      continua com NODE_ENV=production; postgres (volume pgdata_2026_11), api, caddy, backup, redes e
#      volumes idênticos a BASE.
#   B. Repositório: entre BASE e HEAD, em infra/prod e scripts/{backup,restore}.sh, só mudam o Compose
#      e os testes do pacote; no Compose, só a linha SITE_COMERCIAL (além de comentários). O bloco
#      environment do web é idêntico ao de 696e3e9.
# BASE = pacote do banco limpo, em produção desde 14/11/2026 (padrão 9ff142e274b1).
# Executar: bash infra/prod/gcp/testes/test_conheca_ligada.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
BASE="${BASE:-9ff142e274b1cc04953bbfb5161a7940962530d5}"
REF_WEB="${REF_WEB:-696e3e9ddc5f1c803a4b9244a075ed498ad81be3}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FALHAS=0
igual() { if [[ "$1" == "$2" ]]; then echo "  ✔ $3: $1"; else echo "  ✘ $3: '$1' (esperado '$2')"; FALHAS=$((FALHAS + 1)); fi; }

cat > "$TMP/env" <<'ENV'
PROD_DOMAIN=cenariogestao.com.br
PROD_DOMAIN_WWW=www.cenariogestao.com.br
POSTGRES_PASSWORD=ficticio
TOKEN_HASH_SECRET=ficticio
SEED_ADMIN_EMAIL=gestor@exemplo.com
SEED_ADMIN_PASSWORD=ficticio
SEED_ADMIN_NAME=Gestor
CENARIO_API_IMAGE=registro/api:x
CENARIO_WEB_IMAGE=registro/web:x
ENV
config() { docker compose -p cenario-prod --project-directory "$RAIZ/infra/prod" -f "$1" --env-file "$TMP/env" config --format json; }
git -C "$RAIZ" show "$BASE:infra/prod/docker-compose.prod.yml" > "$TMP/base.yml"
config "$TMP/base.yml" > "$TMP/base.json"
config "$RAIZ/infra/prod/docker-compose.prod.yml" > "$TMP/novo.json"

echo "A. Compose resolvido"
python3 - "$TMP/base.json" "$TMP/novo.json" > "$TMP/a.out" <<'PY'
import json, sys
base, novo = (json.load(open(p)) for p in sys.argv[1:3])
eb, en = base["services"]["web"].get("environment", {}), novo["services"]["web"].get("environment", {})
print("base_site", eb.get("SITE_COMERCIAL"))
print("novo_site", en.get("SITE_COMERCIAL"))
print("node_env", en.get("NODE_ENV"))
print("env_extra", sorted(set(en) - set(eb)), sorted(set(eb) - set(en)),
      sorted(k for k in set(eb) & set(en) if eb[k] != en[k]))
for s in ("postgres", "api", "caddy", "backup"):
    print(s, "igual" if base["services"][s] == novo["services"][s] else "DIFERENTE")
b, n = json.loads(json.dumps(base)), json.loads(json.dumps(novo))
n["services"]["web"]["environment"].pop("SITE_COMERCIAL", None)
print("resto", "igual" if b == n else "DIFERENTE")
PY
sed 's/^/    /' "$TMP/a.out"
igual "$(grep '^base_site' "$TMP/a.out")" "base_site None" "BASE: web sem SITE_COMERCIAL (/conheca 404)"
igual "$(grep '^novo_site' "$TMP/a.out")" "novo_site 1" "web com SITE_COMERCIAL=1"
igual "$(grep '^node_env' "$TMP/a.out")" "node_env production" "web continua em NODE_ENV=production"
igual "$(grep '^env_extra' "$TMP/a.out")" "env_extra ['SITE_COMERCIAL'] [] []" "ambiente do web: só SITE_COMERCIAL acrescentada"
for s in postgres api caddy backup; do igual "$(grep "^$s " "$TMP/a.out")" "$s igual" "serviço $s sem mudança"; done
igual "$(grep '^resto' "$TMP/a.out")" "resto igual" "nenhuma outra diferença (redes, volumes, limites, imagens)"

echo "B. Repositório: arquivos alterados desde $BASE"
mudou="$(git -C "$RAIZ" diff --name-only "$BASE" HEAD -- infra/prod scripts/backup.sh scripts/restore.sh | sort | xargs)"
igual "$mudou" "infra/prod/docker-compose.prod.yml infra/prod/gcp/testes/test_conheca_ligada.sh infra/prod/gcp/testes/test_deploy_banco_limpo.sh" "arquivos do pacote alterados (Compose + testes)"
linhas="$(git -C "$RAIZ" diff "$BASE" HEAD -- infra/prod/docker-compose.prod.yml | grep -E '^[+-][^+-]' | grep -vE '^[+-]\s*#' | tr -s ' ' | paste -sd'|')"
igual "$linhas" "+ SITE_COMERCIAL: '1'" "linhas efetivas do Compose"
bloco() { sed -n '/^  web:/,/^  caddy:/p' | sed -n '/environment:/,/mem_limit:/p'; }
if diff <(git -C "$RAIZ" show "$REF_WEB:infra/prod/docker-compose.prod.yml" | bloco) <(bloco < "$RAIZ/infra/prod/docker-compose.prod.yml") >/dev/null; then
  echo "  ✔ environment do web idêntico ao de ${REF_WEB:0:12} (commit 16d17f4)"
else echo "  ✘ environment do web difere de ${REF_WEB:0:12}"; FALHAS=$((FALHAS + 1)); fi

echo
if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
