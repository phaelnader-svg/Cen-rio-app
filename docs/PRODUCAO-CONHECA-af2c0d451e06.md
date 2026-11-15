# Reativar /conheca em produção — pacote `scripts-af2c0d451e06`

Estado: **pronto para revisão. NADA foi publicado nem aplicado em produção.** A aplicação só começa
com a autorização do proprietário.

## 1. Causa

- A VM de produção roda a imagem `696e3e9`, que contém a landing (`/conheca`). Em produção a landing
  só abre com `SITE_COMERCIAL=1` (`apps/web/components/site/config.ts`); sem a variável,
  `app/(site)/layout.tsx` chama `notFound()` e a resposta é **HTTP 404**.
- O Compose que a VM usa vem do pacote `scripts-9ff142e274b1` (deploy de banco limpo, 14/11/2026,
  branch `claude/deploy-banco-limpo`). Ele não tem `SITE_COMERCIAL`: a linha do commit `16d17f4` ficou
  fora por escopo daquele deploy, que se limitou ao volume do PostgreSQL ("/conheca continua
  desligada"; `docs/PRODUCAO-AUDITORIA-VERSAO-IMPLANTADA-696e3e9.md`: "desligada de propósito
  (decisão do deploy)").
- A raiz `/` redireciona para `/painel` → `/entrar` em todas as versões. Isso não muda aqui.

## 2. Diff (sobre `9ff142e274b1`)

Commit `af2c0d451e065189378109bf7fa24b86d8bc58d9`, branch `claude/wonderful-meitner-abcnno`. Única
mudança efetiva — as mesmas 3 linhas do Compose de `696e3e9`:

```diff
--- a/infra/prod/docker-compose.prod.yml
+++ b/infra/prod/docker-compose.prod.yml
@@ -106,6 +106,9 @@ services:
     environment:
       NODE_ENV: production
       NODE_OPTIONS: --max-old-space-size=448
+      # Página comercial pública em /conheca (apps/web/components/site/config.ts). Só abre se
+      # também não houver pendência na configuração; "0" a desliga (404) sem nova imagem.
+      SITE_COMERCIAL: '1'
     mem_limit: 640m
     networks: [interna]
     logging: *logging
```

Também no pacote (testes, não executados na VM):

- `infra/prod/gcp/testes/test_conheca_ligada.sh` (novo): a única diferença efetiva no Compose resolvido
  em relação a `9ff142e274b1` é `SITE_COMERCIAL=1` no `web`; postgres (volume `pgdata_2026_11`), api,
  caddy, backup, redes, volumes e limites idênticos; o bloco `environment` do `web` é igual ao de `696e3e9`.
- `infra/prod/gcp/testes/test_deploy_banco_limpo.sh`: passa a provar o pacote `9ff142e274b1` fixo
  (variável `ALVO`) em vez do `HEAD`. Sem isso ele falharia neste commit, porque afirmava
  "/conheca desligada".

## 3. Pacote a publicar

| | |
|---|---|
| Nome | `scripts-af2c0d451e06.tar.gz` + `scripts-af2c0d451e06.sha256` |
| Destino | `gs://cenariogestao-prod-runner-versoes` (só a conta do proprietário grava) |
| Conteúdo | `git archive` de `af2c0d451e06` (`infra/prod`, `scripts/backup.sh`, `scripts/restore.sh`), `gzip -n -9`: 24 arquivos |
| SHA-256 | `1b0118436b8ffe8f1fde124b452b70e1e2b6e3f34a324f23332fec1c2f00b187` |
| Diferença para `/opt/cenario` atual (`9ff142e274b1`) | `~ docker-compose.prod.yml`, `+ testes/test_conheca_ligada.sh`, `~ testes/test_deploy_banco_limpo.sh`; vm.sh, Caddyfile, startup.sh e scripts de backup idênticos |

O mesmo método reproduz byte a byte o SHA-256 de referência de `scripts-9ff142e274b1`
(`c8c293b10ba5a5fe…`). O SHA acima é a referência que o bloco do Cloud Shell exige antes de publicar.

## 4. Impacto

- Mesmas imagens (`696e3e9`), **nenhuma migration**, banco e volumes intocados.
- `apply_stack_config` recria o proxy (alguns segundos sem resposta para todos) e depois só o `web`
  (cerca de 10–30 s: a página de manutenção do Caddy, HTTP 503, aparece no painel; os tablets mostram
  "sem conexão" e tentam de novo). API e PostgreSQL não são recriados. Prefira um horário sem uso da oficina.
- `restart_web` **não** serve: só reinicia o contêiner e não aplica a variável nova.
- Ligada, a landing fica indexável pela própria página (`<meta name="robots" content="index, follow">`).
  O Caddyfile da VM continua mandando `X-Robots-Tag: noindex` em todas as rotas, inclusive `/conheca`;
  liberar a indexação é outro pacote (o trecho do Caddyfile do commit `16d17f4`), fora deste escopo.

## 5. Etapa A — publicar o pacote (Cloud Shell, conta do proprietário)

Clona/usa o repositório, confere que o commit está na branch e parte de `9ff142e274b1`, mostra o diff,
gera o pacote, confere arquivo a arquivo contra o Git, **exige o SHA-256 de referência** e só então
publica com `--if-generation-match=0` (nunca sobrescreve). Reexecutar é seguro.

```bash
(
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=cenariogestao
COMMIT=af2c0d451e065189378109bf7fa24b86d8bc58d9
V=af2c0d451e06
RAMO=claude/wonderful-meitner-abcnno
REF=1b0118436b8ffe8f1fde124b452b70e1e2b6e3f34a324f23332fec1c2f00b187
DEST=gs://cenariogestao-prod-runner-versoes
ARVORE="$HOME/cenario-conheca-$V"
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
git -C "$CLONE" fetch origin "$RAMO"
git -C "$CLONE" merge-base --is-ancestor "$COMMIT" FETCH_HEAD || { echo "✘ $COMMIT não está em origin/$RAMO"; exit 1; }
git -C "$CLONE" fetch origin claude/deploy-banco-limpo
git -C "$CLONE" merge-base --is-ancestor 9ff142e274b1cc04953bbfb5161a7940962530d5 "$COMMIT" || { echo "✘ $COMMIT não parte do pacote em produção 9ff142e274b1"; exit 1; }
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
echo "— única mudança efetiva no Compose em relação ao pacote em produção (9ff142e274b1):"
git diff 9ff142e274b1cc04953bbfb5161a7940962530d5 "$COMMIT" -- infra/prod/docker-compose.prod.yml
SAIDA="$HOME/cenario-pacote-$V"
PAC="$SAIDA/scripts-$V.tar.gz"
SHA="$SAIDA/scripts-$V.sha256"
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
echo "✔ sha256 igual à referência revisada"
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
VER="$(mktemp -d)"
gcloud storage cp "$DEST/scripts-$V.tar.gz" "$DEST/scripts-$V.sha256" "$VER/"
[ "$(sha256sum "$VER/scripts-$V.tar.gz" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$VER/scripts-$V.sha256")" ] || { echo "✘ cópia do bucket não confere com o .sha256"; exit 1; }
cmp -s "$VER/scripts-$V.tar.gz" "$PAC" || { echo "✘ pacote no bucket difere do gerado agora"; exit 1; }
gcloud storage ls -l "$DEST/scripts-$V.tar.gz" "$DEST/scripts-$V.sha256"
echo "✔ publicado: scripts-$V ($(cat "$VER/scripts-$V.sha256"))"
echo "PUBLICAÇÃO: OK"
)
```

Esperado no final: `✔ publicado: scripts-af2c0d451e06 (1b0118436b8f…)` e `PUBLICAÇÃO: OK`.

## 6. Etapa B — aplicar (operador `claude-operador-prod`, após a autorização)

Operações nomeadas do catálogo do runner (nenhum shell na VM). Cada uma só segue se a anterior terminar
com sucesso.

```bash
export CENARIO_AMBIENTE=prod
O=infra/homolog/gcp/autonomia/operar.py
python3 $O op version                                         # antes: etiqueta 696e3e9…, /opt/cenario 9ff142e274b1
python3 $O op health                                          # antes: contêineres saudáveis, /api/ready 200
python3 $O op vm_scripts_diff version=af2c0d451e06            # tem de mostrar SÓ a linha SITE_COMERCIAL no Compose
python3 $O op gate_open
python3 $O op vm_scripts_update version=af2c0d451e06          # valida Compose/Caddyfile e guarda a cópia anterior
python3 $O op apply_stack_config                              # recria proxy + web (mesmas imagens) e roda vm.sh saude
python3 $O op gate_close
python3 $O op smoke_test                                      # verificação completa: HTTPS, /entrar 200, /api/ready, 401s, certificado
python3 $O op version                                         # depois: /opt/cenario af2c0d451e06, etiqueta 696e3e9…
```

Se `vm_scripts_diff` mostrar qualquer outra diferença, **parar** (nada foi alterado até ali).

## 7. Etapa C — validar

Pelo Cloud Shell (só leitura; passa pelo DNS e pelo certificado reais):

```bash
(
set -uo pipefail
BASE="${BASE:-https://cenariogestao.com.br}"
T="$(mktemp -d)"; F=0
ok() { echo "✔ $*"; }
falha() { echo "✘ $*"; F=$((F + 1)); }
pedir() { curl -sS --max-time 20 -o "$T/corpo" -D "$T/cab" -w '%{http_code}' -H 'Cache-Control: no-cache' "$BASE$1" 2>"$T/erro" || true; }
echo "• alvo: $BASE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"

st="$(pedir /conheca)"
[ "$st" = 200 ] && ok "/conheca: HTTP 200" || falha "/conheca: HTTP ${st:-sem resposta} $(cat "$T/erro")"
grep -q '<h1[^>]*>Feito dentro de uma tapeçaria, para tapeçarias.</h1>' "$T/corpo" && ok "/conheca mostra a landing (<h1> da landing)" || falha "/conheca sem o <h1> da landing"
grep -q 'NEXT_HTTP_ERROR_FALLBACK;404' "$T/corpo" && falha "/conheca devolveu a página 404 do Next.js" || ok "/conheca não é a página 404"
grep -q '<a[^>]*href="https://wa.me/5512996520615' "$T/corpo" && ok "/conheca com o botão do WhatsApp" || falha "/conheca sem o link do WhatsApp"
for img in inicio producao tablet financeiro; do
  st="$(pedir "/site/$img.webp")"
  [ "$st" = 200 ] && ok "/site/$img.webp: HTTP 200" || falha "/site/$img.webp: HTTP ${st:-sem resposta}"
done

st="$(pedir /entrar)"
[ "$st" = 200 ] && ok "/entrar: HTTP 200" || falha "/entrar: HTTP ${st:-sem resposta} $(cat "$T/erro")"
grep -q '<title>Entrar · Cenário Gestão</title>' "$T/corpo" && ok "/entrar mostra a tela de entrada" || falha "/entrar sem o título da tela de entrada"

st="$(pedir /api/ready)"
[ "$st" = 200 ] && ok "/api/ready: HTTP 200" || falha "/api/ready: HTTP ${st:-sem resposta} $(cat "$T/erro")"
grep -q '"status":"ready"' "$T/corpo" && ok "/api/ready: $(tr -d '\n' < "$T/corpo" | head -c 120)" || falha "/api/ready sem \"status\":\"ready\": $(head -c 200 "$T/corpo")"

echo
if [ "$F" = 0 ]; then echo "VALIDAÇÃO: OK"; else echo "VALIDAÇÃO: $F falha(s)"; fi
rm -rf "$T"
)
```

Esperado: todas as linhas com ✔ e `VALIDAÇÃO: OK`, em especial:

- `/conheca: HTTP 200`, `<h1>` da landing ("Feito dentro de uma tapeçaria, para tapeçarias."),
  não é a página 404, botão do WhatsApp e as 4 imagens `/site/*.webp` com 200;
- `/entrar: HTTP 200` com a tela de entrada;
- `/api/ready: HTTP 200` com `{"status":"ready"}`.

Do lado da VM, depois da validação: `op container_logs service=caddy lines=200 since_minutes=15`
mostra as requisições a `/conheca` com `"status":200`.

## 8. Reversão

Volta exatamente ao estado atual (`/conheca` 404). Mesmas imagens, nada de banco; mesmo impacto da
aplicação (proxy alguns segundos, `web` 10–30 s).

```bash
export CENARIO_AMBIENTE=prod
O=infra/homolog/gcp/autonomia/operar.py
python3 $O op gate_open
python3 $O op vm_scripts_restore          # /opt/cenario volta à cópia guardada pelo vm_scripts_update (9ff142e274b1)
python3 $O op apply_stack_config          # recria proxy + web sem SITE_COMERCIAL
python3 $O op gate_close
python3 $O op version                     # /opt/cenario 9ff142e274b1
python3 $O op smoke_test
```

Alternativa equivalente, se a cópia guardada não estiver disponível:
`op vm_scripts_update version=9ff142e274b1` (o pacote anterior continua no bucket) seguido de
`op apply_stack_config`. O pacote `scripts-af2c0d451e06` pode ficar no bucket: ele não é usado sem
um `vm_scripts_update` explícito.

Se `apply_stack_config` falhar no meio (ex.: o `web` não sobe), a API e o banco não foram tocados: execute
a reversão acima. `rollback_to_recovery_point` **não** é necessário (nenhum dado muda).

## 9. Evidências desta preparação (sessão sem acesso de escrita à produção)

| Verificação | Resultado |
|---|---|
| `test_conheca_ligada.sh` | OK; reprova se outra linha mudar (testado: `mem_limit`) ou se o valor for `'0'` |
| `test_deploy_banco_limpo.sh` (alvo fixo `9ff142e274b1`) | OK |
| `test_vm_sh_prod.sh`, `test_provisionar.sh` | OK |
| `test_runner_prod.py` (14 testes) | OK |
| `pacote_scripts` do runner `9ff142e`, perfil prod, sobre o pacote gerado | aceito (commit `af2c0d451e06…`, 24 arquivos); `.sha256` adulterado é recusado |
| Bloco da Etapa A com `gcloud` simulado | normal ✔; reexecução idempotente ✔; `.sha256` conflitante no bucket → nada publicado ✔; SHA divergente → nada publicado ✔ |
| `web` de `696e3e9` compilado localmente, `NODE_ENV=production` | sem `SITE_COMERCIAL`: `/conheca` 404; com `SITE_COMERCIAL=1`: 200 com a landing; `/entrar` 200 nos dois |
| Bloco da Etapa C contra os dois servidores locais | com a correção: `VALIDAÇÃO: OK`; sem: 4 falhas, todas em `/conheca` |
