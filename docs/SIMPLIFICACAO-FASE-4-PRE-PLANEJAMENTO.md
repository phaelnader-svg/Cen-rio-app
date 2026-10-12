# Simplificação — Fase 4/10: Pré-planejamento, fila "A planejar" e distribuição automática

> Tudo foi executado **localmente**, em PostgreSQL 16 descartável e com **dados fictícios**. Nada
> foi publicado. Não houve Cloud Build, nenhuma alteração no Google Cloud, nenhuma migration na
> homologação, nenhum dado real, nenhum pagamento e nenhuma mensagem externa. O VerificaPro não foi
> alterado. A simplificação dos modelos (Fase 5) **não** foi antecipada: os modelos de produção
> atuais foram usados como estão.
>
> A mensagem da Fase 4 chegou cortada no item 13 da estrutura do relatório. As seções 13 a 24
> seguem o mesmo padrão das fases anteriores (tablets, reprogramação, permissões, concorrência,
> migrations, compatibilidade, testes, matriz CA4, evidências, problemas, pendências e
> GO/NO-GO).

## 1. SHA inicial e final

| Item                            | Valor                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                          | `claude/cenario-gestao-fase-1-zf3bj2`                                                                                                                                                                                                                                           |
| SHA inicial                     | `0b7b967` (fim da Fase 3; HEAD local = `origin`, worktree limpa)                                                                                                                                                                                                                |
| Versão informada na homologação | `eb3fe2a` — não verificada (sem acesso de rede à homologação neste ambiente)                                                                                                                                                                                                    |
| Commits da fase                 | `f2303b9` API/banco · `5f6abc8` formatação · `e11c982` painel · `1fa176f` E2E e ajustes · `a854114` migração encadeada · `14307de` rascunho inacessível por id · `4c6c0df` evidências · `84e5d99` semana exclusiva no E2E · `3e3f036` geometria · relatório e evidências finais |
| SHA final                       | o commit que adiciona este relatório (último da branch; ver `git log`)                                                                                                                                                                                                          |

Migrations confirmadas no início: a última era `20261206000000_recebimentos_compartilhados`.

## 2. Arquitetura implementada

```
Recebimento (Fase 3) ──► OS automática (Fase 2)
                              │
                              ▼
GET /api/v1/production/pipeline ── classifica cada OS pelos vínculos reais:
   sem item de plano e sem tarefa ............ A planejar
   tarefas em RASCUNHO ....................... Planejado — rascunho
   publicada, nada iniciado .................. Planejado — publicado
   publicada com impedimento real ............ Aguardando condição (derivado, sem estado novo)
   alguma tarefa iniciada .................... Em produção
   todas concluídas (30 dias) ................ Concluído

POST /api/v1/production/plan-services (1 OS ou lote, UMA transação, idempotente)
   trava por OS (advisory) + trava por semana (mesma chave da criação de plano)
   para cada OS: semana = segunda-feira da data de início
      plano da semana: encontra ou cria (FILA_SEMANAL, rascunho) — weekStart continua único
      item do plano: start_date, planned_by, version
      distributeServiceOrder(draft: true) — motor da Evolução Fase 3 (João/titular/dependências)
   auditoria production.service_planned + evento production.plan_updated

POST /api/v1/production-plans/:id/publish (endpoint EXISTENTE)
   plano em rascunho → publicação inicial (como antes)
   plano já publicado com tarefas em rascunho → publica o rascunho como NOVA REVISÃO

Liberação (common.ts › reevaluateTasks / releaseDueTasks / início da tarefa)
   evaluateRelease(..., notBefore = 00:00 da data de início no fuso da empresa)
   antes da data: PROGRAMADA (nunca LIBERADA); o tick periódico libera no dia
```

Não há segunda entidade de planejamento semanal. O pré-planejamento é o plano semanal existente
(`production_plans`, um por semana) com as tarefas em rascunho.

## 3. Entidades reutilizadas

| Entidade                                                          | Uso na Fase 4                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `production_plans`                                                | Plano da semana (único por `week_start`), criado em FILA_SEMANAL quando não existe                     |
| `production_plan_items`                                           | Vínculo OS ↔ semana; agora com data de início, autor e versão                                         |
| `production_tasks` / `task_dependencies`                          | Geradas pelo motor de distribuição; pré-planejado = status RASCUNHO                                    |
| `service_order_items.upholsterer_user_id` + histórico de titular  | Titular por peça (definição registrada no histórico; substituição só pelo fluxo existente, com motivo) |
| `production_plan_revisions`                                       | Publicação de rascunho numa semana já publicada = nova revisão (cópia imutável)                        |
| `production_task_events`                                          | Publicação, transferência de semana (`TRANSFERIDA_SEMANA`)                                             |
| Prontidão de materiais (`readinessOf`), chegadas físicas (Fase 3) | Situação dos materiais e "em conferência" na fila                                                      |
| `audit_logs`, outbox/WebSocket, `Idempotency-Key`                 | Auditoria, tempo real e repetição segura                                                               |

## 4. Alterações na API

| Endpoint                                                     | Acesso                                    | Descrição                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/production/pipeline`                            | `producao.ver` ou `producao.planejar`     | Cada OS em UMA situação, com peças, titulares, materiais, plano (semana, início, versão, quem planejou), contagem de tarefas, impedimentos e pendências. Sem valores financeiros. |
| `POST /api/v1/production/plan-services`                      | `producao.planejar` (painel), idempotente | `{ entries: [{ serviceOrderId, startDate, priority?, pieces: [{ serviceOrderItemId, upholstererUserId }] }] }`. Tudo ou nada.                                                     |
| `PUT /api/v1/production/planned/:id`                         | `producao.planejar`, idempotente          | Reprogramação: `{ version, startDate?, priority?, reason? }`. Versão do item (409); motivo obrigatório quando a semana já está publicada.                                         |
| `GET /api/v1/production-plans/:id/publication-preview`       | `producao.ver` ou `producao.planejar`     | O que "Publicar semana" vai liberar: OS, peças, tarefas, distribuição por profissional, datas, pendências, materiais bloqueados, conflitos.                                       |
| `POST /api/v1/production-plans/:id/publish`                  | inalterado                                | Também publica o rascunho de uma semana já publicada (nova revisão).                                                                                                              |
| `POST /api/v1/production-plans/:id/items/:itemId/distribute` | inalterado                                | Reprocessar uma OS em rascunho numa semana publicada mantém o rascunho (nunca publica sozinho).                                                                                   |

Contratos em `packages/shared`:

- `planServicesSchema`, `reschedulePlannedSchema`;
- `PipelineStage` com `PIPELINE_STAGE_LABEL`;
- `PipelineServiceDto`, `ProductionPipelineDto`, `PlanServicesResultDto`, `PublicationPreviewDto`;
- `ReleaseInput.notBefore`.

## 5. Alterações no painel

- Novo item de menu **"Produção — A planejar"** (`/painel/producao/a-planejar`), visível com
  `producao.ver` ou `producao.planejar`.
- Abas com contagem: **A planejar · Planejados · Aguardando condição · Em produção ·
  Concluídos**. Cada OS aparece em uma aba só.
- **A planejar**: seleção múltipla, "Planejar serviço" (individual) e "Planejar selecionados"
  (lote), sem trocar de página. O código da OS abre o detalhe.
- **Planejados**: agrupado por semana, com **Rascunho — ainda não visível aos funcionários**
  separado de **Publicado — já na fila dos tablets**. Cada OS mostra data de início, tarefas,
  quem planejou e "Reprogramar". A semana com rascunho mostra **"Revisar e publicar semana"**.
- **Aguardando condição**: os motivos reais (materiais, ocorrência, bloqueio, sem responsável,
  aguardando a data de início) e atalhos "Resolver na OS" e "Prontidão de materiais".
- O planejamento avançado (`/painel/producao/planejamento`) continua disponível, fora do fluxo
  principal.
- Design system global (Card, Badge, Dialog, Field, Tabs). Testado sem rolagem horizontal em
  390/768/1280/1440 e incluído na auditoria de geometria e na auditoria visual.

## 6. Fila A planejar

Uma OS está em **A planejar** quando, no banco:

- a OS está ABERTA;
- todas as peças foram fisicamente recebidas (`received_quantity > 0`);
- **não há** item de plano para ela (em nenhuma semana);
- **não há** tarefa de produção não cancelada.

Isso não é ocultação visual: a mesma regra recusa planejar de novo (409). Uma OS planejada sai da
fila no mesmo instante, e a lista se atualiza em tempo real (eventos `service_order.*`,
`receipt.*`, `production.*`, materiais).

Para cada serviço a fila mostra:

- código da OS, cliente, peças (tipo, quantidade, tipo de serviço);
- data de recebimento (do recebimento de origem) e prazo comercial;
- situação dos materiais (e "em conferência" quando há chegada física pendente);
- titular atual;
- pendências: peça sem modelo de produção, sem responsável elegível, nenhuma tarefa gerada.

## 7. Planejamento individual

- Campos obrigatórios: **data de início** e **tapeceiro de cada peça que tem tapeçaria**. Peça
  com titular já definido aparece travada (troca só pelo fluxo de substituição, com motivo).
- Não há horário, duração, atribuição manual de tarefas nem repetição de responsáveis
  configurados.
- O servidor:
  1. identifica a semana;
  2. encontra ou cria o rascunho;
  3. vincula a OS com data, autor e versão;
  4. registra o titular de cada peça (histórico DEFINICAO);
  5. distribui pelo motor existente (tarefas do modelo atual com dependências);
  6. audita;
  7. emite o evento.

  Tudo continua em **rascunho** até a publicação.

## 8. Planejamento em lote

- Seleção múltipla. Cada OS recebe a própria data e o tapeceiro de cada peça.
- "Aplicar a todos" preenche data e tapeceiro nas peças ainda sem titular, para evitar
  digitação repetida.
- O resumo mostra peças por tapeceiro, a preparação com o responsável padrão e os avisos (peça
  sem tapeceiro, data no passado).
- **Uma transação**: se uma OS falha (sem titular, já planejada, semana por horário, não
  recebida), nada é gravado e a mensagem diz qual OS e por quê. Testado: 0 itens e 0 tarefas
  depois da falha.
- A mesma chave devolve a mesma resposta. Outra requisição para a mesma OS recebe 409. Titular
  existente nunca é substituído (422 com orientação). As travas por OS e por semana impedem a
  sobrescrita por outro gestor.

## 9. Publicação semanal

- "Revisar e publicar semana" mostra:
  - quantidade de OS, peças e tarefas;
  - distribuição por profissional;
  - datas de início;
  - pendências;
  - materiais bloqueados;
  - conflitos (data de início já passada).
- **Publicar semana** reutiliza o endpoint existente, que exige a versão do plano:
  - primeira publicação: como antes (revisão 1);
  - semana já publicada com rascunho: o rascunho é publicado como nova revisão e o que já valia
    não muda.
- Depois de publicar:
  - as tarefas são reavaliadas (bloqueadas continuam bloqueadas, com motivo);
  - antes da data de início ficam Programadas;
  - nada é iniciado automaticamente;
  - os responsáveis são avisados e os tablets recebem `production.plan_published` ou
    `production.plan_revised`.
- Duas publicações simultâneas com a mesma versão: uma vale e a outra recebe conflito
  (testado: 1 revisão).

## 10. Distribuição automática

O motor da Evolução Fase 3 (`distributeServiceOrder`) foi reutilizado sem alterar regras:

- **Preparação**: o responsável padrão configurado ou o único ajudante elegível (João no seed).
- **Tapeçaria**: o titular da peça (Ricardo ou Márcio, escolha do gestor). A titularidade fica
  na peça e nunca é dividida nem trocada automaticamente.
- **Outros serviços**: modelos e competências existentes. Sem responsável elegível, a pendência
  fica visível (nunca há atribuição arbitrária).
- **Reprocessar**: completa o que falta.
  - não duplica tarefas nem dependências (testado: mesmas contagens);
  - não troca titular, não reinicia concluídas, não altera histórico nem valores.
  - Mudança única: `draft: true` mantém em rascunho a OS pré-planejada numa semana já
    publicada.

## 11. Datas de início

- **Persistência**: `production_plan_items.start_date` (DATE, nula = sem restrição, como em
  todos os itens antigos e nas pendências transferidas).
- **Significado**: intenção de início do serviço, não um horário obrigatório de tarefa. Na fila
  semanal continua não havendo horário.
- **Regra**: antes de 00:00 da data (fuso da empresa), nenhuma tarefa da OS fica "Liberada".
  - `reevaluateTasks` passa `notBefore` a `evaluateRelease`, e a tarefa fica PROGRAMADA;
  - o tick periódico (`releaseDueTasks`) também procura tarefas PROGRAMADAS de planos em fila
    cuja data chegou;
  - o **início** da tarefa revalida a data no servidor.
- **Teste**: com a data em dois dias, João não consegue iniciar. Com o relógio de teste no dia,
  o tick libera a primeira etapa.
- **Tablet**: mostra "Aguarda a data de início do serviço" (antes mostraria "Libera em às
  null").

## 12. Materiais e bloqueios

- A fila mostra a situação dos materiais pela prontidão existente:
  - sem levantamento;
  - aguardando aprovação, compra ou recebimento;
  - parcialmente disponível;
  - completo;
  - com divergência;
  - "em conferência" quando há chegada física pendente (Fase 3).
- Não há outro estoque.
- Planejar é permitido sem material, com aviso no formulário e na prévia.
- Publicar **não libera** etapa que exige material: ela fica BLOQUEADA com MATERIAIS (testado).
- A OS vai para **Aguardando condição**, com o motivo e atalhos para resolver.
- "Planejado" e "Liberado" são exibidos separadamente:
  - aba e selo de rascunho/publicado;
  - motivos de espera;
  - "aguardando a data de início".

## 13. Tarefas e tablets

- "Minha semana" e a fila foram preservados sem mudança de controles:
  - tarefa atual, próximas e lista completa;
  - iniciar, pausar, retomar, concluir;
  - informar problema;
  - reconexão.
- Tarefas de rascunho não aparecem, mesmo numa semana publicada, nem na fila nem na lista. O
  detalhe por id devolve 404 e o início devolve 422. Testado com tablets do Ricardo e do João.
- Nenhuma tarefa é liberada antes da data de início, nenhum indicador de atraso foi criado e
  nenhuma tarefa extra representa o pré-planejamento.
- Única mudança no tablet: o texto da espera por data de início.

## 14. Reprogramação

- **Data na mesma semana**: atualiza o início e reavalia as tarefas publicadas.
- **Outra semana**: só sem tarefa iniciada.
  - As pendentes vão para o **rascunho** da nova semana (o gestor publica de novo).
  - O item antigo é substituído.
  - Evento `TRANSFERIDA_SEMANA` por tarefa, aviso a quem já via a tarefa, revisão na semana de
    origem se estava publicada.
- **Prioridade**: no item e nas tarefas pendentes.
- **Controles**:
  - versão do item (409 para edição concorrente);
  - motivo obrigatório quando a semana está publicada (revisão);
  - auditoria `production.service_rescheduled`.
- **Proteções**:
  - tarefas concluídas não mudam (testado: status, versão e data de conclusão iguais);
  - tapeçaria em andamento não é transferida;
  - valores de mão de obra não são tocados.
- **Titular**: trocado só pelo fluxo existente (`PUT /api/v1/service-order-items/:id/upholsterer`,
  motivo, confirmação e CAS), que abre revisão financeira quando a regra exige.
- **Pendências de semanas anteriores**: continuam com a transferência existente (carry-over). Os
  planos antigos por horário não são convertidos.

## 15. Permissões e auditoria

- `producao.planejar` (sessão de painel) é exigida para planejar, reprogramar e publicar.
- `producao.ver` dá leitura da fila e da prévia.
- Tablets e funcionários recebem 403 na API, incluindo chamada direta. Testado com o tablet do
  Ricardo e com um usuário de painel só com `producao.ver`.
- Nenhuma permissão nova, nenhuma ampliada. Permissões financeiras e dos tablets intactas.
- Auditoria registra:
  - quem planejou e quando (ator, data);
  - data pretendida e titular de cada peça (`production.service_planned`, com `changes.owners`);
  - reprogramações com antes, depois e motivo;
  - publicação e revisões.
- A fila operacional não expõe valores (testado: sem `Cents/valor/price`).

## 16. Concorrência e idempotência

| Cenário                                            | Resultado testado                                          |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Dois gestores planejando a mesma OS ao mesmo tempo | 201 + 409; um único item de plano; tarefas sem duplicidade |
| Duplo clique (outra chave)                         | 409; nada duplicado                                        |
| Repetição após falha de rede (mesma chave)         | Mesma resposta; nada regravado                             |
| Publicação simultânea (mesma versão)               | 200 + 409; uma revisão                                     |
| Reprogramação com versão antiga                    | 409                                                        |
| Reprocessar a distribuição                         | Mesmas tarefas e dependências; titular mantido             |
| Troca de semana com tarefa iniciada                | Recusada (422)                                             |
| Lote com uma OS inválida                           | Nada gravado                                               |

Mecanismos:

- transação única;
- `pg_advisory_xact_lock` por OS e por semana (mesma chave usada na criação de plano existente);
- `FOR UPDATE` no plano e nas tarefas;
- `Idempotency-Key`;
- versão do item e do plano;
- índices únicos existentes (plano por semana, OS por plano, tarefa por etapa do modelo).

## 17. Migrations e rollback

Migration `20261213000000_pre_planejamento`, somente aditiva:

- `production_plan_items.start_date` (DATE, nula);
- `planned_by_id` (FK `users`, `SET NULL`);
- `version` (INT, padrão 1, `CHECK >= 1`).

Itens existentes ficam com data nula e versão 1, sem conversão.

Rollback `packages/db/rollback/20261213000000_pre_planejamento.down.sql`:

- **recusa** antes de qualquer alteração se existir item com data de início, autor ou versão
  diferente de 1;
- sem dados novos, remove as colunas e o registro de `_prisma_migrations`.

`scripts/test-evolution-migrations.sh` foi atualizado: a nova migration é revertida primeiro e
recusada com dados do pré-planejamento. A etapa de escrita planeja uma OS recebida pela fila. O
resultado está em §19. **Não** foi executada na homologação.

## 18. Compatibilidade com dados existentes

Preservados:

- OS anteriores;
- planos por horário (LEGADO): não convertidos; planejar numa semana LEGADO é recusado com
  orientação e o plano fica intacto (testado);
- planos semanais publicados;
- tarefas em execução e concluídas;
- dependências, titulares, mão de obra, revisões financeiras;
- recebimentos, histórico e auditoria.

O endpoint antigo de inclusão de OS no plano (`POST /production-plans/:id/items`) continua com
o comportamento anterior. Itens sem data de início não ganham restrição nova.

## 19. Testes executados

Ambiente: PostgreSQL 16 local descartável, dados fictícios.

| Suíte                                                                                                             | Resultado                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/pre-planejamento.test.ts` (novo)                                                                   | 12/12 (chamada direta e OS concluída; reexecutado após a última alteração)                                                                                                                                                    |
| Suítes de produção relacionadas (produção, distribuição, fila, semana do tablet, ajuda, ocorrências, mão de obra) | 118 aprovados, 3 ignorados (10 arquivos) — reexecutados após a última alteração                                                                                                                                               |
| API completa (`vitest run`)                                                                                       | 426 aprovados, 5 ignorados (verificações de migração, executadas pelo script), 0 falhas — 44 arquivos, sobre o código final                                                                                                   |
| Migração encadeada, rollback condicionado, backup/restauração                                                     | Aprovado: dados legados idênticos (98 tabelas); 9 rollbacks com schema e dados idênticos; 8 recusas atômicas (inclusive "1 OS planejada pelo pré-planejamento"); backup e restauração verificados                             |
| E2E `pre-planejamento.spec.ts` (novo)                                                                             | 1/1                                                                                                                                                                                                                           |
| E2E completo com geometria estrita (`depois-fase4`)                                                               | 32/32 (15,2 min), sobre o código final. Geometria: 57 telas × 4 larguras, 0 desalinhamentos, 0 rolagem horizontal, 0 campos estourados. (A rodada anterior teve 31/32 por colisão de semana entre E2E — §22, item 7.)         |
| Lint · typecheck · build web · Prettier                                                                           | Lint 0 erros · typecheck de todos os pacotes e do E2E: 0 erros · `pnpm build` (todos os pacotes): OK · Prettier: arquivos-fonte OK; 4 JSON de geometria gerados em fases anteriores (não alterados nesta fase) fora do padrão |

O E2E pedido foi executado:

- receber sofá (Novo serviço + confirmação de chegada) → OS automática → A planejar;
- planejar com Ricardo e data de início → rascunho (invisível no tablet do Ricardo);
- lote com a OS de dois sofás (Sofá A → Ricardo, Sofá B → Márcio);
- revisar e publicar semana;
- João vê as etapas de preparação, Ricardo vê a tapeçaria do sofá e do Sofá A, Márcio vê só o
  Sofá B. Nada fica executável antes da data de início.

**Não testado:** Safari/WebKit e tablets físicos **não** foram testados e **não** são declarados
aprovados. Os testes usaram Chromium com viewport e toque emulados.

## 20. Matriz CA4-01 a CA4-28

| CA     | Critério                                          | Situação | Evidência                                                                                                                      |
| ------ | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CA4-01 | OS recebida e não planejada aparece em A planejar | Aprovado | API A; E2E (captura 01)                                                                                                        |
| CA4-02 | OS não recebida não aparece                       | Aprovado | API A (e planejar é recusado)                                                                                                  |
| CA4-03 | Cancelada/concluída não aparece como pendente     | Aprovado | API A (cancelada fora da lista; concluída em "Concluído", fora de "A planejar")                                                |
| CA4-04 | OS planejada sai de A planejar                    | Aprovado | API B (contagem 0); E2E (linha some)                                                                                           |
| CA4-05 | Rascunhos e publicados separados                  | Aprovado | API D; E2E (captura 04)                                                                                                        |
| CA4-06 | Formulário exige só responsável e data            | Aprovado | API B (sem titular → 400; data no passado → 400); E2E (captura 02)                                                             |
| CA4-07 | Várias peças, titulares diferentes                | Aprovado | API B (dois sofás); E2E (Ricardo/Márcio)                                                                                       |
| CA4-08 | Planejamento em lote                              | Aprovado | API C (3 OS, 2 semanas; falha desfaz tudo); E2E (captura 03)                                                                   |
| CA4-09 | Data de início preservada                         | Aprovado | API B; E2E (Planejados mostra 08/12)                                                                                           |
| CA4-10 | Nenhuma tarefa inicia antes da data               | Aprovado | API B (início por chamada direta: 422 "data de início", `startedAt` nulo; liberação só no dia)                                 |
| CA4-11 | Rascunho não aparece no tablet                    | Aprovado | API B (fila, lista e detalhe por id: 404; início: 422) e D (semana publicada); E2E (tablet do Ricardo vazio antes de publicar) |
| CA4-12 | Publicação semanal em uma ação                    | Aprovado | API B e D; E2E (captura 05)                                                                                                    |
| CA4-13 | Distribuição respeita competências                | Aprovado | API B (preparação → João, tapeçaria → titular)                                                                                 |
| CA4-14 | Titularidade por peça preservada                  | Aprovado | API B (dois sofás; titular existente não substituído)                                                                          |
| CA4-15 | Dependências funcionam                            | Aprovado | API B (tapeçaria aguarda preparação)                                                                                           |
| CA4-16 | Materiais bloqueados não são liberados            | Aprovado | API E; E2E (Aguardando condição — captura 06)                                                                                  |
| CA4-17 | Reprocessamento não duplica                       | Aprovado | API B (mesmas tarefas e dependências)                                                                                          |
| CA4-18 | Duplo clique não duplica                          | Aprovado | API C                                                                                                                          |
| CA4-19 | Dois gestores simultâneos não duplicam            | Aprovado | API C                                                                                                                          |
| CA4-20 | Reprogramação preserva histórico                  | Aprovado | API D (`TRANSFERIDA_SEMANA`, revisão com motivo, versão)                                                                       |
| CA4-21 | Concluídas não são reiniciadas                    | Aprovado | API D (concluída intacta após reprogramar)                                                                                     |
| CA4-22 | Valores financeiros intactos                      | Aprovado | API B (obrigações, contas e recebíveis iguais antes/depois)                                                                    |
| CA4-23 | Permissões na API                                 | Aprovado | API E (tablet e painel sem planejar: 403)                                                                                      |
| CA4-24 | Tempo real                                        | Aprovado | API D (tablet recebe a revisão) e E (gestor recebe `plan_updated`)                                                             |
| CA4-25 | Planos antigos compatíveis                        | Aprovado | API E (LEGADO intacto); script encadeado                                                                                       |
| CA4-26 | Interface responsiva e alinhada                   | Aprovado | E2E (390/768/1280/1440 sem rolagem); geometria estrita                                                                         |
| CA4-27 | Migration, rollback e restauração                 | Aprovado | §17, §19                                                                                                                       |
| CA4-28 | Regressão completa da API e E2E                   | Aprovado | §19                                                                                                                            |

## 21. Evidências

Capturas em `docs/evidencias/simplificacao-fase-4/` (geradas pelo E2E, dados fictícios):

| Arquivo                                       | Conteúdo                                               |
| --------------------------------------------- | ------------------------------------------------------ |
| `01-a-planejar.png`                           | Fila A planejar (OS recebidas, materiais, sem valores) |
| `02-planejar-servico.png`                     | Formulário individual: data + tapeceiro                |
| `03-planejar-lote-dois-sofas.png`             | Dois sofás: Ricardo e Márcio, resumo                   |
| `04-planejados-rascunho.png`                  | Semana com rascunho separado                           |
| `05-revisar-e-publicar.png`                   | Prévia da publicação (OS, peças, tarefas, por pessoa)  |
| `06-aguardando-condicao.png`                  | Publicado ≠ liberado: motivos (materiais, data)        |
| `07-tablet-joao.png`, `08-tablet-ricardo.png` | Tablets depois da publicação                           |
| `09-producao-{390,768,1280,1440}.png`         | Quatro larguras, sem rolagem horizontal                |

A geometria (57 telas × 4 larguras) está em
`docs/evidencias/interface/depois-fase4/geometria.json`.

## 22. Problemas encontrados e corrigidos

1. **Início da tarefa ignorava a data de início.** O servidor revalida a liberação no início da
   tarefa sem a nova regra, e o primeiro teste mostrou João conseguindo iniciar antes da data.
   Corrigido: `taskNotBefore` foi incluído na verificação do início.
2. **Tablet sem texto para a espera por data** (mostraria "Libera em às null"). Corrigido.
3. **"Aguardando condição" inflado.** Toda OS publicada com várias etapas caía nessa aba, porque
   as etapas seguintes aguardam a anterior (DEPENDENCIAS). Agora conta só impedimento real
   (material, ocorrência, bloqueio, sem responsável) ou nenhuma etapa da OS podendo andar.
4. **Reprocessar numa semana publicada publicaria uma OS em rascunho.** Corrigido com
   `draft: true`.
5. **Layout em 390 px**: as linhas apertavam a descrição da OS. Corrigido: empilha no celular.
6. **Detalhe de tarefa em rascunho acessível ao responsável por chamada direta** (GET
   `/api/v1/production-tasks/:id` com o id). Nenhuma lista mostrava, mas a regra é "nunca".
   Agora o tablet recebe 404 para tarefa em rascunho. A lista (`/mine`), a fila (`/mine/queue`)
   e o início já recusavam (testado).

7. **Colisão de dados entre E2E.** O E2E novo usava a mesma semana futura (hoje + 63 dias) do
   E2E "Minha semana" e a deixava publicada. Este passou a falhar ao incluir OS ("Informe o motivo
   da alteração da programação publicada"). Corrigido: o E2E da Fase 4 usa uma semana exclusiva
   (+91 dias), e a suíte completa foi executada de novo.

## 23. Pendências e riscos

- **Safari/WebKit e tablets físicos** não testados.
- **Semana em planejamento por horário (LEGADO)** não aceita pré-planejamento. O gestor escolhe
  outra data ou usa o planejamento avançado. É intencional: não converter planos antigos.
- **Troca de titular** continua no fluxo existente (OS/distribuição), fora do formulário rápido,
  como pede a regra de não substituir sem confirmação.
- **Concluídos** lista os últimos 30 dias, para manter a tela leve.
- **Fase 5**: os modelos atuais têm mais etapas do que o desejado; a simplificação ficou para a
  Fase 5, como combinado.
- A migration **não** foi aplicada na homologação. A publicação segue o runbook (backup antes,
  migração explícita).

## 24. GO/NO-GO técnico para a Fase 5

**GO técnico** para a Fase 5.

- Os 28 critérios têm evidência executada nesta fase.
- Regressão completa da API (426/426, 5 ignorados por desenho) e E2E completo (32/32) sobre o
  código final.
- Migration aditiva com rollback condicionado e restauração verificados.
- Rascunho invisível aos tablets por qualquer via; início antes da data recusado também por
  chamada direta.

Condições antes do uso real (não bloqueiam o desenvolvimento da Fase 5):

- testar Safari/WebKit e tablets físicos;
- aplicar a migration na homologação somente com backup e autorização.

A Fase 5 **não** foi iniciada. Aguardando autorização explícita.
