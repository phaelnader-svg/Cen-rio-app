# Fase 10 (plano principal) — Gestão, indicadores, auditoria e fechamento final

Base funcional: `1aa916f` (ativa em homologação, 31/31). `127bf67` é só documentação da Fase 8 e não
foi usada como base. Produção: fora de escopo e **não tocada**.

## 1–5. Identificação

| Item                       | Valor                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. SHA base                | `1aa916f990f2377ebfd643e882af0dbaf3380a65`                                                                                                                                                                   |
| 2. SHA funcional final     | `9fb1786beddae28c34b20a0922b42989ecb0fbf2`                                                                                                                                                                   |
| 3. Commits                 | `9fb1786` (funcional, código + testes); este relatório em commit só de documentação                                                                                                                          |
| 4. CI final                | run 39166196167 no SHA exato — **verde na 1ª tentativa** (verify 21:04:33 → 21:44:38, **40 min 05 s**; testes da API ~21,7 min, E2E ~15 min). Limite de 45 min não excedido; configuração do CI não alterada |
| 5. Migrations antes/depois | 31/31 → **31/31** (nenhuma migration; nenhuma necessidade estrutural comprovada)                                                                                                                             |

## 6. Auditoria inicial (A/B/C/D)

| Requisito                                                                                                                                                                                                                                                                                                                                                    | Classe | Evidência / decisão                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Central: ocorrências, ajuda, reprogramação, presença (impacto), produção (prazo interno/impedimento), prazos da OS/pedido, qualidade/logística, cobrança, rascunhos passados                                                                                                                                                                                 | A      | provedores existentes em `issues/attention.ts`, `deadlines/attention.ts`, `quality/attention.ts`, `finance/billing.ts`; mantidos |
| Central: negociação pendente (R2), revisão financeira (R1), "a comprar", chegada aguardando conferência, expediente sem saída                                                                                                                                                                                                                                | C      | existiam no domínio e nas telas, mas nunca chegavam à Central → `management/attention.ts`                                        |
| Central: mesmo problema em 2–3 itens (entrega frustrada + "pronta" + ocorrência; correção + "prazo interno"; ajuda escalada + proposta)                                                                                                                                                                                                                      | D      | contraprovas falhavam na base → deduplicação                                                                                     |
| Central: qualidade com "prazo ≤ hoje" próprio (2ª regra de prazo)                                                                                                                                                                                                                                                                                            | D      | prazo hoje virava CRÍTICO; agora usa `serviceDeadlines` (ATRASADO)                                                               |
| Central: links quebrados/imprecisos (`?entrega=` ignorado, cobrança "informada" sem aba)                                                                                                                                                                                                                                                                     | D      | abas por `?tab=`; cobrança na entrega abre a entrega                                                                             |
| Central: erro de carga exibia lista vazia; contagens "0" sem dados; eventos de compra/estoque/financeiro não atualizavam                                                                                                                                                                                                                                     | D      | estado de erro, "—" sem dado, invalidação                                                                                        |
| Central: candidatos a prazo incluíam OS já toda entregue                                                                                                                                                                                                                                                                                                     | D      | `deadlineCandidatesWhere` só com peça não final                                                                                  |
| Início: "OS abertas" crescia para sempre (OS entregue continua ABERTA); cartão "Implantação" e textos antigos                                                                                                                                                                                                                                                | B/D    | "Serviços ativos" (OS com peça não final); cartão removido                                                                       |
| Início: visão operacional e financeira                                                                                                                                                                                                                                                                                                                       | C      | `GET /api/v1/management/overview`                                                                                                |
| Menu: lista plana com ~35 itens                                                                                                                                                                                                                                                                                                                              | B      | grupos (Serviços, Produção, Compras, Financeiro, Administração); nenhum item removido/renomeado                                  |
| "Recebimento de materiais" sem filtro de permissão                                                                                                                                                                                                                                                                                                           | A      | regra intencional: qualquer funcionário recebe                                                                                   |
| Telas antigas (`/painel/planejamento`, `/painel/materiais`, `/painel/os/nova`, `/painel/pedidos/novo`)                                                                                                                                                                                                                                                       | A      | redundantes mas usam a API atual; preservadas (nada apagado)                                                                     |
| Busca: cliente, pedido, OS                                                                                                                                                                                                                                                                                                                                   | A      | existente                                                                                                                        |
| Busca pelo código da peça (`OS-00012/1`)                                                                                                                                                                                                                                                                                                                     | B      | aceito                                                                                                                           |
| Histórico completo do serviço                                                                                                                                                                                                                                                                                                                                | C      | linha do tempo composta (sem tabela nova)                                                                                        |
| Auditoria: D1 prazo da OS sem motivo e omitir o campo apagava o prazo; D2 motivo fora da AuditLog; D5 cancelamento/bloqueio de tarefa sem AuditLog; D6 substituto da inspeção herdava o motivo anterior e sem de/para; D7 alteração de entrega sem antes/depois; D8 cancelamento de custo logístico sem AuditLog; D10 motivo de desbloqueio sem limite (500) | D      | corrigidos                                                                                                                       |
| Auditoria: D3/D4 (conteúdo da troca de titular), D9 (resumo limitado a 300), D11 (SET NULL latente; DELETE de `domain_events` permitido por desenho)                                                                                                                                                                                                         | B      | documentados como caveat (não bloqueiam; motivos completos ficam nos históricos de domínio)                                      |
| AuditLog: auditor sem `financeiro.ver` lia `finance.*`                                                                                                                                                                                                                                                                                                       | D      | filtrado                                                                                                                         |
| PIN/segredos na auditoria                                                                                                                                                                                                                                                                                                                                    | A      | nunca gravados (verificado)                                                                                                      |
| `resolved_at` em notificações (plano original)                                                                                                                                                                                                                                                                                                               | —      | desnecessário: a Central é projeção; o item some quando a causa é resolvida (sem migration)                                      |

## 7–11. Central

- **7. Antes:** 9 provedores; sem decisões financeiras/materiais; duplicidades; prazo próprio na qualidade; erros de carga invisíveis.
- **8. Gaps:** os itens C/D acima.
- **9. Final:** mesmos provedores + `FINANCEIRO` (negociação, revisão), `MATERIAL` (a comprar — um item agregado sobre `purchaseShortages`, sem duplicar a lista; chegada a conferir — um item), `PRESENCA:expediente`. Cada item: o quê, OS/pedido, categoria/prioridade, desde quando (`at`), próximas ações e link.
- **10. Deduplicação:** frustrada → um item (a peça não aparece como "pronta"; ocorrência não bloqueante da frustrada não repete; a ocorrência vai na descrição); correção → o item da qualidade carrega a tarefa e suprime "prazo interno"/"impedimento" da mesma tarefa; ajuda escalada com proposta pendente → só a proposta. Chaves únicas (teste).
- **11. Prioridade:** inalterada — `CATEGORY_ORDER` (CRÍTICO → AÇÃO → ATENÇÃO → INFO) e depois `at`. D9 preservado. Novos itens usam as categorias existentes (sem fórmula nova).

## 12–15. Início e indicadores

- **12. Início:** saudação/data no fuso da oficina; cartão Prazos (mesma rota da Central); "Serviços ativos"; seção Operação; seção Financeiro (só com `financeiro.ver`).
- **13. Operacionais:** ativos, atrasados/em risco/próximos (motor de prazos), aguardando material (estados de prontidão `MATERIALS_PENDING_STATES`), peças por etapa (produção, qualidade, retrabalho, embalagem, bloqueadas, prontas, agendadas, em trânsito — `fulfillmentStage`), entregas próximas (hoje..+2) e frustradas.
- **14. Financeiros:** a receber em aberto e vencido (`dueContext`/`dueOf` — mesma fonte da Cobrança), contas a pagar abertas e vencidas, mão de obra liberada a pagar (`ProductionPayable` LIBERADO/PAGO_PARCIAL), decisões pendentes (negociações, revisões, pagamentos informados). **Sem margem, sem lucro.** Sem permissão: `finance: null` (nunca zero); a tela mostra "—".
- **15. Fontes canônicas:** `serviceDeadlines`/`deadlineCandidatesWhere`, prontidão de materiais, `fulfillmentStage`, `purchaseShortages`, `dueContext`, `AccountPayable`, `ProductionPayable`, `ValueChangeRequest`, `LaborReview`, `openShifts`. Nada persistido; nenhuma tabela agregada.

## 16–19. Menu, navegação, deep-links, rotas antigas

- **16. Menu:** seis grupos (Início, Serviços, Produção, Compras, Financeiro, Administração), itens continuam filtrados por permissão (`anyOf`).
- **17. Navegação:** abas de Entregas e Financeiro aceitam `?tab=`; nenhuma rota removida.
- **18. Deep-links:** cada item leva à tela da ação canônica (OS, pedido, tarefa, ocorrência, entrega, Compras, Recebimento de materiais, Presença, Financeiro → aba). A ação é sempre o fluxo existente (E2E: prazo alterado pelo diálogo da OS, com motivo).
- **19. Rotas antigas:** preservadas e funcionais (E2E de geometria e auditoria visual percorrem 57/147 telas sem erro); não há link morto no menu.

## 20–23. Histórico e auditoria

- **20. Histórico do serviço:** `GET /api/v1/service-orders/:id/timeline` + aba "Linha do tempo" na OS: pedido, retirada, recebimento, revisões da OS, medição, produção (eventos de tarefa), qualidade, entrega, cobrança (só com `financeiro.ver`) e AuditLog da OS/pedido; limite de 400 por fonte, `truncated`.
- **21. AuditLog:** cobertura ampliada (D1, D2, D5–D8, D10); filtro `entityId`; `finance.*` só para quem vê o financeiro.
- **22. DomainEvent:** inalterado (eventos já emitidos pelos fluxos; nenhum terceiro sistema).
- **23. Ações críticas:** prazo (OS: motivo obrigatório; pedido: já exigia), titular (revisão de mão de obra + histórico de distribuição), revisão/negociação (decisão com autor), exceção administrativa (R2, autor e motivo), correção de presença (`attendance_corrections`), cancelamentos (tarefa, custo logístico), substituição (inspetor), alteração de entrega (de/para), estornos financeiros (eventos financeiros). Motivo não foi exigido em ações triviais.

## 24–37. Domínios preservados

| Domínio               | Resultado                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| 24. Prazos/D9         | motor inalterado; Central/Início/qualidade consomem os estados; só os candidatos excluem OS toda entregue |
| 25. Materiais/compras | Compras 1–3 inalteradas; Central lê `purchaseShortages` e chegadas                                        |
| 26. Produção          | fila/DAG/bloqueios/titular inalterados; Central não planeja                                               |
| 27. Qualidade         | fluxo da Fase 8 inalterado; só a projeção da Central                                                      |
| 28. Entrega           | inalterada; auditoria de/para na alteração                                                                |
| 29. Cobrança          | regra inalterada; link da Central                                                                         |
| 30. Mão de obra       | inalterada                                                                                                |
| 31. LogisticsCost     | inalterado; cancelamento agora também na AuditLog                                                         |
| 32. Meus Ganhos       | inalterado (suíte R1 verde)                                                                               |
| 33. Negociação        | inalterada; pendências na Central (sem valores no item)                                                   |
| 34. Confirmação       | inalterada (suíte R2 verde)                                                                               |
| 35. D12               | inalterado                                                                                                |
| 36. D13               | inalterado                                                                                                |
| 37. Presença/apoio    | inalterados; expediente sem saída na Central para `presenca.gerenciar`                                    |

## 38–44. Transversais

- **38. Privacidade:** tablets não acessam Central nem Início gerencial (403); itens financeiros sem valores; nada financeiro pelo WebSocket (só invalidação `['attention']`/`['overview']`).
- **39. Permissões:** por permissão, nunca por nome de função (`os.ver`, `entregas.*`, `financeiro.ver`, `compras.*`, `estoque.*`, `presenca.gerenciar`, `auditoria.ver`).
- **40. Realtime:** eventos `finance.`, `material.`, `purchase_order.`, `stock.` passam a invalidar Central e Início.
- **41. Timezone:** "hoje" do Início e da Central pelo relógio/fuso da oficina (teste 23h30 BRT = dia seguinte em UTC).
- **42. Performance:** consultas com `take` (100 na Central nova, 400 por fonte na linha do tempo), contagens por `count`/`groupBy`; nenhum endpoint carrega o banco inteiro. Caveat: N+1 pré-existente nas retiradas do Início.
- **43. Dados históricos:** nada alterado. Não há leitura SQL livre na homologação: OS antigas `ABERTA` com todas as peças entregues (que inflavam o antigo "OS abertas") não foram quantificadas nem alteradas — o novo indicador simplesmente não as conta. Nenhum dado corrigido.
- **44. Migration/backfill:** nenhuma; nenhum backfill.

## 45–48. Testes

- **45. Fase 10:** `apps/api/test/fase10-gestao.test.ts` — 21 testes cobrindo os aceites 1–46 (agrupados). **Contraprova:** com o código da base (`apps/api/src` de `1aa916f`), **18 falham**; os 3 que passam confirmam regras já corretas (ordenação por categoria, permissões dos itens existentes, histórico próprio da presença). Aceites cobertos por suítes existentes: 11 (cobrança — `cobranca.test.ts`), 33 (titular — `distribution`/`labor`), 39 (menu por permissão — `admin.spec`), 42/43 (WebSocket e Meus Ganhos — suítes R1/segurança), 44 (ação canônica — E2E), 45 (rotas antigas — geometria/visual), 46 (deep-links: cada destino aplica a própria permissão).
- **46. API/shared/web:** API **748 aprovados**, 10 ignorados (condicionais); shared 127; web 6. Um teste existente (`saneamento.test.ts`) passou a informar o motivo ao alterar o prazo da OS (regra nova D1) — asserções inalteradas.
- **47. E2E:** **46/46** (novo `gestao.spec.ts`: gestor entra → Início → cartão Prazos → Central → "Abrir" → OS → alterar prazo sem motivo é recusado → com motivo salva → linha do tempo mostra o motivo → item some da Central e do Início). Datas relativas ao dia da oficina.
- **48. format/lint/typecheck/build:** OK.

## 49. Auditoria ponta a ponta (somente leitura)

| Domínio                | Resultado        | Evidência                                                          |
| ---------------------- | ---------------- | ------------------------------------------------------------------ |
| Novo serviço           | PASS             | `services` tests, `novo-servico.spec`                              |
| Retirada               | PASS             | `team-route-os.spec`, `team-logistics.spec`                        |
| Recebimento            | PASS             | `recebimentos*.spec`, testes de recebimento                        |
| OS/peças               | PASS             | `commercial-flow.spec`, testes de OS                               |
| Medição                | PASS             | `measurements.spec`                                                |
| Materiais              | PASS             | `compras-*` specs                                                  |
| Compras                | PASS WITH CAVEAT | caveats das Etapas 1–3                                             |
| Planejamento           | PASS             | `pre-planejamento.spec`, `team-queue.spec`                         |
| Produção               | PASS             | `production.spec`, `team-week.spec`, `team-workshop.spec`          |
| Titular/apoio          | PASS WITH CAVEAT | `team-distribution.spec`, `team-presenca-apoio.spec`; caveat D3/D4 |
| Prazos                 | PASS             | `prazos.spec` + Fase 10 (regra única)                              |
| Qualidade/retrabalho   | PASS             | `team-quality.spec`                                                |
| Embalagem/pronto       | PASS             | `team-quality.spec`                                                |
| Entrega                | PASS WITH CAVEAT | `team-quality.spec` (inclui parcial); caveat 3 da Fase 8           |
| Cobrança               | PASS WITH CAVEAT | `cobranca.spec`; caveats 1–2 da Fase 8                             |
| Mão de obra/logística  | PASS             | `team-labor.spec`, `team-logistics.spec`                           |
| Meus Ganhos            | PASS             | `team-finance.spec`, suíte R1                                      |
| Negociação/confirmação | PASS             | `team-negociacao.spec`                                             |
| Pagamento              | PASS             | `team-closing.spec`, `team-negociacao.spec`                        |
| Central/auditoria      | PASS WITH CAVEAT | Fase 10; caveats abaixo                                            |

Nenhum P0/P1 de integridade encontrado.

## 50. Matriz das 10 fases

Numeração do plano principal conforme as autorizações recebidas (Fase 7 "Presença e apoio", Fase 8
"Qualidade, finalização e entrega", Fase 10 "Gestão"); a Fase 9 é o bloco financeiro que a própria
autorização da Fase 10 lista (Cobrança, R1/Meus Ganhos, R2/negociação/confirmação, D12, D13).

| Fase | Objetivo                                    | Evidência                                                                                                                                  | Status                  |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1    | Auditoria e arquitetura                     | `SIMPLIFICACAO-FASE-1-AUDITORIA-ARQUITETURA.md` (plano, decisões D1–D13)                                                                   | CONCLUÍDA               |
| 2    | Novo serviço, cliente e retirada integrados | `SIMPLIFICACAO-FASE-2-NOVO-SERVICO.md`, `SIMPLIFICACAO-ESTABILIZACAO-FASES-2-4.md`; `novo-servico.spec`                                    | CONCLUÍDA               |
| 3    | Recebimentos compartilhados                 | `SIMPLIFICACAO-FASE-3-RECEBIMENTOS-COMPARTILHADOS.md`; `recebimentos*.spec`                                                                | CONCLUÍDA               |
| 4    | Produção a planejar (+ Prazos/D9)           | `SIMPLIFICACAO-FASE-4-PRE-PLANEJAMENTO.md`, `PRAZOS-SERVICOS-EM-RISCO-RELATORIO.md` (GO WITH CAVEATS), `SANEAMENTO-FUNCIONAL-RELATORIO.md` | CONCLUÍDA COM RESSALVAS |
| 5    | Modelos de produção simplificados           | `SIMPLIFICACAO-FASE-5-RELATORIO.md`; `modelos-simplificados.spec`                                                                          | CONCLUÍDA               |
| 6    | Compras sem duplicidade (Etapas 1–3)        | `COMPRAS-SEM-DUPLICIDADE-ETAPA-{1,2,3}-RELATORIO.md` (GO WITH CAVEATS)                                                                     | CONCLUÍDA COM RESSALVAS |
| 7    | Presença e apoio simplificados              | `SIMPLIFICACAO-FASE-7-PRESENCA-APOIO-RELATORIO.md` (GO WITH CAVEATS)                                                                       | CONCLUÍDA COM RESSALVAS |
| 8    | Qualidade, finalização e entrega            | `FASE-8-QUALIDADE-FINALIZACAO-ENTREGA-RELATORIO.md` (GO WITH CAVEATS)                                                                      | CONCLUÍDA COM RESSALVAS |
| 9    | Financeiro: Cobrança, R1/Meus Ganhos, R2    | `COBRANCA-CLIENTE-RELATORIO.md`, `R1-…`, `R2-…` (GO WITH CAVEATS)                                                                          | CONCLUÍDA COM RESSALVAS |
| 10   | Gestão, indicadores, auditoria e fechamento | este relatório; `fase10-gestao.test.ts`, `gestao.spec.ts`; homologação `9fb1786`                                                           | CONCLUÍDA COM RESSALVAS |

## 51. Caveats por fase

- **4:** regras de prazo próprias do domínio de ocorrências (`quickDeadlineRisk`, janela das propostas) permanecem — são do domínio de ocorrências, não do prazo do serviço.
- **6:** caveats documentados nas Etapas 1–3.
- **7:** impacto de presença só para o dia corrente.
- **8:** (1) pagamento informado em tentativa frustrada bloqueia a seguinte; (2) responsável da equipe própria não informa pagamento coletado; (3) peças antigas só recalculam no próximo evento. **Não corrigidos** (instrução), não impedem requisito da Fase 10.
- **9:** pagamentos informados com `collected=false` não aparecem como decisão.
- **10:** D3/D4 (conteúdo da auditoria da troca de titular), D9 (resumo limitado a 300 caracteres — motivo completo nos históricos de domínio), D11 (SET NULL latente; `domain_events` apagáveis por desenho); `at` do PRAZO_OS = `updatedAt` da OS; itens dos domínios já existentes exigem só `ocorrencias.ver` (como antes); tabelas largas sem rolagem própria em telas antigas (geometria sem rolagem horizontal); N+1 das retiradas no Início; dois fluxos de criação de pedido coexistem (Novo serviço e pedido avulso); CI no limite de 45 min (40 min neste SHA, folga de 5 min); sem clique na aplicação em homologação (evidência funcional: CI + E2E do mesmo SHA).

## 52–60. Homologação (`9fb1786`)

| Passo                       | Resultado                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pré-check                   | ativa/candidata/migrada `1aa916f`; disco 63%; `images_cleanup_plan`: 0 candidatas (só versão ativa e do ponto de recuperação)                                       |
| build                       | Cloud Build SUCCESS (`api`/`web` com a etiqueta do SHA completo)                                                                                                    |
| prepare_version             | OK — 31 na imagem, 31 aplicadas; a imagem não migra na partida                                                                                                      |
| migration_precheck          | PREFLIGHT OK — 0 pendentes                                                                                                                                          |
| 52. recovery point          | `cenario-staging-20261018T214717Z` (versão anterior `1aa916f`, impressão `06194921…`), enviado a `gs://cenariogestao-homolog-backups/`                              |
| 53. backup/restore          | restauração de teste **IDÊNTICA** (conteúdo, vínculos, catálogo, valores); `backup_validate` SHA256SUMS conferido                                                   |
| migrate                     | "Database schema is up to date" (nenhuma migration)                                                                                                                 |
| 54. versão ativa            | `9fb1786beddae28c34b20a0922b42989ecb0fbf2` (etiqueta local, pilha, candidata e migrada); portão fechado                                                             |
| 55. migration_verify        | **31/31**; nada pendente, ausente ou incompleto                                                                                                                     |
| 56. health                  | OK (disco 75%, memória ~1 GB livre, certificado válido)                                                                                                             |
| 57. smoke                   | OK; `run_homologation_tests suite=completo`: saúde, acesso e websocket ✔                                                                                           |
| 58. WebSocket               | `/api/realtime` pelo proxy: 401 sem sessão (esperado)                                                                                                               |
| 59. logs                    | api, web, postgres, caddy (15 min): nenhum erro                                                                                                                     |
| 60. fingerprint/schema/data | esquema **idêntico** (colunas, restrições, índices, gatilhos, tipos); dados idênticos exceto `devices` (mesma contagem, 2) — sinal de um dispositivo real conectado |

Sem clique manual na aplicação (o processo não oferece sessão de navegador na homologação; infraestrutura não ampliada). Evidência funcional: CI + E2E completo do mesmo SHA.

## 61. Produção

Absolutamente intocada: nenhum deploy, migration, teste, escrita, limpeza, smoke, usuário ou pedido.

## 62. Classificação final

**GO WITH CAVEATS.** Nenhum critério de NO-GO presente: indicadores pelas fontes canônicas (testes de coerência Central × Início), uma única regra de prazo, uma única fonte financeira, nenhuma pendência crítica invisível conhecida, ações pelos fluxos de domínio, sem vazamento financeiro (tablet 403, `finance: null`, WebSocket só invalida), auditoria ampliada (nada removido), regressão completa verde, CI verde, homologação consistente, nenhuma migration, nenhum dado histórico alterado, produção intocada. Caveats: item 51.

## O Cenário Gestão concluiu as 10 fases planejadas?

**Sim.** As 10 fases planejadas estão concluídas, com evidência de repositório, testes, CI e homologação:

- **CONCLUÍDAS:** 1 (auditoria e arquitetura), 2 (Novo serviço), 3 (Recebimentos compartilhados), 5 (Modelos de produção).
- **CONCLUÍDAS COM RESSALVAS:** 4 (Produção a planejar + Prazos), 6 (Compras sem duplicidade), 7 (Presença e apoio), 8 (Qualidade, finalização e entrega), 9 (Financeiro: Cobrança, R1, R2), 10 (Gestão).

Nenhuma fase está NÃO CONCLUÍDA. As ressalvas (item 51) são conhecidas, documentadas e não bloqueiam a operação; ficam para decisão do proprietário. Encerrado aqui: nenhuma Fase 11, melhoria, refatoração, produção ou roteiro novo foi iniciado.
