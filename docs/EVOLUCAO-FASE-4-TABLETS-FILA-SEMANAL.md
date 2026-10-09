# Evolução, Fase 4 de 8 — Experiência dos tablets e fila semanal

Ambiente exclusivamente local (PostgreSQL 16 em contêiner, dados sintéticos). Sem deploy, sem
Google Cloud/homologação/DNS/VM/segredos, sem dados reais, sem VerificaPro, sem mudança em
mão de obra, pagamentos ou logística. Sem migration nesta fase. A Fase 5 **não** foi iniciada.

## 1. Branch, SHA e worktree

| Item                                   | Valor                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Branch                                 | `claude/cenario-gestao-fase-1-zf3bj2`                                                        |
| SHA inicial (conferido: fim da Fase 3) | `ad20154`                                                                                    |
| SHA final                              | último commit desta entrega (seção 13 do resumo)                                             |
| Worktree                               | `/home/user/Cen-rio-app`, limpo antes e depois; migrations no banco local: 14 (nenhuma nova) |

Commits: `27ea76a` Evolução Fase 4: contratos da semana e seleção pura do tablet; `194531d` Evolução Fase 4: API da fila com semana e contagens; testes do tablet; `bd8fa21` Evolução Fase 4: tablet "Minha semana"; `844dca8` Evolução Fase 4: E2E do tablet (gestor + 4 tablets) e evidências; specs das Fases 2/3 na nova tela; `581244e` Evolução Fase 4: capturas dos fluxos das Fases 2 e 3 na nova tela (dados sintéticos); `6a6dcc9` Evolução Fase 4: contagem semanal limitada à semana; "Minha semana" só com fila aberta; e o commit deste relatório.

## 2. Auditoria do tablet atual e decisões de UX

**Antes desta fase** (`apps/web/components/tablet/`):

| Peça                                                                             | Arquivo                                                                                                                        | Observação                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Shell, pareamento, PIN, sessão, WS                                               | `tablet-app.tsx`, `pairing.tsx`, `login.tsx`, `lib/realtime.tsx`                                                               | Mantidos sem mudança                                                    |
| Início ("Meu dia") e navegação por telas                                         | `home.tsx` (`Screen`), `tasks.tsx` `MyDay`                                                                                     | "Hoje/Próximos dias" por horário; na Fase 2 ganhou a seção "Minha fila" |
| Cartão, ação rápida (Iniciar/Concluir), detalhe, pausa, andamento, fotos, avisos | `tasks.tsx` `TaskCard`, `QuickAction`, `MyTaskDetail`, `PausePanel`, `CompletePanel`                                           | Reaproveitados                                                          |
| Presença, fim do expediente                                                      | `presence.tsx`                                                                                                                 | Sem mudança                                                             |
| Ajuda, ocorrências, qualidade, logística, medições, valores próprios             | `help.tsx`, `issues.tsx`, `quality.tsx`, `logistics.tsx`, `measurements.tsx`, `my-values.tsx`                                  | Sem mudança                                                             |
| Estados de tarefa reais                                                          | `TASK_STATUSES` (`RASCUNHO, BLOQUEADA, PROGRAMADA, LIBERADA, EM_EXECUCAO, PAUSADA, CONCLUIDA, CANCELADA`) e `RELEASE_BLOCKERS` | Usados sem novos nomes                                                  |
| Campos da Fase 3                                                                 | `service_order_items.upholsterer_user_id`, `production_tasks.step_class`, pendências em `/distribution` (gestão)               | Titular e classe passam a vir no DTO da tarefa                          |

**Decisões de UX**

- "Minha semana" substitui o "Meu dia" **somente quando há fila semanal aberta**; sem fila (planos
  por horário), a tela anterior permanece idêntica — sem conversão.
- Destaque = tarefa em execução; sem ela, a primeira executável **na ordem do servidor** (a tela
  nunca reordena). Depois, até três próximas em cartões compactos (sem ações) com a posição na
  fila; o botão **Ver todas as tarefas (N)** abre a fila completa paginada (20 por página).
- Contagens: concluídas na semana, em execução, disponíveis, aguardando (informativas; nenhuma
  "meta" ou ranking).
- Nada executável: cartão de estado com o motivo agregado (dependências, materiais, ocorrência,
  bloqueio, responsável) e o caminho (abrir a tarefa → "Tenho um problema"/ajuda, ou avisar o
  gestor). Nenhuma ação é habilitada pela tela.
- Titular × apoio: "Você é o tapeceiro titular desta peça." (tapeçaria do próprio titular) ou
  "Tapeceiro titular da peça: X — esta etapa é de apoio." (preparação/desmontagem). Só exibição.
- Pendências de semanas anteriores: aviso no resumo e selo "Semana anterior" no cartão.
- Outras tarefas (apoio de ajuda, resolução, qualidade, planos por horário) continuam abaixo,
  com a ação rápida.
- Confirmação só no Concluir (já existente: toque duplo); nenhum diálogo novo.

## 3. Mudanças (arquivos, contratos, permissões, fluxos)

| Arquivo                                         | Mudança                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/week-view.ts` (novo)       | `summarizeWeek` (destaque, até 3 próximas, motivos), `pageOf`, rótulos dos motivos                              |
| `packages/shared/src/types-production.ts`       | `ProductionTaskDto.stepClass`, `serviceOrderItem.upholsterer`; `MyQueueDto.week`, `counts`, `fromPreviousWeeks` |
| `apps/api/src/modules/production/common.ts`     | `taskInclude`/`toTaskDto` com titular e classe                                                                  |
| `apps/api/src/modules/production/queue.ts`      | Semana vigente (relógio operacional, fuso da empresa), contagens, concluídas **só da semana**                   |
| `apps/web/components/tablet/my-week.tsx` (novo) | "Minha semana", fila completa, estados vazio/erro                                                               |
| `apps/web/components/tablet/home.tsx`           | Título "Minha semana", tela "Todas as minhas tarefas", voltar                                                   |
| `apps/web/components/tablet/tasks.tsx`          | `PieceOwnerInfo` no cartão                                                                                      |

Contratos só **acrescentados** (nenhum campo removido ou renomeado). Permissões: nenhuma nova,
nenhuma ampliada. Fluxos de execução (iniciar/pausar/retomar/concluir/ajuda/problema/fotos):
mesmos endpoints e validações do servidor.

## 4. Evidências de tela (dados sintéticos, sem credenciais)

`docs/evidencias/evolucao-fase-4/`: `01-joao-tablet.png` (destaque, próximas 3, contagens,
titular × apoio), `02-ricardo-aguardando.png` (nada executável + motivo; "você é o titular"),
`03-joao-celular.png`, `03-joao-tablet.png`, `03-joao-desktop.png` (390, 1280 e 1440 px sem
rolagem horizontal), `04-fila-completa.png`. Capturas das Fases 2/3 na nova tela em
`docs/evidencias/evolucao-fase-2/` e `evolucao-fase-3/`.

## 5. Matriz CA4

| CA                                                | Status              | Evidência                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA4-01 Semana e identidade                        | APROVADO            | API: `/auth/me` = João; `week` = segunda–domingo vigente (relógio controlado); E2E: título, nome e período                                                                                                                                                                                        |
| CA4-02 Destaque                                   | APROVADO            | E2E: 1ª da fila destacada; após iniciar, "Em execução agora"; unitário `summarizeWeek`                                                                                                                                                                                                            |
| CA4-03 Até três + fila completa                   | APROVADO            | E2E: 3 próximas; "Ver todas (4)" com a ordem; unitário (menos de 3 não inventa cartões; paginação)                                                                                                                                                                                                |
| CA4-04 OS, peça, etapa, status, técnicos          | APROVADO            | Cartão com OS, código da peça, etapa — descrição, status, prioridade; detalhe técnico existente                                                                                                                                                                                                   |
| CA4-05 Bloqueio explicado                         | APROVADO            | E2E Ricardo: "aguardando materiais; aguardando etapas anteriores", sem botão Iniciar; API: iniciar bloqueada 422                                                                                                                                                                                  |
| CA4-06 Bloqueada não impede a próxima             | APROVADO            | API + E2E Fase 2: posição 1 mantida, próxima executável destacada                                                                                                                                                                                                                                 |
| CA4-07 Desbloqueio não interrompe                 | APROVADO            | API: em execução mantida, desbloqueada vira a próxima; inícios simultâneos 409                                                                                                                                                                                                                    |
| CA4-08 Transições e única ativa                   | APROVADO            | API: iniciar/pausar/retomar/concluir com eventos; concluir duplo = 1 evento; segunda principal 409                                                                                                                                                                                                |
| CA4-09 Segunda → terça                            | APROVADO            | API: linhas idênticas, mesma ordem, contagem da semana; semana seguinte zera a contagem e marca pendências anteriores; E2E com relógio                                                                                                                                                            |
| CA4-10 Titular × apoio                            | APROVADO            | API: classe e titular no DTO; Ricardo 403 em tarefa do Márcio; E2E: textos de titular e de apoio                                                                                                                                                                                                  |
| CA4-11 Reordenação em tempo real e após reconexão | APROVADO            | E2E: reordenação muda o destaque; com o tablet offline, nova reordenação reconciliada ao reconectar; API: replay `queue_reordered`                                                                                                                                                                |
| CA4-12 Proibições do funcionário                  | APROVADO            | API: reordenar 403, trocar titular 403, executar tarefa de outro 403, ver fila de outro 403                                                                                                                                                                                                       |
| CA4-13 Nenhum valor financeiro                    | APROVADO            | API: varredura de chaves financeiras em `/auth/me`, `/mine`, `/mine/queue`, detalhe, avisos, presença, ajuda, ocorrências, recebimento de materiais (com pedido de compra com preço e mão de obra combinada no banco) para os 4 tablets + WS: nenhuma; `/finance/my-production` 403 sem permissão |
| CA4-14 Layout e acessibilidade                    | APROVADO (Chromium) | E2E: 390/1280/1440 px sem rolagem horizontal, teclado (foco + Enter em "Ver todas"), rótulos (`aria-label` da posição, seções com títulos), estados vazio/erro/offline; auditoria visual completa (144 telas×tamanhos, 0 erros). Safari/WebKit físico: **não executado** (indisponível aqui)      |
| CA4-15 Fluxos anteriores e planos por horário     | APROVADO            | E2E completo: presença, ajuda, ocorrências, qualidade, logística, financeiro, oficina com 4 tablets (por horário)                                                                                                                                                                                 |
| CA4-16 Regressão, E2E, concorrência, backup       | APROVADO            | seção 6                                                                                                                                                                                                                                                                                           |

## 6. Testes executados

| Teste                                                       | Comando                                                         | Resultado                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Unitários do resumo da semana                               | `cd packages/shared && npx vitest run`                          | 68/68 (inclui 5 de `week-view`)                                                 |
| API do tablet (CA4)                                         | `cd apps/api && npx vitest run test/tablet-week.test.ts`        | 4/4                                                                             |
| Regressão completa da API                                   | `cd apps/api && npx vitest run`                                 | 323 aprovados, 2 ignorados (desempenho opcional), 0 falhas — 35 arquivos, 685 s |
| Web unitários                                               | `cd apps/web && npx vitest run`                                 | 6/6                                                                             |
| E2E Fase 4 (gestor + João, Ricardo, Márcio, Thiago)         | `npx playwright test specs/team-week.spec.ts`                   | 1/1                                                                             |
| E2E completo                                                | `cd tests/e2e && npx playwright test`                           | 24/24 (7,5 min), inclusive oficina com 4 tablets, auditoria visual e Fases 2–4  |
| Formatação, lint, typecheck, build web                      | `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `build:web` | sem apontamentos; compilado                                                     |
| Backup/restauração (sem mudança de persistência; regressão) | `pnpm test:backup`                                              | verificado (14 migrations)                                                      |
| Desempenho da fila                                          | `QUEUE_PERF=1 npx vitest run test/queue-perf.test.ts`           | seção 9                                                                         |

Falhas encontradas e corrigidas:

1. E2E: formato do período (o painel exibe o dia da semana) — ajuste da asserção.
2. **Defeito real** (1º E2E completo): concluídas com o relógio de teste em semanas futuras eram
   contadas na semana vigente (sem limite superior), e a tela "Minha semana" aparecia sem fila
   aberta, escondendo o "Meu dia" de quem só tinha tarefas por horário (o spec de oficina da
   Fase 12 ficou esperando). Correção: contagem limitada à semana e "Minha semana" só com fila
   aberta; teste de API da virada para a semana seguinte.
3. Specs das Fases 2 e 3 adaptados aos novos identificadores da tela (mesmas asserções de
   comportamento).

## 7. Compatibilidade

- Planos por horário (LEGADO): sem conversão; quem não tem fila aberta vê o "Meu dia" anterior;
  tarefas por horário aparecem com ação rápida em "Outras tarefas" quando há fila.
- Fase 2: liberação, ordem, exclusividade, reordenação, transferência — mesmos endpoints.
- Fase 3: titular e classe só exibidos; nenhuma troca pelo tablet; pendências seguem no painel.
- Sem migration; nenhum dado alterado; histórico preservado.

## 8. Segurança e privacidade

- DTOs do tablet sem campos financeiros (verificado por varredura automática, inclusive com
  preço de compra e mão de obra no banco) e WS sem valores.
- Nenhuma permissão nova; autorização sempre no servidor (403/409/422 nos testes).
- O nome do cliente segue no DTO da tarefa e no detalhe (contrato anterior, necessário para
  identificar a peça); os cartões da "Minha semana" não o exibem. Redução adicional: pendência
  para a auditoria final (Fase 8).

## 9. Desempenho medido

40 OS, 200 tarefas FILA (50 por funcionário), gestor + 4 tablets por WS, contêiner local
(4 vCPU), **medido com a regressão da API rodando em paralelo**:

| Medida                                                              | p50 / p95    |
| ------------------------------------------------------------------- | ------------ |
| Fila do tablet (com semana e contagens), 80 leituras, 4 em paralelo | 44 / 80 ms   |
| Iniciar/concluir, 80 ações em 4 tablets simultâneos                 | 174 / 350 ms |
| Plano completo (painel)                                             | 145 / 205 ms |
| Reordenar fila de 40 + aviso no tablet                              | 233 ms       |

Risco: a contagem semanal acrescenta uma consulta por leitura da fila (indexada por responsável
e estado); sem impacto mensurável relevante frente à Fase 2 (39/60 ms sem carga paralela).

## 10. Limitações e pendências (Fases 5–8)

- Safari/WebKit e tablets físicos: validação manual pendente (ambiente só com Chromium).
- O relógio do cabeçalho do tablet é o do aparelho (o relógio de teste é só do servidor).
- Nome do cliente no detalhe da tarefa (seção 8) — avaliar na Fase 8.
- Mão de obra, fechamento semanal e logística: Fases 5–7 (nada alterado aqui).
- −3 h fixo no indicador financeiro (pendente desde a Fase 2).

## 11. Rollback

Sem migration e sem dado novo: reverter os commits desta fase (`git revert`) restaura a tela
anterior; os campos acrescentados ao DTO são opcionais para clientes antigos. Nenhum impacto em
dados.

## 12. GO/NO-GO para a Fase 5

| P0                                                              | Situação |
| --------------------------------------------------------------- | -------- |
| Execução (iniciar/pausar/retomar/concluir, início explícito)    | APROVADO |
| Autorização (reordenar, titular, tarefa de outro)               | APROVADO |
| Exclusividade (uma principal ativa, tapeçaria do titular)       | APROVADO |
| Dependências/bloqueios (sem liberar pela tela, sem interromper) | APROVADO |
| Integridade (sem duplicar, sem transferir, sem migration)       | APROVADO |
| Privacidade (respostas, WS, avisos)                             | APROVADO |
| E2E crítico (gestor + 4 tablets, reconexão, virada do dia)      | APROVADO |

**GO técnico para a Fase 5, condicionado à sua autorização explícita.** Ressalva: validação em
Safari/WebKit e nos tablets físicos não foi executada (ambiente só com Chromium) e fica
pendente; por isso não é GO pleno para uso em campo.
