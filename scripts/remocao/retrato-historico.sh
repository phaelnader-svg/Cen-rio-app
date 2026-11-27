#!/usr/bin/env bash
# Retrato de integridade histórica — SOMENTE LEITURA (transação READ ONLY; nada é gravado no banco).
# Uso: DATABASE_URL=postgresql://… bash scripts/remocao/retrato-historico.sh <arquivo-de-saida>
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL (banco isolado ou leitura autorizada)}"
SAIDA="${1:?arquivo de saída}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
psql "$DATABASE_URL" -X -q -At -F'|' -v ON_ERROR_STOP=1 -f "$AQUI/retrato-historico.sql" | LC_ALL=C sort > "$SAIDA"
echo "retrato: $(wc -l < "$SAIDA") medidas · $(grep -c '^contagem|' "$SAIDA") tabelas · $(grep -c '^orfaos|' "$SAIDA") FKs verificadas → $SAIDA"
