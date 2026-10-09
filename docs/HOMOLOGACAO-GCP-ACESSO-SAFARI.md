# Homologação GCP — Acesso pelo Safari: investigação, correção e validação

Objetivo: abrir `https://teste.cenariogestao.com.br`, passar pelo proxy e chegar à tela de entrada do
Cenário Gestão. Este ambiente **não tem acesso ao Google Cloud**: o que foi provado localmente está
separado do que precisa ser verificado na VM real. Nenhum segredo aparece neste documento.

## 1. Conclusão

| Item                                                                                          | Situação                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Caddy → cookie → Next.js → `/entrar` → login → painel → WebSocket, com a senha do proxy certa | **Funciona** (provado localmente, mesma configuração e imagens `fd6dc19`)                              |
| Defeito 1: o proxy anunciava HTTP/3 (`Alt-Svc: h3`) sem UDP 443 publicado nem liberado        | **Corrigido** no Caddyfile (só HTTP/1.1 e HTTP/2)                                                      |
| Defeito 2: 401 do proxy com corpo vazio (Safari mostra página em branco)                      | **Corrigido** (página explicativa, sem segredos, mantendo o pedido de senha)                           |
| Defeito 3: `vm.sh saude` dava "OK" sem testar a senha do proxy (entrava direto com o cookie)  | **Corrigido** (testa senha do proxy → cookie → `/entrar` → JavaScript)                                 |
| Causa exata no seu Safari                                                                     | **A confirmar na VM** com `operador.sh acesso` (log do Caddy: senha recusada × aceita × nunca enviada) |
| Reconstruir imagens?                                                                          | **Não.** Só configuração da VM (Caddyfile e scripts); banco, API e web intocados                       |

A causa raiz **mais provável** é uma de duas, e o diagnóstico na VM separa as duas sem expor segredos:

1. **Credencial do proxy recusada.** O diálogo do Safari pede o usuário `homologacao` (minúsculo,
   sem acento) e a senha **do proxy**. O e-mail e a senha do gestor só servem depois, na tela
   `/entrar`. Com qualquer outra combinação o proxy responde 401 e repete o pedido; ao cancelar,
   o Safari mostrava uma página **em branco** (o 401 não tinha corpo), o que corresponde à captura.
   Também cai aqui um hash desatualizado: o segredo do proxy trocado depois do `gerar-env`.
2. **HTTP/3 anunciado e inalcançável.** Toda resposta trazia `Alt-Svc: h3=":443"; ma=2592000`, mas
   o Docker publica só `443/tcp` e o firewall libera `tcp:80,tcp:443`. O Safari guarda o anúncio
   por 30 dias e tenta QUIC primeiro. O Chromium deste ambiente não reproduz efeito disso; o
   defeito é real e foi eliminado de qualquer forma.

## 2. Provado localmente

Pilha real (`docker-compose.homolog.yml` + `Caddyfile.homolog`) com as imagens `fd6dc19`, banco
novo e dados fictícios.

**Fluxo no navegador (Playwright/Chromium)**, com a senha do proxy certa:

- `/` → 307 → `/entrar`, com o título "Entrar no painel" e os campos de e-mail e senha.
- Cookie do proxy gravado com `Secure`, `HttpOnly`, `SameSite=Lax` e `Path=/`.
- 0 erros de JavaScript, 0 erros de hidratação, 0 requisições falhas e 0 recursos com erro. A única
  resposta 401 é `/api/auth/me` antes do login: é a aplicação verificando a sessão.

**Login do gestor fictício:** abre `/painel`, grava a sessão `__Host-cen_sid` e o WebSocket
`/api/realtime` responde 101.

**Só com o cookie, sem reenviar a senha** (como o Safari pode fazer): `/entrar` e todos os arquivos
carregam.

**Recusas (401, nenhum cookie gravado):**

- usuário = e-mail do gestor;
- `Homologacao` com maiúscula;
- senha do gestor no diálogo do proxy.

**Cabeçalhos:**

| Situação          | Antes                             | Depois                                                                  |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------- |
| sem credencial    | 401, corpo 0 bytes, `Alt-Svc: h3` | 401, página HTML explicativa, `WWW-Authenticate` mantido, sem `Alt-Svc` |
| senha certa       | 307 + cookie, `Alt-Svc: h3`       | 307 + cookie, sem `Alt-Svc`                                             |
| 401 da API (JSON) | JSON                              | JSON (inalterado; a página nova é só do proxy)                          |
| 404               | 404                               | 404                                                                     |

**Regressão:** o teste automatizado novo **falha** com o Caddyfile antigo, exatamente no
`Alt-Svc: h3`, e passa com o novo.

**Diagnóstico com acessos simulados de um iPhone/Safari** (um cancelado, uma senha do gestor e um
`Homologacao`): o resultado foi "0 aceitas · 2 recusadas COM senha enviada · 1 pedido de senha" e a
leitura "o Safari ENVIOU usuário/senha e o proxy RECUSOU".

**`saude` novo:**

- passa com a pilha correta;
- acusa "hash desatualizado" quando o segredo do proxy não corresponde ao hash em uso (a versão
  antiga dizia OK nesse caso).

**`aplicar-config`:**

- recria só o Caddy (os IDs de postgres, api, web e backup não mudam);
- recusa um Caddyfile inválido sem tocar no proxy em execução;
- recusa com o portão fechado.

Não provado aqui: o comportamento do Safari/WebKit real (o ambiente não tem WebKit) e o estado da VM.

## 3. Correções (commit desta entrega)

- `infra/homolog/Caddyfile.homolog`:
  - `servers { protocols h1 h2 }`;
  - `handle_errors 401` com página HTML explicativa (não revela o usuário nem segredos).
- `infra/homolog/gcp/vm.sh`:
  - `saude` testa o caminho real do navegador;
  - `diagnosticar-acesso [horas]` faz a leitura de configuração, segredo e log, sem imprimir segredos;
  - `aplicar-config` valida o Caddyfile e recria só o proxy.
- `infra/homolog/gcp/operador.sh`:
  - `acesso [horas]` roda o diagnóstico com o `vm.sh` deste commit pela entrada padrão, sem gravar
    nada na VM;
  - `atualizar-config` leva à VM só a configuração, guarda a cópia anterior e chama `aplicar-config`.
- Testes:
  - `tests/e2e/homolog/acesso-proxy.spec.ts`: 5 testes do fluxo completo; rodam também contra a VM;
  - `infra/homolog/gcp/testes/test_vm_sh.sh` (cenário E): leitura do log de acesso.

## 4. Testes executados

| Teste                                                | Resultado                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `acesso-proxy.spec.ts` (5) — Caddyfile novo          | 5 passaram (duas execuções, antes e depois de recriar o Caddy) |
| `acesso-proxy.spec.ts` — Caddyfile antigo            | teste 1 falha em `Alt-Svc: h3` (regressão detectada)           |
| `test_vm_sh.sh` (inclui o cenário E novo)            | OK                                                             |
| `test_homolog_sh.sh`                                 | OK                                                             |
| `caddy validate` e `caddy fmt`                       | válido e formatado                                             |
| ShellCheck (warning), ESLint, `tsc` do E2E, Prettier | OK                                                             |

## 5. Procedimento na VM

São três passos. Só o passo 2 altera algo, e só com a sua autorização.

```bash
# 1. Evidência (SÓ LEITURA): o que aconteceu com as tentativas do seu Safari nas últimas 48 h
cd ~/Cen-rio-app && git pull origin claude/cenario-gestao-fase-1-zf3bj2 && bash infra/homolog/gcp/operador.sh acesso 48

# 2. Correção (com autorização): configuração nova na VM, recria SÓ o proxy e roda a saúde completa
bash infra/homolog/gcp/operador.sh atualizar-config        # digite: sim
```

O passo 1 mostra se a senha do proxy em uso confere com o segredo e se o proxy anuncia HTTP/3. Ele
também traz as últimas tentativas: status, se a senha foi enviada e se havia cookie.

Se o passo 1 indicar **hash desatualizado**, rode antes do passo 2:
`gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap --command='sudo /opt/cenario/infra/homolog/gcp/vm.sh gerar-env'`.

3. **No iPhone:**
   - Em Ajustes → Safari → Avançado → Dados dos Sites, remova `cenariogestao.com.br`. Isso apaga o
     anúncio de HTTP/3 e a credencial recusada que o Safari guardou.
   - Abra `https://teste.cenariogestao.com.br`.
   - No diálogo do proxy, digite `homologacao` e a senha do proxy. Para vê-la no Cloud Shell, use
     `bash infra/homolog/gcp/operador.sh mostrar-credencial proxy`.
   - Na tela "Entrar no painel", use o e-mail e a senha do gestor (`mostrar-credencial gestor`).

**Reversão do passo 2:** a cópia anterior fica em `/opt/cenario.anterior-<data>`. Restaure-a em
`/opt/cenario` e rode `vm.sh aplicar-config`.

**Validação opcional** pelo Cloud Shell ou por um computador com Node: rode o mesmo teste
automatizado contra a VM real.

- Comando: `HOMOLOG_WEB_URL=https://teste.cenariogestao.com.br` mais as variáveis do proxy e do
  gestor, e `npx playwright test -c playwright.homolog.config.ts homolog/acesso-proxy.spec.ts`
  (em `tests/e2e`).
- Coloque as senhas nas variáveis sem digitá-las na linha de comando: use `read -s`.
