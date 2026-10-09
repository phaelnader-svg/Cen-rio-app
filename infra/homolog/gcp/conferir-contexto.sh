#!/usr/bin/env bash
# Confere, SEM custo e sem rede, se o envio ao Cloud Build levaria TODOS os arquivos versionados
# necessários ao build. Usa o próprio filtro do gcloud (gcloud meta list-files-for-upload, que
# aplica o .gcloudignore) e compara com "git ls-files". Ficam de fora só os excluídos de propósito
# (.gcloudignore e .github/). Saída 0 = completo · 1 = faltariam arquivos (lista impressa).
# Origem: o Cloud Build 436c51a7 falhou porque um padrão "storage" no .gcloudignore excluía
# apps/api/src/core/storage/.
set -euo pipefail
cd "$(dirname "$0")/../../.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
gcloud meta list-files-for-upload . 2>/dev/null | sort > "$T/envio"
[[ -s "$T/envio" ]] || { echo "✘ gcloud meta list-files-for-upload não listou nada"; exit 1; }
git -c core.quotePath=false ls-files | grep -vE '^(\.gcloudignore$|\.github/)' | sort > "$T/git"
comm -23 "$T/git" "$T/envio" > "$T/faltam"
if [[ -s "$T/faltam" ]]; then
  echo "✘ $(wc -l < "$T/faltam") arquivo(s) versionado(s) NÃO seriam enviados ao Cloud Build (revise o .gcloudignore):"
  sed 's/^/    /' "$T/faltam"
  exit 1
fi
echo "✔ contexto do Cloud Build completo: $(wc -l < "$T/git") arquivos versionados serão enviados ($(wc -l < "$T/envio") no total)"
