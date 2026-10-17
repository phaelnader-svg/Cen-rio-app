# R1 — Mão de obra confiável + Meus Ganhos

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-17. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Base `e1a7030` (CI nº 138, 28/28).
Candidato inicial `0ee0dca` → correções `9cef46f` (tipo de teste) e `5c29700` (privacidade do motivo
de revisão). **Homologado: `5c29700`** (CI 39077760651 verde), **29/29** migrations. Produção fora
do escopo e não tocada.

## Decisões aplicadas

DEC-1 R1 sozinho · DEC-2 troca de principal pela regra canônica · DEC-3 devolução parcial com OS
inteira → revisão · DEC-4 só remuneração variável própria · DEC-5 só tablet · DEC-6 D13 fora
(pagamento como homologado) · DEC-7 semana conferida não é reescrita · DEC-9 permissão por padrão
(tapeceiro e logística) · DEC-10 desbloqueio de 5 min por sessão.

## Correções na fonte (P0/P1)

| Item                   | Antes (reproduzido)                                                            | Agora                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0-1 TROCAR_PRINCIPAL  | Tarefa ia ao novo tapeceiro; titular, obrigação e revisão ficavam com o antigo | `setUpholsterer` (motivo, elegibilidade, histórico, tarefas da peça, LaborReview); sem peça → revisão da OS inteira; `changeTask` recusa caminho lateral na tapeçaria; proposta guarda o principal de origem |
| P0-2 Devolução parcial | Obrigação da OS inteira ficava integral, sem revisão                           | LaborReview no escopo da OS inteira; valor EM REVISÃO; sem desconto/rateio; repetição idempotente                                                                                                            |
| Situação única         | Fechamento contava peças devolvidas na OS inteira                              | `laborSituationOf` na lista, fechamento, Meus Ganhos e pagamento                                                                                                                                             |
| Revisão global         | Qualquer revisão bloqueava qualquer semana                                     | Bloqueia só a semana das obrigações dela                                                                                                                                                                     |
| Estorno                | Sem revisão/cancelamento; lote sem versão                                      | Recusa com revisão aberta ou cancelada; repetição = 409; lote idem                                                                                                                                           |
| Semana conferida       | Ajuste posterior reescrevia semana/relatório                                   | Mudança após a liberação tem competência própria (fechamento, logística, relatório semanal); `previousCents` separa saldo anterior                                                                           |
| "Meus valores"         | Somava valor em revisão                                                        | `inReviewCents` à parte                                                                                                                                                                                      |

## Meus Ganhos

`POST /finance/my-earnings/unlock` (PIN, limite de tentativas, token HMAC ligado à sessão, 5 min,
sem valores) e `GET /finance/my-earnings?week=` (sessão DEVICE + `financeiro.producao_propria` +
token). Visão filtrada pela sessão sobre `buildClosingItems`: previsto, aguardando liberação, em
revisão, liberado, pago, saldo; itens com combinado, ajustes (motivo; de revisão → "valor definido
pelo gestor"), pagamentos e estornos, data de liberação; logística própria. Totais = fechamento
para a mesma pessoa e semana. Sem TeamMonthlyCost, margem, preço ou valores de terceiros.

## Migration 29 (`20270126000000_meus_ganhos_permissao`)

Um comando: `INSERT … role_permissions` de `financeiro.producao_propria` para `tapeceiro` e
`logistica_terceirizada`, `ON CONFLICT DO NOTHING`. Sem esquema, sem valores, sem financeiro geral.

## Validação

- API completa (0ee0dca): 653 aprovados, 0 falhas, 10 ignorados (perf/proxy opcionais); novos
  `mao-de-obra-confiavel` (13) + `meus-ganhos` (12), executados de novo em `5c29700`.
- Shared 119 (4 novos). E2E local completo em `5c29700`: **43/43**. Lint, format, typecheck ok.
- CI: 39074719011 (0ee0dca) falhou no typecheck de teste; 39076273582 (9cef46f) falhou no E2E
  `team-labor` (motivo da revisão expunha o outro profissional — corrigido); **39077760651
  (5c29700) verde**.

## Homologação

Build SUCCESS (api `sha256:0e126f44…`, web `sha256:ee7a0558…`) → gate_open → prepare_version →
precheck (1 pendente, 1 comando) → manutenção → ponto de recuperação
`cenario-staging-20261017T235133Z` (restauração de teste idêntica, enviado ao bucket) →
backup_validate → migrate (1 aplicada, 40 s) → activate `5c29700` → gate_close → migration_verify
29/29 → health, smoke, WebSocket, suítes saúde/acesso/websocket OK; logs sem erro. Impressão digital:
só `_prisma_migrations` 28→29 e `role_permissions` 78→80.

## Dados existentes (somente leitura, contagens)

Antes: production_payables 1, labor_reviews 0, professional_payments 0, reversals 0, adjustments 0,
owner_changes 1, reschedule_proposals 8, logistics_costs 2. Nada corrigido. O runner só expõe
contagens (sem consulta de detalhe), então titular × recebedor da única obrigação não pôde ser
conferido linha a linha.

## Ressalvas

1. Fluxos não clicados na homologação (sem login de aplicação); validação pelo CI e E2E do SHA.
2. Auditoria de dados limitada a contagens (ver acima).
3. Plano LEGADO: a troca de titular pela rota não move tarefas sem classe de etapa (comportamento
   existente); pela Reprogramação a tarefa é movida junto.
4. Motivo neutro para ajustes de revisão é identificado pelo prefixo "Revisão RF-" gravado pela
   resolução.
5. Previsto/aguardando/em revisão em Meus Ganhos e no fechamento são a situação atual (mesmo em
   semana passada).
