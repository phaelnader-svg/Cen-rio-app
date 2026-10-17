# Cobrança / pagamento do cliente

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-17. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Base `020a820` (CI nº 133, 27/27).
Candidato **`e1a7030`** (CI nº 138 verde), ativo na homologação com **28/28** migrations. Produção
fora do escopo e não tocada.

## Fontes de verdade (inalteradas)

- Valor final = `commercial_orders.agreed_value_cents` + Σ `commercial_adjustments`.
- Cobranças = `customer_receivables`; caixa = `customer_payments`.
- Resultado da OS = receita econômica/contratual (nunca o dinheiro recebido).

## Migration (28ª, aditiva)

`20270119000000_cobranca_cliente` (28 comandos):

- `commercial_order_items.agreed_value_cents` (nulo, CHECK ≥ 0);
- `customer_receivables`: `due_date` opcional, `due_trigger` DATA/RETIRADA/ENTREGA (DATA ⇒ data),
  `installments` 1..12 só para cartão;
- `customer_payments`: `installments`, `refund` (padrão false); CHECK do valor refeito
  (recebimento > 0; estorno < 0 com vínculo; reembolso < 0 sem vínculo);
- `customer_payment_reports`: registro da equipe (retirada XOR entrega), PENDENTE/CONFIRMADO/
  DESCARTADO, `payment_id` único, um pendente por cobrança e parada, proibido apagar.

**Backfill:** só os padrões técnicos (`due_trigger='DATA'`, `refund=false`). Ensaio em cópia do
banco E2E: aplicada, `migrate diff` vazio, dados idênticos (excluídas as colunas novas), CHECKs
verificados.

## O que muda

| Tema                      | Regra                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Condição (AM-1)           | Novo serviço: 50/50 (entrada com data + saldo na entrega), 100% Pix, cartão 100% N×, cartão na retirada N×, Manual. Cobranças criadas na mesma transação e idempotência do Novo serviço. `payment_terms` segue como observação. |
| Valor por peça (AM-2)     | Todas ou nenhuma; soma = valor final, validada no domínio (criação, edição, ajuste, reembolso). Ajuste com valores por peça exige a nova distribuição.                                                                          |
| Receita por OS (AM-3)     | Com valores: soma das unidades da peça na OS (estável: OS anterior nunca perde receita; peça sem OS não transfere). Sem valores: fallback antigo, marcado **estimado**.                                                         |
| Vencimento (AM-4)         | DATA, ou conclusão real da retirada/entrega (derivado; frustrada/reagendamento não vencem). VENCIDO derivado.                                                                                                                   |
| Entrega (AM-5)            | Saldo com aviso forte no agendamento, detalhe e conclusão; confirmação consciente ("Estou ciente"); nada bloqueado. Central acusa entregue com saldo.                                                                           |
| Desconto (AM-6)           | Reduz automaticamente só a cobrança de vencimento mais distante ABERTA sem recebimento; parcial/recebida exige redução explícita; nunca abaixo do recebido sem reembolso.                                                       |
| Reembolso (AM-7)          | Recebimento negativo `refund=true`, data real, motivo, sem estorno vinculado + ajuste comercial; cobrança reduzida junto (o saldo não reaparece); nunca acima do recebido líquido.                                              |
| Pagamento em campo (AM-8) | Equipe informa (sim/não, forma, observação); escritório confirma (cria o recebimento) ou descarta; dupla confirmação impossível.                                                                                                |
| Tablet (AM-9)             | `paymentInstruction` (ação, valor, forma, parcelas) só para o responsável da parada, com a cobrança aberta do gatilho correspondente.                                                                                           |
| A maior (AM-10)           | Bloqueado, mensagem com o saldo.                                                                                                                                                                                                |
| Cancelamento (AM-11)      | Sem recebido: cobranças canceladas. Com recebido: decisão explícita reter e/ou reembolsar; nenhuma cobrança fantasma; pendentes da equipe descartados.                                                                          |
| Data (AM-12)              | Data passada aceita (fechamento não cobre clientes); futura recusada.                                                                                                                                                           |
| Edição direta (AM-13)     | Só antes da primeira cobrança (com evento financeiro); depois, só ajuste.                                                                                                                                                       |

Correções da auditoria: PUT do valor respeita o financeiro; cancelamento trata cobranças;
recebimento/estorno/cancelamento travam pedido → cobrança; estorno confere versão e usa o fuso da
oficina (e não deixa o recebido negativo após reembolso); data futura recusada.

## Telas

Pedido → **Financeiro** (valor fechado, recebido, saldo, vencido, condição, valores por peça,
cobranças e pagamentos; Lançar cobrança, Ajuste, Reembolso). Novo serviço e pedido com valor por
peça e condição. Financeiro → Receitas: "Só vencidas" (dias em atraso) e "Pagamento informado pela
equipe — confirmar". Entregas: aviso de saldo. Tablet: bloco "PAGAMENTO NA RETIRADA/ENTREGA" com
"Pagamento realizado/coletado?". Central: tipo COBRANCA (só `financeiro.ver`).

## Testes

- API nova `cobranca.test.ts`: 22 testes cobrindo os cenários 1–47 (inclui concorrência com
  `Promise.all`: baixa dupla, cobranças diferentes, pagamento × ajuste/edição/cancelamento,
  reembolso × reembolso, reembolso × pagamento (3×), dupla confirmação/descarte, cancelamento ×
  confirmação). Executado 3× sem falha.
- Shared: +3 (115). API completa: **628 aprovados, 0 falhas**. E2E completo local 42/43 → o único
  ajuste: `team-quality` passa a confirmar o saldo (AM-5); novo `cobranca.spec.ts`. CI nº 138 verde
  (format, lint, typecheck, migrations do zero, build, testes, backup, E2E).
- Testes ajustados deliberadamente: `finance.test` (campo `estimated`; estorno com versão),
  `integrity-audit` (data de recebimento não futura), `team-quality` (confirmação do saldo). Os
  testes antigos de privacidade continuam valendo sem alteração; a nova allowlist garante que o
  único valor da equipe é `paymentInstruction.amountCents`.

## Homologação

1. Build `e1a7030` SUCCESS (api `sha256:fc751f1029ee…`, web `sha256:c3e731fb5863…`).
2. `migration_precheck`: imagem 28, banco 27, **1 pendente** compatível (28 comandos).
3. `maintenance_on`; ponto de recuperação **`cenario-staging-20261017T204051Z`** (restauração de
   teste idêntica); `backup_validate` OK.
4. `migrate`: **1 aplicada** em 23 s. `activate_version e1a7030`, `gate_close`.
5. `migration_verify` 28/28; health, smoke, WebSocket (401 sem sessão) e suítes saúde/acesso/
   websocket OK; logs de api, web, postgres e caddy sem erro.
6. Impressão digital (3.850 → 3.919 linhas): só `_prisma_migrations` 27 → 28 e o esquema da
   migration; `commercial_order_items` com as mesmas 5 linhas (coluna nova nula); homologação sem
   cobranças/recebimentos (nada a preencher). Nenhuma outra tabela mudou.
7. Imagens `0c9262c` removidas; `e1a7030` (ativa) e `020a820` (ponto de recuperação) protegidas.

## Ressalvas

1. Fluxos não clicados na homologação (sem login de aplicação no runner); validação funcional
   pelo CI nº 138 e E2E sobre o mesmo commit.
2. Saldo "na entrega" vence na **primeira** entrega concluída com peças do pedido (entregas
   parciais: o saldo é esperado já na primeira).
3. Uma instrução de pagamento por parada (a cobrança mais antiga em aberto do gatilho); a
   seguinte aparece depois de quitada.
4. Pedido cancelado com valores por peça: a soma das peças deixa de ser exigida (não há OS).
5. Teste de tempo real `integrated-evolution` nº 7 falhou uma vez só sob carga (API + E2E em
   paralelo); passou 3× isolado e na suíte completa isolada e no CI.
