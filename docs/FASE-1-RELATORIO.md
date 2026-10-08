# Fase 1 — Fundação: relatório de entrega

Data: 08/10/2026 · Branch: `claude/cenario-gestao-fase-1-zf3bj2`

O repositório estava vazio no início (sem código a preservar).

## 1. Arquitetura implementada

Monólito modular TypeScript: API Fastify + PostgreSQL/Prisma, frontend Next.js (painel e
PWA dos tablets), pacote compartilhado de permissões/validações/eventos, eventos de domínio
persistentes (outbox) com distribuição em tempo real por WebSocket e reconciliação após
reconexão. Detalhes e justificativas: [ARQUITETURA.md](ARQUITETURA.md).

## 2. Tecnologias e versões

| Item                                                         | Versão           |
| ------------------------------------------------------------ | ---------------- |
| Node.js / pnpm                                               | 22 / 10.28       |
| TypeScript (estrito)                                         | 5.9.3            |
| Next.js / React                                              | 15.5.27 / 19.2.8 |
| Tailwind CSS                                                 | 4.3.3            |
| TanStack Query                                               | 5.104            |
| Fastify (+ cookie, helmet, rate-limit, websocket, multipart) | 5.12.5           |
| PostgreSQL / Prisma                                          | 16 / 6.19.3      |
| zod                                                          | 4.1.13           |
| argon2 (`@node-rs/argon2`)                                   | 2.2.2            |
| Vitest / Playwright                                          | 3.2.7 / 1.56.1   |
| ESLint / Prettier                                            | 9.39 / 3.6       |

## 3. Entidades e migrations

Migration `20261008000000_fundacao`: `users`, `employees`, `roles`, `role_permissions`,
`user_roles`, `user_permissions`, `devices`, `sessions`, `auth_throttle`, `company_settings`,
`audit_logs` (imutável), `domain_events` (imutável + `pg_notify`), `event_consumers`,
`idempotency_keys`, `stored_files`, com restrições de integridade em SQL.

Seed idempotente: 4 funções padrão (Gestor, Tapeceiro, Cabeceiras/reparos/qualidade,
Ajudante), configurações da empresa (8h30, alerta 9h30, seg–sex, programação e medição às
sextas), conta do gestor **somente** a partir de `SEED_ADMIN_*` e a equipe informada
(Ricardo, Márcio, Thiago, João) **sem PIN** — o gestor define os acessos pelo painel. Nenhum
dado de cliente foi criado.

## 4. Telas

**Painel** (desktop e celular): Entrar · Início (indicadores, equipe com status do tablet,
atividade recente, roteiro de fases) · Funcionários (cadastro, edição, funções, permissões
individuais, PIN, acesso ao painel, foto, ativar/desativar) · Funções e permissões ·
Dispositivos e sessões (cadastro, código de vinculação, revincular, revogar, excluir, sessões
ativas com encerramento remoto) · Empresa · Auditoria (filtro e paginação) · Sincronização
(diagnóstico) · Minha conta (troca de senha). Módulos futuros aparecem como "Próximas fases",
sem link.

**Tablet** (PWA, 10–11"): Vincular tablet · Quem está usando? · Teclado de PIN · Início com
identificação (cor/foto/nome/cargo/tablet), relógio, indicador de tempo real, botão Sair,
cartões "Disponível na próxima fase" para Minhas tarefas, Presença, Materiais e Ocorrências ·
Teste de sincronização. Página offline e service worker sem cache de dados.

## 5. APIs

| Método e rota                                                                                                                                                          | Acesso                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/health`, `GET /api/ready`                                                                                                                                    | público                              |
| `POST /api/auth/login`                                                                                                                                                 | público (limitado)                   |
| `POST /api/auth/logout`, `GET /api/auth/me`                                                                                                                            | qualquer sessão                      |
| `POST /api/auth/password`                                                                                                                                              | painel                               |
| `GET /api/tablet/status`, `POST /api/tablet/pair`                                                                                                                      | público (limitado)                   |
| `POST /api/tablet/login`                                                                                                                                               | dispositivo vinculado                |
| `GET /api/employees`, `GET /api/employees/:id`                                                                                                                         | `funcionarios.ver`                   |
| `POST /api/employees` (idempotente), `PUT /api/employees/:id`, `POST …/:id/status`, `PUT/DELETE …/:id/pin`, `PUT/DELETE …/:id/admin-access`, `POST/DELETE …/:id/photo` | `funcionarios.gerenciar`             |
| `GET /api/permissions`, `GET /api/roles`                                                                                                                               | `funcoes.ver`                        |
| `POST /api/roles` (idempotente), `PUT/DELETE /api/roles/:id`                                                                                                           | `funcoes.gerenciar`                  |
| `GET /api/devices`                                                                                                                                                     | `dispositivos.ver`                   |
| `POST /api/devices` (idempotente), `PUT/DELETE /api/devices/:id`, `POST …/:id/pairing-code` (idempotente), `POST …/:id/revoke`                                         | `dispositivos.gerenciar`             |
| `GET /api/sessions` / `POST /api/sessions/:id/revoke`                                                                                                                  | `sessoes.ver` / `sessoes.revogar`    |
| `GET` / `PUT /api/company/settings`                                                                                                                                    | `empresa.ver` / `empresa.configurar` |
| `GET /api/audit`                                                                                                                                                       | `auditoria.ver`                      |
| `POST /api/sync/signal` (idempotente)                                                                                                                                  | `sincronizacao.diagnosticar`         |
| `GET /api/sync/status`, `GET /api/sync/events`                                                                                                                         | qualquer sessão                      |
| `GET /api/files/:id`                                                                                                                                                   | sessão + política do arquivo         |
| `GET /api/realtime` (WebSocket)                                                                                                                                        | qualquer sessão + origem permitida   |

Rotas do painel exigem também `painel.acessar`; rotas usadas em tablets, `producao.acessar`.

## 6. Permissões configuradas

`painel.acessar`, `producao.acessar`, `funcionarios.ver`, `funcionarios.gerenciar`_,
`funcoes.ver`, `funcoes.gerenciar`_, `dispositivos.ver`, `dispositivos.gerenciar`_,
`sessoes.ver`, `sessoes.revogar`_, `empresa.ver`, `empresa.configurar`_, `auditoria.ver`,
`sincronizacao.diagnosticar` (_ = crítica).

| Função                          | Permissões                                       |
| ------------------------------- | ------------------------------------------------ |
| Gestor (protegida)              | todas                                            |
| Tapeceiro                       | `producao.acessar`, `sincronizacao.diagnosticar` |
| Cabeceiras, reparos e qualidade | idem                                             |
| Ajudante                        | idem                                             |

Permissões operacionais das próximas fases (ex.: medição extraordinária, inspeção de
qualidade) serão adicionadas ao catálogo junto com os módulos e concedidas por função ou
individualmente.

## 7. Testes executados e resultados

Todos executados neste ambiente em 08/10/2026, contra PostgreSQL 16 real:

| Suíte                                                                 | Resultado                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| API — integração (Vitest, 9 arquivos)                                 | **68/68 aprovados** (repetida 3 vezes, estável)                   |
| Pacote compartilhado — unitários                                      | **7/7**                                                           |
| Web — unitários                                                       | **3/3**                                                           |
| Ponta a ponta (Playwright, Chromium, build de produção do Next.js)    | **7/7**                                                           |
| Backup + restauração (`pnpm test:backup`)                             | **aprovado** (contagens idênticas, auditoria imutável preservada) |
| Lint, Prettier, typecheck (5 pacotes), builds de produção (API e web) | **sem erros**                                                     |

Cobertura dos itens obrigatórios:

| Requisito                                 | Onde                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Criação e autenticação de usuários        | `auth.test.ts`, `admin.spec.ts`                                                  |
| Permissões administrativas e operacionais | `permissions.test.ts`                                                            |
| Sessões persistentes                      | `devices.test.ts`, `tablet-sync.spec.ts` (recarregar/reabrir navegador)          |
| Revogação de sessões e dispositivos       | `devices.test.ts`, `realtime.test.ts`, `tablet-sync.spec.ts`                     |
| Cadastro de dispositivos                  | `devices.test.ts`, `tablet-sync.spec.ts`                                         |
| Proteção de rotas                         | `permissions.test.ts`, `admin.spec.ts`                                           |
| Validação de dados                        | `validation.test.ts`, `schemas.test.ts`, `env.test.ts`                           |
| Migrations                                | `migrations.test.ts` (banco recriado do zero + `migrate deploy` a cada execução) |
| Sincronização entre sessões               | `realtime.test.ts`, `tablet-sync.spec.ts`                                        |
| Reconexão                                 | `realtime.test.ts`, `tablet-sync.spec.ts`                                        |
| Tratamento de erros                       | `validation.test.ts`                                                             |
| Concorrência e idempotência               | `validation.test.ts`, `processor.test.ts`                                        |

Defeitos encontrados pelos testes e corrigidos durante a fase: processador de eventos podia
pular evento com várias instâncias concorrentes; tela do tablet não avançava após a
vinculação; script de teste de restauração não detectava ausência do trigger com banco vazio.

## 8. Pendências e limitações

- **CI (GitHub Actions)** criado em `.github/workflows/ci.yml`, mas **não executado** (não há
  execução de Actions a partir deste ambiente).
- **Imagens Docker/deploy:** não há daemon Docker neste ambiente; o `docker-compose.yml`
  (PostgreSQL local) e o `infra/Caddyfile.example` não foram executados aqui. Nenhum deploy
  foi feito.
- Testes E2E executados apenas em Chromium (desktop e viewport de tablet com toque); não
  foram testados Safari/iPadOS nem tablets físicos.
- Limite geral de requisições em memória (por instância).
- Foto de funcionário: sem redimensionamento automático (limite de 5 MB).
- Logística terceirizada sem acesso nesta fase.
- Fontes: pilha de fontes do sistema (sem download externo).

## 9. Evidências de sincronização

Teste E2E `sinais de sincronização e reconciliação após queda de conexão` (navegadores
separados para painel e tablet, servidores reais):

1. Sinal enviado pelo tablet aparece no painel identificado como "Tablet Márcio"; sinal do
   painel aparece no tablet.
2. A conexão do tablet é derrubada e **bloqueada** (simulação de Wi-Fi caído); o indicador
   muda para "Reconectando…".
3. O painel envia os sinais nº 2 e nº 3; o tablet não os recebe.
4. A rede volta; o tablet reconecta sozinho, informa o último evento recebido e o servidor
   reenvia exatamente os 2 eventos perdidos, marcados "recuperado após reconexão"; o contador
   "Recuperados após reconexão" mostra 2 e o último evento do tablet fica igual ao do painel.

Testes de integração complementares: reenvio de 3 eventos perdidos sem duplicação e com
continuidade ao vivo; filtro de audiência; ressincronização completa para intervalos > 500
eventos e para cursor desconhecido; encerramento imediato (código 4401) do WebSocket ao revogar
a sessão; evento de presença do tablet. A alteração do nome de um funcionário no painel aparece
no tablet sem recarregar (E2E).

## 10. Próximos passos recomendados (Fase 2 — aguardando autorização)

1. Clientes, pedidos comerciais e solicitação de retirada (logística).
2. Recebimento da peça e criação da OS técnica.
3. Presença operacional: "Cheguei", alerta configurável, encerramento de expediente com
   registro de andamento (sem efeitos trabalhistas).
4. Primeiros consumidores de eventos (central de atenção).
5. Executar o CI no GitHub, definir hospedagem e domínio, gerar imagens de deploy e
   configurar backups agendados com cópia externa.
