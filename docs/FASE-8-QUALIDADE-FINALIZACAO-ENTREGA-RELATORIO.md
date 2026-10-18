# Fase 8 (plano principal) — Qualidade, finalização e entrega

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-18. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Produção fora do escopo e não tocada.

|                                     |                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. SHA base                         | `5433c0f` (31/31; `cba4d6d` só documentação)                                                                                                                                                                                                                                                                        |
| 2. SHA final funcional (homologado) | `1aa916f990f2377ebfd643e882af0dbaf3380a65`                                                                                                                                                                                                                                                                          |
| 3. Commits                          | `489c28b` qualidade/entrega (correções + contraprovas + aceites + E2E parcial) · `1aa916f` gatilho ENTREGA da Cobrança (autorizado pelo proprietário)                                                                                                                                                               |
| 4. CI final                         | run 39152037647 (nº 156) **tentativa 2 verde em todas as etapas**. A tentativa 1 foi cancelada pelo limite de 45 min do job durante o E2E (testes da API levaram 28 min no runner contra 18–20 min habituais; todas as etapas anteriores verdes); uma única nova execução do mesmo SHA, verde. `489c28b`: CI verde. |
| 5. Migrations                       | antes 31/31 → depois **31/31** (nenhuma migration nova)                                                                                                                                                                                                                                                             |

## 6–9. Auditoria inicial (contraposição requisito a requisito)

| Requisito                                                                    | Classe                         | Onde                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Produção terminada ≠ concluída; entra em qualidade                           | A                              | `qualityTaskClosed` → `inspectIfProductionDone`                                                               |
| Responsável padrão configurável (Thiago no cadastro), substituto pelo gestor | A                              | `company_settings.quality_inspector_user_id` / competência `INSPECAO`; `POST /quality/inspections/:id/assign` |
| Aprovar / reprovar com registro, versão e trava                              | A (com D de concorrência)      | `quality_inspections` + gatilhos de imutabilidade                                                             |
| Retrabalho como tarefa `CORRECAO` nova, histórico preservado, sem pagamento  | A                              | `rejectInspection`                                                                                            |
| Volta à qualidade após correção                                              | A (com D)                      | rodada nova `CORRECAO_CONCLUIDA`                                                                              |
| Embalagem depois da aprovação, obrigatória                                   | A (com D)                      | `packaging_records`                                                                                           |
| Pronto para entrega: regra única (5 condições, sem exceção)                  | A (com D na etapa gravada)     | `deliveryReadiness` / `computeStage`                                                                          |
| Entrega parcial, agendamento pelo gestor, equipe, tablet sem valores         | A (com D)                      | `shipping.ts`                                                                                                 |
| Confirmação peça a peça, frustrada, reagendamento                            | A (com D)                      | idem                                                                                                          |
| Estado agregado do pedido derivado                                           | A (com D por herança da etapa) | `orderServiceState`                                                                                           |

**Defeitos comprovados (D) — cada um com contraprova que falhava no código anterior** (`apps/api/test/qualidade-entrega.test.ts`; 10 de 11 falhavam com o código de `5433c0f`):

- **QA** aprovação invalidada com etapa nova aberta: a peça ficava sem inspeção para sempre.
- **QB** etapa obrigatória nova numa peça pronta: a etapa gravada continuava "Pronta para entrega" (prazos, Central e mão de obra liam errado).
- **QC** (concorrência, preventivo) duas últimas etapas concluídas juntas podiam não criar inspeção — **não reproduzido** de forma determinística (3 rodadas passaram antes); corrigido por bloqueio da peça antes de ler a produção.
- **QD** aprovar × alteração técnica simultâneas: **deadlock 40P01 → 500** (duas causas: ordem inspeção→peça × peça→inspeção; e `FOR UPDATE` da OS bloqueando a FK da tarefa de embalagem).
- **QE** embalagem sem responsável (ninguém disponível) concluída pelo gestor: **500** (CHECK `started_needs_assignee`).
- **E2** peça marcada "entregue" no destino virava ENTREGUE antes da conclusão (podia ser remarcada "não entregue" com a mão de obra já liberada; pedido "concluído" antes).
- **E-trânsito** aprovação invalidada com a peça no caminhão: podia ser marcada entregue.
- **E3** equipe própria aceita como responsável recebia 403 na própria entrega.
- **E4** trocar entrega terceirizada com custo para equipe própria mantinha o custo (viraria dívida para o André).
- **E5** reagendar trocava o endereço da entrega pelo principal do cliente.
- **E6** instalação de tentativa frustrada valia para a tentativa seguinte.
- **E8** detalhe da entrega concluída listava peças retiradas antes da saída.
- **E1 (Cobrança)** gatilho ENTREGA contava peça apenas associada a entrega concluída — corrigido **após autorização expressa** (ver 25–26).

## 10–17. Qualidade, retrabalho, embalagem, pronto

- **Entrada**: concluída a última etapa obrigatória da peça (ou da OS), nasce a inspeção (uma vez — peça bloqueada antes da leitura, ordem estável entre peças).
- **Responsável**: inspetor principal configurado; ausente/executor/sem inspetor → gestor designa substituto (só inspeções abertas; o passado é imutável por gatilho). Nada é "Thiago" no código.
- **Aprovação**: checklist completo, não executor, versão da peça; registra decidedBy/At, dispositivo, revisão da OS; CAS + repetição idempotente; dois dispositivos → 200/409.
- **Reprovação**: motivo + não conformidade; correção `CORRECAO` liberada para quem fez a peça; nada apagado; **nenhum pagamento criado** (aceite 12).
- **Retrabalho → qualidade**: correção concluída → rodada nova obrigatória; **nova regra (QA)**: última rodada invalidada, ou reprovada sem correção aberta, gera a próxima rodada quando a produção termina.
- **Embalagem (regra efetiva, mantida)**: produção → qualidade → **embalagem** → pronto (a embalagem protege a peça aprovada). Gestor pode concluir quando ninguém foi designado (QE: passa a ser o responsável registrado).
- **Pronto para entrega**: `deliveryReadiness` — tarefas obrigatórias, inspeção aprovada, sem correção aberta, embalagem concluída, sem bloqueio; **sem exceção administrativa** (nenhuma criada). Etapa gravada reavaliada quando surge etapa obrigatória nova (QB).

## 18–24. Entrega

- **Parcial**: suportada peça a peça; só peças individualmente prontas entram na entrega definitiva; **ENTREGUE só com a entrega concluída** (E2) — no destino a peça continua "Em transporte".
- **Agendamento**: só o gestor (`entregas.gerenciar`, web); provisório sem prontidão, definitivo exige prontidão; mesma peça em duas entregas ativas → 409 (índice parcial).
- **Equipe**: equipe própria ou terceirizada por permissão/configuração (sem nomes no código); o responsável da equipe própria executa só a própria entrega (E3, sem permissão nova); custo de terceirização não migra para equipe própria (E4).
- **Tablet/celular**: endereço, cliente, peças, horário, instruções, status; sem valores (aceites 24, 47–48).
- **Confirmação**: trava + versão; dupla conclusão → um único evento CONCLUIDA; peça entregue não entra em outra entrega.
- **Falha/reagendamento**: frustrada nunca entrega, abre ocorrência, peças voltam à expedição; reagendamento preserva o histórico, mantém o endereço (E5) e zera a instalação da tentativa anterior (E6).
- **Estado agregado**: derivado; pedido só "Serviço concluído" com todas as peças ativas entregues.

## 25–27. Cobrança e custo logístico

- **Gatilho ENTREGA (decisão do proprietário)**: `dueContext` (fonte única do vencimento e da Central) passa a contar só peça **efetivamente entregue** (ENTREGUE/DIVERGENTE) numa entrega **concluída**. Não contam: "não entregue", retirada antes da saída, frustrada, associação histórica. Contraprovas A–G em `cobranca.test.ts` (A, B, C/G falhavam antes; D/F confirmam a regra preservada).
- **26. Caveat da primeira entrega parcial**: **mantido** — entrega parcial real (ao menos uma peça entregue) continua vencendo o saldo.
- O cenário 26 do `cobranca.test.ts` passou a concluir a entrega como o fluxo real (peças registradas como entregues); as asserções continuam as mesmas.
- **LogisticsCost**: inalterado; constituição única na conclusão (aceite 40/46); a validação de troca de equipe (E4) só impede gravar combinação inválida.

## 28–33. R1, R2, D13, Prazos/D9, Produção, Presença/Apoio

Sem alteração: ProductionPayable, Meus Ganhos, negociação, confirmação semanal, D12/D13, exceção administrativa, titular (aceite 38), D9 e motor de prazos (aceites 35/37: `EM_RISCO` com motivo `EM_CORRECAO`), apoio/transferência/presença (suítes completas verdes). Produção: o hook QB roda dentro de `reevaluateTasks` e só toca peças além da produção.

## 34–37. Permissões, auditoria, tempo real, concorrência

- Permissões existentes (`qualidade.*`, `entregas.*`, `logistica.executar`, `producao.executar` só para a própria entrega); funções personalizadas cobertas (substituto com `qualidade.inspecionar`; sem permissão → 403).
- Histórico: `quality_events`, `delivery_events` (imutáveis), AuditLog, eventos de domínio — reconstrução completa (aceites 1–15, 28–29).
- Tempo real: eventos existentes, sem valores (aceite 48).
- **Ordem de bloqueio**: OS (`FOR NO KEY UPDATE` na revisão) → peça → inspeção → embalagem/tarefas; entrega por linha + versão. Cobertos: duas aprovações, aprovar × reprovar, aprovar × alteração técnica (QD), duas últimas etapas, dois agendamentos, entrega parcial concorrente, conclusão × "não entregue", dupla conclusão.

## 38–40. Migration, backfill, dados históricos

Nenhuma migration; nenhum backfill; nenhuma correção automática de dados antigos. Etapas gravadas antigas só são recalculadas quando a peça volta a ter evento. Não há leitura SQL livre na homologação: peças antigas marcadas no destino de entregas ainda não concluídas (se houver) seguem a nova regra no próximo evento — não quantificado (caveat 3).

## 41–45. Testes e regressão

- Focados: `qualidade-entrega.test.ts` — 12 contraprovas + aceites 1–48 (agrupados) + concorrência; `cobranca.test.ts` — contraprovas A–G + idempotência.
- API completa local: **727 aprovados, 10 ignorados** (condicionais); shared 127; web 6.
- E2E completo: **45/45** — `team-quality.spec.ts` cobre produção → reprovação → correção → aprovação → embalagem → agenda → entrega → confirmação **e a entrega parcial** (sofá entregue; poltronas na oficina; pedido não concluído).
- format, lint, typecheck, build: OK (local e CI).

## 46–53. Homologação (`1aa916f`)

| Passo                      | Resultado                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build                      | Cloud Build SUCCESS (api/web com a etiqueta do SHA completo)                                                                                                                                                                                                                                                                       |
| prepare_version / precheck | OK — 31 na imagem, 31 aplicadas, 0 pendentes                                                                                                                                                                                                                                                                                       |
| 46. recovery point         | `cenario-staging-20261018T193031Z` (versão anterior `5433c0f`), enviado ao bucket                                                                                                                                                                                                                                                  |
| 47. backup/restore         | restauração de teste IDÊNTICA; `backup_validate` SHA256SUMS conferido                                                                                                                                                                                                                                                              |
| 48. migrate                | sem pendências ("Database schema is up to date")                                                                                                                                                                                                                                                                                   |
| 49. migration_verify       | 31/31                                                                                                                                                                                                                                                                                                                              |
| 50. versão ativa           | `1aa916f990f2377ebfd643e882af0dbaf3380a65` (etiqueta local, pilha, candidata, migrada); portão fechado                                                                                                                                                                                                                             |
| 51. health/smoke/WS        | a 1ª ativação subiu a versão, mas a checagem final acusou **disco 86%** → `images_cleanup_plan` + `images_cleanup` (removidas só as imagens de `5c29700` e `932e04b`; ativa e ponto de recuperação protegidas; +4,26 GiB, disco 63%) → nova ativação limpa (Saúde OK); health, smoke, WebSocket e suítes saúde/acesso/websocket ✔ |
| 52. logs                   | api/web/postgres sem erro; caddy: 3× 503 em `/api/realtime` às 19:30–19:31 (janela de manutenção/reinício — esperado)                                                                                                                                                                                                              |
| 53. fingerprint            | esquema idêntico; tabelas de negócio idênticas; mudaram só `devices`/`sessions` (mesmas contagens) e `domain_events` +3 — atividade de um dispositivo real durante a janela (as mesmas reconexões do log)                                                                                                                          |

## 54. Caveats

1. Pagamento informado numa tentativa frustrada bloqueia a tentativa seguinte (Cobrança) — registrado para decisão posterior.
2. Responsável da equipe própria executa a entrega, mas não informa pagamento coletado (Cobrança) — registrado para decisão posterior.
3. Peças antigas marcadas "entregue" no destino antes desta versão, em entregas ainda não concluídas, só são recalculadas no próximo evento (sem backfill).
4. QC corrigido preventivamente (não reproduzido).
5. Demais ciclos de bloqueio pré-existentes fora dos pares cobertos não foram reescritos.
6. CI precisou de uma nova execução do mesmo SHA por tempo de runner (limite de 45 min do workflow).
7. Sem clique na aplicação em homologação (evidência funcional: CI + E2E do mesmo SHA).

## 55. Produção

Absolutamente intocada.

## 56. Classificação

**GO WITH CAVEATS.** Nenhum critério de NO-GO presente. Fase 9 e Fase 10 não iniciadas.
