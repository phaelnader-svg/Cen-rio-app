# Simplificação Fase 7 — Presença e apoio simplificados

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-18. Ramo `claude/cenario-gestao-fase-1-zf3bj2`.

|                           |                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. SHA base               | `932e04b` (R2 homologada, 30/30)                                                                                                                                                                                                                                                                                      |
| 2. SHA final (homologado) | `5433c0f29a226d80ad3c93e247e49a0564647799`                                                                                                                                                                                                                                                                            |
| 3. Commits                | `9cb161a` domínio/API/migration · `5d900f4` telas, E2E, testes de domínio (+ correção do teste de Meus Ganhos que falhava aos domingos) · `5433c0f` E2E com dia de teste próprio                                                                                                                                      |
| 4. CI final               | nº 153 / run 39101416508 — verde em todas as etapas (audit, format, lint, typecheck, migrations do zero sem divergência, build, testes, backup, E2E). As runs de `9cb161a` e `5d900f4` falharam (teste de Meus Ganhos dependente do dia da semana; colisão de dia entre E2E) e foram corrigidas antes da homologação. |

## 5. Auditoria inicial (contraprova em `932e04b`)

Todos os gaps A–I existiam em `932e04b`; nada foi reimplementado sobre algo já corrigido.

| Gap                             | Situação em 932e04b                                                                                  | Contraprova                   | Correção                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| A. tablet expõe `lateMinutes`   | `/attendance/me`, evento `attendance.*` ao próprio usuário e notificação com minutos/tipo de chegada | `presenca-apoio.test.ts` "A." | DTO próprio do funcionário + evento reduzido             |
| B. expediente esquecido aberto  | linha de dia anterior com chegada e sem saída ficava invisível                                       | "B."                          | alerta `EXPEDIENTE_ABERTO` ao gestor                     |
| C. encerramento incorreto       | não havia como desfazer/corrigir a saída                                                             | "C."                          | `REGISTRAR_SAIDA`, `SAIDA_NAO_INFORMADA`, `ANULAR_SAIDA` |
| D. folga/férias dia a dia       | só lançamento por dia                                                                                | testes 12–15                  | intervalos (`attendance_leaves`)                         |
| E. sem calendário de feriados   | inexistente                                                                                          | testes 10–11                  | `company_holidays`                                       |
| F. `helperUserId` desatualizado | `changeTask` trocava o executor sem atualizar o pedido                                               | "F."                          | `supportReassigned` centralizado                         |
| G. público de aviso             | avisos acionáveis para `presenca.gerenciar`, ação exige `producao.planejar`                          | "G."                          | `notifyPlanners`                                         |
| H. apoio prolongado             | inexistente                                                                                          | 29–32                         | proposta `APOIO_PROLONGADO`                              |
| I. transferência com aprovação  | inexistente                                                                                          | 33–37                         | proposta `TRANSFERENCIA`                                 |

## 6–7. CA7-01 e privacidade da presença

- `GET /api/v1/attendance/me` devolve `MyAttendanceDayDto`/`MyAttendanceConfigDto`, que não têm `lateMinutes`, classificação de chegada, limiares nem minutos.
- Eventos de presença: `attendanceEvent` emite a versão completa só para a audiência de gestores e uma versão mínima para `user:<id>`. O evento de impacto/atraso não tem versão para o funcionário.
- Notificação ao funcionário: "Chegada confirmada às HH:MM." Correções feitas pelo gestor aparecem como "registro de presença ajustado pelo gestor".
- Tablet: sem rótulo de atraso. Na ausência presumida o texto é neutro ("Se você já está na oficina, toque em Cheguei.").
- O gestor mantém todos os dados: atraso operacional, minutos e histórico. Nenhum dado do gestor foi apagado.

## 8. Expediente esquecido

`detectOpenShifts` roda no mesmo temporizador da verificação de ausência. Ele procura dias anteriores, até 14 dias atrás, com chegada, sem saída, sem "saída não informada" e não encerrados. Para cada linha há trava consultiva e um único alerta por linha (marcado em AuditLog `attendance.open_shift_detected`). O alerta é a notificação `EXPEDIENTE_ABERTO` ao gestor, com nome, data e hora de chegada. Nunca encerra sozinho e nunca inventa horário. Na tela Presença, a seção "Expedientes sem encerramento" tem o botão "Resolver".

## 9. Correção de saída

Exige `presenca.gerenciar`, justificativa e CAS (`version`).

- `REGISTRAR_SAIDA`: o horário é obrigatório e posterior à chegada.
- `SAIDA_NAO_INFORMADA`: registra que a saída não é conhecida. A situação continua PRESENTE e o horário fica vazio, como exige o CHECK `operational_attendances_departed`.
- `ANULAR_SAIDA`: desfaz um encerramento feito por engano.

Cada ação gera histórico antes/depois com autor (eventos de presença + AuditLog). O fato original nunca é apagado.

## 10. Folga/férias por intervalo

`attendance_leaves` tem FOLGA/FERIAS, intervalo de até 60 dias pela API (366 no CHECK) e código FL-00001.

- Criar: trava `leave:<funcionário>`; intervalos sobrepostos dão 409.
- Corrigir: CAS, evento CORRIGIDA.
- Cancelar: CAS + motivo, evento CANCELADA.
- Eventos imutáveis (gatilho); o intervalo não pode ser excluído (gatilho).
- É só uma situação planejada: o dia aparece como folga/férias, mas nenhuma presença futura é criada.
- Se o intervalo cobre hoje e já existe uma ausência presumida, ela é convertida pela mesma ação do gestor, com histórico.

## 11. Calendário/feriados

`company_holidays`: uma data por linha. Não há exclusão: o feriado é desativado/reativado com CAS e auditoria. Não depende de API externa.

- No feriado: não há expediente normal, ausência presumida, atraso nem proposta de reprogramação por ausência.
- ADIAR pula o feriado (`nextWorkingDay` também é usado em ocorrências).
- Dias passados não são reclassificados.

## 12. helperUserId

A reatribuição do apoio, tanto por proposta (`changeTask`) quanto pelo planejamento (`PUT /production-tasks/:id`), passa por `supportReassigned`, na mesma transação. Ela:

- sincroniza `helperUserId` com o executor;
- recusa o solicitante como ajudante e recusa ajudante vazio;
- grava evento `AJUDANTE_ALTERADO`, ação `AJUDANTE_REATRIBUIDO`, AuditLog `help.helper_changed`, `HELP_ASSIGNED` e notificação.

O novo ajudante abre o pedido; o antigo deixa de ser o atual.

## 13. Público/permissões dos avisos

Avisos acionáveis (ajuda urgente, espera com risco, propostas de reprogramação, apoio prolongado, transferência) vão para quem tem `producao.planejar`, a permissão exigida para decidir. Avisos de presença continuam com `presenca.gerenciar`. Nenhuma permissão foi ampliada. Foi testado com funções personalizadas.

## 14. Apoio prolongado

`POST /api/v1/help-requests/prolonged` (60–2400 min, justificativa) cria um pedido escalado e uma proposta `APOIO_PROLONGADO`, com alternativas por candidato apto.

- Aprovar: atribui o apoio e cria o vínculo.
- Recusar: cancela o pedido, sem voltar à fila automática.
- Decisão notificada ao solicitante (`PEDIDO_DECIDIDO`); histórico imutável.
- Não cria ProductionPayable (D14 mantida) e não muda o titular.

## 15. Transferência com aprovação

`POST /api/v1/production-tasks/:id/transfer-request` (motivo; só tarefas BLOQUEADA/PROGRAMADA/LIBERADA; uma pendente por tarefa) cria uma proposta `TRANSFERENCIA`.

- Etapa do titular (TAPEÇARIA ou atividade principal): a ação é CHANGE_PRINCIPAL, pela regra canônica da R1 (titular + LaborReview + obrigação financeira).
- Demais etapas: REASSIGN com CAS do executor atual.
- Recusada: nada muda.

## 16–17. Ausência e reprogramação

REDISTRIBUIR / TROCAR_PRINCIPAL / ADIAR / AGUARDAR mantidos. Folga/férias contam como ausência na avaliação de candidatos, e o feriado entra no ADIAR.

## 18–20. Proteções R1/R2

Nada da presença toca ProductionPayable, Meus Ganhos, negociação, `weekly_closing_confirmations`, D12, D13, pagamento, exceção administrativa, snapshot, titular ou LaborReview (testes 40–43). Não existe relação presença × pagamento: sem desconto, banco de horas ou folha. Na homologação, a impressão financeira ficou idêntica antes e depois.

## 21–23. Tablets, gestor e notificações

- **Tablet:** Cheguei e Encerrar como antes, sem pontualidade, aviso de feriado, "Preciso de apoio prolongado" e "Pedir transferência" no cartão da tarefa. Sem app novo, sem login web pessoal, sem offline.
- **Gestor:** telas existentes. Presença ganhou expedientes sem saída, folgas/férias e feriados. Ajuda e reprogramação mostram as novas propostas. Menu sem mudanças.
- **Notificações:** sistema existente; tipos `EXPEDIENTE_ABERTO` e `PEDIDO_DECIDIDO`. Nunca levam minutos de atraso ou valores ao funcionário.

## 24. Auditoria

Registros em AuditLog e eventos de domínio para: correção de presença/saída, alerta de expediente, folga/férias (eventos próprios imutáveis), feriado, apoio prolongado, transferência, aprovação/recusa e reatribuição de ajudante.

## 25–26. Migration e backfill

Uma migration aditiva: `20270209000000_presenca_apoio_simplificados` (30 comandos).

- Tabelas novas: `company_holidays`, `attendance_leaves`, `attendance_leave_events`.
- Colunas novas: `operational_attendances.departure_unrecorded_at` e `reschedule_proposals.requested_by_id` (anuláveis).
- CHECKs novos.
- CHECKs ampliados (substituídos):
  - `help_requests_kind` passa a aceitar `APOIO_PROLONGADO`;
  - `help_requests_minutes_range` passa a 60–2400 minutos para ele (demais tipos continuam 5–240);
  - `reschedule_proposals_kind` passa a aceitar `TRANSFERENCIA` e `APOIO_PROLONGADO`.
- Dois gatilhos.

Sem backfill e sem reinterpretar o histórico. Nenhum fato histórico de presença foi alterado.

## 27. Concorrência

Testes 44–46:

- duas reatribuições do mesmo apoio;
- aprovar × recusar;
- chegada × correção, saída × correção, alerta × correção, feriado × ausência, transferência × titular.

O resultado é determinístico (CAS + travas consultivas por chave), sem deadlock.

## 28–32. Testes e regressão

- Focados: `apps/api/test/presenca-apoio.test.ts`. São 5 contraprovas (A, B, C, F, G) e os aceites 1–46 em 25 casos agrupados, todos passando; D, E, H e I são cobertos pelos aceites correspondentes.
- Domínio: `packages/shared/test/presence-simplified.test.ts`.
- Testes anteriores adaptados ao CA7-01 (as verificações de minutos passaram para a visão do gestor, sem afrouxar): `attendance.test.ts`, `help.test.ts` nº 27, `team-presence.spec.ts`.
- `meus-ganhos.test.ts`: a data de teste caía numa segunda-feira quando a suíte rodava num domingo. Corrigido.
- Local: API completa verde (699), shared 127, web 6.
- E2E completo: 45/45, incluindo `team-presenca-apoio.spec.ts`: expediente esquecido → Resolver; feriado; férias por intervalo; tablet sem atraso, com o gestor vendo "Atraso operacional · 20 min".
- format, lint, typecheck e build OK, também na CI nº 153.
- Regressões cobertas pela suíte completa + E2E: presença, ajuda, reprogramação, planejamento, fila, tablets, titular, R1/Meus Ganhos, R2/negociação/confirmação/D13, financeiro/fechamento, logística, qualidade, Compras, Cobrança, Prazos, D9.

## 33–41. Homologação (`5433c0f`)

| Passo                            | Resultado                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build                            | Cloud Build SUCCESS; imagens api/web com etiqueta do SHA completo                                                                                                                                    |
| prepare_version                  | OK; imagem com 31 migrations, banco com 30; a imagem não migra na partida                                                                                                                            |
| 33. migration_precheck           | OK: 1 pendente, esquema e dados compatíveis                                                                                                                                                          |
| 34. recovery point               | `cenario-staging-20261018T062553Z` (versão anterior 932e04b), enviado ao bucket                                                                                                                      |
| 35. backup/restore               | restauração de teste IDÊNTICA ao banco; `backup_validate` SHA256SUMS conferido                                                                                                                       |
| 36. migrate                      | aplicada em 32 s                                                                                                                                                                                     |
| 37. migrations finais            | **31/31**; `migration_verify` OK                                                                                                                                                                     |
| 38. versão ativa                 | `5433c0f29a226d80ad3c93e247e49a0564647799` (etiqueta local, pilha, candidata, migrada); portão fechado                                                                                               |
| 39. health/smoke/WS              | todos os contêineres saudáveis, `/api/ready` 200, certificado válido por 81 dias, disco 74%, WebSocket 401 sem sessão (esperado); `run_homologation_tests completo` com saúde, acesso e websocket ✔ |
| 40. logs                         | api/web/postgres/caddy (15 min): nenhuma linha de erro, fatal ou exceção                                                                                                                             |
| 41. fingerprint/schema/data diff | ver abaixo                                                                                                                                                                                           |

**Diff de impressão digital.**

- Esquema: só acréscimos: 3 tabelas, 2 colunas anuláveis, índices, gatilhos e CHECKs. Os 3 CHECKs substituídos (`help_requests_kind`, `help_requests_minutes_range`, `reschedule_proposals_kind`) foram ampliados, nunca restringidos.
- Contagens iguais em todas as tabelas, exceto `audit_logs` 182→183, `domain_events` 485→486 e `notifications` 80→81. Isso equivale exatamente a um alerta de expediente aberto na primeira rodada do detector: uma linha legada dos últimos 14 dias com chegada e sem saída (caveat 1). As operações de leitura disponíveis não permitem ler o conteúdo dessas linhas; a conclusão vem da contagem.
- Os hashes de `operational_attendances` (25 linhas) e `reschedule_proposals` (8 linhas) mudaram só pela coluna nova anulável; as contagens são iguais.
- Impressão financeira inalterada: ProductionPayable, fechamentos, confirmações, pagamentos.

## 42. Caveats

1. O alerta de expediente aberto olha até 14 dias para trás. Na primeira rodada em homologação, linhas legadas abertas geram alerta ao gestor; foi observado 1 (+1 notificação, +1 evento, +1 auditoria). O gestor resolve pela tela.
2. Feriados valem para presença e reprogramação. O cálculo de Prazos/D9 continua com os dias úteis da empresa, sem o calendário.
3. Apoio prolongado e pedido de ajuda rápida não ficam abertos ao mesmo tempo na mesma tarefa (unicidade existente de pedido aberto por tarefa).
4. O vínculo de apoio prolongado aprovado é registrado e auditado. Ele não muda automaticamente outras tarefas, porque o desenho original não define esse efeito.
5. Funcionário em folga/férias vê no tablet o cartão de ausente, sem Cheguei, como já acontecia com FERIAS de um dia.
6. Não houve clique na aplicação em homologação, conforme instruído. A evidência funcional é CI + E2E do mesmo SHA.

## 43. Produção

Produção absolutamente intocada: só a homologação (VM `cenario-homolog`) foi operada.

## 44. Classificação

**GO WITH CAVEATS.** Fase 10 não iniciada.
