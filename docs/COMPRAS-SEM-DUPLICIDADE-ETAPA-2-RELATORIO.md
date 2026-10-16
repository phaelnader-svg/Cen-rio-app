# Compras e materiais sem duplicidade: Etapa 2

Data: 2026-10-16. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Base homologada `56192c1` (CI nº 128 verde,
25/25 migrations). Produção fora do escopo e não tocada.

## O que muda

Uma nova medição não soma mais à anterior por padrão silencioso: na aprovação, o gestor decide, item a
item, se o material é **necessidade nova** ou **substitui** uma necessidade anterior da OS. A necessidade
passa a ter estado:

| Estado        | Significado                                                                       |
| ------------- | --------------------------------------------------------------------------------- |
| `ATIVA`       | Vale hoje: gera falta, "A comprar", prontidão e bloqueios.                        |
| `SUBSTITUIDA` | Trocada por uma nova medição (aponta para a sucessora). Fica no histórico.        |
| `CANCELADA`   | Encerrada (OS cancelada, peça devolvida ou decisão do gestor). Fica no histórico. |

Nada é apagado: compras, recebimentos, reservas, movimentos, sobras e custos continuam onde estavam.

## Migration (26ª, aditiva e sem perda)

`20270105000000_necessidade_substituicao`:

- enum `material_requirement_status` e coluna `status` NOT NULL DEFAULT `ATIVA`;
- `replaces_requirement_id` (FK para a própria tabela, ON DELETE RESTRICT) com índice **único** (no máximo
  uma sucessora direta);
- `closed_at`, `closed_by_id` (FK users, ON DELETE SET NULL), `close_reason`;
- CHECK `status = ATIVA ⇔ closed_at IS NULL` e CHECK contra autorreferência;
- índice `(service_order_id, status)`.

**Backfill:** somente o DEFAULT `ATIVA`. Nenhuma interpretação do histórico (V9).

Ensaio sobre cópia do banco E2E com dados: md5 de necessidades, alocações, reservas e custos idênticos
antes/depois; todas as linhas `ATIVA`; `prisma migrate diff` sem diferença; constraints verificadas.

## Regra da cobertura (fonte única preservada)

`requirementCoverage` **não mudou**. Mudou só o carregamento (`chainsOf`):

1. só necessidades `ATIVA` são cabeças;
2. para cada cabeça, caminha pelas predecessoras **enquanto compatíveis** e soma os fatos delas
   (compras, recebidos, reservas, sobras transferidas);
3. chama `requirementCoverage` com os fatos agregados.

Compatível (V4): mesma origem, tipo e unidade e — exclusivo: `specKey` completa; estoque: mesma chave do
catálogo. Sem botão "considerar compatível", sem equivalência manual, sem aproximação. X → Y: Y começa sem
a cobertura de X; os fatos de X aparecem como "sem necessidade ativa" na aba Materiais da OS.

O **excedente** (`coverageExcess`) é derivado das mesmas entradas, por estágio: rascunho, confirmado a
caminho, disponível (recebido/reservado/sobra) e já consumido.

## Decisões V1–V9 implementadas

- **V1/V3:** a revisão mostra, por item, "Nova necessidade" ou "Substitui: Linho cru — 10 m — Sofá A". Só
  vem pré-selecionado com exatamente um candidato seguro (mesma OS, mesma peça não nula, mesmo tipo,
  ATIVA, aprovada). "Toda a OS", zero ou vários candidatos: sem escolha automática.
- **V2:** necessidade anterior não repetida: Manter (padrão) ou Cancelar.
- **V4:** cadeia compatível acima.
- **V5:** OS cancelada → necessidades ATIVAS viram `CANCELADA` em lote (data, autor, motivo). Compras não
  são canceladas e continuam "sem destino".
- **V6:** reserva ativa sob substituição incompatível ou redução não é liberada sozinha: aviso "Reserva
  excedente" / "Reserva sem necessidade ativa" com link para Estoque → Reservas.
- **V7:** devolução parcial cancela, na mesma transação, as necessidades da peça devolvida (antes de
  liberar as reservas). Material "Toda a OS" vai para a revisão do gestor na devolução, com ação
  "Cancelar necessidade". Peça devolvida não aceita nova medição.
- **V8:** excedente exclusivo recebido → "Registrar sobra" pré-preenchido (material, especificação,
  quantidade; origem e custo unitário só quando há um único preço conhecido). Sobra registrada com a mesma
  especificação deixa de ser oferecida.
- **V9:** sem limpeza histórica.

## Travas

Todo vínculo novo exige necessidade `ATIVA` (409 com mensagem clara): itens de compra (`prepareItems`),
confirmação de rascunho antigo ("Edite o rascunho e vincule a necessidade atual"), reserva com
necessidade, transferência de sobra, vínculo de tarefa (422) e ocorrência de material.

**Concorrência:** ordem única de bloqueio **necessidades → OS** na aprovação, na compra e na
confirmação da devolução (sem deadlock); índice único da sucessora; idempotência da aprovação.

**Reabrir aprovação:** só a aprovação "virgem" é desfeita (necessidade ATIVA sem predecessora, sem
sucessora, sem compra, reserva, sobra, ocorrência ou tarefa). Caso contrário, 422.

## Tarefas, ocorrências, prontidão

- **Tarefas:** na substituição o vínculo passa para a sucessora (auditado); no cancelamento é removido
  (auditado). Levantamento feito e tudo encerrado = prontidão `COMPLETO` (a tarefa não fica presa em
  "sem levantamento").
- **Ocorrências:** necessidade citada é resolvida para a cabeça ATIVA da cadeia; cancelada → a causa
  deixou de existir.
- **Recebimento de compra de estoque:** reserva automática só para a cabeça ATIVA compatível.
- **Previsto (Resultado por OS):** só ATIVAS. Comprado, consumido e lançamentos de custo intactos.

## Fora desta etapa

Etapa 3, compra antecipada, necessidade prevista e Cobrança. D9 ("prazo não reorganiza a fila"), prazos e
D11 sem alteração. Tablet sem funções administrativas novas.
