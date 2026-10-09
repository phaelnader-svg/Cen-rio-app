# Evolução, Fase 3 de 8 — Distribuição automática de tarefas por OS e peça

Ambiente exclusivamente local (PostgreSQL 16 em contêiner, dados sintéticos). Sem deploy, sem
Google Cloud/DNS/VM/Cloud Build, sem migrations remotas, sem dados reais, sem VerificaPro, sem
pagamentos, rateio de mão de obra ou fechamento logístico. A Fase 4 **não** foi iniciada.

## 1. Branch, SHA, worktree e commits

| Item                                   | Valor                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Branch                                 | `claude/cenario-gestao-fase-1-zf3bj2`                                                  |
| SHA inicial (fim da Fase 2, conferido) | `89a3f58`                                                                              |
| SHA final                              | ver seção 13 do resumo de entrega (último commit desta fase)                           |
| Worktree                               | `/home/user/Cen-rio-app`; worktree temporária de `89a3f58` só para gerar dados legados |
| Migrations no banco local de teste     | 13 antes; 14 depois (`20261025000000_distribuicao_automatica`)                         |

Commits desta fase (do mais antigo ao mais novo): `d317008` Evolução Fase 3: migration aditiva de distribuição (titular por peça, classe da etapa); `954d3a5` Evolução Fase 3: domínio e contratos da distribuição automática; `4748f5a` Evolução Fase 3: serviço de distribuição automática na API; `3b93a59` Evolução Fase 3: testes de distribuição automática (CA3-01..CA3-13); `3ddc009` Evolução Fase 3: painel mínimo de distribuição por peça; `c2dfb39` Evolução Fase 3: E2E da distribuição automática (painel + tablet); `f0be8a1` Evolução Fase 3: não gerar por cima de tarefas anteriores; script de reversão; `6262488` Evolução Fase 3: teste de desempenho da distribuição (DIST_PERF=1); `fe9c965` Evolução Fase 3: testes da classificação de etapas; formatação; e o commit deste relatório.

## 2. Inventário reaproveitado (arquivo:linha, antes das mudanças)

| Entidade / fluxo                                                                              | Onde                                                                                                                                  | Papel na Fase 3                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ServiceOrderItem` (peça, posição, tipo, serviço)                                             | `schema.prisma` `model ServiceOrderItem`                                                                                              | Recebe o titular (`upholsterer_user_id`)                                             |
| `ProductionPlanItem.principalUserId` (titular por OS/semana)                                  | `schema.prisma` `model ProductionPlanItem`; `plans.ts` addItem (`assertPrincipal`, `plans.ts:415`)                                    | Legado: continua valendo no LEGADO; na fila vira **proposta** para peças sem titular |
| Modelos e etapas (`ProductionTemplate/Step`, `role` PRINCIPAL/APOIO, `dependsOn` por posição) | `schema.prisma`; `plans.ts:518` `saveTemplate` (apaga e recria etapas, `version++`)                                                   | Etapas ganham `step_class`; tarefas guardam modelo/versão/posição                    |
| Geração antiga                                                                                | `plans.ts:356` `generateTasks`                                                                                                        | Mantida para LEGADO; fila usa `distributeServiceOrder`                               |
| Regra "corte/costura do principal"                                                            | `tasks.ts:124` `assertPrincipalRule`, `PRINCIPAL_ACTIVITIES`                                                                          | Mantida; na fila soma-se `assertUpholstererRule`                                     |
| Trabalhadores e tapeceiros                                                                    | `plans.ts:54` `workers` (`isTapeceiro` pela função `tapeceiro`)                                                                       | Elegibilidade do titular                                                             |
| Competências (`EmployeeSkill`, `SKILLS`, `DEFAULT_ROLE_SKILLS`)                               | `help-domain.ts:37,84`; `help/reschedule.ts:50` `ACTIVITY_SKILL`                                                                      | Elegibilidade do responsável padrão da preparação                                    |
| Inspetor e segregação                                                                         | `quality/common.ts:229` `mainInspector`, `:263` `chooseInspector`, `:189` `executorsOf`; `company_settings.quality_inspector_user_id` | Só leitura (prévia do inspetor); regra de qualidade intocada                         |
| Mão de obra por peça (direito financeiro)                                                     | `finance/labor.ts:149` `createLabor` (`production_payables.professional_user_id`, um por peça)                                        | **Separado** do titular operacional; só sinaliza revisão                             |
| Publicação, revisões, liberação, fila                                                         | `plans.ts` publish, `reviseIfPublishedBy` (`plans.ts:121`), `common.ts reevaluateTasks`, `queue.ts` (Fase 2)                          | Reaproveitados sem alteração de regra                                                |

Conflito com o desenho da Fase 1 documentado: a Fase 1 previa o titular por OS/semana; o código
já tinha `production_payables` por peça. A fonte de verdade operacional passa a ser a **peça**;
o campo por OS/semana fica como compatibilidade.

## 3. Decisões de arquitetura e regras por competência

- **Somente planos FILA_SEMANAL** recebem distribuição automática. LEGADO mantém a geração e as
  regras anteriores (decisão conservadora: sem conversão silenciosa).
- **Classe explícita da etapa** (`step_class`: PREPARACAO, TAPECARIA, OUTRA), versão 1 da tabela
  em `packages/shared/src/distribution-domain.ts`. Classificação automática só quando atividade
  e papel concordam; combinação ambígua fica nula e vira pendência, nunca atribuição.
- **TAPECARIA** → titular da peça (nunca outro tapeceiro por disponibilidade, fila ou ausência).
- **PREPARACAO** → responsável padrão configurável (`company_settings.preparation_assignee_user_id`)
  se elegível (ativo, `producao.executar`, competência da atividade); sem configuração, o **único**
  ajudante (função `ajudante`) elegível; zero ou vários → pendência.
- **OUTRA** → sem responsável automático (gestor define).
- **Inspeção** não é etapa de modelo: segue o módulo de qualidade (inspetor padrão/competência e
  bloqueio de quem executou). A distribuição só mostra o inspetor previsto ou a pendência.
- Nenhum nome ou ID codificado: tudo por função, competência e configuração.

## 4. Titular por peça e compatibilidade

- Fonte de verdade: `service_order_items.upholsterer_user_id` (uma coluna ⇒ no máximo um titular,
  também para OS de uma peça só). Histórico imutável em `service_order_item_owner_changes`
  (DEFINICAO/SUBSTITUICAO, motivo, tarefas movidas, sinal de revisão financeira, autor, data).
- Gatilho `production_tasks_upholsterer_check`: tarefa TAPECARIA de peça com titular só pode ser
  gravada para o titular (ou sem responsável). API valida antes com mensagem clara.
- Ordem de resolução na inclusão da OS (fila): titular escolhido para a peça > titular já
  definido > responsável principal da OS como proposta > pendência `SEM_TITULAR`.
- Compatibilidade: dados antigos não ganham titular (sem backfill); planos LEGADO não gravam
  titular; no plano em fila, trocar o "principal da OS" é recusado (usar titular por peça).

## 5. Algoritmo de geração e idempotência

`distributeServiceOrder` (`apps/api/src/modules/production/distribution.ts`), por peça, numa
transação com a trava do plano e das peças (`FOR UPDATE` ordenado):

1. resolve o titular (seção 4); modelo = escolhido para a peça ou o primeiro ativo do tipo;
2. se a peça já tem tarefas geradas em **outra** semana → não gera (`JA_GERADA_EM_OUTRA_SEMANA`);
3. se a peça tem tarefas **sem marcador de geração** (Fase 2, legado ou avulsas) → não gera
   (`TAREFAS_ANTERIORES`) — encontrado ao migrar dados reais da Fase 2;
4. se o modelo mudou desde a geração → não mexe (`MODELO_ALTERADO`), salvo `regenerate` com motivo
   **e** nada iniciado: antigas canceladas (ou apagadas, se rascunho) e novas geradas;
5. para cada etapa: se já existe (chave peça + modelo + posição) só preenche responsável **vazio**
   de tarefa não iniciada; senão cria com responsável pela classe, dependências pelo DAG do modelo
   (etapas opcionais puladas em fabricação repassam as dependências).

Garantias: índice único parcial `production_tasks_generated_step_unique (item, template_id,
posição) WHERE template_id IS NOT NULL AND status <> 'CANCELADA'`; plano único por OS
(`@@unique([planId, serviceOrderId])` + trava do plano); rotas com `Idempotency-Key`.
Nunca troca um responsável já gravado.

## 6. Dependências, publicação e fila

Gerar não libera: em rascunho as tarefas nascem `RASCUNHO`; em plano publicado nascem
`BLOQUEADA` e passam pela reavaliação normal (publicado, responsável, peça, dependências,
materiais, ocorrência, bloqueio). A liberação, a ordem da fila, a única principal ativa e o
início explícito são os da Fase 2, sem alteração. Ajuda (apoio) não tem classe e não transfere
titularidade nem pagamento.

## 7. Substituição e proteção financeira

`PUT /api/v1/service-order-items/:id/upholsterer` (`producao.planejar`, sessão web):

- CAS pelo titular exibido (`expectedUserId`; divergência = 409);
- definição (primeira vez): direta; substituição: motivo ≥ 3 + `confirm: true`;
- recusa se houver etapa de tapeçaria **em execução ou pausada** (registro de execução nunca muda
  de dono); concluídas e canceladas ficam como estão; pendentes passam ao novo titular com evento
  `RESPONSAVEL_ALTERADO`, aviso a quem saiu, revisão do plano publicado e auditoria;
- financeiro: nenhuma alteração. Se houver mão de obra combinada (peça ou OS) com outra pessoa,
  grava `financial_review_required` e a pendência `REVISAO_FINANCEIRA` para a Fase 5.

## 8. Migration e rollback

`packages/db/prisma/migrations/20261025000000_distribuicao_automatica` (aditiva; nenhuma
migration anterior editada): enum `step_class`; colunas `production_template_steps.step_class`
(backfill concordante), `production_tasks.{step_class, template_id, template_version,
template_step_position}`, `service_order_items.upholsterer_user_id` (FK RESTRICT),
`company_settings.preparation_assignee_user_id`; tabela imutável de titularidade; índice
único parcial; gatilhos. `prisma migrate diff` contra o schema: sem diferença.

Reversão manual: `packages/db/rollback/20261025000000_distribuicao_automatica.down.sql`
(backup + aplicação parada + código `89a3f58`). Testada (seção 11).

## 9. APIs, permissões, eventos e interface

| Rota                                                              | Acesso                | Função                                                                                     |
| ----------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `POST /api/v1/production-plans/:id/items` (existente)             | planejar              | Em fila aceita `pieces[{serviceOrderItemId, upholstererUserId?, templateId?}]` e distribui |
| `GET /api/v1/production-plans/:id/distribution`                   | ver (web)             | Por peça: titular, modelo, tarefas/responsáveis, inspetor, pendências, histórico           |
| `POST /api/v1/production-plans/:id/items/:itemId/distribute`      | planejar, idempotente | Reprocessa (completa o que falta; `regenerate` com motivo)                                 |
| `PUT /api/v1/service-order-items/:id/upholsterer`                 | planejar, idempotente | Define/substitui titular                                                                   |
| `GET/PUT /api/v1/production/distribution-settings`                | ver / planejar        | Responsável padrão da preparação                                                           |
| `PUT /api/v1/production-tasks/:id`, `POST .../tasks` (existentes) | planejar              | Recusam tapeçaria fora do titular; avulsa de tapeçaria vai sozinha ao titular              |
| `PUT /api/v1/production-plans/:id/items/:itemId` (existente)      | planejar              | Em fila: troca de principal recusada; prioridade não mexe em responsáveis                  |

Eventos: `production.distribution_updated` (gestão) e `production.piece_owner_changed`
(gestão + titular anterior e novo), só com identificadores; atribuições pelos eventos existentes.
Interface (painel): titular por peça ao incluir a OS, seção "Distribuição por peça" com
reprocessar, pendências, histórico e diálogo de substituição (motivo + confirmação); classe da
etapa no editor de modelos. Tablet sem mudança (Fase 4).

## 10. Matriz CA3

| CA                            | Status   | Evidência                                                                                                                                                                         |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA3-01 Titular único          | APROVADO | `distribution.test` CA3-01: tapeçaria de A só Ricardo, de B só Márcio; `UPDATE` direto recusado pelo gatilho; API 422                                                             |
| CA3-02 Múltiplas peças        | APROVADO | OS com dois sofás, atribuições independentes; substituição de A não toca B                                                                                                        |
| CA3-03 João e Thiago          | APROVADO | Preparação/desmontagem ao João (único ajudante elegível); inspetor previsto Thiago; qualidade intocada (suítes de qualidade aprovadas)                                            |
| CA3-04 Geração automática     | APROVADO | 12 tarefas completas para 2 peças sem nenhuma atribuição manual; E2E pela tela                                                                                                    |
| CA3-05 Idempotência           | APROVADO | reprocessar 1× + 2× concorrente: linhas idênticas; inclusão concorrente 201/409; outra semana não duplica; índice único recusa duplicata; tarefas anteriores protegidas (CA3-05b) |
| CA3-06 Dependências           | APROVADO | rascunho não inicia (422); publicado: DEPENDENCIAS/MATERIAIS; concluir libera sem iniciar                                                                                         |
| CA3-07 Pendências seguras     | APROVADO | sem titular, sem competência (preparação configurada para tapeceiro) e etapa ambígua: nada atribuído, `SEM_RESPONSAVEL` após publicar, pendências no painel                       |
| CA3-08 Substituição auditada  | APROVADO | 403 funcionário, 400 sem motivo, 422 sem confirmação/etapa em execução, 409 CAS; concluída mantém executor; auditoria; histórico imutável                                         |
| CA3-09 Financeiro preservado  | APROVADO | `production_payables` idêntico após substituição/reprocessamento; `REVISAO_FINANCEIRA` sinalizada; somas de valores idênticas na migração                                         |
| CA3-10 Legado preservado      | APROVADO | plano LEGADO gera como antes (sem classe/titular); regra antiga do sofá mantida; dados da Fase 2 migrados idênticos; fila da Fase 2 não duplicada                                 |
| CA3-11 Permissões             | APROVADO | tablet 403 em distribuição, reprocessar, titular e configuração; WS sem valores                                                                                                   |
| CA3-12 Fila e concorrência    | APROVADO | filas de João/Ricardo corretas; segunda principal 409; reconexão recupera `piece_owner_changed` e a fila atualizada                                                               |
| CA3-13 Edição após execução   | APROVADO | modelo alterado: peça com execução intocada + pendência; peça sem execução regenerada com motivo (antigas canceladas, histórico mantido); rascunho regenerado                     |
| CA3-14 Integridade e rollback | APROVADO | seção 11 (fotografia idêntica, reversão idêntica, backup/restauração)                                                                                                             |
| CA3-15 Regressão e desempenho | APROVADO | seções 11 e 12                                                                                                                                                                    |

## 11. Testes executados (contagens reais)

| Teste                                     | Comando                                                                                                                                                                                                                                                                                                                                                                  | Resultado                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribuição (CA3)                        | `cd apps/api && npx vitest run test/distribution.test.ts`                                                                                                                                                                                                                                                                                                                | 10/10                                                                                                                                             |
| Regressão completa API                    | `cd apps/api && npx vitest run`                                                                                                                                                                                                                                                                                                                                          | 319 aprovados, 2 ignorados (testes de desempenho opcionais), 0 falhas — 34 arquivos, 733 s                                                        |
| Domínio compartilhado                     | `cd packages/shared && npx vitest run`                                                                                                                                                                                                                                                                                                                                   | 63/63 (10 arquivos)                                                                                                                               |
| Web unitários                             | `cd apps/web && npx vitest run`                                                                                                                                                                                                                                                                                                                                          | 6/6                                                                                                                                               |
| E2E distribuição + fila + produção legada | `npx playwright test specs/team-distribution.spec.ts specs/team-queue.spec.ts specs/production.spec.ts`                                                                                                                                                                                                                                                                  | 3/3                                                                                                                                               |
| E2E completo                              | `cd tests/e2e && npx playwright test`                                                                                                                                                                                                                                                                                                                                    | 23/23 (7,6 min)                                                                                                                                   |
| Formatação, lint, typecheck               | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                                                                                                                                                                                                                                                                                                                       | sem apontamentos                                                                                                                                  |
| Build web                                 | `pnpm --filter @cenario/e2e build:web`                                                                                                                                                                                                                                                                                                                                   | compilado                                                                                                                                         |
| Migração com dados legados                | fixture pelo código `89a3f58` (fluxo de 32 passos + LEGADO com execução/pausa/bloqueio/horário futuro + FILA da Fase 2 publicada + mão de obra + rascunho) → `migrate deploy` → fotografia (134 linhas: contagens, 22 colunas de valores, hashes de tarefas, eventos, planos, revisões, dependências, auditoria, peças, mão de obra, pagamentos, etapas, itens do plano) | **idêntica** (só a tabela nova, vazia); 36 tarefas sem classe/marcador; 8 peças sem titular; 17 etapas classificadas, 0 ambíguas                  |
| Reversão                                  | script down + `pg_dump -s` + fotografia                                                                                                                                                                                                                                                                                                                                  | esquema idêntico (3 212 linhas); dados idênticos; reaplicação limpa                                                                               |
| Código novo sobre o banco migrado         | verificação pontual                                                                                                                                                                                                                                                                                                                                                      | 3 planos (2 LEGADO, 1 FILA); fila da Fase 2 com `TAREFAS_ANTERIORES`, reprocessar não cria tarefa; mão de obra idêntica; horário futuro ainda 422 |
| Backup/restauração                        | `pnpm test:backup` (banco separado)                                                                                                                                                                                                                                                                                                                                      | verificado (14 migrations; contagens origem = restaurado)                                                                                         |

Falhas encontradas e tratadas: (1) duas expectativas do próprio teste (tarefa escolhida estava
bloqueada; peça sem execução foi corretamente regenerada); (2) E2E: seção da fila some quando
vazia; (3) **defeito real** — reprocessar uma OS gerada pela Fase 2 duplicaria tarefas: corrigido
com a proteção `TAREFAS_ANTERIORES` e teste CA3-05b; (4) uma execução completa intermediária
teve 1 falha por ter carregado o teste novo junto com o código anterior à correção — a execução
completa final está na tabela.

## 12. Desempenho medido

Contêiner local (4 vCPU, 16 GB), banco separado, painel + 4 tablets por WebSocket. 40 OS de uma
cabeceira, 200 tarefas geradas e atribuídas automaticamente (80 João, 60 Ricardo, 60 Márcio):

| Medida                                                        | Resultado    |
| ------------------------------------------------------------- | ------------ |
| Incluir OS com distribuição (n=40) p50/p95                    | 187 / 275 ms |
| Ler a distribuição do plano (40 OS) p50/p95                   | 353 / 384 ms |
| Reprocessar sem mudança (inclui a releitura) p50/p95          | 406 / 427 ms |
| Publicar 200 tarefas                                          | 3,1 s        |
| Fila dos 4 tablets (80 leituras) p50/p95                      | 51 / 81 ms   |
| Iniciar/concluir (20 ações) com 3 tablets lendo filas p50/p95 | 71 / 201 ms  |

Gargalo identificado: a leitura da distribuição faz consultas por peça e carrega permissões por
funcionário (linear no número de peças); aceitável para 40 OS, candidato a otimização se o
volume crescer. Fila da Fase 2 (medida antes): mesma ordem de grandeza.

## 13. Impacto nos planos antigos e na Fase 2

- LEGADO: nenhuma mudança de regra; titular por peça recusado; geração anterior.
- Fila da Fase 2: liberação, fila, exclusividade, revisão e transferência intactas; OS já geradas
  ficam protegidas (`TAREFAS_ANTERIORES`). Mudança deliberada na fila: trocar o "principal da OS"
  no plano em fila é recusado (titular agora é por peça) e a mudança de prioridade da OS não
  reescreve responsáveis.

## 14. Riscos, pendências e decisões para as Fases 4/5

- **Fase 5 (financeiro):** tratar `financial_review_required`/`REVISAO_FINANCEIRA` (ninguém
  altera valores hoje); decidir rateio em substituições; −3 h fixo de `finance/results.ts`
  continua pendente (Fase 2).
- **Fase 4 (tablet):** exibir titular/peça na fila; o tablet não mudou nesta fase.
- Leitura da distribuição linear por peça (seção 12).
- Peças com tarefas anteriores exigem ajuste manual (decisão conservadora).
- Substituição bloqueada com etapa pausada: o gestor precisa concluir ou cancelar antes.
- Modelos editados apagam e recriam etapas (comportamento anterior); a chave usa
  modelo + versão + posição, por isso a troca de modelo é sempre revisão controlada.

## 15. GO/NO-GO para a Fase 4

| Item                                                        | Situação                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| CA3-01..CA3-15                                              | APROVADO com execução                                                |
| Regressão API / E2E / lint / typecheck / formatação / build | sem falhas                                                           |
| Migração sobre dados da Fase 2 e reversão                   | idênticas                                                            |
| Desempenho 40 OS / 200 tarefas / 4 tablets + gestor         | medido (seção 12)                                                    |
| Pendências                                                  | financeiro (Fase 5), tablet (Fase 4), leitura linear da distribuição |

**GO técnico para iniciar a Fase 4, condicionado à sua autorização explícita** (a Fase 4 não foi
iniciada). Não é GO irrestrito: as pendências da seção 14 seguem abertas e nada foi aplicado
fora do ambiente local; em qualquer ambiente real, aplicar com backup e a aplicação parada.
