# Simplificação operacional — Fase 1/10: auditoria e arquitetura

> Fase **exclusivamente** de auditoria, arquitetura, documentação e plano. Nenhum código
> funcional foi alterado, nenhuma migration foi criada ou executada, nada foi publicado, a
> homologação, o Google Cloud e o VerificaPro não foram tocados. Toda decisão marcada como
> **pendente** continua pendente até autorização explícita.

Convenções de citação: `API` = `apps/api/src/modules`, `schema` =
`packages/db/prisma/schema.prisma`, `shared` = `packages/shared/src`, `web` = `apps/web`,
`mig/<nome>` = `packages/db/prisma/migrations/<nome>/migration.sql`. Linhas referem-se ao SHA
`eb3fe2a`.

---

## 1. Identificação

| Item                                           | Valor                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Repositório                                    | `phaelnader-svg/cen-rio-app`                                                                        |
| Branch                                         | `claude/cenario-gestao-fase-1-zf3bj2`                                                               |
| HEAD local = `origin` no início                | `eb3fe2a66a535a668e0c95337f83c45c784bfea6` (worktree limpa)                                         |
| Versão informada como publicada na homologação | `eb3fe2a` — **não verificada na homologação** (sem acesso de rede a partir deste ambiente; ver §17) |
| SHA final                                      | commit deste documento (§19)                                                                        |

Stack confirmada: Fastify 5 (`apps/api`), Next 15 (`apps/web`), Prisma 6 + PostgreSQL 16
(`packages/db`), contratos zod (`packages/shared`), vitest e Playwright.

## 2. Resumo executivo

O sistema já tem **quase todas as peças** que a simplificação exige; o que falta é
**orquestração** (operações compostas atômicas) e **apresentação** (filas e uma central por
exceção). As regras financeiras das Fases 5–7 são sólidas e devem ser reutilizadas sem
duplicação.

**Achados principais**

1. **Hoje a OS não pode existir antes do recebimento**: bloqueio explícito em
   `API/service-orders/routes.ts:447-452` ("A OS técnica só pode ser criada depois que a peça
   chegar à oficina"), e o modelo assume isso (`schema:841`). Ao menos seis pontos a jusante
   dependem dessa invariante (§4.3). A regra "OS nasce no fechamento" é viável, mas é a
   mudança mais arriscada do plano → **decisão pendente D1**, com alternativa recomendada.
2. **Não existe orçamento/lead**: não há modelo de orçamento, proposta ou prospect
   (`schema`; o pedido é "criado após a aprovação do cliente", `schema:574`) → D2.
3. **Novo serviço exige ≥ 5 telas e 4–5 envios** (cliente → pedido → retirada → recebimento →
   OS; §4.1). A lógica de cliente, pedido e retirada está **inline nas rotas**, não em funções
   reutilizáveis dentro de transação (`API/customers/routes.ts:290-365`,
   `API/orders/routes.ts:189-250`, `API/pickups/routes.ts:190-301`).
4. **"A comprar" já desconta compras válidas** (`API/purchasing/purchase-orders.ts:479-489`,
   necessidade 20 − comprado 12 = 8), mas a lista consolidada de materiais mostra a
   quantidade **bruta** e pode induzir compra em dobro (`API/materials/routes.ts:124-151`).
5. **Risco real de recebimento de material em dobro** com dois tablets: a idempotência é por
   `(userId, chave)` (`apps/api/src/plugins/idempotency.ts:23-92`) e o recebimento não envia
   versão; duas contagens parciais de 10 do mesmo volume somam 20
   (`API/purchasing/receipts.ts:240-252`).
6. **O tablet mostra atraso ao funcionário**: `({lateMinutes} min)` em
   `web/components/tablet/presence.tsx:141-146`; a API envia `lateMinutes`/`arrivalKind`/
   `presumedAbsentAt` ao próprio tablet (`API/attendance/common.ts:274-280`) e os eventos
   `attendance.arrived/late` chegam com `lateMinutes` ao `user:<id>`
   (`API/attendance/routes.ts:179-194`).
7. **Meus Ganhos, negociação e confirmação semanal pelo profissional não existem.** Existe
   "Meus valores" com PIN só para mão de obra de tapeceiro (`API/finance/labor.ts:535-594`,
   `API/finance/labor-review.ts:569-598`); André não tem área própria; o fechamento tem só a
   conferência do gestor, sem hash nem confirmação do profissional
   (`API/finance/closing.ts:628-685`).
8. **Notificações nunca se resolvem sozinhas** (só `readAt`, `schema` model `Notification`
   ~L1961-1983; `API/notifications/routes.ts:66-68`) — fonte de avisos que permanecem depois de
   resolvidos. A Central de Atenção é calculada ao vivo (bom), mas com `take` que pode
   subcontar (`API/issues/attention.ts:58-103, 205-255, 277-281`).
9. **Modelos de produção**: escolha só por tipo de peça (`API/production/distribution.ts:159-172`)
   e um único responsável de preparação global (`CompanySettings.preparationAssigneeUserId`,
   `distribution.ts:113-129`) — não atende "João na reforma, Thiago na cabeceira" sem mudança
   aditiva.
10. **Thiago não é elegível como titular** (sem `CORTE_COSTURA`, `shared/help-domain.ts:84-88`;
    regra `upholstererOk`, `distribution.ts:100-103`) e **não pode ter mão de obra por peça**
    (`API/finance/labor.ts:236-240`: só tapeceiro) → D7/D8.

**Mudanças realmente necessárias (resumo)** — detalhadas no §16:

- Funções transacionais reutilizáveis para cliente/pedido/retirada + um endpoint composto
  "Novo serviço" (sem tabela nova, exceto orçamentos se D2 for aprovado).
- Recebimentos compartilhados no tablet: proteção de versão por pedido/retirada e contagem de
  volumes (colunas aditivas).
- Pré-planejamento em lote sobre o plano RASCUNHO existente (sem estado novo no banco).
- Modelos: escolha por tipo de serviço + responsável padrão por etapa (colunas aditivas).
- Compras: filas derivadas + correção da lista bruta; versão no recebimento.
- Presença/apoio: ocultar dados gerenciais em sessões de tablet (API, WS e texto de
  notificação); ajuda rápida sai do tablet.
- **Três tabelas novas estritamente necessárias**: solicitações de negociação, confirmações
  semanais e (se D2) orçamentos.
- Central do Gestor: endpoint agregado sem estado persistido + menu em seis áreas.

---

## 3. Inventário do sistema atual

### 3.1 Números (medidos neste SHA)

| Item                   | Quantidade                                              | Fonte                                                          |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Módulos de API         | 28 diretórios                                           | `apps/api/src/modules/*`                                       |
| Endpoints HTTP         | **333**                                                 | varredura de `app.get/post/put/patch/delete` em `apps/api/src` |
| Modelos Prisma / enums | 110 / 46                                                | `schema`                                                       |
| Migrations             | 18 (+ 6 scripts de rollback)                            | `packages/db/prisma/migrations`, `packages/db/rollback`        |
| Páginas web            | 52 (`page.tsx`), 1 rota de tablet com 12 telas internas | `web/app/**`, `web/components/tablet/home.tsx:39-51`           |
| Testes de API / E2E    | 55 arquivos / 22 specs                                  | `apps/api/test`, `tests/e2e/specs`                             |
| Permissões             | 46 chaves                                               | `shared/permissions.ts:40-365`                                 |
| Eventos de domínio     | ~130 tipos                                              | `shared/events.ts:9-139`                                       |

Endpoints por área (maiores): financeiro 67, medições 16, tarefas de produção 15, OS 13,
qualidade 13, planos de produção 13, entregas 12, ocorrências 11, clientes 11.

### 3.2 Migrations

| Migration                                | Tabelas novas | Observação                                                   |
| ---------------------------------------- | ------------- | ------------------------------------------------------------ |
| `20261008000000_fundacao`                | 15            | usuários, funções, dispositivos, sessões, auditoria, eventos |
| `20261008100000_comercial_oficina`       | 14            | clientes, pedidos, retiradas, recebimentos, OS               |
| `20261008200000_medicoes_materiais`      | 5             | medições, solicitações                                       |
| `20261009000000_compras_estoque`         | 13            | compras, estoque, reservas                                   |
| `20261010000000_producao`                | 8             | modelos, planos, tarefas (+ modelos padrão inseridos)        |
| `20261011000000_tablets_notificacoes`    | 2             | notificações                                                 |
| `20261012000000_presenca_operacional`    | 3             | presença                                                     |
| `20261013000000_ajuda_reprogramacao`     | 5             | ajuda, propostas                                             |
| `20261014000000_central_atencao`         | 2             | ocorrências                                                  |
| `20261015000000_qualidade_logistica`     | 16            | qualidade, embalagem, entregas, devoluções                   |
| `20261016000000_financeiro_operacional`  | 15            | financeiro operacional                                       |
| `20261017000000_auditoria_final`         | 0             | ajustes de integridade                                       |
| `20261018000000_fila_semanal`            | 0             | modo FILA_SEMANAL, exclusividade                             |
| `20261025000000_distribuicao_automatica` | 1             | titular por peça, classe de etapa                            |
| `20261101000000_mao_de_obra_revisao`     | 1             | revisões financeiras                                         |
| `20261108000000_custos_logistica`        | 3             | custos de viagem, participantes, rateio                      |
| `20261115000000_fechamento_semanal`      | 7             | fechamento, Pix em lote, estornos                            |
| `20261122000000_roteiro_logistica`       | 0             | `route_sequence`                                             |

As seis migrations da Evolução têm rollback condicionado que **recusa** reverter quando há
dados novos (verificado em `scripts/test-evolution-migrations.sh`).

### 3.3 Mecanismos transversais reutilizáveis

| Mecanismo                                        | Onde                                                                                                                            | Uso na simplificação              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Idempotência por cabeçalho                       | `apps/api/src/plugins/idempotency.ts:23-96`; `schema` `IdempotencyKey` L428-445 (único `(userId,key)`, TTL 24 h, hash do corpo) | toda operação composta nova       |
| Auditoria na mesma transação                     | `apps/api/src/core/audit.ts:24-38` (144 usos)                                                                                   | toda mudança                      |
| Outbox de eventos ordenado                       | `apps/api/src/core/events/append.ts:21-34` (lock consultivo)                                                                    | eventos novos                     |
| Audiência de eventos `all`/`permission:`/`user:` | `shared/events.ts:150-169`; filtro por conexão `apps/api/src/core/realtime/hub.ts:256-266`                                      | isolamento de Meus Ganhos         |
| Verificação de origem (CSRF)                     | `apps/api/src/plugins/auth.ts:60-65`                                                                                            | mantida                           |
| Acesso declarativo obrigatório por rota          | `apps/api/src/plugins/auth.ts:46-54, 157-188`                                                                                   | toda rota nova                    |
| Travas de linha / CAS por `version`              | ex.: `API/finance/common.ts:45-51`; `API/purchasing/purchase-orders.ts:438-446`                                                 | concorrência                      |
| PIN com limitação de tentativas                  | `API/finance/labor-review.ts:569-598`; `apps/api/src/core/throttle.ts:22`                                                       | Meus Ganhos e confirmação         |
| Processador de eventos (sem consumidores)        | `apps/api/src/core/events/processor.ts:28-149`, iniciado em `apps/api/src/app.ts:241-242`                                       | opcional para reações assíncronas |

---

## 4. Fluxo comercial: atual × proposto

### 4.1 Fluxo atual (código real)

| Passo          | Tela                                                                                                  | Endpoint                                                               | Observações                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cliente     | `/painel/clientes` → modal `CustomerForm`                                                             | `POST /api/v1/customers` (`API/customers/routes.ts:290-365`)           | trava consultiva global (`:298`); duplicidade por documento = 409, por telefone/e-mail/nome = `POSSIBLE_DUPLICATE` salvo `allowSimilar` (`:98-146`, `:300-302`)                                                       |
| 2. Pedido      | `/painel/pedidos/novo` (sem criação de cliente inline, `web/components/commercial/order-form.tsx:58`) | `POST /api/v1/orders` (`API/orders/routes.ts:189-250`)                 | valores exigem `pedidos.valores` (`:194-201`); status inicial `AGUARDANDO_RETIRADA` (`schema:587`)                                                                                                                    |
| 3. Retirada    | modal no detalhe do pedido (`order-detail.tsx:302`)                                                   | `POST /api/v1/pickups` (`API/pickups/routes.ts:190-301`)               | equipe `LOGISTICA_TERCEIRIZADA`/`EQUIPE_PROPRIA` (`schema:655-660`); responsável validado (`:216-222`); custo exige `financeiro.gerenciar` (`:195`) → `upsertTripCost` PREVISTO (`API/finance/trip-costs.ts:430-541`) |
| 4. Recebimento | `/painel/recebimentos/novo`                                                                           | `POST /api/v1/receipts` (`API/receipts/routes.ts:155-310`)             | aceita sessão de tablet (`:29`), mas **não há tela no tablet**; retirada vai a `RECEBIDA_NA_OFICINA` mesmo em recebimento parcial (`:253-270`); custo vira DEVIDO                                                     |
| 5. OS          | `/painel/os/nova?pedido=`                                                                             | `POST /api/v1/service-orders` (`API/service-orders/routes.ts:420-560`) | bloqueio antes do recebimento (`:447-452`); disponível = recebido − devolvido − em OS (`:461-469`)                                                                                                                    |

Status do pedido é **derivado** por `refreshOrderStatus` (`API/commercial/status.ts:24-45`);
`ServiceOrderStatus` só tem `ABERTA`/`CANCELADA` (`schema:806-811`).

### 4.2 Fluxo proposto: "Novo serviço" em um formulário

Seções: **Cliente** (buscar ou cadastrar) → **Serviço fechado** (peças, serviço contratado,
valor, condições) → **Retirada** (data, horário de chegada, endereço, equipe, responsável,
custo) → **Salvar**.

Operação composta `POST /api/v1/services` (nome provisório), **uma transação**, idempotente:

1. `resolveCustomer(tx, input)` — seleciona existente ou cria (mesma deduplicação de
   `findDuplicates`, hoje privada em `API/customers/routes.ts:98-134`, a ser extraída).
2. `createOrder(tx, …)` — extraída de `API/orders/routes.ts:202-247`.
3. `createPickup(tx, …)` — extraída de `API/pickups/routes.ts:198-294` (opcional: entrega pelo
   próprio cliente dispensa retirada).
4. `upsertTripCost(tx, …)` — já reutilizável (`API/finance/trip-costs.ts:430-541`).
5. Auditoria e eventos já existentes (`ORDER_CREATED`, `PICKUP_*`, `CUSTOMER_CREATED`).

Qualquer falha desfaz tudo (mesmo padrão já usado em `POST /api/v1/deliveries`,
`API/quality/routes.ts:724-743`, e na nova OS, `API/service-orders/routes.ts:439-557`).
**Permissões são verificadas por parte** (cliente: `clientes.gerenciar`; pedido:
`pedidos.gerenciar` e `pedidos.valores` para valores; retirada: `retiradas.gerenciar`; custo:
`financeiro.gerenciar`) — a tela pode ocultar seções, mas a API recusa a parte sem permissão.
Os endpoints atuais continuam existindo (compatibilidade).

### 4.3 Regra "a OS nasce no fechamento, aguardando as peças" — validação

Dependências que assumem OS ⇒ peça recebida:

| #   | Ponto                                 | Citação                                                                                                            | Efeito se a OS nascer antes                                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Criação da OS                         | `API/service-orders/routes.ts:447-452, 461-469`                                                                    | fórmula "disponível = recebido − devolvido − em OS" fica negativa                                                   |
| 2   | Liberação de tarefa                   | `shared/production-domain.ts:291, 318`; `API/production/common.ts:385-417`; `API/production/tasks.ts:952`          | já existe o bloqueio `PECA_NAO_RECEBIDA`, mas por item de pedido (`receivedQuantity > 0`), não por quantidade da OS |
| 3   | Recebimento não reavalia tarefas      | `API/receipts/routes.ts` (sem `reevaluateTasks`; nenhum consumidor de `receipt.registered`, `shared/events.ts:31`) | tarefas ficariam bloqueadas após a chegada                                                                          |
| 4   | Candidatos ao planejamento            | `API/production/plans.ts:668-690` (todas as OS `ABERTA`)                                                           | serviço não recebido entraria na fila de planejamento                                                               |
| 5   | Medições                              | `API/measurements/routes.ts:66-88` bloqueia; `:886-920` lista sem filtro                                           | inconsistência                                                                                                      |
| 6   | Correções de recebimento e devoluções | `API/quality/returns.ts:211, 475-530`; `shared/quality-domain.ts:485-499`                                          | limites calculados contra quantidade em OS                                                                          |
| 7   | Rateio de custo da retirada           | `API/finance/trip-costs.ts:301-320`                                                                                | passaria a ratear já no agendamento (efeito desejável)                                                              |

**Opções**

- **A — OS no fechamento com situação "aguardando peças"** (como proposto): exige novo valor
  de status ou campo derivado, rastreio de recebido **por item da OS**, mudança nos pontos 1–6
  e migração de dados zero (aditiva). Risco médio-alto, toca o coração do domínio.
- **B — OS gerada automaticamente na confirmação do recebimento** (recomendada): o gestor
  registra **uma vez** os dados técnicos no "Novo serviço" (tipo de serviço, tecido, titular,
  mão de obra prevista) como **intenção técnica do item do pedido** (colunas aditivas em
  `commercial_order_items`); quando a chegada é confirmada no tablet, a mesma transação do
  recebimento cria a OS a partir dessa intenção (`setUpholsterer`/`createLabor` já são
  chamáveis em transação, `API/service-orders/routes.ts:513-531`), com unicidade por item.
  Mantém a invariante do domínio, não mexe nos pontos 1–6, e o gestor continua com **um
  formulário e zero passos extras**.

**Recomendação padrão: B.** Consequência: o número da OS só existe após a chegada; antes disso
o serviço é identificado pelo número do pedido (que a tela "Serviços" apresenta como número do
serviço). → **Decisão pendente D1.**

### 4.4 Orçamento sem cliente definitivo

Não existe orçamento (`schema` sem modelo; "orçamentos" só aparece em descrição de função,
`shared/permissions.ts:397`). Cadastrar como cliente definitivo dispara a deduplicação por
documento/telefone (`API/customers/routes.ts:98-146`) e polui a base. **Proposta:** tabela
mínima `quotes` (contato livre, peças, valor, validade, status ABERTO/FECHADO/PERDIDO); ao
fechar, o orçamento alimenta o "Novo serviço" (cliente criado/selecionado nesse momento) e
guarda o vínculo. **Decisão pendente D2** (alternativa: adiar orçamentos para depois da Fase
10).

---

## 5. Recebimentos compartilhados (tablets)

### 5.1 Peças de clientes (retiradas)

**Existe:** status `RETIRADA_REALIZADA` (coleta concluída) e `RECEBIDA_NA_OFICINA`
(`schema:643-653`, transições `shared/domain.ts:112-134`); recebimento aceita sessão de tablet
com `recebimentos.registrar` (`API/receipts/routes.ts:29`); trava do pedido e itens
(`:175-176`).

**Proposta (sem estado novo no banco):**

| Situação exibida                 | Derivação                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Retirada prevista                | `AGENDADA` com data = hoje (aviso a partir do horário de chegada `windowStart`) |
| A caminho / em coleta            | `EM_EXECUCAO`                                                                   |
| **Chegada aguardada na oficina** | `RETIRADA_REALIZADA`                                                            |
| Recebida                         | `RECEBIDA_NA_OFICINA` (+ quem, quando: `Receipt.receivedBy*`, `receivedAt`)     |

- **Equipe:** terceirizada → André (+ Izaías quando participante); própria → responsável padrão
  configurável (Thiago). Coluna aditiva `own_team_default_user_id` em `company_settings` (hoje
  só há `logisticsPayeeUserId` e custos padrão, `schema` `CompanySettings` ~L350-361).
- **Confirmação da chegada no tablet:** botão único "Chegou" que envia o recebimento de todas
  as quantidades pendentes daquela retirada (condição padrão "BOA", local padrão configurável;
  divergências opcionais). Se D1=B, a mesma transação gera a OS.
- **Dois funcionários ao mesmo tempo:** a transação trava o pedido e os itens
  (`API/receipts/routes.ts:175-176`); o segundo envio encontra pendência zero. **Mudança:** em
  vez de erro, responder 200 "já confirmado por X às HH:MM" (idempotência semântica por
  retirada, além da por chave). Envio inclui `pickupVersion` esperado (CAS).
- **Aviso some de todos os tablets:** evento `receipt.registered` já existe; o cliente deve
  invalidar a lista de recebimentos e o aviso é **derivado** (não persistido), logo não fica
  órfão.
- **Lacuna a corrigir:** o recebimento não chama `reevaluateTasks` (§4.3, item 3).

### 5.2 Materiais

**Existe:** `GET /material-receipts/pending` e `POST /material-receipts`
(`API/purchasing/receipts.ts:122-168, 201-374`); recebimento parcial com saldo
(`receipts.ts:51-65, 155-158`); acima do pedido só com excedente autorizado (`:244-251`);
qualquer funcionário pode receber (`API/purchasing/common.ts:43-44`); trava do pedido de compra,
itens e estoque (`purchase-orders.ts:438-446`; `receipts.ts:216-220, 287`); reserva automática
por necessidade (`receipts.ts:72-116`); **não exige distribuição por OS**.

**Lacunas:**

1. **Contagem dupla com dois tablets** (achado 5): sem versão nem token de contagem.
2. **Não há contagem de volumes/peças** (`shared/schemas/purchasing.ts:150-198`); unidade
   `EMBALAGEM` é apenas unidade (`schema:1106-1115`).
3. **Recebimento físico = aprovação técnica**: aceito vira disponível na hora
   (`receipts.ts:197-199`).
4. **Prazo de entrega** existe (`PurchaseOrder.expectedDate`, `schema:1422`) mas não gera aviso
   compartilhado.

**Proposta:**

- `material_receipts.volumes_count` (inteiro opcional) e `material_receipts.expected_po_version`
  — aditivas. O envio leva a versão do pedido de compra lida; se outra contagem entrou antes,
  409 com o que já foi registrado ("Márcio registrou 10 às 09:12; confirme o restante").
- Aviso "Material previsto para hoje" derivado de `expectedDate` + itens com saldo.
- **Separação física × técnica** (decisão D5): opção padrão recomendada — manter "aceito =
  disponível" para materiais de estoque e criar **conferência técnica pendente** apenas para
  materiais exclusivos de OS (tecido), bloqueando o consumo até aprovação. Coluna aditiva
  `technical_status` (`PENDENTE|APROVADO|RECUSADO`) na linha de recebimento; a cobertura da
  necessidade (`API/purchasing/common.ts:364-417`) passa a contar somente aprovados para
  exclusivos.

---

## 6. Pré-planejamento ("Produção a planejar")

**Existe:** plano por semana com `RASCUNHO|PUBLICADO` e modo `LEGADO|FILA_SEMANAL`
(`schema:1685-1771`); modo imutável e planos antigos não convertidos
(`mig/20261018000000_fila_semanal:7, 54-65`); candidatos = OS `ABERTA` com `openTasks` e
`inPlan` (`API/production/plans.ts:668-718`); inclusão de **uma OS por chamada**
(`plans.ts:721-832`); publicação em um comando com CAS e revisão (`plans.ts:929-1011`);
geração sem duplicidade por índice único parcial
(`mig/20261025000000_distribuicao_automatica:60-62`) e `@@unique([planId, serviceOrderId])`
(`schema:1786`).

**Situações (derivadas, sem estado novo no banco):**

| Situação            | Derivação                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A planejar          | OS `ABERTA`, peça recebida, sem item de plano e sem tarefa ativa                                                                                 |
| Planejado           | item de plano; tarefas `RASCUNHO` ou liberadas e nunca iniciadas                                                                                 |
| Aguardando condição | tarefa `BLOQUEADA` com `blockers` (MATERIAIS, PECA_NAO_RECEBIDA…) ou `PAUSADA` com impedimento; `ServiceOrder.materialsReadiness` (`schema:872`) |
| Em produção         | alguma tarefa `EM_EXECUCAO`/`PAUSADA`/`CONCLUIDA` com obrigatórias pendentes                                                                     |
| Concluído           | todas as obrigatórias concluídas (`API/quality/common.ts:177-187`)                                                                               |

A fila "A planejar" **não mistura** serviços já planejados porque o filtro exige ausência de
item de plano.

**Proposta:** endpoint `POST /api/v1/production-plans/prepare` (lote): recebe
`[{serviceOrderId, startDate, upholstererUserId}]`, calcula a semana (`weekStart` da data),
cria/abre o plano `RASCUNHO` (FILA_SEMANAL) daquela semana, inclui as OS e distribui
(`distributeServiceOrder`, `API/production/distribution.ts:236-402`) na mesma transação por
semana; idempotente; não publica. A publicação continua sendo o comando único existente.
"Data de início" é usada para **escolher a semana e a ordem na fila** — não cria horário
(modo FILA_SEMANAL proíbe data por tarefa, `plans.ts:767-770`) → decisão D9.

Regras preservadas: tarefa não começa sozinha (só o responsável inicia,
`API/production/tasks.ts:935-937`); uma tarefa principal ativa por pessoa
(`tasks.ts:216-236` + índice `production_tasks_one_active_per_assignee`,
`mig/20261018000000_fila_semanal:49-51`); transferência entre semanas explícita
(`API/production/queue.ts:251-368`).

---

## 7. Novos modelos de produção

**Existe:** `ProductionTemplate`/`ProductionTemplateStep` com dependências por posição, classe
de etapa `PREPARACAO|TAPECARIA|OUTRA` (`schema:1693-1738`); classificação
(`shared/distribution-domain.ts:25-66`); modelos padrão (`shared/production-domain.ts:487-653`:
reforma de sofá 6 etapas, cabeceira 5, cadeira/poltrona 6); edição incrementa versão e peças já
geradas mostram `MODELO_ALTERADO` sem regenerar (`API/production/plans.ts:520-585`;
`distribution.ts:468-475`); titular exclusivo nas tarefas de tapeçaria por gatilho
(`mig/20261025000000_distribuicao_automatica:67-83`) e API (`distribution.ts:704-721`).

**Proposta:**

| Modelo                   | Etapa                       | Classe / atividade          | Responsável                         |
| ------------------------ | --------------------------- | --------------------------- | ----------------------------------- |
| Reforma de estofados     | 1. Desmontagem e preparação | PREPARACAO / DESMONTAGEM    | padrão da etapa: João               |
|                          | 2. Corte e costura          | TAPECARIA / CORTE_TECIDO    | titular (Ricardo ou Márcio)         |
|                          | 3. Montagem e acabamento    | TAPECARIA / MONTAGEM        | titular                             |
| Fabricação de cabeceiras | 1. Corte e preparação       | PREPARACAO / PREPARACAO_MDF | padrão da etapa: Thiago             |
|                          | 2. Tapeçaria e acabamento   | TAPECARIA / REVESTIMENTO    | titular (Thiago, Ricardo ou Márcio) |

Depois: inspeção (por habilitado, sem o executor) e embalagem — fluxo existente
(`API/quality/inspections.ts:326-355`; `API/quality/packaging.ts:149-220`).

Mudanças aditivas necessárias:

1. **Escolha do modelo por tipo de serviço**, não só por tipo de peça: coluna
   `service_types` em `production_templates` e ajuste em `templateFor`
   (`distribution.ts:159-172`). Hoje `serviceType` só pula etapas opcionais
   (`distribution.ts:349-352`).
2. **Responsável padrão por etapa**: coluna `default_assignee_user_id` em
   `production_template_steps`; o global (`distribution.ts:113-129`) vira fallback.
3. **Novos modelos como registros novos** (não editar os antigos): serviços em andamento
   mantêm modelo e versão; os antigos ficam inativos para novas gerações, nunca apagados.
4. **Thiago titular de cabeceira**: dar a competência `CORTE_COSTURA` pela tela de
   competências (configuração, sem código) **ou** relaxar `upholstererOk` para modelos de
   cabeceira → D7.
5. **Segregação:** `executorsOf`/`canDecideInspection` já impedem o executor
   (`API/quality/common.ts:190-213`; `shared/quality-domain.ts:71-87`), mas **o gestor passa
   mesmo tendo executado** — lacuna a fechar. Peça executada por Thiago (inspetor principal,
   `API/quality/common.ts:230-248`) precisa de inspetor substituto → D8.

**Impacto financeiro:** mão de obra por peça continua presa ao titular
(`API/finance/labor.ts:250-261`). Cabeceira com Thiago titular **não gera obrigação** (só
tapeceiro, `labor.ts:236-240`, "equipe de remuneração fixa") — correto se Thiago for fixo;
cabeceira com Ricardo/Márcio gera obrigação normal. Troca de titular abre revisão sem transferir
valores (`distribution.ts:201-209`; `API/finance/labor-review.ts:64-120`).

---

## 8. Compras sem duplicidade

**Existe:** necessidade aprovada (`MaterialRequirement`, `schema:1003-1040`); vínculo de
cobertura `PurchaseAllocation` com `@@unique([itemId, requirementId])` (`schema:1491-1507`);
bloqueio de compra acima da necessidade com trava `FOR UPDATE`
(`API/purchasing/purchase-orders.ts:262-310`); **"A comprar" já líquido** (`:465-529`, cálculo
em `:479-489`); recebimento parcial; reserva automática; testes de concorrência de reservas e de
recebimento total simultâneo (`apps/api/test/purchasing.test.ts:406, 552`).

**Três filas (derivadas):**

| Fila               | Derivação                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| A comprar          | `pendingToBuy > 0` (cálculo existente)                                                               |
| Aguardando entrega | itens de pedidos `CONFIRMADO`/`PARCIALMENTE_RECEBIDO` com saldo `qty + extra − recebido − encerrado` |
| Recebidos          | linhas de recebimento (imutáveis, `schema:1527-1579`)                                                |

Pedidos em **rascunho** já descontam do "A comprar" (`purchase-orders.ts:481`) — evita duas
compras em rascunho, mas pode esconder necessidade indefinidamente → mostrar "em rascunho há
N dias" (decisão D10).

**Correções necessárias:**

1. `GET /materials/consolidated` e CSV mostram quantidade **bruta**
   (`API/materials/routes.ts:124-151`) → exibir líquido ou rotular "bruto".
2. Estoque livre não é sugerido antes de comprar (necessidades de estoque) → sugerir reserva.
3. Saída livre de estoque (`API/purchasing/stock.ts:219-253`) e reserva sem necessidade não
   cobrem a necessidade (`API/purchasing/common.ts:396-405`) → manter, mas avisar.
4. Excedente do pedido sem dono vai para estoque livre — aceitável, documentar.
5. Recebimento com versão (§5.2) contra contagem dupla.

**Unidades:** não há conversão (`shared/purchasing-domain.ts:185-194`); identidade do material
= `specKey` (`:170-182`); decimais só em metro/m² (`shared/measurements-domain.ts:78-98` e check
no banco). **Volumes** serão só contagem informativa do recebimento; o saldo continua na unidade
do item — o recebimento simplificado **não cria saldo** a partir de volumes.

**Contas a pagar de compras não existem** (nenhuma chamada de `createPayable` a partir de
compras, `API/finance/payables.ts:98-139`) → fora do escopo; registrar como risco (D11).

---

## 9. Presença e apoio simplificados

### 9.1 Presença

**Exposição atual ao funcionário:**

- API `GET /attendance/me` e `POST /attendance/me/arrive` retornam `arrivalKind`,
  `lateMinutes`, `presumedAbsentAt` e a configuração de alerta
  (`API/attendance/routes.ts:96-235`; `API/attendance/common.ts:54-64, 235-287`).
- Eventos ao próprio usuário com `lateMinutes` (`API/attendance/routes.ts:179-194`;
  `API/attendance/absence.ts:83-101`); o hub envia o payload completo
  (`apps/api/src/core/realtime/hub.ts:256-262`).
- Notificação "Chegada confirmada (N min após o horário previsto)"
  (`API/attendance/routes.ts:196-204`).
- Tela: horário previsto, ausência presumida em vermelho, rótulo de atraso com minutos
  (`web/components/tablet/presence.tsx:30-31, 68-76, 141-146`).

**Proposta:** DTO de presença **por tipo de sessão**: sessão `DEVICE` recebe só
`{arrivedAt, departedAt, canStart}`; eventos `attendance.*` com dados gerenciais passam a ter
audiência `permission:presenca.ver` (sem `user:<id>`), e o próprio usuário recebe um evento sem
números; texto da notificação sem minutos. Painel do gestor inalterado.

**Natureza jurídica:** esconder indicadores na interface **não define** a natureza jurídica
(autônomo × empregado). Registro de chegada e indicadores gerenciais existentes continuam no
banco e no painel. Recomenda-se avaliação jurídica independente; esta auditoria não faz essa
afirmação.

### 9.2 Apoio

**Existe:** pedidos de ajuda rápida (`PARAFUSAR, MOVIMENTAR, AUXILIAR_MONTAGEM, POSICIONAR,
OUTRO`, `shared/help-domain.ts:12-34`; `kind` é `varchar(30)`, sem enum no banco) que criam
tarefa de APOIO separada sem mexer no titular nem em valores (`API/help/engine.ts:241-356`);
transferência formal via proposta `REASSIGN` decidida pelo gestor
(`API/help/reschedule.ts:830+`); ajuda não gera obrigação financeira
(`API/finance/labor.ts:236-257`; apoio só em relatórios, `API/finance/results.ts:407, 421`).

**Proposta:** o tablet deixa de oferecer ajuda rápida (registros antigos preservados e
visíveis no painel). Ficam dois pedidos formais:

1. **Transferência de tarefa** → cria `RescheduleProposal` de reatribuição (mecanismo
   existente), aprovada pelo gestor; se a tarefa for de tapeçaria, a regra de titular continua
   valendo e a troca de titular abre revisão financeira **sem transferir valores**.
2. **Apoio prolongado** → `HelpRequest` com `kind = 'APOIO_PROLONGADO'` (valor novo em campo
   texto, sem migration) exigindo aprovação do gestor antes de criar a tarefa de apoio.

---

## 10. Meus Ganhos

**Existe:** `GET /finance/my-production` (sessão própria, `financeiro.producao_propria`; tablet
exige PIN — `API/finance/routes.ts:415-433`) e `POST /finance/my-production/unlock` (PIN com
limitação, `API/finance/labor-review.ts:569-598`); filtro pelo usuário da sessão
(`API/finance/labor.ts:535-594`); tela com auto-ocultação em 2 min
(`web/components/tablet/my-values.tsx:10-31`).

**Faltam:** logística do André (custos de viagem com `payeeUserId`, `schema` `LogisticsCost`
L2961-3009), agrupamento por semana e histórico (`take 200`, sem semana), "aguardando
aprovação", serviços executados ainda sem valor, evento ao vivo próprio, token de desbloqueio.

**Proposta:**

- `GET /finance/my-earnings?week=` reutilizando **a mesma fonte do fechamento**
  (`buildClosingItems`, `API/finance/closing.ts:87-409`) filtrada por beneficiário — garante que
  Meus Ganhos e Fechamento mostrem os mesmos números (sem segundo financeiro).
- Quadros: previsto da semana, liberado, aguardando aprovação/qualidade, pago, saldo, histórico
  por semana, detalhe por peça/retirada/entrega. "Previsto" e "devido" sempre separados e
  rotulados.
- PIN: token de desbloqueio curto (ex.: 5 min, ligado à sessão do dispositivo) para não reenviar
  o PIN a cada tela — decisão D12.
- André recebe `financeiro.producao_propria` por configuração (função logística não tem hoje,
  `shared/permissions.ts:445`).
- Evento `finance.own_changed` com audiência `user:<id>` e **sem valores** (só invalida).
- Isolamento: nenhum parâmetro de usuário na rota; testes de IDOR e de WebSocket (os atuais
  cobrem só mão de obra: `apps/api/test/labor.test.ts:377, 447`).

---

## 11. Negociação de valores

**Existe:** edição de valor combinado só sem pagamento e sem revisão aberta
(`API/finance/labor-review.ts:227-269`); ajuste assinado após pagamento sem ficar abaixo do
pago (`API/finance/labor.ts:328-370`); ajuste de custo de viagem (`API/finance/trip-costs.ts:764-840`);
revisão por troca de titular trava pagamentos (`labor.ts:491-500`).

**Proposta — tabela nova `value_change_requests`:** alvo (`production_payable_id` **ou**
`logistics_cost_id`, check de exclusividade), solicitante, valor vigente no pedido (snapshot),
valor solicitado, justificativa, status `PENDENTE|APROVADA|RECUSADA|OBSOLETA`, decisor, motivo,
datas, `version`.

- **Uma solicitação aberta por alvo** (índice único parcial).
- Só o titular da obrigação / o recebedor da viagem pode pedir (verificação pela sessão).
- **Aprovação aplica pela via existente**: sem pagamento → `editLaborAgreed`; com pagamento →
  `adjustLabor` (nunca abaixo do pago); viagem → `upsertTripCost` (PREVISTO) ou
  `adjustTripCost` (DEVIDO). Nada apaga pagamentos nem cria obrigação nova.
- Se o valor vigente mudou depois do pedido, a solicitação vira `OBSOLETA` (CAS no snapshot).
- Revisão de titularidade aberta bloqueia a decisão.
- Recusa não altera nada. Toda decisão audita e gera `FinancialEvent`.

---

## 12. Confirmação semanal pelo profissional

**Existe:** fechamento por semana (`WeeklyClosing`, `schema:3084-3106`) com conferência do
gestor, versão e snapshot `{id, code, bucket, dueCents, totalDueCents}` (`API/finance/closing.ts:480-490,
628-685`); divergência calculada mas não aplicada (`closing.ts:492-598`); Pix em lote com
pagamentos parciais e estornos (`closing.ts:718-864`); CSV (`closing.ts:901-933`).
**Não existe confirmação do profissional**, e o pagamento em lote **não exige** semana conferida
(`closing.ts:746-750`); pagamento direto de mão de obra contorna o fechamento
(`API/finance/routes.ts:392`).

**Proposta — tabela nova `weekly_closing_confirmations`:** profissional, semana, versão do
fechamento, itens (JSON imutável: id, código, valor devido), total, **hash** do conteúdo
ordenado, data/hora, sessão e dispositivo, `pin_verified`, tipo `PROFISSIONAL|EXCECAO_ADMINISTRATIVA`
(+ motivo e autor na exceção), e invalidação (`invalidated_at`, motivo).

- Validade **recalculada ao vivo**: hash atual ≠ hash confirmado ⇒ confirmação inválida (sem
  gatilho, sem job).
- Só itens `DEVIDO` (liberados) entram; o gestor continua vendo tudo, inclusive não confirmados.
- **Portão de pagamento** (D13): o lote de pagamento do fechamento exige confirmação válida ou
  exceção administrativa (motivo + auditoria; nunca simula a confirmação do profissional).
- Pagamentos parciais, estornos e saldo anterior seguem as funções atuais — confirmação não
  movimenta dinheiro.

---

## 13. Central do Gestor e navegação

### 13.1 Menu atual

33 itens planos em `web/components/admin/nav.ts:46-205`, filtrados por permissão
(`web/components/admin/shell.tsx:68`). "Recebimento de materiais" não tem filtro (`nav.ts:154`).
A home (`web/components/admin/dashboard.tsx:66-147`) monta cartões a partir de listas no cliente
e tem textos desatualizados ("aguardando as próximas fases", cartão "Implantação").

### 13.2 Proposta em seis áreas (nenhuma tela removida)

| Área              | Itens atuais reunidos                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Início**        | Central do Gestor (nova), Central de atenção                                                                                                                     |
| **Serviços**      | Novo serviço (novo), Clientes, Pedidos, Retiradas, Roteiro do dia, Recebimentos, Ordens de serviço, Qualidade, Expedição e entregas, Devoluções                  |
| **Produção**      | A planejar (novo), Planejamento de produção, Quadro, Pedidos de ajuda, Reprogramação, Competências, Modelos, Medições, Planejamento de sexta, Presença da equipe |
| **Compras**       | Filas A comprar / Aguardando entrega / Recebidos, Compras, Fornecedores, Recebimento de materiais, Estoque, Prontidão, Materiais aprovados                       |
| **Financeiro**    | Financeiro (abas atuais), Fechamento semanal, Negociações (novo), Confirmações (novo)                                                                            |
| **Administração** | Funcionários, Funções e permissões, Dispositivos e sessões, Empresa, Auditoria, Sincronização, Conta                                                             |

### 13.3 Central do Gestor

Endpoint `GET /api/v1/manager/central` **sem estado persistido**: cada cartão é uma contagem
calculada no momento a partir da fonte de verdade, com chave estável e link para a ação:

| Cartão                             | Fonte                                                    | Ação                     |
| ---------------------------------- | -------------------------------------------------------- | ------------------------ |
| Serviços a planejar                | §6                                                       | A planejar               |
| Retiradas e entregas próximas      | `PickupStatus`/`DeliveryStatus` por data                 | Roteiro do dia           |
| Recebimentos aguardados            | `RETIRADA_REALIZADA` + compras com `expectedDate`        | Recebimentos             |
| Materiais a comprar                | `pendingToBuy` (`purchase-orders.ts:465-529`)            | Compras › A comprar      |
| Compras aguardando entrega         | §8                                                       | Compras › Aguardando     |
| Bloqueios de produção              | tarefas `BLOQUEADA` com blockers                         | Quadro filtrado          |
| Negociações                        | `value_change_requests` PENDENTE                         | Financeiro › Negociações |
| Fechamentos aguardando confirmação | semana atual sem confirmação válida por profissional     | Fechamento               |
| Pagamentos disponíveis             | itens `DEVIDO` confirmados e não pagos                   | Fechamento › Pagar       |
| Prontos para entrega               | `deliveryReadiness` (`shared/quality-domain.ts:279-290`) | Entregas                 |

Por ser derivado, o aviso **some quando a condição deixa de existir** (sem notificação órfã).
Contagens por `count()` (não `take`, evitando a subcontagem de `API/issues/attention.ts:277-281`).
Permissão por cartão (só aparece o que o usuário pode agir). Atualização: invalidação por
eventos + `refetchInterval`. Notificações: coluna aditiva `resolved_at` e resolução automática
nos pontos que fecham a condição (Fase 10).

---

## 14. Matriz de permissões

Permissões existentes (`shared/permissions.ts:40-365`); funções padrão
(`shared/permissions.ts:392-452`): gestor = todas; tapeceiro; cabeceiras_qualidade (+
inspecionar); ajudante; logística terceirizada. **Atenção:** o seed só aplica permissões às
funções não-gestor quando estão vazias (`packages/db/src/seed.ts:92-98`) — permissões novas
**não chegam** a funções existentes sem ação explícita (migration de dados ou configuração pela
tela de funções).

| Capacidade nova                     | Permissão proposta                                                                                                  | Gestor | Tapeceiro (Ricardo, Márcio) | Cabeceiras/qualidade (Thiago) | Ajudante (João) | Logística (André, Izaías) |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- | ----------------------------- | --------------- | ------------------------- |
| Novo serviço (composto)             | partes: `clientes.gerenciar`, `pedidos.gerenciar`, `pedidos.valores`, `retiradas.gerenciar`, `financeiro.gerenciar` | ✔     | —                           | —                             | —               | —                         |
| Confirmar chegada de peças (tablet) | `recebimentos.registrar` (existente)                                                                                | ✔     | config.                     | config.                       | config.         | config.                   |
| Receber material (tablet)           | qualquer funcionário (existente, `API/purchasing/common.ts:43-44`)                                                  | ✔     | ✔                          | ✔                            | ✔              | ✔                        |
| Conferência técnica de material     | `estoque.autorizar` (existente)                                                                                     | ✔     | —                           | —                             | —               | —                         |
| Pré-planejar / publicar             | `producao.planejar` (existente)                                                                                     | ✔     | —                           | —                             | —               | —                         |
| Meus Ganhos                         | `financeiro.producao_propria` (existente)                                                                           | —      | ✔                          | — (fixo)                      | — (fixo)        | André ✔                  |
| Pedir negociação                    | `financeiro.producao_propria` + titularidade                                                                        | —      | ✔                          | —                             | —               | André ✔                  |
| Decidir negociação                  | `financeiro.ajustes` (existente)                                                                                    | ✔     | —                           | —                             | —               | —                         |
| Confirmar semana                    | `financeiro.producao_propria` + PIN                                                                                 | —      | ✔                          | —                             | —               | André ✔                  |
| Exceção administrativa              | `financeiro.ajustes` + motivo                                                                                       | ✔     | —                           | —                             | —               | —                         |
| Central do Gestor                   | `painel.acessar` + permissão de cada cartão                                                                         | ✔     | —                           | —                             | —               | —                         |

Nenhuma permissão existente é enfraquecida; "config." = concedido pelo gestor na tela de
funções, não automaticamente.

---

## 15. Integridade, migrations e rollback

| Alteração de banco (todas aditivas)                                                                                | Fase | Rollback                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------- |
| `commercial_order_items`: intenção técnica (tipo de serviço, tecido, titular e mão de obra previstos) — só se D1=B | 2/3  | remover colunas; recusa se houver OS geradas a partir delas |
| `quotes` (+ vínculo no pedido) — só se D2 aprovado                                                                 | 2    | recusa se houver orçamento fechado vinculado                |
| `company_settings.own_team_default_user_id`                                                                        | 2    | remover coluna                                              |
| `material_receipts.volumes_count`, `expected_po_version`; `material_receipt_lines.technical_status`                | 3/6  | remover; recusa se houver linha `PENDENTE`/`RECUSADO`       |
| `production_templates.service_types`; `production_template_steps.default_assignee_user_id`                         | 5    | remover; modelos novos ficam inativos                       |
| `value_change_requests`                                                                                            | 8    | recusa se houver registros                                  |
| `weekly_closing_confirmations`                                                                                     | 9    | recusa se houver registros                                  |
| `notifications.resolved_at`                                                                                        | 10   | remover coluna                                              |

Princípios: nenhuma exclusão de dados; nenhuma conversão automática de planos antigos; cada
migration com rollback condicionado e entrada no teste de evolução
(`scripts/test-evolution-migrations.sh`); backup antes de aplicar; aplicação explícita pelo
runbook existente.

**Pontos em que a simplificação pode esconder obrigação:**

1. Botão único "Chegou" pode esconder divergência/avaria → divergência opcional mas visível no
   painel e no Central.
2. Ocultar ajuda rápida pode apagar a prova de apoio relevante → manter "apoio prolongado".
3. Meus Ganhos pode confundir previsto com devido → rótulos e quadros separados (CA).
4. Pagamento direto fora do fechamento contorna a confirmação → D13.
5. "Aceito = disponível" pode liberar tecido errado → D5.
6. Central derivada pode ocultar item se a permissão do cartão for mal mapeada → testes por
   perfil.

---

## 16. Plano das Fases 2–10

Formato por fase: escopo · dependências · mudanças técnicas · critérios de aceite · testes ·
riscos · GO/NO-GO. Todas exigem: lint, typecheck, suíte de API completa, E2E completo com
geometria estrita, teste de migrações e relatório próprio; nenhuma inicia sem autorização.

### Fase 2 — Novo serviço, cliente e retirada integrados

- **Escopo:** formulário único; extração de `resolveCustomer`, `createOrder`, `createPickup` para
  funções com `tx`; endpoint composto; equipe própria com responsável padrão; orçamentos se D2.
- **Dependências:** D1, D2, D3.
- **Mudanças:** API (`customers`, `orders`, `pickups`, novo `services`), shared (schema composto),
  web (tela "Novo serviço"), coluna `own_team_default_user_id`.
- **Critérios:** CA2-01 cliente novo + pedido + retirada + custo em uma transação; CA2-02 falha em
  qualquer parte não deixa registro parcial; CA2-03 repetição com a mesma chave devolve o mesmo
  resultado; CA2-04 cliente existente não é duplicado (documento = bloqueio; semelhante = aviso);
  CA2-05 cada parte respeita sua permissão; CA2-06 endpoints antigos inalterados; CA2-07 sem
  retirada (cliente entrega) funciona; CA2-08 equipe própria preenche Thiago por padrão;
  CA2-09 horário de chegada obrigatório com data; CA2-10 orçamento (se D2) não cria cliente até
  o fechamento.
- **Testes:** API (atomicidade com falha injetada em cada passo, idempotência, concorrência de
  dois "Novo serviço" com o mesmo cliente), E2E 390/1440.
- **Riscos:** regressão nos endpoints antigos ao extrair funções → testes existentes como rede.
- **GO:** CA2 todos ✔ e regressão verde.

### Fase 3 — Recebimentos compartilhados

- **Escopo:** área "Recebimentos" no tablet (peças e materiais), botão "Chegou", avisos
  derivados, CAS por retirada/pedido de compra, volumes, reavaliação de tarefas após
  recebimento; se D1=B, geração automática da OS.
- **Dependências:** Fase 2; D1, D4, D5.
- **Critérios:** CA3-01 aviso aparece no horário de chegada; CA3-02 coleta concluída → "chegada
  aguardada"; CA3-03 confirmação registra quem e quando; CA3-04 dois tablets confirmando ao
  mesmo tempo → um registro, o outro vê "já confirmado"; CA3-05 aviso some de todos os tablets;
  CA3-06 material parcial mantém saldo; CA3-07 duas contagens parciais concorrentes não somam
  em dobro (409 com versão); CA3-08 sem distribuição por OS na chegada; CA3-09 conferência
  técnica (se D5) bloqueia consumo; CA3-10 tarefas reavaliadas após a chegada; CA3-11 (D1=B) OS
  gerada uma única vez por item.
- **Testes:** concorrência real (duas conexões), WebSocket, E2E com 2 tablets.
- **Riscos:** contagem dupla (P1), geração duplicada de OS.

### Fase 4 — Produção a planejar

- **Escopo:** fila derivada; seleção múltipla; data de início → semana; responsável; endpoint de
  lote; publicação única existente.
- **Dependências:** Fase 3 (recebido); Fase 5 recomendada antes ou junto (modelos novos).
- **Critérios:** CA4-01 fila só com recebidos não planejados; CA4-02 planejado sai da fila;
  CA4-03 lote cria/abre o plano da semana correta; CA4-04 nenhuma tarefa duplicada em repetição
  ou concorrência; CA4-05 dependências preservadas; CA4-06 planos LEGADO intocados; CA4-07
  tarefa não inicia sozinha; CA4-08 uma principal ativa por pessoa.
- **Riscos:** semana errada por fuso (usar `America/Sao_Paulo`, já padronizado).

### Fase 5 — Modelos de produção simplificados

- **Escopo:** modelos novos (reforma 3, cabeceira 2), escolha por serviço, responsável por etapa,
  regra de Thiago, segregação na inspeção.
- **Dependências:** D6, D7, D8.
- **Critérios:** CA5-01 reforma gera 3 tarefas com João/titular/titular; CA5-02 cabeceira com
  Thiago → Thiago nas duas; com Ricardo/Márcio → Thiago prepara e titular faz tapeçaria; CA5-03
  executor não aprova a própria peça (inclusive gestor executor, se D8); CA5-04 serviços em
  andamento mantêm modelo antigo; CA5-05 mão de obra por peça inalterada; CA5-06 nenhuma geração
  duplicada.
- **Riscos:** troca de modelo no meio da execução; inspetor indisponível.

### Fase 6 — Compras sem duplicidade

- **Escopo:** três filas, lista consolidada líquida, sugestão de estoque livre, rascunhos
  envelhecidos, versão no recebimento (se não feita na Fase 3).
- **Dependências:** D10, D11.
- **Critérios:** CA6-01 20 − 12 = 8 a comprar; CA6-02 coberto não reaparece; CA6-03 compra
  concorrente acima da necessidade recusada; CA6-04 cancelamento devolve a quantidade à fila;
  CA6-05 parcial fica em "Aguardando"; CA6-06 lista consolidada não induz compra em dobro;
  CA6-07 unidades nunca misturadas; CA6-08 volumes não alteram saldo.

### Fase 7 — Presença e apoio simplificados

- **Escopo:** DTO e eventos de presença por tipo de sessão; textos; ajuda rápida fora do tablet;
  transferência e apoio prolongado com aprovação.
- **Critérios:** CA7-01 tablet sem atraso/minutos/pontualidade (tela, API, WS, notificação);
  CA7-02 painel do gestor inalterado; CA7-03 transferência só com aprovação; CA7-04 apoio
  prolongado não transfere valores; CA7-05 histórico de ajudas preservado.
- **Riscos:** vazamento por evento antigo em cache do cliente → teste de payload.

### Fase 8 — Meus Ganhos e negociação

- **Escopo:** `my-earnings` sobre a fonte do fechamento; André; token de desbloqueio; tabela
  `value_change_requests`; decisão do gestor pelas funções existentes.
- **Dependências:** D12; Fase 9 compartilha a mesma fonte.
- **Critérios:** CA8-01 totais iguais aos do fechamento; CA8-02 previsto × devido separados;
  CA8-03 ninguém vê valores de outro (HTTP e WS); CA8-04 só aprovação altera valor; CA8-05 sem
  obrigação duplicada nem pagamento apagado; CA8-06 obsoleta se o valor mudou; CA8-07 bloqueio
  com revisão de titularidade aberta.

### Fase 9 — Confirmação semanal

- **Escopo:** tabela de confirmações, hash, PIN, invalidação ao vivo, exceção administrativa,
  portão de pagamento (D13).
- **Critérios:** CA9-01 confirmação grava profissional, semana, versão, itens, valores, data,
  PIN; CA9-02 mudança de valor invalida; CA9-03 gestor vê não confirmados; CA9-04 lote de
  pagamento exige confirmação válida ou exceção; CA9-05 exceção não simula o profissional;
  CA9-06 parciais, estornos e saldo anterior preservados.

### Fase 10 — Central do Gestor, navegação e auditoria final

- **Escopo:** endpoint agregado, menu em seis áreas, `resolved_at` em notificações, regressão
  integral, auditoria final.
- **Critérios:** CA10-01 cada cartão leva à ação; CA10-02 contagem = fonte; CA10-03 aviso some
  ao resolver; CA10-04 sem duplicidade de aviso; CA10-05 cartões por permissão; CA10-06 todas as
  telas antigas acessíveis por submenu.

---

## 17. Critérios de aceite da Fase 1

| CA     | Critério                                              | Resultado                                                                                        |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| CA1-01 | HEAD, worktree e arquitetura confirmados no código    | ✔ `eb3fe2a`, limpo; §1, §3                                                                      |
| CA1-02 | Versão publicada na homologação confirmada            | ✘ **não verificada** — sem acesso de rede à homologação neste ambiente (403 na política de rede) |
| CA1-03 | Fluxo comercial auditado com citações                 | ✔ §4                                                                                            |
| CA1-04 | Recebimentos auditados e arquitetura proposta         | ✔ §5                                                                                            |
| CA1-05 | Pré-planejamento sem estados novos no banco           | ✔ §6                                                                                            |
| CA1-06 | Modelos novos e impacto financeiro                    | ✔ §7                                                                                            |
| CA1-07 | Compras: filas, regra 20−12=8, proteções              | ✔ §8                                                                                            |
| CA1-08 | Presença/apoio: exposição atual mapeada               | ✔ §9                                                                                            |
| CA1-09 | Meus Ganhos, negociação, confirmação                  | ✔ §10–12                                                                                        |
| CA1-10 | Central e navegação                                   | ✔ §13                                                                                           |
| CA1-11 | Matriz de permissões                                  | ✔ §14                                                                                           |
| CA1-12 | Migrations aditivas e rollback                        | ✔ §15                                                                                           |
| CA1-13 | Plano 2–10 com CA, testes, riscos, GO                 | ✔ §16                                                                                           |
| CA1-14 | Matriz de rastreabilidade                             | ✔ §20                                                                                           |
| CA1-15 | Nenhuma alteração funcional                           | ✔ só este arquivo no commit                                                                     |
| CA1-16 | Testes locais executados e reportados com honestidade | ✔ §17.1                                                                                         |

### 17.1 Verificações executadas (locais, PostgreSQL descartável)

| Verificação                                  | Como                                                                                                                                                                                                                                                    | Resultado                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Estado do repositório                        | `git rev-parse`, `git status`, `git fetch`                                                                                                                                                                                                              | HEAD = origin = `eb3fe2a`, worktree limpa                                                                                      |
| Inventário de rotas web                      | varredura de `apps/web/app/**/page.tsx` + `nav.ts`                                                                                                                                                                                                      | 52 páginas, 33 itens de menu, 1 rota de tablet (12 telas)                                                                      |
| Inventário de endpoints                      | varredura de `apps/api/src`                                                                                                                                                                                                                             | 333 endpoints                                                                                                                  |
| Inventário de migrations                     | leitura das 18 migrations e 6 rollbacks                                                                                                                                                                                                                 | §3.2                                                                                                                           |
| Mapeamento de permissões                     | `shared/permissions.ts`, `seed.ts`                                                                                                                                                                                                                      | §14                                                                                                                            |
| Fluxos de API, regras financeiras, contratos | leitura do código, com citações; amostras conferidas manualmente (`service-orders/routes.ts:447-452`, `purchase-orders.ts:479-489`, `receipts.ts:240-252`, `presence.tsx:141-146`, `attendance/common.ts:274-280`, `seed.ts:92-98`, `labor.ts:236-240`) | conferido                                                                                                                      |
| Lint                                         | `pnpm lint` (`--max-warnings=0`)                                                                                                                                                                                                                        | ✔ limpo                                                                                                                       |
| Tipos                                        | `pnpm typecheck` (shared, db, api, web, e2e)                                                                                                                                                                                                            | ✔ limpo                                                                                                                       |
| Testes unitários de domínio                  | `packages/shared` → `pnpm test`                                                                                                                                                                                                                         | ✔ 77/77                                                                                                                       |
| Suíte de API                                 | `apps/api` → `pnpm test` (PostgreSQL 16 local, recriado a cada teste)                                                                                                                                                                                   | ✔ 386 aprovados; 5 arquivos ignorados (desempenho e migração, ativados por variável de ambiente)                              |
| E2E (Playwright)                             | —                                                                                                                                                                                                                                                       | **não executado nesta fase** (último resultado: 29/29 no SHA `eb3fe2a`, relatório `CORRECAO-GLOBAL-INTERFACE-OS-LOGISTICA.md`) |
| Homologação                                  | `curl https://teste.cenariogestao.com.br`                                                                                                                                                                                                               | **bloqueado** (403 da política de rede do ambiente) — nada verificado lá                                                       |

**Cobertura ausente identificada (para as próximas fases):** duas contagens parciais
simultâneas do mesmo recebimento de material; teste explícito 20−12=8; saída livre/reserva sem
necessidade mantendo a necessidade aberta; reavaliação de tarefa por vínculo de material quando a
OS não muda de estado (`API/production/common.ts:489-501`); recebimento de peça reavaliando
tarefas; sessão de tablet de usuário com `financeiro.ver` recebendo eventos financeiros
(`apps/api/src/core/realtime/hub.ts:256-266` filtra por permissão, não por tipo de sessão);
payload de presença sem dados gerenciais no tablet.

---

## 18. Riscos e decisões pendentes

Nenhuma decisão abaixo está aprovada. Cada uma traz a **opção padrão recomendada**.

| #   | Decisão                                                       | Recomendação padrão                                                                                      | Consequência                                                              |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | OS no fechamento (A) ou gerada automaticamente na chegada (B) | **B**                                                                                                    | número de OS só após a chegada; risco baixo; nenhuma regra a jusante muda |
| D2  | Orçamentos sem cliente definitivo                             | tabela mínima `quotes` na Fase 2                                                                         | +1 tabela; base de clientes limpa                                         |
| D3  | Responsável padrão da equipe própria                          | coluna em `company_settings` (Thiago)                                                                    | configurável, sem código fixo                                             |
| D4  | Quem confirma chegada de peças                                | conceder `recebimentos.registrar` às funções de oficina pela tela de funções                             | decisão do gestor, auditável                                              |
| D5  | Conferência técnica de material                               | só para materiais exclusivos de OS (tecido)                                                              | estoque comum segue imediato                                              |
| D6  | Modelos novos convivem com os antigos                         | novos registros; antigos inativos para novas gerações                                                    | serviços em andamento intactos                                            |
| D7  | Thiago titular de cabeceira                                   | conceder competência `CORTE_COSTURA` (configuração)                                                      | sem mudança de regra no código                                            |
| D8  | Segregação quando o gestor executou                           | bloquear também o gestor executor; inspetor substituto configurável                                      | exige segundo inspetor habilitado                                         |
| D9  | "Data de início" no pré-planejamento                          | define semana e ordem, não horário                                                                       | mantém FILA_SEMANAL                                                       |
| D10 | Rascunhos de compra descontam do "a comprar"                  | manter + alerta de envelhecimento                                                                        | evita duas compras                                                        |
| D11 | Contas a pagar de compras                                     | fora do escopo desta simplificação                                                                       | documentado como risco                                                    |
| D12 | Token de desbloqueio do PIN                                   | 5 min por sessão de dispositivo                                                                          | menos digitação, risco controlado                                         |
| D13 | Portão de pagamento                                           | lote do fechamento exige confirmação/exceção; pagamento direto de itens semanais bloqueado salvo exceção | integridade maior; muda rotina do gestor                                  |
| D14 | Remuneração de Thiago/João em cabeceira/preparação            | sem obrigação por peça (equipe fixa, regra atual)                                                        | nenhuma mudança financeira                                                |

**Riscos**

| Risco                                             | Nível               | Mitigação                           |
| ------------------------------------------------- | ------------------- | ----------------------------------- |
| Contagem dupla de material com dois tablets       | P1 (existe hoje)    | CAS de versão + volumes (Fases 3/6) |
| OS antes do recebimento (D1=A)                    | Alto                | escolher B                          |
| Pagamento fora do fechamento contorna confirmação | Médio               | D13                                 |
| Atraso visível ao funcionário                     | Médio (existe hoje) | Fase 7                              |
| Avisos persistidos ficam órfãos                   | Médio (existe hoje) | Central derivada + `resolved_at`    |
| Subcontagem por `take` na Central de Atenção      | Baixo (existe hoje) | `count()`                           |
| Permissões novas não chegam às funções existentes | Médio               | ação explícita documentada          |
| Lista consolidada bruta induz compra em dobro     | Médio (existe hoje) | Fase 6                              |

---

## 19. GO/NO-GO técnico

| Item                                                                   | Situação                  |
| ---------------------------------------------------------------------- | ------------------------- |
| Auditoria do código real com citações                                  | ✔                        |
| Arquitetura das Fases 2–10 com reutilização máxima                     | ✔                        |
| Tabelas novas limitadas ao estritamente necessário (2 + 1 condicional) | ✔                        |
| Nenhuma alteração funcional, deploy, migration ou dado real            | ✔                        |
| Verificação da versão na homologação                                   | ✘ sem acesso (registrado) |
| Decisões pendentes                                                     | 14 abertas (D1–D14)       |

**GO técnico para iniciar a Fase 2 somente após:** (1) autorização explícita; (2) decisão de
**D1, D2 e D3** (as demais podem ser decididas antes da fase em que atuam). Sem D1–D3, **NO-GO**.

SHA inicial `eb3fe2a`; SHA final = commit deste documento.

---

## 20. Matriz de rastreabilidade

| Requisito do usuário                                          | Módulos existentes (citação)                                                                       | Lacuna                                    | Fase   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------ |
| Novo serviço em um formulário                                 | `API/customers/routes.ts:290-365`; `API/orders/routes.ts:189-250`; `API/pickups/routes.ts:190-301` | operação composta                         | 2      |
| Cadastrar ou selecionar cliente                               | `findDuplicates` `API/customers/routes.ts:98-146`                                                  | extrair função                            | 2      |
| Orçamento sem cliente definitivo                              | —                                                                                                  | modelo inexistente                        | 2 (D2) |
| Equipe própria/terceirizada e custo                           | `schema:655-660`; `API/finance/trip-costs.ts:430-541`                                              | padrão da equipe própria                  | 2      |
| Horário de chegada (não de retorno)                           | `shared/schemas/commercial.ts` `refineWindow`                                                      | — (existe)                                | 2      |
| OS nasce no fechamento                                        | bloqueio `API/service-orders/routes.ts:447-452`                                                    | D1                                        | 2/3    |
| Aviso de retirada prevista                                    | `PickupStatus` `schema:643-653`                                                                    | aviso derivado                            | 3      |
| Chegada aguardada / confirmação por qualquer autorizado       | `API/receipts/routes.ts:29, 155-310`                                                               | tela tablet, CAS, reavaliação             | 3      |
| Materiais: parcial, volumes, sem distribuição                 | `API/purchasing/receipts.ts:51-65, 201-374`                                                        | volumes, versão, conferência técnica      | 3/6    |
| A planejar / Planejado / Aguardando / Em produção / Concluído | `API/production/plans.ts:668-718`; `shared/production-domain.ts:245-332`                           | fila derivada + lote                      | 4      |
| Sem tarefas duplicadas                                        | `mig/20261025000000_distribuicao_automatica:60-62`                                                 | —                                         | 4/5    |
| Não converter planos antigos                                  | `mig/20261018000000_fila_semanal:54-65`                                                            | —                                         | 4      |
| Reforma 3 tarefas / Cabeceira 2 tarefas                       | `shared/production-domain.ts:487-653`; `API/production/distribution.ts:113-172`                    | modelo por serviço, responsável por etapa | 5      |
| Executor não aprova a própria peça                            | `shared/quality-domain.ts:71-87`                                                                   | gestor executor                           | 5 (D8) |
| Compras: A comprar / Aguardando / Recebidos                   | `API/purchasing/purchase-orders.ts:465-529`                                                        | filas e lista líquida                     | 6      |
| 20 − 12 = 8                                                   | `purchase-orders.ts:479-489`                                                                       | teste explícito                           | 6      |
| Sem compra duplicada concorrente                              | `purchase-orders.ts:268-310`                                                                       | —                                         | 6      |
| Cheguei sem atraso no tablet                                  | `web/components/tablet/presence.tsx:85-146`; `API/attendance/common.ts:235-287`                    | DTO/WS por sessão                         | 7      |
| Indicadores no painel preservados                             | `web/components/attendance/team-page.tsx`                                                          | —                                         | 7      |
| Ajuda rápida sem registro                                     | `shared/help-domain.ts:12-34`; `API/help/engine.ts:241-356`                                        | sair do tablet                            | 7      |
| Transferência / apoio prolongado com aprovação                | `API/help/reschedule.ts:830+`                                                                      | tipo novo                                 | 7      |
| Meus Ganhos (Ricardo, Márcio, André)                          | `API/finance/labor.ts:535-594`; `API/finance/closing.ts:87-409`                                    | logística, semanas, token                 | 8      |
| Negociação de valores                                         | `API/finance/labor-review.ts:227-269`; `API/finance/labor.ts:328-370`                              | tabela de solicitações                    | 8      |
| Confirmação semanal com PIN e versão                          | `API/finance/closing.ts:480-490, 628-685`                                                          | tabela de confirmações                    | 9      |
| Exceção administrativa                                        | —                                                                                                  | registro com motivo                       | 9      |
| Pagamentos parciais/estornos preservados                      | `API/finance/closing.ts:718-864`                                                                   | —                                         | 9      |
| Seis áreas no menu                                            | `web/components/admin/nav.ts:46-205`                                                               | reorganização                             | 10     |
| Central do Gestor por exceção                                 | `API/issues/attention.ts:46-284`                                                                   | agregador derivado                        | 10     |
| Avisos não ficam órfãos                                       | `schema` `Notification`; `API/notifications/routes.ts:66-68`                                       | `resolved_at`                             | 10     |
| Isolamento em endpoints e tempo real                          | `apps/api/src/core/realtime/hub.ts:256-266`; `shared/events.ts:150-169`                            | audiência `user:` nova                    | 8/9    |
