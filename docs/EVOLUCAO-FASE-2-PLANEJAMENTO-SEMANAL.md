# Evolução, Fase 2 de 8 — Planejamento semanal contínuo (fila por funcionário)

Ambiente exclusivamente local (PostgreSQL 16 em contêiner, dados sintéticos). Nenhum deploy,
Cloud Build, migration em nuvem, acesso à homologação publicada, dado real ou alteração no
VerificaPro. A Fase 3 **não** foi iniciada.

## 1. Branch, SHA e worktree

| Item               | Valor                                                                            |
| ------------------ | -------------------------------------------------------------------------------- |
| Branch             | `claude/cenario-gestao-fase-1-zf3bj2`                                            |
| Base (Fase 1)      | `839770a`                                                                        |
| Commits desta fase | ver seção 13                                                                     |
| Worktree principal | `/home/user/Cen-rio-app`                                                         |
| Worktree auxiliar  | `839770a` (código anterior) em diretório temporário, só para gerar dados legados |
| Banco              | PostgreSQL 16 local (`127.0.0.1:55432`), bancos `*_test` sintéticos              |

## 2. Diagnóstico e LEGADO × FILA

### 2.1 Onde o horário mandava (auditoria no código real, antes da mudança)

| Ponto                                                       | Papel do horário/semana/ordem                                                                                               |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `shared/production-domain.ts` `evaluateRelease`             | Sem `scheduledAt` ou horário futuro ⇒ `PROGRAMADA`; só `LIBERADA` pode iniciar.                                             |
| `production/common.ts` `reevaluateTasks`, `releaseDueTasks` | Único caminho para `LIBERADA`; o ciclo de 30 s (`app.ts`) libera quem chegou ao horário — usava `new Date()`.               |
| `production/tasks.ts` `execute` (start)                     | Reavalia tudo no início com `new Date()`; recusa "o horário programado ainda não chegou".                                   |
| `production/tasks.ts` POST tarefa / PUT tarefa              | `scheduledFrom(date,time)`; reprogramação gera evento `REPROGRAMADA` e revisão.                                             |
| `production/tasks.ts` `/mine`                               | "Hoje" × "próximos dias" pelo `scheduledAt`; "hoje" calculado com `new Date()`.                                             |
| `production/tasks.ts` quadro                                | Filtro de período por `scheduledAt`.                                                                                        |
| `production/plans.ts` `loadPlan`                            | Conflitos `SEM_HORARIO`, `HORARIO_COINCIDENTE`, `ANTES_DA_DEPENDENCIA`, `APOS_PRAZO`, `FORA_DA_SEMANA` (todos por horário). |
| `production/plans.ts` addItem                               | `date` + início do expediente viram `scheduledAt` de todas as tarefas geradas.                                              |
| `help/reschedule.ts` `suggestAlternative`                   | Impedimento ⇒ indica liberada ou **antecipa** uma `PROGRAMADA` para agora (muda o horário).                                 |
| `help/reschedule.ts` `analyzeAbsence`                       | Redistribuição simples aceitava `'DEPENDENCIAS' \|\| 'HORARIO'` — `HORARIO` não existe (defeito).                           |
| `help/engine.ts`, `issues/service.ts`, `quality/*`          | Apoio, resolução, correção e embalagem nascem com `scheduledAt = new Date()` (liberadas na hora).                           |
| `testing/routes.ts`                                         | Relógio de teste só deslocava presença/ajuda: a liberação de produção ignorava-o (defeito).                                 |
| `finance/results.ts:377-390`                                | Indicador de pontualidade usa `dueDate` ou o dia de `scheduledAt` com −3 h fixo (pendência, seção 9).                       |
| Prioridade/ordem                                            | `priority` + `sequence` + `number`; `compareTasks` ordena status → prioridade → horário → sequência.                        |
| Dependências/materiais/ocorrência/bloqueio/presença         | Independentes do horário; preservados nos dois modos.                                                                       |

### 2.2 Regra por modo

| Regra                                     | LEGADO (planos existentes)                   | FILA_SEMANAL (planos novos)                                                                       |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Horário                                   | Obrigatório; futuro ou ausente impede início | Não existe; data/hora recusadas na criação e na alteração (422)                                   |
| Liberação                                 | Bloqueios + horário                          | Só bloqueios (publicado, responsável, peça, dependências, materiais, ocorrência, bloqueio manual) |
| Ordem                                     | Status → prioridade → horário → sequência    | Semana → prioridade → posição do gestor → sequência → número (determinística)                     |
| Tarefas principais em execução por pessoa | Sem limite (comportamento anterior mantido)  | No máximo 1 (pausada não conta; apoio não conta) — garantido no banco                             |
| Impedimento                               | Indica liberada ou antecipa programada       | Indica a próxima executável da fila; não antecipa nem reordena                                    |
| Virada do dia                             | Libera pelo horário                          | Nada muda: a fila continua de onde parou                                                          |
| Fim da semana                             | —                                            | Pendências visíveis ao gestor; transferência só por ação explícita                                |

O modo é gravado no plano e **não muda** depois de criado (gatilho no banco). Planos
existentes ficaram LEGADO pela migration; a API cria FILA_SEMANAL por padrão (D-1). Nenhum plano
antigo foi convertido.

## 3. Arquitetura, banco, migration e compatibilidade

Migration nova e aditiva `packages/db/prisma/migrations/20261018000000_fila_semanal` (nenhuma
migration anterior foi editada):

- tipo `plan_mode` (`LEGADO`, `FILA_SEMANAL`) e coluna `production_plans.mode NOT NULL DEFAULT 'LEGADO'`
  (preenche os existentes sem reescrever dados);
- `production_tasks.queue_position` (posição do gestor, `CHECK > 0`, nula = ordem natural);
- `production_tasks.carried_from_plan_id` (semana de origem da pendência transferida, FK `RESTRICT`);
- `production_tasks.queue_exclusive` (calculada por gatilho: plano FILA e não é apoio). O valor
  não pode ser forçado pela aplicação: o gatilho recalcula a cada inclusão/troca de plano/apoio;
- índice único parcial `production_tasks_one_active_per_assignee (assignee_user_id) WHERE
status='EM_EXECUCAO' AND queue_exclusive` — D-6 no banco, mesmo sob concorrência ou fora da API;
- índice parcial de leitura da fila (`assignee, plan, priority, queue_position, sequence`, só abertas);
- gatilho `production_plans_mode_immutable`.

Nenhum estado novo de tarefa. Ordem reutiliza `priority` e `sequence`; acrescentado só
`queue_position` + desempate por `number`.

**Compatibilidade:** dados legados recebem `mode=LEGADO`, `queue_exclusive=false`, colunas novas
nulas; por isso o índice único não afeta o legado (que pode ter duas tarefas em execução da mesma
pessoa — caso presente na fixture e preservado). APIs anteriores mantidas; campos novos só
acrescentados aos DTOs.

**Reversão:** `packages/db/rollback/20261018000000_fila_semanal.down.sql` (manual, com backup e
aplicação parada, voltando ao código `839770a`). Testada: esquema e dados voltam idênticos (seção 6).

## 4. Mudanças em API, backend, painel, tablet e WebSocket

**Backend**

- `core/clock.ts`: relógio único (`now()`/`setClock`) usado por presença, liberação, início,
  tarefas imediatas (apoio, resolução, correção, embalagem) e relógio de teste.
- `production/common.ts`: `reevaluateTasks` passa o modo do plano; `releaseDueTasks` usa o relógio.
- `production/tasks.ts`: `execute` usa o relógio e o modo; `assertSingleActive` (advisory lock por
  funcionário + verificação) no iniciar e no retomar; FILA recusa data/hora; quadro inclui tarefas
  FILA pela semana do plano; `/mine` inclui todas as abertas do modo fila.
- `production/plans.ts`: criação com `mode`; addItem sem data em FILA; `loadPlan` devolve `mode`,
  `weekEnded`, `pendingCount` e não gera avisos de horário em FILA; snapshot com `queuePosition`.
- `production/queue.ts` (novo):
  - `GET /api/v1/production-tasks/mine/queue` — fila do próprio funcionário (`current`, `next`,
    `blockedAhead`, `items[{position, executable, task}]`);
  - `GET /api/v1/production-queue/:userId` — gestão (sessão web, `producao.ver`/`planejar`);
  - `PUT /api/v1/production-plans/:id/queue` — reordena a fila de um funcionário (lista completa,
    versão do plano/CAS, motivo e nova revisão se publicado, evento `FILA_REORDENADA` por tarefa,
    auditoria, evento `production.queue_reordered`); `Idempotency-Key`;
  - `POST /api/v1/production-plans/:id/carry-over` — pendências de semana encerrada para outra
    semana FILA publicada posterior; idempotente; mantém responsável/andamento/histórico; evento
    `TRANSFERIDA_SEMANA`, revisões nas duas semanas, auditoria, `production.tasks_carried`.
- `help/reschedule.ts`: `onlyReassignableBlockers` (corrige `HORARIO`); no modo fila indica a
  próxima da fila sem antecipar; usa o relógio.
- `testing/routes.ts`: `/api/test/attendance/check` também executa `releaseDueTasks`.

**Painel** (`components/production/planning-page.tsx`): seletor de modo (fila por padrão), selo do
modo, sem colunas Dia/Hora em FILA, seção "Filas da semana" por funcionário com progresso e
subir/descer (motivo obrigatório se publicado), aviso de semana encerrada com pendências e
diálogo de transferência. Rótulos novos no histórico da tarefa.

**Tablet** (`components/tablet/tasks.tsx`): "Minha fila da semana" com posição, cartão de
"Próxima da fila" e botões Iniciar/Concluir já existentes; nada inicia sozinho.

**WebSocket:** eventos novos com público restrito (gestão + funcionário afetado) e carga só com
identificadores; o web invalida `my-queue` e `production-queue` em qualquer `production.*`.

## 5. Máquina de estados, ordem, bloqueios, ajuda e concorrência

- Estados inalterados. Em FILA: `RASCUNHO → (publicação) → BLOQUEADA/LIBERADA → EM_EXECUCAO ⇄
PAUSADA → CONCLUIDA`, `CANCELADA` como antes. `PROGRAMADA` não ocorre em FILA.
- **Próxima executável** = primeira da ordem da fila que está `LIBERADA` ou `PAUSADA` sem
  ocorrência que a impeça. Bloqueada mantém a posição (`executable=false`); nada é regravado.
- **Desbloqueio** (gestor, materiais, ocorrência resolvida) só reavalia a tarefa desbloqueada;
  a que está em execução não muda. Iniciar a desbloqueada enquanto há outra ativa ⇒ 409.
- **Início explícito**: concluir libera dependentes e devolve a próxima, mas nunca muda o estado
  de outra tarefa para `EM_EXECUCAO`.
- **Exceção de ajuda (D-6):** apoio (`support_for_task_id`) não é principal: pode ser iniciado com
  uma principal ativa, não entra na fila e não transfere responsabilidade. Resolução de ocorrência,
  correção e embalagem do mesmo plano FILA contam como principais.
- **Concorrência:** `pg_advisory_xact_lock` por funcionário + verificação na transação + índice
  único parcial (última barreira). Reordenação: trava do plano + versão (CAS). Transferência:
  trava das duas semanas em ordem fixa (sem impasse) + travas das tarefas.

## 6. Preservação do legado e do financeiro (evidências)

Fixture legada gerada pelo **código anterior** (`839770a`) no banco `cenario_legacy_test`:
fluxo completo de 32 passos da Fase 12 (com valores financeiros) + plano LEGADO publicado com
tarefas `EM_EXECUCAO` (duas da mesma pessoa), `PAUSADA`, `PROGRAMADA` (horário futuro),
`BLOQUEADA` (gestor e dependência) e `CONCLUIDA`, e um rascunho LEGADO da semana seguinte.

| Verificação (script de fotografia: contagem de todas as tabelas, soma de todas as 22 colunas `*_cents`, hash de tarefas, eventos, planos, revisões, dependências, auditoria e eventos de domínio) | Resultado                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Antes × depois da migration                                                                                                                                                                       | **Idêntico** (127 linhas comparadas)                                                                                          |
| Planos após a migration                                                                                                                                                                           | 2 × `LEGADO`                                                                                                                  |
| Tarefas após a migration                                                                                                                                                                          | 26 com `queue_exclusive=false`, colunas novas nulas                                                                           |
| Reversão (script down)                                                                                                                                                                            | Esquema `pg_dump -s` idêntico ao original (3 173 linhas); dados idênticos; 12 migrations                                      |
| Reaplicação                                                                                                                                                                                       | Dados idênticos de novo                                                                                                       |
| Código novo sobre o banco migrado                                                                                                                                                                 | Planos LEGADO; horário futuro ainda recusado (422); fila vazia; concluir e retomar com outra em execução continuam permitidos |

Cálculo financeiro **não** alterado (nenhum arquivo de `finance/` mudou).

## 7. Testes executados

Variáveis: `TEST_DATABASE_URL=postgresql://cenario:***@127.0.0.1:55432/cenario_test`,
`CHECKPOINT_DISABLE=1`.

| Teste                              | Comando                                                                | Resultado                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Fila (CA2-01..14, WS e reconexão)  | `cd apps/api && npx vitest run test/queue.test.ts`                     | 14/14                                                                           |
| Regressão completa da API          | `cd apps/api && npx vitest run`                                        | 309 aprovados, 1 ignorado (desempenho, opcional), 0 falhas — 31 arquivos, 663 s |
| Domínio compartilhado              | `cd packages/shared && npx vitest run`                                 | 59/59 (9 arquivos)                                                              |
| Web (unitários)                    | `cd apps/web && npx vitest run`                                        | 6/6                                                                             |
| Desempenho                         | `QUEUE_PERF=1 npx vitest run test/queue-perf.test.ts` (banco separado) | 1/1, números na seção 10                                                        |
| Migração com dados legados         | fixture via `839770a` + `prisma migrate deploy` + fotografia           | idêntico (seção 6)                                                              |
| Reversão                           | `psql < packages/db/rollback/...down.sql` + `pg_dump -s`               | idêntico                                                                        |
| E2E fila (painel + tablet, 2 dias) | `cd tests/e2e && npx playwright test specs/team-queue.spec.ts`         | 1/1                                                                             |
| E2E completo                       | `cd tests/e2e && npx playwright test`                                  | 22/22 (6,8 min)                                                                 |
| Formatação / lint / typecheck      | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                     | sem apontamentos                                                                |
| Build web                          | `pnpm --filter @cenario/e2e build:web` (next build)                    | compilado sem erros                                                             |
| Backup/restauração                 | `pnpm test:backup`                                                     | verificado (13 migrations; contagens origem = restaurado)                       |

Ajustes feitos durante a regressão (cada um reexecutado até passar):

1. 1ª execução completa da API: 11 falhas (ajuda, ocorrências, qualidade). Apoio, resolução,
   correção e embalagem nasciam com o relógio real enquanto o início já usava o relógio
   unificado (o teste fixa 08:00 de hoje, antes do horário real).
2. 1º E2E completo: 4 falhas (ajuda, ocorrências, presença, qualidade). Esses specs adiantam o
   relógio do servidor em ~14 dias; com o relógio chegando à produção, tarefas imediatas eram
   carimbadas no futuro (fora do quadro da semana) e o "hoje" do `/mine` mudava de dia.
   Correção: tarefas imediatas usam `immediateAt()` = o menor entre relógio real e operacional
   (idênticos em produção) e o "hoje" de exibição do `/mine` volta ao dia real. Liberação e
   início continuam no relógio unificado (defeito do relógio de teste segue corrigido).
   Reexecução: suítes afetadas da API 114/114; os 4 E2E + fila 5/5.

## 8. Matriz CA2

| CA     | Critério                                                                     | Situação | Evidência                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA2-01 | Legado: horário futuro continua recusado                                     | APROVADO | `queue.test` "LEGADO preservado" (futuro e ausente 422; passado inicia; duas em execução no legado); verificação no banco migrado                                                                                     |
| CA2-02 | 40+ tarefas publicadas sem horário                                           | APROVADO | 42 tarefas `scheduledAt=null`, todas `LIBERADA`; data/hora recusadas (422); padrão da API = fila; perf com 200                                                                                                        |
| CA2-03 | Sem horário; dependências e materiais exigidos                               | APROVADO | `BLOQUEADA [DEPENDENCIAS]` e `[MATERIAIS]`, início 422                                                                                                                                                                |
| CA2-04 | Início explícito                                                             | APROVADO | após concluir A, B é `next` e `LIBERADA`, `startedAt` nulo; E2E idem                                                                                                                                                  |
| CA2-05 | 20 tarefas, 4 na segunda, 5ª na terça sem duplicar                           | APROVADO | relógio 23:59 → 00:01 → terça 08:00 com o ciclo de liberação; linhas idênticas; `next` = 5ª; total 16; E2E em dois dias                                                                                               |
| CA2-06 | 1ª bloqueada ⇒ próxima executável sem reordenar                              | APROVADO | posição 1 mantida, `blockedAhead=1`, `queue_position`/prioridade intactos                                                                                                                                             |
| CA2-07 | Desbloqueio não interrompe                                                   | APROVADO | em execução continua; desbloqueada volta a `next` na posição original; iniciar 409                                                                                                                                    |
| CA2-08 | Concorrência: no máximo uma ativa                                            | APROVADO | 6 inícios simultâneos ⇒ 1×200, 5×409; retomar × iniciar ⇒ 200/409; `UPDATE` direto no banco recusado pelo índice; apoio permitido                                                                                     |
| CA2-09 | Revisão com motivo, versão, histórico, tablet; funcionário proibido          | APROVADO | sem motivo 400; versão antiga 409; concorrentes 200/409; revisão 2; `FILA_REORDENADA`; auditoria; WS no tablet; tablet 403; faixa de prioridade/dependência 422                                                       |
| CA2-10 | Semana encerrada: pendências preservadas, transferência só autorizada        | APROVADO | sexta 422; sábado `weekEnded`, `pendingCount=3`, nada movido sozinho; tablet 403; em execução 422; transferência mantém responsável e origem                                                                          |
| CA2-11 | Migration preserva contagens, vínculos, horários, estados, custos, auditoria | APROVADO | seção 6 (fotografia idêntica; reversão idêntica)                                                                                                                                                                      |
| CA2-12 | Sem regressão P0                                                             | APROVADO | regressão completa API + E2E (seção 7)                                                                                                                                                                                |
| CA2-13 | Idempotência                                                                 | APROVADO | mesma chave em paralelo (200 ou 409 "em andamento", 1 evento); concluir duplo ⇒ 1 `CONCLUIDA`; transferência repetida (mesma chave ⇒ mesma resposta; outra chave ⇒ `moved: 0`); reordenação repetida sem nova revisão |
| CA2-14 | Segurança, acesso cruzado, vazamento financeiro                              | APROVADO | outro funcionário 403 ao iniciar/ver fila; fila e WS do tablet sem campos de valor                                                                                                                                    |
| CA2-15 | Isolamento                                                                   | APROVADO | regras de FILA não alcançam LEGADO (legado com duas ativas, fila vazia); semanas separadas; E2E em semana própria e limpo ao final; somente local e sintético                                                         |

## 9. Defeitos corrigidos e pendências

Corrigidos (com teste):

1. `reschedule.ts` usava o código inexistente `HORARIO` — agora `onlyReassignableBlockers`
   (tipado: um código inexistente não compila).
2. O relógio de teste não chegava à liberação — relógio único `core/clock.ts`; o ciclo e a rota
   de teste liberam pelo mesmo relógio (teste: 10:01 libera a de 10:00).
3. (Encontrado na regressão) tarefas imediatas × relógio unificado — `immediateAt()` (seção 7).

Pendências (não alteradas nesta fase):

- **−3 h fixo** em `finance/results.ts:381,385` (indicador de pontualidade): não altera valores
  financeiros; em FILA, tarefas sem `dueDate` ficam fora do indicador (sem `scheduledAt`). Corrigir
  para o fuso configurado e definir o prazo da tarefa em fila numa fase própria.
- Painel: reordenação por subir/descer (sem arrastar); filas exibidas por plano (a fila do
  tablet abrange todas as semanas FILA publicadas).
- Pausa com impedimento sem ocorrência continua retomável pelo funcionário (como antes).
- Distribuição automática (Fase 3), redesenho do tablet (Fase 4), mão de obra (5), logística (6–7).

## 10. Desempenho medido e limites

Medido em contêiner local (4 vCPU, 16 GB), **com a regressão da API rodando em paralelo**
(carga extra), 40 OS, 200 tarefas FILA (50 por funcionário), painel + 4 tablets conectados por WS:

| Medida                                                     | Resultado                                          |
| ---------------------------------------------------------- | -------------------------------------------------- |
| Criar 40 OS / 200 tarefas (preparação)                     | 4,8 s / 14,1 s                                     |
| Publicar 200 tarefas                                       | 3,5 s                                              |
| Ler o plano completo (painel) p50/p95                      | 136 / 169 ms                                       |
| Quadro p50/p95                                             | 32 / 38 ms                                         |
| Fila do tablet (80 leituras, 4 em paralelo) p50/p95        | 39 / 60 ms                                         |
| Iniciar/concluir (80 ações, 4 tablets em paralelo) p50/p95 | 204 / 377 ms; 4,8 s no total                       |
| Reordenar fila de 40 tarefas                               | 265 ms (aviso no tablet dentro do mesmo intervalo) |

Limites: reordenação até 500 tarefas por pedido; transferência até 500; `loadPlan` cresce com o
número de OS (lê a prontidão de materiais por OS).

## 11. Reversão, backup e riscos

- **Antes de aplicar em qualquer ambiente:** backup (`scripts/backup.sh`), aplicação parada,
  `prisma migrate deploy`. Nada foi aplicado fora do ambiente local.
- **Reversão:** voltar ao código `839770a` e executar o script down (testado). Perde-se só
  posição de fila e semana de origem; planos criados em FILA passam a ser tratados por horário
  (tarefas sem horário ficam `PROGRAMADA` até o gestor definir).
- **Riscos:** gestores acostumados ao horário (mitigado: modo explícito e selo no painel); fila
  longa sem arrastar; dependência entre funcionários pode deixar alguém sem executável
  (aparece como bloqueada à frente).

## 12. GO/NO-GO para a Fase 3

**GO técnico para iniciar a Fase 3**, condicionado à sua autorização explícita (a Fase 3
não foi iniciada). Base: CA2-01..CA2-15 aprovados com execução; regressão completa da API e E2E
sem falhas; migration aditiva comprovada sobre dados legados, com reversão testada.

Antes de qualquer ambiente real (fora do escopo desta fase): backup, janela com a aplicação
parada e `prisma migrate deploy`. Pendências da seção 9 (−3 h no indicador; prazo de tarefas em
fila) não bloqueiam a Fase 3, mas devem ter fase definida.

## 13. Commits e instruções de validação

- `6216aa6` Evolução Fase 2: migration aditiva da fila semanal (modo do plano, posição, exclusividade)
- `1a8a4b9` Evolução Fase 2: domínio e contratos da fila semanal
- `c1a32fe` Evolução Fase 2: motor da fila semanal na API
- `95ad29c` Evolução Fase 2: painel e tablet mínimos para a fila semanal
- `6865a73` Evolução Fase 2: testes da fila semanal (API, desempenho e E2E)
- `1a9db99` Evolução Fase 2: tarefas imediatas nunca no futuro do relógio; agenda do /mine no dia real
- este commit: relatório `docs/EVOLUCAO-FASE-2-PLANEJAMENTO-SEMANAL.md`

Validação local:

```bash
pnpm install && pnpm db:generate
export TEST_DATABASE_URL=postgresql://<usuario>:<senha>@127.0.0.1:<porta>/cenario_test
cd apps/api && npx vitest run test/queue.test.ts && npx vitest run   # API
cd ../../packages/shared && npx vitest run                          # domínio
cd ../../tests/e2e && pnpm build:web && npx playwright test specs/team-queue.spec.ts
QUEUE_PERF=1 npx vitest run test/queue-perf.test.ts                  # em apps/api, banco separado
```
