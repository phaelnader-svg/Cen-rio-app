# Arquitetura — Cenário Gestão

## 1. Visão geral

Monólito modular em TypeScript, num monorepo pnpm:

```
 Navegador (painel)   Tablets (PWA)
        │  HTTPS + WebSocket (mesma origem)
        ▼
 ┌──────────────────────────────┐
 │ Proxy reverso (Caddy/nginx)  │  /api/* → API   · resto → Next.js
 └──────────────┬───────────────┘
        ┌───────┴────────┐
        ▼                ▼
  Next.js (apps/web)   API Fastify (apps/api) ──► PostgreSQL 16
  telas, PWA            módulos, regras,         dados, auditoria,
                        tempo real               eventos (outbox)
                              │
                              └──► armazenamento privado de arquivos
```

Em desenvolvimento, o próprio Next.js encaminha `/api/*` (inclusive o WebSocket) para a API,
mantendo a mesma origem para o navegador.

### Por que estas escolhas

| Decisão                                         | Motivo                                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Monólito modular** (não microsserviços)       | Uma equipe pequena, um banco, transações ACID entre módulos. Módulos isolados por pasta e contrato, prontos para crescer sem custo operacional de serviços distribuídos.                                                                     |
| **API Fastify separada do Next.js**             | O Next.js não oferece WebSocket persistente nem processos de fundo confiáveis. A API concentra regras, permissões, eventos e tempo real; o Next.js só entrega telas.                                                                         |
| **WebSocket** (e não SSE)                       | Canal bidirecional (retomada com `resume`, ping/pong de vivacidade), presença dos tablets e base para ações futuras. SSE não detecta conexões "zumbis" de Wi-Fi com a mesma precisão. Há também reconciliação por HTTP (`/api/sync/events`). |
| **PostgreSQL + Prisma**                         | Relacional, migrations versionadas, transações, `LISTEN/NOTIFY` e advisory locks usados no tempo real e na concorrência. Prisma 6 (estável); Prisma 7 foi avaliado e adiado por mudanças de configuração ainda recentes.                     |
| **Sessões opacas em cookie httpOnly** (não JWT) | Revogação imediata é requisito: cada requisição consulta a sessão no banco. JWT exigiria lista de revogação.                                                                                                                                 |
| **Next.js 15.5 / React 19 / Tailwind 4**        | Versões estáveis e maduras na data do projeto.                                                                                                                                                                                               |

## 2. Módulos da API (`apps/api/src`)

| Pasta                      | Responsabilidade                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/env.ts`            | Validação de variáveis de ambiente (falha na inicialização se inválidas; regras mais rígidas em homologação/produção).                                                                                                                   |
| `plugins/auth.ts`          | Resolve credencial do dispositivo e sessão; exige `Origin` permitido em métodos que alteram estado e no WebSocket; aplica a regra de acesso declarada em **toda** rota (`config.access`). Rota `/api` sem regra impede a API de iniciar. |
| `plugins/idempotency.ts`   | `Idempotency-Key` em operações sensíveis.                                                                                                                                                                                                |
| `plugins/error-handler.ts` | Formato único de erro `{ error: { code, message, requestId, details? } }`.                                                                                                                                                               |
| `core/audit.ts`            | Auditoria gravada na mesma transação da alteração.                                                                                                                                                                                       |
| `core/events/*`            | Eventos de domínio (outbox), fluxo de eventos e processador de automações.                                                                                                                                                               |
| `core/realtime/hub.ts`     | Conexões WebSocket, audiência, reenvio após reconexão, presença, encerramento de sessões revogadas.                                                                                                                                      |
| `core/sessions.ts`         | Criação, expiração e revogação de sessões.                                                                                                                                                                                               |
| `core/throttle.ts`         | Bloqueio progressivo contra força bruta (persistido no banco).                                                                                                                                                                           |
| `core/storage/`            | Armazenamento privado de arquivos (driver local; interface pronta para S3).                                                                                                                                                              |
| `core/locking.ts`          | `SELECT … FOR UPDATE` para controle de concorrência.                                                                                                                                                                                     |
| `core/maintenance.ts`      | Limpeza periódica (chaves de idempotência, contadores, sessões antigas).                                                                                                                                                                 |
| `modules/*`                | `auth`, `tablet`, `employees`, `roles`, `devices`, `sessions`, `company`, `audit`, `sync`, `files`, `health`, `realtime`.                                                                                                                |

Novos módulos (pedidos, OS, materiais…) entram como novas pastas em `modules/`, novas
permissões no catálogo `packages/shared/src/permissions.ts` e novos tipos de evento em
`packages/shared/src/events.ts`.

## 3. Modelo de dados (Fase 1)

| Tabela                           | Finalidade                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `users`                          | Identidade de acesso: e-mail/senha (painel) e PIN (tablets), hashes argon2id.      |
| `employees`                      | Pessoa: nomes, cargo, responsabilidades, cor e foto de identificação.              |
| `roles`, `role_permissions`      | Funções e suas permissões (catálogo definido em código).                           |
| `user_roles`, `user_permissions` | Funções de cada pessoa e concessões individuais.                                   |
| `devices`                        | Tablets/dispositivos: vínculo, credencial (hash), funcionário atribuído, presença. |
| `sessions`                       | Sessões web e de dispositivo (hash do token, expiração, revogação).                |
| `auth_throttle`                  | Contadores de tentativas e bloqueios.                                              |
| `company_settings`               | Registro único: dados da empresa e parâmetros (8h30, alerta 9h30, sextas…).        |
| `audit_logs`                     | Auditoria **imutável** (trigger bloqueia UPDATE/DELETE).                           |
| `domain_events`                  | Eventos persistentes com sequência global (`seq`).                                 |
| `event_consumers`                | Posição de cada consumidor de automações.                                          |
| `idempotency_keys`               | Respostas de operações idempotentes (24 h).                                        |
| `stored_files`                   | Metadados de arquivos privados.                                                    |

Migration única versionada: `packages/db/prisma/migrations/20261008000000_fundacao`, com
restrições adicionais em SQL (registro único de configurações, e-mails minúsculos, coerência
status×credencial do dispositivo, vínculo sessão×dispositivo, triggers de imutabilidade e de
notificação de eventos).

Entidades das próximas fases (clientes, pedidos, OS, materiais, estoque, programação,
tarefas, ocorrências, presença, qualidade, entregas) **não** foram criadas.

## 4. Eventos, concorrência e tempo real

**Gravação (outbox).** Toda alteração relevante grava, na mesma transação: os dados, a
auditoria e o evento de domínio. Um _advisory lock_ transacional serializa a gravação de
eventos, garantindo que a ordem de `seq` seja a ordem de _commit_ — nenhum leitor "pula" um
evento confirmado depois de outro com `seq` maior.

**Distribuição.** Um trigger faz `pg_notify` (entregue só após o commit). Cada instância da API
escuta (`LISTEN`) e, como contingência, varre `seq > último` a cada 2 s; assim nenhuma
notificação perdida causa perda de evento, e várias instâncias funcionam juntas.

**Audiência.** Cada evento declara quem pode recebê-lo: `all`, `permission:<p>` ou `user:<id>`.
Tablets não recebem eventos administrativos.

**Reconexão e reconciliação.**

1. O servidor envia `hello` com o `headSeq`.
2. O cliente responde `resume` com o último `seq` que recebeu (ou `null` na primeira conexão,
   quando recarrega os dados).
3. O servidor reenvia os eventos perdidos (filtrados pela audiência) e envia `replay.done`;
   eventos ao vivo que chegam durante o reenvio ficam em espera e são entregues em seguida,
   sem duplicação.
4. Se o intervalo passa de 500 eventos, ou o cursor é desconhecido (ex.: banco restaurado), o
   servidor pede `resync.required` e o cliente recarrega tudo.

O cliente (`apps/web/lib/realtime.tsx`) reconecta com espera exponencial, envia ping a cada
20 s (sem resposta em 10 s → reconecta), reage a `online`/`visibilitychange` e invalida as
consultas afetadas por cada evento. **A interface nunca é atualizada por estado local
"simulado": toda mudança vem do servidor.**

**Revogação imediata.** `session.revoked` e `device.revoked` fazem o hub enviar
`session.ended` e fechar a conexão (código 4401). Além disso, as sessões conectadas são
revalidadas a cada 60 s.

**Concorrência.** Entidades editáveis têm `version`. A atualização bloqueia a linha
(`FOR UPDATE`), compara a versão e responde `409 VERSION_CONFLICT` se alguém alterou antes.
Regras globais (ex.: "sempre existe um gestor ativo") usam advisory lock.

**Automações confiáveis.** `EventProcessor` entrega eventos a consumidores em ordem, um por
vez; bloqueio, leitura do próximo evento, execução e avanço do checkpoint acontecem na mesma
transação (exatamente uma vez para efeitos no banco). Falhas não avançam o checkpoint e são
repetidas com espera exponencial. Não há consumidores de produção na Fase 1; a base está
pronta para reprogramações e distribuição de ajuda (Fase 2+). Notificações do navegador não
são usadas como garantia de execução.

## 5. Frontend (`apps/web`)

- `/entrar`, `/painel/*`: painel responsivo (desktop e celular), navegação lateral, módulos
  futuros listados como indisponíveis (sem link).
- `/tablet`: vinculação por código, escolha do funcionário, teclado de PIN, tela inicial com
  identificação visual (cor/foto), relógio, indicador de conexão e áreas preparadas para
  tarefas, presença, materiais e ocorrências. Botões grandes para tablets de 10–11".
- PWA: `manifest.webmanifest` (início em `/tablet`), service worker que **nunca** guarda
  respostas da API e mostra página offline quando não há rede.
- Permissões no frontend só escondem elementos; o servidor sempre decide.

## 6. Fluxo operacional suportado (próximas fases)

A fundação já acomoda: funcionários e funções da oficina (tapeceiros, cabeceiras/qualidade,
ajudante) e concessões individuais (ex.: tapeceiro autorizado a medir); tablets individuais
com sessão permanente; parâmetros de expediente (botão "Cheguei" 8h30, alerta 9h30
configurável, sem efeito trabalhista); dia de programação e de medição (sextas); eventos e
consumidores para reprogramação automática, distribuição de ajuda e central de atenção.
A equipe de logística terceirizada (André e Izaías) ainda não tem acesso — será tratada no
módulo de logística.
