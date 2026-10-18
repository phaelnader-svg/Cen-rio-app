#!/usr/bin/env bash
# PROMOÇÃO das imagens homologadas para o Artifact Registry de PRODUÇÃO, exigindo os digests
# homologados. A produção nunca constrói imagens: recebe exatamente os bytes que rodaram na homologação.
# Executado no Cloud Shell, com a SUA conta (chamado por provisionar.sh promover); não concede nem
# altera nada na homologação (só LÊ o repositório cenario-homolog).
#
#   promover-imagens.sh <sha-40> <digest-api> <digest-web>
#
# Para cada serviço (api, web):
#   1. a origem cenario-homolog/<svc>:<sha> precisa ter EXATAMENTE o digest informado (senão nada é copiado);
#   2. o destino cenario-prod/<svc>:<sha> já existente precisa ter o MESMO digest (nunca é sobrescrito);
#   3. cópia de registro para registro do manifesto pelo digest (gcloud container images add-tag) e
#      conferência do digest no destino.
# Código de saída: 0 promovidas (ou já promovidas) · 1 recusado/divergente · 2 uso.
set -euo pipefail
TAG="${1:-}" DIGEST_API="${2:-}" DIGEST_WEB="${3:-}"
ORIGEM="${CENARIO_PROMOCAO_ORIGEM:-us-east1-docker.pkg.dev/cenariogestao/cenario-homolog}"
DESTINO="${CENARIO_PROMOCAO_DESTINO:-southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod}"

[[ "$TAG" =~ ^[0-9a-f]{40}$ ]] || { echo "Uso: promover-imagens.sh <sha-40> <digest-api> <digest-web> (SHA completo)" >&2; exit 2; }
for d in "$DIGEST_API" "$DIGEST_WEB"; do
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "✘ digest inválido: '$d' (sha256:<64 hex>)" >&2; exit 2; }
done
[[ "$ORIGEM" =~ ^[a-z0-9-]+-docker[.]pkg[.]dev/[a-z0-9-]+/cenario-homolog$ ]] || { echo "✘ origem inesperada: $ORIGEM" >&2; exit 2; }
[[ "$DESTINO" =~ ^[a-z0-9-]+-docker[.]pkg[.]dev/[a-z0-9-]+/cenario-prod$ ]] || { echo "✘ destino inesperado: $DESTINO" >&2; exit 2; }

digest_de() { gcloud artifacts docker images describe "$1" --format='value(image_summary.digest)' 2>/dev/null || true; }

for svc in api web; do
  if [[ "$svc" == api ]]; then esperado="$DIGEST_API"; else esperado="$DIGEST_WEB"; fi
  src="$ORIGEM/$svc:$TAG"; dst="$DESTINO/$svc:$TAG"
  origem="$(digest_de "$src")"
  [[ "$origem" == "$esperado" ]] || { echo "✘ $src tem digest '${origem:-ausente}', homologado: $esperado. NADA copiado."; exit 1; }
  atual="$(digest_de "$dst")"
  if [[ -n "$atual" ]]; then
    [[ "$atual" == "$esperado" ]] || { echo "✘ $dst já existe com OUTRO digest ($atual): nunca sobrescrito."; exit 1; }
    echo "• $svc:$TAG já promovida (digest $esperado)"
    continue
  fi
  gcloud container images add-tag --quiet "$ORIGEM/$svc@$esperado" "$dst" >/dev/null
  final="$(digest_de "$dst")"
  [[ "$final" == "$esperado" ]] || { echo "✘ $dst ficou com digest '${final:-ausente}' (esperado $esperado)"; exit 1; }
  echo "✔ $svc:$TAG promovida com o digest homologado $esperado"
done
