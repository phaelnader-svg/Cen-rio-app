#!/usr/bin/env bash
# Firma Viva — VERSÃO DE TESTE em hospedagem separada (VM própria no Compute Engine), com banco
# isolado, dados FICTÍCIOS e um Cenário Gestão de teste (empresa fictícia) para a conexão.
# Rode no Cloud Shell, na raiz do repositório, na branch que quer publicar:
#
#   bash infra/firma-viva/teste/firma-teste.sh subir --dono voce@exemplo.com
#   bash infra/firma-viva/teste/firma-teste.sh dns          # registros DNS exatos para firmaviva.com.br
#   bash infra/firma-viva/teste/firma-teste.sh validar      # depois do DNS: HTTPS, login e jogo no domínio
#   bash infra/firma-viva/teste/firma-teste.sh atualizar    # publica de novo o código atual
#   bash infra/firma-viva/teste/firma-teste.sh producao     # liga ao Cenário Gestão de PRODUÇÃO (jogo, operação e escritório)
#   bash infra/firma-viva/teste/firma-teste.sh homologacao  # liga à HOMOLOGAÇÃO do Cenário (jogo, operação e escritório)
#   bash infra/firma-viva/teste/firma-teste.sh voltar-teste # volta ao Cenário de teste (empresa fictícia)
#   bash infra/firma-viva/teste/firma-teste.sh status | convite <email> | destruir
#
# Nada aqui toca a homologação ou a produção do Cenário Gestão (outra VM, outro IP, outro banco).
# Segredos são gerados NA VM (/opt/firma-teste/.env, só root) e nunca vão para o repositório.
set -euo pipefail

PROJECT="${FIRMA_PROJECT:-cenariogestao}"
REGION="${FIRMA_REGION:-southamerica-east1}"
ZONE="${FIRMA_ZONE:-southamerica-east1-a}"
VM="${FIRMA_VM:-firma-teste}"
IP_NAME="${VM}-ip"
TAG="${VM}"
MACHINE="${FIRMA_MACHINE:-e2-standard-2}"
DOMAIN="${FIRMA_DOMAIN:-firmaviva.com.br}"
DIR=/opt/firma-teste
G=(gcloud --project="$PROJECT" --quiet)

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }
ip() { "${G[@]}" compute addresses describe "$IP_NAME" --region="$REGION" --format='value(address)' 2>/dev/null; }
ssh_vm() { "${G[@]}" compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command="$1"; }
# Executa um bloco bash como root na VM (lido da entrada padrão).
run_vm() { "${G[@]}" compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command='sudo bash -s'; }

criar_infra() {
  say "Projeto $PROJECT · VM $VM ($MACHINE) em $ZONE"
  "${G[@]}" services enable compute.googleapis.com iap.googleapis.com >/dev/null
  if [[ -z "$(ip)" ]]; then
    say "Reservando IP fixo $IP_NAME"
    "${G[@]}" compute addresses create "$IP_NAME" --region="$REGION"
  fi
  if ! "${G[@]}" compute firewall-rules describe "${TAG}-web" >/dev/null 2>&1; then
    "${G[@]}" compute firewall-rules create "${TAG}-web" --network=default --direction=INGRESS \
      --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags="$TAG"
  fi
  if ! "${G[@]}" compute firewall-rules describe "${TAG}-iap-ssh" >/dev/null 2>&1; then
    "${G[@]}" compute firewall-rules create "${TAG}-iap-ssh" --network=default --direction=INGRESS \
      --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags="$TAG"
  fi
  if ! "${G[@]}" compute instances describe "$VM" --zone="$ZONE" >/dev/null 2>&1; then
    say "Criando a VM (Debian 12, disco de 40 GB)"
    "${G[@]}" compute instances create "$VM" --zone="$ZONE" --machine-type="$MACHINE" \
      --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=40GB \
      --address="$(ip)" --tags="$TAG" --metadata=enable-oslogin=TRUE
  fi
  say "Preparando a VM (Docker, Compose e 4 GB de swap — só se ausentes)"
  for i in $(seq 1 30); do ssh_vm true 2>/dev/null && break; sleep 10; done
  run_vm <<'EOF'
set -e
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q && apt-get install -yq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q && apt-get install -yq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
install -d -m 700 /opt/firma-teste
EOF
}

enviar_codigo() {
  say "Enviando o código ($(git rev-parse --short HEAD), branch $(git rev-parse --abbrev-ref HEAD))"
  local tmp; tmp="$(mktemp -d)"
  git archive --format=tar.gz -o "$tmp/codigo.tgz" HEAD
  "${G[@]}" compute scp "$tmp/codigo.tgz" "$VM:/tmp/codigo.tgz" --zone="$ZONE" --tunnel-through-iap
  rm -rf "$tmp"
  run_vm <<EOF
set -e
rm -rf $DIR/src.novo && mkdir -p $DIR/src.novo && tar -xzf /tmp/codigo.tgz -C $DIR/src.novo && rm /tmp/codigo.tgz
rm -rf $DIR/src.antigo; [ -d $DIR/src ] && mv $DIR/src $DIR/src.antigo; mv $DIR/src.novo $DIR/src
EOF
}

gerar_env() {
  local addr="$1"
  run_vm <<EOF
set -e
cd $DIR
if [ ! -f .env ]; then
  r() { openssl rand -hex 32; }
  umask 077
  cat > .env <<ENV
POSTGRES_PASSWORD=\$(r)
CENARIO_TOKEN_HASH_SECRET=\$(r)
FIRMA_TOKEN_HASH_SECRET=\$(r)
FIRMA_SEAL_KEY=\$(openssl rand -base64 32)
FIRMA_CENARIO_CLIENT_SECRET=\$(r)
CENARIO_GESTOR_EMAIL=gestor@teste.firmaviva.com.br
CENARIO_GESTOR_SENHA=Teste-\$(openssl rand -hex 6)
VALIDACAO_SENHA=Valida-\$(openssl rand -hex 12)
CENARIO_HOST=cenario.${addr//./-}.sslip.io
FIRMA_PROVISORIO=firma.${addr//./-}.sslip.io
FIRMA_HOSTS=firma.${addr//./-}.sslip.io
FIRMA_CANONICAL=firma.${addr//./-}.sslip.io
FIRMA_WEB_URL=https://firma.${addr//./-}.sslip.io
FIRMA_EXTRA_ORIGINS=
FIRMA_WWW=http://www.invalid
ENV
fi
EOF
}

# Docker Compose da pilha de teste, rodando na VM.
DC="cd $DIR/src/infra/firma-viva/teste && docker compose --env-file $DIR/.env -f docker-compose.teste.yml"

construir_e_subir() {
  say "Construindo as imagens na VM (primeira vez: ~10–15 min) e subindo a pilha"
  run_vm <<EOF
set -e
$DC build
$DC up -d --remove-orphans
for i in \$(seq 1 60); do
  $DC exec -T firma-api node -e "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null \
  && $DC exec -T api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 5
done
$DC ps --format 'table {{.Service}}\t{{.Status}}'
EOF
}

# Redirecionamentos de retorno aceitos pelo Cenário de teste: endereço provisório e o domínio.
registrar_app() {
  run_vm <<EOF
set -e
. $DIR/.env
$DC exec -T -e FIRMA_CENARIO_CLIENT_SECRET api pnpm --silent --filter @cenario/api app-client -- \
  --id firma-viva --name "Firma Viva" --scopes jogo,operacao,escritorio --secret-env FIRMA_CENARIO_CLIENT_SECRET \
  --redirect "https://\$FIRMA_PROVISORIO/api/conexoes/cenario/retorno,https://$DOMAIN/api/conexoes/cenario/retorno"
EOF
}

dados_ficticios() {
  local dono="$1"
  say "Dados fictícios: Cenário de teste (equipe, OS) e organização no Firma Viva"
  run_vm <<EOF
set -e
. $DIR/.env
cd $DIR
if [ ! -f .semeado ]; then
  $DC exec -T api pnpm --silent db:seed
  $DC exec -T -e JOGO_API=http://127.0.0.1:4000 -e JOGO_ORIGIN=https://\$CENARIO_HOST \
    -e JOGO_EMAIL=\$CENARIO_GESTOR_EMAIL -e JOGO_PASSWORD=\$CENARIO_GESTOR_SENHA \
    api node scripts/jogo-dados-sinteticos.mjs > $DIR/dados-ficticios.txt 2>&1 || { cat $DIR/dados-ficticios.txt; exit 1; }
  # Conta só para a validação automática (login e jogo pelo domínio). A senha fica nesta VM.
  $DC exec -T -e VALIDACAO_SENHA firma-api sh -c 'cd /app/apps/firma-api && node --import tsx src/cli/criar-organizacao.ts --organizacao "Validação automática" --email validacao@teste.firmaviva.com.br --nome "Validação" --senha-env VALIDACAO_SENHA'
  touch .semeado
fi
echo "--- Convite do dono (Cenário Estofados, dados fictícios) ---"
$DC exec -T firma-api sh -c 'cd /app/apps/firma-api && node --import tsx src/cli/criar-organizacao.ts --organizacao "Cenário Estofados" --email "$dono"'
EOF
}

mostrar_links() {
  local addr; addr="$(ip)"
  local d="${addr//./-}"
  run_vm <<EOF
. $DIR/.env
echo
echo "════════ Firma Viva (TESTE, dados fictícios) ════════"
echo "Link provisório do jogo:   https://firma.$d.sslip.io"
echo "Cenário Gestão de teste:   https://cenario.$d.sslip.io   (empresa fictícia)"
echo "  gestor de teste (use na tela de autorização do Cenário): \$CENARIO_GESTOR_EMAIL  /  \$CENARIO_GESTOR_SENHA"
echo "Tablets de teste (Cenário /tablet):"
grep -E '^\s+(João|Márcio|Ricardo|Thiago)\s+PIN' $DIR/dados-ficticios.txt || true
EOF
  mostrar_dns
}

mostrar_dns() {
  local addr; addr="$(ip)"
  [[ -n "$addr" ]] || die "Ainda não há IP reservado. Rode: subir --dono <email>"
  cat <<EOF

════════ Registros DNS para $DOMAIN ════════
No painel do seu DNS (no Registro.br: Domínio → DNS → "Editar zona"), APAGUE registros A/AAAA/CNAME
de estacionamento ou redirecionamento que já existam em "$DOMAIN" e "www", e crie:

  Tipo   Nome (host)          Valor                 TTL
  A      @  ($DOMAIN)   $addr     300
  A      www                  $addr     300
  CAA    @                    0 issue "letsencrypt.org"   3600   (opcional; libera o certificado HTTPS)

Não crie AAAA (IPv6): esta VM só tem IPv4. Depois que propagar, rode:
  bash infra/firma-viva/teste/firma-teste.sh validar
EOF
}

validar() {
  local addr; addr="$(ip)"
  say "Conferindo o DNS de $DOMAIN e www.$DOMAIN → $addr"
  local a w
  a="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
  w="$(getent ahostsv4 "www.$DOMAIN" | awk 'NR==1{print $1}')"
  echo "$DOMAIN → ${a:-(sem resposta)} | www.$DOMAIN → ${w:-(sem resposta)}"
  [[ "$a" == "$addr" ]] || die "$DOMAIN ainda não aponta para $addr. Aguarde a propagação (TTL) e rode de novo."
  say "Ativando o domínio no Caddy e no Firma Viva (o provisório continua valendo)"
  run_vm <<EOF
set -e
cd $DIR
. ./.env
sed -i "s#^FIRMA_HOSTS=.*#FIRMA_HOSTS=$DOMAIN, \$FIRMA_PROVISORIO#; s#^FIRMA_CANONICAL=.*#FIRMA_CANONICAL=$DOMAIN#; s#^FIRMA_WEB_URL=.*#FIRMA_WEB_URL=https://$DOMAIN#; s#^FIRMA_EXTRA_ORIGINS=.*#FIRMA_EXTRA_ORIGINS=https://\$FIRMA_PROVISORIO#" .env
if [ "$w" = "$addr" ]; then sed -i "s#^FIRMA_WWW=.*#FIRMA_WWW=www.$DOMAIN#" .env; fi
$DC up -d firma-api api caddy
EOF
  say "Validando HTTPS, login e abertura do jogo em https://$DOMAIN"
  run_vm <<EOF
set -u
. $DIR/.env
ok=0; falhou=0
chk() { if [ "\$2" = "1" ]; then echo "  ✔ \$1"; ok=\$((ok+1)); else echo "  ✖ \$1"; falhou=\$((falhou+1)); fi; }
for i in \$(seq 1 36); do curl -fsS -o /dev/null https://$DOMAIN/entrar 2>/dev/null && break; sleep 5; done
cert=\$(echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null)
chk "certificado HTTPS válido (\$(echo "\$cert" | tr '\n' ' '))" \$(curl -fsS -o /dev/null https://$DOMAIN/entrar && echo 1 || echo 0)
chk "http:// redireciona para https://" \$([ "\$(curl -s -o /dev/null -w '%{http_code}' http://$DOMAIN/)" = "308" ] && echo 1 || echo 0)
chk "página de login do Firma Viva" \$(curl -fsS https://$DOMAIN/entrar | grep -q 'Firma Viva' && echo 1 || echo 0)
jar=\$(mktemp)
code=\$(curl -s -c \$jar -o /dev/null -w '%{http_code}' -H "Origin: https://$DOMAIN" -H 'content-type: application/json' \
  -d "{\"email\":\"validacao@teste.firmaviva.com.br\",\"password\":\"\$VALIDACAO_SENHA\"}" https://$DOMAIN/api/auth/login)
chk "login (conta de validação) → \$code" \$([ "\$code" = "200" ] && echo 1 || echo 0)
chk "sessão: /api/auth/me" \$(curl -fsS -b \$jar https://$DOMAIN/api/auth/me | grep -q '"organization"' && echo 1 || echo 0)
chk "jogo abre: /jogo" \$([ "\$(curl -s -b \$jar -o /dev/null -w '%{http_code}' https://$DOMAIN/jogo)" = "200" ] && echo 1 || echo 0)
chk "planta do jogo carrega: /api/v1/game/spaces" \$(curl -fsS -b \$jar https://$DOMAIN/api/v1/game/spaces | grep -q 'TAPECARIA' && echo 1 || echo 0)
chk "cookie de sessão Secure e HttpOnly" \$(grep -q '#HttpOnly_$DOMAIN.*TRUE' \$jar && echo 1 || echo 0)
if [ "\$FIRMA_WWW" = "www.$DOMAIN" ]; then
  chk "www redireciona para $DOMAIN" \$(curl -s -o /dev/null -w '%{redirect_url}' https://www.$DOMAIN/ | grep -q "^https://$DOMAIN/" && echo 1 || echo 0)
fi
rm -f \$jar
echo "Resultado: \$ok ok, \$falhou falha(s)"
[ \$falhou -eq 0 ]
EOF
}

# Conferência de fora (Cloud Shell): o domínio responde com HTTPS válido para quem acessa da internet.
validar_de_fora() {
  say "Conferindo de fora da VM (Cloud Shell)"
  curl -fsS -o /dev/null "https://$DOMAIN/entrar" && echo "  ✔ https://$DOMAIN/entrar com certificado válido" \
    || die "https://$DOMAIN não respondeu com certificado válido de fora da VM."
  curl -fsS "https://$DOMAIN/entrar" | grep -q 'Firma Viva' && echo "  ✔ página de login do Firma Viva"
  echo "Abra https://$DOMAIN e entre com a sua conta (convite de dono)."
}

# Liga o Firma Viva a um Cenário Gestão real em MODO CONSULTA (somente leitura).
#   producao    → https://cenariogestao.com.br
#   homologacao → https://teste.cenariogestao.com.br (o cookie do portão do proxy é lido do Secret
#                 Manager pela SUA conta e vai direto para a VM; nunca aparece na tela)
# Pré-requisito: no Cenário escolhido (Administração → Aplicativos conectados), cadastrar
# "firma-viva" com o retorno https://firmaviva.com.br/api/conexoes/cenario/retorno e copiar o segredo.
# O segredo é digitado aqui SEM eco, vai para a VM pela conexão SSH (entrada padrão) e fica só em
# $DIR/.env (root). Nunca aparece na tela, em argumentos de comando nem no repositório.
ligar_cenario() {
  local rotulo="$1" cen="$2" cookie="" seg=""
  if [[ "$rotulo" == homologação ]]; then
    local gate
    gate="$("${G[@]}" secrets versions access latest --secret=homolog-gate-token 2>/dev/null)" \
      || die "Não consegui ler o segredo homolog-gate-token com a sua conta."
    [[ "$gate" =~ ^[A-Za-z0-9_-]+$ ]] || die "homolog-gate-token em formato inesperado."
    cookie="cenario_homolog=$gate"
  fi
  say "Ligando o Firma Viva ($DOMAIN) ao Cenário Gestão de $rotulo ($cen): jogo, operação e escritório"
  read -rs -p "Cole o segredo do aplicativo firma-viva gerado nesse Cenário (não aparece na tela): " seg
  echo
  [[ ${#seg} -ge 32 && "$seg" =~ ^[A-Za-z0-9_-]+$ ]] || die "Segredo inválido (copie de novo do Cenário)."
  run_vm <<FIM || die "A ligação parou no meio (veja a mensagem acima). Nada foi trocado no Cenário; rode o mesmo comando de novo."
set -eu
cd $DIR
umask 077
echo "  • gravando o endereço do Cenário de $rotulo"
sed -i '/^FIRMA_CENARIO_API_URL=/d; /^FIRMA_CENARIO_WEB_URL=/d; /^FIRMA_CENARIO_SCOPES=/d; /^FIRMA_CENARIO_SEGREDO_PRODUCAO=/d; /^FIRMA_CENARIO_COOKIE=/d' .env
printf '%s\n' "FIRMA_CENARIO_API_URL=$cen" "FIRMA_CENARIO_WEB_URL=$cen" "FIRMA_CENARIO_SCOPES=${FIRMA_CENARIO_SCOPES:-jogo operacao escritorio}" "FIRMA_CENARIO_SEGREDO_PRODUCAO=$seg" "FIRMA_CENARIO_COOKIE=$cookie" >> .env
# Conexões antigas apontavam para outro Cenário: ficam desconectadas (tokens apagados).
$DC exec -T postgres psql -U app -d firma_viva -qc "UPDATE cenario_connections SET status='DESCONECTADA', access_enc=NULL, refresh_enc=NULL, access_expires_at=NULL, last_error='Trocado para o Cenário Gestão de $rotulo: conecte de novo.' WHERE status <> 'DESCONECTADA'" </dev/null
echo "  • reconstruindo o Firma Viva para o novo endereço (~3 min)"
$DC build firma-web
$DC up -d firma-api firma-web
for i in \$(seq 1 30); do $DC exec -T firma-api node -e "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1 && break; sleep 2; done
# Prova sem efeito: o Cenário reconhece o aplicativo e o segredo (concessão desconhecida → 400;
# segredo errado seria 401). Nada é criado no Cenário.
$DC exec -T firma-api node -e "fetch(process.env.CENARIO_API_URL+'/api/oauth/token',{method:'POST',headers:Object.assign({'content-type':'application/json'},process.env.FIRMA_CENARIO_COOKIE?{cookie:process.env.FIRMA_CENARIO_COOKIE}:{}),body:JSON.stringify({grant_type:'conferencia',client_id:process.env.FIRMA_CENARIO_CLIENT_ID,client_secret:process.env.FIRMA_CENARIO_CLIENT_SECRET})}).then(async r=>{const b=await r.json().catch(()=>({}));if(r.status===400&&b.error==='unsupported_grant_type'){console.log('  ✔ o Cenário reconhece o aplicativo e o segredo');process.exit(0)}console.log('  ✖ Cenário respondeu '+r.status+' '+(b.error||'')+': confira o cadastro e o segredo');process.exit(1)}).catch(e=>{console.log('  ✖ sem acesso ao Cenário: '+e.message);process.exit(1)})" </dev/null
FIM
  echo "Pronto. No Cenário de $rotulo, entre como dono e clique em \"Acessar ambiente interativo\": o jogo abre já conectado."
}

# Volta ao Cenário Gestão de TESTE (empresa fictícia) da própria VM.
voltar_teste() {
  run_vm <<FIM
set -eu
cd $DIR
sed -i '/^FIRMA_CENARIO_API_URL=/d; /^FIRMA_CENARIO_WEB_URL=/d; /^FIRMA_CENARIO_SCOPES=/d; /^FIRMA_CENARIO_SEGREDO_PRODUCAO=/d; /^FIRMA_CENARIO_COOKIE=/d' .env
$DC exec -T postgres psql -U app -d firma_viva -qc "UPDATE cenario_connections SET status='DESCONECTADA', access_enc=NULL, refresh_enc=NULL, access_expires_at=NULL WHERE status <> 'DESCONECTADA'" </dev/null
$DC build firma-web
$DC up -d firma-api firma-web
FIM
  echo "Firma Viva voltou a usar o Cenário de teste (empresa fictícia)."
}

case "${1:-}" in
  subir)
    shift; dono=""
    while [[ $# -gt 0 ]]; do case "$1" in --dono) dono="$2"; shift 2;; *) die "opção desconhecida: $1";; esac; done
    [[ -n "$dono" ]] || die "Informe --dono <seu e-mail> (recebe o convite de dono da organização)."
    git diff --quiet HEAD || echo "Atenção: há alterações não commitadas; só o último commit é publicado."
    criar_infra
    enviar_codigo
    gerar_env "$(ip)"
    construir_e_subir
    registrar_app
    dados_ficticios "$dono"
    mostrar_links
    ;;
  atualizar) enviar_codigo; gerar_env "$(ip)"; construir_e_subir; registrar_app ;;
  dns) mostrar_dns ;;
  validar) validar && validar_de_fora ;;
  producao) ligar_cenario produção "${CENARIO_PRODUCAO:-https://cenariogestao.com.br}" ;;
  homologacao) ligar_cenario homologação https://teste.cenariogestao.com.br ;;
  voltar-teste) voltar_teste ;;
  convite)
    [[ -n "${2:-}" ]] || die "uso: convite <email>"
    run_vm <<EOF
$DC exec -T firma-api sh -c 'cd /app/apps/firma-api && node --import tsx src/cli/criar-organizacao.ts --organizacao "Cenário Estofados" --email "$2"'
EOF
    ;;
  status) run_vm <<<"$DC ps --format 'table {{.Service}}\t{{.Status}}'"; mostrar_dns ;;
  destruir)
    read -r -p "Apagar a VM $VM, o IP $IP_NAME e as regras de firewall (dados de TESTE)? digite 'apagar': " c
    [[ "$c" == "apagar" ]] || die "cancelado"
    "${G[@]}" compute instances delete "$VM" --zone="$ZONE"
    "${G[@]}" compute addresses delete "$IP_NAME" --region="$REGION"
    "${G[@]}" compute firewall-rules delete "${TAG}-web" "${TAG}-iap-ssh"
    ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
