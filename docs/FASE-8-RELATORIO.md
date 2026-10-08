# Fase 8 — Distribuição automática de ajudantes e reprogramação inteligente: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)             |
| SHA inicial (fim da Fase 7)    | `7af003f` (relatório) — último código da Fase 7: `57e777d`                                  |
| Commits da Fase 8              | `ddb9c32` (banco, domínio, API, motor, testes de API), `5b4057f` (telas, E2E, documentação) |
| SHA final do código verificado | `5b4057f` — este relatório é o commit seguinte (só o relatório)                             |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `7af003f`.
- Relatórios das Fases 1–7 lidos; schema, migrations, motor de liberação (Fase 5), tablets e avisos
  (Fase 6), presença e impactos (Fase 7), permissões, eventos e hub de tempo real inspecionados.
- O PostgreSQL do contêiner estava parado; foi iniciado (`service postgresql start`) antes da linha
  de base.
- **Linha de base antes de qualquer alteração** (PostgreSQL 16 real): `pnpm check` aprovado — API
  **163/163**, compartilhado **33/33**, web **6/6**, formatação, lint e typecheck sem erros.
- **E2E de linha de base: 14/15.** A 1ª tentativa falhou no `next build` por duas compilações
  simultâneas no mesmo diretório (execução duplicada minha, não defeito do código); a 2ª, às 10h44
  (São Paulo), teve **1 falha**: o E2E de presença da Fase 7 esperava "Não confirmou chegada" para o
  Márcio, mas a verificação periódica (relógio real, depois das 9h30 de dia útil) já o havia marcado
  como ausência presumida. Além do _skip_ entre 22h e 02h, o teste dependia do horário real — é o
  defeito que a Fase 8 manda corrigir (seção 13).
- **Divergências registradas:**
  1. A disponibilidade da Fase 7 é **derivada** (não há entidade separada); o motor da Fase 8 lê a
     presença do dia e as tarefas, sem duplicar estado.
  2. O gestor tem todas as permissões e registro de funcionário; a "equipe" candidata a ajudante é a
     mesma da presença (quem registra presença sem gerenciá-la): Ricardo, Márcio, Thiago e João.
  3. "HelpAssignment" e "RescheduleDecision" sugeridos como entidades: a atribuição fica no próprio
     pedido (ajudante, tarefa de apoio, data) com o histórico imutável em `help_request_events`
     (inclusive a avaliação de cada candidato); a decisão fica na proposta (quem, quando, alternativa,
     ajuste, motivo) e em `planning_actions`. Evita duas fontes de verdade.
  4. "AutomaticPlanningAction" foi implementada como `planning_actions`, cobrindo ações automáticas
     **e** aprovadas (o histórico pedido é único: quem, quando, por quê).
  5. Competências não existiam: foram criadas e semeadas por função (seção 7); o gestor ajusta.

## 3. Estruturas reutilizadas

- **Motor de liberação** (`reevaluateTasks`/`evaluateRelease`, Fase 5): única via de liberação; a
  tarefa de apoio passa por ele (dispensada só da exigência de "programação publicada", pois nasce
  de uma tarefa principal já liberada). Ganhou um ouvinte `onTaskBlocked` (tarefa que estava
  liberada/programada e fica bloqueada).
- **Revisão da programação publicada** (Fase 5): `reviseIfPublished` passou a delegar a
  `reviseIfPublishedBy` (sem requisição), usada pelas mudanças automáticas e aprovadas.
- **Tarefas** (`production_tasks`): a tarefa de apoio é uma tarefa comum (atividade `APOIO`) com
  `support_for_task_id` e `estimated_minutes` — aparece no Meu dia, no quadro, no detalhe e usa
  Iniciar/Concluir já existentes.
- **Presença** (Fase 7): `attendanceConfig`, `team`, `notifyManagers`, `detectAbsences`,
  impactos (`attendance_impacts`) e o relógio injetável `setAttendanceClock` (base do relógio de
  teste).
- **Avisos persistentes, eventos (outbox), WebSocket com reenvio, auditoria, idempotência,
  versões e bloqueios** (Fases 1 e 6).
- **Telas**: `Section`, `Tabs`, `Dialog`, `Badge`, `Button` (tamanho `xl` dos tablets), `useSend`.

## 4. Funcionalidades

**Tablet**

- **Solicitar ajudante** (tarefa própria liberada, em execução ou pausada — nunca numa tarefa de
  apoio): tipo em botões grandes (parafusar estrutura, movimentar sofá, auxiliar montagem,
  virar/posicionar peça, outro apoio), duração sugerida (20/10/30/10/15 min) com ajuste em
  botões, observação opcional.
- **Preciso de ajuda agora**: o mesmo formulário com justificativa curta obrigatória (também
  exigida pela API e por CHECK no banco); prioridade na fila; alerta ao gestor.
- Acompanhar o pedido ("Na fila", "João vai ajudar", "Thiago está ajudando", "Encaminhado ao
  gestor", "Apoio concluído por João"), **cancelar** enquanto o apoio não começou e "Meus pedidos de
  ajuda" no Meu dia.
- **Receber, iniciar e concluir o apoio**: o ajudante vê "Apoio para Ricardo · TP-00013 · 30 min"
  no cartão e no detalhe; Iniciar/Concluir de sempre. Concluir o apoio conclui o pedido e avisa
  quem pediu — **a tarefa principal continua com ele**.
- **Mudanças de programação** chegam como avisos (automática, aprovada, rejeitada, tarefa
  alternativa liberada) e o Meu dia atualiza em tempo real.
- **Tarefas alternativas**: tarefa bloqueada ou parada por impedimento mostra "Enquanto isso, você
  pode fazer" com as tarefas próprias já liberadas ou prontas para hoje (só consulta; nada inicia).

**Painel**

- **Pedidos de ajuda** (`/painel/ajuda`): abas pendentes, atribuídas, em execução, concluídas,
  canceladas e escaladas (com contagem); detalhe com histórico e a **avaliação de cada candidato**
  (elegível ou motivos, observações e impacto); cancelar; "Reavaliar fila".
- **Reprogramação** (`/painel/reprogramacao`): propostas com situação, problema, tarefas
  afetadas, alternativas (impactos, crítica, proposta) e ação proposta; **aprovar** (qualquer
  alternativa), **ajustar** (responsável, data e hora, com motivo) ou **rejeitar** (com motivo);
  aba de decididas e **histórico de alterações** automáticas e aprovadas (quem, quando, por quê).
- **Competências da equipe** (`/painel/competencias`).
- Integração: aviso de decisões pendentes, pedidos aguardando e apoios em andamento no **quadro** e
  no **planejamento**; selo "Apoio para …" nas linhas do quadro.

**Fila de ajuda**: pedidos sem ajudante ficam pendentes, o solicitante é avisado uma vez e a fila
é reavaliada a cada mudança de disponibilidade (chegada, saída, início/pausa/conclusão de tarefa,
decisão do gestor, competências) e a cada 30 s; duplicidade impedida (um pedido aberto por pessoa
e tarefa; "agora" sobre um pedido na fila só o torna urgente); risco de atraso avisado ao gestor uma
vez (5 min urgente, 20 min normal). Nenhuma previsão de disponibilidade é inventada.

## 5. Motor de distribuição

Determinístico e auditável (`modules/help/engine.ts`, `help-domain.ts`); cada tentativa grava todos
os candidatos com motivos e pontuação.

| Verificação                   | Resultado                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Competência exigida pelo tipo | sem ela → **Sem a competência exigida** (nunca escolhido)                                                                                                       |
| Presença do dia (Fase 7)      | sem chegada → **Não confirmou chegada**; ausência/folga/férias/atestado → **Ausente**; externo → **Em atividade externa**; encerrado → **Expediente encerrado** |
| Tarefa em execução            | prioridade ALTA/URGENTE ou apoio → **Com tarefa importante** (nunca interrompida); senão **Com tarefa em execução** (só o gestor pode mandar interromper)       |
| Outro apoio atribuído         | **Ocupado**                                                                                                                                                     |
| Agenda e prazos               | tarefa ALTA/URGENTE programada dentro da janela do apoio ou tarefa urgente liberada aguardando → **Tarefa prioritária**                                         |
| Impacto (menor = melhor)      | +10 especialidade preservada (cabeceiras/reparos/inspeção), +5 por tarefa própria na janela, +3 se há tarefa liberada esperando, +2 por tarefa pausada          |
| Empate                        | ordem alfabética do nome                                                                                                                                        |

Assim, para apoio geral em condições iguais, o **João** é escolhido e o **Thiago** fica preservado
para cabeceiras, reparos e inspeções (teste 5: João 3, Thiago 13). Atribuições são serializadas
(lock de transação global) — pedidos simultâneos nunca recebem o mesmo ajudante (teste 9). Pedido
**urgente** sem ninguém livre, com alguém em tarefa não crítica, vira proposta ao gestor (interromper
ou aguardar); rejeitada, o pedido volta à fila e não é escalado de novo.

## 6. Regras de reprogramação

**Simples — executada automaticamente** (registrada em `planning_actions` com o motivo, evento na
tarefa, revisão da programação publicada e aviso):

1. **Tarefa bloqueada** (ou pausada por impedimento) de quem está presente e sem tarefa em execução:
   se já há outra tarefa própria liberada, ela é **indicada**; senão, a próxima tarefa própria
   **pronta para hoje** (programada, sem bloqueio técnico, materiais e dependências ok) é
   **antecipada para agora**. Mesmo responsável (capacitado), prazo não comprometido (só antecipa),
   prioridade maior não prejudicada. Nunca inicia nada; o andamento da tarefa bloqueada é mantido.
2. **Ausência confirmada** (ou justificada, folga, férias, atestado, externo): tarefas de **apoio**
   (não principais), prioridade até normal, sem prazo hoje e sem bloqueio técnico passam para alguém
   **presente, livre e capacitado** (mesmo motor da ajuda).
3. **Encaixe do apoio**: a tarefa de apoio é criada liberada no intervalo livre do ajudante.

**Crítica — só com aprovação do gestor** (proposta; nada é aplicado antes): interromper tarefa em
execução para ajuda urgente; trocar o tapeceiro principal; tarefa de prioridade alta/urgente;
reprogramação que compromete prazo interno ou entrega prometida ao cliente; qualquer mudança em
ausência presumida. A proposta mostra situação, problema, tarefas afetadas (inclusive dependentes de
outras pessoas), alternativas com impactos e a ação proposta; uma por fato (chave única).

**Ausências (integração com a Fase 7)**: presumida → proposta só com "aguardar" recomendado e as
alternativas (nada é transferido); confirmada → as mudanças simples acima + proposta para o restante
(redistribuir, trocar principal, reprogramar para o próximo dia útil, manter); chegada (pelo tablet
ou registrada pelo gestor) → propostas pendentes daquela ausência ficam **sem efeito**, sem gerar
nova proposta.

## 7. Banco e migrations

Migration **aditiva** `20261013000000_ajuda_reprogramacao` (nenhuma migration antiga alterada, nada
apagado):

| Tabela / coluna                                             | Conteúdo                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `employee_skills`                                           | Funcionário + competência (PK), quem concedeu; CHECK da lista                                                                                                                                                                                                                                    |
| `help_requests` (AJ-00001)                                  | Tarefa, OS, solicitante, tipo, minutos (5–240), urgente + justificativa (CHECK), observação, status, ajudante, tarefa de apoio (única), datas de atribuição/escalada/alerta/conclusão/cancelamento, versão; CHECKs de coerência; **índice único parcial** — um pedido aberto por pessoa e tarefa |
| `help_request_events`                                       | Histórico **imutável** (trigger) com a avaliação dos candidatos                                                                                                                                                                                                                                  |
| `reschedule_proposals` (RP-00001)                           | Tipo, status, crítica, situação, problema, tarefas afetadas, alternativas, proposta/escolhida, ações aplicadas, `dedupe_key` única, ausência/pedido ligados, decisão (quem, quando, nota), versão                                                                                                |
| `planning_actions`                                          | Histórico **imutável** (trigger) de toda alteração automática ou aprovada                                                                                                                                                                                                                        |
| `production_tasks.estimated_minutes`, `support_for_task_id` | Duração e vínculo da tarefa de apoio com a principal (FK, CHECKs)                                                                                                                                                                                                                                |

Também: `ajuda.solicitar` para Gestor, tapeceiros e cabeceiras/qualidade; competências iniciais
por função (ajudante: parafusar, movimentar, auxiliar montagem, posicionar, apoio geral,
desmontagem, preparação; cabeceiras/qualidade: as mesmas + cabeceiras, reparos, instalações,
inspeção; tapeceiro: corte/costura) — na migration e no seed. Concorrência: `FOR UPDATE` nos pedidos,
tarefas e propostas, lock global nas atribuições, versão nas decisões; idempotência nas rotas de
criação e decisão; transações em toda mudança.

## 8. APIs (`/api/v1`)

| Método e rota                                                    | Uso                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /help-requests`                                            | Solicitar (normal/urgente) e atribuição automática imediata               |
| `GET /help-requests/mine`                                        | Meus pedidos (abertos e encerrados hoje)                                  |
| `GET /help-requests?status=`                                     | Fila por status (painel)                                                  |
| `GET /help-requests/:id`                                         | Consultar (solicitante, ajudante ou gestão), com histórico                |
| `POST /help-requests/:id/cancel`                                 | Cancelar (solicitante antes do início, ou gestor)                         |
| `POST /help-requests/process`                                    | Reavaliar a fila (atribuição automática)                                  |
| `POST /production-tasks/:id/start` e `/complete`                 | Iniciar e concluir o apoio (rotas existentes, agora sincronizam o pedido) |
| `GET /production-tasks/alternatives`                             | Tarefas alternativas do próprio funcionário                               |
| `GET /skills`, `PUT /employees/:id/skills`                       | Competências                                                              |
| `GET /reschedule-proposals?status=`, `GET /:id`                  | Sugestões de reprogramação                                                |
| `POST /reschedule-proposals/:id/approve` · `/adjust` · `/reject` | Decisão do gestor                                                         |
| `GET /planning-actions?automatic=`                               | Histórico de alterações                                                   |
| `POST /api/test/clock`, `POST /api/test/attendance/check`        | Relógio de teste — **só** com `ENABLE_TEST_CLOCK` em `APP_ENV=test`       |

## 9. Telas

- **Tablet**: painel "Ajuda" no detalhe da tarefa (Solicitar ajudante / Preciso de ajuda agora,
  formulário com botões grandes, cartão do pedido com Cancelar), "Meus pedidos de ajuda" no Meu dia,
  selo "Apoio para …" nos cartões e no detalhe, "Enquanto isso, você pode fazer". Sem valores
  financeiros (verificado no E2E).
- **Painel**: Pedidos de ajuda, Reprogramação (aguardando decisão, decididas, histórico), Competências
  da equipe; aviso no quadro e no planejamento; selo de apoio no quadro; três novas entradas no menu.
- **Presença da equipe** passou a abrir no "hoje" do servidor (relógio operacional), em vez da data
  do navegador.

## 10. Permissões (sempre verificadas no servidor)

| Ação                                                                               | Exige                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pedir ajuda / cancelar o próprio pedido                                            | `ajuda.solicitar` + ser o responsável pela tarefa (tablet ou painel)                                |
| Consultar um pedido                                                                | Solicitante, ajudante ou `producao.ver`/`producao.planejar` (no tablet sem a avaliação dos colegas) |
| Iniciar/concluir apoio                                                             | `producao.executar` + ser o ajudante                                                                |
| Fila, propostas, histórico, competências (ver)                                     | `producao.ver` ou `producao.planejar`, sessão do painel                                             |
| Decidir propostas, reavaliar fila, alterar competências, cancelar pedido de outros | `producao.planejar`, sessão do painel                                                               |
| Relógio de teste                                                                   | `ENABLE_TEST_CLOCK` + `APP_ENV=test` + `presenca.gerenciar` no painel                               |

O ajudante (João) não pede ajuda; tapeceiros e cabeceiras pedem só nas próprias tarefas.

## 11. Eventos

Domínio (outbox + WebSocket, com reenvio na reconexão): `help.requested`, `help.assigned`,
`help.queued`, `help.escalated`, `help.cancelled`, `help.started`, `help.completed` (gestão,
solicitante e ajudante); `help.skills_changed`, `reschedule.proposed`, `reschedule.decided`,
`planning.action_recorded` (gestão). Tarefas continuam com os eventos da Fase 5.

Avisos persistentes (chave de deduplicação — o mesmo fato nunca repete): ajuda solicitada, atribuída,
em espera, cancelada, concluída; reprogramação pendente (gestor), aprovada, automática, rejeitada;
tarefa alternativa liberada.

## 12. Testes e resultados (08/10/2026, PostgreSQL 16 real)

**Final:** `pnpm check` aprovado — API **191/191** (163 anteriores + 28 da Fase 8 em
`apps/api/test/help.test.ts`), compartilhado **33/33**, web **6/6**, formatação, lint e typecheck sem
erros. **E2E completo 16/16** (nenhum ignorado). `pnpm test:backup` aprovado com as tabelas da Fase 8
e as travas de imutabilidade/justificativa conferidas no banco restaurado.

| #   | Cenário                          | Teste (API, `help.test.ts`) e E2E                                                   | Resultado |
| --- | -------------------------------- | ----------------------------------------------------------------------------------- | --------- |
| 1   | Solicitação normal               | 1 (+ E2E passo 2)                                                                   | ✔        |
| 2   | Solicitação urgente              | 2, 2b (+ E2E passo 6)                                                               | ✔        |
| 3   | João disponível                  | 3                                                                                   | ✔        |
| 4   | Thiago disponível                | 4                                                                                   | ✔        |
| 5   | Ambos disponíveis                | 5 (João 3 × Thiago 13; + E2E passo 2)                                               | ✔        |
| 6   | Ambos ocupados                   | 6 (fila, aviso único, alerta de atraso, atribuição ao liberar) + E2E passo 6        | ✔        |
| 7   | Funcionário ausente              | 7                                                                                   | ✔        |
| 8   | Sem competência                  | 8                                                                                   | ✔        |
| 9   | Solicitações simultâneas         | 9                                                                                   | ✔        |
| 10  | Cancelamento                     | 10                                                                                  | ✔        |
| 11  | Conclusão de apoio               | 11 (+ E2E passo 3)                                                                  | ✔        |
| 12  | Tarefa principal independente    | 12 (+ E2E passo 3)                                                                  | ✔        |
| 13  | Reprogramação simples            | 13 (redistribuição na ausência confirmada) e 19 (antecipação)                       | ✔        |
| 14  | Reprogramação crítica            | 14                                                                                  | ✔        |
| 15  | Aprovação do gestor              | 15 (com ajuste), 2b (interrupção aprovada) + E2E passo 7                            | ✔        |
| 16  | Rejeição                         | 16                                                                                  | ✔        |
| 17  | Ausência presumida               | 17                                                                                  | ✔        |
| 18  | Chegada tardia                   | 18                                                                                  | ✔        |
| 19  | Tarefa bloqueada                 | 19, 19b (pausa por impedimento)                                                     | ✔        |
| 20  | Materiais indisponíveis          | 20                                                                                  | ✔        |
| 21  | Dependências                     | 21                                                                                  | ✔        |
| 22  | Permissões                       | 22                                                                                  | ✔        |
| 23  | Concorrência                     | 23 (versão e decisões simultâneas) e 9                                              | ✔        |
| 24  | Idempotência                     | 24                                                                                  | ✔        |
| 25  | Sincronização                    | 25/26 (painel e tablets por WebSocket) + E2E (tablets atualizam sem recarregar)     | ✔        |
| 26  | Reconexão                        | 25/26 (reenvio de `help.cancelled` e do aviso após queda)                           | ✔        |
| 27  | Presença independente do horário | 27 (validação do ambiente, rotas, 8h30/9h31 fixos) + **E2E de presença sem _skip_** | ✔        |
| 28  | Regressão das Fases 1 a 7        | Suíte completa: API 163 anteriores, compartilhado, web, E2E das Fases 1–7, backup   | ✔        |

**E2E da Fase 8** (`tests/e2e/specs/team-help.spec.ts`, painel + tablets do Ricardo, do João e do
Thiago, sessões separadas): chegada dos três às 8h30 (relógio de teste) → Ricardo inicia a montagem e
pede ajudante (parafusar, 30 min) → João é escolhido, recebe o apoio em tempo real, inicia e conclui
→ Ricardo vê "Apoio concluído por João" e a montagem continua em execução → painel mostra o pedido
concluído com a avaliação dos candidatos → João e Thiago ocupados → "Preciso de ajuda agora" vai ao
gestor sem interromper ninguém → gestor aprova em Reprogramação → cabeceira do Thiago pausada
(interrupção programada) e apoio atribuído; Ricardo avisado → histórico, competências e quadro
conferidos → tudo encerrado ao final.

**E2E da Fase 7 reescrito** (`team-presence.spec.ts`): roda num dia operacional próprio com o
relógio de teste (8h00 → 8h30 Cheguei → 9h31 ausência presumida verificada na hora → 9h50 chegada
tardia), sem horários relativos e sem _skip_; validado às 11h–12h (horário em que a versão anterior
falhava) e passa em qualquer horário.

## 13. Defeitos corrigidos

1. **E2E de presença dependente do horário** (Fase 7): falhava depois das 9h30 de dia útil e era
   ignorado entre 22h e 02h. Corrigido com o relógio de teste controlável (seção 8), impossível fora
   de `APP_ENV=test`.
2. **Presença da equipe** abria na data do navegador; agora usa o "hoje" do servidor.
3. **Condição de corrida no E2E da Fase 6** (`tablets.spec.ts`): o aviso "Prioridade alterada" do
   Márcio era procurado sem filtro, e o spec da Fase 5 deixa outro aviso do mesmo tipo; dependendo de
   qual chegava primeiro, o seletor encontrava dois elementos. O teste passou a filtrar pela tarefa.
4. Durante o desenvolvimento (antes da entrega): `/help-requests/mine` comparava a data do relógio
   operacional com o `updatedAt` real; o rótulo da nova permissão ("Solicitar ajudante") colidia com
   o seletor "Ajudante" do E2E do painel (renomeado para "Pedir ajuda nas próprias tarefas"); o novo
   E2E criava o planejamento da semana antes do E2E da Fase 5 (renomeado para rodar depois); a
   limpeza do E2E tentava cancelar tarefas de outras OS; um pedido urgente rejeitado poderia ser
   escalado de novo a cada ciclo da fila (impedido: uma proposta por pedido).

## 14. Pendências

- O gestor não escolhe manualmente um ajudante específico fora das propostas (pode reavaliar a fila,
  ajustar competências ou decidir a proposta de interrupção).
- Tipos de proposta `BLOQUEIO` e `CONFLITO` ficam reservados (não são gerados): para tarefa bloqueada
  a regra simples já indica/antecipa; bloqueios sem alternativa seguem no quadro (central de atenção
  é da Fase 9).
- Limites de espera (5/20 min) e pesos da pontuação são constantes do código, documentadas; não são
  configuráveis no painel.
- A criação da tarefa de apoio não gera revisão da programação publicada (é registrada no histórico
  do planejamento e no da tarefa); mudanças em tarefas existentes geram revisão normalmente.
- O relógio de teste afeta presença, ausência e fila de ajuda; o horário das tarefas continua o real.
- Capturas de página inteira do tablet mostram o cabeçalho fixo sobreposto (só na captura).

## 15. Evidências

`docs/evidencias/fase-8/` (geradas com `E2E_EVIDENCE=1` só para os dois specs da Fase 8; as
evidências das fases anteriores não foram regeradas):

- `01-tablet-solicitar-ajudante.png`, `02-tablet-ajudante-a-caminho.png`,
  `03-tablet-joao-apoio-recebido.png`, `05-tablet-ajuda-urgente.png`,
  `07-tablet-thiago-apoio-aprovado.png`
- `04-painel-pedido-avaliacao.png`, `06-painel-proposta-critica.png`, `08-painel-historico.png`,
  `09-painel-competencias.png`
- `presenca-01` a `presenca-06`: E2E de presença com o relógio de teste.

Logs locais desta execução: linha de base, `pnpm check` final, E2E final (16/16) e backup.

## 16. Próximos passos (aguardando autorização)

A Fase 8 está concluída e **parada aqui**. Não houve deploy. Fase 9 (central de atenção), qualidade
final e financeiro **não** foram iniciados. Aguardo autorização para a Fase 9.
