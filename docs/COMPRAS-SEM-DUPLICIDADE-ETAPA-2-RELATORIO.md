# Compras e materiais sem duplicidade: Etapa 2

**Classificação: GO WITH CAVEATS.**

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

## Versões e CI

| Item                     | Valor                                                                     |
| ------------------------ | ------------------------------------------------------------------------- |
| Base                     | `56192c1` (homologada, CI nº 128 verde, 25/25 migrations)                 |
| Implementação            | `23de047`. CI nº 130 vermelho só por `team-route-os.spec.ts` (ver abaixo) |
| Candidato final          | `0c9262c` (correção só do teste E2E do roteiro). **CI nº 131 verde**      |
| Versão ativa homologação | **`0c9262c`**                                                             |
| Imagens                  | api `sha256:0878a143befa…`, web `sha256:d3c705aa4626…` (build `5583da14`) |

**Teste do roteiro (pré-existente):** CI nº 129 (commit só de documentação, código idêntico ao nº 128) e
nº 130 falharam em `team-route-os.spec.ts`. Causa: a numeração das paradas é do dia inteiro e outras
specs agendam paradas no mesmo dia com o André; "Parada 1" fixa dependia de não haver outras paradas.
O teste passou a conferir a mesma posição gravada pelo gestor e a ordem tarde → manhã. Nenhum código de
produção mudou por isso; nenhum teste foi desligado.

## Testes

- **API nova** (`compras-etapa2.test.ts`): 27 testes — migration e constraints; V1/V3 (pré-seleção,
  decisões inválidas); cadeia 10 → 8 (sobra pré-preenchida e oculta após registrar), 10 → 12 com 8
  cobertos = falta 4, troca de especificação, cadeia de 3 medições quebrada por cor, estoque/reserva
  excedente (nada liberado), E3 só em ATIVA; V2 Manter/Cancelar; travas (rascunho antigo 409, compra,
  reserva, sobra, reabrir); tarefas (vínculo move, troca de especificação, cancelamento sem tarefa presa);
  OS cancelada; devolução parcial com "Toda a OS" em revisão; concorrência real com `Promise.all`
  (duas aprovações, aprovação × compra, × recebimento, × devolução) e repetição idempotente; custo
  histórico intacto. Bloco de concorrência repetido 5× sem falha.
- **Ocorrências:** +2 testes (cadeia até a ATIVA; cancelada resolve; nova ocorrência nela → 409).
- **API completa:** 582 aprovados, 10 ignorados, 0 falhas. Etapa 1 (`compras-sem-duplicidade`) verde.
- **Unidade (shared):** 112 (inclui `coverageExcess`; `requirementCoverage` inalterada).
- **Web:** 6. **E2E completo local:** 41/41 (inclui `compras-etapa2.spec.ts`).
- **Qualidade:** lint, typecheck, format e build OK.

## Homologação (autonomia)

1. Estado inicial: `56192c1`, portão fechado. Impressão digital 3.805 linhas (`e35c92fcdb22…`); desde a
   Etapa 1 só mudaram tabelas de rotinas automáticas (presença, impactos, propostas de reprogramação,
   avisos, eventos, sessões) — nenhuma de compras/materiais.
2. Build `0c9262c`: SUCCESS. `gate_open`, `prepare_version` OK.
3. `migration_precheck`: imagem 26, banco 25, **1 pendente** (`20270105000000_necessidade_substituicao`,
   8 comandos), esquema compatível.
4. `maintenance_on`; `recovery_point_create` **`cenario-staging-20261016T151253Z`** (restauração de teste
   idêntica, enviado ao bucket); `backup_validate` OK.
5. `migrate`: **1 aplicada** em 23 s. `activate_version 0c9262c`, `gate_close`.
6. Depois: etiquetas e migrada `0c9262c`; `migration_verify` 26/26, nenhuma pendente/incompleta; health
   OK; smoke OK; WebSocket 401 sem sessão (esperado); suítes acesso e websocket ✔; logs de api, web,
   postgres e caddy sem erro.
7. **Impressão digital depois** (3.824 linhas, `6662594aa68d…`) — diferenças, todas esperadas:
   `_prisma_migrations` 25 → 26; em `material_requirements` 5 colunas, 2 índices, 2 CHECK, 2 FK, padrão
   `ATIVA` e o tipo `material_requirement_status`; as mesmas **4** linhas (hash muda só pelas colunas
   novas). **Nenhuma outra tabela mudou** (compras, recebimentos, reservas, movimentos, custos, fila,
   prazos). Sem backfill além de `ATIVA`.
8. Limpeza: imagens `03ab53b` removidas (2,12 GiB); `0c9262c` e `56192c1` protegidas.

## Ressalvas

1. Fluxos não clicados na homologação (sem login de aplicação no runner, por desenho); validação
   funcional pelo CI nº 131 e E2E 41/41 sobre o mesmo commit das imagens ativas.
2. A cobertura herdada só existe para cadeias estritamente compatíveis; trocas de especificação deixam
   fatos "sem necessidade ativa" que exigem ação humana na aba Materiais (por desenho, V4/V6).
3. A oferta de "Registrar sobra" desconta sobras já registradas na mesma OS com a mesma especificação
   completa; sobra registrada com especificação diferente não é reconhecida (sem aproximação).
4. Endpoint novo `POST /api/v1/material-requirements/:id/cancel` (gestor com `materiais.aprovar`) para a
   decisão da revisão de devolução (V7).
