# Autenticação SSH NÃO interativa para os scripts do Cloud Shell (homolog.sh, auditoria-pre-deploy.sh,
# operador.sh). Incluído com "source"; sozinho não executa nada.
#
# O "gcloud compute ssh/scp" usa a chave ~/.ssh/google_compute_engine. Com passphrase, o ssh a pedia
# NO MEIO do script, a cada conexão, com a entrada padrão ocupada pelo script remoto e a saída de erro
# desviada para arquivo (o motivo real da falha não aparecia). Aqui a chave protegida precisa já estar
# carregada no ssh-agent (a passphrase é digitada uma vez, no ssh-add, fora do script) e toda conexão
# leva BatchMode=yes: o ssh nunca pergunta nada; sem a chave no agente, a etapa para na hora e explica.
# Nada é criado: não gera chave (o gcloud a criaria SEM passphrase e a gravaria nos metadados), não
# inicia agente, não remove a passphrase e não grava arquivo algum.

CHAVE_SSH="${CENARIO_CHAVE_SSH:-$HOME/.ssh/google_compute_engine}"
SSH_SEM_PERGUNTA=(--ssh-flag=-oBatchMode=yes)
SCP_SEM_PERGUNTA=(--scp-flag=-oBatchMode=yes)
_SSH_CONFERIDO=0

conferir_chave_ssh() { # 0 se o gcloud autenticará sem perguntar nada; senão explica (na saída de erro) e devolve 1
  (( _SSH_CONFERIDO )) && return 0
  local c
  for c in ssh-keygen ssh-add; do
    command -v "$c" >/dev/null 2>&1 || { echo "✘ $c ausente (use o Cloud Shell)" >&2; return 1; }
  done
  if [[ ! -f "$CHAVE_SSH" || ! -f "$CHAVE_SSH.pub" ]]; then
    cat >&2 <<EOF
✘ Chave SSH do gcloud não encontrada ($CHAVE_SSH e $CHAVE_SSH.pub).
  Os scripts não geram chave. Conecte-se uma vez manualmente (o gcloud cria a chave e pede a passphrase):
    gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap
EOF
    return 1
  fi
  # Com -P '' o ssh-keygen não pergunta: só dá certo se a chave não tem passphrase.
  if ssh-keygen -y -P '' -f "$CHAVE_SSH" >/dev/null 2>&1; then _SSH_CONFERIDO=1; return 0; fi
  local impressao lista rc=0 motivo
  impressao="$(ssh-keygen -lf "$CHAVE_SSH.pub" 2>/dev/null | awk '{print $2}')"
  lista="$(ssh-add -l 2>/dev/null)" || rc=$?
  if [[ -z "${SSH_AUTH_SOCK:-}" ]] || (( rc == 2 )); then motivo="nenhum ssh-agent acessível neste terminal"
  elif [[ -z "$impressao" ]] || ! grep -qF -- "$impressao" <<<"$lista"; then motivo="a chave não está carregada no ssh-agent"
  else _SSH_CONFERIDO=1; return 0; fi
  {
    echo "✘ A chave $CHAVE_SSH tem passphrase e $motivo."
    echo "  O script não pede a passphrase (cada conexão pediria de novo, sem mostrar o erro real)."
    echo "  Carregue a chave no ssh-agent DESTE terminal (a passphrase é digitada só no ssh-add) e repita:"
    [[ "$motivo" == nenhum* ]] && echo '    eval "$(ssh-agent -s)"                     # agente só deste terminal; some ao fechá-lo'
    echo "    ssh-add -t 1h $CHAVE_SSH   # a chave sai do agente em 1 hora"
    echo "    (depois, opcional: ssh-add -d $CHAVE_SSH  ou  ssh-agent -k)"
  } >&2
  return 1
}
