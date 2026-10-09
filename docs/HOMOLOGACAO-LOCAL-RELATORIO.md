# Homologação local — relatório

> Execução de 09/10/2026 (madrugada, horário de Brasília), sobre o commit `cb12ff9` da branch
> `claude/cenario-gestao-fase-1-zf3bj2`. Sem deploy, sem serviços contratados, sem infraestrutura
> externa, só dados fictícios. Nenhuma migration foi alterada. Todos os resultados abaixo vêm de
> execuções reais; o que não foi possível testar está dito explicitamente.

## 1. Ambiente utilizado

| Item               | Valor                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Máquina            | Contêiner temporário do Claude Code na nuvem (Linux, 4 vCPU, 16 GB), sem acesso de entrada |
| Node.js / pnpm     | 22.22.0 / 10.28.0                                                                          |
| PostgreSQL         | 16.15 local (iniciado com `service postgresql start`), escutando só em 127.0.0.1:5432      |
| Navegador de teste | Chromium do Playwright 1.56 (painel, 4 tablets 1280×800 com toque, celular 390×844)        |
| Código             | `cb12ff9` + as mudanças desta homologação (§7 e §10)                                       |

Documentos lidos antes: `docs/FASE-12-RELATORIO.md`, `docs/HOMOLOGACAO.md`, `docs/OPERACAO.md`.

## 2. Serviços iniciados

| Serviço                       | Como                                                       | Endereço           |
| ----------------------------- | ---------------------------------------------------------- | ------------------ |
| PostgreSQL 16                 | Serviço local; banco **exclusivo** `cenario_homolog_local` | 127.0.0.1:5432     |
| API Fastify + WebSocket       | Build de produção (`node apps/api/dist/server.js`)         | 127.0.0.1:4200     |
| Web Next.js (painel e tablet) | Build de produção em `.next-homolog` (`next start`)        | 127.0.0.1:3200     |
| Tempo real                    | WebSocket `/api/realtime`, encaminhado pela web à API      | via 127.0.0.1:3200 |
| Armazenamento de arquivos     | Diretório privado `.homolog-local/storage`                 | local              |

Verificado: as três portas escutam **somente** em 127.0.0.1; uma conexão pelo endereço do
contêiner (192.0.2.2:3200) foi **recusada**. Nada foi exposto à rede.

Os demais bancos do ambiente (`cenario_dev`, `cenario_test`, `cenario_e2e_test`,
`cenario_perf_test`) não foram tocados pela instância de homologação; as suítes automatizadas usam
os bancos de teste próprios delas (que elas mesmas recriam).

## 3. Configurações

Geradas por `scripts/homolog-local.sh preparar` em `.homolog-local/env` (ignorado pelo Git e pelo
Docker; permissões 600):

| Variável              | Valor na homologação                                       |
| --------------------- | ---------------------------------------------------------- |
| `APP_ENV`             | `development` (HTTP em loopback; `staging` exige HTTPS)    |
| `NODE_ENV`            | `production` (builds otimizados)                           |
| `DATABASE_URL`        | servidor local, banco `cenario_homolog_local`              |
| `API_HOST`/`API_PORT` | `127.0.0.1` / `4200`                                       |
| `ALLOWED_ORIGINS`     | `http://127.0.0.1:3200`, `http://localhost:3200`           |
| `COOKIE_SECURE`       | `false` (HTTP local)                                       |
| `TOKEN_HASH_SECRET`   | gerado na hora (`openssl rand`), exclusivo desta instância |
| `STORAGE_DIR`         | `.homolog-local/storage`                                   |
| Gestor de teste       | `gestor@homolog.local`, senha aleatória gerada na hora     |

Configuração da empresa feita pela homologação (fictícia): expediente 00:00–23:59, todos os dias
— para os tablets poderem registrar "Cheguei" e executar tarefas em qualquer horário de teste
(o relógio de teste só existe em `APP_ENV=test`).

O perfil `staging` com HTTPS (Caddy, cookie `__Host-` Secure, HSTS) foi verificado na Fase 12 com
a pilha Docker (`FASE-12-RELATORIO.md` §17); nesta homologação local ele não foi repetido.

## 4. Dados sintéticos

- **Seed**: funções e permissões, configurações, checklists de qualidade, gestor de teste e a
  equipe fictícia (Ricardo, Márcio, Thiago, João, André, Izaías — sem PIN).
- **`scripts/homolog-dados-sinteticos.mjs`** (pela API HTTP): 5 clientes fictícios, cada um com
  pedido, recebimento das peças e OS aberta.
- **Roteiro ao vivo** (§5): por execução, mais 1 cliente/pedido/OS, programação com 4 tarefas, PINs
  e dispositivos dos 4 tablets e do celular do André, 1 inspeção aprovada e 1 cobrança.

Estado final do banco de homologação: 8 clientes, 8 pedidos, 8 OS (16 peças), 38 tarefas,
14 dispositivos, 2 inspeções, 2 cobranças, 365 eventos de domínio, 155 registros de auditoria,
12 migrations. (Inclui os registros de uma primeira execução do roteiro que parou num erro do
próprio script de teste — §8.)

## 5. Testes executados

### 5.1 Verificação ao vivo da instância (`tests/e2e/homolog/homologacao-local.spec.ts`)

Playwright contra a instância já em execução (sem recriar banco nem subir outros servidores).
Executado duas vezes completo — a segunda depois de parar e reiniciar os serviços — **3/3 nas
duas**:

| #   | Etapa                                                                                                                                                    | Resultado |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | API: `health` e `ready`; rota protegida anônima → 401; login com origem estranha → 403; senha errada → 401; CSP e `X-Frame-Options`                      | OK        |
| 2   | Login do gestor no painel; tempo real conectado                                                                                                          | OK        |
| 3   | Cliente → pedido → recebimento → OS fictícios pela API                                                                                                   | OK        |
| 4   | Programação semanal com 4 tarefas (Ricardo, Márcio, João, Thiago) publicada                                                                              | OK        |
| 5   | PIN, cadastro do dispositivo, vinculação e entrada por PIN nos 4 tablets                                                                                 | OK        |
| 6   | "Cheguei" e início **simultâneo** nos 4 tablets; quadro do painel atualizado                                                                             | OK        |
| 7   | Tablets sem valores financeiros na tela; rotas financeiras → 403                                                                                         | OK        |
| 8   | Tablet do Márcio sem rede enquanto o gestor muda a prioridade; ao voltar, "Prioridade urgente" aparece **sem recarregar**; tarefa continua uma única vez | OK        |
| 9   | João e Ricardo concluem; a inspeção chega ao tablet do Thiago em tempo real                                                                              | OK        |
| 10  | Thiago aprova a inspeção pela sessão do tablet; painel mostra "Aprovada"                                                                                 | OK        |
| 11  | Celular do André (390 px): PIN, pedidos → 403, sem valores                                                                                               | OK        |
| 12  | Cobrança registrada; financeiro do painel aberto                                                                                                         | OK        |
| 13  | 24 telas do painel × desktop e celular (48 visitas): sem erro de JS, com título, sem rolagem horizontal                                                  | OK        |

### 5.2 Suítes automatizadas do projeto

| Suíte              | O que cobre                                                                         | Resultado            |
| ------------------ | ----------------------------------------------------------------------------------- | -------------------- |
| `pnpm check`       | Formatação, lint, typecheck e testes de unidade/integração (API, shared, web)       | Passou: 295 + 53 + 6 |
| `pnpm build`       | Build de produção da API e da web                                                   | Passou               |
| `pnpm test:backup` | Backup + restauração num banco temporário, arquivo real, backup adulterado recusado | Passou               |
| `pnpm test:e2e`    | 13 specs no navegador (painel, tablets, 4 tablets simultâneos, auditoria visual)    | **21/21** (6,0 min)  |

O **fluxo operacional completo (32 passos)** — cliente, pedido, retirada pela logística,
recebimento, OS, medição, compra, chegada do material, programação, 4 tablets, ajuda, ocorrência,
inspeção com reprovação e correção, embalagem, entrega, financeiro e resultado da OS — roda em
`apps/api/test/full-flow.test.ts`, dentro do `pnpm check`, num banco de teste isolado.

### 5.3 Backup e restauração do banco de homologação

`scripts/backup.sh` sobre `cenario_homolog_local` e `scripts/restore.sh` num banco temporário
(`cenario_homolog_local_restore`, apagado em seguida). Contagens idênticas na origem e no
restaurado: clientes 7, OS 7, tarefas 21, dispositivos 9, inspeções 1, auditoria 103, sequência de
eventos 231, migrations 12 (medido no meio da sessão, antes da segunda execução do roteiro). A
instância não tinha arquivos enviados nesse momento; a restauração de arquivos é coberta pelo
`pnpm test:backup`.

## 6. Resultados

- Verificação ao vivo: **3/3**, duas execuções completas, 14 etapas registradas cada.
- E2E do projeto: **21/21**; auditoria visual com 144 combinações tela × tamanho: 0 erros de JS,
  0 erros de console, 0 rolagens horizontais, 0 telas sem título.
- `pnpm build`: passou. `pnpm test:backup`: passou ("Backup e restauração verificados").
- `pnpm check`: **passou** — formatação, lint, typecheck e testes: API 30 arquivos / 295 testes
  (inclui o fluxo completo de 32 passos e as auditorias de segurança, integridade e
  sincronização), shared 53, web 6. Duas tentativas anteriores pararam na formatação e no lint dos
  arquivos novos desta homologação (§8), não em testes.
- Log da API após o reinício (1.749 linhas durante a segunda execução): 0 erros, 0 avisos.

## 7. Evidências

`docs/evidencias/homologacao-local/`:

- `resultado.json` — etapas e resultados da última execução ao vivo; `telas.json` — as 48 visitas.
- Capturas: `painel-inicio`, `painel-quadro-producao`, `painel-inspecao-aprovada`,
  `painel-financeiro`, `tablet-Ricardo`, `tablet-Márcio`, `tablet-João`, `tablet-Thiago`,
  `tablet-Márcio-reconectado`, `celular-André`, `desktop-sincronizacao`, `celular-sincronizacao`.

Arquivos que tornam a homologação repetível: `scripts/homolog-local.sh`,
`tests/e2e/playwright.homolog.config.ts`, `tests/e2e/homolog/homologacao-local.spec.ts`.

## 8. Problemas encontrados

| Problema                                                                                     | Tipo                  | Tratamento                                                                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `next build` com outro diretório de saída reescrevia `apps/web/tsconfig.json`                | Ferramenta            | `.next-homolog/types` incluído no `tsconfig` (o Next deixa de alterá-lo)                                                        |
| ESLint e Prettier passaram a analisar o build `.next-homolog` (código minificado) e falhavam | Configuração          | `.next-homolog` e `.homolog-local` nos ignores de ESLint, Prettier, Git e Docker                                                |
| Primeira execução do roteiro: o teste clicava em "Cheguei" antes de o cartão carregar        | Script de teste       | Espera explícita pelo cartão de presença. Os registros dessa tentativa ficaram no banco (tarefas "Liberada" visíveis no quadro) |
| Uma execução parcial (`-g "1. API"`) sobrescreveu `resultado.json`                           | Procedimento          | Roteiro completo executado de novo; evidências regeneradas por execução real                                                    |
| PID da web gravado no diretório errado (primeira versão do script)                           | Script de homologação | Corrigido; ciclo parar/iniciar verificado                                                                                       |

**Nenhum defeito do sistema** foi encontrado nesta homologação.

## 9. Acesso pelo celular (Safari do iPhone)

**Neste ambiente (contêiner temporário do Claude Code): não é possível.**

- O contêiner não recebe conexões de fora: o endereço dele (192.0.2.2) é de uma faixa reservada
  para documentação, não roteável pela internet nem pela sua Wi-Fi, e a saída de rede passa por um
  proxy só de saída.
- A única forma seria um túnel público, que **não foi criado** (exige sua autorização e exporia o
  sistema à internet).
- **Duração:** o contêiner existe enquanto esta sessão estiver ativa e é recolhido depois de um
  período sem uso ou quando a sessão termina. Não há prazo garantido; tudo nele (banco de
  homologação, arquivos, segredos gerados) desaparece. O código e as evidências estão no Git.

**Num computador seu, na mesma Wi-Fi do iPhone (procedimento seguro):**

1. Requisitos: Node 22.12+, pnpm 10, PostgreSQL 16 local; clonar a branch; `pnpm install`;
   `.env` com `DATABASE_URL` do PostgreSQL local (veja o README).
2. Descobrir o IP do computador na rede local (ex.: `192.168.0.25`; macOS: Ajustes → Wi-Fi →
   Detalhes; Windows: `ipconfig`).
3. Preparar e iniciar só na rede local:
   ```bash
   HOMOLOG_BIND=192.168.0.25 bash scripts/homolog-local.sh preparar
   bash scripts/homolog-local.sh iniciar
   ```
   A web passa a escutar em `192.168.0.25:3200`; **a API e o banco continuam só em 127.0.0.1**.
4. No iPhone (mesma Wi-Fi): Safari → `http://192.168.0.25:3200/painel` (gestor) ou
   `http://192.168.0.25:3200/tablet` (código de vinculação + PIN). Opcional: Compartilhar →
   Adicionar à Tela de Início.
5. Cuidados:
   - Só em rede confiável (casa/oficina), nunca em Wi-Fi pública; não abrir portas no roteador.
   - Permitir a porta 3200 no firewall do computador **apenas** para a rede local; ao terminar,
     `bash scripts/homolog-local.sh parar`.
   - É HTTP sem criptografia: usar só dados fictícios e a senha gerada de teste.
   - Limitações do HTTP no iPhone: o modo offline (service worker) e alguns recursos que o Safari
     só libera em HTTPS não funcionam; "Adicionar à Tela de Início" funciona, mas sem o cache
     offline. Para testar esses pontos, usar a pilha com HTTPS (`docs/HOMOLOGACAO.md`, que exige
     um certificado confiável no iPhone ou um domínio de teste).

Nenhum desses passos foi executado aqui; o acesso real pelo iPhone continua **não testado**.

## 10. Instruções para repetir a homologação

```bash
service postgresql start                                  # se o PostgreSQL não estiver rodando
bash scripts/homolog-local.sh preparar                    # banco exclusivo, variáveis, migrations, seed, build
bash scripts/homolog-local.sh iniciar                     # 127.0.0.1:4200 (API) e 127.0.0.1:3200 (web)

set -a; source .homolog-local/env; set +a                 # dados sintéticos pela API
HOMOLOG_URL=$HOMOLOG_WEB_URL HOMOLOG_EMAIL=$SEED_ADMIN_EMAIL HOMOLOG_PASSWORD=$SEED_ADMIN_PASSWORD \
  node scripts/homolog-dados-sinteticos.mjs 5

cd tests/e2e && pnpm exec playwright test -c playwright.homolog.config.ts && cd ../..   # roteiro ao vivo
pnpm check && pnpm build && pnpm test:backup && pnpm test:e2e                           # suítes do projeto

bash scripts/homolog-local.sh status                      # endereços e conta do gestor
bash scripts/homolog-local.sh parar                       # encerra os serviços (mantém os dados)
bash scripts/homolog-local.sh apagar                      # encerra e APAGA o banco e .homolog-local
```

- O roteiro ao vivo cria registros novos a cada execução (nomes com carimbo de data) e nunca
  apaga nada; para recomeçar do zero, `apagar` e `preparar`.
- A senha do gestor de teste fica em `.homolog-local/env` (gerada na hora, nunca versionada).
- O script recusa bancos sem `homolog` no nome.
- Para o uso manual: abra `http://127.0.0.1:3200/painel` no navegador do próprio computador.

**Situação ao final desta sessão:** a instância continua em execução neste contêiner temporário
(até ele ser recolhido), sem acesso de fora.
