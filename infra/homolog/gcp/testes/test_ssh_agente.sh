#!/usr/bin/env bash
# Teste do ssh-agente.sh com o OpenSSH REAL (ssh-keygen, ssh-agent, ssh-add; sshd local se existir).
# Nada externo é tocado: chaves, agente e servidor são temporários, só em 127.0.0.1. Prova que:
#   - chave com passphrase sem agente (ou fora dele) é recusada NA HORA, sem nenhum pedido de passphrase,
#     mesmo com um terminal disponível;
#   - com a chave no agente (com prazo), ou sem passphrase, é aceita — e a passphrase continua na chave;
#   - com sshd: BatchMode=yes nunca pergunta (falha 255 sem agente) e, com o agente, a mesma estrutura
#     da auditoria (script remoto pela entrada, erro desviado, saída pelo tee) funciona;
#   - sem BatchMode (como era antes), o ssh pede a passphrase no meio do script.
# Executar: bash infra/homolog/gcp/testes/test_ssh_agente.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
LIB="$AQUI/../ssh-agente.sh"
for c in ssh-keygen ssh-agent ssh-add ssh script timeout; do
  command -v "$c" >/dev/null 2>&1 || { echo "(OpenSSH/script ausente: $c — teste não executado)"; exit 0; }
done
TMP="$(mktemp -d)"
AGENTE_PID=""; SSHD_PID=""
trap '[[ -n "$AGENTE_PID" ]] && kill "$AGENTE_PID" 2>/dev/null; [[ -n "$SSHD_PID" ]] && kill "$SSHD_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
SENHA='passphrase-de-teste-9f3'
FALHAS=0
ok() { echo "  ✔ $*"; }
ruim() { echo "  ✘ $*"; FALHAS=$((FALHAS + 1)); }
afirma() { if grep -qF -- "$2" "$1"; then ok "contém: $2"; else ruim "NÃO contém: $2"; fi; }
nega() { if grep -qF -- "$2" "$1"; then ruim "contém (não deveria): $2"; else ok "não contém: $2"; fi; }

ssh-keygen -q -t ed25519 -N "$SENHA" -C teste -f "$TMP/com-senha"
ssh-keygen -q -t ed25519 -N '' -C teste -f "$TMP/sem-senha"

# Roda conferir_chave_ssh num pseudo-terminal (o ssh-keygen/ssh-add poderiam perguntar ali), sem digitar nada.
confere() { # confere <saida> <chave> → grava o código de saída em <saida>.rc
  local out="$1" chave="$2"
  printf 'source %q; CHAVE_SSH=%q; conferir_chave_ssh; echo "rc=$?"\n' "$LIB" "$chave" > "$TMP/confere.sh"
  local ini=$SECONDS
  timeout 20 script -qec "bash $TMP/confere.sh" /dev/null < /dev/null > "$out" 2>&1 || true
  echo $((SECONDS - ini)) > "$out.s"
  grep -o 'rc=[0-9]*' "$out" | tail -1 | cut -d= -f2 > "$out.rc"
}
rc_e() { local r; r="$(cat "$1.rc")"; [[ "$r" == "$2" ]] && ok "código $r" || ruim "código ${r:-?} (esperado $2)"; }
rapido() { (( $(cat "$1.s") <= 5 )) && ok "respondeu em $(cat "$1.s")s (sem esperar digitação)" || ruim "demorou $(cat "$1.s")s"; }

echo "1. chave com passphrase, sem agente → recusa na hora, sem pedir passphrase"
( unset SSH_AUTH_SOCK; confere "$TMP/1.out" "$TMP/com-senha" )
rc_e "$TMP/1.out" 1; rapido "$TMP/1.out"
afirma "$TMP/1.out" "nenhum ssh-agent acessível"; afirma "$TMP/1.out" 'eval "$(ssh-agent -s)"'
nega "$TMP/1.out" "Enter passphrase"

eval "$(ssh-agent -s -a "$TMP/agente.sock")" > /dev/null
AGENTE_PID="$SSH_AGENT_PID"
echo "2. agente ativo, chave fora dele → recusa, pede só o ssh-add"
confere "$TMP/2.out" "$TMP/com-senha"
rc_e "$TMP/2.out" 1; rapido "$TMP/2.out"
afirma "$TMP/2.out" "a chave não está carregada no ssh-agent"; nega "$TMP/2.out" 'eval "$(ssh-agent -s)"'
nega "$TMP/2.out" "Enter passphrase"

echo "3. chave carregada no agente com prazo (ssh-add -t) → aceita; a chave continua protegida"
printf '#!/bin/sh\necho %q\n' "$SENHA" > "$TMP/askpass"; chmod 700 "$TMP/askpass"   # só neste teste
SSH_ASKPASS="$TMP/askpass" SSH_ASKPASS_REQUIRE=force ssh-add -q -t 300 "$TMP/com-senha" < /dev/null
rm -f "$TMP/askpass"
confere "$TMP/3.out" "$TMP/com-senha"
rc_e "$TMP/3.out" 0; rapido "$TMP/3.out"
ssh-keygen -y -P '' -f "$TMP/com-senha" >/dev/null 2>&1 && ruim "a passphrase foi removida da chave" || ok "a chave continua com passphrase"
ssh-add -l | grep -q 'ED25519' && ok "chave no agente (com prazo de 300 s)" || ruim "chave ausente do agente"

echo "4. chave sem passphrase → aceita sem agente"
( unset SSH_AUTH_SOCK; confere "$TMP/4.out" "$TMP/sem-senha" )
rc_e "$TMP/4.out" 0

echo "5. chave inexistente → recusa sem gerar chave"
confere "$TMP/5.out" "$TMP/nao-existe"
rc_e "$TMP/5.out" 1; afirma "$TMP/5.out" "não encontrada"
[[ ! -e "$TMP/nao-existe" ]] && ok "nenhuma chave criada" || ruim "chave criada"

SSHD="$(command -v sshd || echo /usr/sbin/sshd)"
if [[ -x "$SSHD" ]]; then
  echo "6. sshd local: BatchMode=yes nunca pergunta; com o agente, a estrutura da auditoria funciona"
  ssh-keygen -q -t ed25519 -N '' -f "$TMP/hostkey"
  cp "$TMP/com-senha.pub" "$TMP/authorized_keys"
  PORTA=$((20000 + RANDOM % 20000))
  cat > "$TMP/sshd_config" <<EOF
Port $PORTA
ListenAddress 127.0.0.1
HostKey $TMP/hostkey
AuthorizedKeysFile $TMP/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes no
UsePAM no
PidFile $TMP/sshd.pid
EOF
  mkdir -p /run/sshd 2>/dev/null || true
  "$SSHD" -D -f "$TMP/sshd_config" -E "$TMP/sshd.log" & SSHD_PID=$!
  for _ in $(seq 1 50); do (echo > "/dev/tcp/127.0.0.1/$PORTA") 2>/dev/null && break; sleep 0.1; done
  printf 'echo INSPECAO-REMOTA-OK\n' > "$TMP/remoto.sh"
  BASE=(ssh -T -p "$PORTA" -i "$TMP/com-senha" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o "UserKnownHostsFile=$TMP/kh" "$(id -un)@127.0.0.1")
  # Mesma estrutura do homolog.sh: ( … ) 2>&1 | tee, script remoto pela entrada, erro desviado para arquivo.
  estrutura() { # estrutura <arquivo-de-comando> <saida>
    printf '( %s "bash -s" < %q > %q 2> %q; echo "rc=$?" ) 2>&1 | tee %q\n' "$1" "$TMP/remoto.sh" "$2" "$2.err" "$2.log" > "$TMP/estrutura.sh"
    local ini=$SECONDS
    timeout 20 script -qec "bash $TMP/estrutura.sh" /dev/null < /dev/null > "$2.tty" 2>&1 || true
    echo $((SECONDS - ini)) > "$2.s"
  }
  COM_BATCH="$(printf '%q ' "${BASE[@]:0:2}" -o BatchMode=yes "${BASE[@]:2}")"
  SEM_BATCH="$(printf '%q ' "${BASE[@]}")"

  echo "6a. antes da correção (sem BatchMode, sem agente): o ssh pede a passphrase no meio do script"
  ( unset SSH_AUTH_SOCK; estrutura "$SEM_BATCH" "$TMP/6a" )
  afirma "$TMP/6a.tty" "Enter passphrase"
  echo "6b. com BatchMode e sem agente: nenhum pedido, falha 255 na hora"
  ( unset SSH_AUTH_SOCK; estrutura "$COM_BATCH" "$TMP/6b" )
  nega "$TMP/6b.tty" "Enter passphrase"; afirma "$TMP/6b.log" "rc=255"; rapido "$TMP/6b"
  echo "6c. com BatchMode e a chave no agente: a inspeção remota roda"
  estrutura "$COM_BATCH" "$TMP/6c"
  nega "$TMP/6c.tty" "Enter passphrase"; afirma "$TMP/6c.log" "rc=0"; afirma "$TMP/6c" "INSPECAO-REMOTA-OK"
else
  echo "6. (sshd ausente: conexão real não testada)"
fi

echo; if (( FALHAS == 0 )); then echo "RESULTADO: todos os cenários OK"; else echo "RESULTADO: $FALHAS falha(s)"; exit 1; fi
