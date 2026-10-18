# R2 — Negociação de valores + confirmação semanal + portão de pagamento (D13)

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-18. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Base `5c29700` (R1, 29/29).
**Homologado: `932e04b`** (CI nº 149 / 39088968574 verde em todas as etapas), **30/30**
migrations. Produção fora do escopo e não tocada.

## Regra D13 aplicada

Pagamento a profissional (mão de obra e logística) só sai se cada item pago estiver, com o valor
devido atual, numa **confirmação semanal do próprio profissional** ou numa **exceção
administrativa** da mesma pessoa e semana. Sem caminho lateral: pagamento direto
(`/labor/:id/payments`), parcial, lote (`/weekly-closings/:week/payments`), rota genérica de contas
a pagar (`/payables/:id/payments`, viagens com recebedor), repetição, concorrência e antecipação
passam pelo mesmo `assertPaymentCovered`. O lote só distribui entre itens cobertos.

- Linha conferida = `{kind, id, code, bucket, dueCents, totalDueCents}`; pagamentos da semana não
  entram (pagar em parte não invalida); mudar o devido invalida (ajuste, negociação, revisão,
  cancelamento). Hash SHA-256 de `{userId, weekStart, linhas canônicas}`.
- Semana do pagamento = semana do lote, ou `closingWeekStart(paidAt)` no direto. Uma semana não
  cobre outra.
- Antecipação (item previsto) só por exceção com o item exato (`itemIds`).
- Exceção: `financeiro.gerenciar`, motivo obrigatório, pessoa, semana, itens e valores gravados,
  imutável (gatilho), auditada (`finance.week_exception` + evento), texto neutro ao profissional
  ("Pagamento liberado administrativamente."); nunca aparece como confirmação dele.
- Confirmação do profissional: só no tablet/celular com o desbloqueio D12; pedido pendente
  impede; hash divergente → 409; repetição idempotente; separada da conferência (CONFERIDO) do
  gestor.

## Negociação de valores

`value_change_requests`: só o beneficiário pede, pelo tablet (D12), sobre o próprio item;
PENDENTE / APROVADA / RECUSADA / OBSOLETA, no máximo uma pendente por alvo (índice parcial).
Aprovação pelas funções existentes (`editLaborAgreed` antes da liberação e sem pagamento;
`adjustLabor`; `adjustTripCost`), na mesma transação; recusa exige motivo; alvo mudou (titular,
revisão aberta, valor, cancelamento) → OBSOLETA sem aplicar nada. Sem segunda fonte de verdade:
o valor continua em ProductionPayable/ajustes e LogisticsCost/contas a pagar. Notificações
`VALOR_SOLICITADO`/`VALOR_DECIDIDO` sem valores.

## Telas

- Meus Ganhos (tablet/celular): "Solicitar alteração" por item, situação do pedido, "Conferir
  semana" com a lista e o total, caixa "Conferi os itens e os valores desta semana" e "Confirmar
  semana"; pagamento por exceção marcado "(liberado administrativamente)".
- Fechamento semanal (painel): situação da confirmação por linha, "Pagar por exceção
  administrativa" (motivo interno + mensagem opcional), painel de pedidos (aprovar/recusar).

## Migration 30 (`20270202000000_negociacao_confirmacao_semanal`)

Aditiva, 22 comandos: duas tabelas novas com CHECKs (alvo exclusivo, status, valores, decisão;
tipo, motivo da exceção, segunda-feira ISO, hash), índices parciais de pendência, gatilho contra
exclusão de pedidos e de imutabilidade das confirmações. Sem backfill, sem confirmação retroativa:
dados antigos ficam sem confirmação.

## Validação

- Aceite 1–55: `negociacao-confirmacao.test.ts` (21 casos agrupados, todos passando).
- Testes antigos que pagavam sem confirmação (23 em 7 arquivos) passam a dar o passo explícito da
  regra aprovada (exceção administrativa) antes de pagar; nenhuma asserção removida. O teste 40
  da R1 ("lote sem confirmação, D13 fora") passou a provar o contrário: 422 sem cobertura, 201 com
  a semana liberada.
- API completa: 674 + 1 corrigido (compras-etapa3: dia do relatório tomado em UTC — falhava entre
  21h e 24h no horário de Brasília, sem relação com a R2; passou a usar o fuso da oficina). Shared
  123 (4 novos), web 6. Lint, format, typecheck ok.
- E2E completo local em `932e04b`: **44/44** (novo `team-negociacao`: pedido no celular do André →
  aprovação no painel → pagamento do item recusado sem confirmação → André confere → pagamento
  pela tela de contas a pagar; `team-closing` usa a exceção pela tela; `team-logistics` prova que
  a exceção antiga não cobre o valor ajustado).
- CI: 39087008016 (`ad7085a`) falhou só no E2E novo (premissa do teste, corrigida em `932e04b`);
  **39088968574 (`932e04b`) verde**.

## Homologação

Impressão digital antes → build SUCCESS (api `sha256:412b9466…`, web `sha256:d679ebac…`) →
gate_open → prepare_version → precheck (1 pendente, 22 comandos, compatível) → manutenção →
ponto de recuperação `cenario-staging-20261018T025240Z` (restauração de teste idêntica, enviado ao
bucket) → backup_validate → migrate (1 aplicada, 22 s) → activate `932e04b` → gate_close →
migration_verify **30/30** → health, smoke, WebSocket → suíte completa. A primeira execução da
suíte acusou disco em 86% (imagens novas); limpeza planejada removeu só imagens de `020a820` e
`e1a7030` (ativa e a do ponto de recuperação protegidas; livre 2,74 → 6,99 GiB) e a suíte
completa passou (saúde, acesso, WebSocket; disco 63%). Logs de api/web/postgres/caddy sem erro.
Impressão digital: só `_prisma_migrations` 29→30 e o esquema das duas tabelas novas (vazias).

## Dados existentes (somente leitura, contagens)

production_payables 1, professional_payments 0, reversals 0, financial_adjustments 0,
labor_reviews 0, logistics_costs 2, account_payables 0, weekly_closings 0,
value_change_requests 0, weekly_closing_confirmations 0. Nada corrigido nem confirmado
retroativamente.

## Ressalvas

1. Fluxos não clicados na homologação (sem login de aplicação); validação pelo CI e E2E do SHA.
2. Auditoria de dados limitada a contagens.
3. Com o D13, todo pagamento a profissional passa a exigir confirmação ou exceção: a operação
   precisa que os profissionais confiram a semana no tablet/celular, ou o gestor registra a
   exceção com motivo.
4. O Pix em lote paga só os itens cobertos; um item novo da mesma semana fica de fora até nova
   confirmação/exceção (comportamento desejado, mas o saldo restante aparece na linha).
5. Confirmação/exceção de semanas anteriores a esta versão não existem (sem retroatividade).
