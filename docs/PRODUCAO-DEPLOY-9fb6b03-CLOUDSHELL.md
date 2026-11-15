# Deploy 9fb6b03 (E1 + S1) — promoção das imagens no Cloud Shell

Autorização do dono: deploy em produção de `9fb6b032c3c2496204043baa15bc2fb55a6b5e01` (branch `claude/reformulacao-s1`), versão atual `696e3e9`, retorno `rollback_version 696e3e9`.

A produção não constrói imagens: recebe por digest exatamente as que rodaram na homologação (build `09a46bbd-98d0-4d06-915b-541d246c227d`, relatório `docs/HOMOLOGACAO-S1-DEPLOY-RELATORIO.md`).

| Imagem | Digest homologado |
|---|---|
| api | `sha256:723530c305ced018d90106930c0b9b0db441b389e3ec8bc282e0b4f41f717ef0` |
| web | `sha256:aec4622f844317e2b69d8844f77ef5f04d32269167104cf6f5b917d54fd90259` |

O bloco usa o mesmo `promover-imagens.sh` (árvore `9ff142e`) que promoveu a 696e3e9: o script recusa se o digest de origem divergir e nunca sobrescreve um destino existente com outro digest. Só a versão e os digests mudaram em relação ao bloco 2 de `docs/PRODUCAO-DEPLOY-696e3e9-CLOUDSHELL.md`.

```bash
(
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=cenariogestao
COMMIT=9ff142e274b1cc04953bbfb5161a7940962530d5
ARVORE="$HOME/cenario-deploy-9ff142e274b1"
CLONE=""
while IFS= read -r g; do
  d="$(dirname "$g")"
  if git -C "$d" remote get-url origin 2>/dev/null | grep -qi 'phaelnader-svg/cen-rio-app'; then CLONE="$d"; break; fi
done < <(find "$HOME" -maxdepth 4 -type d -name .git 2>/dev/null)
if [ -z "$CLONE" ]; then
  echo "• nenhum clone encontrado em $HOME: clonando em $HOME/cen-rio-app"
  git clone --no-checkout https://github.com/phaelnader-svg/cen-rio-app.git "$HOME/cen-rio-app"
  CLONE="$HOME/cen-rio-app"
fi
echo "• clone: $CLONE"
git -C "$CLONE" fetch origin claude/deploy-banco-limpo
git -C "$CLONE" merge-base --is-ancestor "$COMMIT" FETCH_HEAD || { echo "✘ $COMMIT não está em origin/claude/deploy-banco-limpo"; exit 1; }
if [ -e "$ARVORE" ]; then
  [ "$(git -C "$ARVORE" rev-parse HEAD)" = "$COMMIT" ] || { echo "✘ $ARVORE existe e não está em $COMMIT: nada feito"; exit 1; }
  [ -z "$(git -C "$ARVORE" status --porcelain)" ] || { echo "✘ $ARVORE tem alterações locais: nada feito"; exit 1; }
else
  git -C "$CLONE" worktree add --detach "$ARVORE" "$COMMIT"
fi
cd "$ARVORE"
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "✘ diretório de trabalho fora de $COMMIT"; exit 1; }
echo "• scripts: $(git rev-parse HEAD) em $ARVORE"
echo "• conta gcloud: $(gcloud config get-value account 2>/dev/null)"
VER=9fb6b032c3c2496204043baa15bc2fb55a6b5e01
D_API=sha256:723530c305ced018d90106930c0b9b0db441b389e3ec8bc282e0b4f41f717ef0
D_WEB=sha256:aec4622f844317e2b69d8844f77ef5f04d32269167104cf6f5b917d54fd90259
LOG="$HOME/cenario-promocao-9fb6b03.log"
OK=0
for t in 1 2 3 4 5; do
  echo "— tentativa $t/5 ($(date -u +%H:%M:%SZ))"
  if bash infra/prod/gcp/promover-imagens.sh "$VER" "$D_API" "$D_WEB" 2>&1 | tee "$LOG"; then OK=1; break; fi
  if grep -q "✘" "$LOG"; then echo "✘ promoção RECUSADA pelo script (veja acima): sem nova tentativa"; exit 1; fi
  echo "• falha de rede/transferência; nova tentativa em $((t * 30)) s"
  sleep $((t * 30))
done
[ "$OK" = 1 ] || { echo "✘ promoção não concluída em 5 tentativas"; exit 1; }
echo "— conferência no destino (cenario-prod):"
for par in "api $D_API" "web $D_WEB"; do
  set -- $par
  atual="$(gcloud artifacts docker images describe "southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod/$1:$VER" --format='value(image_summary.digest)')"
  if [ "$atual" = "$2" ]; then echo "✔ $1:$VER = $atual"; else echo "✘ $1:$VER = '${atual:-ausente}' (esperado $2)"; exit 1; fi
done
echo "PROMOÇÃO: OK"
)
```

Depois de "PROMOÇÃO: OK", o deploy segue pelas operações nomeadas (Claude, `CENARIO_AMBIENTE=prod`): `imagens` → `gate_open` → `prepare_version` → `migration_precheck` (0 pendentes) → `maintenance_on` → `recovery_point_create` → `backup_validate` → `migrate` (só registro) → `migration_verify` → `activate_version` → `gate_close` → `health`, `smoke_test`, `websocket_test`. Em falha: `rollback_version 696e3e9`.
