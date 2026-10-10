# Evolução, Fase 6 de 8 — Custos de retirada e entrega

Ambiente exclusivamente local (PostgreSQL 16 em contêiner, dados sintéticos). Sem deploy, sem
Cloud Build, sem Google Cloud/homologação/DNS/VM/segredos, sem migrations em bancos remotos, sem
pagamentos externos, sem dados reais e sem VerificaPro. A Fase 7 (fechamento semanal) **não** foi
iniciada: só os dados e contratos que ela vai consumir.

## 1. Branch e SHAs

| Item                                   | Valor                                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Branch                                 | `claude/cenario-gestao-fase-1-zf3bj2`                      |
| SHA inicial (conferido local e remoto) | `14af6e7` (fim da Fase 5); worktree limpo, sem divergência |
| SHA final                              | último commit desta entrega (o deste relatório)            |
| Migrations no banco local              | 16 (1 nova: `20261108000000_custos_logistica`)             |

Commits: `98ed7f2` migration + domínio + rollback; `ffaad5c` API + testes; `942c076` painel;
`d2e682c` correção do valor sugerido no formulário (achado pelo E2E); `c2778c5` E2E, desempenho
e evidências; e o commit deste relatório (com ajustes de lint).

## 2. Auditoria do código existente (antes de codificar)

| Conceito                       | Onde estava (Fase 11/10)                                                                                                                                                                                  | Achado                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retirada / entrega (viagem)    | `pickup_requests` (`pickups/routes.ts`), `deliveries` (`quality/shipping.ts`)                                                                                                                             | Estados reais: retirada AGENDADA→EM_EXECUCAO→RETIRADA_REALIZADA→RECEBIDA_NA_OFICINA, COM_OCORRENCIA, CANCELADA; entrega PROVISORIA/AGENDADA→EM_TRANSPORTE→NO_DESTINO→CONCLUIDA, FRUSTRADA (reagendável), CANCELADA                  |
| Custo de logística             | `logistics_costs` + `logistics_cost_allocations` (`finance/payables.ts` `createLogisticsCost`)                                                                                                            | Já havia **valor total por viagem** e rateio exato (`splitCents`), índice único por viagem e tipo; porém **recebedor em texto livre** e **conta a pagar criada no lançamento** (antes da realização), sem vínculo com o agendamento |
| Contas a pagar / pagamentos    | `account_payables`, `payable_payments` (`payPayable`, `cancelPayable`)                                                                                                                                    | Pagamento parcial/integral sem ultrapassar o saldo; **sem estorno** de pagamento                                                                                                                                                    |
| Rateio                         | `logistics_cost_allocations` (imutável por gatilho; único por custo+OS)                                                                                                                                   | Não permitia refazer o rateio (OS incluída/removida)                                                                                                                                                                                |
| Margem da OS                   | `finance/results.ts`                                                                                                                                                                                      | Somava todo custo não cancelado como realizado                                                                                                                                                                                      |
| Permissões                     | `financeiro.ver/gerenciar/ajustes`; logística com `logistica.executar`                                                                                                                                    | André/Izaías sem financeiro (correto)                                                                                                                                                                                               |
| Escritores de status da viagem | `pickups/routes.ts` (transição, edição), `quality/routes.ts` (passo da logística), `receipts/routes.ts`, `orders/routes.ts` (cancelamento do pedido), `quality/shipping.ts` (alterar, cancelar, concluir) | Todos ganharam o mesmo gancho `syncTripCost`                                                                                                                                                                                        |

**Fonte única de verdade (mantida):** `logistics_costs` (um custo vivo por viagem e tipo — índice da
Fase 11) → `account_payables` (obrigação, criada só quando devido) → `payable_payments` (+
`payable_payment_reversals`). Nenhum segundo módulo financeiro foi criado.

## 3. Arquitetura e decisões

- **Valor total por viagem**, combinado no agendamento (`tripCost` na criação da retirada/entrega,
  ou `PUT /finance/trip-costs`), sugerido pelos padrões da empresa e editável por quem tem
  `financeiro.gerenciar`. Guardado na viagem: mudar o padrão não altera viagens registradas.
- **Recebedor único** configurado explicitamente (`company_settings.logistics_payee_user_id`,
  usuário + funcionário ativos), nunca por nome. Participantes (André, Izaías) ficam em
  `logistics_cost_participants` — execução, não crédito. Sem recebedor ativo: o valor fica devido,
  **nenhuma conta é criada**, o gestor é avisado (pendência `RECEBEDOR_AUSENTE`) e, depois de
  configurar, gera a conta uma vez (`/constitute`, idempotente).
- **R$ 0 não é aceito** (CHECK da Fase 11 mantido): viagem sem custo simplesmente não tem
  lançamento e aparece como “Sem custo combinado”; nada de gratuidade presumida. Limite R$ 100.000,00.
- **Situações:** PREVISTO (combinado, nada devido) → DEVIDO (realizada: retirada realizada/recebida
  ou entrega concluída; `due_at` = fato gerador) → conta a pagar ABERTO/PARCIAL/PAGO. CANCELADO
  quando a viagem é cancelada antes da realização. Custos avulsos/legados: LANCADO.
- **Tentativa frustrada** não gera nada; taxa só com `financeiro.ajustes` + justificativa, como custo
  próprio (`TENTATIVA_FRUSTRADA`, devido na autorização). Nova frustração da mesma viagem soma à
  taxa existente como ajuste autorizado (uma obrigação por evento de custo e recebedor).
- **Reagendar** não toca no custo (único pelo índice do banco). Criação concorrente: 409.
- **Rateio** por revisão (`allocation_revision`): rateios são imutáveis; incluir/remover OS ou ajustar
  o valor grava uma nova revisão com histórico (antes/depois). Regra determinística: OS em ordem
  crescente de número, centavos restantes para as primeiras (R$ 100 em 3 OS = 33,34/33,33/33,33).
  Retirada antes de existir OS: rateio pendente; a OS criada para o pedido entra automaticamente
  (pagamento e conta intocados).
- **Correções depois de devido:** ajuste com sinal (`logistics_cost_adjustments`, imutável), nunca
  abaixo do pago, refaz o rateio e atualiza a conta; estorno de pagamento (`payable_payment_reversals`,
  imutável) devolve o saldo sem apagar o pagamento. Conta de viagem só é cancelada pelo custo.
- **Margem:** “Previsto” inclui o combinado; “Realizado” só devido/lançado; sempre a revisão vigente.
  Margem de contribuição continua sem ser chamada de lucro.
- **Fase 7 (`GET /finance/logistics-weekly?from&to&payeeUserId`):** itens com viagem, OS e rateio,
  combinado, ajustes, devido, pago, saldo, data do fato gerador e situação + totais por recebedor e
  semana. **Regra:** semana (segunda a domingo) da **data local do fato gerador** (`due_at`) no fuso
  da oficina (`company_settings.timezone`, America/Sao_Paulo); agendamento não entra. Pago e saldo
  são os da conta no momento da consulta.
- O lançamento avulso da Fase 11 continua para custos sem viagem cadastrada (transporte terceirizado,
  deslocamento etc.); **retirada/entrega de viagem cadastrada é recusada nele** (fonte única).

## 4. Migration e rollback

`20261108000000_custos_logistica` (aditiva): colunas em `company_settings` (padrões, recebedor) e
`logistics_costs` (situação, recebedor vinculado, ajustes, fato gerador, pendência, modo/revisão do
rateio); `logistics_cost_allocations.revision` (o único passa a incluir a revisão);
tabelas `logistics_cost_participants`, `logistics_cost_adjustments`, `payable_payment_reversals`;
CHECKs (situação, valores, motivos) e gatilhos de imutabilidade; lista de tipos ampliada com
`TENTATIVA_FRUSTRADA`. Legado: custos ficam `LANCADO` (cancelados → `CANCELADO`); o texto
`beneficiary` é preservado e **nenhum vínculo é inferido**.

Rollback `packages/db/rollback/20261108000000_custos_logistica.down.sql`: **aborta antes de qualquer
alteração** se existir qualquer dado da Fase 6 (custo previsto/devido, recebedor vinculado,
participante, ajuste, estorno, rateio revisado, padrão configurado); nesse caso a recuperação é a
restauração do backup anterior à migration.

## 5. Alterações

- **API:** `apps/api/src/modules/finance/trip-costs.ts` (serviço + rotas `/finance/logistics-defaults`,
  `/finance/trip-costs`, `/trip-costs/fee`, `/logistics-costs/:id/adjustments`, `/:id/constitute`,
  `/payables/:id/payments/:paymentId/reverse`, `/logistics-weekly`); ganchos em `pickups/routes.ts`,
  `quality/routes.ts`, `quality/shipping.ts`, `receipts/routes.ts`, `orders/routes.ts`,
  `service-orders/routes.ts`; `finance/payables.ts` (DTO único, estorno visível, bloqueios);
  `finance/results.ts` e `finance/reports.ts` (previsto × realizado, revisão vigente).
- **Shared:** `finance-domain.ts` (`tripAllocation`, `tripCostSituation`, situações, limites),
  `schemas/finance.ts` (validação monetária), `types-finance.ts` (DTOs).
- **Web:** `components/finance/trip-cost.tsx` (campos no agendamento, cartão na retirada/entrega,
  padrões); formulário de retirada, agendamento de entrega, detalhe da retirada/entrega, aba de
  custos (situação, recebedor) e estorno no detalhe da conta a pagar.

## 6. Segurança e matriz de permissões

| Ação                                                 | Permissão (backend)                                         | André / Izaías / tablets |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| Ver custo da viagem, lista, base semanal, relatórios | `financeiro.ver`                                            | 403                      |
| Combinar/alterar custo, padrões, gerar conta         | `financeiro.gerenciar`                                      | 403                      |
| Taxa de tentativa frustrada, ajuste, estorno         | `financeiro.ajustes`                                        | 403                      |
| Informar custo ao agendar (retirada/entrega)         | `retiradas/entregas.gerenciar` **e** `financeiro.gerenciar` | 403                      |
| Executar viagem (saída, realizada, concluída)        | `logistica.executar` (sem valores)                          | sim, sem valores         |

Retirada/entrega, trabalhos do André e eventos em tempo real não carregam valores (eventos
financeiros têm audiência `financeiro.ver`). CSRF/origem e idempotência são os do plugin global
(suíte de segurança verde); as novas rotas de escrita são idempotentes.

## 7. Fluxo financeiro e reconciliação

Agendar (PREVISTO, nada devido) → executar → realizar (DEVIDO uma vez; conta a pagar do recebedor
com o total) → ratear (revisão vigente soma exatamente o devido) → pagar parcial/integral (abate a
mesma conta) → corrigir (ajuste ≥ pago / estorno) → conciliar: soma dos rateios = devido; pago da
conta = soma dos pagamentos não estornados; base semanal = devido/pago/saldo por recebedor.

## 8. Matriz CA6

| CA     | Status     | Evidência                                                                                                                                                                                             |
| ------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA6-01 | APROVADO   | `logistics-costs.test.ts` #1 (padrões distintos, sugestão, mudança não altera viagem, 403, auditoria antes/depois); E2E (tela)                                                                        |
| CA6-02 | APROVADO   | #2 (André + Izaías, R$ 100 → 1 custo de 10.000, 1 conta de 10.000); #15 (entrega); E2E                                                                                                                |
| CA6-03 | APROVADO   | #2 (conta só do André; Izaías só participante; nenhuma obrigação dele)                                                                                                                                |
| CA6-04 | APROVADO   | #3 + `packages/shared/test/trip-cost.test.ts` (0, negativo, fração, NaN, texto, estouro → 400; R$ 0 não aceito, regra explícita)                                                                      |
| CA6-05 | APROVADO   | #4 (agendado/em execução = nada devido; realizada → devido uma vez; recebimento não duplica); #15 (entrega concluída)                                                                                 |
| CA6-06 | APROVADO   | #5 (retirada cancelada e pedido cancelado → CANCELADO, sem conta)                                                                                                                                     |
| CA6-07 | APROVADO   | #6 (frustrada sem taxa = nada; taxa exige `financeiro.ajustes` + justificativa; viagem continua não realizada; 2ª taxa soma); #15                                                                     |
| CA6-08 | APROVADO   | #7 (3 reagendamentos → 1 custo; criação concorrente 200/409; realização concorrente → 1 conta); #15 (frustrada → reagendada)                                                                          |
| CA6-09 | APROVADO   | #8 (33,34 + 33,33 + 33,33 = 100,00) e unitário (somas exatas para vários totais/quantidades)                                                                                                          |
| CA6-10 | APROVADO   | #8 (remover OS → nova revisão 50,00/50,00, histórico, rateios imutáveis); #9 (OS após pagamento: conta e pagamento intactos)                                                                          |
| CA6-11 | APROVADO   | #10 (40 + 60 abatem a mesma conta; mesma chave não repete; acima do saldo 422; nenhuma despesa nova); E2E                                                                                             |
| CA6-12 | APROVADO   | #11 (ajuste abaixo do pago 422; estorno auditável; ajuste −20,00; imutáveis; cancelar conta direto 422); E2E                                                                                          |
| CA6-13 | APROVADO   | #13 (André/Izaías/usuário de entregas: 403 em custo, lista, semanal, padrões, contas e relatório CSV; sem chaves monetárias nas APIs dos tablets; WS sem eventos financeiros); E2E (celular do André) |
| CA6-14 | APROVADO   | Migração sobre dados gerados com a Fase 5 (seção 9.3): hashes/somas/vínculos iguais, órfãos 0                                                                                                         |
| CA6-15 | APROVADO   | #14 (domingo 23:30 local → semana anterior; segunda 00:10 → semana nova; período inválido 400; agendamento em outra semana não conta)                                                                 |
| CA6-16 | APROVADO\* | E2E `team-logistics.spec.ts` (agendar → executar → ratear → constituir → pagar parcial → estornar → ajustar → conciliar); regressão: ver seção 9                                                      |

\* ressalva: falha pré-existente do teste de medições (seção 9.1).

## 9. Testes e evidências (contagens reais)

### 9.1 Automatizados

| Suíte                                                    | Resultado                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared (unitários)                                       | 74/74                                                                                                                                                                                                         |
| Fase 6 API (`logistics-costs.test.ts`, PG16)             | 15/15                                                                                                                                                                                                         |
| Regressão API completa (`cd apps/api && npx vitest run`) | 349 passaram, **1 falhou** (pré-existente, abaixo), 4 ignorados (desempenho, só com variável)                                                                                                                 |
| Falha da regressão                                       | `measurements.test.ts` “planejamento distingue solicitado × aprovado” — **reproduzida idêntica na base da Fase 5 (`14af6e7`)** em 10/10/2026 (sábado); depende do dia da semana; medições não foram alteradas |
| Fase 6 E2E (`team-logistics.spec.ts`)                    | 1/1                                                                                                                                                                                                           |
| E2E completo (`cd tests/e2e && npx playwright test`)     | 26/26 (7,5 min), inclusive Fases 2–5, Fase 11 e auditoria visual                                                                                                                                              |
| Desempenho (`LOGISTICS_PERF=1`)                          | 1/1 (seção 10)                                                                                                                                                                                                |
| Lint, formatação, typecheck, build web                   | sem apontamentos; compilado                                                                                                                                                                                   |

Testes alterados por mudança intencional de regra (documentada): `finance.test.ts` #11 (retirada de
viagem cadastrada passa pelo custo da viagem, não pelo lançamento avulso) e `full-flow.test.ts`
passo do frete (idem). Asserções originais preservadas (código, valor, conta, resultado, pagamento).

### 9.2 Evidências de tela

`docs/evidencias/evolucao-fase-6/`: `01-padroes-e-recebedor`, `02-agendar-com-custo-total`,
`03-retirada-custo-combinado`, `04-retirada-realizada-devido`, `05-pagamento-estornado`.

### 9.3 Migração, rollback, backup

Banco sintético gerado **com o código da Fase 5** (`14af6e7`): entrega avulsa rateada em 2 OS
(10.001; conta paga 4.000), retirada ligada a viagem com rateio manual (12.000), custo cancelado e
mão de obra. Resultado:

1. Antes × depois: contagens, somas (`logistics_costs` 25.001, rateios 25.001, contas 22.001, pago
   4.000) e hashes de custos, rateios, contas, pagamentos, eventos, auditoria, mão de obra,
   revisões e trocas de titular **idênticos**; órfãos 0. Diferenças: só as novas tabelas/colunas,
   zeradas. Legado: `LANCADO`/`CANCELADO`, texto do recebedor preservado, sem vínculo inferido.
2. Rollback sem dados da Fase 6 → schema idêntico ao da Fase 5 e dados iguais; reaplicação ok.
3. Código da Fase 6 sobre o legado: valores e saldo corretos; conta legada quitada (mesma
   obrigação); viagem legada continua com custo único; novo custo segue a regra nova.
4. Rollback **com** dados da Fase 6: `Reversão bloqueada: 3 registro(s) da Fase 6` antes de qualquer
   alteração — dados, schema e registro da migration intactos.
5. Backup/restauração: `scripts/test-backup-restore.sh` ✔; dump/restauração do banco E2E (com
   participantes, ajuste, estorno e padrões) em banco separado: hashes de valores, revisões,
   participantes, ajustes, estornos e configuração iguais; imutabilidade ativa após restaurar.

## 10. Desempenho (40 OS, 40 entregas + 40 retiradas, 20 realizadas, 4 tablets + painel no WS; 20 execuções)

| Operação                                          | p50 / p95 (ms) |
| ------------------------------------------------- | -------------- |
| Transição de realização (constitui a obrigação)   | 66 / 76        |
| `PUT /finance/trip-costs` (alteração com motivo)  | 62 / 75        |
| `GET /finance/trip-costs`                         | 22 / 26        |
| `GET /finance/logistics-costs` (lista, 80 custos) | 73 / 108       |
| `GET /finance/logistics-weekly` (60 dias)         | 18 / 42        |
| `GET /finance/service-orders/:id` (resultado)     | 45 / 80        |
| `GET /logistics/jobs` (celular do André)          | 13 / 19        |

## 11. Compatibilidade e pendências

- Planejamentos por horário, filas semanais e a lógica de produção/tapeçaria da Fase 5 não foram
  alterados (suítes verdes). Qualidade, entregas, devoluções, ocorrências e auditoria seguem iguais.
- Fechamento semanal (Fase 7) não implementado; contrato pronto (`/finance/logistics-weekly` aqui e
  `/finance/labor-weekly` da Fase 5).
- **Falha antiga, fora do escopo (não corrigida):** teste de medições “planejamento de sexta”
  depende do dia da semana (falha em fins de semana; reproduzida na base `581e03e` na Fase 5).
- **Desvio de −3h do indicador financeiro (relatado pelo usuário):** não investigado nem corrigido
  nesta fase, por estar fora do escopo; registrado para tratamento separado.
- Uma viagem pode atender várias OS do mesmo cliente (o modelo de entrega é por cliente); rotas com
  clientes diferentes seguem como custo avulso rateado.
- Validação física em Safari/WebKit segue pendente (como nas Fases 4–5).

## 12. GO/NO-GO para a Fase 7

**GO técnico** para a Fase 6: CA6-01 a CA6-16 aprovados com evidência executada; sem acesso
financeiro indevido, sem obrigação duplicada ou para Izaías, sem pagamento acima do devido, sem
sobrescrita silenciosa, migração sem perda e rollback seguro (permitido sem dados da Fase 6;
bloqueado, sem alterar nada, com eles). Ressalvas: (1) a falha antiga do teste de medições (fora do
escopo, reproduzida na base); (2) o desvio de −3h do indicador financeiro, para tratamento separado.
**GO técnico não autoriza deploy.** A Fase 7 não foi iniciada: aguardando autorização explícita.
