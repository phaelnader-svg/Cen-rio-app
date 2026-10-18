#!/usr/bin/env bash
# Instala/atualiza o executor de operações nomeadas (cenario-runner) na VM da homologação ou da produção
# (perfil "prod" no arquivo de configuração), como root.
# Origem dos arquivos: o bootstrap (pela SUA sessão SSH) ou o update_runner (só de uma versão
# publicada no bucket de versões, que só aceita gravação humana, conferida por SHA-256).
#   instalar.sh <pasta-com-os-arquivos>
# Na primeira instalação, a configuração vem de variáveis CENARIO_RUNNER_* (passadas pelo bootstrap);
# depois, a configuração existente é mantida. Idempotente. Não toca na pilha, no banco nem no portão.
# CENARIO_RAIZ (só nos testes) prefixa os caminhos do sistema.
set -euo pipefail
R="${CENARIO_RAIZ:-}"
SRC="${1:?uso: instalar.sh <pasta>}"
DEST="$R/opt/cenario-runner"
CONF="$R/etc/cenario/runner.json"
UNIDADE="$R/etc/systemd/system/cenario-runner.service"

[[ -n "$R" || "$(id -u)" == 0 ]] || { echo "✘ execute como root" >&2; exit 1; }
for f in cenario_runner.py cenario-runner.service VERSAO; do
  [[ -f "$SRC/$f" ]] || { echo "✘ arquivo ausente: $f" >&2; exit 1; }
done
command -v python3 >/dev/null && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || { echo "✘ python3 ≥ 3.11 ausente" >&2; exit 1; }
command -v openssl >/dev/null || { echo "✘ openssl ausente" >&2; exit 1; }
VERSAO="$(tr -dc '0-9.' < "$SRC/VERSAO")"
[[ "$VERSAO" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "✘ VERSAO inválida" >&2; exit 1; }
[[ "$(python3 -I "$SRC/cenario_runner.py" --versao)" == "$VERSAO" ]] || { echo "✘ VERSAO difere do código" >&2; exit 1; }

install -d -m 755 "$DEST" "$R/etc/cenario" "$R/etc/systemd/system"
install -d -m 700 "$R/var/lib/cenario-runner" "$R/var/log/cenario-runner"
install -m 755 "$SRC/cenario_runner.py" "$DEST/cenario_runner.py.novo"
mv -f "$DEST/cenario_runner.py.novo" "$DEST/cenario_runner.py"
install -m 644 "$SRC/VERSAO" "$DEST/VERSAO"

if [[ -n "${CENARIO_RUNNER_PROJETO:-}" ]]; then
  umask 077
  python3 -I - "$CONF" <<'PY'
import json, os, re, sys
v = {k: os.environ[f"CENARIO_RUNNER_{k.upper()}"] for k in ("projeto", "vm", "assinante", "assinatura", "bucket", "bucket_versoes", "dominio")}
regras = {"projeto": r"[a-z][a-z0-9-]{4,28}[a-z0-9]", "vm": r"[a-z][a-z0-9-]{0,61}",
          "assinante": r"[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com", "assinatura": r"projects/[a-z0-9-]+/subscriptions/[A-Za-z0-9._-]+",
          "bucket": r"[a-z0-9._-]{3,63}", "bucket_versoes": r"[a-z0-9._-]{3,63}", "dominio": r"[a-z0-9.-]+"}
# Opcionais (produção): perfil e audiência. Sem eles, perfil homologação e audiência padrão.
for k, r in (("ambiente", r"homolog|prod"), ("aud", r"cenario-(homolog|prod)-runner")):
    x = os.environ.get(f"CENARIO_RUNNER_{k.upper()}", "")
    if x:
        if not re.fullmatch(r, x):
            sys.exit(f"✘ configuração inválida: {k}")
        v[k] = x
for k, r in regras.items():
    if not re.fullmatch(r, v[k]):
        sys.exit(f"✘ configuração inválida: {k}")
with open(sys.argv[1] + ".novo", "w", encoding="utf-8") as f:
    json.dump(v, f, indent=1)
os.replace(sys.argv[1] + ".novo", sys.argv[1])
PY
  chmod 600 "$CONF"
  echo "✔ configuração gravada em /etc/cenario/runner.json"
fi
[[ -f "$CONF" ]] || { echo "✘ sem configuração (/etc/cenario/runner.json) e sem variáveis CENARIO_RUNNER_*" >&2; exit 1; }

install -m 644 "$SRC/cenario-runner.service" "$UNIDADE"
systemctl daemon-reload
systemctl enable cenario-runner.service >/dev/null
if [[ "${CENARIO_RUNNER_ADIAR_REINICIO:-0}" == 1 ]]; then
  # Chamado pelo próprio runner (update_runner): reinicia depois que o job atual terminar.
  systemd-run --quiet --on-active=15 --unit="cenario-runner-reinicio-$(date +%s)" systemctl restart cenario-runner.service
  echo "✔ runner $VERSAO instalado; reinício agendado em 15 s"
else
  systemctl restart cenario-runner.service
  for _ in $(seq 1 20); do systemctl is-active --quiet cenario-runner.service && break; sleep 1; done
  systemctl is-active --quiet cenario-runner.service || { echo "✘ cenario-runner não ficou ativo" >&2; journalctl -u cenario-runner -n 20 --no-pager >&2 || true; exit 1; }
  echo "✔ runner $VERSAO instalado e ativo"
fi
