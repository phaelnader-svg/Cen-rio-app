# Reformulação — Fase 3: regra proposta para desfazer a entrega direta (D5)

**Situação: PROPOSTA — aguarda aprovação específica. Nada disto está implementado.**

## 1. O que a entrega direta faz hoje (Fase 1)

"Marcar como entregue" na OS grava uma entrega **já concluída** de origem `DIRETA`, com as peças
pendentes como `ENTREGUE`. Quase tudo o que vem depois é **derivado** dessa entrega concluída (nada
é copiado para outro lugar):

| Efeito                                                      | Como existe hoje                                                        | Reversível sem inconsistência?                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Etapa da peça `ENTREGUE`                                    | derivada da entrega concluída (`refreshItemStage`)                      | sim: volta a `PRONTA_ENTREGA` ao recalcular                                                             |
| Localização "Entregue"                                      | movimentação gravada (histórico imutável)                               | sim: nova movimentação de volta (o histórico mostra as duas)                                            |
| Mão de obra com regra "entregue ao cliente"                 | status gravado, recalculado pela etapa: `PREVISTO → LIBERADO`           | só se **não houver pagamento** e a semana **não estiver conferida**: o recálculo volta a `PREVISTO`     |
| Vencimento das cobranças com gatilho ENTREGA                | **derivado** da data da entrega concluída (nada gravado)                | o cálculo volta a "aguardando entrega"; problema só se o cliente **já pagou** com base nesse vencimento |
| Prazo do serviço encerrado / data de conclusão no resultado | derivados                                                               | sim: o prazo reabre (pode aparecer atrasado — é a verdade)                                              |
| "Serviço concluído" no pedido                               | derivado                                                                | sim                                                                                                     |
| Aviso "pronta para entrega" resolvido                       | notificação resolvida                                                   | aceitável não reabrir (o quadro e a OS mostram a peça pronta)                                           |
| Auditoria e eventos                                         | imutáveis                                                               | não se apaga nada: a reversão é um **novo** registro                                                    |
| Fechamento semanal                                          | retrato versionado (`weekly_closings`) do devido e pago por competência | **não**, se a semana com a liberação já foi **conferida**: a reversão mudaria um retrato conferido      |
| Pagamento de mão de obra (Pix em lote ou baixa)             | baixa gravada na obrigação                                              | **não**: dinheiro pago não volta por desfazer a entrega                                                 |

## 2. Regra proposta

### 2.1 Quem e o quê

- Só a **última entrega DIRETA** da OS pode ser desfeita (entregas da logística continuam pelo
  fluxo da logística/devolução).
- Exige `entregas.gerenciar` **e** `financeiro.gerenciar` (efeito financeiro), sessão do painel.
- **Justificativa obrigatória** (mínimo 10 caracteres), identidade, data e hora gravadas; evento
  **destacado** na auditoria (`delivery.direct_reverted`, mesma marcação de destaque da
  autoaprovação da qualidade).
- Prazo: até **7 dias** depois da confirmação. Depois disso, só pelo fluxo de devolução.

### 2.2 Bloqueios (a reversão é recusada, sem gravar nada, com a lista do que impede)

1. **Mão de obra paga**: qualquer obrigação das peças da entrega com pagamento (total ou parcial)
   ou em lote de Pix do fechamento.
2. **Semana conferida**: qualquer obrigação das peças que ficou liberada por causa da entrega e cuja
   semana de competência já está **CONFERIDA** no fechamento semanal (reabrir a semana é decisão do
   financeiro, pelo fluxo que já existe; depois disso a reversão passa a ser possível).
3. **Cobrança paga pelo gatilho da entrega**: qualquer cobrança do pedido com gatilho ENTREGA que
   tenha recebimento registrado **depois** da confirmação da entrega (o pagamento pode ter sido
   motivado por ela). Recebimentos anteriores à entrega não bloqueiam.
4. **Algo já aconteceu depois da entrega**: devolução registrada, nova entrega das mesmas peças, OS
   cancelada, ou peça alterada tecnicamente depois da entrega.
5. **Concorrência**: trava a OS e as peças na mesma ordem da entrega direta; repetição devolve "já
   desfeita" sem gravar nada (chave de idempotência obrigatória).

### 2.3 O que a reversão grava (tudo aditivo, nada apagado)

- Na entrega: `reverted_at`, `reverted_by_id`, `revert_reason` (colunas novas) — a entrega continua
  existindo como registro histórico, com o status `CONCLUIDA` preservado e marcada como desfeita.
- Nos itens da entrega: `active = false` e status `NAO_ENTREGUE` com nota "Entrega direta desfeita:
  motivo". As consultas que derivam "entregue" passam a ignorar entregas desfeitas.
- Evento `ENTREGA_DIRETA_DESFEITA` no histórico da entrega; movimentação das peças de volta para a
  localização anterior à entrega (ou "Expedição", se não houver).
- Recalcula a etapa das peças (volta a `PRONTA_ENTREGA`) e, pelo mesmo caminho, a mão de obra
  `LIBERADO → PREVISTO` das obrigações com regra "entregue ao cliente".
- Auditoria destacada com: OS, entrega, peças, justificativa, obrigações que voltaram a previsto,
  cobranças cujo vencimento voltou a "aguardando entrega".

### 2.4 O que a tela mostra antes de confirmar

Prévia (somente leitura) com: peças afetadas, obrigações de mão de obra que voltam a previsto,
cobranças que voltam a "aguardando entrega", prazo que reabre (e se ficará atrasado) — ou a lista
de bloqueios com o caminho para resolvê-los.

## 3. Por que não algo mais simples

- **Apagar a entrega**: perderia o histórico e a auditoria; recusado.
- **Desfazer sempre, ajustando o financeiro sozinho**: estornar pagamentos ou mudar uma semana
  conferida automaticamente gera inconsistência entre o que foi pago/conferido e o registrado;
  recusado — por isso os bloqueios 1–3.
- **Desfazer só a etapa da peça**: deixaria a entrega concluída valendo para vencimento, prazo e
  pedido (contradição entre telas); recusado.

## 4. Impacto técnico se aprovada

Uma migration aditiva (3 colunas anuláveis em `deliveries`). As consultas que derivam "entregue"
(etapa, vencimento, prazo, pedido, resultado) já exigem item `ENTREGUE`/`DIVERGENTE`; com o item
desfeito como `NAO_ENTREGUE` e inativo, elas deixam de contá-lo sem mudança — cada uma será
conferida por teste. Rota de prévia e rota de reversão, testes de cada bloqueio, de concorrência e
de idempotência, e E2E da tela.
