#!/usr/bin/env bash
# Pacote do DEPLOY COM BANCO LIMPO (696e3e9): prova que a ÚNICA mudança efetiva em relação aos
# scripts anteriores é o volume do PostgreSQL (pgdata → pgdata_2026_11), sem apagar nada.
#   A. Compose resolvido (docker compose config, valores fictícios): o PostgreSQL monta pgdata_2026_11;
#      pgdata continua declarado (preservado); storage, backups e caddy_data iguais; /conheca desligada
#      (web sem SITE_COMERCIAL); nenhuma outra diferença entre a configuração resolvida de BASE e a atual.
#   B. Repositório: entre BASE e HEAD, em infra/prod e scripts/{backup,restore}.sh, só mudam o Compose
#      e os 2 testes do pacote (este e o ensaio-deploy-banco-limpo.sh).
# BASE = commit dos scripts da correção do envio de backups (padrão 2f078850696c).
# Executar: bash infra/prod/gcp/testes/test_deploy_banco_limpo.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../.." && pwd)"
BASE="${BASE:-2f078850696c73854483b9f5f9ba1e88a6c4ea0d}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
FALHAS=0
igual() { if [[ "$1" == "$2" ]]; then echo "  ✔ $3: $1"; else echo "  ✘ $3: '$1' (esperado '$2')"; FALHAS=$((FALHAS + 1)); fi; }

cat > "$TMP/env" <<'EOF'
PROD_DOMAIN=cenariogestao.com.br
PROD_DOMAIN_WWW=www.cenariogestao.com.br
POSTGRES_PASSWORD=ficticio
TOKEN_HASH_SECRET=ficticio
SEED_ADMIN_EMAIL=gestor@exemplo.com
SEED_ADMIN_PASSWORD=ficticio
SEED_ADMIN_NAME=Gestor
CENARIO_API_IMAGE=registro/api:x
CENARIO_WEB_IMAGE=registro/web:x
EOF
config() { docker compose -p cenario-prod --project-directory "$RAIZ/infra/prod" -f "$1" --env-file "$TMP/env" config --format json; }
git -C "$RAIZ" show "$BASE:infra/prod/docker-compose.prod.yml" > "$TMP/base.yml"
config "$TMP/base.yml" > "$TMP/base.json"
config "$RAIZ/infra/prod/docker-compose.prod.yml" > "$TMP/novo.json"

echo "A. Compose resolvido"
python3 - "$TMP/base.json" "$TMP/novo.json" > "$TMP/a.out" <<'PY'
import json, sys
base, novo = (json.load(open(p)) for p in sys.argv[1:3])
def montagens(c, s): return [(v.get("source"), v.get("target")) for v in c["services"][s].get("volumes", [])]
print("postgres", montagens(novo, "postgres"))
print("volumes", " ".join(sorted(novo["volumes"])))
print("nomes", " ".join(sorted(v.get("name", k) for k, v in novo["volumes"].items())))
for s in ("api", "web", "caddy", "backup"):
    print(s, "igual" if base["services"][s] == novo["services"][s] else "DIFERENTE")
print("SITE_COMERCIAL", "SITE_COMERCIAL" in json.dumps(novo["services"]["web"].get("environment", {})))
# Diferença total, exceto o que é esperado mudar:
b, n = json.loads(json.dumps(base)), json.loads(json.dumps(novo))
b["services"]["postgres"].pop("volumes"); n["services"]["postgres"].pop("volumes")
n["volumes"].pop("pgdata_2026_11", None); b["volumes"].pop("pgdata", None)
print("resto", "igual" if b == n else "DIFERENTE")
PY
cat "$TMP/a.out" | sed 's/^/    /'
igual "$(grep '^postgres' "$TMP/a.out")" "postgres [('pgdata_2026_11', '/var/lib/postgresql/data')]" "PostgreSQL monta só o volume novo"
igual "$(grep '^volumes' "$TMP/a.out")" "volumes backups caddy_data pgdata_2026_11 storage" "volumes em uso"
igual "$(grep '^nomes' "$TMP/a.out")" "nomes cenario-prod_backups cenario-prod_caddy_data cenario-prod_pgdata_2026_11 cenario-prod_storage" "nomes reais dos volumes em uso"
# O Compose omite da configuração resolvida os volumes declarados e não usados: "pgdata" continua
# DECLARADO no arquivo, e o Compose nunca apaga volume sem "down -v" ou "volume rm".
igual "$(awk '/^volumes:/{v=1;next} v&&/^[^ ]/{v=0} v' "$RAIZ/infra/prod/docker-compose.prod.yml" | sed 's/ *#.*//' | tr -d ' :' | xargs)" \
  "pgdata pgdata_2026_11 storage backups caddy_data" "volumes declarados no arquivo (pgdata preservado)"
if grep -qE 'volume rm|down -v|--volumes' "$RAIZ/infra/prod/gcp/vm.sh"; then echo "  ✘ vm.sh remove volumes"; FALHAS=$((FALHAS + 1)); else echo "  ✔ vm.sh nunca remove volumes (sem 'volume rm', 'down -v', '--volumes')"; fi
for s in api web caddy backup; do igual "$(grep "^$s " "$TMP/a.out")" "$s igual" "serviço $s sem mudança"; done
igual "$(grep '^SITE_COMERCIAL' "$TMP/a.out")" "SITE_COMERCIAL False" "/conheca desligada (web sem SITE_COMERCIAL)"
igual "$(grep '^resto' "$TMP/a.out")" "resto igual" "nenhuma outra diferença na configuração resolvida"

echo "B. Repositório: arquivos alterados desde $BASE"
mudou="$(git -C "$RAIZ" diff --name-only "$BASE" HEAD -- infra/prod scripts/backup.sh scripts/restore.sh | sort | xargs)"
igual "$mudou" "infra/prod/docker-compose.prod.yml infra/prod/gcp/testes/ensaio-deploy-banco-limpo.sh infra/prod/gcp/testes/test_deploy_banco_limpo.sh" "arquivos do pacote alterados (Compose + 2 testes)"
linhas="$(git -C "$RAIZ" diff "$BASE" HEAD -- infra/prod/docker-compose.prod.yml | grep -E '^[+-][^+-]' | grep -vE '^[+-]\s*#' | sed 's/ *#.*//' | xargs)"
igual "$linhas" "- - pgdata:/var/lib/postgresql/data + - pgdata_2026_11:/var/lib/postgresql/data - pgdata: + pgdata: + pgdata_2026_11:" "linhas efetivas do Compose"

echo
if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
