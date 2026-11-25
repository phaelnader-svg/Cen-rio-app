#!/usr/bin/env bash
# Guarda a chave do e-mail (Resend) no Secret Manager: confirmar e-mail, esqueci a senha, avisos da
# assinatura e da LGPD saem por ela (remetente nao-responda@cenariogestao.com.br, domínio já verificado).
# Roda UMA vez, no Cloud Shell do dono:   cd ~/Cen-rio-app && bash infra/email/guardar-chave-email.sh
# A chave é digitada sem aparecer na tela e vai direto ao Secret Manager pela entrada padrão:
# nunca é exibida, gravada em arquivo, passada como argumento nem registrada em log.
# Grava a mesma chave para homologação e produção; cada VM só lê o próprio segredo.
# Rodar de novo troca a chave (nova versão; a anterior é desativada).
set -euo pipefail
PROJECT=cenariogestao
declare -A REGIAO=([prod]=southamerica-east1 [homolog]=us-east1)
declare -A CONTA=([prod]="cenario-prod-vm@$PROJECT.iam.gserviceaccount.com" [homolog]="cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com")
g() { gcloud --project="$PROJECT" --quiet "$@"; }

printf 'Cole a chave do Resend (começa com re_) e aperte Enter. Ela não aparece na tela: '
IFS= read -rs CHAVE; echo
CHAVE="${CHAVE//[[:space:]]/}"
[[ "$CHAVE" == re_* && ${#CHAVE} -ge 20 ]] || { echo "✘ Isso não parece uma chave do Resend (re_...). Nada foi gravado."; exit 1; }

for amb in homolog prod; do
  nome="$amb-resend-api-key"
  antigas=""
  if g secrets describe "$nome" --format='value(name)' >/dev/null 2>&1; then
    antigas="$(g secrets versions list "$nome" --filter=state=ENABLED --format='value(name)')"
  else
    g secrets create "$nome" --replication-policy=user-managed --locations="${REGIAO[$amb]}" \
      --labels=ambiente="$amb",uso=email --format=none
  fi
  printf '%s' "$CHAVE" | g secrets versions add "$nome" --data-file=- --format=none
  for v in $antigas; do g secrets versions disable "$v" --secret="$nome" --format=none; done
  g secrets add-iam-policy-binding "$nome" --member="serviceAccount:${CONTA[$amb]}" \
    --role=roles/secretmanager.secretAccessor --format=none >/dev/null
  echo "✔ $amb: chave guardada (valor não exibido)"
done
unset CHAVE
echo "Pronto. Pode fechar o Cloud Shell; o resto é com o Claude (a chave entra na próxima publicação)."
