# Deploy 696e3e9 — blocos do Cloud Shell (seção 6.1 do checklist), revisão 2

Revisão: URL Git original (`https://github.com/phaelnader-svg/cen-rio-app.git`); SHA-256 diferente da referência = erro fatal antes do upload; nada é enviado se qualquer verificação falhar (inclusive conflito em qualquer um dos dois objetos). Testado nesta sessão com um `gcloud` simulado: divergência de SHA (0 objetos publicados), caminho normal, reexecução, e `.sha256` conflitante no bucket (`.tar.gz` não publicado).

## Bloco 1

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
echo "• versão: $(git rev-parse HEAD) em $ARVORE"
echo "• conta gcloud: $(gcloud config get-value account 2>/dev/null)"
VER=696e3e9ddc5f1c803a4b9244a075ed498ad81be3
D_API=sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f
D_WEB=sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72
bash infra/prod/gcp/promover-imagens.sh "$VER" "$D_API" "$D_WEB"
echo "— conferência no destino (cenario-prod):"
for par in "api $D_API" "web $D_WEB"; do
  set -- $par
  atual="$(gcloud artifacts docker images describe "southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod/$1:$VER" --format='value(image_summary.digest)')"
  if [ "$atual" = "$2" ]; then echo "✔ $1:$VER = $atual"; else echo "✘ $1:$VER = '${atual:-ausente}' (esperado $2)"; exit 1; fi
done
echo "BLOCO 1: OK"
)
```

## Bloco 2

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
echo "• versão: $(git rev-parse HEAD) em $ARVORE"
echo "• conta gcloud: $(gcloud config get-value account 2>/dev/null)"
SAIDA="$HOME/cenario-pacote-9ff142e274b1"
PAC="$SAIDA/scripts-9ff142e274b1.tar.gz"
SHA="$SAIDA/scripts-9ff142e274b1.sha256"
DEST=gs://cenariogestao-prod-runner-versoes
REF=c8c293b10ba5a5fe1b10d30b77a5760c088c62dffec044450a1a5a5dba028cdc
mkdir -p "$SAIDA"
git archive --format=tar "$COMMIT" infra/prod scripts/backup.sh scripts/restore.sh | gzip -n -9 > "$PAC"
sha256sum "$PAC" | cut -d' ' -f1 > "$SHA"
echo "• sha256: $(cat "$SHA")"
python3 -I - "$PAC" "$SHA" "$COMMIT" <<'PY'
import hashlib, subprocess, sys, tarfile
pac, sha, commit = sys.argv[1:4]
dados = open(pac, "rb").read()
assert hashlib.sha256(dados).hexdigest() == open(sha).read().split()[0], "sha256 do arquivo .sha256 não confere"
esperados = subprocess.run(["git", "ls-tree", "-r", "--name-only", commit, "infra/prod", "scripts/backup.sh", "scripts/restore.sh"],
                           capture_output=True, text=True, check=True).stdout.split()
with tarfile.open(pac, "r:gz") as t:
    assert t.pax_headers.get("comment") == commit, "o pacote não é o git archive do commit"
    arquivos = {m.name: t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
assert sorted(arquivos) == sorted(esperados), "lista de arquivos diferente do commit"
for nome in esperados:
    blob = subprocess.run(["git", "cat-file", "blob", f"{commit}:{nome}"], capture_output=True, check=True).stdout
    assert arquivos[nome] == blob, f"conteúdo diferente do commit: {nome}"
print(f"✔ pacote conferido: commit {commit}, {len(arquivos)} arquivos idênticos ao repositório")
PY
if [ "$(cat "$SHA")" != "$REF" ]; then echo "✘ sha256 $(cat "$SHA") diferente da referência $REF: NADA publicado"; exit 1; fi
echo "✔ sha256 igual à referência do checklist"
ENVIAR=""
for f in "$PAC" "$SHA"; do
  n="$(basename "$f")"
  if gcloud storage objects describe "$DEST/$n" >/dev/null 2>&1; then
    if gcloud storage cat "$DEST/$n" | cmp -s - "$f"; then echo "• $n já publicado e idêntico"; else echo "✘ $n já existe no bucket com outro conteúdo: NADA publicado"; exit 1; fi
  else
    ENVIAR="$ENVIAR $f"
  fi
done
for f in $ENVIAR; do
  gcloud storage cp "$f" "$DEST/$(basename "$f")" --if-generation-match=0
done
echo "— conferência no bucket:"
V="$(mktemp -d)"
gcloud storage cp "$DEST/scripts-9ff142e274b1.tar.gz" "$DEST/scripts-9ff142e274b1.sha256" "$V/"
[ "$(sha256sum "$V/scripts-9ff142e274b1.tar.gz" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$V/scripts-9ff142e274b1.sha256")" ] || { echo "✘ cópia do bucket não confere com o .sha256"; exit 1; }
cmp -s "$V/scripts-9ff142e274b1.tar.gz" "$PAC" || { echo "✘ pacote no bucket difere do gerado agora"; exit 1; }
gcloud storage ls -l "$DEST/scripts-9ff142e274b1.tar.gz" "$DEST/scripts-9ff142e274b1.sha256"
echo "✔ publicado: $(cat "$V/scripts-9ff142e274b1.sha256")"
echo "BLOCO 2: OK"
)
```

## Bloco 1 com novas tentativas (após SSLError: UNEXPECTED_EOF_WHILE_READING)

Testado com um `gcloud` simulado: falha de SSL na 1ª tentativa → sucesso na 2ª; digest de origem divergente → recusa sem nova tentativa.

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
echo "• versão: $(git rev-parse HEAD) em $ARVORE"
echo "• conta gcloud: $(gcloud config get-value account 2>/dev/null)"
VER=696e3e9ddc5f1c803a4b9244a075ed498ad81be3
D_API=sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f
D_WEB=sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72
LOG="$HOME/cenario-promocao-696e3e9.log"
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
