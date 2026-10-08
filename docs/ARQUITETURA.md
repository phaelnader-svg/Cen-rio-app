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

**Módulos da Fase 2** (rotas versionadas em `/api/v1`):

| Pasta                    | Responsabilidade                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `modules/customers`      | Clientes PF/PJ, endereços (arquivados, nunca apagados), pesquisa, duplicidade, histórico. |
| `modules/orders`         | Pedido comercial e peças; valores restritos; cancelamento.                                |
| `modules/pickups`        | Solicitação, agenda e linha do tempo das retiradas (máquina de estados).                  |
| `modules/receipts`       | Recebimento físico (parcial ou completo) com proteção contra duplicidade.                 |
| `modules/service-orders` | OS técnica, itens individualizados, medições, materiais previstos, histórico técnico.     |
| `modules/attachments`    | Fotografias dos registros, com política de acesso por tipo de registro.                   |
| `modules/commercial`     | Utilitários comuns (números legíveis, cópia de endereço, situação derivada do pedido).    |

**Módulos da Fase 3** (rotas em `/api/v1`):

| Pasta                  | Responsabilidade                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `modules/measurements` | Medições (rotina de sexta e extraordinárias), atribuição/delegação, rascunho, envio, revisão, aprovação, devolução, reabertura, histórico. |
| `modules/materials`    | Lista consolidada de materiais aprovados (tela, cópia e CSV) e planejamento de sexta.                                                      |

Novos módulos entram como novas pastas em `modules/`, novas permissões no catálogo
`packages/shared/src/permissions.ts` e novos tipos de evento em `packages/shared/src/events.ts`.

**Versionamento da API.** As rotas de domínio criadas a partir da Fase 2 ficam em `/api/v1/…`.
As rotas de infraestrutura da Fase 1 (`/api/auth`, `/api/tablet`, `/api/realtime`, cadastros
de pessoas e dispositivos) permanecem sem prefixo para não quebrar clientes existentes; uma
versão futura incompatível receberá `/api/v2` em paralelo.

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

**Fase 2** (migration `20261008100000_comercial_oficina`, puramente aditiva):

| Tabela                                                             | Finalidade                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `customers`, `customer_addresses`                                  | Clientes e endereços de atendimento (CPF/CNPJ único quando informado; um endereço principal).                                                    |
| `commercial_orders`, `commercial_order_items`                      | Pedido comercial, peças e quantidades recebidas (`recebido ≤ quantidade` no banco).                                                              |
| `pickup_requests`, `pickup_request_items`, `pickup_events`         | Retiradas, peças a retirar e linha do tempo imutável. Campo `external_reference` e origem `INTEGRACAO` preparados para a logística terceirizada. |
| `receipts`, `receipt_lines`                                        | Recebimentos físicos (imutáveis) com condição, localização e divergências.                                                                       |
| `service_orders`, `service_order_items`, `service_order_revisions` | OS técnica, itens com código individual (`OS-00012/3`), medições e histórico técnico imutável.                                                   |
| `material_requirements`                                            | Materiais previstos por OS (estrutura para Fase 3; tecido sempre `EXCLUSIVO_OS` por restrição no banco).                                         |
| `attachments`                                                      | Vínculo de fotos (`stored_files`) aos registros.                                                                                                 |

**Fase 3** (migration `20261008200000_medicoes_materiais`, aditiva):

| Tabela                                        | Finalidade                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measurements`                                | Tarefa de medição (`MD-00001`): OS, peça opcional, tipo, responsável, quem pediu, prazo, motivo, situação, início/conclusão/cancelamento, `version`. Uma ativa por peça/OS (índice parcial). |
| `measurement_pieces`                          | Medidas por peça (rascunho do executor), copiadas para a OS no envio.                                                                                                                        |
| `material_requests`, `material_request_items` | Solicitação de materiais (1:1 com a medição) e itens estruturados: tecido, espuma, outros; quantidade `NUMERIC(12,3)`, unidade, densidade/espessura/dimensões. Sem preço nem fornecedor.     |
| `measurement_revisions`                       | Histórico **imutável** (trigger) com cópia dos itens a cada envio, revisão, aprovação, devolução e reabertura.                                                                               |
| `material_requirements` (ampliada)            | Recebe as necessidades **aprovadas** (`origin = SOLICITACAO_APROVADA`, vínculo único ao item da solicitação) — base para compras na Fase 4.                                                  |

Restrições no banco: unidade compatível com o tipo (tecido em metros; espuma em placas, peças
ou m²), quantidade > 0 e inteira fora de m/m², tecido sempre `EXCLUSIVO_OS`, motivo obrigatório
na extraordinária, coerência de cancelamento/conclusão, versões positivas.

Pedidos, retiradas e OS guardam **cópia** do endereço combinado; números legíveis (`PC-`,
`RT-`, `RC-`, `OS-`) vêm de sequências do banco (podem ter lacunas após transações desfeitas).

Migration da Fase 1: `packages/db/prisma/migrations/20261008000000_fundacao`, com
restrições adicionais em SQL (registro único de configurações, e-mails minúsculos, coerência
status×credencial do dispositivo, vínculo sessão×dispositivo, triggers de imutabilidade e de
notificação de eventos).

Entidades das próximas fases (compras, estoque completo, programação, tarefas, ocorrências, presença,
qualidade, entregas) **não** foram criadas.

### Fluxo comercial → oficina (Fase 2)

```
Cliente ─► Pedido comercial ─► Retirada (agenda + linha do tempo) ─► Recebimento físico ─► OS técnica
                │                       │                                  │
                └── situação derivada ◄─┴──────── peças recebidas ─────────┘
```

- **Situação do pedido** é calculada (aguardando retirada → retirada agendada → recebido
  parcialmente → recebido), exceto o cancelamento (manual, com motivo).
- **Retirada:** transições manuais validadas; "Recebida na oficina" só pelo recebimento físico.
- **Recebimento:** bloqueia as linhas do pedido (`FOR UPDATE`), confere o saldo pendente por
  peça e só então grava; o banco também impede ultrapassar a quantidade. Recebimentos
  simultâneos do mesmo saldo: um é aceito, os demais recebem 409.
- **OS técnica:** só aceita quantidades efetivamente recebidas e ainda não alocadas em OS ativa
  (mesmo bloqueio). Antes do recebimento, a criação é recusada (422).
- **Medições:** de rotina quando o gestor (`os.gerenciar`) mede no dia configurado (sexta);
  caso contrário — ou por tapeceiro com `medicoes.extraordinarias` — extraordinária.
  _(Fase 3: o registro direto na OS passou a ser exclusivo do painel com `os.gerenciar`; o
  tapeceiro mede pela medição atribuída.)_
- **Prontidão para produção** é apenas informativa; `canStartProduction` é sempre `false`
  nesta fase. Não existe rota que inicie produção, e materiais previstos não disparam nada.

### Medições e solicitações de materiais (Fase 3)

```
Peça recebida (OS aberta) ─► Medição atribuída ─► Em andamento (rascunho) ─► Concluída + Solicitação enviada
                                                                                   │
                                     Devolvida (motivo) ◄── Em revisão (gestor) ◄──┘
                                          │                     │
                                          └── corrigida e reenviada   └─► Aprovada para compra ─► necessidades aprovadas da OS
```

- **Rotina de sexta:** atribuída a quem tem `medicoes.gerenciar` (gestor), com prazo no dia de
  medição configurado. **Extraordinária:** exige motivo e pode ser delegada a quem tem
  `medicoes.extraordinarias` ("Executar medições atribuídas").
- **Só o responsável executa** (inclusive o gestor: ninguém altera a medição de outra pessoa).
  O gestor reatribui, cancela ou, após o envio, ajusta as quantidades pela revisão auditada.
- **Envio** conclui a tarefa, copia as medidas para as peças da OS (com revisão `MEDICAO` no
  histórico técnico) e envia a solicitação. **Aprovação** (`materiais.aprovar`) significa
  apenas "quantidades conferidas": materializa as necessidades da OS; não registra compra nem
  recebimento e não libera produção (`canStartProduction` continua `false`).
- **Reabertura** de uma aprovação volta para revisão e remove as necessidades aprovadas
  (nunca há alteração silenciosa de solicitação aprovada).
- **Consolidação** (`consolidateMaterials`, função pura testada): itens de compra exclusiva
  (sempre o tecido) só se somam dentro da mesma OS; materiais comuns de estoque somam entre OS
  por especificação + unidade, preservando a origem (OS, peça, medição) de cada quantidade.

## 4. Eventos, concorrência e tempo real

**Gravação (outbox).** Toda alteração relevante grava, na mesma transação: os dados, a
auditoria e o evento de domínio. Um _advisory lock_ transacional serializa a gravação de
eventos, garantindo que a ordem de `seq` seja a ordem de _commit_ — nenhum leitor "pula" um
evento confirmado depois de outro com `seq` maior.

**Distribuição.** Um trigger faz `pg_notify` (entregue só após o commit). Cada instância da API
escuta (`LISTEN`) e, como contingência, varre `seq > último` a cada 2 s; assim nenhuma
notificação perdida causa perda de evento, e várias instâncias funcionam juntas.

**Audiência.** Cada evento declara quem pode recebê-lo: `all`, `permission:<p>` ou `user:<id>`,
combináveis com `|` (basta atender a uma — ex.: recebimentos interessam a quem vê pedidos _ou_
registra recebimentos). Tablets não recebem eventos administrativos. Eventos da Fase 2
(`customer.*`, `order.*`, `pickup.*`, `receipt.registered`, `service_order.*`,
`attachment.changed`) carregam apenas identificadores, números e situações — nunca valores,
documentos, telefones ou endereços; o cliente recarrega os dados pela API com suas permissões.
Eventos da Fase 3 (`measurement.assigned/started/updated/completed/cancelled`,
`material_request.submitted/in_review/revised/approved/returned/reopened`) vão para a gestão
(`medicoes.gerenciar`, `materiais.ver`, `materiais.aprovar`) **e** para o usuário responsável
(`user:<id>`) — o tablet de outro tapeceiro não os recebe.

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
- Fase 3: `/painel/medicoes` (aguardando medição, lista com filtros, aguardando revisão),
  `/painel/medicoes/[id]` (ações de gestão e revisão, totais por OS, histórico),
  `/painel/planejamento` (checklist de sexta) e `/painel/materiais` (lista consolidada, cópia,
  CSV). No tablet, a área **Medições atribuídas** usa o mesmo editor em etapas
  (`components/measurements/measurement-editor.tsx`) em modo ampliado.
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
