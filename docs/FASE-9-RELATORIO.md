# Fase 9 — Central de atenção, ocorrências e resolução de impedimentos: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)      |
| SHA inicial (fim da Fase 8)    | `edac889` (relatório) — último código da Fase 8: `5b4057f`                           |
| Commits da Fase 9              | `b8c5911` (banco, domínio, API, testes de API), `85ff353` (telas, E2E, documentação) |
| SHA final do código verificado | `85ff353` — este relatório é o commit seguinte (só o relatório)                      |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `edac889`.
- Relatórios das Fases 1–8 lidos; schema, migrations, motor de liberação, tablets, avisos,
  presença, ajuda/reprogramação, anexos, materiais/estoque/prontidão, permissões e eventos
  inspecionados.
- O PostgreSQL do contêiner estava parado de novo; foi iniciado antes da linha de base.
- **Linha de base antes de qualquer alteração** (PostgreSQL 16 real): `pnpm check` aprovado — API
  **191/191**, compartilhado **33/33**, web **6/6**; E2E completo **16/16**.
- **Divergências registradas:**
  1. Entidades sugeridas `IssueAction`, `IssueAssignment`, `IssueHistory` e `IssueAttachment`: a
     ação é uma **tarefa de resolução** (`production_tasks.issue_id`) que reusa Meu dia,
     Iniciar/Andamento/Concluir, fotos e histórico das tarefas; a atribuição atual fica na
     ocorrência e todas as atribuições no histórico imutável `production_issue_events`; anexos
     reusam `attachments` com o novo tipo `PRODUCTION_ISSUE`. Evita duplicar fontes de verdade.
  2. A pausa por ocorrência reutiliza o motivo existente "Outro" com a marca de impedimento (Fase 6)
     e a nota "Ocorrência OC-…", sem novo valor de enum.
  3. As propostas `BLOQUEIO` e `CONFLITO` já existiam no banco (Fase 8, não geradas); foram
     implementadas sem alterar a migration antiga.
  4. O gestor também executa tarefas (`producao.executar`): "atribuir a si próprio" cria a tarefa
     de resolução para ele.
  5. O E2E do painel (Fase 1) verificava "Central de atenção" como módulo indisponível; com a
     entrega, passou a verificar "Qualidade" como indisponível e a central como link.

## 3. Estruturas reutilizadas

- Motor de liberação (Fase 5) — novo bloqueador `OCORRENCIA`; ouvinte `onTaskBlocked` e
  `emitTaskBlocked` (Fase 8) para indicar/antecipar alternativas.
- Tarefas, histórico de tarefas, Meu dia, detalhe, exigência de observação na conclusão (Fase 6).
- Pausa com impedimento e evento `production.task_impediment` (Fase 6, "pronto para a central").
- Presença do dia e disponibilidade (Fase 7) para validar quem resolve; relógio de teste (Fase 8).
- Prontidão de materiais, reservas e o ouvinte `onReadinessChanged` (Fase 4).
- Propostas, `createProposal`, `obsoleteProposals`, decisão do gestor e `planning_actions` (Fase 8).
- Revisão da programação publicada `reviseIfPublishedBy` (Fases 5/8) — fonte única das revisões.
- Anexos privados, avisos persistentes com deduplicação, eventos/WebSocket com reenvio,
  auditoria, idempotência e versão.

## 4. Funcionalidades

**Tablet — "Tenho um problema"** (só nas próprias tarefas não encerradas; a ajuda de colega segue
em "Ajuda"):

- **Falta material**: escolher o material da OS (ou "Outro material" descrito), quantidade e
  unidade, observação e impacto. **Nenhuma compra é criada**: o gestor decide (estoque, compra ou
  outra solução).
- **Problema técnico**: descrição e impacto.
- **Outro impedimento**: só a descrição e "consegue continuar trabalhando?".
- Foto opcional; OS, tarefa, funcionário, dispositivo e horário registrados pelo servidor.
- **Impacto**: _impedido_ → pausa a tarefa em execução (andamento preservado) ou bloqueia a que
  aguardava início, identifica as tarefas afetadas e tenta indicar/antecipar outra tarefa;
  _consegue continuar com dificuldade_ → tarefa ativa, risco de prazo registrado; _consegue
  executar outra atividade_ → tarefa impedida e alternativa indicada. Só a etapa é afetada, nunca
  a OS inteira.
- Acompanhamento ("o gestor vai decidir", "Thiago vai resolver", "aguardando o gestor confirmar"),
  cancelamento por engano (só a própria, aberta) e "Retomar" só depois da resolução confirmada.
- **Tarefa de resolução** no Meu dia de quem resolve, com o problema descrito; iniciar, registrar
  andamento e concluir com o resultado (obrigatório).

**Painel**

- **Central de atenção** (`/painel/atencao`): contadores por categoria (crítico, atenção, ação
  necessária, informativo), filtros (prioridade/categoria, tipo, situação, funcionário, OS, data,
  responsável pela solução) e itens com tipo, OS, tarefa, funcionário, descrição, prioridade,
  horário, prazo, responsável, situação, impactos e próximas ações. Só exceções: ocorrências,
  ajuda atrasada/escalada, propostas pendentes, ausências com impacto (um item por pessoa), pausa
  por impedimento sem ocorrência e prazos vencidos/bloqueios com prazo. Um item por fato.
- **Ocorrência** (`/painel/ocorrencias/[id]`): dados, material, tarefas afetadas (dependentes em
  cadeia, pessoas e prazos), fotos, histórico e ações: delegar, registrar ação, registrar solução,
  verificar (confirmar ou "não resolvida"), reabrir e cancelar — com motivo onde exigido.
- **Delegação** a João, Thiago, Ricardo, Márcio ou ao próprio gestor: tarefa de resolução
  separada; competência exigida (opcional) conferida; ausente/externo/encerrado recusado; conflito
  de agenda pede confirmação explícita e fica registrado como impacto.
- **Escolha manual do ajudante** em Pedidos de ajuda (candidatos avaliados; impossível não é
  oferecido; conflito com aprovação e motivo).

**Ciclo e confirmação**: concluir a ação leva a "aguardando verificação" (nunca encerra); o gestor
confirma (falta de material só com o material coberto/reservado para a OS) ou recusa (volta a
aberta); na confirmação, a tarefa original é reavaliada (liberada se nada mais a impede; pausada →
"tarefa desbloqueada", sem retomar sozinha), as dependentes também, o funcionário é avisado e as
propostas ligadas perdem o efeito. Reabertura e cancelamento auditáveis, com motivo; exclusão
impossível.

## 5. Banco e migrations

Migration **aditiva** `20261014000000_central_atencao` (nenhuma migration antiga alterada, nada
apagado):

| Tabela / coluna                          | Conteúdo                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production_issues` (OC-00001)           | Tipo, situação, impacto, `blocks_task` (CHECK coerente com o impacto), prioridade, descrição, tarefa, OS, quem registrou, dispositivo, material (necessidade/estoque/descrição, quantidade, unidade — CHECK), responsável, tarefa de resolução (única), competência exigida, prazo de resolução, alerta de prazo, resultado, resolução, cancelamento (motivo obrigatório — CHECK), reaberturas, versão; índices por situação, tarefa, responsável e OS; **trigger impede exclusão** |
| `production_issue_events`                | Histórico **imutável** (trigger): abertura, atribuições (com conflitos), início, andamento, ações, solução, verificação, reabertura, cancelamento, riscos                                                                                                                                                                                                                                                                                                                           |
| `production_tasks.issue_id`              | Tarefa de resolução ligada à ocorrência (FK; CHECK: não é tarefa de apoio ao mesmo tempo)                                                                                                                                                                                                                                                                                                                                                                                           |
| `reschedule_proposals.issue_id`          | Proposta de bloqueio ligada à ocorrência                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `attachment_entity` + `PRODUCTION_ISSUE` | Fotos da ocorrência (arquivos privados)                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Permissões: `ocorrencias.registrar` (tapeceiros, cabeceiras/qualidade, ajudante e gestor),
`ocorrencias.ver` e `ocorrencias.gerenciar` (gestor). Concorrência: `FOR UPDATE` na ocorrência e
nas tarefas, versão nas decisões (409), idempotência nas rotas de escrita, transações em tudo.

## 6. APIs (`/api/v1`)

| Método e rota                                                                                | Uso                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /issues`                                                                               | Abrir ocorrência (tablet; idempotente; sem duplicar a mesma aberta) |
| `GET /issues/mine`                                                                           | Ocorrências que registrei ou estou resolvendo                       |
| `GET /issues?status=&kind=&taskId=`                                                          | Consultar ocorrências (painel)                                      |
| `GET /issues/:id`                                                                            | Detalhe com histórico e o que o usuário pode fazer                  |
| `GET /issues/:id/impacts`                                                                    | Tarefas afetadas, pessoas e risco de prazo                          |
| `POST /attachments` (`PRODUCTION_ISSUE`)                                                     | Anexar evidências (foto)                                            |
| `POST /issues/:id/assign`                                                                    | Atribuir responsável (cria a tarefa de resolução)                   |
| `POST /issues/:id/actions`                                                                   | Registrar ação (gestor ou quem resolve)                             |
| `POST /production-tasks/:id/start · progress · complete`                                     | Executar e concluir a ação no tablet (rotas existentes)             |
| `POST /issues/:id/request-verification`                                                      | Registrar a solução sem tarefa → verificação                        |
| `POST /issues/:id/verify`                                                                    | Confirmar a resolução ou recusar                                    |
| `POST /issues/:id/reopen` · `/cancel`                                                        | Reabrir · cancelar (motivo obrigatório)                             |
| `GET /attention?category=&type=&status=&employeeUserId=&solverUserId=&serviceOrderId=&date=` | Central de atenção                                                  |
| `GET /help-requests/:id/candidates`, `POST /help-requests/:id/assign`                        | Escolha manual do ajudante                                          |

Autenticação, autorização (servidor), validação (zod), auditoria e eventos em todas.

## 7. Telas

- **Tablet**: "Problema na tarefa" no detalhe (três opções em botões grandes, formulários curtos,
  foto), "Problemas registrados" no Meu dia, cartão e detalhe da tarefa de resolução com o problema,
  resultado obrigatório ao concluir, avisos. Sem valores financeiros (conferido no E2E).
- **Painel**: Central de atenção (primeiro item do menu), detalhe da ocorrência, diálogos de
  delegação (com confirmação de conflito) e de ação/solução/verificação/reabertura/cancelamento,
  escolha manual do ajudante.

## 8. Permissões (sempre no servidor)

| Ação                                         | Exige                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| Abrir ocorrência                             | `ocorrencias.registrar` + ser o responsável pela tarefa        |
| Ver uma ocorrência / fotos                   | Quem registrou, quem resolve ou `ocorrencias.ver`/`gerenciar`  |
| Cancelar                                     | Quem registrou (só a própria, ainda aberta) ou o gestor        |
| Registrar ação / solução                     | Quem resolve ou o gestor                                       |
| Delegar, verificar, reabrir                  | `ocorrencias.gerenciar`, sessão do painel                      |
| Central de atenção, lista, impactos (painel) | `ocorrencias.ver` ou `ocorrencias.gerenciar`, sessão do painel |
| Escolha manual do ajudante                   | `producao.planejar`, sessão do painel                          |

Funcionários não encerram ocorrências de terceiros; quem resolve não confirma a própria solução.

## 9. Eventos

Domínio (outbox + WebSocket, com reenvio): `issue.opened`, `issue.assigned`, `issue.updated`,
`issue.verification_requested`, `issue.resolved`, `issue.reopened`, `issue.cancelled`,
`issue.risk` — para a gestão de ocorrências, quem registrou e quem resolve. Tarefas e propostas
seguem com os eventos das Fases 5 e 8.

Avisos persistentes (um por fato; dedupe): ocorrência aberta (gestor), atribuída (quem resolve),
prazo de resolução em risco (gestor + quem resolve), solução concluída (quem registrou),
verificação necessária (gestor), resolvida (quem registrou + quem resolveu), cancelada, reaberta,
tarefa desbloqueada; nova tarefa alternativa e proposta aguardando aprovação reutilizam os avisos da
Fase 8.

## 10. Integração com reprogramação

- Tarefa bloqueada/pausada por ocorrência → regra simples da Fase 8 (indicar tarefa liberada ou
  antecipar a próxima pronta do mesmo funcionário: competência, materiais, dependências,
  prioridade e prazo preservados); nada inicia sozinho.
- **Proposta BLOQUEIO** (crítica quando há prazo em risco): ocorrência que impede com prazo em
  risco, dependentes de outras pessoas ou tarefa importante — "aguardar a solução" ou
  "reprogramar a tarefa e as dependentes para o próximo dia útil"; e tarefa bloqueada sem
  ocorrência com prazo em risco. Uma por fato (e por reabertura); perde o efeito quando a
  ocorrência é encerrada ou a tarefa deixa de estar bloqueada.
- **Proposta CONFLITO**: falta de ajudante com risco de atraso (pedido normal além do limite e
  alguém em tarefa não crítica) — o pedido continua na fila; se alguém ficar livre e for atribuído,
  a proposta perde o efeito.
- Mudanças críticas só com aprovação do gestor (aprovar/ajustar/rejeitar da Fase 8).
- **Histórico da programação**: tarefas de resolução e de apoio que entram numa programação
  publicada geram revisão (cópia anterior preservada, motivo, responsável e impacto) pela mesma
  rotina das demais revisões — sem segunda fonte de verdade.

## 11. Testes e resultados (08/10/2026, PostgreSQL 16 real)

**Final:** `pnpm check` aprovado — API **215/215** (191 anteriores + 24 da Fase 9 em
`apps/api/test/issues.test.ts`), compartilhado **38/38** (33 + 5 em `packages/shared/test/issues.test.ts`),
web **6/6**, formatação, lint e typecheck sem erros. **E2E completo 17/17** (nenhum ignorado).
`pnpm test:backup` aprovado com as tabelas da Fase 9 e a proteção contra exclusão conferida no banco
restaurado.

| #   | Cenário                        | Teste (API, `issues.test.ts`) / E2E                                               | Resultado |
| --- | ------------------------------ | --------------------------------------------------------------------------------- | --------- |
| 1   | Falta de material              | 1 (sem compra; só resolve com material reservado), 1b                             | ✔        |
| 2   | Problema técnico               | 2 + E2E                                                                           | ✔        |
| 3   | Outro impedimento              | 3                                                                                 | ✔        |
| 4   | Bloqueio total                 | 2 (pausa, andamento preservado, sem retomar) e 3 (bloqueia a não iniciada)        | ✔        |
| 5   | Impacto parcial                | 5                                                                                 | ✔        |
| 6   | Continuação de outra atividade | 6                                                                                 | ✔        |
| 7   | Ocorrência com foto            | 7 + E2E                                                                           | ✔        |
| 8   | Delegação ao Thiago            | 8 + E2E                                                                           | ✔        |
| 9   | Delegação ao João              | 9 (competência, ausente, conflito com confirmação)                                | ✔        |
| 10  | Tarefa de resolução            | 10 + E2E                                                                          | ✔        |
| 11  | Conclusão sem resolução        | 10 (vai para verificação) e 11 (recusada → aberta)                                | ✔        |
| 12  | Confirmação da solução         | 12 + E2E                                                                          | ✔        |
| 13  | Reabertura                     | 13 (motivo, auditoria, sem exclusão)                                              | ✔        |
| 14  | Cancelamento                   | 14                                                                                | ✔        |
| 15  | Impacto nas dependências       | 15                                                                                | ✔        |
| 16  | Proposta de bloqueio           | 15/16 (sem duplicar, perde o efeito) e 19                                         | ✔        |
| 17  | Proposta de conflito           | 17                                                                                | ✔        |
| 18  | Reprogramação simples          | 18                                                                                | ✔        |
| 19  | Aprovação crítica              | 19                                                                                | ✔        |
| 20  | Escolha manual de ajudante     | 20                                                                                | ✔        |
| 21  | Revisão da programação         | 8 (resolução) e 20 (apoio)                                                        | ✔        |
| 22  | Permissões                     | 22                                                                                | ✔        |
| 23  | Concorrência                   | 23                                                                                | ✔        |
| 24  | Idempotência                   | 24                                                                                | ✔        |
| 25  | Sincronização                  | 25/26 + E2E (painel e tablets atualizam sem recarregar)                           | ✔        |
| 26  | Reconexão                      | 25/26 (reenvio de `issue.assigned` e do aviso)                                    | ✔        |
| 27  | Regressão das Fases 1 a 8      | Suíte completa: API 191 anteriores, compartilhado, web, E2E 16 anteriores, backup | ✔        |

Também: "Central de atenção" (só exceções, categorias, filtros, um item por fato, prazo vencido
crítico com um único aviso).

**E2E da Fase 9** (`tests/e2e/specs/team-issues.spec.ts`, painel + tablets do Márcio e do Thiago):
chegada às 8h30 (relógio de teste) → Márcio inicia o revestimento, "Tenho um problema" → problema
técnico "Máquina de costura travando a linha", impedido, com foto → tarefa pausada → Central de
atenção mostra a ocorrência como "ação necessária" → gestor delega ao Thiago ("Verificar a máquina de
costura do Márcio") → Thiago recebe a tarefa de resolução em tempo real, inicia e conclui com o
resultado → a ocorrência fica "aguardando verificação" e o Márcio ainda não pode retomar → gestor
confirma → Márcio recebe "tarefa desbloqueada" e "ocorrência resolvida" e retoma.

## 12. Defeitos corrigidos

1. Durante o desenvolvimento, a proposta de conflito por falta de ajudante escalava o pedido —
   isso impediria a atribuição automática quando alguém ficasse livre (regra da Fase 8). Corrigido
   antes da entrega: o pedido segue na fila e a proposta perde o efeito na atribuição.
2. O tablet oferecia "Retomar" com ocorrência aberta (o servidor recusava); agora o botão só aparece
   quando a tarefa pode ser retomada.
3. O E2E do painel (Fase 1) esperava a central de atenção como módulo indisponível — atualizado.
4. Ajustes nos próprios testes novos (notas com menos de 3 caracteres e versão 0, recusadas pela
   validação; categoria esperada de uma ocorrência aberta com dificuldade).

## 13. Pendências

- Uma tarefa de resolução por vez (nova delegação cancela a anterior; o histórico guarda todas).
- No tablet, o material é escolhido entre os da OS ou descrito; a escolha de item de estoque existe
  só na API (o tablet não tem acesso ao estoque).
- Prazo de resolução padrão (2 h se impede, 8 h se não) e aviso 15 min antes são constantes
  documentadas; não configuráveis no painel.
- Conflito de agenda na delegação é aprovado explicitamente pelo gestor no próprio ato (sem gerar
  proposta separada).
- A central é calculada na consulta (sem tabela de alertas própria) e limita cada fonte a 300 itens.
- O gestor pode remover fotos da ocorrência pela galeria existente (remoção lógica, auditada).

## 14. Evidências

`docs/evidencias/fase-9/` (geradas com `E2E_EVIDENCE=1` só para o spec da Fase 9):
`01-tablet-tenho-um-problema.png`, `02-tablet-problema-registrado.png`,
`03-painel-central-de-atencao.png`, `04-painel-ocorrencia-delegada.png`,
`05-tablet-thiago-resolucao.png`, `06-painel-ocorrencia-resolvida.png`,
`07-tablet-marcio-avisos.png`.

## 15. Próximos passos (aguardando autorização)

A Fase 9 está concluída e **parada aqui**. Não houve deploy. A Fase 10, qualidade final e
financeiro **não** foram iniciados. Aguardo autorização para avançar.
