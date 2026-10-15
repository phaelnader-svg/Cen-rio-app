# Saneamento funcional — 4 correções pontuais

Data: 2026-10-15. Referência homologada: `406fde7` (aplicação). SHA inicial do ramo: `057c892` (só infra/docs
depois de `406fde7`). Código da rodada: `c239e84`. Produção fora do escopo e não tocada.

Esta rodada não é fase nova: nada de cobrança, compras, capacidade, orçamento, menus, infraestrutura ou
runner. **Nenhuma migration.**

## 1. Tipo de serviço por peça (Novo serviço)

**Causa raiz.** A API já aceitava e gravava `serviceType` por item (`newServiceItemSchema`, `createOrder`,
OS automática na chegada). A tela tinha um único seletor "Tipo de serviço" e mandava o mesmo valor em todas as
peças. A escolha do modelo de produção (`selectProductionTemplate`) usa o tipo da peça, então peças de tipos
diferentes recebiam o modelo errado.

**Correção (só tela).** `apps/web/components/commercial/new-service-page.tsx`:

- seletor "Tipo de serviço" em cada peça (`ns-piece-service-<n>`);
- a peça nova herda o tipo da anterior;
- o resumo lista "quantidade × peça — tipo";
- a descrição padrão do serviço junta os tipos distintos ("Reforma completa + Troca de tecido").

Registros antigos, atomicidade e idempotência não mudam (mesma rota).

**"Novo pedido" (legado).** O pedido cria a OS manualmente, e o tipo é escolhido por item da OS. Sem
corrupção, nada alterado.

## 2. `analyzeAbsence` (ausência)

**Causa raiz.** Na fila semanal as tarefas não têm horário (`scheduledAt = null`). A consulta incluía
`scheduledAt: null` sem outro filtro: a fila inteira da pessoa, de todas as semanas. Na ausência confirmada,
isso:

- reatribuía automaticamente todo apoio simples;
- montava a proposta "Reprogramar" (ADIAR) para todas as tarefas, dando horário a tarefas de fila.

**Correção** (`apps/api/src/modules/help/reschedule.ts`). Entra só o que dependia da pessoa no dia:

- tarefas com horário até o fim do dia (agenda, correção, embalagem, apoio de ajuda): regra inalterada;
- na fila, a tarefa em destaque (atual ou próxima executável — a mesma que o tablet mostra);
- tarefas sem horário com prazo interno até hoje.

O resto da fila continua na ordem, com a pessoa.

## 3. Prioridade e prazo (OS × planejamento)

**Fontes da verdade:**

| Dado                   | Fonte                                             |
| ---------------------- | ------------------------------------------------- |
| Prazo prometido        | só a OS (lido ao vivo), sem cópia no planejamento |
| Prioridade operacional | **OS**                                            |
| Posição na fila        | `queuePosition`, D9 + ordem manual                |
| Data inicial           | item do planejamento                              |

**Causa raiz.** A prioridade existia na OS, no item do planejamento e na tarefa, com três caminhos de escrita
independentes: mudava num lugar e o outro ficava diferente sem aviso.

**Correção.** Uma regra (`production/service-priority.ts`) aplicada em todas as entradas:

- edição da OS;
- planejar (`plan-services`);
- incluir OS na semana;
- reprogramar (mesma semana / outra semana);
- item do planejamento.

A mudança vale na OS, nos itens e nas tarefas **não iniciadas**. No modo fila só a própria OS é reposicionada
(D9). A ordem manual das outras é preservada. O prazo prometido não reordena nada.

Programação publicada exige motivo e gera revisão. Dados antigos divergentes só se alinham numa mudança
explícita (nada é reescrito sozinho). Os campos da tela dizem que a prioridade é do serviço.

## 4. Confirmar viagem sem custo

**Causa raiz.** A rota `POST /api/v1/finance/trip-costs/free` existia, com permissão, idempotência e
auditoria, mas sem tela. A pendência "custo não informado" bloqueava a conferência da semana.

**Correção:**

- botão "Confirmar viagem sem custo" na própria pendência, só para quem tem `financeiro.gerenciar`;
- diálogo "Confirma que esta viagem não teve custo? Ela será registrada com valor de R$ 0.", com motivo
  obrigatório;
- a tela se atualiza.

Repetição devolve 409 "Esta viagem já foi confirmada como sem custo." A corrida simultânea segue barrada pelo
índice único (409). Quem pode ver valores não mudou.

## Testes

- `apps/api/test/saneamento.test.ts`: 19 testes, nas seções A–D, incluindo regressão D9 explícita.
  Contraprova: com o código anterior, 10 deles falham. A seção A passa nos dois, porque a API já estava correta.
- E2E:
  - `novo-servico.spec.ts`: tipos diferentes por peça, até a OS;
  - `team-closing.spec.ts`: botão, confirmação, atualização da tela, repetição 409.

## Pendências reais (não implementadas)

- Ausência presumida (9h30) no modo fila: `detectImpacts` não conta a tarefa liberada em destaque e mostra
  "nenhuma tarefa afetada". Inconsistência anterior, sem efeito em massa.
- Pedido editado com peça nova de OS automática: item sem tipo → OS com `OUTRO` (modelo geral). Corrigível na
  OS (o tipo do item da OS é editável).
- OS de chegadas parciais posteriores copiam o prazo do pedido, não o da OS editada. Decisão de negócio.
- Reprogramação também muda a prioridade de tarefas de correção da OS. Comportamento anterior mantido.
- Sobreposição por tarefa (prioridade de uma tarefa na tela da semana) continua existindo.
- `tripCostInclude.allocations` sem `orderBy`: a ordem do rateio exibida pode variar. Teste
  `logistics-costs` nº 8 falhou 1× em execução local combinada; passou isolado e na suíte completa.
