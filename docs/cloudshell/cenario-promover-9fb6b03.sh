#!/usr/bin/env bash
# Promoção das imagens homologadas de 9fb6b03 (E1 + S1) para o registro de produção.
# Só lê cenario-homolog e etiqueta em cenario-prod; não toca VM, banco, portão, IAM ou segredos.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=cenariogestao
REPO_URL="https://github.com/phaelnader-svg/cen-rio-app.git"
COMMIT="9ff142e274b1cc04953bbfb5161a7940962530d5"
SCRIPT_SHA256="537a0137b8b8a1b0f42a290624c02f9bbb3424337c7cf63a3a1dd77235448d31"
VER="9fb6b032c3c2496204043baa15bc2fb55a6b5e01"
D_API="sha256:723530c305ced018d90106930c0b9b0db441b389e3ec8bc282e0b4f41f717ef0"
D_WEB="sha256:aec4622f844317e2b69d8844f77ef5f04d32269167104cf6f5b917d54fd90259"
DESTINO="southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod"
ARVORE="$HOME/cenario-deploy-9ff142e274b1"
LOG="$HOME/cenario-promocao-9fb6b03.log"

falha() { echo "✘ $*"; echo "PROMOÇÃO: NÃO CONCLUÍDA"; exit 1; }

CLONE=""
while IFS= read -r g; do
  d="$(dirname "$g")"
  if git -C "$d" remote get-url origin 2>/dev/null | grep -qi 'phaelnader-svg/cen-rio-app'; then
    CLONE="$d"
    break
  fi
done < <(find "$HOME" -maxdepth 4 -type d -name .git 2>/dev/null)
if [ -z "$CLONE" ]; then
  echo "• nenhum clone encontrado em $HOME: clonando em $HOME/cen-rio-app"
  git clone --no-checkout "$REPO_URL" "$HOME/cen-rio-app"
  CLONE="$HOME/cen-rio-app"
fi
echo "• clone: $CLONE"

git -C "$CLONE" fetch origin claude/deploy-banco-limpo
git -C "$CLONE" merge-base --is-ancestor "$COMMIT" FETCH_HEAD || falha "$COMMIT não está em origin/claude/deploy-banco-limpo"

if [ -e "$ARVORE" ]; then
  [ "$(git -C "$ARVORE" rev-parse HEAD)" = "$COMMIT" ] || falha "$ARVORE existe e não está em $COMMIT: nada feito"
  [ -z "$(git -C "$ARVORE" status --porcelain)" ] || falha "$ARVORE tem alterações locais: nada feito"
else
  git -C "$CLONE" worktree add --detach "$ARVORE" "$COMMIT"
fi
cd "$ARVORE"
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || falha "diretório de trabalho fora de $COMMIT"
echo "$SCRIPT_SHA256  infra/prod/gcp/promover-imagens.sh" | sha256sum -c - || falha "promover-imagens.sh diferente do auditado: nada feito"
bash -n infra/prod/gcp/promover-imagens.sh || falha "promover-imagens.sh com erro de sintaxe: nada feito"
echo "• scripts: $(git rev-parse HEAD) em $ARVORE"
echo "• conta gcloud: $(gcloud config get-value account 2>/dev/null)"
echo "• versão: $VER"
echo "• api: $D_API"
echo "• web: $D_WEB"

# Repetição segura: uma imagem já promovida com o MESMO digest é só confirmada; com outro digest, recusa.
OK=0
for t in 1 2 3 4 5; do
  echo "— tentativa $t/5 ($(date -u +%H:%M:%SZ))"
  if bash infra/prod/gcp/promover-imagens.sh "$VER" "$D_API" "$D_WEB" 2>&1 | tee "$LOG"; then
    OK=1
    break
  fi
  if grep -q "✘" "$LOG"; then
    falha "promoção RECUSADA pelo script (veja acima): sem nova tentativa"
  fi
  echo "• falha de rede/transferência; nova tentativa em $((t * 30)) s"
  sleep $((t * 30))
done
[ "$OK" = 1 ] || falha "promoção não concluída em 5 tentativas (pode repetir este comando com segurança)"

echo "— conferência no destino (cenario-prod):"
for par in "api $D_API" "web $D_WEB"; do
  set -- $par
  atual="$(gcloud artifacts docker images describe "$DESTINO/$1:$VER" --format='value(image_summary.digest)' 2>/dev/null || true)"
  if [ "$atual" = "$2" ]; then
    echo "✔ $1:$VER = $atual"
  else
    falha "$1:$VER = '${atual:-ausente}' (esperado $2)"
  fi
done
echo "PROMOÇÃO: OK"
