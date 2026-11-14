#!/usr/bin/env bash
# Promoção das imagens 696e3e9 (homologação → produção) e publicação do pacote scripts-9ff142e274b1.
# Executar no Cloud Shell, com a SUA conta. Não acessa a VM, não abre o portão, não reinicia nada,
# não muda permissões. Tolerante a falhas transitórias de transferência: "crane copy" é repetido e
# reaproveita as camadas já enviadas; o manifesto é copiado byte a byte (o digest não muda).
set -euo pipefail
PROJ=cenariogestao
SHA=696e3e9ddc5f1c803a4b9244a075ed498ad81be3
ORIG=us-east1-docker.pkg.dev/$PROJ/cenario-homolog
DEST=southamerica-east1-docker.pkg.dev/$PROJ/cenario-prod
DIG_api=sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f
DIG_web=sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72
PKG=scripts-9ff142e274b1
PKG_SHA=c8c293b10ba5a5fe1b10d30b77a5760c088c62dffec044450a1a5a5dba028cdc
BUCKET=gs://cenariogestao-prod-runner-versoes
ARTE=origin/claude/artefatos-deploy-696e3e9
CRANE_V=v0.20.2
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
falha() { echo "✘ $*"; echo "RESULTADO: INTERROMPIDO (nada foi sobrescrito)"; exit 1; }
tenta() { # tenta <n> <comando…>: repete com espera crescente (falhas transitórias)
  local n="$1" t; shift
  for t in $(seq 1 "$n"); do "$@" && return 0; (( t < n )) && { echo "  • falha transitória ($t/$n): nova tentativa em $((t * 15)) s" >&2; sleep $((t * 15)); }; done
  return 1
}

echo "== 0. Preparação (conta, repositório, ferramenta)"
gcloud config set project "$PROJ" >/dev/null 2>&1
echo "  conta: $(gcloud config get-value account 2>/dev/null)"
REPO="${REPO:-$(find "$HOME" -maxdepth 2 -type d -iname 'cen*rio-app' -exec test -d '{}/.git' ';' -print -quit)}"
[[ -n "$REPO" ]] || falha "clone do repositório não encontrado em $HOME (defina REPO=<caminho> e rode de novo)"
tenta 4 git -C "$REPO" fetch -q origin claude/artefatos-deploy-696e3e9 || falha "não consegui buscar a branch de artefatos"
CRANE="${CRANE:-}"
if [[ -z "$CRANE" ]]; then
  U="https://github.com/google/go-containerregistry/releases/download/$CRANE_V"
  tenta 4 curl -fsSL -o "$W/gcr.tgz" "$U/go-containerregistry_Linux_x86_64.tar.gz" || falha "download do crane"
  tenta 4 curl -fsSL -o "$W/checksums.txt" "$U/checksums.txt" || falha "download dos checksums do crane"
  esperado="$(awk '$2 == "go-containerregistry_Linux_x86_64.tar.gz" {print $1}' "$W/checksums.txt")"
  [[ -n "$esperado" && "$(sha256sum "$W/gcr.tgz" | cut -d' ' -f1)" == "$esperado" ]] || falha "checksum do crane $CRANE_V não confere"
  tar -xzf "$W/gcr.tgz" -C "$W" crane && CRANE="$W/crane"
fi
echo "  crane: $("$CRANE" version 2>/dev/null || echo "$CRANE_V")"
gcloud auth configure-docker us-east1-docker.pkg.dev,southamerica-east1-docker.pkg.dev --quiet >/dev/null 2>&1 \
  || falha "configurar o acesso do Docker/crane ao Artifact Registry"

echo "== 1. Promoção das imagens (cópia por digest, com novas tentativas)"
for s in api web; do
  dig_var="DIG_$s"; dig="${!dig_var}"
  origem="$(tenta 4 "$CRANE" digest "$ORIG/$s:$SHA")" || falha "não li a origem $ORIG/$s:$SHA"
  [[ "$origem" == "$dig" ]] || falha "origem $s:$SHA tem $origem, e não o digest aprovado $dig"
  atual="$("$CRANE" digest "$DEST/$s:$SHA" 2>/dev/null || true)"
  if [[ -n "$atual" ]]; then
    [[ "$atual" == "$dig" ]] || falha "destino $DEST/$s:$SHA já existe com OUTRO digest ($atual): nada sobrescrito"
    echo "  ✔ $s já estava promovida ($dig)"; continue
  fi
  tenta 6 "$CRANE" copy "$ORIG/$s@$dig" "$DEST/$s:$SHA" || falha "cópia de $s falhou 6 vezes"
  final="$(tenta 4 "$CRANE" digest "$DEST/$s:$SHA")" || falha "não li o destino de $s"
  [[ "$final" == "$dig" ]] || falha "destino $s ficou com $final (esperado $dig)"
  echo "  ✔ $s promovida: $dig"
done

echo "== 2. Pacote $PKG (bytes exatos do repositório, SHA-256 exigido)"
git -C "$REPO" show "$ARTE:artefatos/$PKG.tar.gz" > "$W/$PKG.tar.gz"
got="$(sha256sum "$W/$PKG.tar.gz" | cut -d' ' -f1)"
[[ "$got" == "$PKG_SHA" ]] || falha "SHA-256 do pacote $got ≠ $PKG_SHA"
echo "$PKG_SHA" > "$W/$PKG.sha256"
echo "  ✔ pacote local: $PKG_SHA"
for f in tar.gz sha256; do
  obj="$BUCKET/$PKG.$f"
  if gcloud storage objects describe "$obj" >/dev/null 2>&1; then
    remoto="$(gcloud storage cat "$obj" | sha256sum | cut -d' ' -f1)"
    [[ "$remoto" == "$(sha256sum "$W/$PKG.$f" | cut -d' ' -f1)" ]] || falha "$obj já existe com OUTRO conteúdo: nada sobrescrito"
    echo "  ✔ $PKG.$f já publicado (idêntico)"
  else
    tenta 4 gcloud storage cp "$W/$PKG.$f" "$obj" --if-generation-match=0 --quiet || falha "envio de $PKG.$f"
    echo "  ✔ $PKG.$f publicado"
  fi
done

echo "== 3. Confirmação final (Artifact Registry e bucket)"
for s in api web; do
  dig_var="DIG_$s"
  d="$(gcloud artifacts docker images describe "$DEST/$s:$SHA" --format='value(image_summary.digest)' 2>/dev/null || true)"
  [[ "$d" == "${!dig_var}" ]] && echo "  ✔ cenario-prod/$s:$SHA = $d" || falha "Artifact Registry: $s com '$d' (esperado ${!dig_var})"
done
r="$(gcloud storage cat "$BUCKET/$PKG.tar.gz" | sha256sum | cut -d' ' -f1)"
[[ "$r" == "$PKG_SHA" ]] && echo "  ✔ $BUCKET/$PKG.tar.gz = $r" || falha "bucket: pacote com $r"
[[ "$(gcloud storage cat "$BUCKET/$PKG.sha256" | tr -dc '0-9a-f')" == "$PKG_SHA" ]] && echo "  ✔ $BUCKET/$PKG.sha256 confere" || falha "bucket: .sha256 diferente"
echo "RESULTADO: ARTEFATOS PRONTOS (imagens api/web promovidas e pacote $PKG publicado)"
