# Evolução, Fase 5 de 8 — Mão de obra dos tapeceiros, privacidade e integração financeira

Ambiente exclusivamente local (PostgreSQL 16 em contêiner, dados sintéticos). Sem deploy, sem
Cloud Build, sem Google Cloud/homologação/DNS/VM/segredos, sem migrations em bancos remotos, sem
pagamentos reais, sem mensagens, sem dados reais e sem VerificaPro. Custos de logística e
fechamento semanal **não** foram alterados/implementados. A Fase 6 **não** foi iniciada.

## 1. Branch, SHA e worktree

| Item                                   | Valor                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Branch                                 | `claude/cenario-gestao-fase-1-zf3bj2`                                                                  |
| SHA inicial (conferido: fim da Fase 4) | `581e03e`                                                                                              |
| SHA final                              | último commit desta entrega (o deste relatório)                                                        |
| Worktree                               | `/home/user/Cen-rio-app`; migrations no banco local: 15 (1 nova: `20261101000000_mao_de_obra_revisao`) |

Commits: `c2d490c` migration aditiva + domínio; `9d759e2` API; `42c276a` web (painel e tablet);
`15cd00c` E2E e evidências; e o commit deste relatório (com o teste de reprovação/retrabalho).

Arquivos novos: `apps/api/src/modules/finance/labor-review.ts`,
`apps/web/components/finance/service-order-labor.tsx`, `apps/api/test/labor.test.ts`,
`apps/api/test/labor-perf.test.ts`, `packages/shared/test/labor-review.test.ts`,
`tests/e2e/specs/team-labor.spec.ts`, a migration e
`packages/db/rollback/20261101000000_mao_de_obra_revisao.down.sql`.
Alterados: `finance/labor.ts`, `finance/routes.ts`, `app.ts`, `production/distribution.ts`,
`quality/common.ts`, `shared/finance-domain.ts`, `shared/types-finance.ts`,
`shared/schemas/finance.ts`, `schema.prisma`, `web/components/finance/labor.tsx`,
`web/components/tablet/my-values.tsx`, `web/components/commercial/service-order-detail.tsx`,
`web/lib/finance.ts`, testes `finance.test.ts`/`tablet-week.test.ts` e E2E `team-finance.spec.ts`.

## 2. Auditoria inicial (antes de editar)

### 2.1 Entidades e fonte de verdade

| Conceito                 | Onde (antes da Fase 5)                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS / peça                | `service_orders`, `service_order_items` (`fulfillment_stage`)                                                                                              |
| Titular da peça (Fase 3) | `service_order_items.upholsterer_user_id` + histórico imutável `service_order_item_owner_changes`                                                          |
| Mão de obra combinada    | `production_payables` (uma por peça **ou** uma pela OS inteira; `agreed_cents`, `adjustments_cents`, `paid_cents`, `status`, `eligibility`, `eligible_at`) |
| Ajustes                  | `financial_adjustments` (imutáveis)                                                                                                                        |
| Pagamentos               | `professional_payments` (registro; o sistema não transfere dinheiro)                                                                                       |
| Histórico / auditoria    | `financial_events`, `audit_logs`                                                                                                                           |
| Aprovação de qualidade   | `quality_inspections` → `refreshItemStage` (`quality/common.ts`) muda `fulfillment_stage`                                                                  |
| Visibilidade no tablet   | `GET /finance/my-production` com `FIN_OWN` (`financeiro.producao_propria`), sessão de qualquer tipo                                                        |

**Fonte de verdade e precedência**: o valor devido é sempre `agreed_cents + adjustments_cents`
(nunca negativo) de cada linha viva de `production_payables`; o pago é a soma de
`professional_payments`. Previsto/liberado/pago/saldo são **derivados**; nenhum total é gravado
em outro lugar. Valor da OS inteira (legado) e valores por peça são mutuamente exclusivos.

### 2.2 Transições PREVISTO → LIBERADO → PAGO (achados)

- `laborStatus` calcula PREVISTO/LIBERADO/PAGO_PARCIAL/PAGO a partir de `eligible`; `isEligible`
  = `eligible_at` já gravado **ou** regra (`PRODUCAO_CONCLUIDA`, `QUALIDADE_APROVADA`,
  `ENTREGA_CONCLUIDA`) satisfeita pelas etapas das peças.
- **Achado:** `refreshLabor` só rodava em leituras (GET labor, labor/:id, my-production,
  resultados). O banco ficava PREVISTO após a aprovação até alguém abrir uma tela.
  **Corrigido:** `refreshItemStage` chama `refreshLaborOf` na mesma transação da mudança de etapa
  (`apps/api/src/modules/quality/common.ts:391`).
- Pagamento antes da liberação só com justificativa (“antecipado”); acima do devido é recusado.

### 2.3 Sinalização da Fase 3

`setUpholsterer` calculava `financialReviewNeeded` e gravava `financial_review_required` na troca,
mas **nada bloqueava** liberação/pagamento; a definição de titular via distribuição gravava sempre
`false`. Agora ambas abrem revisão (seção 3).

### 2.4 Caminhos de exposição financeira (inventário)

| Caminho                                                             | Proteção                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/api/v1/finance/*` (listas, detalhe, relatórios/CSV, painel)       | `FIN_VIEW`/`FIN_MANAGE`/`FIN_ADJUST`, sessão de painel                                          |
| `/finance/my-production`                                            | `FIN_OWN`; **agora** recusado para sessão DEVICE (tablet) — exige PIN (`/unlock`)               |
| Endpoints de produção, fila, “Minha semana”, notificações, presença | sem campos monetários (varredura por chave nos testes)                                          |
| WebSocket                                                           | eventos financeiros com audiência `financeiro.ver` (`FINANCE_AUDIENCE`), sem valores no payload |
| Logs                                                                | redação (`lib/log-redaction.ts`), inclusive `*.pin`                                             |

### 2.5 Ambiguidades e estado seguro adotado

| Ambiguidade                                            | Decisão (estado seguro, sem rateio automático)                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Troca de titular com valor já combinado                | Revisão financeira ABERTA; trava liberação, pagamento, ajuste, edição, cancelamento e novo valor no escopo |
| Valor da OS inteira com peças de titulares diferentes  | Novo lançamento recusado (lance por peça); legado → revisão ABERTA (migration)                             |
| Valor por peça para quem não é o titular               | Recusado                                                                                                   |
| Liberação já gravada e peça volta para correção depois | Liberação não é desfeita em silêncio (regra da Fase 12): o gestor ajusta com justificativa                 |
| Data de referência para a Fase 7                       | combinado = criação; liberado = `eligible_at`; pago = data do pagamento (sugerida: liberação)              |

## 3. Arquitetura e mudanças

- **Migration aditiva** `20261101000000_mao_de_obra_revisao`: tabela `labor_reviews`
  (`ABERTA`/`RESOLVIDA`, resolução em JSON, quem abriu/resolveu); `production_payables.review_id`;
  índice único **uma revisão aberta por escopo**; gatilho que impede alterar/apagar revisão
  resolvida; índices únicos **uma obrigação viva por profissional e escopo**. Os índices da
  Fase 11 “uma obrigação viva por peça/OS” foram **substituídos** (mais restritivos que os
  novos): na substituição resolvida, quem trabalhou mantém o devido e o novo titular ganha
  obrigação própria na mesma peça. Lançamentos comuns continuam um por peça (regra da aplicação,
  serializada por `FOR UPDATE` na OS). Dados legados: revisões abertas criadas para as trocas
  sinalizadas da Fase 3 e para valores da OS inteira com titulares diferentes.
- **Serviço** `apps/api/src/modules/finance/labor-review.ts`: `openLaborReviews` (:61, idempotente
  por escopo), `editLaborAgreed` (:224, CAS por versão, nunca após pagamento, auditoria
  antes/depois), `resolveLaborReview` (:274, bloqueio `FOR UPDATE` da revisão e das obrigações;
  quem já tinha valor tem de constar, nunca abaixo do pago; diferença vira ajuste justificado,
  zero sem pagamento cancela, novo profissional ganha obrigação ligada à revisão; tudo numa
  transação), `laborWeekly` (:437) e rotas (`/finance/service-orders/:id/labor`,
  `/finance/labor-reviews[/:id[/resolve]]`, `/finance/labor/:id/agreed`, `/finance/labor-weekly`,
  `/finance/my-production/unlock`).
- **Bloqueios** em `finance/labor.ts`: `refreshLabor` não libera com revisão aberta (:177);
  `createLabor` exige o titular e recusa OS inteira com titulares diferentes (:222);
  `assertNoReview` (:438) em ajuste, pagamento e cancelamento.
- **Situação exibida** (`laborSituation`, `packages/shared/src/finance-domain.ts:405`):
  Combinado (previsto) · Concluído, aguardando qualidade · Liberado para pagamento · Pago em parte
  (saldo pendente) · Pago · Em revisão financeira · Cancelado.
- **Distribuição** (`production/distribution.ts`): a troca/definição de titular abre a revisão
  (:196); a pendência `REVISAO_FINANCEIRA` acompanha revisão aberta (:486).
- **Tablet** “Meus valores”: `GET /my-production` recusado para sessão DEVICE (`routes.ts:421`);
  `POST /my-production/unlock` confere o PIN do **próprio usuário da sessão** com o mesmo
  limitador do login (`AuthThrottle`/`POLICIES.pin`), responde `cache-control: no-store`; a tela
  guarda os dados só no componente, oculta ao sair, em “Ocultar valores” ou após 2 minutos.
  Autorização por identidade (`request.auth.userId`) + permissão, nunca por nome.
- **Painel**: aba **Mão de obra** na OS (só `financeiro.ver`) com titular, valor por peça,
  “Sem valor combinado.” (≠ R$ 0), situação, “Combinar valor”, alerta e diálogo **Resolver
  revisão** (totais antes/depois); aba Produção do financeiro com revisões pendentes,
  “Alterar valor combinado” (motivo) e ações travadas durante a revisão. Nenhum valor nas páginas
  de produção.
- **Desempenho**: listas sem N+1 (`openReviewIndex`, labor.ts:89) e `refreshLaborOf` em lote
  (só regrava o que muda).

## 4. Evidências de tela (dados sintéticos)

`docs/evidencias/evolucao-fase-5/`: `01-os-mao-de-obra-por-peca`, `02-revisao-financeira-aberta`,
`03-resolver-revisao`, `04-revisao-resolvida`, `05-tablet-ricardo-meus-valores`,
`06-tablet-marcio-meus-valores`. Capturas da Fase 11 atualizadas (novos rótulos e PIN).

## 5. Matriz CA5

| CA     | Status     | Evidência                                                                                                                                                                                   |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA5-01 | APROVADO   | `labor.test.ts` #1 (centavos inteiros, titular, 0/negativo/ausente/fracionário → 400); E2E passo “Combinar valor” na OS                                                                     |
| CA5-02 | APROVADO   | #1 (Ricardo 80.000 e Márcio 45.000 independentes, sem soma); E2E (R$ 320,00 × R$ 450,00)                                                                                                    |
| CA5-03 | APROVADO   | #3 (valor da OS preservado, nada replicado, revisão aberta, liberação travada); migração legada (seção 6.3)                                                                                 |
| CA5-04 | APROVADO   | #2 (403 sem `financeiro.ajustes`, 400 sem motivo, 409 versão, auditoria `{from,to}`, 422 após pagamento)                                                                                    |
| CA5-05 | APROVADO   | #4 (Ricardo/Márcio só os próprios; 403 cruzado em labor/:id, lista, OS, revisões, semanal e relatórios; João e painel sem permissão 403); E2E                                               |
| CA5-06 | APROVADO   | #4 (tablet sem PIN 403, PIN errado/de outra pessoa 401, bloqueio 429, `no-store`); #5 (varredura de produção, Minha semana, notificações e WS); E2E (ocultar)                               |
| CA5-07 | APROVADO   | #6 (concluir 2× → PREVISTO, 0 pagamentos); `finance.test.ts` #8                                                                                                                             |
| CA5-08 | APROVADO   | #6 (aprovação libera no banco sem leitura; 1 evento LIBERADO); #6b (reprovação + correção: continua previsto, libera só na nova aprovação, 1 obrigação, 0 pagamentos)                       |
| CA5-09 | APROVADO   | #7 (30.000 + 50.000 = PAGO; 50.001 e +1 recusados; 403 sem permissão; mesma chave não repete)                                                                                               |
| CA5-10 | APROVADO   | #8 (`Promise.all`: criação 201/409, edição 200/409, pagamento 200/409, resolução 200/422; índice do banco recusa duplicata)                                                                 |
| CA5-11 | APROVADO   | #9 (revisão aberta, obrigação/pagamento intactos, ida-e-volta não duplica revisão, operações 422); E2E                                                                                      |
| CA5-12 | APROVADO   | #9/#10 (pagamento anterior preservado; valor original + ajuste justificado; histórico)                                                                                                      |
| CA5-13 | APROVADO   | #10 (403 sem permissão; recusa sem o profissional existente, abaixo do pago, ajudante, sem motivo; total conciliado; auditoria; revisão imutável); E2E                                      |
| CA5-14 | APROVADO\* | Regressão API 333/334 executados — a falha é pré-existente e dependente do dia da semana (seção 6.1); suítes relacionadas 88/88; E2E completo 25/25                                         |
| CA5-15 | APROVADO   | Migração sobre dados da Fase 4: contagens/somas/hashes iguais; rollback → schema idêntico; reaplicação; rollback recusado e atômico após resolução dividida; backup/restauração (seção 6.3) |
| CA5-16 | APROVADO   | #11 (combinado/liberado/pago por tapeceiro e semana iniciando na segunda; saldo por profissional; período inválido 400)                                                                     |

\* ver seção 6.1.

## 6. Testes executados (contagens reais)

### 6.1 Automatizados

| Suíte                                  | Comando                                                               | Resultado                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitários shared                       | `cd packages/shared && npx vitest run`                                | 71/71                                                                                                                                                                                                                                               |
| Fase 5 API (PG16 local)                | `npx vitest run test/labor.test.ts`                                   | 12/12                                                                                                                                                                                                                                               |
| Regressão API completa                 | `cd apps/api && npx vitest run`                                       | 333 passaram, 1 falhou, 3 ignorados (perf com variável) — antes do teste #6b                                                                                                                                                                        |
| Falha da regressão                     | `measurements.test.ts` “planejamento distingue solicitado × aprovado” | **pré-existente**: falha idêntica no código da Fase 4 (`581e03e`) executado hoje (sábado); o teste agenda a medição para a “próxima sexta”, que no fim de semana cai na semana seguinte. Módulo de medições não alterado. Sugerida tarefa separada. |
| Desempenho (`LABOR_PERF=1`)            | `npx vitest run test/labor-perf.test.ts`                              | 1/1 (seção 9)                                                                                                                                                                                                                                       |
| Lint, formatação, typecheck, build web | `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `build:web`       | sem apontamentos; compilado                                                                                                                                                                                                                         |

### 6.2 E2E

| Suíte                                                   | Resultado                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Fase 5 (gestor + Ricardo + Márcio + João sem permissão) | 1/1                                                                               |
| E2E completo (`cd tests/e2e && npx playwright test`)    | 25/25 (7,8 min), inclusive Fases 2–4, Fase 11 atualizada (PIN) e auditoria visual |

### 6.3 Migração, rollback, backup

Banco sintético gerado **com o código da Fase 4** (worktree em `581e03e`): 3 OS — sofá do Ricardo
(80.000, pago 30.000) trocado para o Márcio; poltronas do Márcio (45.000 + ajuste 5.000); valor da
OS inteira do Ricardo (125.000) com peça do Márcio; sofá do Ricardo pago integralmente (controle).

1. Antes × depois da migration: contagens de todas as tabelas, somas monetárias e hashes de
   obrigações, pagamentos, ajustes, eventos financeiros (7), auditoria (27), trocas de titular,
   tarefas e planos **idênticos**; única diferença: `labor_reviews=2` (as duas ambiguidades,
   ABERTAS; a da troca ligada ao registro da troca). Totais: 4 obrigações, combinado 310.000,
   ajustes 5.000, pago 90.000.
2. Rollback → `pg_dump -s` idêntico ao original (exceto o token aleatório `\restrict` do
   pg_dump) e dados idênticos; reaplicação ok.
3. Código da Fase 5 sobre os dados migrados: revisões travam pagamento; resolução concilia
   (OS do sofá: 130.000 antes e depois; OS inteira: 125.000 antes e depois); controle intacto.
4. Rollback após resolução que deixou dois profissionais na mesma peça: **recusado e atômico**
   (índice da Fase 11 não recria) — banco inalterado. Documentado no script.
5. Backup/restauração: `scripts/test-backup-restore.sh` ✔; além disso, dump/restauração do banco
   legado migrado e resolvido em banco separado: fotografia, hash das revisões e vínculos iguais;
   gatilho de imutabilidade ativo após restaurar.

## 7. Compatibilidade

Planos por horário (LEGADO), fila semanal, geração automática e distribuição (Fases 2–3), tablet
(Fase 4), qualidade, logística e financeiro da Fase 11 seguem pelas suítes existentes. Mudanças
visíveis: rótulos de situação no financeiro; “Meus valores” no tablet pede PIN; valor por peça
só para o titular; valor da OS inteira recusado quando há titulares diferentes.

## 8. Segurança e privacidade

Nenhum acesso cruzado encontrado (testes #4, #5 e E2E). Tablet não mostra dinheiro sem o PIN
redigitado; respostas sem cache; WS sem eventos financeiros para tablets; PIN redigido nos logs;
exportações exigem `financeiro.ver`.

## 9. Desempenho medido (60 OS, 120 valores, 30 pagamentos, 20 revisões; 20 execuções)

| Consulta                                   | p50 antes da otimização | p50 / p95 final |
| ------------------------------------------ | ----------------------- | --------------- |
| `GET /finance/labor` (todas)               | 504 ms                  | 114 / 149 ms    |
| `GET /finance/service-orders/:id/labor`    | 26 ms                   | 26 / 34 ms      |
| `GET /finance/labor-reviews?status=ABERTA` | 23 ms                   | 24 / 29 ms      |
| `GET /finance/labor-weekly` (90 dias)      | 379 ms                  | 26 / 30 ms      |
| `POST /finance/my-production/unlock`       | 152 ms                  | 37 / 43 ms      |

## 10. Pendências e riscos

- Fechamento semanal (Fase 7) não implementado; só os dados/contrato (`/finance/labor-weekly`).
- Liberação não é revertida automaticamente quando a peça volta para correção **depois** de
  liberada (regra da Fase 12: o gestor revisa e ajusta com justificativa).
- Fuso de `labor-weekly` fixo em America/Sao_Paulo (sem horário de verão desde 2019).
- Validação física em Safari/WebKit dos tablets segue pendente (como na Fase 4).
- Teste de medições dependente do dia da semana (pré-existente) — tarefa separada sugerida.

## 11. Rollback

Aplicação parada + backup recente → `psql -f packages/db/rollback/20261101000000_mao_de_obra_revisao.down.sql`
e código `581e03e`. Perdem-se as revisões; obrigações/ajustes/pagamentos das resoluções
permanecem. Se alguma resolução deixou dois profissionais na mesma peça, o script é recusado
inteiro (não reverter sem decisão do gestor).

## 12. GO/NO-GO

**GO técnico** para a Fase 5: CA5-01 a CA5-16 aprovados com evidência executada; sem acesso
cruzado, pagamento acima do devido, alteração silenciosa, duplicação, perda de dados ou falha de
restauração. Ressalva única: falha pré-existente e alheia (medições, dependente do dia) na
regressão. **Não autoriza deploy.** Aguardando autorização explícita para a Fase 6.
