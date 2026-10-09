# Fase 11 — Financeiro operacional, custos por OS, pagamentos por produção e indicadores: relatório de entrega

Data: 09/10/2026

## 1. Branch e SHAs

|                                |                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)      |
| SHA inicial (fim da Fase 10)   | `b928db3` (relatório) — código da Fase 10: `eceaac3`, `d0c6308`                      |
| Commits da Fase 11             | `a897a4c` (banco, domínio, API, testes de API), `e838d26` (telas, E2E, documentação) |
| SHA final do código verificado | `e838d26` — este relatório é o commit seguinte (só o relatório)                      |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `b928db3`. PostgreSQL 16 do contêiner ativo.
- Relatórios das Fases 1–10 lidos; schema Prisma, migrations, APIs, permissões, eventos,
  compras/recebimentos/estoque/sobras (Fase 4), tarefas e histórico (Fases 5–9), etapas da peça e
  entregas (Fase 10) inspecionados.
- **Linha de base antes de qualquer alteração**: `pnpm check` aprovado — API **242/242**,
  compartilhado **45/45**, web **6/6**; E2E completo **18/18**.
- **Divergências registradas antes de implementar:**
  1. O valor negociado já existe no pedido (`commercial_orders.agreed_value_cents`, Fase 2,
     protegido por `pedidos.valores`): a receita **reaproveita** esse valor; a OS só ganhou
     `revenue_cents` opcional para o rateio manual entre várias OS do mesmo pedido.
  2. Entidades sugeridas × implementadas: `CustomerReceivable`/`CustomerPayment` → como sugerido;
     `ProfessionalPayable`/`ProfessionalPayment` → `production_payables`/`professional_payments`;
     `FinancialAdjustment` → `financial_adjustments` (produção) + `commercial_adjustments`
     (valor da OS); `ServiceOrderCost` → razão de custos da OS (`service_order_costs`);
     acrescentados `account_payables`/`payable_payments`, `recurring_expenses`,
     `team_monthly_costs`, `logistics_cost_allocations` e `financial_events` (histórico).
  3. O ajuste de inventário da Fase 4 não ligava a entrada a uma OS: não havia como registrar a
     **devolução de material ao estoque**. Acrescentado `serviceOrderId` opcional (só entrada,
     limitado ao que saiu para a OS).
  4. O relatório da Fase 10 foi entregue com §10 e §11 como marcadores de texto (ver §11).
  5. O E2E verificava "Financeiro" como módulo indisponível e o bloco "Disponível na próxima
     fase" no tablet; ambos foram atualizados com a entrega.

## 3. Estruturas reutilizadas

- Valor contratado do pedido e permissão `pedidos.valores` (Fase 2); clientes, pedidos e OS.
- Compras, itens exclusivos por OS, recebimentos de material e estornos, estoque comum,
  movimentações (`SAIDA_OS`), reservas e sobras transferidas (Fase 4) — base do custo de material.
- Etapa da peça `fulfillment_stage` (Fase 10) — condição de liberação da mão de obra e conclusão
  da OS; entregas e retiradas (Fases 2/10) — vínculo dos custos logísticos.
- Histórico imutável das tarefas (`production_task_events`), pausas com impedimento, ocorrências
  (Fase 9), tarefas de correção e reprovações (Fase 10) — indicadores de produtividade.
- `workers()` (Fase 5, função `tapeceiro`), anexos privados (comprovantes), auditoria, eventos
  com audiência por permissão e reenvio, idempotência, versão e `FOR UPDATE`, triggers
  `cenario_reject_mutation`/`cenario_reject_delete`.

## 4. Funcionalidades

- **Receita por OS**: contratado, ajustes autorizados (desconto, acréscimo, ajuste — com
  justificativa, quem autorizou, histórico imutável e auditoria), valor final, valor lançado,
  recebido, situação financeira (sem valor / cobrança não lançada / a receber / recebido em parte
  / quitado). Ajuste não deixa o valor final abaixo do já recebido. Receita da OS = rateio manual
  (soma exata) ou proporcional às peças não devolvidas. A produção nunca vê esses valores.
- **Contas a receber**: cliente, pedido/OS, valor, vencimento, forma prevista, situação,
  recebido, data, observações; recebimentos parciais; estorno (linha negativa única);
  cancelamento só sem recebimento; soma das cobranças ≤ valor final. Sem gateway nem cobrança.
- **Custos de material** sem duplicidade (razão com chave de origem única): compra exclusiva
  **recebida** (e estornos), saída do estoque para a OS ao custo médio ponderado da data, devolução
  ao estoque, sobra transferida (sai da origem, entra no destino) e lançamento manual justificado.
  Visões separadas: **previsto, comprado, reservado e consumido** — compra não é consumo; reserva
  não é consumo; histórico preservado (linhas imutáveis).
- **Mão de obra por produção** (Ricardo, Márcio): valor por peça ou OS, tapeceiro principal,
  serviço, previsto, ajustes autorizados, devido, pago, situação, datas e histórico. Liberação
  pela regra escolhida (produção concluída, aprovada na qualidade — padrão — ou entregue);
  **concluir a tarefa (uma ou duas vezes) não gera pagamento**; um único valor ativo por peça
  (nunca dividido entre Ricardo e Márcio); pagamento antecipado só com justificativa; nunca acima
  do devido; João e Thiago não entram aqui.
- **Equipe fixa** (João, Thiago): custo mensal por pessoa; alocação por OS como estimativa
  proporcional ao tempo de execução; sem desconto automático; não vira pagamento por produção.
- **Logística**: retirada, entrega, instalação, transporte terceirizado e deslocamento extra,
  ligados às OS (e à entrega/retirada); rateio igual, por peça ou manual, documentado e com soma
  exata; uma viagem nunca é contada duas vezes; conta a pagar opcional ao transportador.
- **Despesas operacionais**: aluguel, energia, água, internet, combustível, marketing,
  contabilidade, sistemas, outras; competência mensal; recorrências com geração mensal
  idempotente; cada despesa gera a conta a pagar.
- **Resultado por OS**: receita, materiais, mão de obra, logística, tributos estimados (alíquota
  configurável), outros variáveis e **margem de contribuição**, em duas colunas (**previsto** ×
  **realizado**), com avisos (sem valor, sem preço, sem alíquota, sem mão de obra combinada) e a
  estimativa da equipe fixa à parte. Sempre identificado como "não é lucro líquido".
- **Contas a pagar**: fornecedor/beneficiário, categoria, valor, vencimento, situação, pagamentos
  parciais, comprovante opcional, histórico. Sem transferência nem pagamento externo.
- **Painel financeiro** com filtro de período: competência (contratado, margem das OS concluídas,
  despesas, equipe fixa, resultado gerencial estimado) × caixa (recebido, pago, saldo); saldos a
  receber/pagar (vencidos), produção liberada e prevista, OS em andamento, despesas por categoria
  e serviços mais rentáveis.
- **Produtividade por funcionário**, sem ranking: tarefas concluídas, apoios, retrabalhos,
  execução e espera médias, prazo (data limite ou dia programado), atrasos **separados** entre
  com e sem impedimento externo, impedimentos, ocorrências registradas e peças reprovadas.
- **Relatórios** (JSON na tela e CSV): resultado por OS, receita por período, custos por
  categoria, pagamentos por produção, despesas, margens, produtividade, retrabalhos e serviços
  mais rentáveis.

## 5. Banco e migrations

- Migration nova e aditiva `20261016000000_financeiro_operacional` (nenhuma migration antiga
  alterada; nada apagado). Tabelas: `commercial_adjustments`, `customer_receivables`,
  `customer_payments`, `service_order_costs`, `production_payables`, `financial_adjustments`,
  `professional_payments`, `team_monthly_costs`, `logistics_costs`,
  `logistics_cost_allocations`, `recurring_expenses`, `operational_expenses`,
  `account_payables`, `payable_payments`, `financial_events`.
- Colunas: `service_orders.revenue_cents`, `company_settings.tax_rate_bps`; enum
  `attachment_entity` + `FINANCE_PAYABLE`.
- Restrições (CHECK): valores positivos/não nulos, recebido/pago ≤ valor, situações e categorias
  válidas, mês de competência no dia 1, motivo obrigatório nos ajustes, alíquota 0–50%.
- Índices únicos: `source_key` da razão de custos; um valor de produção ativo por peça e um por
  OS inteira (parciais); um custo logístico ativo por entrega/retirada e tipo (parciais); uma
  despesa por modelo recorrente e competência; custo da equipe por pessoa e mês; um estorno por
  recebimento.
- Triggers: imutáveis — ajustes comerciais, recebimentos, custos da OS, ajustes e pagamentos de
  produção, pagamentos de contas, rateios logísticos, histórico financeiro; sem exclusão —
  contas a receber, valores de produção, custos logísticos, despesas, contas a pagar.
- Permissões `financeiro.ver`, `financeiro.gerenciar`, `financeiro.ajustes`,
  `financeiro.producao_propria` concedidas ao gestor pela migration (e pelo seed).
- Concorrência: `version` (409) + `SELECT … FOR UPDATE`; geração recorrente com
  `pg_advisory_xact_lock`.

## 6. APIs (`/api/v1/finance`)

| Área               | Rotas                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Configuração       | `GET/PUT /settings` (alíquota estimada), `GET /people`                                                                                  |
| Receita            | `GET /orders`, `GET /orders/:id`, `POST /orders/:id/adjustments`, `PUT /orders/:id/revenue-split`                                       |
| Contas a receber   | `GET/POST /receivables`, `GET /receivables/:id`, `POST …/:id/payments`, `POST …/:id/payments/:paymentId/reverse`, `POST …/:id/cancel`   |
| Contas a pagar     | `GET/POST /payables`, `GET /payables/:id`, `POST …/:id/payments`, `POST …/:id/cancel` (comprovantes: `/attachments`, `FINANCE_PAYABLE`) |
| Produção           | `GET/POST /labor`, `GET /labor/:id`, `POST …/:id/adjustments`, `…/payments`, `…/cancel`, `GET /my-production` (próprios valores)        |
| Equipe fixa        | `GET/PUT /team-costs`                                                                                                                   |
| Logística          | `GET/POST /logistics-costs`, `POST /logistics-costs/:id/cancel`                                                                         |
| Despesas           | `GET/POST /expenses`, `POST /expenses/:id/cancel`, `GET/POST /recurring-expenses`, `PUT /recurring-expenses/:id`, `POST …/generate`     |
| Custos/resultado   | `GET /service-orders`, `GET /service-orders/:id`, `POST /costs` (lançamento manual)                                                     |
| Painel/indicadores | `GET /dashboard`, `GET /productivity`, `GET /reports/:kind?format=json\|csv`                                                            |
| Estoque (Fase 4)   | `POST /api/v1/stock-items/:id/adjust` aceita `serviceOrderId` (devolução da OS)                                                         |

Todas com autenticação, permissão no servidor (painel obrigatório, exceto `my-production`),
validação zod (400), regras (422), versão (409 `VERSION_CONFLICT`), conflito (409) e chave de
idempotência obrigatória nas criações, recebimentos, pagamentos, ajustes e cancelamentos.

## 7. Telas

- **Painel** `/painel/financeiro` (menu "Financeiro", só com `financeiro.ver`): abas Painel,
  Receitas e recebimentos (receita por pedido, cobrança, ajuste, recebimentos e estornos),
  Contas a pagar (pagamentos, comprovantes, histórico), Produção e equipe (combinar valor por peça
  ou OS, pagar, ajustar, cancelar; custo mensal da equipe fixa), Custos e resultado por OS
  (previsto × realizado, materiais por origem, custo manual, alíquota; custos logísticos com
  rateio), Despesas (lançamento, recorrências, geração mensal), Produtividade e Relatórios (CSV).
  Filtro de período (este mês, mês passado, este ano ou datas).
- **Tablet**: "Meus valores" (Ricardo/Márcio, só com autorização): liberado a receber, previsto,
  já pago e cada valor com a condição — sem valores de clientes, de outras pessoas ou margens.
  Saiu o bloco antigo "Ocorrências — disponível na próxima fase".

## 8. Permissões

| Permissão                     | Quem                                 | O que permite                                                                                    |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `financeiro.ver`              | Gestor (painel)                      | Todo o financeiro: receitas, contas, custos, margens, despesas, painel, indicadores e relatórios |
| `financeiro.gerenciar`        | Gestor (painel)                      | Cobranças, recebimentos, contas a pagar, pagamentos, despesas, logística, equipe, produção       |
| `financeiro.ajustes`          | Gestor (painel)                      | Ajustes do valor da OS e da produção, custo manual, alíquota — com justificativa e auditoria     |
| `financeiro.producao_propria` | Ricardo/Márcio, se o gestor conceder | Só os próprios valores de produção e pagamentos                                                  |

Nenhum funcionário vê dados financeiros de outra pessoa; tablets recebem 403 no financeiro geral
mesmo com permissão concedida (sessão do painel exigida).

## 9. Eventos

- Reutilizada a infraestrutura de eventos (outbox, WebSocket, reenvio): `finance.receivable_created`,
  `finance.payment_recorded`, `finance.payable_created`, `finance.payable_paid`,
  `finance.expense_created`, `finance.cost_updated`.
- Audiência: só `financeiro.ver`. **Payload sem valores** (id, tipo, situação). Tablets não
  recebem eventos financeiros ao vivo nem na reconciliação (`/api/sync/events`).
- Histórico por registro em `financial_events` (imutável) + auditoria das ações críticas.

## 10. Testes (09/10/2026, PostgreSQL 16 real)

| Verificação                                      | Resultado                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `pnpm check` (formatação, lint, tipos, testes)   | **aprovado** — API **264/264**, compartilhado **53/53**, web **6/6** |
| `apps/api/test/finance.test.ts` (novo)           | **22/22**                                                            |
| `packages/shared/test/finance.test.ts` (novo)    | **8/8**                                                              |
| E2E completo (`pnpm --filter @cenario/e2e test`) | **19/19** (18 anteriores + `team-finance.spec.ts`)                   |
| `pnpm test:backup` (backup e restauração)        | **aprovado** (contagens iguais; proteções da Fase 11 verificadas)    |

Mapa dos 23 testes exigidos:

| #   | Exigido                          | Onde                                                                                          |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Receita por OS                   | finance.test 1                                                                                |
| 2   | Ajuste comercial autorizado      | finance.test 2                                                                                |
| 3   | Recebimento parcial              | finance.test 3 (+ E2E)                                                                        |
| 4   | Recebimento duplicado            | finance.test 4                                                                                |
| 5   | Custo de material consumido      | finance.test 5                                                                                |
| 6   | Reserva sem consumo              | finance.test 6 (inclui saída e devolução ao estoque)                                          |
| 7   | Sobra de material                | finance.test 7                                                                                |
| 8   | Pagamento por produção           | finance.test 8 (tablets reais: conclusão dupla não paga; inspeção aprovada libera)            |
| 9   | Ajuste autorizado                | finance.test 9                                                                                |
| 10  | Pagamento duplicado              | finance.test 10                                                                               |
| 11  | Custo logístico                  | finance.test 11                                                                               |
| 12  | Rateio entre OS                  | finance.test 12                                                                               |
| 13  | Despesas recorrentes             | finance.test 13 (inclui geração simultânea)                                                   |
| 14  | Margem de contribuição           | finance.test 14 (+ domínio)                                                                   |
| 15  | Resultado gerencial              | finance.test 15 (+ relatórios JSON/CSV)                                                       |
| 16  | Indicadores de produtividade     | finance.test 16                                                                               |
| 17  | Permissões                       | finance.test 17 (+ E2E)                                                                       |
| 18  | Proteção dos valores nos tablets | finance.test 18 (+ E2E)                                                                       |
| 19  | Concorrência                     | finance.test 19                                                                               |
| 20  | Idempotência                     | finance.test 20                                                                               |
| 21  | Sincronização                    | finance.test 21                                                                               |
| 22  | Backup e restauração             | finance.test 22 (imutabilidade) + `pnpm test:backup` (dados fictícios da Fase 11 restaurados) |
| 23  | Regressão das Fases 1–10         | suíte completa (`pnpm check` + E2E 19/19)                                                     |

E2E com o painel e um tablet de produção (Ricardo): cobrança, recebimento parcial, valor de
produção, despesa, painel, resultado por OS, relatório CSV; tablet sem acesso até a autorização
e, depois, só os próprios valores.

## 11. Defeitos corrigidos

1. **Rateio de centavos** (`splitCents`): a sobra ia sempre para as primeiras partes (R$ 10,00
   em 1:2 dava 3,34/6,66) — passou a usar os maiores restos (3,33/6,67), soma sempre exata.
2. **Prazo da produtividade**: tarefas sem data limite não entravam na pontualidade (a maioria
   das tarefas só tem dia programado) — o prazo passou a ser a data limite ou o dia programado.
3. **Data de conclusão da OS** sem registro de entrega (peças marcadas como entregues por outro
   caminho) ficava nula e a OS sumia do período — passa a usar a última mudança de etapa.
4. **Devolução de material ao estoque** não podia ser ligada à OS (Fase 4) — o custo da OS não
   seria reduzido; agora o ajuste de entrada aceita a OS, limitado ao que saiu para ela.
5. **CSV**: proteção contra fórmulas em células de texto (`=`, `+`, `@`, `-texto`).
6. **Relatório da Fase 10** entregue com §10 e §11 como marcadores: preenchidos com a medição
   real feita sobre o mesmo código no início desta fase (a lista de defeitos da Fase 10 não pôde
   ser reconstruída e isso está declarado no próprio relatório).
7. Durante o desenvolvimento, nomes duplicados no pacote compartilhado (`formatCents`,
   `periodQuerySchema`) foram evitados reutilizando os existentes.

## 12. Pendências (avaliação do item 20 e riscos)

- **Devoluções parciais e reservas** (Fase 10): as reservas de uma OS parcialmente devolvida
  continuam ativas. Efeito financeiro: aparecem só como **reservado** (não como consumido); a
  receita da OS já exclui as peças devolvidas do rateio. O valor de produção de uma peça devolvida
  nunca é liberado (a etapa `DEVOLVIDA` não satisfaz nenhuma regra), mas continua "previsto" até
  o gestor cancelá-lo. **Fase 12**: liberar reservas e sugerir o cancelamento do valor de
  produção na confirmação da devolução.
- **Estado comercial das peças devolvidas**: o valor final do pedido não muda sozinho; o gestor
  registra um desconto/ajuste (auditado) se houver abatimento. **Fase 12**: sugerir o ajuste na
  devolução.
- **Devolução de peças avulsas pelo painel** (sem peça de OS): continua só na API; sem efeito
  financeiro. **Fase 12**.
- **Saldo de compras parcialmente recebidas**: o custo consumido só conta o que foi recebido (sem
  inconsistência na margem), mas a visão "comprado" mostra a quantidade pedida mesmo que o saldo
  nunca chegue. **Fase 12**: encerramento do saldo do pedido de compra.
- **Atalho antigo "Ocorrências" do tablet**: resolvido nesta fase (removido).
- Material sem preço conhecido entra com valor zero e aviso "custo subestimado" até o gestor
  lançar o custo manual. Tributos são uma alíquota estimada única (não é apuração fiscal).
- A geração das despesas recorrentes é manual (botão idempotente); não há agendador.
- Os indicadores de tempo dependem do uso de Iniciar/Pausar/Concluir no tablet.

## 13. Evidências

Capturas geradas pelo E2E da Fase 11 com `E2E_EVIDENCE=1` em `docs/evidencias/fase-11/`:
`01-recebimento-parcial.png`, `02-producao-combinada.png`, `03-painel-financeiro.png`,
`04-resultado-os.png` (painel) e `05-tablet-meus-valores.png` (tablet do Ricardo). Logs da
execução: `pnpm check` (API 264, compartilhado 53, web 6), E2E 19/19 e `pnpm test:backup`
aprovados.

## 14. Próximos passos (aguardando autorização)

A Fase 11 está concluída e documentada. **Nada da Fase 12 foi iniciado; nenhum deploy foi
feito**; não há integração bancária, pagamento executado nem nota fiscal. Aguardo autorização
para a Fase 12. Sugestões para avaliação: as pendências do §12 (reservas e valores de produção
na devolução, ajuste comercial sugerido, devolução avulsa na tela, encerramento de saldo de
compra), agendamento da geração das despesas recorrentes e gráficos históricos no painel.
