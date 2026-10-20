# Remediação pós-auditoria — Rodada 2 (funcionalidades ausentes da Central / Fase 10)

Base: Rodada 1 homologada (`e4d6010`). Auditoria de referência:
`AUDITORIA-RASTREABILIDADE-10-FASES-9fb1786` (284 requisitos).

Escopo fechado:

- F8-15b
- F10-08 (= F10-13d)
- F10-11 (= F10-13o)
- F10-12
- F10-13r
- F10-19
- F10-21m
- F10-21s

Nada mais da auditoria foi alterado.

Fora do escopo, e não implementado:

- F8-03, F8-06 e F9-02;
- o resíduo de F2-08 e a dívida de escala de F10-15;
- Safari, o tablet físico e a rede física;
- as seis reversões históricas;
- as 34 linhas "sem teste suficiente".

**Produção fora do escopo.** Não houve acesso, deploy, migration, leitura de dados ou de segredos
de produção.

Regra geral: a Central de Atenção é uma **visão derivada** das fontes canônicas. Nenhum item novo é
gravado. Cada item é recalculado a cada leitura e some quando a causa some.

**Uma migration nova, aditiva:** `20270216000000_notificacoes_resolvidas`. Nenhuma migration
histórica foi tocada.

---

## A. F10-08 / F10-13d — compras aguardando entrega (uma implementação)

**Item da Central:** `MATERIAL:aguardando-entrega:<pedido>` (`management/attention.ts`).

**Fonte.** É o mesmo pedido de compra da tela de Compras:

- pedidos em `PURCHASE_ORDER_RECEIVABLE` (confirmado ou parcialmente recebido);
- o saldo por item vem de `pendingQuantity` (quantidade − recebido − encerrado), a mesma função que
  o pedido usa (`purchasing/common.ts`).

| Situação                                  | Na Central                                     |
| ----------------------------------------- | ---------------------------------------------- |
| Rascunho / aguardando aprovação           | não aparece                                    |
| Confirmado sem recebimento                | aparece (INFO, "Aguardando entrega")           |
| Recebimento parcial                       | continua, contado pelo **saldo**               |
| Recebido por completo / saldo encerrado   | some                                           |
| Cancelado                                 | some                                           |
| Previsão vencida                          | ATENÇÃO / ALTA, "Entrega atrasada"             |
| Chegada registrada aguardando conferência | fica só em "chegada a conferir" (sem duplicar) |

**O item mostra:**

- o número do pedido;
- o fornecedor;
- quantos itens têm saldo;
- a previsão;
- a OS, quando há uma só.

O item **não mostra preço**. O link é `/painel/compras/<id>`.

**Permissão:** `compras.ver`, `compras.gerenciar` ou `compras.aprovar`.

## B. F10-11 / F10-13o — fechamentos aguardando confirmação (uma implementação)

**Item da Central:** `FINANCEIRO:confirmacao:<profissional>`.

**Fonte.** As linhas vêm de `buildClosingItems`, a mesma leitura do Fechamento semanal. O estado
vem de `confirmationState`, extraído de `weekConfirmation` sem mudança de regra. A função
`weekCoverage` (`finance/confirmations.ts`) reúne os dois.

**Regra integral (D13).** A confirmação do PROFISSIONAL só vale se o hash for igual ao hash atual
da semana. Por isso:

- se nunca houve confirmação, o item aparece como `SEM_CONFIRMACAO`;
- se a semana mudou depois da conferência, o item aparece como `DESATUALIZADA` e a confirmação
  antiga não vale.

**Exceção administrativa.** Uma exceção vigente não pede ação, então o profissional sai do item. A
exceção **não** é tratada como confirmação: o estado continua sendo o da exceção. O teste afirma
`kind = EXCECAO_ADMINISTRATIVA`.

**Semana considerada:** só a semana corrente da oficina (segunda a domingo).

**O item mostra:** o nome, a semana e o estado. Não mostra valores.

**Link:** `/painel/financeiro?tab=fechamento&semana=<segunda>&profissional=<id>`. O Fechamento passou
a ler `semana` e `profissional` da URL.

**Permissão:** `financeiro.ver`. `ocorrencias.ver` sozinho não basta, e o tablet recebe 403.

## C. F10-12 — pagamentos disponíveis

**Item da Central:** `FINANCEIRO:pagamento:<profissional>` (categoria AÇÃO).

**Disponível** quer dizer que todas estas condições valem:

- o item está **DEVIDO**;
- está coberto pela regra do portão D13 (`coveringRow`, a mesma de `assertPaymentCovered`): uma
  confirmação válida ou uma exceção que cobre a linha;
- tem **saldo em aberto**.

O cálculo cobre:

- **PREVISTO:** não entra.
- **Pagamento parcial:** o item continua.
- **Pagamento total:** o item sai.
- **Estorno:** o saldo volta e o item volta.
- **Mudança depois da exceção:** se a linha muda, o portão bloqueia de novo e o item sai.

Itens bloqueados pelo D13 nunca aparecem.

**Semanas consideradas:** a corrente e a anterior, porque o portão D13 também aceita o lote da
semana anterior. Um mesmo item conta uma vez só.

O item não mostra valores; mostra só a contagem de pagamentos. O link abre o Fechamento da semana
que cobre o pagamento.

**Permissão:** `financeiro.ver`.

## D. F10-13r — substituição de material aguardando decisão

**Item da Central:** `MATERIAL:substituicao:<medição>`.

**Fonte.** É o estado de Compras Etapa 2. O item aparece quando as duas condições valem:

- a medição está em `REQUEST_AWAITING_REVIEW`;
- `count(substitutionWhere(medição)) > 0`, ou seja, há necessidades ATIVAS da OS que ela pode
  substituir. `substitutionWhere` é a mesma regra que `substitutionScope` usa na aprovação.

**Quando o item some:**

- a medição é aprovada (a decisão foi tomada);
- a medição é devolvida;
- a necessidade candidata deixa de ser ativa;
- não há candidata a substituir.

**Deduplicação:** há um item por medição. Duas propostas na mesma OS geram duas chaves distintas.

**Link:** `/painel/medicoes/<id>`, onde a decisão é tomada.

**Permissão:** `materiais.aprovar`.

## E. F8-15b — Meus Ganhos ao vivo (`finance.own_changed`)

**Evento:** `finance.own_changed`, com:

- audiência `user:<id>`;
- `aggregateType: 'user'`;
- payload `{ reason }`, **sem valores**.

O teste confere que o payload não tem chaves de dinheiro nem números de três dígitos.

**Gatilho centralizado** (`finance/own-changed.ts`):

- **`financeEvent`.** Todo evento financeiro chama `notifyOwnersOf(entidade)`. Essa função resolve
  o dono pela entidade (produção, custo logístico, conta a pagar, confirmação, solicitação de valor,
  revisão de mão de obra).
- **`setLogisticsDefaults`.** Avisa o recebedor antigo e o novo quando o recebedor muda.
- **`refreshItemStage`.** A etapa da peça muda o "devido" da mão de obra.

O aviso é deduplicado por transação.

**Tablet** (`my-values.tsx`). Só recarrega se o token D12 estiver desbloqueado. Sem PIN, nada é
lido, e o evento não traz dado nenhum.

**F1-09 não foi enfraquecido e não houve conflito.** A audiência `user:<id>` já existia em
`audienceAllows` e não mudou. Outros usuários, inclusive outros profissionais, não recebem o
evento. A reconexão reenvia o aviso, e isso está testado.

## F. F10-19 — notificação ATIVA × RESOLVIDA

**Migration:** `ALTER TABLE notifications ADD COLUMN resolved_at TIMESTAMPTZ(3)`. É uma coluna
nula, sem default e **sem backfill**: todo aviso antigo continua ATIVO. Nada é inventado.

**Reversão condicionada** (`packages/db/rollback/20270216000000_notificacoes_resolvidas.down.sql`):

- se houver qualquer aviso resolvido, a reversão é RECUSADA e nada muda;
- caso contrário, remove a coluna e o registro em `_prisma_migrations`.

**Resolução** (`resolveNotifications`). É chamada pela ação que resolve a condição, na mesma
transação. A atualização é `UPDATE … WHERE resolved_at IS NULL AND kind = ANY(…) AND dedupe_key`
(o assunto ou o prefixo `assunto:`). Com isso:

- é **idempotente**;
- é **segura sob concorrência**: duas resoluções simultâneas marcam uma vez só, e só uma publica o
  evento;
- nada é apagado.

O evento `notification.resolved` vai só para o destinatário.

**Reativação.** Se o mesmo fato volta a acontecer depois de resolvido, `notify()` reativa o aviso:
`resolved_at` e `read_at` voltam a nulo. Exemplo: uma peça "não entregue" volta a ficar pronta.

**API:**

- `GET /api/v1/notifications?status=ativas|resolvidas|todas` (padrão: ativas);
- o contador de não lidos conta só as ativas;
- o DTO traz `resolvedAt`.

**Painel:** um botão alterna entre "Ver resolvidos" e "Ver avisos ativos".

| Tipo de aviso                              | Resolvido por                                                     |
| ------------------------------------------ | ----------------------------------------------------------------- |
| VALOR_SOLICITADO                           | aprovação, recusa ou obsolescência da solicitação                 |
| REPROGRAMACAO_PENDENTE                     | decisão da proposta, obsolescência, cancelamento do pedido        |
| EXPEDIENTE_ABERTO                          | ação do gestor que encerra o expediente (saída/não informada)     |
| AUSENCIA_PRESUMIDA                         | chegada no tablet; tratamento pelo gestor (confirmar, justificar) |
| OCORRENCIA_ABERTA                          | ocorrência sai de ABERTA (atribuída, cancelada…)                  |
| OCORRENCIA_ATRIBUIDA                       | tratativa cancelada/enviada à verificação; ocorrência encerrada   |
| VERIFICACAO_NECESSARIA                     | ocorrência sai de AGUARDANDO_VERIFICACAO                          |
| AJUDA_SOLICITADA, AJUDA_EM_ESPERA          | pedido atribuído, em execução, concluído ou cancelado             |
| INSPECAO_PENDENTE/ATRIBUIDA, NOVA_INSPECAO | peça sai da etapa de inspeção; troca do inspetor (o antigo)       |
| CORRECAO_ATRIBUIDA                         | peça sai de EM_CORRECAO                                           |
| EMBALAGEM_LIBERADA                         | peça sai da etapa de embalagem                                    |
| PRONTO_ENTREGA                             | peça sai de PRONTA_ENTREGA (agendada)                             |
| ENTREGA_ATRIBUIDA (entrega)                | entrega concluída, frustrada ou cancelada                         |

**Ficam ativos até serem lidos**, sem resolução automática:

- avisos **informativos** de fato consumado: tarefa liberada ou atribuída, chegada confirmada,
  atraso, pagamento registrado, entre outros;
- avisos sem um ponto único de resolução nesta rodada:
  - REVISAO_DEVOLUCAO;
  - TAREFA_PENDENTE_ENCERRAMENTO;
  - a retirada, que usa o tipo ENTREGA_ATRIBUIDA com o assunto `RETIRADA_ATRIBUIDA`.

Esses avisos continuam como antes, porque `resolved_at` é nulo.

## G. F10-21m — indicador "Entregues"

**Onde aparece:** Início, seção "Entregas", "Entregues hoje" (`overview.deliveries.deliveredToday`).

**Unidade: PEÇAS.** É a regra canônica da Fase 8 (`DELIVERED_ITEM`): uma peça conta quando:

- o item da entrega está em ENTREGUE ou DIVERGENTE;
- a entrega está CONCLUÍDA.

Por consequência:

- uma tentativa frustrada não conta;
- uma entrega cancelada não conta;
- uma peça marcada no destino, sem a entrega concluída, não conta;
- várias peças na mesma entrega contam uma a uma.

**Período:** o "hoje" da oficina, no fuso da empresa (`shopTimezone`), medido pelo `completedAt` da
entrega. É a mesma âncora de "próximas entregas" da mesma área. 23h30 de ontem não conta; 00h30 e
23h59 de hoje contam.

**Permissão:** a seção de entregas é nula sem permissão de entregas.

## H. F10-21s — indicador "Valores pagos"

**Onde aparece:** Início, seção "Financeiro", "Pago na semana" (`overview.finance.paid`, no formato
`{ weekStart, paidInWeekCents }`).

**Fonte canônica única:** `summarize(buildClosingItems(semana corrente)).totals.paidInWeekCents`. É
o mesmo número do "Pago na semana" do Fechamento:

- tapeçaria + logística;
- líquido de estornos.

O teste afirma a igualdade com o Fechamento, e o E2E também. O link abre o Fechamento da semana.

**Sem `financeiro.ver`** a seção é `null`, nunca um zero enganoso.

**Não houve ambiguidade real.** A especificação agrupa o indicador com as obrigações de mão de obra
e de logística, e a única fonte de "pagos" é a do Fechamento. Por isso não foi criada segunda fonte
nem houve decisão a pedir.

---

## Provas

**API, em três arquivos novos:**

- `rodada2-central.test.ts` (22 testes): F10-08, F10-13r, F10-11, F10-12, F10-21s e F10-21m, cada um
  com permissões;
- `rodada2-eventos.test.ts` (11 testes): F8-15b, F10-19 e a migration up/down;
- `rodada2-resolucao.test.ts` (4 testes): F10-19 em presença, ocorrência, ajuda, qualidade e entrega,
  com reativação.

**E2E:** `tests/e2e/specs/rodada2-central.spec.ts` cobre:

- Meus Ganhos do André atualizando ao vivo no celular;
- o cartão de confirmação e o link para o Fechamento com semana e profissional;
- a confirmação no tablet, que troca o cartão para "pagamento";
- "Entregues hoje" e "Pago na semana", este igual ao Fechamento;
- a alternância "avisos ativos × resolvidos".

**Migration:** `scripts/test-migration-notificacoes-resolvidas.sh` faz:

- **evolução** sobre o banco gerado pelo código `e4d6010` com o fluxo completo: aplica exatamente uma
  migration; dados idênticos (md5 de todas as colunas); nenhuma notificação antiga resolvida;
- **reversão limpa:** o `pg_dump -s` fica idêntico ao anterior e os dados também;
- **reversão recusada** com um aviso resolvido: schema, migrations e dados ficam inalterados.

A instalação limpa e o diff de schema são feitos pela suíte (`migrate reset` / `migrate diff`).

## Matriz da auditoria (somente os IDs desta rodada)

| ID      | Antes            | Depois                    | Prova                                                         |
| ------- | ---------------- | ------------------------- | ------------------------------------------------------------- |
| F8-15b  | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | eventos › F8-15b (4); E2E Meus Ganhos ao vivo                 |
| F10-08  | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-08 (4)                                          |
| F10-13d | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | mesma implementação de F10-08; central › F10-08 (4)           |
| F10-11  | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-11 (3); E2E cartão + link + confirmação         |
| F10-13o | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | mesma implementação de F10-11; central › F10-11 (3); E2E      |
| F10-12  | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-12 (3); E2E cartão "pagamento"                  |
| F10-13r | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-13r (4)                                         |
| F10-19  | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | eventos › F10-19 (7); resolucao (4); script de migration; E2E |
| F10-21m | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-21m (6); E2E `dl-delivered`                     |
| F10-21s | NÃO IMPLEMENTADO | IMPLEMENTADO E COMPROVADO | central › F10-21s (2); E2E `fin-paid` = Fechamento            |

**Totais (284 requisitos).**

| Classificação                     | Rodada 1 | Rodada 2 |
| --------------------------------- | -------- | -------- |
| IMPLEMENTADO E COMPROVADO         | 197      | **207**  |
| IMPLEMENTADO PARCIALMENTE         | 35       | 35       |
| IMPLEMENTADO SEM TESTE SUFICIENTE | 34       | 34       |
| NÃO IMPLEMENTADO                  | 10       | **0**    |
| DIVERGENTE                        | 0        | 0        |
| SUBSTITUÍDO POR DECISÃO           | 6        | 6        |
| NÃO COMPROVADO                    | 2        | 2        |

## Pendências que continuam abertas

| Item   | Situação                                                                      |
| ------ | ----------------------------------------------------------------------------- |
| F8-03  | Recorte semanal do previsto: sem fonte canônica, precisa de decisão           |
| F8-06  | Serviços executados sem valor: precisa de regra nova                          |
| F9-02  | Não existe `pin_verified` explícito (a rota exige o token D12)                |
| F10-15 | Dívida de escala da contagem exata (Rodada 1)                                 |
| F2-08  | Janela residual entre o commit e a gravação da resposta da chave (backend)    |
| F10-19 | Avisos sem ponto único de resolução (lista em F) seguem ativos até a leitura  |
| —      | 34 linhas "sem teste suficiente"; seis reversões históricas; Safari e físicos |
