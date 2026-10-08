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

**Módulos da Fase 4** (rotas em `/api/v1`, pasta `modules/purchasing`):

| Arquivo              | Responsabilidade                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `suppliers.ts`       | Cadastro simples de fornecedores.                                                                                     |
| `purchase-orders.ts` | Central de compras (necessidades aprovadas), pedidos de compra, confirmação/cancelamento, excedente autorizado.       |
| `receipts.ts`        | Recebimento de materiais com conferência e divergências, reserva automática na chegada, estorno compensatório.        |
| `stock.ts`           | Catálogo de materiais comuns, saldos, ajustes, saídas, movimentações e reservas por OS.                               |
| `leftovers.ts`       | Sobras por OS, transferência autorizada, prontidão de materiais (lista e por OS).                                     |
| `common.ts`          | Bloqueios, alteração de saldo validada, cálculo do andamento de cada necessidade e da prontidão (`refreshReadiness`). |

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

**Fase 4** (migration `20261009000000_compras_estoque`, aditiva):

| Tabela                                                            | Finalidade                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `suppliers`                                                       | Fornecedores (nome, contato, categorias).                                                                           |
| `purchase_orders`, `purchase_order_items`, `purchase_allocations` | Pedido de compra (`CP-`), itens com preço em centavos e **origem** de cada quantidade (necessidade aprovada da OS). |
| `purchase_order_history`                                          | Histórico imutável do pedido.                                                                                       |
| `material_receipts`, `material_receipt_lines`                     | Recebimento (`RM-`) imutável: recebido conforme × com problema, conferência e divergência.                          |
| `material_receipt_reversals`                                      | Estornos (lançamentos compensatórios) com motivo, responsável e impacto.                                            |
| `stock_items`, `stock_movements`, `stock_reservations`            | Catálogo de materiais comuns (`MT-`), saldo físico/reservado, movimentações imutáveis e reservas por OS.            |
| `material_leftovers`, `material_leftover_transfers`               | Sobras da OS de origem e transferências autorizadas (imutáveis).                                                    |
| `service_orders.materials_readiness`                              | Última prontidão calculada (para detectar mudanças e publicar eventos).                                             |

Restrições no banco: estoque nunca negativo e reservado ≤ físico; tecido não entra no catálogo
comum e só é comprado como exclusivo da OS; item exclusivo sempre com OS e item de estoque sempre
com material do catálogo; recebido líquido ≤ pedido + excedente autorizado; inteiros fora de
m/m²; sinal da movimentação coerente com o tipo; triggers de imutabilidade.

Pedidos, retiradas e OS guardam **cópia** do endereço combinado; números legíveis (`PC-`,
`RT-`, `RC-`, `OS-`) vêm de sequências do banco (podem ter lacunas após transações desfeitas).

Migration da Fase 1: `packages/db/prisma/migrations/20261008000000_fundacao`, com
restrições adicionais em SQL (registro único de configurações, e-mails minúsculos, coerência
status×credencial do dispositivo, vínculo sessão×dispositivo, triggers de imutabilidade e de
notificação de eventos).

Entidades das próximas fases (programação, tarefas, ocorrências, presença,
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

### Compras, recebimento e estoque híbrido (Fase 4)

```
Necessidade aprovada (Fase 3) ─► Pedido de compra (rascunho → confirmado pelo gestor)
        │                                   │
        │          tecido / exclusivo ──────┼──► recebido e conferido = da OS (nunca de outra)
        │          material comum ──────────┴──► entra no estoque ─► reserva para as OS de origem
        └────────────────────────────────────────────────► prontidão de materiais da OS
```

- **Compras** só a partir de necessidades **aprovadas** de OS abertas, sem comprar mais que o
  aprovado (bloqueio das necessidades). Tecido/exclusivo: uma OS por linha. Materiais comuns:
  uma linha consolidada com várias origens; o material do catálogo é localizado (ou criado) pela
  especificação.
- **Recebimento** por qualquer funcionário (painel ou tablet), sem preços: só o recebido
  conforme e conferido conta; o restante vira divergência. Acima do pedido só com excedente
  autorizado pelo gestor. Bloqueio do pedido e dos itens impede recebimento duplicado.
- **Estoque**: `changeStock` altera saldo físico/reservado de um material bloqueado e grava a
  movimentação; duas OS nunca reservam a mesma quantidade. Ao receber uma compra consolidada, o
  que entrou é reservado para as OS de origem (na ordem das origens).
- **Estorno**: lançamento compensatório (o recebimento original não muda); recusado se deixaria
  o estoque negativo ou abaixo do reservado.
- **Prontidão** (`readinessOf`/`refreshReadiness`): calculada a partir de medições abertas,
  solicitações pendentes, compras confirmadas, recebidos conformes, reservas e transferências —
  nunca marcada à mão. Recalculada na mesma transação de cada alteração relevante (inclusive
  medições/aprovações da Fase 3); a mudança publica `material.readiness_changed`.
  Material completo não inicia produção: o início é decidido tarefa a tarefa pelo motor de
  liberação da Fase 5 (`canStartProduction` da OS continua `false`).
- **Sobras** ficam na OS de origem; transferência só com `estoque.autorizar`, motivo e
  especificação compatível (tecido de outra referência/cor é recusado).

### Motor de produção e planejamento semanal (Fase 5)

```
Planejamento (rascunho) ─► publicar ─► tarefas BLOQUEADA ─► motor de liberação ─► PROGRAMADA / LIBERADA
   OS + modelo + ajustes      revisão 1          │                 ▲   (OS ativa, peça recebida,
                                                  │                 │    publicada, responsável,
   alterações após publicar ─► nova revisão       │                 │    dependências, materiais,
   (snapshot imutável: quem, quando, motivo)      ▼                 │    sem bloqueio, horário)
                                  tablet: Iniciar → Andamento/Pausar/Retomar → Concluir
                                                                    │
                                    conclusão ─► reavalia as dependentes na mesma transação
```

- **Planejamento** (`production_plans`, uma por semana — segunda-feira, CHECK no banco): rascunho
  → publicado. Sexta é o dia padrão (`planningWeekday` da empresa), mas qualquer dia é aceito e a
  revisão registra `off_schedule`. Depois de publicado, toda alteração (responsável, horário,
  prioridade, dependências, inclusão/retirada de etapa ou OS) exige motivo e grava uma
  `production_plan_revisions` com o _snapshot_ anterior (imutável por trigger).
- **Modelos** (`production_templates` + `production_template_steps`): etapas sugeridas por tipo
  de peça (sofá, cabeceira, cadeira/poltrona), com papel (principal/apoio), exigência de
  materiais, etapa opcional e dependências por posição (somente de etapas anteriores). Ao incluir
  uma OS, as tarefas são geradas por peça; etapas opcionais não são criadas para fabricação e as
  dependências são refeitas transitivamente. O gestor retira, inclui e reorganiza etapas em cada OS.
- **Tarefas** (`production_tasks`, código `TP-00001`): estados `RASCUNHO` (só no planejamento não
  publicado), `BLOQUEADA`, `PROGRAMADA`, `LIBERADA`, `EM_EXECUCAO`, `PAUSADA`, `CONCLUIDA`,
  `CANCELADA`; motivos de bloqueio em `blockers`. CHECKs garantem consistência (iniciada exige
  responsável e início; concluída exige término; progresso 0–100). Eventos de tarefa
  (`production_task_events`) são imutáveis.
- **DAG explícito** (`task_dependencies`): várias dependências por tarefa, só dentro da mesma OS,
  ciclos recusados (`findCycle`). Dependência cancelada conta como satisfeita.
- **Responsável principal**: cada OS com sofá exige um tapeceiro principal; corte de tecido e
  costura ficam obrigatoriamente com ele. Ajudantes são atribuídos explicitamente (não há
  distribuição automática). A conclusão de uma tarefa de apoio nunca conclui a principal.
- **Motor de liberação** (`reevaluateTasks` em `modules/production/common.ts`): única via que muda
  BLOQUEADA/PROGRAMADA/LIBERADA. Roda ao publicar, ao alterar a tarefa, ao concluir/cancelar uma
  dependência, ao mudar a prontidão de materiais (`onReadinessChanged`) e a cada 30 s
  (`releaseDueTasks`, para horários que chegaram). O `start` refaz toda a verificação no banco,
  sob bloqueio da linha — o estado salvo e o tablet não são confiáveis por si.
- **Cancelamento de OS** (`protectCancelledServiceOrder`): cancela as tarefas abertas, retira a
  OS dos rascunhos e libera as reservas ativas de estoque, na mesma transação do cancelamento.

### Interface operacional dos tablets e avisos (Fase 6)

- **Meu dia** (`/tablet`): a tela inicial de cada funcionário (Ricardo, Márcio, Thiago, João) mostra
  a tarefa em execução, a próxima liberada e as tarefas do dia na ordem: em execução → pausadas →
  liberadas (urgentes primeiro) → programadas → bloqueadas; próximos dias e concluídas hoje. Só as
  tarefas do próprio usuário (dependências aparecem por nome e responsável, para entender a espera).
- **Execução simplificada**: Iniciar com um toque no cartão; Concluir com um toque + confirmação
  (sem formulário) quando a etapa não exige registro. A etapa pode exigir observação ou foto
  (`completion_requirement`, definido no modelo ou na tarefa) — só então o campo aparece.
- **Andamento** estruturado (observação, % opcional, etapa atual, próximo passo, fotos da tarefa
  como anexos `PRODUCTION_TASK`); o histórico guarda cada registro.
- **Pausa** com motivo rápido e marcação de **impedimento**, que grava `pause_impediment` e o evento
  `production.task_impediment` — ponto de integração da futura central de atenção (não implementada).
- **Avisos** (`notifications`): gravados na mesma transação da mudança que os gera, únicos por
  usuário e chave (`user_id`, `dedupe_key`), com lida/não lida. Tipos: tarefa atribuída, retirada,
  liberada, reprogramada, prioridade alterada, bloqueada, cancelada, etapa anterior concluída e
  OS atualizada. Atribuição e liberação na mesma versão geram um único aviso; quem fez a ação não é
  avisado sobre ela (exceto a liberação da própria próxima tarefa).
- **Materiais por tarefa** (`production_task_materials`): a tarefa pode ser vinculada a materiais
  aprovados específicos da OS; então é liberada quando **esses** materiais estão cobertos (ex.: corte
  com o tecido, enquanto a costura espera o restante), desde que não haja medição ou solicitação
  pendente. Sem vínculos, continua valendo a OS inteira (regra conservadora da Fase 5). A regra vale
  no motor de liberação, no `iniciar` e nos conflitos do planejamento.
- **Sem conexão**: aviso fixo, dados já carregados continuam visíveis e todos os botões de ação ficam
  desativados (nada é "salvo" localmente); na reconexão o hub reenvia os eventos perdidos e as
  consultas são recarregadas.

### Presença operacional e disponibilidade (Fase 7)

Presença **operacional** para organizar a produção — não é registro de ponto, não calcula
jornada, folha, descontos nem penalidades.

- **Registro do dia** (`operational_attendances`, único por funcionário e data operacional no fuso
  da empresa): situação (presente, ausência presumida/confirmada/justificada, atestado informado,
  folga, férias, trabalho externo, encerrado), chegada (horário do servidor, quem, dispositivo,
  "no horário"/"atraso"/"após ausência presumida", minutos de atraso), saída (antecipada ou não,
  observação) e a disponibilidade atual. CHECKs garantem a coerência (ex.: encerrado exige saída;
  saída depois da chegada).
- **Histórico imutável** (`attendance_corrections`, trigger): cada chegada, saída, ausência
  presumida e registro do gestor guarda o estado anterior e o novo, com justificativa, autor e
  dispositivo. Correções nunca apagam o original.
- **Configuração** (empresa): janela do "Cheguei" (07:00), início previsto (08:30), ausência
  presumida (09:30), fim do expediente (18:00), tolerância para avisar atraso (15 min) e dias úteis.
- **Equipe**: funcionários ativos com `presenca.registrar` e sem `presenca.gerenciar` (Ricardo,
  Márcio, Thiago e João; o gestor não registra presença).
- **Ausência presumida** (`detectAbsences`, a cada 60 s, idempotente): em dia útil, depois do
  limite, quem não confirmou chegada nem tem situação registrada vira "ausência presumida"; o
  sistema identifica as tarefas do dia da pessoa e, em cadeia, as que dependem delas (com
  responsáveis e prazos) em `attendance_impacts` e avisa o gestor uma vez por pessoa. Nada é
  cancelado ou transferido (redistribuição é da Fase 8). A chegada posterior encerra esses alertas.
- **Disponibilidade** (derivada): não confirmou, presente e disponível, presente e ocupado (tarefa em
  execução), em pausa (tarefa pausada durante o dia), atividade externa, ausência presumida,
  ausência confirmada, expediente encerrado. Recalculada a cada chegada/saída/registro e a cada
  início/pausa/retomada/conclusão de tarefa; muda → `attendance.availability_changed`.
- **Encerrar expediente**: registra a saída (nunca bloqueada por falta de informação), grava o
  andamento informado, pausa as tarefas em execução (motivo "fim do expediente", andamento
  preservado) e gera pendência `ANDAMENTO_PENDENTE` + aviso ao gestor para as que ficaram sem
  andamento.
- Relógio injetável (`setAttendanceClock`) usado só pelos testes para fixar 8h30/9h30.

### Distribuição de ajudantes e reprogramação (Fase 8)

Regras **determinísticas e auditáveis** (sem IA generativa); módulo `modules/help`.

- **Competências** (`employee_skills`, PK funcionário + competência): parafusar, movimentar,
  auxiliar montagem, virar/posicionar, apoio geral, desmontagem, preparação, cabeceiras, reparos,
  instalações, inspeção e corte/costura. Semeadas por função (ajudante; cabeceiras/qualidade =
  ajudante + especialidades; tapeceiro = corte/costura) e ajustadas pelo gestor.
- **Pedido de ajuda** (`help_requests`, AJ-00001): tarefa e OS, quem pediu, tipo, duração estimada
  (sugestão por tipo, ajustável), urgente (+ justificativa obrigatória — CHECK no banco),
  observação, status (pendente, atribuída, em execução, concluída, cancelada, escalada), ajudante,
  tarefa de apoio, datas e versão. Índice único parcial impede dois pedidos abertos da mesma
  pessoa na mesma tarefa. Histórico imutável em `help_request_events` (com a avaliação dos
  candidatos de cada tentativa).
- **Tarefa de apoio**: `production_tasks` com `activity = APOIO`, `support_for_task_id` (tarefa
  principal) e `estimated_minutes`. Nasce liberada para o ajudante, sem dependência com a
  principal (trabalho simultâneo na mesma OS); concluir o apoio conclui o pedido, nunca a principal.
- **Motor de seleção** (`evaluateCandidates` + `pickCandidate`): para cada pessoa da equipe (exceto
  quem pede) registra motivos de exclusão — sem competência, não confirmou chegada, ausente,
  atividade externa, expediente encerrado, ocupado (tarefa em execução), ocupado com tarefa
  importante (ALTA/URGENTE ou apoio), tarefa prioritária programada na janela do apoio ou urgente
  aguardando — e uma pontuação de impacto: +10 especialidade preservada (cabeceiras/reparos/
  inspeção), +5 por tarefa própria na janela, +3 se há tarefa liberada esperando, +2 por tarefa
  pausada. Escolhe o menor impacto; empate por nome. Assim, em condições iguais, o apoio geral vai
  para o João e o Thiago fica preservado. Atribuições são serializadas (advisory lock global) —
  dois pedidos simultâneos nunca pegam o mesmo ajudante.
- **Fila** (`processHelpQueue`): urgentes primeiro, depois por chegada; reavaliada após chegada,
  saída, início/pausa/conclusão de tarefa, decisão do gestor, mudança de competências e a cada
  30 s. Sem ajudante: o solicitante é avisado uma vez; passado o limite (5 min urgente, 20 min
  normal) o gestor recebe **um** alerta de risco de atraso. Nenhuma previsão de disponibilidade é
  inventada. Pedido urgente sem ninguém livre, mas com alguém em tarefa não crítica, vira uma
  **proposta** ao gestor (interromper ou aguardar) — nunca interrompe sozinho; se o gestor
  rejeitar, o pedido volta à fila e não é escalado de novo.
- **Reprogramação simples automática** (registrada em `planning_actions`, imutável):
  (a) tarefa liberada/programada que fica bloqueada — ou pausada por impedimento — de quem está
  presente: indica outra tarefa já liberada da mesma pessoa ou **antecipa** a próxima tarefa pronta
  de hoje (mesmo responsável, sem bloqueio técnico, materiais e dependências ok; antecipar não
  compromete prazo); nunca inicia nada e não mexe no andamento; (b) ausência **confirmada**:
  tarefas de apoio de prioridade até normal, sem prazo hoje e sem bloqueio técnico passam para
  alguém presente, livre e capacitado. Toda mudança gera evento na tarefa, revisão da programação
  publicada (`reviseIfPublishedBy`) e aviso.
- **Reprogramação crítica** (`reschedule_proposals`, RP-00001): situação, problema, tarefas
  afetadas, alternativas (ações + impactos + crítica/recomendada) e ação proposta; deduplicada
  por fato (`dedupe_key`). Ausência presumida → recomenda aguardar (nada é transferido); ausência
  confirmada → redistribuir, trocar o tapeceiro principal (crítica), reprogramar para o próximo dia
  útil (crítica se compromete prazo interno ou entrega ao cliente) ou manter. O gestor aprova,
  ajusta (responsável/data/hora, com motivo) ou rejeita; nada é aplicado antes. A chegada da pessoa
  torna as propostas pendentes da ausência **sem efeito** (sem duplicar).
- **Relógio de teste** (`/api/test/clock`, `/api/test/attendance/check`): só registrado com
  `ENABLE_TEST_CLOCK=true` em `APP_ENV=test` (a validação do ambiente recusa o contrário). Desloca
  apenas o relógio operacional da aplicação; o relógio do servidor e do banco não mudam.

### Central de atenção, ocorrências e delegação de soluções (Fase 9)

Módulo `modules/issues`; regras determinísticas e auditáveis.

- **Ocorrência** (`production_issues`, OC-00001): tipo (falta de material, problema técnico, outro
  impedimento), impacto (impedido; continua com dificuldade; faz outra atividade), `blocks_task`
  (CHECK: só a dificuldade não impede), prioridade inicial (alta se impede; urgente se a tarefa
  é urgente), descrição, tarefa e OS, quem registrou e o dispositivo (automáticos), material
  (necessidade da OS, item de estoque ou descrição + quantidade e unidade), responsável pela
  solução, tarefa de resolução atual, competência exigida, prazo de resolução, resultado,
  resolução/cancelamento (com motivo) e reaberturas. **Nunca é apagada** (trigger) e o histórico
  `production_issue_events` é imutável. Fotos: anexos `PRODUCTION_ISSUE` (arquivos privados).
- **Estados**: aberta → atribuída → em resolução → aguardando verificação → resolvida; cancelada;
  reaberta (de resolvida/cancelada, com motivo). Transições validadas (`ISSUE_TRANSITIONS`).
  Concluir a tarefa de resolução **nunca** resolve: leva a "aguardando verificação"; só quem tem
  `ocorrencias.gerenciar` confirma (ou recusa — volta a aberta).
- **Impedimento**: bloqueio total / outra atividade pausam a tarefa em execução (motivo "outro",
  impedimento, andamento preservado) ou bloqueiam a que aguardava início — o motor de liberação
  ganhou o bloqueador `OCORRENCIA` (`hasBlockingIssue`), também conferido ao iniciar e ao retomar.
  Só a etapa é afetada, nunca a OS inteira. Dificuldade mantém a tarefa e registra o risco.
- **Tarefas afetadas** (`impactOf`): a tarefa e, em cadeia, as dependentes (responsáveis e prazos);
  risco de prazo quando há prazo interno até amanhã, entrega ao cliente em até 2 dias ou tarefa
  urgente.
- **Delegação**: tarefa de resolução separada (`production_tasks.issue_id`, atividade "outra",
  exige o resultado ao concluir) para João, Thiago, Ricardo, Márcio ou o próprio gestor;
  competência exigida conferida, ausente/externo/encerrado recusado, conflito (ocupado, tarefa
  prioritária nas próximas 2 h, sem chegada) exige confirmação explícita e fica registrado como
  impacto. Entra na programação publicada como **revisão** (`reviseIfPublishedBy`, a mesma fonte
  das revisões), assim como a tarefa de apoio da Fase 8.
- **Confirmação**: falta de material só é resolvida com a necessidade da OS coberta (recebida/
  reservada) ou com reserva ativa do item de estoque; depois a tarefa é reavaliada (liberada se
  nada mais a impede; pausada → aviso "tarefa desbloqueada", sem retomar sozinha) e as
  dependentes também. Material que fica disponível com a ocorrência aberta a leva para
  verificação. Nenhuma compra é criada automaticamente.
- **Propostas**: `BLOQUEIO` (ocorrência que impede com prazo em risco, dependentes de outras
  pessoas ou tarefa importante; ou tarefa bloqueada com prazo em risco) — aguardar ou reprogramar a
  tarefa e as dependentes; `CONFLITO` (pedido de ajuda esperando além do limite quando alguém
  poderia ser liberado; o pedido segue na fila). Ambas deduplicadas e invalidadas quando perdem
  o sentido (ocorrência encerrada, tarefa liberada, ajudante atribuído).
- **Central de atenção** (`GET /attention`): só exceções — ocorrências, ajuda atrasada/escalada,
  propostas pendentes, ausências com impacto (um item por pessoa), pausa por impedimento sem
  ocorrência e prazos vencidos/bloqueios com prazo; um item por fato (`key`), categorias crítico,
  ação necessária, atenção e informativo, filtros por categoria, tipo, situação, funcionário,
  responsável, OS e data.
- **Escolha manual do ajudante** (Fase 8 + 9): candidatos avaliados agora; impossível recusado,
  conflito com aprovação explícita; histórico com a avaliação e "Manual: gestor escolheu…".
- Rotina: a cada 30 s, depois da fila de ajuda, `processIssueRisks` avisa (uma vez) prazos de
  resolução vencendo/vencidos e revalida as propostas de bloqueio.

### Qualidade, embalagem, expedição e logística (Fase 10)

Módulo `modules/quality` (`common`, `inspections`, `packaging`, `shipping`, `logistics`,
`returns`, `attention`, `routes`); regras puras em `packages/shared/src/quality-domain.ts`.

- **Unidade**: a peça da OS (`service_order_items`). Etapa derivada `fulfillment_stage`
  (`computeStage`): em produção → aguardando inspeção → em inspeção → em correção → aguardando
  embalagem → em embalagem → bloqueio de expedição → pronta para entrega → entrega agendada → em
  transporte → entregue (ou devolvida/cancelada). Recalculada do banco a cada mudança
  (`refreshItemStage`), com evento `item.stage_changed` e histórico em `quality_events` (imutável).
- **Tarefas obrigatórias** de uma peça: as da peça e as da OS inteira, exceto apoio, resolução de
  ocorrência, correção e embalagem (canceladas e rascunhos não contam). Quando todas concluem
  (`qualityTaskClosed`, chamado no concluir/cancelar de tarefa), nasce a **inspeção**
  (`quality_inspections`, IQ-00001, rodada 1). Etapa nova concluída depois da aprovação invalida a
  aprovação.
- **Inspetor**: o definido em `company_settings.quality_inspector_user_id`; sem definição, quem
  tem a competência `INSPECAO` e a permissão `qualidade.inspecionar` (Thiago). Ausente (folga,
  férias, ausência), executor do serviço ou não definido → a inspeção fica sem inspetor, com o
  motivo, e o gestor é avisado para designar um substituto autorizado ou aprovar diretamente.
  `canDecideInspection`: gestor sempre; inspetor designado só se não executou o serviço, salvo
  autorização explícita do gestor (`executor_authorized_by_id`, auditada).
- **Checklist**: modelos `quality_templates`/`quality_template_items` por tipo de peça; cada item
  pode valer só para alguns tipos de serviço (`checklistFor` — sem itens irrelevantes). A inspeção
  guarda a própria cópia (`quality_inspection_items`), bloqueada por trigger após a decisão.
- **Aprovação**: checklist obrigatório conferido e conforme, produção concluída, sem correção
  aberta e com a versão técnica da peça igual à da inspeção; grava inspetor, data/hora,
  dispositivo, `item_version` e a revisão técnica da OS (`os_revision`).
- **Reprovação**: motivo + ao menos um item não conforme; cria a tarefa `CORRECAO` (ligada por
  `inspection_id`, prioridade alta, responsável = principal da peça ou o escolhido), revisa a
  programação publicada (`reviseIfPublishedBy`) e registra no histórico do planejamento.
  Inspeções decididas não mudam nem são apagadas (triggers). Correções encerradas → nova
  inspeção (rodada + 1, `CORRECAO_CONCLUIDA`); nada é aprovado automaticamente.
- **Alteração técnica** (`core/item-changes.ts`): mudança de especificação da peça (revisão
  `ITEM`) ou novas medidas (revisão `MEDICAO`) invalidam a aprovação (`INVALIDADA`, motivo),
  invalidam a embalagem (tarefa cancelada), devolvem a entrega confirmada a provisória e criam a
  rodada `ALTERACAO_TECNICA`. Inspeção ainda aberta é cancelada e recriada com a versão nova.
- **Embalagem** (`packaging_records`, EB-00001): só nasce de uma aprovação; tarefa `EMBALAGEM`
  distribuída pelo motor da Fase 8 (`evaluateCandidates`, competência de apoio geral; João antes
  do Thiago por preservar a especialidade); sem ninguém disponível, aguarda o gestor (o tapeceiro
  só com autorização explícita). Concluída por rota própria (proteção, local, observações, fotos),
  que exige a aprovação vigente — o "Concluir" genérico recusa tarefas de embalagem.
- **Localizações** (`item_locations`, configuráveis) e movimentações (`item_location_events`,
  imutáveis), registradas na embalagem, saída, entrega e quando informadas; etiqueta/QR em texto
  (`CENARIO:PECA:OS-00001/1`) sem hardware.
- **Pronto para entrega** (`deliveryReadiness`): tarefas obrigatórias concluídas, inspeção final
  aprovada, nenhuma correção pendente, embalagem concluída e sem ocorrência logística que bloqueie
  a expedição. Avisa o gestor uma vez por embalagem; nunca agenda.
- **Entregas** (`deliveries`, EN-00001; `delivery_items` com índice único parcial — uma peça em uma
  só entrega ativa; `delivery_events` imutável): só `entregas.gerenciar` agenda; definitiva só com
  todas as peças prontas; provisória para peças não liberadas (sem confirmação ao cliente).
  Execução: saída → chegada → peça a peça (entregue, divergência, não entregue) → instalação →
  conclusão; tentativa frustrada (tentativas + 1, ocorrência, peças voltam à expedição);
  reagendamento pelo gestor. Agenda agrupada por data e região (cidade/bairro) sem rota inventada.
- **Logística terceirizada**: função `logistica_terceirizada` (`producao.acessar` +
  `logistica.executar`), André e Izaías cadastrados sem PIN; entram por PIN num dispositivo
  vinculado, veem só `GET /logistics/jobs` (visão restrita `LogisticsJobDto`, sem valores).
  Retiradas da Fase 2 ganham `logistics_user_id` e passos "saída"/"retirada realizada".
- **Ocorrências logísticas** (`logistics_occurrences`, OL-00001, sem exclusão; histórico
  imutável): cliente indisponível, peça danificada, endereço incorreto, atraso, instalação
  incompleta, divergência, outro; responsável, situação e histórico; peça danificada e divergência
  bloqueiam a expedição. Integradas à central de atenção (tipos `QUALIDADE` e `LOGISTICA`).
- **Devoluções** (`piece_returns`, DV-00001): linhas por item do pedido (peças de OS inteiras e/ou
  peças recebidas fora de OS); confirmação encerra tarefas, inspeções, embalagens e entregas da
  peça, marca `DEVOLVIDA`, soma `returned_quantity` e, se a OS fica sem peças, cancela a OS com a
  proteção da Fase 5 (tarefas e reservas). O recebimento original nunca é apagado.
- **Correção de recebimento** (`receipt_corrections`, imutável): o recebimento continua imutável;
  a correção ajusta `received_quantity` só quando não deixa peças em OS ou devolvidas sem
  cobertura (`receiptCorrectionProblem`).
- **OS cancelada**: inspeções e embalagens abertas são canceladas e a peça sai das entregas
  (listener `onServiceOrderCancelled`).

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
Eventos da Fase 4: `purchase_order.confirmed/cancelled`, `material.received`,
`material.partially_received`, `material_receipt.reversed` vão para todos (os tablets mostram os
pedidos a receber); `supplier.changed`, `purchase_order.created/updated`, `stock.*`,
`leftover.changed`, `material.shortage_detected` (estoque mínimo ou divergência) e
`material.readiness_changed` vão para a gestão. Nenhum payload leva preços.
Eventos da Fase 5 (`production.plan_created/plan_updated/plan_published/plan_revised`,
`production.task_assigned/task_released/task_blocked/task_started/task_progress/task_paused/
task_resumed/task_completed/task_cancelled`, `production.dependencies_updated`,
`production.template_changed`) vão para quem vê a produção (`producao.ver`/`producao.planejar`)
**e** para o responsável da tarefa (`user:<id>`); a liberação de uma tarefa avisa o próximo
responsável sem recarregar a tela. O tablet de outro funcionário não recebe as tarefas alheias.
Eventos da Fase 6: `notification.created` e `notification.read` vão **somente** para o usuário
(`user:<id>`), carregando só o tipo e o id da tarefa; `production.task_impediment` vai para a gestão e
o responsável.
Eventos da Fase 7: `attendance.arrived`, `attendance.late`, `attendance.absence_suspected`,
`attendance.absence_confirmed`, `attendance.corrected`, `attendance.departed`,
`attendance.availability_changed` e `attendance.production_impact_detected` vão para quem vê a
presença (`presenca.ver`/`presenca.gerenciar`) e para o próprio funcionário — nunca para os colegas.
Eventos da Fase 8: `help.requested`, `help.assigned`, `help.queued`, `help.escalated`,
`help.cancelled`, `help.started` e `help.completed` vão para a gestão (`producao.ver`/
`producao.planejar`), quem pediu e o ajudante; `help.skills_changed`, `reschedule.proposed`,
`reschedule.decided` e `planning.action_recorded` só para a gestão. Os avisos persistentes
(ajuda solicitada/atribuída/em espera/cancelada/concluída, reprogramação pendente/aprovada/
automática/rejeitada e tarefa alternativa liberada) usam `notification.created` com chave de
deduplicação — o mesmo fato nunca gera dois avisos.
Eventos da Fase 9: `issue.opened`, `issue.assigned`, `issue.updated`,
`issue.verification_requested`, `issue.resolved`, `issue.reopened`, `issue.cancelled` e
`issue.risk` vão para quem vê ocorrências (`ocorrencias.ver`/`ocorrencias.gerenciar`), quem
registrou e quem resolve — nunca para os demais colegas. Avisos novos: ocorrência aberta,
atribuída, prazo em risco, solução concluída, verificação necessária, resolvida, cancelada,
reaberta e tarefa desbloqueada.

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
- Fase 4: `/painel/compras` (a comprar e pedidos), `/painel/compras/novo`,
  `/painel/compras/[id]`, `/painel/fornecedores`, `/painel/recebimento-materiais`,
  `/painel/estoque` (materiais, movimentações, reservas, sobras), `/painel/prontidao` e a aba
  Materiais da OS. No tablet, **Recebimento de materiais** usa o mesmo componente
  (`components/purchasing/material-receiving.tsx`) em modo ampliado.
- Fase 5: `/painel/producao/planejamento` (planejamento semanal: OS candidatas, responsáveis,
  dias/horários, dependências, conflitos, publicação e revisões), `/painel/producao` (quadro por
  funcionário, OS, etapa, status ou dia), `/painel/producao/tarefas/[id]` (detalhe com
  reprogramar, dependências, bloquear/desbloquear, cancelar e histórico),
  `/painel/producao/modelos` e a aba **Produção** da OS. No tablet, **Minhas tarefas** (hoje por
  prioridade e próximos dias) e o detalhe com Iniciar, Registrar andamento, Pausar (motivo
  simples), Retomar e Concluir, além de peças, medidas, fotos, materiais (sem preços),
  dependências e histórico.
- Fase 6: o tablet abre direto no **Meu dia** (cartões com OS, peça, etapa, prioridade, prazo, status,
  responsável, materiais e motivo da espera; ação rápida no cartão), detalhe técnico (o que fazer,
  peças com medidas/tecido/espuma e fotos, materiais da tarefa, etapas da OS, dependências, fotos da
  tarefa, histórico técnico da OS só com nomes de campos e histórico da tarefa), painéis de
  andamento, pausa e conclusão, caixa de **Avisos** e aviso de **sem conexão**. Funciona em tablet
  (10–11") e celular. No painel, o detalhe da tarefa ganhou "Materiais desta tarefa" e "Para
  concluir, exigir"; os modelos, a coluna "Para concluir".
- Fase 7: no tablet, cartão de presença no topo do "Meu dia" ("Cheguei" em destaque; depois, a
  situação e "Encerrar expediente") e a tela de encerramento com o andamento de cada tarefa em
  execução. No painel, `/painel/presenca` (Presença da equipe: situação, chegada, atraso, tarefa
  atual e próxima, saída, alertas, histórico, registros do gestor e impacto na produção), sino de
  **avisos** no cabeçalho e os novos horários em Empresa.
- Fase 8: no tablet, **Solicitar ajudante** e **Preciso de ajuda agora** no detalhe da tarefa
  própria (tipo em botões grandes, duração sugerida com ajuste, justificativa no urgente),
  acompanhamento e cancelamento do pedido, "Meus pedidos de ajuda" no Meu dia, selo "Apoio para
  …" nas tarefas de apoio e "Enquanto isso, você pode fazer" (tarefas alternativas) quando a tarefa
  está bloqueada ou parada por impedimento. No painel, `/painel/ajuda` (pedidos por status com a
  avaliação dos candidatos), `/painel/reprogramacao` (propostas, decisão e histórico de alterações)
  e `/painel/competencias`; aviso de decisões pendentes no quadro e no planejamento. A Presença da
  equipe passa a abrir no "hoje" do servidor.
- Fase 9: no tablet, **Tenho um problema** no detalhe da tarefa própria (falta de material com
  material, quantidade e unidade; problema técnico; outro impedimento só com descrição e "consegue
  continuar?"; foto opcional), situação dos problemas registrados e a tarefa de resolução com o
  problema descrito (resultado obrigatório ao concluir). No painel, `/painel/atencao` (Central de
  atenção com contadores e filtros), `/painel/ocorrencias/[id]` (detalhe, tarefas afetadas, fotos,
  histórico, delegar, registrar ação/solução, verificar, reabrir, cancelar) e a escolha manual do
  ajudante em Pedidos de ajuda.
- Fase 10: no tablet, **Inspeções** (Thiago: OS, peça, serviço, prazo, prioridade, checklist com
  "conforme / não conforme / não se aplica", defeitos, fotos, histórico de produção, aprovar e
  reprovar com motivo), informações da correção (defeitos) na tarefa do tapeceiro e **Concluir
  embalagem** (proteção, local, fotos) na tarefa de embalagem; André e Izaías veem só **Minhas
  entregas e retiradas** (saída, chegada, peça a peça, instalação, tentativa frustrada,
  ocorrência). No painel, `/painel/qualidade` (inspeções, histórico, embalagens com designação,
  checklists, inspetor principal e localizações), `/painel/qualidade/inspecoes/[id]` (designar
  substituto/autorizar executor, decidir, fotos), `/painel/entregas` (agenda por data e região,
  prontas para entrega com agendamento definitivo ou provisório, expedição com localização e
  ocorrências), `/painel/entregas/[id]`, `/painel/entregas/ocorrencias/[id]`,
  `/painel/devolucoes` e "Corrigir" nas linhas de Recebimentos.
- PWA: `manifest.webmanifest` (início em `/tablet`), service worker que **nunca** guarda
  respostas da API e mostra página offline quando não há rede.
- Permissões no frontend só escondem elementos; o servidor sempre decide.

## 6. Fluxo operacional suportado (próximas fases)

A fundação já acomoda: funcionários e funções da oficina (tapeceiros, cabeceiras/qualidade,
ajudante) e concessões individuais (ex.: tapeceiro autorizado a medir); tablets individuais
com sessão permanente; parâmetros de expediente (botão "Cheguei" 8h30, alerta 9h30
configurável, sem efeito trabalhista); dia de programação e de medição (sextas); eventos e
consumidores para a central de atenção. A distribuição de ajuda e a reprogramação foram
implementadas na Fase 8.
A equipe de logística terceirizada (André e Izaías) passou a ter acesso restrito na Fase 10
(só as próprias retiradas e entregas, sem dados comerciais).
