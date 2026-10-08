# Fase 5 — Motor de produção e planejamento semanal: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento) |
| SHA inicial (fim da Fase 4)    | `ec72d74` (igual ao `origin` no início)                                         |
| Commits da Fase 5              | `7025c47`, `cb6679c`, `ab65be6`, `2a9f235` (banco, API, telas, testes, docs)    |
| SHA final do código verificado | `2a9f235` — este relatório é o commit seguinte                                  |

## 2. Estado inicial do repositório

- Branch correta, árvore limpa, `HEAD` = `origin` = `ec72d74`.
- Relatórios das Fases 1–4, `ARQUITETURA.md`, `SEGURANCA.md` e `OPERACAO.md` lidos; schema
  Prisma, migrations, rotas, permissões, hub de tempo real e prontidão de materiais inspecionados.
- Nenhuma entidade de produção existia (sem tarefas, planejamentos ou modelos). Já existiam e
  foram reaproveitados: OS e peças (Fase 2), responsável técnico da OS, prontidão de materiais
  (`readinessOf`/`refreshReadiness`, Fase 4), reservas de estoque, funções `tapeceiro`,
  `cabeceiras_qualidade` e `ajudante`, `planningWeekday` (sexta) e `workdayStart` da empresa.
- **Divergências e lacunas registradas antes de implementar:**
  1. A prontidão "Programação" da OS era fixa em `FASE_FUTURA`, e a aba Produção da OS estava
     desabilitada — esperado até a Fase 4, substituído agora.
  2. O teste da Fase 4 afirmava "não existe rota de produção" (`printRoutes` sem `production`) —
     regra que a Fase 5 muda por definição; trocado por "material completo não cria tarefa nem
     item de planejamento" (o objetivo original do teste).
  3. Cancelar uma OS não tratava reservas de estoque nem (naturalmente) tarefas — pendência da
     seção 19, com proteção mínima nesta fase.
  4. Nenhuma divergência entre o código e os relatórios anteriores foi encontrada.

## 3. Estruturas reutilizadas

| Já existia                                                                         | Uso na Fase 5                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OS, peças (`service_order_items`) e quantidade recebida do pedido                  | Tarefas por peça; regra "peça recebida" verificada no banco                      |
| Responsável técnico da OS                                                          | Sugestão do responsável principal ao incluir a OS na semana                      |
| Prontidão de materiais (Fase 4)                                                    | Condição "materiais disponíveis e reservados"; mudança reavalia tarefas          |
| Reservas e `changeStock` (Fase 4)                                                  | Liberação das reservas quando a OS é cancelada                                   |
| Funções da oficina e concessões                                                    | `producao.executar` concedida a tapeceiro, cabeceiras/qualidade e ajudante       |
| `planningWeekday`, `workdayStart`, fuso da empresa                                 | Sexta padrão (outros dias marcados "fora da rotina"); horário padrão das tarefas |
| Sessões, permissões por rota, CSRF, idempotência, `version` + `FOR UPDATE`, outbox | Todas as rotas novas                                                             |
| Hub de tempo real com audiência e reenvio na reconexão                             | Eventos `production.*` para gestão e para o responsável                          |
| Galeria de fotos e política de anexos                                              | Fotos da OS no tablet do responsável por tarefa publicada                        |
| `cenario_reject_mutation` (triggers de imutabilidade)                              | Histórico de tarefas e revisões de planejamento                                  |

## 4. Funcionalidades implementadas

- **Planejamento semanal** (`/painel/producao/planejamento`): seleção da semana (segunda a
  domingo), rascunho, OS abertas candidatas com prazo, prioridade e prontidão de materiais;
  inclusão da OS com responsável principal, prioridade e dia; tarefas sugeridas pelos modelos;
  edição de responsável, dia, hora, prazo interno, prioridade e dependências; inclusão/retirada
  de etapas; conflitos e avisos (sem responsável, sem horário, mesmo horário para a mesma
  pessoa, antes da dependência, materiais, após o prazo, fora da semana); revisar e publicar.
- **Sexta como padrão**: publicar em outro dia é permitido e a revisão fica marcada "fora da
  sexta" (`off_schedule`).
- **Versões e histórico**: publicação = revisão 1. Depois disso, toda alteração exige motivo e
  grava nova revisão com o _snapshot_ anterior completo, quem e quando (imutável).
- **Motor de liberação**: uma tarefa só fica `LIBERADA` com OS ativa, peça recebida, planejamento
  publicado, responsável, dependências concluídas (ou canceladas), materiais completos quando a
  etapa exige, sem bloqueio manual e horário programado alcançado. Antes do horário fica
  `PROGRAMADA` (distinta de `LIBERADA`); faltando qualquer condição, `BLOQUEADA` com os motivos.
  O `iniciar` refaz toda a verificação no banco sob bloqueio da linha; eventos fora de ordem ou
  repetidos não liberam nada.
- **Reprogramação pelo gestor** sem atalho: alterar dia, responsável ou dependências reavalia a
  tarefa pelas mesmas regras; não há "forçar início".
- **Modelos configuráveis** (`/painel/producao/modelos`): sofá, cabeceira e cadeira/poltrona,
  editáveis (etapas, papel, materiais, opcional, dependências), e novos modelos.
- **Tarefas paralelas com DAG explícito**: várias dependências por tarefa, só da mesma OS; ciclos
  recusados com a lista do ciclo.
- **Responsável principal por sofá** (Ricardo ou Márcio — qualquer tapeceiro): obrigatório para
  OS com sofá; corte de tecido e costura ficam com ele; trocar o principal leva junto as tarefas
  principais ainda não iniciadas. Apoio (João, Thiago) atribuído explicitamente.
- **Execução no tablet**: iniciar, registrar andamento (texto curto + 25/50/75%), pausar com motivo
  simples (fim do expediente, aguardando orientação, interrupção programada, outro), retomar
  mantendo o andamento, concluir com confirmação.
- **Conclusão**: valida "em execução", grava usuário, dispositivo e horário, auditoria e evento
  persistente na mesma transação; reavalia as dependentes, libera as elegíveis e avisa o próximo
  responsável; repetição não duplica; tarefa de apoio nunca conclui a principal.
- **Quadro de produção**, **detalhe da tarefa** com ações do gestor e **aba Produção da OS**.
- **Liberação por horário**: a API libera a cada 30 s as tarefas cujo horário chegou (idempotente).
- **Proteção mínima no cancelamento de OS** (seção 14).

## 5. Modelos de produção

| Modelo (tipos de peça)                               | Etapas (dependências por posição)                                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reforma de sofá (sofá, canto alemão)                 | 1 Desmontagem (apoio, opcional) · 2 Preparação (apoio) [1] · 3 Corte de tecido (principal, materiais) · 4 Costura (principal, materiais) [3] · 5 Montagem (principal, materiais) [2, 4] · 6 Acabamento (principal) [5] |
| Cabeceira (cabeceira)                                | 1 Preparação do MDF (apoio, materiais) · 2 Corte de espuma (apoio, materiais) · 3 Revestimento (principal, materiais) [1, 2] · 4 Montagem (principal) [3] · 5 Acabamento (principal) [4]                               |
| Cadeira ou poltrona (cadeira, poltrona, pufe, banco) | 1 Desmontagem (apoio, opcional) · 2 Preparação (apoio) [1] · 3 Corte (principal, materiais) · 4 Costura (principal, materiais) [3] · 5 Montagem (principal, materiais) [2, 4] · 6 Acabamento (principal) [5]           |

- Etapas opcionais não são geradas para peças de **fabricação**; as dependências que passavam por
  elas são refeitas transitivamente (nenhuma tarefa desnecessária).
- Uma etapa só pode depender de etapas anteriores do mesmo modelo (validado na API e no banco
  de forma indireta: o DAG resultante é acíclico).
- O gestor adapta cada OS no planejamento (retirar, incluir, reorganizar dependências); o modelo
  não é alterado por isso.

## 6. Banco e migrations

Migration nova e aditiva `20261010000000_producao` (nenhuma migration antiga alterada;
checksums preservados; nada apagado):

| Tabela                          | Conteúdo / garantias                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production_templates`/`_steps` | Modelos e etapas (posição única por modelo)                                                                                                                                                                                                                                                  |
| `production_plans`              | Uma por semana (`week_start` único, CHECK segunda-feira), status, revisão, publicação consistente (CHECK), `version`                                                                                                                                                                         |
| `production_plan_items`         | OS da semana (única por planejamento), responsável principal, prioridade                                                                                                                                                                                                                     |
| `production_plan_revisions`     | Revisão numerada (única), motivo, `off_schedule`, _snapshot_ JSON — **imutável** (trigger)                                                                                                                                                                                                   |
| `production_tasks`              | Código sequencial, OS/peça, etapa, papel, responsável, prioridade, horário, prazo, status, bloqueios, pausa, andamento, conclusão (usuário/dispositivo), `version`; CHECKs de execução, responsável ao iniciar e progresso 0–100; índices por OS, responsável+status, planejamento e horário |
| `production_task_dependencies`  | DAG (chave composta, sem autodependência por CHECK, cascata ao excluir rascunho)                                                                                                                                                                                                             |
| `production_task_events`        | Histórico da tarefa (de/para, nota, mudanças, usuário, dispositivo) — **imutável** (trigger)                                                                                                                                                                                                 |

A migration também insere os três modelos padrão e concede `producao.*` ao Gestor e
`producao.executar` às três funções da oficina. O seed recria os modelos se não houver nenhum.
Testado: migrations aplicadas do zero (E2E e testes) e restauração do backup com dados da Fase 5.

## 7. APIs (`/api/v1`)

| Rota                                                                                       | Permissão                   | Observações                                                         |
| ------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------- |
| `GET/POST /production-templates`, `PUT /production-templates/:id`                          | ver / planejar              | Versão otimista no PUT                                              |
| `GET /production/workers`                                                                  | ver                         | Funcionários ativos com `producao.executar` (marca tapeceiros)      |
| `GET /production-plans?week=`, `GET /production-plans/:id`                                 | ver                         | Com tarefas, conflitos e revisões                                   |
| `POST /production-plans`                                                                   | planejar                    | Idempotente; uma por semana (409)                                   |
| `GET /production-plans/:id/candidates`                                                     | planejar                    | OS abertas com prontidão                                            |
| `POST /production-plans/:id/items` · `PUT …/items/:itemId` · `POST …/items/:itemId/remove` | planejar                    | Inclusão idempotente; motivo obrigatório após publicar              |
| `POST /production-plans/:id/publish`                                                       | planejar                    | Idempotente; versão                                                 |
| `POST /production-plans/:id/tasks`                                                         | planejar                    | Etapa avulsa (idempotente)                                          |
| `PUT /production-tasks/:id` · `PUT /production-tasks/:id/dependencies`                     | planejar                    | Versão; ciclos recusados (422)                                      |
| `POST /production-tasks/:id/cancel` · `/block` · `/unblock`                                | planejar                    | Motivo obrigatório                                                  |
| `GET /production-board`                                                                    | ver                         | Filtros: período, pessoa, OS, planejamento, status, etapa           |
| `GET /service-orders/:id/production`                                                       | ver                         | Aba Produção da OS                                                  |
| `GET /production-tasks/mine`                                                               | executar                    | `{ today, upcoming }`, ordenadas por situação, prioridade e horário |
| `GET /production-tasks/:id`                                                                | ver ou responsável          | Detalhe técnico sem valores; `can` com as ações permitidas          |
| `POST /production-tasks/:id/start` · `/complete`                                           | executar (só o responsável) | Idempotentes (`Idempotency-Key`); repetição não gera novo evento    |
| `POST /production-tasks/:id/pause` · `/resume` · `/progress`                               | executar (só o responsável) | Pausa com motivo; andamento preservado                              |

Erros seguem o padrão existente (400 validação, 403 permissão/tarefa de outro, 404, 409 versão
ou duplicidade, 422 regra de negócio com o motivo do bloqueio).

## 8. Telas administrativas

- **Planejamento de produção** — semana, rascunho, OS candidatas, diálogo de inclusão
  (principal, prioridade, dia), tabela de tarefas editável por OS, dependências, conflitos,
  revisar e publicar, motivo obrigatório depois de publicado, histórico de revisões.
- **Quadro de produção** — filtros por período, funcionário, OS/cliente, etapa e status;
  agrupamento por funcionário, OS, etapa, status ou dia; contagens por situação.
- **Detalhe da tarefa** — dados, bloqueios, pausa, dependências e dependentes, materiais com
  situação, tarefas da OS, histórico; ações: reprogramar/editar, dependências,
  bloquear/desbloquear e cancelar (com motivo).
- **Modelos de produção** — edição das etapas, papéis, materiais, opcionais e dependências.
- **OS** — aba **Produção** ativa (substitui as abas futuras "Programação"/"Produção");
  prontidão "Programação" passa a refletir planejamento publicado.
- Menu: "Planejamento de produção", "Quadro de produção" e "Modelos de produção" por permissão;
  "Programação semanal" e "Produção" saíram da lista de módulos indisponíveis.

## 9. Telas dos tablets

- Tela inicial: bloco **Minhas tarefas** com a contagem de hoje (atualiza em tempo real); o bloco
  "Disponível na próxima fase" de tarefas foi substituído. Presença e Ocorrências continuam
  indisponíveis.
- **Lista**: hoje por prioridade (em execução primeiro) e próximos dias; cartões com OS, peça,
  etapa, prazo, prioridade, status e o motivo de espera quando bloqueada.
- **Detalhe**: botões grandes (Iniciar, Registrar andamento, Pausar, Retomar, Concluir) conforme
  o estado; pausa com quatro botões de motivo; andamento com 25/50/75% e texto curto; confirmação
  da conclusão mostrando quem será liberado; instruções, dependências, peças com tecido/espuma e
  medidas, fotos, materiais (sem preços) e histórico. Sem formulários longos e sem cronômetro.

## 10. Permissões

| Permissão           | Padrão                                            | Permite                                                                                                 |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `producao.ver`      | Gestor                                            | Ver planejamentos, quadro, modelos e qualquer tarefa                                                    |
| `producao.planejar` | Gestor (crítica)                                  | Planejar, publicar, alterar prioridade, horário, responsável, dependências, bloquear, cancelar, modelos |
| `producao.executar` | Gestor, Tapeceiro, Cabeceiras/Qualidade, Ajudante | Ver e executar **apenas as próprias** tarefas                                                           |

Toda ação de execução confere no servidor que o usuário é o responsável (403 caso contrário);
nem o gestor executa pelo funcionário. O tablet não recebe tarefas nem eventos de outra pessoa.

## 11. Eventos em tempo real

`production.plan_created`, `plan_updated`, `plan_published`, `plan_revised`, `task_assigned`,
`task_released`, `task_blocked`, `task_started`, `task_progress`, `task_paused`, `task_resumed`,
`task_completed`, `task_cancelled`, `dependencies_updated` e `template_changed` — gravados na
mesma transação (outbox), para a gestão (`producao.ver`/`producao.planejar`) e para o responsável
(`user:<id>`); só identificadores e situações, nunca valores. A mudança de prontidão de materiais
(`material.readiness_changed`) também atualiza as telas de produção. Na reconexão, o hub reenvia
os eventos perdidos e o tablet recarrega as tarefas (testado com o tablet do Márcio desligado
durante a liberação).

## 12. Testes e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                          | Resultado                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API — integração (Vitest, 19 arquivos)                         | **142/142** (130 das Fases 1–4 + 12 novos: 10 de produção + 2 de tempo real) |
| Pacote compartilhado — unitários                               | **29/29** (24 + 5 novos)                                                     |
| Web — unitários                                                | **6/6**                                                                      |
| E2E Playwright (build de produção, painel e tablets separados) | **13/13** (12 das Fases 1–4 + 1 novo com painel e dois tablets)              |
| Backup + restauração (agora com dados da Fase 5)               | **aprovado**                                                                 |
| Prettier, ESLint, typecheck dos 5 pacotes, build de produção   | **sem erros** (`pnpm check` com saída 0)                                     |

Depois do `pnpm check`, só mudaram specs E2E e a tabela do planejamento (`planning-page.tsx`):
o E2E completo foi executado de novo (13/13) e a tabela foi revalidada com typecheck, lint,
Prettier e o E2E de produção.

| Cenário exigido                    | Onde                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Planejamento de sexta-feira     | `production.test.ts` — "sexta-feira (dia configurado)…"                                                                                    |
| 2. Planejamento em outro dia       | `production.test.ts` — "em outro dia: permitido e registrado como fora da rotina…"                                                         |
| 3. Rascunho                        | `production.test.ts` (tarefas `RASCUNHO` invisíveis nos tablets), `production.spec.ts`                                                     |
| 4. Publicação                      | `production.test.ts`, `production.spec.ts`                                                                                                 |
| 5. Revisão com histórico           | `production.test.ts` (snapshot anterior, motivo obrigatório, imutável), `production.spec.ts`                                               |
| 6. OS com material incompleto      | `production.test.ts` — corte/costura bloqueados; desmontagem liberada; chegada libera                                                      |
| 7. OS com material completo        | `production.test.ts` — corte liberado na publicação                                                                                        |
| 8. Iniciar antes da programação    | `production.test.ts` — 422 "horário"; rascunho/bloqueada também recusados                                                                  |
| 9. Tarefas simultâneas             | `production.test.ts` (João e Ricardo), `production.spec.ts` (João e Márcio)                                                                |
| 10. Dependência de duas tarefas    | `production.test.ts` — montagem espera preparação **e** costura                                                                            |
| 11. Ciclo recusado                 | `production.test.ts`, `shared/production.test.ts`                                                                                          |
| 12. Responsável principal por sofá | `production.test.ts` — obrigatório, tapeceiro, troca leva as tarefas principais                                                            |
| 13. Início pelo tablet             | `production.test.ts`, `production.spec.ts`                                                                                                 |
| 14. Pausa e retomada               | `production.test.ts` (andamento preservado; "outro" exige texto), `production.spec.ts`                                                     |
| 15. Conclusão                      | `production.test.ts` (usuário, dispositivo, auditoria), `production.spec.ts`                                                               |
| 16. Liberação automática           | `production.test.ts`, `production-realtime.test.ts`, `production.spec.ts`                                                                  |
| 17. Conclusão duplicada            | `production.test.ts` — mesma chave e chaves diferentes: um só evento e uma só liberação                                                    |
| 18. Atualizações simultâneas       | `production.test.ts` — conclusões simultâneas das duas dependências; dois "iniciar"; duas edições do gestor com a mesma versão (200 + 409) |
| 19. Permissões                     | `production.test.ts` (tablet, consulta, tarefa de outro, fotos), `production.spec.ts` (403 no tablet do Márcio)                            |
| 20. Sincronização entre tablets    | `production-realtime.test.ts`, `production.spec.ts` (liberação aparece sem recarregar)                                                     |
| 21. Reconexão                      | `production-realtime.test.ts` — liberação ocorrida com o tablet offline é recuperada                                                       |
| 22. Regressão das Fases 1 a 4      | todas as suítes anteriores executadas e aprovadas (ver tabela acima)                                                                       |

## 13. Defeitos encontrados e corrigidos

1. **Modelos ausentes nos testes**: o `resetDatabase` dos testes apaga `production_templates` e
   nenhuma tarefa era gerada. Os modelos padrão passaram a viver no pacote compartilhado
   (`DEFAULT_PRODUCTION_TEMPLATES`), usados pela migration, pelo seed e pela recriação nos testes.
2. **Item de menu ativo duplicado**: "Quadro de produção" (`/painel/producao`) ficava ativo junto
   com "Planejamento de produção" (prefixo). O menu agora marca apenas o item de prefixo mais longo.
3. **Teste fraco de fotos**: a verificação de acesso às fotos usava o id da tarefa como id da OS;
   corrigido para a OS real, com 200 para o responsável e 403 para quem não tem tarefa na OS.
4. **Teste de backup**: o planejamento fictício colidia com a semana existente no banco de
   origem (semana única) sem falhar o script; agora usa uma semana distante e `ON_ERROR_STOP`.
5. **Nome de dispositivo repetido no E2E**: o novo E2E cadastrava "Tablet Márcio", nome já usado
   por `tablet-sync.spec.ts` (nomes são únicos), e aquele teste falhava ao gerar o código. O novo
   E2E passou a usar "Tablet João (produção)" e "Tablet Márcio (produção)".
6. Asserções que mudaram por regra desta fase (não são defeitos): teste da Fase 4 "sem rota de
   produção", E2E da Fase 4 "aba Produção bloqueada", E2E da Fase 1 "Programação semanal
   indisponível" e o valor `FASE_FUTURA` da programação da OS (teste da Fase 2 e E2E comercial) — atualizados com justificativa.

## 14. Pendências e riscos

**Pendências das fases anteriores (seção 19 da especificação):**

| Pendência                                                   | Avaliação                                                                                                                                                           | O que foi feito nesta fase                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancelamento de OS com compras e reservas                   | Reservas ficavam presas a uma OS cancelada; tarefas poderiam ser executadas                                                                                         | **Proteção mínima, aditiva e testada**: ao cancelar, na mesma transação, tarefas abertas são canceladas (rascunhos removidos), a OS sai dos rascunhos e as reservas ativas são liberadas com movimentação e evento. Compras já feitas **não** são canceladas automaticamente (o gestor decide no pedido). |
| Estorno de recebimento físico de peças de clientes (Fase 2) | Não existe rota de estorno; sem risco de corrupção. A liberação exige peça recebida                                                                                 | Nada alterado; **continua pendente** para remediação específica (estorno compensatório e efeito sobre OS/tarefas).                                                                                                                                                                                        |
| Pedido de compra parcialmente recebido sem entrega do saldo | O pedido fica `PARCIALMENTE_RECEBIDO` indefinidamente; a prontidão segue "aguardando recebimento" (lado seguro: as etapas que exigem material continuam bloqueadas) | Nada alterado; **continua pendente**: encerrar o saldo com motivo e recalcular prontidão/compras.                                                                                                                                                                                                         |

**Riscos e decisões:**

- A liberação por horário roda a cada 30 s em cada instância da API (idempotente e sob bloqueio
  das linhas); uma tarefa pode aparecer liberada até 30 s depois do horário.
- O motor considera "materiais completos" no nível da OS (prontidão da Fase 4), não por etapa
  ou material específico.
- O aviso "mesmo horário" é só um alerta: o gestor pode programar várias tarefas na mesma hora.
- Materiais recebidos de compras de uma OS cancelada continuam vinculados a ela (sobra) —
  tratamento junto com a pendência de cancelamento completo.
- Nenhum deploy foi feito.

## 15. Evidências dos fluxos principais

E2E `production.spec.ts` (build de produção, servidores reais; painel e **dois tablets em
sessões separadas**): o gestor cria o planejamento da semana, inclui a OS com Márcio como
tapeceiro principal (corte e costura com ele, apoio sem responsável), retira a desmontagem,
atribui a preparação ao João, inclui um revestimento do Márcio dependente da preparação e
publica (revisão 1). Os tablets recebem as tarefas sem recarregar e cada um vê só as suas; o
revestimento do Márcio aparece "Ainda não liberada" sem botão Iniciar, e o tablet do Márcio
recebe 403 ao tentar iniciar a tarefa do João. João inicia, registra 50%, pausa ("Fim do
expediente"), retoma e conclui; **no tablet do Márcio a tarefa passa a "Liberada" e o botão
Iniciar aparece sem recarregar**; Márcio inicia. O quadro mostra concluída/em execução, o
detalhe da tarefa mostra o histórico, a OS mostra a aba Produção e uma alteração posterior com
motivo gera a revisão 2.

Capturas (dados fictícios) em [`docs/evidencias/fase-5/`](evidencias/fase-5/): planejamento em
rascunho e publicado, lista do tablet do Márcio, tablet do João com a tarefa pausada, tablet do
Márcio com a tarefa liberada, quadro de produção, detalhe da tarefa e histórico de revisões.

## 16. Próximos passos (aguardando autorização)

1. Remediação específica das pendências: estorno de recebimento de peças (Fase 2), encerramento
   de saldo de pedido parcialmente recebido e tratamento completo de compras/sobras de OS
   cancelada.
2. Fase 6 — somente após autorização (presença operacional, distribuição de ajudantes, central
   de atenção e qualidade continuam fora do escopo e não foram implementadas).
3. Executar o CI no GitHub e definir hospedagem (nenhum deploy realizado).
