# Área 4: Planejamento semanal (R7), Painel gerencial (R8), Ajuda/Medições e pedidos anteriores (R9–R12)

Auditoria somente leitura. ANTES = `7b4177b`, DEPOIS = `696e3e9` (em produção). Situação de produção: interruptores no padrão (todos LIGADOS: `logistica`, `ajuda`, `embalagem`, `materiais`) e banco vazio.
As referências seguem o formato `caminho:linha @sha`. Componente, API ou teste unitário **não** foram aceitos sozinhos como "atendido". Quando há evidência funcional, ela vem de um spec E2E indicado pelo nome.

## Resumo

| Grupo | ATENDIDO | PARCIAL | NÃO ATENDIDO | NÃO VERIFICADO | Fora do escopo |
|---|---|---|---|---|---|
| R7 (8) | 6 | 2 | 0 | 0 | – |
| R8 (7) | 6 | 1 | 0 | 0 | – |
| R9 (11) | 5 | 3 | 3 | 0 | – |
| R10 (10) | 7 | 2 | 0 | 1 | – |
| R11 (6) | 5 | 1 | 0 | 0 | – |
| R12 (6) | – | – | – | – | 6 |

Obs.: vários itens marcados como ATENDIDO já existiam antes da reformulação (R7.3, R7.4, R7.6, R7.8, R8.2, R8.5, R8.7). A reformulação não os alterou de forma relevante.

### Contagem concreta de ações para planejar e publicar uma semana

| Passo | ANTES (7b4177b) | DEPOIS (696e3e9) |
|---|---|---|
| 1 | Menu "Produção — A planejar" (`nav.ts:156 @7b4177b`) | Menu "Programação semanal" (`nav.ts:167-171 @696e3e9`) → aba "Serviços" (padrão) → subaba "A planejar" (padrão) |
| 2 | "Planejar serviço" (`preplanning-page.tsx:302 @7b4177b`) | "Planejar serviço" (`preplanning-page.tsx:300 @696e3e9`) |
| 3–4 | Escolher o tapeceiro (obrigatório) e a data de início | Igual (`preplanning-page.tsx:574, 672 @696e3e9`) |
| 5 | "Adicionar ao planejamento" (cria o **rascunho**) | Igual |
| 6 | Aba "Planejados" | Igual (subaba dentro da aba "Serviços") |
| 7 | "Revisar e publicar semana" (`:360 @7b4177b`) | Igual (`:358 @696e3e9`) |
| 8 | Diálogo de prévia → "Publicar semana" | Igual (`publish-week-dialog.tsx @696e3e9`, diálogo unificado) |
| **Total** | **8 ações, 1 tela + 2 diálogos** | **8 ações, 1 tela (com 2 níveis de abas) + 2 diálogos** |

Conclusão: o número de ações **não diminuiu**. O ciclo rascunho → revisar → publicar continua inteiro. A Fase 3 juntou 3 itens de menu em 1 e transformou os 2 diálogos de publicação em 1 (`publish-week-dialog.tsx:16-21 @696e3e9`). O caminho para a tarefa chegar ao tablet continua igual. Ainda vale a regra "só a programação publicada libera as tarefas" (`weekly-schedule-page.tsx:45 @696e3e9`).
Depois de publicar, qualquer ajuste na "Semana detalhada" exige um "Motivo das alterações" e gera uma revisão (`planning-page.tsx:186-193, 217 @696e3e9`). Essa regra é anterior e foi mantida.

### Profundidade de navegação do gestor (DEPOIS)

| Informação | Onde | Cliques a partir do login |
|---|---|---|
| Situação do dia (em execução, na oficina, prontas, pendências, sugestões) | Início → painel "Hoje" (`dashboard.tsx:130`, `today-panel.tsx:59-250 @696e3e9`) | 0 (novo) |
| Atrasos e prazos em risco | Início → cartão de prazos (`dashboard.tsx:160 @696e3e9`; já existia em `:157 @7b4177b`) e alertas "PRAZO_EM_RISCO" no "Hoje" (`management/today.ts:149-157 @696e3e9`) | 0 para a contagem, 1 para a lista |
| Financeiro resumido | Início → seção Financeiro (`dashboard.tsx:325 @696e3e9`; já existia em `:322 @7b4177b`) | 0 |
| Produtividade | Financeiro → aba Produtividade (já existia) **ou** Programação semanal → aba Produtividade (nova, `weekly-schedule-page.tsx:64, 74 @696e3e9`) | 2 |
| Situação de cada OS | Ordens de serviço → selo de estado | 1 |

---

## (a) R7 – Planejamento semanal e R8 – Painel gerencial

| ID | Requisito (resumo) | Antes (7b4177b) | Depois (696e3e9) | Evidência no código (path:line @sha) | Evidência funcional | Depende de interruptor? | Classificação | Correção necessária (mínima) |
|---|---|---|---|---|---|---|---|---|
| R7.1 | Organizar o trabalho por semana | Plano por semana em duas telas ("A planejar" e "Planejamento de produção") | Uma tela, "Programação semanal", com abas Serviços / Semana detalhada / Produtividade. O plano continua sendo um por semana | `apps/web/components/production/weekly-schedule-page.tsx:23-78 @696e3e9`; `apps/api/src/modules/production/pre-planning.ts:90-122 @696e3e9` | `pre-planejamento.spec.ts` (fluxo planejar → publicar → tablets, ainda pelo endereço antigo `/painel/producao/a-planejar`, que redireciona); `zz-fase3-qualidade-programacao.spec.ts:156` (só a tela e as rotas) | Não | ATENDIDO | – |
| R7.2 | Preparar o planejamento com antecedência | Data futura, rascunho invisível aos tablets. A OS só entra em "A planejar" com as peças **fisicamente recebidas** | **Sem mudança.** A aba "Serviços" ignora OS sem recebimento (`continue`) e a API recusa "as peças ainda não chegaram". Pela "Semana detalhada" a OS pode entrar, mas as tarefas ficam bloqueadas com `PECA_NAO_RECEBIDA` | `apps/api/src/modules/production/pre-planning.ts:176-177, 425-426 @696e3e9`; `preplanning-page.tsx:241 @696e3e9` ("Quando as peças chegarem…"); `packages/shared/src/production-domain.ts:352 @696e3e9` | `pre-planejamento.spec.ts` só cobre OS já recebida. Nenhum E2E planeja uma OS antes da chegada | Não | PARCIALMENTE ATENDIDO | Mostrar em "A planejar" as OS ainda não recebidas (marcadas como "aguardando chegada") e aceitar `plan-services` para elas. A trava `PECA_NAO_RECEBIDA` na liberação continua segurando a execução |
| R7.3 | Distribuir os serviços entre os funcionários | Tapeceiro titular por peça + distribuição automática (preparação/tapeçaria) | Igual, sem mudança funcional | `pre-planning.ts:440-481 @696e3e9` (`distributeServiceOrder`) | `team-distribution.spec.ts`; `pre-planejamento.spec.ts` (Ricardo/Márcio) | Não | ATENDIDO | – |
| R7.4 | Mostrar tarefas e responsáveis | Prévia por profissional, filas por pessoa, "Minha semana" no tablet | Igual. Diálogo único de prévia, com distribuição por profissional | `publish-week-dialog.tsx @696e3e9`; `pre-planning.ts:292-371 @696e3e9` (`publicationPreview.byAssignee`) | `pre-planejamento.spec.ts` (`publish-preview`); `team-week.spec.ts` | Não | ATENDIDO | – |
| R7.5 | Sugestões automáticas sem tirar o controle do gestor | Tarefas geradas pelo motor no rascunho, editáveis antes de publicar | Igual, mais as "Ações sugeridas hoje" no Início (só links, não executam nada). O **titular não é sugerido**: o gestor escolhe sempre, e a data padrão é "hoje" | `pre-planning.ts:471-483 @696e3e9`; `management/today.ts:350-400 @696e3e9`; `today-panel.tsx:114 @696e3e9` | `team-distribution.spec.ts` ("geração sem distribuição manual, substituição auditada"); `zz-fase4-hoje.spec.ts:40-46` (sugestões sem botão) | Não | ATENDIDO | (Opcional) pré-preencher o titular com o `plannedUpholstererUserId` do fechamento |
| R7.6 | Ajustes manuais | Reprogramar data/prioridade, reordenar a fila, trocar titular, dependências | Igual. Os ajustes finos (dependências, filas, inclusão de etapa) ficam só na aba "Semana detalhada" (só com `producao.planejar`). Depois de publicar, cada ajuste exige motivo | `planning-page.tsx:186-193, 217, 269-283 @696e3e9`; `apps/api/src/modules/production/queue.ts:160-227 @696e3e9`; `pre-planning.ts:532-560 @696e3e9` | `team-week.spec.ts` ("reordenação"); `team-queue.spec.ts` | Não | ATENDIDO | – |
| R7.7 | Considerar os prazos dos serviços | Prazo exibido; listas ordenadas por `promisedDate`; alerta de prazo no Início | Igual, mais o alerta "PRAZO_EM_RISCO" e a sugestão "Revisar a programação" no "Hoje". O prazo **não** entra na ordem da fila nem na liberação, e o diálogo de planejamento não avisa quando a data de início fica depois do prazo | `pre-planning.ts:159 @696e3e9` (ordem da lista); `apps/api/src/modules/production/service-priority.ts:21 @696e3e9` ("O prazo prometido não entra aqui"); `packages/shared/src/production-domain.ts:476-480 @696e3e9`; `management/today.ts:149-157, 350-353 @696e3e9` | `prazos.spec.ts` (Central/prazos, herdado). Nenhum E2E de prazo dentro da programação | Não | PARCIALMENTE ATENDIDO | Aviso no `PlanDialog` e na prévia de publicação quando a data de início for depois do prazo ou o prazo cair na semana. Opcionalmente, desempatar a posição inicial na fila pelo prazo |
| R7.8 | Liberdade de iniciar ou não uma tarefa planejada | Nada inicia sozinho. Qualquer tarefa LIBERADA pode ser iniciada. Uma principal em execução por vez | Igual, sem mudança | `apps/api/src/modules/production/queue.ts:8-10 @696e3e9` ("Nada inicia sozinho"); `apps/api/src/modules/production/tasks.ts:1031-1037 @696e3e9` (só exige LIBERADA); `tasks.ts:218-243 @696e3e9` (uma ativa por vez) | `team-queue.spec.ts` ("início explícito") | Não | ATENDIDO | – |
| R8.1 | Visão clara dos serviços em andamento | Quadro de produção; cartões de operação no Início | Novo painel "Hoje" com "Em execução", "Na oficina" e "Prontas", mais o "Mapa da oficina" | `apps/web/components/admin/today-panel.tsx:120-201 @696e3e9`; `dashboard.tsx:130 @696e3e9` | `zz-fase4-hoje.spec.ts:36-37` (seções visíveis); `fase2-mapa-oficina.spec.ts` | Não | ATENDIDO | – |
| R8.2 | Identificar atrasados ou perto do vencimento | Cartão de prazos no Início → Central filtrada | Igual, mais alertas internos de prazo e sugestão no "Hoje" | `dashboard.tsx:157 @7b4177b` → `:160 @696e3e9`; `apps/api/src/modules/management/today.ts:74, 149-157 @696e3e9` | `prazos.spec.ts` (herdado). `zz-fase4-hoje.spec.ts` não testa prazo | Não | ATENDIDO | – |
| R8.3 | Acompanhar a produtividade dos profissionais | Financeiro → Produtividade (exige `financeiro.ver`) | Também em Programação semanal → Produtividade (sem valores, com `producao.planejar`). Fica fora do Início (2 cliques) | `weekly-schedule-page.tsx:64, 74 @696e3e9`; `productivity-tab.tsx:16-35 @696e3e9`; `finance-page.tsx:37 @696e3e9` | `zz-fase4-hoje.spec.ts:49-52` (só verifica que a tabela aparece e não tem R$; não valida números) | Não | ATENDIDO | (Opcional) resumo de produtividade no Início |
| R8.4 | Ver a situação de cada OS | Status técnico ("Aberta") | Estado operacional derivado (selo), "próximo passo" no cabeçalho da OS | `apps/web/components/admin/...` lista de OS com `os-state-badge` (Fase 2/3) | `fase2-os-estado-fotos.spec.ts`; `zz-fase3-qualidade-programacao.spec.ts:141-147` | Não | ATENDIDO | – |
| R8.5 | Informações financeiras e operacionais sem muitas telas | Início com seções Operação, Entregas e Financeiro | Igual, mais o "Hoje" | `dashboard.tsx:238, 292, 325 @696e3e9` | `team-finance.spec.ts` ("painel"); `zz-fase4-hoje.spec.ts` | Não | ATENDIDO (já existia antes; acréscimo pequeno) | – |
| R8.6 | Simplificar a navegação | 35 itens em 6 grupos | 34 itens. Saíram 4 itens e entraram 3. Com os padrões LIGADOS, o administrador vê **todos os 34**. Continuam no menu os paralelos antigos: Compras, Fornecedores, Recebimento de materiais, Estoque **e** Estoque da oficina, Prontidão, Materiais aprovados, Medições, Reprogramação, Retiradas/Roteiro (logística LIGADA), Recebimentos, Pedidos comerciais | `apps/web/components/admin/nav.ts:98-295 @696e3e9`; `visibleNav` `:301-311` | `zz-fase3-qualidade-programacao.spec.ts:172-179` (itens removidos); `zz-auditoria-funcional.spec.ts:270` (menu × acesso) | **Sim**: só os itens de logística e ajuda somem, e só com o interruptor DESLIGADO | PARCIALMENTE ATENDIDO | Esconder do menu padrão os módulos formais que o dono pediu para tirar do fluxo (compras/fornecedores/recebimento de materiais/estoque formal/prontidão/materiais aprovados), por exemplo com um grupo "Avançado" recolhido ou interruptores com padrão DESLIGADO em instalação nova |
| R8.7 | Manter o histórico completo de clientes e serviços | Histórico do cliente (pedidos/OS), histórico da OS, auditoria | Igual, sem mudança | `apps/api/src/modules/customers/routes.ts:179-209 @696e3e9` | `zz-auditoria-fluxos.spec.ts:140` (clientes: abrir/editar) | Não | ATENDIDO (já existia) | – |

---

## (b) Pedidos de ajuda e Medições: comportamento ANTES e DEPOIS

O dono **não** pediu, na seção 1.A, para remover nenhum dos dois. Por isso não são classificados como pendências de remoção. O texto abaixo descreve só o comportamento e se eles impõem passos obrigatórios ao fluxo normal da OS.

### Pedidos de ajuda

| Aspecto | ANTES (7b4177b) | DEPOIS (696e3e9) |
|---|---|---|
| Menu do painel | "Pedidos de ajuda" sempre visível para `producao.ver`/`producao.planejar` (`nav.ts:174 @7b4177b`) | Mesmo item, agora condicionado a `module: 'ajuda'` (`nav.ts:192-198 @696e3e9`). Como o padrão é LIGADO, **continua visível em produção** |
| Botão no tablet | `canAskHelp` = só a permissão `ajuda.solicitar` (`tablet/home.tsx:96 @7b4177b`) | `canAskHelp` = permissão **e** `modules.ajuda` (`tablet/home.tsx:90 @696e3e9`). Visível em produção. "Pedir ajuda" / "Pedir ajuda agora" (`tablet/help.tsx:306`) |
| Servidor | Rotas sem verificação de módulo | `assertModuleEnabled(prisma,'ajuda')` em `help/routes.ts:212, 340, 463, 478 @696e3e9`; fila de ajuda inerte com o módulo desligado (`help/queue.ts:263`); Central de atenção omite "AJUDA" (`issues/attention.ts:134`) |
| Fluxo | Funcionário pede → motor procura ajudante pela competência e presença → tarefa de apoio. Urgente sem ajudante vira proposta para o gestor aprovar ou recusar | Sem mudança |
| Obrigatório no fluxo normal da OS? | **Não.** Só acontece quando o funcionário pede | **Não.** A produção segue normal com o módulo desligado (`modules.ts:35-41 @696e3e9`) |
| Efeito colateral | "Reprogramação" (propostas) é um item fixo do menu, sem interruptor (`nav.ts:199-204 @696e3e9`). Quando uma tarefa fica bloqueada, o sistema só **sugere** a próxima (`help/reschedule.ts:170-200, 302-304`). Com **ausência confirmada**, o sistema **executa sozinho** as "mudanças simples" e propõe o resto (`help/reschedule.ts:500-508`) | Igual. Não depende do interruptor `ajuda` |

### Medições e "rotina de sexta"

| Aspecto | ANTES | DEPOIS |
|---|---|---|
| Menu | "Medições" (`nav.ts:143 @7b4177b`) e "Planejamento de sexta" (`nav.ts:149 @7b4177b`) | "Medições" continua (`nav.ts:157-162 @696e3e9`). "Planejamento de sexta" saiu do menu, mas a página continua (`app/painel/planejamento/page.tsx @696e3e9`) e tem link a partir de Medições (`measurements/measurements-page.tsx:38-41`). Não há interruptor |
| Tablet | Card "Medições atribuídas" para `medicoes.extraordinarias`/`medicoes.gerenciar` | Igual (`tablet/home.tsx:84-86 @696e3e9`). O código das medições não mudou entre as versões |
| Rotina de sexta | `CompanySettings.planningWeekday = 5` e `measurementWeekday = 5`. Checklist "Peças recebidas aguardando medição → medições → solicitações → materiais aprovados → compra/recebimento" | Igual (`schema.prisma:386-389 @696e3e9`; `measurements/planning-page.tsx:137-243`). Publicar fora da sexta só marca "fora da sexta" na revisão (`planning-page.tsx:294`; `plans.ts:533`): é aviso, não bloqueio |
| A medição exige recebimento físico? | Sim | **Sim**: "A medição operacional só é possível após o recebimento físico da peça" (`measurements/routes.ts:101-103 @696e3e9`) |
| A medição é obrigatória antes da aprovação de material? | Sim no fluxo formal: a solicitação de material nasce da medição e é aprovada pelo gestor (`measurements/routes.ts:876-888`) | Igual no fluxo formal. A lista simples de materiais da OS (Fase 1, `os-materials`) é independente e não exige medição |
| A medição é obrigatória antes da produção? | **Na prática, sim**, para etapas com `requiresMaterials`: sem levantamento a prontidão fica `SEM_LEVANTAMENTO`, e a tarefa só é liberada com prontidão `COMPLETO` | **Igual com o padrão de produção (`materiais` LIGADO)**: `taskMaterialsReady` exige `COMPLETO` (`production/common.ts:349-366 @696e3e9`), e `computeReadiness` devolve `SEM_LEVANTAMENTO` sem medição (`purchasing-domain.ts:264-265`). Uma medição ou solicitação aberta também segura a tarefa (`purchasing/common.ts:900-906`). A trava só deixa de valer com o interruptor **DESLIGADO**. **[Correção na consolidação]** o banco vazio também é afetado: as migrations gravam os modelos padrão (5 modelos e 22 etapas em produção) com `requires_materials = true` nas etapas principais (`20261230000000_modelos_simplificados/migration.sql:36-48`, `20261010000000_producao/migration.sql:273-304`). O padrão `false` da coluna só vale para etapas novas criadas sem marcar a opção |
| Conflito com a simplificação (R2.x/R1.x) | – | **Sim, condicional**: com o padrão LIGADO, qualquer etapa marcada como "exige materiais" volta a depender de medição → solicitação → aprovação → compra/recebimento ou reserva. Isso contraria "não bloquear o início da produção por falta de informações de compras" (R2.15) **a menos que o interruptor seja desligado** (conta contra) |

---

## (c) Pedidos anteriores (1.B), grupos 9–11 (verificação mais leve) e grupo 12

| ID | Requisito (resumo) | Antes (7b4177b) | Depois (696e3e9) | Evidência no código (path:line @sha) | Evidência funcional | Depende de interruptor? | Classificação | Correção necessária (mínima) |
|---|---|---|---|---|---|---|---|---|
| R9.1 | Profissionais fixos CLT e prestadores CNPJ | Não existe | Não existe. O cadastro de funcionário não tem tipo de vínculo, CPF/CNPJ nem regime | `packages/db/prisma/schema.prisma:184-211 @696e3e9` (model Employee) | Nenhuma | Não | NÃO ATENDIDO | Campo "vínculo" (CLT/CNPJ) e documento no cadastro |
| R9.2 | Salário ou valor combinado | Só valor combinado por OS/peça | Igual. Não há salário fixo | `schema.prisma:3099-3107 @696e3e9` (`ProductionPayable.agreedCents`) | `team-labor.spec.ts` (valor por peça) | Não | PARCIALMENTE ATENDIDO | Salário/valor fixo por profissional |
| R9.3 | Registrar pagamentos | Pagamento de profissional + fechamento semanal | Igual | `schema.prisma:3156-3176 @696e3e9` (`ProfessionalPayment`) | `team-closing.spec.ts` ("registrar Pix… estornar") | Não | ATENDIDO | – |
| R9.4 | Armazenar documentos | Não existe | Não existe. Funcionário só tem foto | `schema.prisma:194, 201 @696e3e9` | Nenhuma | Não | NÃO ATENDIDO | Anexos de documentos no funcionário |
| R9.5 | Atestados, faltas, ausências | Presença com ATESTADO/ausência/férias | Igual | `schema.prisma:2154-2166, 3738-3757 @696e3e9` | `team-presence.spec.ts`; `team-presenca-apoio.spec.ts` | Não | ATENDIDO | – |
| R9.6 | Integrar os custos dos profissionais ao financeiro | Mão de obra por produção no Financeiro | Igual. Salários fixos não existem | `schema.prisma:3100-3129 @696e3e9` | `team-finance.spec.ts` ("valor de produção") | Não | PARCIALMENTE ATENDIDO | Depende de R9.2 |
| R9.7 | Valor do profissional opcional | Mão de obra prevista é nula quando não informada | Igual | `schema.prisma:730-736 @696e3e9` (`plannedLaborUnitCents Int?`) | `team-labor.spec.ts` (indireto) | Não | ATENDIDO | – |
| R9.8 | Atribuir profissionais por dia de trabalho | Plano "por horário" (antigo) ou fila semanal | Igual. A fila semanal não tem dia ("tarefas não têm data nem horário"). Só a data de início por OS | `plans.ts:885-888 @696e3e9`; `pre-planning.ts:462-468 @696e3e9` | `team-queue.spec.ts` | Não | PARCIALMENTE ATENDIDO | – (decisão de produto: fila semanal) |
| R9.9 | Serviços de vários dias | Fila contínua, nada zera à meia-noite | Igual | `queue.ts:4-7 @696e3e9` | `team-queue.spec.ts` ("continuidade em dois dias") | Não | ATENDIDO | – |
| R9.10 | Jornadas com horários diferentes | Só o expediente da empresa | Igual. Não há jornada por profissional | `schema.prisma:376-385 @696e3e9` (`CompanySettings.workdayStart/End`) | Nenhuma | Não | NÃO ATENDIDO | Jornada por funcionário |
| R9.11 | Ganhos individuais dos profissionais | "Meus valores" no tablet com PIN | Igual | `apps/api/src/modules/finance/my-earnings.ts:81, 328 @696e3e9` | `team-labor.spec.ts`; `team-finance.spec.ts` ("Meus valores") | Não | ATENDIDO | – |
| R10.1 | Planejamento semanal das tarefas | = R7.1 | = R7.1 | `weekly-schedule-page.tsx:23-78 @696e3e9` | `pre-planejamento.spec.ts` | Não | ATENDIDO | – |
| R10.2 | Responsável principal por sofá | Titular por peça | Igual | `schema.prisma:1076-1077 @696e3e9` (`ServiceOrderItem.upholstererUserId`) | `team-distribution.spec.ts` | Não | ATENDIDO | – |
| R10.3 | Registrar início e término | Rotas de início/conclusão | Igual | `production/tasks.ts:1249-1262 @696e3e9` | `team-queue.spec.ts`; `team-workshop.spec.ts` | Não | ATENDIDO | – |
| R10.4 | Pausas e retomadas | Rotas de pausa/retomada | Igual | `production/tasks.ts:1253-1258 @696e3e9` | `team-workshop.spec.ts` | Não | ATENDIDO | – |
| R10.5 | Tablets na oficina | App do tablet | Igual (tablet simplificado na Fase 2) | `apps/web/components/tablet/home.tsx @696e3e9` | `tablets.spec.ts`; `team-workshop.spec.ts` | Não | ATENDIDO | – |
| R10.6 | Permissões específicas por funcionário | Funções + permissões por usuário | Igual | `schema.prisma:256-264 @696e3e9` (`UserPermission`) | `zz-auditoria-fluxos.spec.ts:305, 480` (perfis/permissões) | Não | ATENDIDO | – |
| R10.7 | Não forçar o início de tarefas | = R7.8 | = R7.8 | `queue.ts:10 @696e3e9` | `team-queue.spec.ts` | Não | ATENDIDO | – |
| R10.8 | Preservar apontamentos de produção | Eventos de tarefa e revisões imutáveis | Igual | `production/common.ts` (`taskEvent`); `plans.ts:114 @696e3e9` | Nenhum E2E específico de preservação | Não | NÃO VERIFICADO | – |
| R10.9 | Planejar manualmente semanas anteriores, com aviso | "Semana detalhada" cria plano de qualquer semana | Igual. A "Semana detalhada" aceita semana passada **sem aviso**; a aba "Serviços" **recusa** data passada | `plans.ts:739-777 @696e3e9` (sem checagem de data); `pre-planning.ts:410-414 @696e3e9`; `preplanning-page.tsx:574 @696e3e9` | Nenhuma | Não | PARCIALMENTE ATENDIDO | Mostrar aviso ao criar ou editar um plano de semana já passada |
| R10.10 | Considerar data e horário na fila | Modo antigo por horário; fila semanal sem horário | Igual. A data de início define a posição inicial e segura a liberação (`notBefore`). Não há horário | `queue-placement.ts:5-22 @696e3e9`; `production-domain.ts:476-480 @696e3e9` | `pre-planejamento.spec.ts` ("Aguardando a data de início") | Não | PARCIALMENTE ATENDIDO | – |
| R11.1 | Integrar custos de mão de obra | `ProductionPayable` por OS | Igual | `schema.prisma:3100-3124 @696e3e9` | `team-finance.spec.ts`; `team-labor.spec.ts` | Não | ATENDIDO | – |
| R11.2 | Registrar pagamentos dos profissionais | `ProfessionalPayment` | Igual | `schema.prisma:3156 @696e3e9` | `team-closing.spec.ts` | Não | ATENDIDO | – |
| R11.3 | Informações financeiras vinculadas às OS | Cobrança/recebimento/mão de obra por OS | Igual | `schema.prisma:3013, 3104 @696e3e9` | `team-finance.spec.ts` | Não | ATENDIDO | – |
| R11.4 | Serviços distribuídos em vários dias | Mão de obra por peça/OS, sem depender dos dias | Igual | `schema.prisma:3100-3111 @696e3e9` | Não há E2E que combine vários dias com o financeiro (`team-queue` e `team-labor` são separados) | Não | PARCIALMENTE ATENDIDO | – |
| R11.5 | Preservar o histórico financeiro | Estornos preservam o original | Igual | `schema.prisma:3169-3170, 3310 @696e3e9` | `team-closing.spec.ts` ("estornar") | Não | ATENDIDO | – |
| R11.6 | Mudança em serviço não compromete valores já registrados | Revisão de mão de obra na troca de titular | Igual | `schema.prisma:3564-3566 @696e3e9` (`LaborReview`) | `team-labor.spec.ts` ("substituição com revisão") | Não | ATENDIDO | – |
| R12.1–R12.6 | VerificaPro: planos, botão de chamada, 7 dias grátis, assinaturas, fluxo de contratação, web/API/app | – | – | `git grep -i "verificapro\|dias grátis\|subscription" 696e3e9 -- apps packages` → nenhum resultado. Só há menções em `docs/` | – | – | **Fora do escopo deste repositório** | – |

---

## Processos antigos que continuam interferindo

1. **O planejamento só aceita OS com as peças recebidas** (`pre-planning.ts:176-177, 425-426 @696e3e9`). A OS criada no fechamento (R1) não aparece em "A planejar" até haver um recebimento físico registrado. Isso impede o preparo antecipado pelo caminho simples (R7.2) e reintroduz, na prática, a dependência do recebimento.
2. **O ciclo rascunho → revisar → publicar ficou intacto**: 8 ações, igual ao ANTES. A tarefa só chega ao tablet depois de publicar. Depois de publicar, cada ajuste exige motivo e gera revisão (`planning-page.tsx:186-193, 217`). A consolidação da Fase 3 foi visual: menu e diálogo únicos.
3. **A trava de materiais está LIGADA no padrão** (`modules.ts:49-54`; `production/common.ts:349-366`). Etapas marcadas como "exige materiais" ficam bloqueadas até a prontidão `COMPLETO`. Isso exige medição → solicitação → aprovação → compra recebida ou reserva. A prévia de publicação mostra "Materiais pendentes (as etapas ficam bloqueadas)". Para ter o comportamento simples, é preciso **desligar o interruptor** (conta contra).
4. **Medição e "rotina de sexta" continuam ativas e sem interruptor**: `planningWeekday`/`measurementWeekday = 5`; o checklist de sexta continua acessível. A medição exige recebimento físico (`measurements/routes.ts:101`). Não bloqueiam a OS por si sós, mas alimentam a trava do item 3.
5. **Menu quase do mesmo tamanho (34 itens) com estruturas paralelas**: "Estoque" e "Estoque da oficina"; "Compras", "Fornecedores", "Recebimento de materiais", "Prontidão de materiais", "Materiais aprovados"; "Medições"; "Reprogramação"; "Retiradas"/"Roteiro do dia" (logística LIGADA). Com os padrões, nada disso some.
6. **Reprogramação automática por ausência confirmada** executa sozinha as "mudanças simples" (`help/reschedule.ts:500-508`), sem interruptor. É pequena, mas mexe na distribuição sem decisão explícita do gestor.
7. **O E2E principal do planejamento (`pre-planejamento.spec.ts`) não foi atualizado** e ainda navega por `/painel/producao/a-planejar` (endereço antigo, que redireciona). O novo E2E da Fase 3 (`zz-fase3-qualidade-programacao.spec.ts:156-187`) só verifica a renderização e as rotas, não planeja nem publica.
