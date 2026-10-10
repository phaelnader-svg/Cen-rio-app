# Matriz de rastreabilidade — Evolução, Fases 1–7 (verificada no código, HEAD `e72e386`)

Verificação: grep/leitura do código real; cada teste citado foi localizado pelo título.
Siglas: `api/` = `apps/api/test/`, `shr/` = `packages/shared/test/`, `e2e/` = `tests/e2e/specs/`,
`src/` = `apps/api/src/modules/`. Contagens conferidas no HEAD inicial: API 364 `it` em 41 arquivos
(359 + 5 de desempenho sob demanda), shared 77, E2E 27.

Status “Exec.” = evidência executável no repositório; “Manual” = evidência de execução registrada
em relatório, mas com scripts fora do repositório; “Insp.” = só documento/inspeção. A coluna
“Fase 8” diz como a Fase 8 tratou a lacuna.

## Fase 1 — auditoria (documento)

| ID         | Requisito                                    | Evidência                                                     | Status | Fase 8                                   |
| ---------- | -------------------------------------------- | ------------------------------------------------------------- | ------ | ---------------------------------------- |
| CA1-01     | Inventário e fontes de verdade               | doc §3, §5                                                    | Insp.  | —                                        |
| CA1-02     | Horário/dependências/continuidade            | `api/production.test.ts` “material completo: corte liberado…” | Exec.  | —                                        |
| CA1-03..04 | Propostas de fila e atribuição               | doc §6–8                                                      | Insp.  | implementadas nas Fases 2–3 (ver abaixo) |
| CA1-05     | Permissões sem vazamento                     | `api/finance.test.ts` #17/#18, `api/security-audit.test.ts`   | Exec.  | —                                        |
| CA1-06..10 | Financeiro, migração, plano, riscos, sem op. | doc                                                           | Insp.  | divergências do plano listadas abaixo    |

## Fase 2 — fila semanal

Implementação: migration `20261018000000_fila_semanal` (índice `production_tasks_one_active_per_assignee`,
gatilho `production_plans_mode_immutable`), `src/production/queue.ts` (`/production-tasks/mine/queue`,
`/production-queue/:userId`, `PUT /production-plans/:id/queue`, `POST …/carry-over`), `core/clock.ts`,
`assertSingleActive` (`src/production/tasks.ts`).

| ID        | Requisito                                      | Teste (arquivo — título)                                               | Status           | Fase 8                                      |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------- | ------------------------------------------- |
| CA2-01    | Legado: horário futuro recusado                | `api/queue.test.ts` “horário futuro/ausente segue impedindo o início…” | Exec.            | cenário integrado 3                         |
| CA2-02    | 40+ tarefas sem horário                        | `api/queue.test.ts` “CA2-02: padrão da API é fila; 42 tarefas…”        | Exec.            | —                                           |
| CA2-03/04 | Dependências/materiais; início explícito       | “CA2-03/04…”, `e2e/team-queue.spec.ts`                                 | Exec.            | cenário 4/5                                 |
| CA2-05    | Segunda → terça sem duplicar                   | “CA2-05: 20 tarefas, 4 concluídas na segunda…” + E2E                   | Exec.            | cenário 4                                   |
| CA2-06/07 | Próxima executável; desbloqueio não interrompe | “CA2-06/07…”                                                           | Exec.            | cenário 5                                   |
| CA2-08    | Uma principal ativa (concorrência)             | “CA2-08: inícios concorrentes…”                                        | Exec.            | cenário 6                                   |
| CA2-09    | Reordenação com motivo/versão                  | “CA2-09…”, “CA2-09b…”                                                  | Exec.            | cenário 7                                   |
| CA2-10/13 | Semana encerrada; idempotência                 | “CA2-10/13…”, “CA2-13: duplo clique…”                                  | Exec.            | cenário 10                                  |
| CA2-11    | Migration preserva dados                       | relatório (fotografia manual)                                          | Manual           | **migração encadeada versionada (seção 8)** |
| CA2-12/15 | Sem regressão; isolamento LEGADO×FILA          | regressão agregada                                                     | Exec. (indireta) | cenário 3                                   |
| CA2-14    | Sem valores financeiros na fila/WS             | “CA2-14: acesso cruzado e nenhum valor financeiro…”                    | Exec.            | —                                           |

## Fase 3 — distribuição automática

Implementação: migration `20261025000000_distribuicao_automatica` (índice `production_tasks_generated_step_unique`,
gatilho `production_tasks_upholsterer_check`), `src/production/distribution.ts` (`distributeServiceOrder`,
`PUT /service-order-items/:id/upholsterer`, `…/distribute`, `/production/distribution-settings`),
`shared/distribution-domain.ts`.

| ID           | Requisito                                    | Teste                                                                       | Status | Fase 8       |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------------- | ------ | ------------ |
| CA3-01/02/04 | Titular por peça; tapeçaria inteira; geração | `api/distribution.test.ts` “CA3-01/02/04…”, `e2e/team-distribution.spec.ts` | Exec.  | cenários 1–2 |
| CA3-03/07    | João/Thiago; pendências seguras              | “CA3-07/03…”, `shr/distribution.test.ts`                                    | Exec.  | cenário 2    |
| CA3-05       | Idempotência (reprocessar, concorrência)     | “CA3-05…”, “CA3-05b…”                                                       | Exec.  | cenário 9    |
| CA3-06/12    | Dependências; reconexão                      | “CA3-06/12…”, “CA3-12: reconexão…”                                          | Exec.  | —            |
| CA3-08/09/13 | Substituição auditada; financeiro; modelo    | “CA3-08/09/13…”, “CA3-13b…”                                                 | Exec.  | cenário 8    |
| CA3-10       | Legado preservado                            | “CA3-10…”                                                                   | Exec.  | —            |
| CA3-11       | Permissões                                   | “CA3-11…”                                                                   | Exec.  | —            |
| CA3-14       | Integridade/rollback                         | relatório (manual)                                                          | Manual | **seção 8**  |
| CA3-15       | Desempenho                                   | `api/distribution-perf.test.ts` (sob demanda)                               | Exec.  | reexecutado  |

## Fase 4 — tablet “Minha semana” (sem migration)

| ID             | Requisito                                        | Teste                                                                                          | Status              | Fase 8                      |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------- | --------------------------- |
| CA4-01..04, 10 | Semana, destaque, três próximas, titular × apoio | `api/tablet-week.test.ts` “CA4-01/02/04/10…”, `shr/week-view.test.ts`, `e2e/team-week.spec.ts` | Exec.               | —                           |
| CA4-05..09     | Bloqueio explicado; continuidade                 | “CA4-05/06/07/08/09…”                                                                          | Exec.               | —                           |
| CA4-11/12      | Reordenação em tempo real; proibições            | “CA4-11/12…” + E2E offline                                                                     | Exec.               | —                           |
| CA4-13         | Sem valores no tablet                            | “CA4-13…”                                                                                      | Exec.               | segurança (nome do cliente) |
| CA4-14         | Layout/acessibilidade                            | `e2e/team-week.spec.ts`, `e2e/zz-visual-audit.spec.ts`                                         | Exec. (só Chromium) | WebKit (seção 7)            |
| CA4-15/16      | Regressão e backup                               | regressão agregada                                                                             | Exec. (indireta)    | —                           |

Observação: a rota `/mine/queue/all` prevista na Fase 1 não existe (paginação no cliente, `pageOf`).

## Fase 5 — mão de obra por peça

Implementação: migration `20261101000000_mao_de_obra_revisao`, `src/finance/labor-review.ts`
(`editLaborAgreed`, `resolveLaborReview`, `laborWeekly`, `/finance/my-production/unlock`),
`src/finance/labor.ts` (`createLabor`, `assertNoReview`), `src/finance/routes.ts` (`/my-production` recusa DEVICE).

| ID         | Requisito                                  | Teste                                                                        | Status  | Fase 8                  |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------- | ------- | ----------------------- |
| CA5-01..04 | Valor por peça; legado; edição auditada    | `api/labor.test.ts` #1–#3, `e2e/team-labor.spec.ts`                          | Exec.   | —                       |
| CA5-05/06  | Só os próprios valores; PIN; sem vazamento | #4, #5                                                                       | Exec.   | segurança (seção 11)    |
| CA5-07/08  | Concluir não paga; liberação por evento    | #6, #6b, `api/finance.test.ts` #8                                            | Exec.   | —                       |
| CA5-09/10  | Parcial; concorrência                      | #7, #8                                                                       | Exec.   | —                       |
| CA5-11..13 | Substituição → revisão; resolução          | #9, #10, `shr/labor-review.test.ts`                                          | Exec.   | cenário 8               |
| CA5-14     | Regressão                                  | 333/334 (falha de medições, diagnóstico errado na época)                     | Exec.\* | corrigido na Fase 7     |
| CA5-15     | Migração/rollback                          | manual; recusa depende de índice único em BEGIN/COMMIT (sem RAISE explícito) | Manual  | **seção 8**             |
| CA5-16     | Totais semanais                            | #11                                                                          | Exec.   | fuso corrigido (Fase 8) |

## Fase 6 — custos de logística

Implementação: migration `20261108000000_custos_logistica` (rollback com RAISE), `src/finance/trip-costs.ts`
(`/logistics-defaults`, `/trip-costs`, `/trip-costs/fee`, ajustes, `/constitute`, estorno, `/logistics-weekly`),
ganchos `syncTripCost`/`syncPickupCostsOfOrder`.

| ID         | Requisito                                               | Teste (`api/logistics-costs.test.ts`)                        | Status  | Fase 8              |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------ | ------- | ------------------- |
| CA6-01..04 | Padrões; valor total; recebedor único; validação        | #1–#3, `shr/trip-cost.test.ts`, `e2e/team-logistics.spec.ts` | Exec.   | —                   |
| CA6-05..08 | Devido só na realização; cancelar; frustrada; reagendar | #4–#7, #15                                                   | Exec.   | —                   |
| CA6-09/10  | Rateio exato e por revisão                              | #8, #9                                                       | Exec.   | —                   |
| CA6-11/12  | Pagamentos; ajuste; estorno                             | #10, #11                                                     | Exec.   | —                   |
| CA6-13     | Segurança                                               | #13                                                          | Exec.   | —                   |
| CA6-14     | Migração                                                | manual                                                       | Manual  | **seção 8**         |
| CA6-15     | Semana do fato gerador                                  | #14                                                          | Exec.   | —                   |
| CA6-16     | Fluxo completo/regressão                                | E2E + regressão com 1 falha (medições)                       | Exec.\* | corrigido na Fase 7 |
| (C2)       | Recebedor ausente                                       | #12 (fora da matriz CA6)                                     | Exec.   | —                   |

## Fase 7 — fechamento semanal

Implementação: migration `20261115000000_fechamento_semanal` (CHECK segunda-feira, gatilhos de imutabilidade,
rollback com RAISE), `src/finance/closing.ts`, `shared/closing-domain.ts`, `apps/web/components/finance/weekly-closing.tsx`.

| ID                 | Requisito                                        | Teste (`api/closing.test.ts`)                           | Status              | Fase 8                           |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------- | ------------------- | -------------------------------- |
| CA7-01..03, 06, 09 | Tela única, filtros, rastreável, André, R$ 8.100 | #1, `shr/closing.test.ts`, `e2e/team-closing.spec.ts`   | Exec.               | cenário financeiro integrado     |
| CA7-02, 05, 10, 11 | Previsto; retrabalho; Pix R$ 600; idempotência   | #2                                                      | Exec.               | idem                             |
| CA7-04             | Revisão aberta trava; resolvida preserva         | #4                                                      | Exec.               | —                                |
| CA7-07, 08         | Multi-OS; estados; gratuita                      | #3                                                      | Exec.               | —                                |
| CA7-12, 13         | Saldo anterior; conferência/estorno              | #5, #6                                                  | Exec.               | —                                |
| CA7-14             | Segurança                                        | #7                                                      | Exec.               | —                                |
| CA7-15             | Responsivo                                       | E2E + capturas                                          | Exec. (só Chromium) | WebKit                           |
| CA7-16             | Migração/rollback/backup                         | manual; `test-backup-restore.sh` sem as tabelas novas   | Manual              | **seção 8–9 (script corrigido)** |
| CA7-17, 18         | Regressão; desempenho                            | regressão, `api/closing-perf.test.ts` (sob demanda), #8 | Exec.               | reexecutado                      |

## Divergências documentação × implementação encontradas

1. **−3 h fixo** previsto para correção na Fase 2 (Fase 1 §12) **nunca foi corrigido**; foi adiado
   de relatório em relatório e **sumiu do relatório da Fase 7** sem resolução. O mesmo deslocamento
   existe também em `finance/common.ts` `period()` (limites de todos os relatórios financeiros), não
   citado em nenhum relatório. → **Corrigido na Fase 8** (causa raiz: fuso configurado).
2. Rota `/mine/queue/all` e evento `production.queue.reordered` (Fase 1) não existem; a paginação é
   no cliente e o evento real é `production.queue_reordered`.
3. Tabela `activity_assignment_rules` (Fase 1) substituída por `step_class` (Fase 3).
4. Estorno de pagamento ao profissional, previsto para a Fase 5, só existe a partir da Fase 7.
5. Conta a pagar semanal consolidada (Fase 1) substituída por visão calculada (Fase 7, D-1, documentado).
6. Linhas citadas deslocadas por commits posteriores (`results.ts:381,385` → `:392,:396` etc.).
7. Rollback da Fase 5: a recusa é implícita (falha de índice único dentro de BEGIN/COMMIT), não um
   RAISE explícito como nas Fases 6–7.
8. Evidência de migração das Fases 2, 3, 5, 6 e 7 dependia de scripts fora do repositório.
9. CA5-14 e CA6-16 aprovados com a falha de medições, diagnosticada erradamente como dia da semana
   (causa real: fuso; corrigida na Fase 7).
