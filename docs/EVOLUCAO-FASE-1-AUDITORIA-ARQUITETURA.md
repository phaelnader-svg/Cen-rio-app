# Cenário Gestão — Evolução, Fase 1 de 8: auditoria e arquitetura

> Fase **somente de análise**. Nenhum código funcional, nenhuma migration, nenhum deploy, nenhum
> acesso ao Google Cloud, à homologação ou a dados reais. Os testes foram executados apenas
> localmente, com um PostgreSQL 16 descartável e dados sintéticos.
>
> Convenção usada no documento:
>
> - **[código]**: fato verificado no repositório, com caminho e linha.
> - **[proposta]**: desenho para as fases seguintes.
> - **[incógnita]**: algo que precisa de decisão ou verificação.

## 1. Branch, HEAD e worktree

| Item                | Valor                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Branch              | `claude/cenario-gestao-fase-1-zf3bj2`                                                                                              |
| HEAD inicial        | `76aae354fcd348c07f7a44f4c2f5758e79e7aab2`, igual a `origin/claude/cenario-gestao-fase-1-zf3bj2`                                   |
| Worktree inicial    | limpo (`git status` sem alterações)                                                                                                |
| HEAD final / commit | ver §16 (o commit desta fase só adiciona este documento)                                                                           |
| Base auditada       | `schema.prisma` (3.031 linhas, 98 modelos, 44 enums), 12 migrations, 30 módulos da API, relatórios das Fases 1–12 e da homologação |

## 2. Resumo executivo

O sistema já tem quase todas as peças necessárias, mas a lógica de produção é **orientada a
horário**. A principal mudança das Fases 2–4 é trocar essa orientação por uma **fila semanal
contínua**, sem perder o que foi construído.

1. **Hoje o horário é obrigatório para iniciar** [código].
   - Uma tarefa sem `scheduledAt`, ou com horário futuro, fica `PROGRAMADA` e nunca vira
     `LIBERADA`. O início só é aceito em `LIBERADA` (`packages/shared/src/production-domain.ts:288-306`;
     `apps/api/src/modules/production/tasks.ts:856-887`).
   - Uma tarefa sem horário **pode existir**, mas **não pode ser iniciada** e **não aparece** no
     "Meu dia" do tablet (`tasks.ts:662-697`).
2. **A continuidade no dia seguinte existe, mas por acidente** [código].
   - Não há job diário: as tarefas não são duplicadas, reiniciadas nem encerradas na virada do dia
     (`apps/api/src/core/maintenance.ts:14-38`; timers em `apps/api/src/app.ts:238-272`).
   - As tarefas atrasadas continuam em "hoje" porque `scheduledAt <= fim de hoje`. A ordem
     depende do horário (`compareTasks`, `production-domain.ts:380-401`).
3. **As tarefas só nascem quando a OS entra num planejamento semanal** [código].
   - Na inclusão da OS (`POST /api/v1/production-plans/:id/items`, `plans.ts:689-778`) não há
     geração automática a partir da OS.
   - **Não há idempotência por peça e etapa**: a única proteção é `@@unique([planId, serviceOrderId])`.
4. **O "tapeceiro principal" é por OS e por semana, não por peça** [código].
   - Fica em `ProductionPlanItem.principalUserId` (`schema.prisma:1718`). A peça
     (`ServiceOrderItem`) não tem titular.
   - Só CORTE_TECIDO e COSTURA exigem o principal (`PRINCIPAL_ACTIVITIES`, `production-domain.ts:62`).
     REVESTIMENTO, MONTAGEM e ACABAMENTO podem ir para outra pessoa: nada impede dividir a
     tapeçaria de uma peça.
5. **O motor automático da Fase 8 distribui ajudantes e ausências, não a produção** [código].
   - `help/engine.ts:144`, `help/reschedule.ts:461`.
   - A ajuda **não transfere titularidade**: ela cria uma tarefa APOIO separada (`help/engine.ts:245-285`).
6. **Mão de obra** [código].
   - O valor é **por peça ou por OS**, em `ProductionPayable` (`schema.prisma:2790`), com
     situações PREVISTO → LIBERADO → PAGO_PARCIAL/PAGO.
   - Concluir uma tarefa **não paga** e qualidade é a regra padrão (`finance-domain.ts:142-169`).
   - O recálculo da liberação é **preguiçoso**: só acontece em consultas (`finance/routes.ts:350, 365, 416`).
   - A privacidade já está correta: o tablet nunca recebe valores, o Ricardo não vê os do Márcio, o
     WebSocket não leva valores (`finance.test.ts:1066-1090`).
7. **Logística** [código].
   - `LogisticsCost` já é **valor total por serviço**, com rateio exato entre OS
     (`payables.ts:453-477`).
   - O recebedor é **texto livre** (`beneficiary`, `schema.prisma`), sem vínculo a um usuário.
   - **Não existe fechamento semanal** nem estorno de pagamento a fornecedor ou profissional.
8. **Defeitos encontrados de passagem** (não corrigidos, porque a fase proíbe mudar código):
   - deslocamento fixo de −3 h no indicador de atraso (`finance/results.ts:381, 385`);
   - bloqueador `'HORARIO'` inexistente referenciado em `help/reschedule.ts:497`;
   - o relógio de teste não afeta a liberação, o início nem o "Meu dia" (usam `new Date()`).

**Veredito:** **GO condicionado** para a Fase 2. Arquitetura e plano estão completos e
fundamentados no código. Ficam **decisões de negócio pendentes** (§15), sem as quais as Fases 3, 6
e 7 não devem começar; a Fase 2 não depende delas.

## 3. Inventário técnico e evidências

Para cada módulo: estado atual, fonte da verdade, o que reutilizar, lacunas e riscos, testes existentes.

### 3.1 OS, peças, modelos, tarefas, competências, dependências e atribuição

**Estado atual** [código]:

- **OS e peças:**
  - `ServiceOrder` (`schema.prisma:813`): status ABERTA/CANCELADA, `priority`, `promisedDate` e
    `technicalLeadId` (responsável técnico).
  - `ServiceOrderItem` (`:877`) é a peça: `position`, `pieceType`, `serviceType`, `quantity`,
    `fulfillmentStage`, com `@@unique([serviceOrderId, position])`. Não tem titular.
- **Modelos:**
  - `ProductionTemplate` (`:1656`) e `ProductionTemplateStep` (`:1670`): `activity`, `role`
    PRINCIPAL/APOIO, `dependsOn Int[]`, `optional`, `requiresMaterials`, `completionRequirement`.
  - A escolha é o primeiro modelo ativo, por `createdAt`, cujo `pieceTypes` contém o tipo da peça
    (`plans.ts:357-361`).
- **Tarefas:** `ProductionTask` (`:1750-1826`).
  - Uma por etapa e por peça (`generateTasks`, `plans.ts:339-396`), com `sequence = posiçãoDaPeça*100 + posiçãoDaEtapa`.
  - `assigneeUserId = principal` só nas etapas PRINCIPAL; as demais nascem sem responsável (`:381`).
- **Dependências:**
  - `TaskDependency` (`:1829`), restrita à mesma OS e sem ciclos (`setDependencies` e `findCycle`, `tasks.ts:141`).
  - CHECK `not_self` na migration `producao`.
- **Competências:**
  - `EmployeeSkill` (`:2021`) com uma lista fixa de 12 competências por CHECK
    (`help-domain.ts`; migration `ajuda_reprogramacao:195`).
  - `DEFAULT_ROLE_SKILLS` relaciona função e competência, e `ACTIVITY_SKILL` (`reschedule.ts:47`)
    relaciona atividade e competência.
- **Atribuição:**
  - Manual: `PUT /production-tasks/:id` (`tasks.ts:265`), recusada se a tarefa já começou.
  - Troca do principal em `PUT /production-plans/:id/items/:itemId` (`plans.ts:781-838`).
  - `assertWorker` só verifica a permissão `producao.executar` (`plans.ts:70`).

**Fonte da verdade:** `production_tasks`, `production_plan_items` e `service_order_items`.

**Reutilizar:** `generateTasks`, `TaskDependency`, `evaluateRelease`/`reevaluateTasks`,
`ProductionTaskEvent`, `ProductionPlanRevision`, `EmployeeSkill`.

**Lacunas e riscos:**

- não há titular por peça;
- geração sem chave idempotente (reprocessar duplicaria tarefas);
- editar a OS não regenera nada (`service-orders/routes.ts:227-247`, só avisa);
- a escolha do modelo não é explícita por peça;
- competência não é verificada na atribuição;
- os nomes das competências são fixos por CHECK.

**Testes:**

- `apps/api/test/production.test.ts` (10 testes: publicação, principal do sofá, ciclos,
  liberação, paralelismo, concorrência na conclusão, permissões, OS cancelada);
- `help.test.ts` (28);
- E2E `production.spec.ts`, `team-workshop.spec.ts`.
- **Não existe** teste de geração repetida nem de regeneração após edição da OS.

### 3.2 Horário, semana, publicação, revisão, prioridade e liberação

Ver §4 para o comportamento detalhado.

**Fonte da verdade:**

- `ProductionPlan` (`weekStart @unique`, CHECK de segunda-feira, `status` RASCUNHO/PUBLICADO, `revision`);
- `ProductionPlanRevision` (snapshot imutável por trigger);
- `ProductionTask.scheduledAt/priority/sequence/dueDate`.

**Reutilizar:**

- a publicação (`plans.ts:864-948`);
- a revisão com motivo obrigatório para plano publicado (`reviseIfPublished`, `plans.ts:103-159`);
- o histórico por tarefa (`ProductionTaskEvent` REPROGRAMADA).

**Lacunas:**

- não há posição editável na fila (`sequence` só é gravado na criação);
- não há rota de reordenação;
- não há transferência de pendências entre semanas;
- o "Meu dia" é por dia.

**Testes:**

- `production.test.ts:52, 118, 139, 252-268`;
- `tablets.test.ts:85-115`.

### 3.3 Presença, pausas, ausências, ajuda, ocorrências e bloqueios

**Presença** [código]:

- `OperationalAttendance` (`:1935`), único por funcionário e dia.
- "Cheguei" e "Encerrar expediente": `attendance/routes.ts:133-401`. Encerrar pausa as tarefas
  EM_EXECUCAO com `FIM_EXPEDIENTE`.
- **Iniciar uma tarefa não exige presença** (`tasks.ts:823-906`).
- A ausência presumida só sugere (`attendance/absence.ts:29-124`). A ausência confirmada reatribui
  sozinha apenas tarefas não principais, abaixo de ALTA e sem prazo hoje (`reschedule.ts:461-528`).

**Pausas:** `PauseReason` (FIM_EXPEDIENTE, AGUARDANDO_ORIENTACAO, INTERRUPCAO_PROGRAMADA, OUTRO) e `pauseImpediment`.

**Ajuda:**

- `HelpRequest` (`:2048`), com um pedido aberto por tarefa (índice parcial).
- Cria uma tarefa APOIO própria e **não muda o responsável** (teste `help.test.ts:471`).

**Ocorrências:**

- `ProductionIssue` (`:2176`) com `impact`; `blocksTask = impact !== 'DIFICULDADE'` (`issue-domain.ts:26`).
- Uma tarefa em execução vira PAUSADA com impedimento; a retomada é recusada enquanto houver bloqueio
  (`issues/service.ts:73-148`).

**Bloqueios:** `status BLOQUEADA` + `blockers[]` + `blockedReason`. Quem reavalia é `reevaluateTasks`
(`production/common.ts:362-449`).

**Lacuna central para a fila:** quando a tarefa fica bloqueada, `suggestAlternative`
(`reschedule.ts:157-255`) **antecipa o `scheduledAt`** da próxima. Isso **muda a programação**,
contrariando a regra de "apresentar outra executável sem mudar a prioridade original". Na fila
semanal a antecipação deixa de ser necessária.

**Concorrência:**

- `lockTasks` (`SELECT … FOR UPDATE` em ordem de id, `common.ts:223-227`);
- `start` e `complete` são idempotentes;
- **não há impedimento** de duas tarefas EM_EXECUCAO para a mesma pessoa.

**Testes:**

- `attendance.test.ts` (11);
- `help.test.ts` (17–27);
- `issues.test.ts` (24);
- `tablets.test.ts` (10);
- E2E `team-presence`, `team-help`, `team-issues`, `tablets`.

### 3.4 Estoque, reservas, materiais, qualidade, inspeções e embalagem

**Estoque e materiais** [código]:

- `StockItem` (`:1292`, CHECK `reserved <= on_hand`, tecido nunca vai para estoque);
- `StockMovement` (imutável);
- `StockReservation` (ATIVA/CONSUMIDA/LIBERADA);
- `MaterialRequirement` (`sourcing` EXCLUSIVO_OS/ESTOQUE);
- `ProductionTaskMaterial` (`:1873`), que liga material a tarefa;
- **fonte da verdade:** `changeStock` (`purchasing/common.ts:133-175`).

**Qualidade** [código]:

- A inspeção nasce sozinha quando as tarefas obrigatórias da peça terminam
  (`inspectIfProductionDone`, `quality/inspections.ts:325-354`).
- Autoaprovação é proibida (`canDecideInspection`, `quality-domain.ts:71`).
- A reprovação gera uma tarefa CORRECAO e uma nova inspeção.
- A aprovação cria a embalagem (`PackagingRecord`).
- A etapa da peça é derivada por `computeStage` (`quality-domain.ts:296-319`).

**Reutilizar:** tudo. A fila só precisa tratar MATERIAIS como bloqueio (já existe) e as tarefas
CORRECAO e EMBALAGEM, que hoje nascem LIBERADA com `scheduledAt = now`.

**Testes:** `quality.test.ts` (27), `purchasing.test.ts` (13), `remediation.test.ts` (7),
`integrity-audit.test.ts` (7).

### 3.5 Retiradas, entregas, rateios, logística e correções

**Retirada e entrega** [código]:

- `PickupRequest` (`:636`) com status e transições em `domain.ts:112-126`.
- `Delivery` (`:2488`) tem `attempts`. A tentativa frustrada devolve a peça à expedição e abre uma
  ocorrência, **sem custo automático** (`quality/shipping.ts:998-1046`).
- O reagendamento grava o evento `REAGENDADA`.

**Custo** [código]:

- `LogisticsCost` + `LogisticsCostAllocation` (`:2878/2909`).
  - Valor **total** por serviço (`amountCents`), rateio IGUAL/POR_PECA/MANUAL com soma exata.
  - Ligação opcional a **uma** retirada **ou** a **uma** entrega.
  - `beneficiary` em **texto livre**.
  - Conta a pagar opcional (`payableId @unique`, categoria LOGISTICA, `payables.ts:478-486`).
- Unicidade: índices parciais `logistics_costs_delivery_kind` e `logistics_costs_pickup_kind`.

**Correções:** `PieceReturn` e `ReceiptCorrection`. O recebimento original é imutável.

**Lacunas:**

- recebedor como usuário;
- participantes;
- custo padrão configurável;
- viagem com várias retiradas e entregas;
- fechamento semanal;
- regras de cancelamento, frustração e ajuste após fechamento.

**Testes:**

- `finance.test.ts` "11. custo logístico" e "12. rateio";
- `quality.test.ts` 18–21b;
- `orders-pickups.test.ts`;
- `security-audit.test.ts`: o André só vê as próprias retiradas.

### 3.6 Pagamento por produção, custos por OS, contas a pagar, liquidações, estornos, competência e caixa

Ver §5.

### 3.7 Permissões, auditoria, APIs, WebSocket, offline e reconexão

**Permissões** [código]:

- 5 funções de sistema: `gestor`, `tapeceiro`, `cabeceiras_qualidade`, `ajudante`, `logistica_terceirizada`
  (`packages/shared/src/permissions.ts:392-452`).
- 55 permissões em 14 grupos.
- Concessões por usuário (`UserPermission`) só **acrescentam** permissões.
- As rotas declaram `config.access`; rota sem declaração derruba a inicialização (`plugins/auth.ts:48-50`).
- Os tipos de sessão são WEB e DEVICE (tablet por PIN).

**Auditoria:**

- `audit_logs` é imutável por trigger (`fundacao/migration.sql:405-415`).
- A gravação acontece na mesma transação da alteração (`core/audit.ts:24-38`).
- Há 117 ações distintas auditadas.

**Eventos e WebSocket:**

- `domain_events` usa `seq` monotônico (advisory lock) e `audience` (`all` | `permission:x` | `user:id`).
- O payload é entregue inteiro ou não é entregue; os eventos financeiros **não levam valores**
  (`finance/common.ts:23, 66-73`).
- Na reconexão, `resume{sinceSeq}` reenvia até 500 eventos; acima disso, `resync.required`
  (`core/realtime/hub.ts:189-236`).

**Offline:**

- Não há fila offline no tablet: as ações ficam desativadas sem rede.
- Idempotência por `Idempotency-Key` (24 h, `plugins/idempotency.ts`).

**Testes:** `permissions.test.ts`, `security-audit.test.ts`, `realtime.test.ts`, `sync-audit.test.ts`, `rate-limit.test.ts`.

### 3.8 Schema, migrations, constraints, transações, concorrência, testes E2E e backup

**Schema e migrations** [código]:

- 98 modelos, 44 enums e 12 migrations (`20261008000000_fundacao` … `20261017000000_auditoria_final`).
- Cerca de 169 CHECKs em SQL puro e triggers de imutabilidade.
- A regra "migration antiga nunca é editada" está em `docs/FASE-12-RELATORIO.md:3-4` e `OPERACAO.md:18`.

**Transações e concorrência:**

- Nível de isolamento padrão do PostgreSQL (READ COMMITTED), sem uso de Serializable.
- A concorrência vem de `SELECT … FOR UPDATE`, versão otimista (`version`), índices únicos e
  parciais e advisory locks.

**Backup:** `scripts/backup.sh`, `restore.sh` e `test-backup-restore.sh`, executados no CI.

**Testes:** 295 testes de API em 30 arquivos (todos executados e aprovados nesta fase), 16 especificações E2E e
a suíte de homologação.

## 4. Comportamento atual de horários e atribuições

### 4.1 Respostas obrigatórias (com prova no código)

| Pergunta                          | Resposta                                                                                                                                                                                                                                                                              | Evidência                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| O horário bloqueia o início?      | **Sim.** Sem bloqueios, mas com `scheduledAt` futuro ou nulo, a tarefa fica PROGRAMADA. O `start` revalida no servidor e responde 422 "o horário programado ainda não chegou".                                                                                                        | `production-domain.ts:302-304`; `tasks.ts:856-887`; teste `production.test.ts:252-268`   |
| Tarefa pode existir sem horário?  | **Pode existir, não pode ser executada.** A data é opcional no planejamento (`scheduledAt = null` sem data). A tarefa fica PROGRAMADA para sempre: `releaseDueTasks` só olha `scheduledAt <= now`. A publicação não exige horário; o planejamento só mostra o conflito `SEM_HORARIO`. | `plans.ts:730`, `common.ts:476-498`, `plans.ts:225-230`                                  |
| Aparece no tablet sem horário?    | **Não**, a menos que já esteja LIBERADA, EM_EXECUCAO ou PAUSADA. O filtro de `/mine` compara `scheduledAt` com o dia.                                                                                                                                                                 | `tasks.ts:662-697`                                                                       |
| Como continua no dia seguinte?    | **Nada acontece na virada do dia.** Não há job diário. As tarefas pendentes mantêm status e `scheduledAt` e continuam em "hoje" (`scheduledAt <= fim de hoje`). Não são duplicadas, reiniciadas nem encerradas. O "encerrar expediente" pausa as em execução com `FIM_EXPEDIENTE`.    | `maintenance.ts:14-38`; `app.ts:238-272`; `tasks.ts:673`; `attendance/routes.ts:242-401` |
| Alguma tarefa inicia sozinha?     | **Não.** EM_EXECUCAO só é gravado por `start`/`resume` do responsável. Exceção: o registro de embalagem conclui a tarefa EMBALAGEM diretamente.                                                                                                                                       | `tasks.ts:891, 956`; `quality/packaging.ts:365-375`                                      |
| Quem altera prioridade e ordem?   | Só `producao.planejar` em sessão WEB. Não há rota de reordenação; mudam `priority`, data/hora e responsável. O funcionário não reordena.                                                                                                                                              | `production/common.ts:30`; `tasks.ts:265`                                                |
| Programação publicada é revisada? | **Sim.** Qualquer mudança exige motivo (3 ou mais caracteres) e gera revisão com snapshot imutável, auditoria e evento `PRODUCTION_PLAN_REVISED`.                                                                                                                                     | `plans.ts:103-159`, migration `producao:262`                                             |

### 4.2 Onde o horário aparece (inventário para a Fase 2)

**API** [código]:

- `evaluateRelease` (`production-domain.ts:288-306`) e `releaseDueTasks` (`common.ts:476-498`, timer de 30 s);
- `start` (`tasks.ts:879-886`);
- `/mine` (`tasks.ts:662-697`) e quadro (`tasks.ts:611-636`);
- conflitos do planejamento SEM_HORARIO, HORARIO_COINCIDENTE, ANTES_DA_DEPENDENCIA, APOS_PRAZO e FORA_DA_SEMANA (`plans.ts:225-288`);
- `openTasksOf` da presença (`attendance/common.ts:151-171`);
- conflito de agenda do ajudante pela janela `estimatedMinutes` (`help/engine.ts:156-206`);
- risco de atraso (`help/queue.ts:268-320`);
- antecipação (`reschedule.ts:157-255`) e ADIAR para o próximo dia útil (`reschedule.ts:593-610`).

**Indicadores** [código]:

- prazo interno vencido vira CRÍTICO (`issues/attention.ts:53, 205-240`);
- `resolutionOverdue` (`issues/common.ts:338`);
- atraso da tarefa (`finance/results.ts:377-390`, com o **defeito do −3 h fixo**);
- colunas "Atrasadas" (`finance/reports.ts:339-340`).

**UI** [código]:

- `planning-page.tsx:563-591` (dia, hora e prazo);
- `board-page.tsx:43, 104-108, 236`;
- `task-detail.tsx:147-151, 304-306, 396-418`;
- `tablet/tasks.tsx:276, 354-361, 513-518, 592-597, 830-833` ("libera em … às …");
- `tablet/home.tsx:55, 192-194`.

**Testes que dependem de horário** [código]:

- `production.test.ts:118, 139, 252-268`;
- `tablets.test.ts:85-115, 272-278`;
- `help.test.ts:125, 563, 655-671, 718, 754, 816, 905-949`;
- `issues.test.ts:123`;
- os helpers criam tarefas com `time: '08:00'` e `date: day(-1)` para que já nasçam liberadas;
- E2E `team-*.spec.ts` (relógio de teste).

**Relógio de teste** (`attendance/common.ts:43-47`; `modules/testing/routes.ts`):

- Desloca **só** presença, ajuda, ocorrências e propostas.
- **Não** desloca a liberação, o início, o "Meu dia", `suggestAlternative` nem a central (todos usam `new Date()`).

### 4.3 Atribuições hoje

- **Etapas principais:** recebem o principal do plano.
- **Etapas de apoio:** nascem sem responsável, e o gestor atribui uma a uma.
- **Troca do principal:** move as tarefas PRINCIPAL ainda não iniciadas (`plans.ts:809-838`).
- **Automático:** só ajudantes para pedidos de ajuda e reatribuição de tarefas simples na ausência
  confirmada. **Não há** balanceamento por carga (não encontrado em `production/`, `help/`, `attendance/`).

## 5. Fontes de verdade financeiras

| Conceito                   | Fonte da verdade [código]                                                                                                                                                     | Observações                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mão de obra do tapeceiro   | `ProductionPayable` (`schema.prisma:2790`): `agreedCents`, `adjustmentsCents`, `paidCents`, `eligibility`, `status`, `eligibleAt`, `serviceOrderItemId?`                      | Por peça ou por OS, nunca misturados na mesma OS (`labor.ts:187-201`). Só para tapeceiro (`labor.ts:162-166`). Lançamento **manual** do gestor (`POST /finance/labor`).                                     |
| Ajustes de mão de obra     | `FinancialAdjustment` (`:2824`), exige `financeiro.ajustes`                                                                                                                   | Nunca deixa o devido abaixo do pago; recusado em PAGO ou CANCELADO.                                                                                                                                         |
| Pagamento ao profissional  | `ProfessionalPayment` (`:2840`), imutável; `earlyReason` para pagamento antecipado                                                                                            | **Sem estorno** (não encontrado).                                                                                                                                                                           |
| Equipe fixa (João, Thiago) | `TeamMonthlyCost` (`@@unique([userId, month])`)                                                                                                                               | —                                                                                                                                                                                                           |
| Contas a pagar             | `AccountPayable` + `PayablePayment` (`:2971/3000`): ABERTO, PARCIAL, PAGO, CANCELADO                                                                                          | `PayablePayment` imutável, **sem estorno**.                                                                                                                                                                 |
| Custo por OS               | `ServiceOrderCost` (`sourceKey @unique`) + `LogisticsCostAllocation`                                                                                                          | Margem calculada por `contributionMargin` (`finance-domain.ts:297`).                                                                                                                                        |
| Custo logístico            | `LogisticsCost` (total) + alocações por OS                                                                                                                                    | O rateio entra na margem da OS (`results.ts:95`).                                                                                                                                                           |
| Receita                    | `CustomerReceivable` / `CustomerPayment` (estorno via `reversalOfId @unique`)                                                                                                 | Único estorno existente.                                                                                                                                                                                    |
| Competência × caixa        | `dashboard` (`results.ts:280-329`). Competência: despesas operacionais por `competence`, equipe fixa, margem. Caixa: `PayablePayment` + `ProfessionalPayment` + recebimentos. | Uma conta a pagar **não** entra como despesa de competência (só despesas operacionais, equipe e custos por OS). Isso evita a contagem dupla, desde que o fechamento logístico não vire despesa operacional. |
| Histórico                  | `FinancialEvent` (`:3019`, imutável)                                                                                                                                          | —                                                                                                                                                                                                           |

A liberação PREVISTO → LIBERADO depende de `laborEligible(rule, stages)`, que olha a etapa da peça
(padrão `QUALIDADE_APROVADA`). **Lacuna:** a liberação só é recalculada nas consultas
(`finance/routes.ts:350, 365, 416`; `results.ts:83, 260`; `labor.ts:294`). Não há disparo a partir
da qualidade nem da produção.

## 6. Arquitetura proposta de schema e migração [proposta]

### 6.1 Princípios

- **Só migrations novas**, numeradas depois de `20261017000000`; nenhuma edição em migrations antigas.
- Colunas novas são **anuláveis ou têm padrão**; nenhum `DROP`, `RENAME` ou `SET NOT NULL` em dado existente.
- Todo dado legado continua válido.
- **Nenhum valor novo de enum.** Os 8 estados de `TaskStatus` cobrem a fila (§7.1), o que evita
  `ALTER TYPE … ADD VALUE` e o seu risco transacional.
- Unicidade e idempotência por **índice único parcial** (padrão já usado no projeto).
- CHECKs e triggers de imutabilidade nas tabelas novas de histórico.

### 6.2 Fase 2: fila semanal

| Mudança                                                                                                                                                                                                                   | Motivo                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `production_plans.queue_mode VARCHAR(10) NOT NULL DEFAULT 'HORARIO'` + CHECK (`HORARIO`, `FILA`). A migration grava `HORARIO` em todos os planos existentes; planos novos nascem `FILA` (padrão na API, não no banco).    | Compatibilidade: planos antigos e publicados mantêm exatamente o comportamento atual.                            |
| `production_tasks.queue_position INT NULL` + índice `(assignee_user_id, queue_position) WHERE status IN ('BLOQUEADA','PROGRAMADA','LIBERADA','PAUSADA','EM_EXECUCAO')`                                                    | Ordem explícita da fila de cada pessoa, editável só pelo gestor; nulo nas tarefas legadas.                       |
| `production_tasks.carried_from_plan_id UUID NULL` (FK `production_plans`)                                                                                                                                                 | Transferência de pendências entre semanas sem perder a origem.                                                   |
| Tabela `production_task_work_intervals` (`task_id`, `user_id`, `started_at`, `ended_at NULL`, `end_reason`, `device_id`), imutável depois de fechada, com índice único parcial "um intervalo aberto por tarefa e usuário" | Tempo real de execução, inclusive com pausas e vários dias; hoje só existem `startedAt`/`completedAt` e eventos. |
| Ajuste em `evaluateRelease`: em plano `FILA`, sem bloqueio ⇒ **LIBERADA** (horário ignorado); em `HORARIO`, regra atual                                                                                                   | Remove a dependência do horário sem quebrar o legado.                                                            |
| Corrigir `finance/results.ts:381,385` (−3 h) para o fuso configurado e o código `'HORARIO'` de `reschedule.ts:497`                                                                                                        | Defeitos encontrados.                                                                                            |

### 6.3 Fase 3: titular por peça e geração idempotente

| Mudança                                                                                                                                                                                                 | Motivo                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `service_order_items.upholsterer_user_id UUID NULL` (FK `users`) + `template_id UUID NULL`                                                                                                              | Tapeceiro titular **por peça** e modelo escolhido explicitamente (hoje: o primeiro que casa).                               |
| Tabela `service_order_item_holder_changes` (`item_id`, `from_user_id`, `to_user_id`, `reason` ≥ 3, `authorized_by`, `created_at`, `labor_treatment`), imutável                                          | Substituição excepcional auditável.                                                                                         |
| `production_tasks.generation_key VARCHAR(120) NULL` + **índice único parcial** `WHERE generation_key IS NOT NULL AND status <> 'CANCELADA'`; a chave é `item:{itemId}:tpl:{templateId}:step:{position}` | Geração e reprocessamento idempotentes. Tarefas legadas ficam com chave nula.                                               |
| `production_tasks.template_step_position INT NULL`                                                                                                                                                      | Rastreabilidade etapa ↔ tarefa.                                                                                            |
| Tabela `activity_assignment_rules` (`activity` PK, `ownership` `TITULAR_PECA` \| `POOL`, `required_skill VARCHAR`, `active`)                                                                            | Competências configuráveis, sem nomes fixos; define que CORTE, COSTURA, REVESTIMENTO, MONTAGEM e ACABAMENTO são do titular. |
| Nova migration que **amplia** a CHECK de `employee_skills.skill` (DROP CONSTRAINT + ADD com a lista ampliada, que é um superconjunto da atual)                                                          | Competências novas, se necessárias; nenhum dado existente fica inválido.                                                    |
| `production_tasks.assignment_issue VARCHAR(40) NULL` (ex.: `SEM_PROFISSIONAL_ELEGIVEL`)                                                                                                                 | Pendência explícita quando ninguém é elegível; o bloqueador `SEM_RESPONSAVEL` já existe.                                    |

### 6.4 Fases 5–7: financeiro

| Mudança                                                                                                                                                                                                                                                               | Motivo                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Nada novo para o valor por peça:** reutilizar `ProductionPayable` por `serviceOrderItemId` (índice parcial `production_payables_item_active` já impede duplicar). Só a criação passa a ser feita pela OS (valor combinado da peça + titular), de forma idempotente. | Uma única fonte da verdade.                                                                       |
| Gatilho **ansioso** de `refreshLabor` na mudança de etapa da peça (aprovação da qualidade, embalagem, entrega), na mesma transação                                                                                                                                    | A liberação deixa de depender de alguém consultar.                                                |
| `logistics_costs.beneficiary_user_id UUID NULL` (FK `users`) mantendo `beneficiary` texto para o legado; tabela `logistics_cost_participants` (`cost_id`, `user_id`, `role` RECEBEDOR \| PARTICIPANTE) com único parcial "um RECEBEDOR por custo"                     | André recebedor e Izaías participante, sem segunda obrigação.                                     |
| Tabela `logistics_cost_services` (`cost_id`, `pickup_id NULL`, `delivery_id NULL`, CHECK exatamente um) com unicidade por serviço ativo                                                                                                                               | Uma viagem cobrindo várias retiradas e entregas e várias OS; hoje o custo liga a só um serviço.   |
| `company_settings.default_pickup_cost_cents` e `default_delivery_cost_cents` (NULL)                                                                                                                                                                                   | Padrão configurável com ajuste por serviço.                                                       |
| `logistics_costs.status` ampliado por CHECK com `PREVISTO`, `DEVIDO`, `NAO_DEVIDO` e `closing_id NULL`                                                                                                                                                                | Distinguir custo agendado, devido (executado) e não devido (cancelado ou frustrado sem cobrança). |
| Tabela `logistics_closings` (`beneficiary_user_id`, `week_start` CHECK segunda-feira, `status` ABERTO/FECHADO, `total_cents`, `payable_id UNIQUE`), com `@@unique(beneficiary_user_id, week_start)`                                                                   | Fechamento semanal: uma conta a pagar por recebedor e semana.                                     |
| Tabela `logistics_closing_adjustments` (`closing_id`, `cost_id NULL`, `amount_cents` ±, `reason`, `created_by`), imutável                                                                                                                                             | Ajuste depois do fechamento sem editar o fechado.                                                 |
| Tabela `payable_payment_reversals` (`payment_id UNIQUE`, `reason`, `created_by`), imutável, e o mesmo para `professional_payment_reversals`                                                                                                                           | Estorno auditável, seguindo o padrão de `CustomerPayment.reversalOfId`.                           |

### 6.5 Migração dos dados legados

- **Planos:** `queue_mode = 'HORARIO'` em todos os existentes. Nenhuma tarefa muda de status. Os
  horários históricos (`scheduledAt`) ficam intactos e continuam visíveis.
- **Tarefas:**
  - `generation_key` e `queue_position` ficam nulos; continuam válidas.
  - Uma **rotina opcional e idempotente** (não automática; acionada pelo gestor na Fase 2) pode
    preencher `queue_position` das tarefas abertas de um plano, pela ordem atual de `compareTasks`,
    e mudar o plano para `FILA` com revisão auditada.
- **Titular por peça:** preenchimento opcional a partir de `ProductionPlanItem.principalUserId` da
  semana mais recente com tarefas abertas, só com confirmação do gestor (incógnita I-3).
- **Financeiro:** `ProductionPayable`, `LogisticsCost`, pagamentos e eventos não são alterados.
  - `beneficiary_user_id` só é preenchido quando o texto coincidir exatamente com um usuário, e
    com revisão manual.
  - Custos antigos sem `closing_id` continuam com a conta a pagar individual (sem migração para o fechamento).

## 7. Algoritmo de distribuição e máquina de estados [proposta]

### 7.1 Máquina de estados da fila (reutilizando `TaskStatus`)

| Estado pedido | Estado existente                | Pré-condição                                                                                                                                     | Entra por                                                      | Sai para                                                                     |
| ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| pendente      | `RASCUNHO` (antes de publicar)  | plano não publicado                                                                                                                              | geração                                                        | `BLOQUEADA`/`LIBERADA` na publicação                                         |
| bloqueada     | `BLOQUEADA` + `blockers[]`      | algum impedimento (`OS_INATIVA`, `PECA_NAO_RECEBIDA`, `NAO_PUBLICADA`, `SEM_RESPONSAVEL`, `DEPENDENCIAS`, `MATERIAIS`, `BLOQUEIO`, `OCORRENCIA`) | `reevaluateTasks`                                              | `LIBERADA` quando todos somem                                                |
| executável    | `LIBERADA`                      | nenhum impedimento; em modo `FILA` **sem exigência de horário**                                                                                  | `reevaluateTasks`                                              | `EM_EXECUCAO` (só pelo responsável, botão Iniciar), `BLOQUEADA`, `CANCELADA` |
| em execução   | `EM_EXECUCAO`                   | responsável = sessão; revalidação no servidor                                                                                                    | `start`/`resume`                                               | `PAUSADA`, `CONCLUIDA`                                                       |
| pausada       | `PAUSADA` (+ `pauseImpediment`) | —                                                                                                                                                | `pause`, ocorrência, encerrar expediente, interrupção aprovada | `EM_EXECUCAO` (resume, se não houver bloqueio)                               |
| concluída     | `CONCLUIDA`                     | registro exigido (foto/observação)                                                                                                               | `complete`                                                     | — (reavalia as dependentes **na mesma transação**)                           |
| cancelada     | `CANCELADA`                     | gestor                                                                                                                                           | `cancel`                                                       | —                                                                            |
| (legado)      | `PROGRAMADA`                    | só em planos `HORARIO`                                                                                                                           | —                                                              | —                                                                            |

**Concorrência:**

- `lockTasks` (FOR UPDATE em ordem de id) continua.
- `start` e `complete` continuam idempotentes; `pause`, `resume` e `progress` passam a ser idempotentes também.
- **Proposta:** índice único parcial "no máximo uma tarefa EM_EXECUCAO por responsável", excluindo
  APOIO (decisão D-6, porque hoje é permitido).
- Os intervalos de trabalho abrem e fecham na mesma transação da transição.

**Próxima tarefa:**

- A fila de cada pessoa é ordenada por `queue_position` (gestor), depois `priority`, `sequence` e `id`.
- O "atual" é a EM_EXECUCAO ou PAUSADA.
- O "próximo" é a **primeira LIBERADA na ordem da fila**. Se a primeira da ordem estiver
  BLOQUEADA, o tablet mostra a primeira LIBERADA seguinte **sem alterar** `queue_position` nem `priority`.
- `suggestAlternative` deixa de antecipar `scheduledAt` em planos `FILA`; passa só a notificar.
- **Nunca** há início automático.

**Virada do dia:** nada muda (já é assim). **Virada da semana:** as pendências não somem. O gestor
transfere para o plano seguinte (§8.1).

### 7.2 Algoritmo determinístico de geração e atribuição

Entradas, ordenadas de forma estável:

- peças da OS por `position`;
- etapas do modelo da peça por `position`;
- regras `activity_assignment_rules`;
- competências e situação dos funcionários.

```
para cada peça P (ordem position):
  T ← P.template_id ?? primeiro modelo ativo por (createdAt, id) que contém P.pieceType
  se não houver T → pendência explícita "PECA_SEM_MODELO" (nenhuma tarefa criada)
  para cada etapa E de T (ordem position), pulando opcionais conforme o serviço:
    chave ← "item:P.id:tpl:T.id:step:E.position"
    se existe tarefa ativa com essa chave → reutiliza (nunca duplica); segue
    regra ← activity_assignment_rules[E.activity]
    se regra.ownership = TITULAR_PECA:
        responsável ← P.upholsterer_user_id
        se nulo ou sem a competência regra.required_skill → sem responsável,
           assignment_issue = SEM_PROFISSIONAL_ELEGIVEL
        (nunca divide: TODAS as etapas TITULAR_PECA da peça vão para o MESMO titular)
    senão (POOL):
        candidatos ← ativos, com regra.required_skill, com producao.executar
        escolhido ← menor (tarefas abertas atribuídas, nome normalizado, id)   // determinístico
        se nenhum → assignment_issue = SEM_PROFISSIONAL_ELEGIVEL
    cria a tarefa em RASCUNHO (não executável antes da publicação), com generation_key
  dependências por posição (como hoje), dentro da mesma OS
```

**Propriedades:**

- **Idempotência:** chave única parcial. Repetir a geração ou editar a OS só cria as tarefas que faltam.
- **Determinismo:** ordenações totais com `id` no desempate.
- **Exclusividade do tapeceiro:** todas as etapas `TITULAR_PECA` de uma peça têm o mesmo responsável.
  - A troca só acontece por substituição excepcional (gestor + motivo + `holder_changes` + tratamento da mão de obra, D-4).
  - **Nunca** por carga, ausência ou atraso: `analyzeAbsence` e `suggestAlternative` passam a
    ignorar tarefas `TITULAR_PECA`, o que hoje já vale para as PRINCIPAL.
- **Ajuda:** continua criando APOIO separada; a titularidade não muda.
- **Peça removida ou OS editada:** tarefas não iniciadas da peça removida → CANCELADA (com evento).
  Tarefas iniciadas → pendência para o gestor (nunca apagadas).
- **Inspeções (Thiago):** continuam nascendo pela regra da qualidade (`inspectIfProductionDone`),
  com a proibição de autoaprovação.

## 8. Fluxos de gestor e tablet; contratos de API e WebSocket [proposta]

### 8.1 Gestor

1. **Seleção da semana:** o gestor escolhe a semana (`ProductionPlan.weekStart`) e inclui as OS.
   A geração é automática (§7.2).
2. **Publicação:** revisa as pendências (sem responsável, sem modelo, sem material) e publica.
3. **Reordenação:** arrastar para reordenar a fila de uma pessoa (`queue_position`) ou mudar a
   prioridade. Em plano publicado, exige motivo e gera revisão (reutiliza `reviseIfPublished`).
4. **Fim da semana:** em "Transferir pendências", o gestor seleciona as tarefas não concluídas e
   escolhe a semana de destino.
   - O `planId` muda, `carried_from_plan_id` é preenchido e são gravados um evento `TRANSFERIDA_SEMANA` e uma revisão nos dois planos.
   - O histórico e os intervalos de trabalho são preservados.

### 8.2 Tablet

- **Topo:** tarefa atual ou próxima em destaque, com OS, peça, informações técnicas, situação,
  bloqueios e progresso.
- **Fila:** as próximas 3; o botão **"Ver todas"** abre a fila completa, paginada e só para leitura.
- **Inalterados:** presença, iniciar, pausar, retomar, concluir, fotos, ajuda, ocorrências, avisos e reconexão.
- **Sem reordenação** pelo funcionário. Nenhum valor financeiro na fila.

### 8.3 Contratos

| Rota [proposta]                                       | Acesso                                           | Observação                                                                       |
| ----------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/v1/production-tasks/mine/queue`             | `session:any`, `producao.executar`, só a própria | `{ current, next: [3], total, blockedAhead }`, sem janela de data                |
| `GET /api/v1/production-tasks/mine/queue/all?cursor=` | idem                                             | Fila completa paginada                                                           |
| `PUT /api/v1/production-plans/:id/queue/:userId`      | `PLAN` (WEB)                                     | Corpo `{ order: taskId[], reason?, version }`; idempotente; revisão se publicado |
| `POST /api/v1/production-plans/:id/carry-over`        | `PLAN`                                           | `{ taskIds, toWeekStart, reason }`                                               |
| `POST /api/v1/service-orders/:id/generate-tasks`      | `PLAN`                                           | Reprocessamento idempotente; resposta com criadas, mantidas e pendências         |
| `POST /api/v1/service-order-items/:id/holder`         | `PLAN` + motivo                                  | Substituição excepcional                                                         |
| Eventos (existentes)                                  | `user:{assignee}` \| `permission:producao.ver`   | `production.task.updated`, `PRODUCTION_PLAN_REVISED` (sem valores)               |
| Evento novo `production.queue.reordered`              | `user:{userId}` \| `permission:producao.ver`     | Payload `{ userId, planId, version }`; o tablet refaz a busca                    |

As chaves `invalidate` do tablet (`apps/web/lib/realtime.tsx:39-178`) ganham `my-queue`.

## 9. Matriz de permissões [proposta sobre as permissões existentes]

| Ação / dado                                                      | Gestor | Ricardo (tapeceiro) | Márcio (tapeceiro) | João (ajudante) | Thiago (qualidade) | André (logística) | Izaías (logística) |
| ---------------------------------------------------------------- | :----: | :-----------------: | :----------------: | :-------------: | :----------------: | :---------------: | :----------------: |
| Planejar semana, publicar, reordenar, transferir pendências      |   ✔   |          —          |         —          |        —        |         —          |         —         |         —          |
| Substituir titular da peça (com motivo)                          |   ✔   |          —          |         —          |        —        |         —          |         —         |         —          |
| Ver a própria fila; iniciar, pausar e concluir as próprias       |   —    |         ✔          |         ✔         |       ✔        |         ✔         |         —         |         —          |
| Reordenar a própria fila                                         |   ✔   |  só com permissão¹  | só com permissão¹  |        —        |         —          |         —         |         —          |
| Ver tarefas de outros (quadro)                                   |   ✔   |          —          |         —          |        —        |         —          |         —         |         —          |
| Inspecionar e aprovar (não o próprio serviço)                    |   ✔   |          —          |         —          |        —        |         ✔         |         —         |         —          |
| Ver o valor combinado/liberado/pago **próprio**                  |   ✔   |         ✔²         |        ✔²         |        —        |         —          |         —         |         —          |
| Ver o valor de **outro** tapeceiro                               |   ✔   |      **nunca**      |     **nunca**      |    **nunca**    |     **nunca**      |     **nunca**     |     **nunca**      |
| Executar retirada/entrega atribuída                              |   ✔   |          —          |         —          |        —        |         —          |        ✔         |         ✔         |
| Ver o custo do serviço e os valores devidos e pagos **ao André** |   ✔   |          —          |         —          |        —        |         —          |        ✔³        |         —          |
| Registrar pagamento, ajuste, estorno e fechamento                |  ✔⁴   |          —          |         —          |        —        |         —          |         —         |         —          |

¹ Hoje não existe; exige permissão nova e explícita (decisão D-7).
² Só com `financeiro.producao_propria` (já existe); filtro fixo pelo usuário da sessão (`labor.ts:374-416`).
³ Permissão nova `financeiro.logistica_propria` (proposta), espelhando `producao_propria`.
⁴ `financeiro.gerenciar` / `financeiro.ajustes` (já existentes, críticas).

**Regras de não vazamento**, a impor e testar nas Fases 5–7:

- DTOs de tarefa, fila, OS e WebSocket **sem campos monetários**.
- Valores só em rotas `/finance/*`, filtradas por permissão e, nas próprias, por `auth.userId`.
- Exportações CSV só com `financeiro.ver`.
- Eventos financeiros com audiência `financeiro.ver` ou `user:{dono}` e **sem valores no payload** (padrão atual).
- Testes negativos para cada par (Ricardo × Márcio, João/Thiago/André/Izaías × tapeceiros, Izaías × André).

## 10. Fluxos financeiros sem duplicação [proposta]

### 10.1 Tapeceiro: peça → combinado → qualidade → liberado → pago

1. **Combinado:** na OS, a peça recebe o valor combinado e o titular. É criado ou atualizado, de
   forma idempotente, **um** `ProductionPayable` (`serviceOrderItemId`, status PREVISTO), com
   evento `COMBINADO`. O índice parcial `production_payables_item_active` impede o segundo.
2. **Previsto:** `agreed + adjustments`.
3. **Liberado:** gatilho ansioso na aprovação da qualidade (regra padrão `QUALIDADE_APROVADA`),
   `eligibleAt` gravado. **Concluir a tarefa não libera** (regra da Fase 11 preservada; teste
   `finance.test.ts` "8").
4. **Pago e saldo:** `ProfessionalPayment` (parcial permitido, sem exceder; antecipado só com
   motivo); saldo = devido − pago.
5. **Ajuste e estorno:** `FinancialAdjustment` (existente). Estorno de pagamento: tabela nova de
   estorno, com lançamento negativo vinculado e imutável.
6. **Substituição de titular:**
   - Sem execução: o payable PREVISTO é transferido (cancelado e recriado, com eventos).
   - Com execução parcial: o gestor define o rateio entre os dois profissionais (D-4); nunca é automático.

### 10.2 Logística: agendamento → execução → custo único → rateio → obrigação → fechamento → pagamento

1. **Agendamento** de retirada ou entrega: `LogisticsCost` PREVISTO com o padrão configurável
   (ajustável), recebedor = André (usuário), Izaías como PARTICIPANTE. **Um único custo total**.
2. **Execução** concluída: o custo passa a DEVIDO; o rateio por OS (`LogisticsCostAllocation`, soma
   exata) entra na margem da OS **por competência**.
3. **Viagem com várias OS ou serviços:** um custo com vários `logistics_cost_services`, rateado entre as OS.
4. **Cancelado antes de executar:** NAO_DEVIDO. **Tentativa frustrada:** o gestor decide entre
   devido integral, parcial ou não devido, com motivo (D-8). **Reagendamento:** mesmo custo, nova
   data. **Devolução:** custo próprio (novo serviço).
5. **Fechamento semanal** (por recebedor e semana): soma os DEVIDO da semana mais os ajustes; gera
   **uma** `AccountPayable` (categoria LOGISTICA, _sem_ entrar como despesa de competência,
   porque o custo já entrou pelas alocações).
   - Exemplo: 8 × R$ 100 + 6 × R$ 100 = **R$ 1.400**.
6. **Pagamento:** `PayablePayment` (parcial permitido, comprovante como anexo).
   - Exemplo: pago R$ 600, saldo R$ 800.
   - O caixa conta o pagamento; a despesa **não** é contada de novo.
7. **Ajuste após fechamento:** `logistics_closing_adjustments`, que entra no próximo fechamento.
   **Estorno:** tabela nova de estorno de `PayablePayment`. **Sem Pix real.**

Separação dos conceitos:

- **custo** = `LogisticsCost` + alocações (competência);
- **obrigação** = `AccountPayable` do fechamento;
- **liquidação** = `PayablePayment` (caixa).

## 11. Compatibilidade, rollback e recuperação [proposta]

- **Antes de cada fase com migration:** backup com `scripts/backup.sh` mais teste de restauração
  (`scripts/test-backup-restore.sh`).
- **Migrations aditivas**, cada uma acompanhada de:
  - um teste em `migrations.test.ts` (tabelas, CHECKs, triggers);
  - um teste de compatibilidade com dados legados (planos `HORARIO` publicados continuam idênticos).
- **Rollback de aplicação:** voltar a imagem anterior (`vm.sh atualizar <etiqueta>`). As colunas
  novas ficam nulas ou com padrão e são ignoradas pelo código antigo.
- **Feature flag por plano:** `queue_mode`. Um plano `FILA` pode voltar a `HORARIO` com revisão
  auditada, desde que as tarefas tenham `scheduledAt` (a rotina preenche a partir da semana se faltar).
- **Rollback de dados:** não há `down migration` destrutiva. Em último caso, restaurar o backup da fase.
- **Nada apagado:** horários históricos, revisões, inspeções, pagamentos e auditoria permanecem.
  Tabelas novas de histórico são imutáveis.

## 12. Plano detalhado das Fases 2–8 [proposta]

| Fase                                                 | Escopo                                                                                                                                                                  | Pré-requisitos             | Alterações principais                                                                                                       | Testes previstos                                                                                                                                                                                                                                                      | Critérios de aceite / pronto                                                                                                  | Riscos                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **2. Planejamento semanal contínuo**                 | `queue_mode`, `queue_position`, intervalos de trabalho, liberação sem horário, reordenação com revisão, transferência de pendências, correções do −3 h e do `'HORARIO'` | Fase 1 aprovada; D-1, D-6  | Migration 13; `evaluateRelease`, `releaseDueTasks`, `/mine`, `suggestAlternative` (sem antecipar em FILA), planejamento web | Tarefa sem horário liberada em FILA; legado HORARIO idêntico; 20 tarefas, 4 concluídas na segunda, a 5ª é a próxima na terça; nenhuma duplicação na virada; reordenação com motivo; transferência mantém histórico; nunca inicia sozinha; concorrência na reordenação | Todos os testes existentes passam (com os de horário mantidos para HORARIO); novos testes passam; nenhum dado legado alterado | Testes acoplados a `time:'08:00'`; indicadores de atraso sem horário |
| **3. Distribuição automática e tapeceiro exclusivo** | Titular por peça, modelo por peça, `activity_assignment_rules`, geração idempotente, substituição excepcional                                                           | Fase 2; D-2, D-3, D-4, I-3 | Migration 14; `generateTasks` reescrito pelo algoritmo §7.2; `analyzeAbsence`/`suggestAlternative` respeitando TITULAR_PECA | Reprocessar 3× não duplica; editar OS só cria o que falta; todas as etapas de tapeçaria da peça com o mesmo titular; nunca troca por carga, ausência ou atraso; sem elegível ⇒ pendência; OS com 2 peças e 2 titulares; ajuda não transfere                           | Distribuição determinística (mesma entrada ⇒ mesma saída); auditoria das substituições                                        | Peças legadas sem titular; competências mal cadastradas              |
| **4. Tablet**                                        | Atual/próxima, próximas 3, "Ver todas", situação, bloqueios e progresso                                                                                                 | Fases 2–3                  | `/mine/queue`, `/mine/queue/all`, evento `production.queue.reordered`, componentes do tablet                                | E2E com 4 tablets: fila contínua entre dias; primeira bloqueada mostra a próxima executável sem mudar a ordem; reconexão; funcionário não reordena; nenhum valor no DTO e no WS                                                                                       | Fluxos atuais (presença, pausa, fotos, ajuda, ocorrências, avisos) sem regressão                                              | Desempenho da fila completa (paginação)                              |
| **5. Valores por peça e privacidade**                | Valor combinado na OS, criação idempotente do `ProductionPayable`, liberação ansiosa, estorno de pagamento ao profissional                                              | Fase 3; D-4                | Migration 15 (estornos); OS web; gatilhos de liberação                                                                      | Ricardo × Márcio nunca se veem (API, CSV, WS); João/Thiago/André/Izaías não veem tapeceiros; concluir tarefa não libera; qualidade libera; ajuste e estorno auditáveis; nenhuma obrigação duplicada                                                                   | Matriz §9 coberta por testes negativos                                                                                        | Vazamento por DTO compartilhado                                      |
| **6. Logística: custo único e rateios**              | Recebedor como usuário, participantes, padrão configurável, viagem com vários serviços, estados do custo, regras de cancelamento, frustração e devolução                | Fase 5; D-5, D-8           | Migration 16; agendamento de retirada/entrega com custo; rateio                                                             | André + Izaías com R$ 100 ⇒ **um** custo de R$ 100; viagem com 3 OS ⇒ soma exata; cancelado ⇒ não devido; frustrada conforme decisão; Izaías sem obrigação                                                                                                            | Nenhuma segunda conta a pagar; margem das OS correta                                                                          | Custos legados com beneficiário em texto                             |
| **7. Fechamento semanal e liquidações**              | Fechamento por recebedor e semana, pagamento parcial com comprovante, ajuste após fechamento, estorno                                                                   | Fase 6; D-9                | Migration 17; telas de fechamento                                                                                           | 8 retiradas + 6 entregas = R$ 1.400; pago R$ 600 ⇒ saldo R$ 800; ajuste vai para o próximo fechamento; estorno; caixa × competência sem contagem dupla                                                                                                                | Relatórios batem com a soma dos custos; nenhum Pix real                                                                       | Contagem dupla no painel (validar `results.ts`)                      |
| **8. Regressão integrada**                           | Segurança, concorrência, desempenho, backup/restauração e homologação                                                                                                   | Fases 2–7                  | Sem funcionalidade nova                                                                                                     | Suíte completa, E2E multi-tablet, testes de carga da fila, teste de restauração, varredura de permissões, homologação no GCP com autorização                                                                                                                          | GO/NO-GO com evidências                                                                                                       | Prazo                                                                |

## 13. Testes efetivamente executados e pendentes

Ambiente: este contêiner, Node 22, PostgreSQL 16 **local e descartável** (Docker, banco `cenario_test`, dados sintéticos). Nenhum acesso remoto.

| Comando                                                         | Resultado                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `git status`, `git rev-parse HEAD origin/...`                   | worktree limpo; HEAD = remoto (`76aae35`)                                                                  |
| `pnpm typecheck`                                                | OK (rc 0)                                                                                                  |
| `pnpm lint`                                                     | OK (rc 0)                                                                                                  |
| `prettier --check .`                                            | OK                                                                                                         |
| `pnpm --filter @cenario/shared test`                            | 53/53 (9 arquivos)                                                                                         |
| `pnpm --filter @cenario/web test`                               | 6/6 (2 arquivos)                                                                                           |
| `apps/api` `vitest run` (PostgreSQL local, `TEST_DATABASE_URL`) | **295/295 aprovados** (30 arquivos, 502 s; as 12 migrations aplicadas num banco vazio pelo `global-setup`) |

**Não executados (pendentes):**

- E2E Playwright das fases (`tests/e2e/specs`): exigem a pilha completa; ficam para a Fase 8 ou sob demanda.
- `scripts/test-backup-restore.sh`: executado no CI; não repetido aqui.
- Nada foi testado na homologação ou no Google Cloud (proibido nesta fase).

## 14. Matriz CA1-01 a CA1-10

| Critério                                                 | Situação     | Evidência                                                                                                                                                     |
| -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA1-01 Inventário e fontes de verdade com evidências     | **APROVADO** | §3 e §5, com caminhos e linhas verificados                                                                                                                    |
| CA1-02 Horários, dependências e continuidade comprovados | **APROVADO** | §4.1: código (`production-domain.ts:288-306`, `tasks.ts:662-697, 856-887`, `maintenance.ts`, `app.ts:238-272`) e teste existente `production.test.ts:252-268` |
| CA1-03 Fila semanal sem horários obrigatórios            | **APROVADO** | §6.2, §7.1, §8 (modo por plano, bloqueios, revisões)                                                                                                          |
| CA1-04 Atribuição idempotente e tapeceiro exclusivo      | **APROVADO** | §7.2 (chave única parcial, ordenações totais, TITULAR_PECA)                                                                                                   |
| CA1-05 Permissões sem vazamento                          | **APROVADO** | §9; base atual comprovada por `finance.test.ts:1066-1090` e `security-audit.test.ts`                                                                          |
| CA1-06 Financeiro reutilizando entidades                 | **APROVADO** | §10 reutiliza `ProductionPayable`, `LogisticsCost`, `AccountPayable` e `PayablePayment`; só acrescenta fechamento, participantes e estornos                   |
| CA1-07 Migração aditiva e rollback                       | **APROVADO** | §6.1, §6.5, §11                                                                                                                                               |
| CA1-08 Fases 2–8 com critérios e testes                  | **APROVADO** | §12                                                                                                                                                           |
| CA1-09 Riscos, conflitos e incógnitas explícitos         | **APROVADO** | §15; propostas marcadas como [proposta]                                                                                                                       |
| CA1-10 Nenhuma alteração operacional                     | **APROVADO** | §16: só este documento; nenhuma migration aplicada fora do banco local descartável; nenhum acesso remoto                                                      |

## 15. Riscos, decisões pendentes e GO/NO-GO

### Decisões de negócio pendentes

| Id  | Decisão                                                                                                                                                 | Afeta  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-1 | Planos já publicados migram para FILA ou ficam em HORARIO até terminar? (proposta: ficam em HORARIO; novos nascem FILA)                                 | Fase 2 |
| D-2 | Lista exata das atividades de tapeçaria (CORTE, CORTE_TECIDO, CORTE_ESPUMA, COSTURA, REVESTIMENTO, MONTAGEM, ACABAMENTO?) e se PREPARACAO_MDF é do João | Fase 3 |
| D-3 | Critério determinístico para as etapas de POOL (João): menor carga é aceitável para o apoio? (a tapeçaria nunca)                                        | Fase 3 |
| D-4 | Substituição de titular com execução parcial: como dividir o valor combinado entre os dois tapeceiros                                                   | 3, 5   |
| D-5 | Valores padrão de retirada e entrega e se a instalação tem custo próprio                                                                                | Fase 6 |
| D-6 | Pode haver duas tarefas EM_EXECUCAO para a mesma pessoa? (hoje é permitido)                                                                             | Fase 2 |
| D-7 | Algum tapeceiro poderá reordenar a própria fila?                                                                                                        | Fase 4 |
| D-8 | Tentativa de entrega frustrada é cobrada (integral, parcial ou não)?                                                                                    | Fase 6 |
| D-9 | O fechamento semanal fecha em qual dia e hora, e quem pode reabrir?                                                                                     | Fase 7 |

### Riscos e conflitos

**Riscos:**

- **Testes acoplados ao horário** (§4.2): precisam continuar válidos para o modo HORARIO e ganhar
  equivalentes em FILA.
- **Indicadores de atraso** sem horário: o "atraso" passa a ser relativo ao fim da semana do plano
  e ao `promisedDate` da OS. Precisa de redefinição.
- **Contagem dupla** no painel financeiro: o fechamento logístico não pode virar despesa operacional (§10.2).
- **Liberação preguiçosa da mão de obra:** comportamento atual que muda na Fase 5.
- **Concorrência** na reordenação: versão otimista no plano mais lock das tarefas da fila.

**Conflitos com o código atual:**

- `suggestAlternative` antecipa o horário, o que viola a regra de não mudar a prioridade.
- `analyzeAbsence` reatribui apoio automaticamente (permitido, mas nunca para TITULAR_PECA).

**Defeitos encontrados** (fora do escopo; corrigir na Fase 2):

- −3 h fixo em `finance/results.ts:381, 385`;
- `'HORARIO'` em `reschedule.ts:497`;
- relógio de teste que não afeta a liberação.

### Incógnitas

- **I-1:** volume real de tarefas por semana (desempenho da fila). Não medido; sem dados reais.
- **I-2:** se a equipe usa hoje `estimatedMinutes` e horários no dia a dia. A homologação física dirá.
- **I-3:** de onde preencher o titular das peças legadas; exige confirmação do gestor.

### GO/NO-GO

**GO condicionado** para iniciar a Fase 2, se e somente se:

- o gestor decidir **D-1** e **D-6**;
- a suíte da API continuar verde (§13).

As Fases 3, 5, 6 e 7 dependem de D-2, D-3, D-4, D-5, D-8 e D-9.

## 16. Arquivos alterados e commits

- Adicionado: `docs/EVOLUCAO-FASE-1-AUDITORIA-ARQUITETURA.md` (este documento).
- Nenhum outro arquivo alterado. Nenhum código funcional, migration, imagem ou configuração.
- Commit e push: ver a mensagem de entrega (o SHA final é informado na resposta, já que o documento
  não pode conter o próprio hash).
