# Fase 7 — Presença operacional e disponibilidade da equipe: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento) |
| SHA inicial (fim da Fase 6)    | `d6db039` (relatório) — último código da Fase 6: `6570d87`                      |
| Commits da Fase 7              | `1cd903b`, `e918590`, `57e777d` (banco, API, telas, testes, documentação)       |
| SHA final do código verificado | `57e777d` — este relatório é o commit seguinte (só o relatório)                 |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `d6db039`.
- Relatórios das Fases 1–6 lidos; schema Prisma, migrations, rotas, permissões, eventos, hub de
  tempo real, configurações da empresa e telas do tablet/painel inspecionados.
- **Linha de base antes de qualquer alteração** (PostgreSQL 16 real): `pnpm check` aprovado — API
  **152/152**, compartilhado **33/33**, web **6/6**, formatação, lint e typecheck sem erros; E2E
  completo **14/14**.
- **Já existia e foi reaproveitado:** em `company_settings`, `workday_start` (08:30),
  `arrival_alert_at` (09:30), `workday_end` (18:00) e `working_days` (Fase 1, já descritos como
  "controle operacional, não é ponto"); funcionários (`employees`) ligados a usuários e
  dispositivos; sessões persistentes de dispositivo e revogação (Fase 1); avisos persistentes e
  eventos/WebSocket com reenvio (Fases 1 e 6); tarefas e dependências (Fase 5).
- **Divergências registradas:**
  1. A tela Empresa rotulava `workday_start` como "“Cheguei” a partir de", mas a Fase 7 usa 8h30
     como **início previsto** (referência de atraso) com uma **janela** anterior para o botão.
     Solução aditiva: novo campo `arrival_window_start` (07:00); o rótulo antigo foi corrigido.
  2. O gestor tem registro de funcionário e todas as permissões; a "equipe" da presença foi
     definida como quem tem `presenca.registrar` **sem** `presenca.gerenciar` (os quatro
     funcionários). O gestor não registra presença.
  3. Os avisos (Fase 6) só tinham caixa no tablet; o gestor passou a ter o sino no painel.
  4. "EmployeeAvailability" sugerido como entidade: a disponibilidade é **derivada** (presença +
     tarefas + pausas + atividade externa) e o último valor fica no registro do dia
     (`availability`), evitando duas fontes de verdade.

## 3. Estruturas reutilizadas

| Já existia                                               | Uso na Fase 7                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| Horários e dias úteis da empresa (Fase 1)                | Início previsto, limite de ausência presumida, fim e dias úteis     |
| Funcionários, usuários, dispositivos (Fase 1)            | Registro por funcionário; dispositivo e usuário de cada confirmação |
| Sessão persistente de tablet e revogação remota (Fase 1) | "Cheguei" com um toque, sem PIN diário; revogação bloqueia na hora  |
| Outbox + WebSocket com audiência e reenvio               | Eventos `attendance.*` para a gestão e para o próprio funcionário   |
| Avisos persistentes (Fase 6)                             | Alertas ao gestor e recibos ao funcionário, sem duplicidade         |
| Tarefas, dependências e pausa (Fases 5/6)                | Impacto de ausência, disponibilidade e pausa no encerramento        |
| Auditoria imutável, idempotência, bloqueio de linha      | Todas as ações de presença                                          |

## 4. Banco e migrations

Migration nova e aditiva `20261012000000_presenca_operacional` (migrations antigas intactas):

| Objeto                    | Conteúdo / garantias                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operational_attendances` | Um por funcionário e data (único); situação, chegada (hora do servidor, tipo, minutos de atraso, quem, dispositivo), saída, observação, disponibilidade; CHECKs de coerência |
| `attendance_corrections`  | Histórico **imutável** (trigger): ação, justificativa, estado anterior e novo, autor, dispositivo                                                                            |
| `attendance_impacts`      | Tarefa do ausente, dependente afetada, andamento pendente; responsável afetado, prazo, detalhe, encaminhamento; único por dia/tarefa/tipo                                    |
| `company_settings` (+2)   | `arrival_window_start` (07:00) e `late_alert_minutes` (15), com CHECKs                                                                                                       |
| Permissões                | `presenca.ver`/`presenca.gerenciar` ao Gestor; `presenca.registrar` às funções da oficina                                                                                    |

Testado: aplicação do zero (testes e E2E), banco de desenvolvimento migrado e restauração do backup
com registro de presença e histórico imutável preservados.

## 5. APIs (`/api/v1`)

| Rota                                            | Permissão            | Observações                                                                                                                                                     |
| ----------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /attendance/me`                            | `presenca.registrar` | Situação do dia, configuração, se pode chegar/encerrar e tarefas em execução                                                                                    |
| `POST /attendance/me/arrive`                    | `presenca.registrar` | Um toque; horário do servidor; janela configurável; idempotente; repetição não duplica                                                                          |
| `POST /attendance/me/depart`                    | `presenca.registrar` | Andamento opcional por tarefa; pausa as em execução; pendência se faltar andamento; idempotente                                                                 |
| `GET /attendance/team?date=&employeeId=`        | `presenca.ver`       | Situação, chegada, atraso, tarefa atual e próxima, saída, alertas                                                                                               |
| `GET /attendance/history?employeeId=&from=&to=` | `presenca.ver`       | Histórico diário com todas as alterações (autor, dispositivo, motivo)                                                                                           |
| `POST /attendance/actions`                      | `presenca.gerenciar` | Confirmar ausência, justificada, atestado, folga, férias, trabalho externo, saída antecipada, chegada tardia, esquecimento, correção — sempre com justificativa |
| `GET /attendance/impacts?date=`                 | `presenca.ver`       | Tarefas afetadas, dependentes, responsáveis, prazos e encaminhamentos                                                                                           |
| `POST /attendance/impacts/:id/resolve`          | `presenca.gerenciar` | Registra o encaminhamento (nada é feito automaticamente)                                                                                                        |
| `PUT /api/company/settings` (alterada)          | `empresa.configurar` | Janela do "Cheguei" e tolerância de atraso, com validação da ordem dos horários                                                                                 |

## 6. Telas administrativas

- **Presença da equipe** (`/painel/presenca`): filtros por data e funcionário; resumo por
  disponibilidade; tabela com nome, situação, chegada (e atraso/"após ausência presumida"), tarefa
  em execução, próxima tarefa, saída (e saída antecipada), alertas; **Registrar** (diálogo de
  situações e correções, com justificativa obrigatória) e **Histórico** (14 dias, com autor,
  dispositivo e motivo de cada entrada); seção **Alertas e impacto na produção** com tarefa do
  ausente, dependentes potencialmente bloqueadas, responsável, prazo, "Necessário reprogramar" e
  **Registrar encaminhamento**.
- **Avisos** no cabeçalho do painel (sino com contagem): ausência presumida, atraso relevante,
  chegada após ausência presumida e tarefa pendente ao encerrar — abrem a Presença da equipe.
- **Empresa**: janela do "Cheguei", início previsto, ausência presumida, fim do expediente e
  tolerância para avisar atraso.

## 7. Telas dos tablets

- **Cartão de presença** no topo do "Meu dia": "Cheguei" grande e em destaque (um toque) com o
  início previsto; motivo quando ainda não disponível; aviso quando a chegada não foi confirmada até
  o limite; depois, "Presente desde HH:MM", disponibilidade e atraso; situações registradas pelo
  gestor (folga, férias etc.).
- **Encerrar expediente**: botão próprio (ícone de lua, contorno) — não se confunde com "Concluir";
  tela com cada tarefa em execução (como ficou, etapa atual, próximo passo, % opcional) e observação
  do dia; "Encerrar mesmo assim" quando faltar andamento (o gestor é avisado); depois, "Expediente
  encerrado às HH:MM".
- Aviso de sem conexão (Fase 6) desativa também o "Cheguei" e o encerramento.

## 8. Permissões

Ver tabela em `SEGURANCA.md`: `presenca.registrar` (próprio), `presenca.ver` (consulta) e
`presenca.gerenciar` (crítica). As rotas do funcionário não aceitam outra pessoa: valem para o
usuário da sessão; tablet e consulta recebem 403 nas rotas de gestão. Sem GPS, reconhecimento
facial ou câmeras; presença operacional não é prova de jornada.

## 9. Eventos

`attendance.arrived`, `attendance.late`, `attendance.absence_suspected`,
`attendance.absence_confirmed`, `attendance.corrected`, `attendance.departed`,
`attendance.availability_changed` e `attendance.production_impact_detected` — gravados na mesma
transação (outbox), para a gestão e para o próprio funcionário; recuperados na reconexão.
Avisos: chegada confirmada e encerramento (recibo ao funcionário), atraso acima da tolerância,
ausência presumida (um por pessoa), chegada após ausência presumida e tarefa pendente ao encerrar
(gestor), ausência confirmada e alteração administrativa (funcionário). Chegada normal não gera
aviso ao gestor.

## 10. Testes e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                          | Resultado                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| API — integração (Vitest, 21 arquivos)                         | **163/163** (152 das Fases 1–6 + 11 novos em `attendance.test.ts`) |
| Pacote compartilhado — unitários                               | **33/33**                                                          |
| Web — unitários                                                | **6/6**                                                            |
| E2E Playwright (build de produção; painel + 2 tablets)         | **15/15** (14 das Fases 1–6 + 1 novo `team-presence.spec.ts`)      |
| Backup + restauração (agora com presença e histórico imutável) | **aprovado**                                                       |
| Prettier, ESLint, typecheck dos 5 pacotes, build de produção   | **sem erros**                                                      |

O `pnpm check` completo rodou em `e918590`; depois disso só mudaram specs E2E (nome do arquivo e um
rótulo), revalidados com typecheck, lint e Prettier, e o E2E completo (15/15) rodou em `57e777d`.
As capturas vêm da execução isolada do E2E de presença (horários relativos à hora atual).

| Cenário exigido                          | Onde                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Chegada às 8h30                       | `attendance.test.ts` (no horário, dispositivo, histórico, painel em tempo real)                                 |
| 2. Chegada atrasada                      | `attendance.test.ts` (10 min sem alerta; 22 min com alerta; antes da janela recusado)                           |
| 3. Ausência presumida às 9h30            | `attendance.test.ts` (9h29 nada; 9h30 presumida; idempotente), `presence.spec.ts`                               |
| 4. Chegada após ausência presumida       | `attendance.test.ts`, `presence.spec.ts`                                                                        |
| 5. Confirmação duplicada                 | `attendance.test.ts` (três toques simultâneos + repetição: um registro, um evento)                              |
| 6. Sessão permanente                     | `attendance.test.ts` (sessão do dia anterior confirma sem PIN)                                                  |
| 7. Revogação de sessão                   | `attendance.test.ts` (401 após revogar)                                                                         |
| 8. Presença de outro funcionário         | `attendance.test.ts` (rota própria ignora outra pessoa; gestão → 403)                                           |
| 9. Correção administrativa               | `attendance.test.ts` (esquecimento; histórico com o original; histórico imutável), `presence.spec.ts`           |
| 10. Ausência justificada                 | `attendance.test.ts` (justificada, atestado, folga, férias futuras)                                             |
| 11. Trabalho externo                     | `attendance.test.ts` (disponibilidade "externo"; exige descrição)                                               |
| 12. Encerramento normal                  | `attendance.test.ts`, `presence.spec.ts`                                                                        |
| 13. Encerramento com tarefa em andamento | `attendance.test.ts` (andamento gravado, tarefa pausada "fim do expediente")                                    |
| 14. Saída sem atualização de andamento   | `attendance.test.ts` (saída registrada, andamento anterior preservado, pendência ao gestor), `presence.spec.ts` |
| 15. Impacto de ausência em tarefas       | `attendance.test.ts`, `presence.spec.ts`                                                                        |
| 16. Dependências afetadas                | `attendance.test.ts` (montagem/acabamento do Márcio), `presence.spec.ts`                                        |
| 17. Permissões                           | `attendance.test.ts` (tablet, consulta, gestor)                                                                 |
| 18. Sincronização em tempo real          | `attendance.test.ts` (WebSocket), `presence.spec.ts` (painel atualiza sem recarregar)                           |
| 19. Reconexão                            | `attendance.test.ts` (três ausências recuperadas; colega não recebe)                                            |
| 20. Regressão das Fases 1 a 6            | todas as suítes anteriores executadas e aprovadas                                                               |

## 11. Defeitos corrigidos

1. **"Em pausa" dependia de horários**: a primeira regra comparava a hora da pausa com a da chegada
   (frágil e sensível ao relógio). Passou a ser: presente, nada em execução e alguma tarefa pausada
   durante o dia — pausas de "fim do expediente" (de ontem) não contam. Testado.
2. **Horário com segundos** no painel ("08:07:19"): presença passou a mostrar HH:MM no fuso da empresa.
3. **Impacto sem contexto**: a linha mostrava só o nome do ausente; agora "Ausente: João".
4. **Ordem dos E2E**: o novo spec rodava antes do da Fase 5 (ordem alfabética) e deixava tarefas e
   plano da semana que aquele spec não esperava; renomeado para rodar por último. No E2E completo o
   Márcio tinha tarefa em execução de specs anteriores e aparecia corretamente "Presente e ocupado" —
   a asserção passou a aceitar disponível/ocupado.
5. **Rótulo da tela Empresa**: o E2E da Fase 1 usava "Alerta de ausência às"; o campo agora se chama
   "Ausência presumida às" (mudança intencional, ver divergência 1).
6. Asserção da Fase 6 ("o gestor não recebe avisos") passou a ignorar os alertas de presença, que a
   verificação periódica pode gerar durante o teste.

## 12. Pendências

- **Redistribuição automática e reprogramação** a partir das ausências: Fase 8 (aqui só
  identificamos e apresentamos o impacto).
- **Central de atenção completa**, pedidos de ajuda e ocorrências: fases futuras.
- Feriados não são considerados automaticamente (só os dias úteis da semana); o gestor registra a
  situação ou ajusta os dias.
- A verificação de ausência presumida roda a cada minuto em cada instância (idempotente e com
  bloqueio por funcionário/dia).
- O E2E usa horários relativos à hora atual e é pulado entre 22h e 02h.
- Pendências anteriores seguem registradas: estorno de recebimento de peças (Fase 2) e saldo de
  pedido de compra que não será entregue (Fase 4).
- Nenhum deploy foi feito.

## 13. Evidências

Capturas (dados fictícios) em [`docs/evidencias/fase-7/`](evidencias/fase-7/): "Cheguei" em
destaque no tablet, presença confirmada, painel com ausência presumida e impactos (preparação do
João; revestimento, montagem e acabamento do Márcio), tela de encerramento, Presença da equipe ao
fim do dia e avisos do gestor.

## 14. Próximos passos (aguardando autorização)

1. Fase 8 — redistribuição e reprogramação a partir dos impactos (somente após autorização).
2. Calendário de feriados da empresa.
3. Executar o CI no GitHub e definir hospedagem (nenhum deploy realizado).
