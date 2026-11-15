# Firma Viva

**Firma Viva** é o jogo de gestão como produto independente: endereço, login, banco e servidor
próprios. **Cenário Estofados** é a primeira empresa (organização) dentro dele. **Cenário Gestão**
é a integração disponível na Central de Conexões: com ela conectada, o mapa mostra e opera a
empresa real. Outra empresa que entrar vê o nome da própria organização.

| Ambiente                    | Endereço do jogo                                                                                                       | Retorno da conexão com o Cenário Gestão                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Local (desenvolvimento)     | `http://localhost:3100`                                                                                                | `http://localhost:3100/api/conexoes/cenario/retorno`    |
| Prévia privada (provisório) | `https://<FIRMA_DOMAIN provisório>` (ex.: `previa.firmaviva.com.br`, ou `firma.<IP-da-VM>.sslip.io` até o DNS existir) | `https://<FIRMA_DOMAIN>/api/conexoes/cenario/retorno`   |
| Produção                    | `https://firmaviva.com.br`                                                                                             | `https://firmaviva.com.br/api/conexoes/cenario/retorno` |

Tudo é configurado por ambiente (`FIRMA_WEB_URL`, `CENARIO_API_URL`, `CENARIO_WEB_URL`,
`FIRMA_CENARIO_REDIRECT_URI` — padrão `<FIRMA_WEB_URL>/api/conexoes/cenario/retorno`).

## Peças

| Onde                                    | O quê                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/firma-viva`                       | Web (Next.js, porta 3100): entrar, convite, recuperar senha, jogo (`/jogo`), organização (`/organizacao`). O jogo saiu de `apps/web`.                                                                                  |
| `apps/firma-api`                        | API própria (Fastify, porta 4100): contas, organizações, papéis, convites, senha, planta, agentes, metas, conexão com o Cenário e repasse das ações operacionais.                                                      |
| `packages/firma-db`                     | Banco próprio (PostgreSQL `firma_viva`): pessoas, sessões, organizações, associações, convites, recuperações, plantas e histórico, configurações (agentes/metas), conexão (tokens **selados** AES-256-GCM), auditoria. |
| Cenário Gestão (`apps/api`, `apps/web`) | Autorização delegada OAuth 2.0 + PKCE (`/autorizar`, `/api/oauth/*`), "Aplicativos conectados" para revogar, acesso por token com permissões = usuário ∩ escopos. Continua dono dos registros operacionais.            |

## Quem guarda o quê

- **Cenário Gestão**: OS, produção, etapas, funcionários, tablets, materiais, estoque, reservas,
  compras, financeiro, documentos. Todo registro operacional continua lá e só muda pelas rotas
  oficiais (o Firma Viva chama a API do Cenário; nunca o banco).
- **Firma Viva**: pessoas, organizações, convites, plantas (Tapeçaria, Escritório e outros
  ambientes, com histórico), estações e personagens, configurações dos agentes e metas do Quadro.
  Com a empresa conectada, cada gravação de planta/agente passa pelo Cenário (que valida os
  vínculos com funcionários, localizações e materiais) e a cópia do Firma Viva é atualizada — por
  isso, ao desconectar, a planta continua aberta.

## Autorização (Cenário Gestão → Firma Viva)

1. No jogo, **Central de Conexões → Conectar Cenário Gestão** (só Dono/Administrador).
2. O navegador vai para a **tela oficial do Cenário** (`/autorizar`). Sem sessão, o Cenário pede
   login **na tela dele** — a senha nunca passa pelo Firma Viva.
3. A tela mostra a empresa que o usuário pode vincular, a organização do Firma Viva e as
   permissões pedidas (Planta e agentes · Operação da oficina · Escritório e financeiro).
4. **Autorizar** devolve um código de uso único; o servidor do Firma Viva troca o código (PKCE S256
   - segredo do cliente) por um token de acesso (1 h) e um token de renovação (90 dias, girado a
     cada uso). Os dois ficam selados no banco do Firma Viva; o navegador nunca os vê.
5. O cartão mostra empresa, quem autorizou, permissões, conexão e última sincronização, com
   **Reconectar** e **Desconectar**.

- O aplicativo nunca tem mais permissão que o usuário que autorizou; **iniciar/concluir etapa**
  (tablet), administração, sessões e dispositivos nunca são liberados.
- **Desconectar** revoga no Cenário e apaga os tokens. **Revogar** no Cenário (Aplicativos
  conectados) ou expirar: o Firma Viva suspende as ações integradas, mostra "Reconectar Cenário
  Gestão" e mantém a planta.
- Cada ação feita pelo jogo fica auditada **nos dois lados**: no Cenário com
  `[via Firma Viva · <organização> · <pessoa>]`; no Firma Viva com pessoa, organização e empresa.
- Uma empresa só pode estar vinculada a **uma** organização do Firma Viva.

## Organizações, papéis e isolamento

- Acesso só por convite (sem cadastro aberto). Papéis: **Dono**, **Administrador** (convida,
  conecta), **Gestor** (opera: planta, agentes, ações na empresa) e **Membro** (só acompanha).
- Cada requisição confere no servidor a associação da pessoa à organização aberta; plantas,
  convites e conexão são sempre filtrados pela organização. Uma pessoa da organização B não abre a
  OS da empresa A nem pelo ID (a requisição usa a conexão da própria organização B), não edita a
  planta de A e não aciona a integração de A. Testado em `apps/firma-api/test/firma-viva.test.ts`.

## Rodar localmente

```bash
pnpm install
pnpm db:migrate && pnpm db:firma:migrate     # bancos cenario_dev e firma_viva_dev
# Cadastra o Firma Viva como aplicativo autorizado no Cenário (segredo lido da variável, nunca impresso):
pnpm --filter @cenario/api app-client -- --id firma-viva --name "Firma Viva" \
  --redirect http://localhost:3100/api/conexoes/cenario/retorno --scopes jogo,operacao,escritorio \
  --secret-env FIRMA_CENARIO_CLIENT_SECRET
pnpm dev                                     # Cenário :3000/:4000 e Firma Viva :3100/:4100
```

### Criar o primeiro usuário

```bash
pnpm --filter @firma/api criar-organizacao -- --organizacao "Cenário Estofados" --email voce@exemplo.com
```

Imprime o **link de convite do dono** (vale 7 dias). Abra, escolha nome e senha e você entra como
Dono. Depois, em **Organização**, convide as outras pessoas. Enquanto não houver provedor de e-mail,
os e-mails (convite e "Esqueci minha senha") ficam na caixa de saída (`outbox_mails`); fora de
produção o link do convite também aparece na tela para quem convidou.

## Configurar a Cenário Estofados real

1. **No Cenário Gestão (produção)**: publicar a versão com a migration
   `20270330000000_autorizacao_aplicativos` e cadastrar o aplicativo:
   `pnpm --filter @cenario/api app-client -- --id firma-viva --name "Firma Viva" --redirect https://firmaviva.com.br/api/conexoes/cenario/retorno[,https://<prévia>/api/conexoes/cenario/retorno] --scopes jogo,operacao,escritorio --secret-env FIRMA_CENARIO_CLIENT_SECRET`
   e definir `GAME_WEB_URL=https://firmaviva.com.br` (volta do jogo depois de conectar canais da Meta).
2. **No Firma Viva**: `FIRMA_CENARIO_CLIENT_SECRET` com o mesmo segredo (Secret Manager),
   `CENARIO_API_URL` e `CENARIO_WEB_URL` apontando para o Cenário de produção, `FIRMA_WEB_URL`
   com o endereço do jogo, `FIRMA_SEAL_KEY` e `FIRMA_TOKEN_HASH_SECRET` novos.
3. Criar a organização "Cenário Estofados" com o comando acima e aceitar o convite.
4. No jogo: Central de Conexões → **Conectar Cenário Gestão** → entrar com o gestor **na tela do
   Cenário** → Autorizar. Na primeira conexão, como a Cenário já tem planta configurada, o Firma
   Viva **traz a planta, os agentes e as metas do Cenário** (nada se perde); se a organização tinha
   montado outra planta antes, ela fica no histórico.
5. Para outra empresa: outra organização e outro Cenário (ou outro sistema no futuro); uma
   empresa não pode ser vinculada a duas organizações.

## O que publicar onde

| Publicar                 | O quê                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cenário Gestão (API)** | Migration de autorização de aplicativos; rotas `/api/oauth/authorize(/info)`, `/api/oauth/token`, `/api/oauth/revoke`, `/api/v1/apps/me`, `/api/v1/apps/grants(/:id/revoke)`; token Bearer no plugin de autenticação; auditoria "via"; `GAME_WEB_URL`; correção da mesa de agente movida para estação nova. |
| **Cenário Gestão (web)** | Tela `/autorizar`, página "Aplicativos conectados", login com retorno (`?proximo=`); menu "Empresa virtual" e rota `/jogo` removidos.                                                                                                                                                                       |
| **Firma Viva**           | `apps/firma-api` + `packages/firma-db` (migration inicial) e `apps/firma-viva`, com o próprio banco e o próprio domínio. Imagens: `infra/homolog/Dockerfile` alvos `firma-api` e `firma-web`; pilha em `infra/firma-viva/` (Compose + Caddy com `FIRMA_DOMAIN`).                                            |

## Versão de teste em firmaviva.com.br (hospedagem separada)

Pilha própria em `infra/firma-viva/teste/` — **outra VM, outro IP e outro banco**; não toca a
homologação nem a produção do Cenário Gestão. Inclui um **Cenário Gestão de teste** com empresa
fictícia (equipe, OS, tablets) só para a autorização e o mapa. Tudo com dados fictícios.

```bash
# No Cloud Shell, na raiz do repositório, na branch que quer publicar:
bash infra/firma-viva/teste/firma-teste.sh subir --dono <seu-email>
```

O comando reserva um IP fixo, cria a VM `firma-teste` (e2-standard-2, Debian 12, Docker), envia o
código do último commit, gera os segredos **na VM** (`/opt/firma-teste/.env`, só root), constrói as
imagens, sobe PostgreSQL + Cenário de teste + Firma Viva + Caddy (HTTPS automático), cria os dados
fictícios e imprime:

- o **link provisório** `https://firma.<IP-com-hífens>.sslip.io` (funciona sem DNS);
- o **convite de dono** da organização "Cenário Estofados" para o e-mail informado;
- o login do gestor do **Cenário de teste** (`https://cenario.<IP>.sslip.io`) para autorizar a conexão
  e os códigos/PIN dos tablets fictícios;
- os **registros DNS exatos** (com o IP reservado): `A @ → IP`, `A www → IP` (TTL 300) e,
  opcionalmente, `CAA @ 0 issue "letsencrypt.org"`. Sem AAAA.

Depois que o DNS propagar: `bash infra/firma-viva/teste/firma-teste.sh validar` — confere que
`firmaviva.com.br` aponta para o IP, ativa o domínio (o provisório continua valendo), espera o
certificado e valida **HTTPS, redirecionamento http→https, página de login, login com a conta de
validação, sessão, abertura do `/jogo`, planta carregando, cookie Secure/HttpOnly e www → domínio**.
Outros comandos: `dns`, `status`, `atualizar`, `convite <email>`, `destruir`.

**Ensaio feito antes de publicar** (mesmas imagens e o mesmo Compose, com certificado interno no
lugar do Let's Encrypt): as quatro imagens constroem; os seis serviços sobem saudáveis; app
cadastrado, dados fictícios, contas e convite criados pelos comandos do script; todas as
verificações do `validar` passaram; no navegador, convite → conta do dono → jogo → tela oficial do
Cenário de teste → conectado com 5 peças no mapa, sem erros de console
(`docs/evidencias/firma-viva/ensaio-teste/`). O ensaio encontrou e corrigiu um defeito real: a API
do Firma Viva não iniciava na imagem (cliente do banco empacotado de forma incompatível).

## Testes e evidências

- `apps/api/test/autorizacao-aplicativos.test.ts` (6): tela oficial exige login, PKCE, código de
  uso único, segredo/verificador errados, recusa, permissões = usuário ∩ escopos, rotação do
  token de renovação, revogação pelo painel e pelo aplicativo, auditoria "via".
- `apps/firma-api/test/firma-viva.test.ts` (5, com o Cenário real em processo): planta antes de
  conectar, conexão pela tela oficial, OS no mapa, atribuição pelo jogo e início no tablet,
  revogação/desconexão suspendendo só as ações integradas, isolamento entre organizações,
  convite/papéis/recuperação de senha e origem bloqueada.
- Navegador: `docs/evidencias/firma-viva/demo-playwright.cjs` e capturas `01`–`16` (entrar,
  conectar, empresa no mapa, atribuição → tablet → em execução, desconectar, organização B).

## Pendências conhecidas

- **E-mail**: falta configurar um provedor para enviar convites e recuperação de senha (hoje ficam
  na caixa de saída `outbox_mails`).
- **Tempo real**: o jogo consulta os eventos do Cenário a cada 3 s (sem WebSocket entre domínios).
- **Planos e cobrança**: não implementados (fora do escopo desta etapa).
- O bloqueio de tentativas de login é por instância (memória); em várias instâncias, mover para o banco.
