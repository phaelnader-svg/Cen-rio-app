# Simplificação — estabilização das Fases 2, 3 e 4

Pendências apontadas pela auditoria de leitura (13/10/2026) e decisões aprovadas pelo responsável:

1. retirada opcional (cliente pode entregar as peças);
2. o fechamento registra tapeceiro titular e mão de obra prevista;
3. reavaliação das tarefas após a chegada, conforme o requisito original da Fase 3;
4. Fase 5 **não** iniciada (depende de revisão separada e aprovação de D6, D7 e D8).

Nada deste trabalho foi publicado em homologação ou produção. Resultados abaixo distinguem
teste local, CI, homologação e produção.

## Etapa 0 — estado inicial e matriz

- Branch `claude/cenario-gestao-fase-1-zf3bj2`, HEAD `5bb1518` = remoto, árvore limpa, sem
  stash nem alterações de terceiros.
- Fontes lidas: `SIMPLIFICACAO-FASE-1-AUDITORIA-ARQUITETURA.md` (§4.2–4.3, §5, §6, §16, §18),
  `SIMPLIFICACAO-FASE-2/3/4-*.md`, `AUDITORIA-TECNICA-OPERACAO.md`, commits `87f7103`
  (corrida na confirmação) e `b64f214…04176b4` (C3).

| #   | Lote | Requisito (origem)                                                                     | Situação no código (inspecionado)                                                                                                                                                                                                                                    | Arquivos                                                                          | Testes necessários                                                                       | Riscos                                                      |
| --- | ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1.1 | 1    | Liberação periódica não reprocessa OS de outras datas (auditoria; CA4-10)              | `releaseDueTasks` seleciona por `plan.items.some(startDate ≤ hoje)` (qualquer OS do plano) e grava `production.release_tick` a cada 30 s mesmo sem mudança; ramo `scheduledAt` também reseleciona tarefas da fila semanal ainda antes da data; `take: 500` sem ordem | `production/common.ts`                                                            | duas OS na mesma semana, dias diferentes; repetição sem auditoria nova; liberação no dia | liberar antes da hora; perder liberação                     |
| 1.2 | 1    | CA4-21 determinístico                                                                  | teste usa `day(9)`; aos domingos o `if (sameWeekLater)` pula a asserção                                                                                                                                                                                              | `test/pre-planejamento.test.ts`                                                   | data fixa (quarta-feira futura)                                                          | —                                                           |
| 1.3 | 1    | CA4-23 tablets/painel sem permissão em todas as rotas                                  | rotas `pipeline`, `publication-preview` (VIEW), `plan-services`, `planned/:id` (PLAN), `publish`; teste cobre só `plan-services` com tablet e usa `planId` como id do item                                                                                           | `production/pre-planning.ts`, `production/plans.ts`                               | 403 em todas, sem efeito colateral (contagens e versões iguais)                          | —                                                           |
| 1.4 | 1    | Rascunho esquecido em semana passada                                                   | requisito só define transferência **explícita** entre semanas (Fase 1 §6; Fase 4 §14); nenhuma regra automática definida                                                                                                                                             | `production/pre-planning.ts`, `production/queue.ts`                               | rascunho passado continua visível e pode ser reprogramado                                | inventar regra automática → **decisão pendente**            |
| 2.1 | 2    | CA3-10 concorrência com teste determinístico                                           | correção `87f7103` relê a versão após o saldo; teste atual (`Promise.all`) é probabilístico                                                                                                                                                                          | `arrivals/routes.ts`, `receipts/service.ts`                                       | intercalação forçada no ponto da corrida                                                 | gancho de teste não pode existir em produção                |
| 2.2 | 2    | Plano CA3-10: tarefas reavaliadas após a chegada                                       | `registerReceipt` não chama `reevaluateTasks`; materiais já reavaliam (`refreshReadiness` → `onReadinessChanged`). Com D1=B a OS nasce na chegada; `PECA_NAO_RECEBIDA` só ocorre em OS anterior à chegada (dado legado)                                              | `receipts/service.ts`, `production/common.ts`                                     | normal, repetição, falha intermediária, concorrência                                     | reprocessamento indevido; transição errada                  |
| 2.3 | 2    | Cobertura: data/hora gravadas, chave de idempotência no navegador, recusas, legado     | sem asserção de valor de data/hora; reuso da chave só no front sem teste                                                                                                                                                                                             | `web/components/tablet/arrivals.tsx`, testes                                      | API + E2E                                                                                | —                                                           |
| 2.4 | 2    | `recebimentos.registrar` em instalações existentes                                     | a investigar (seed × migration)                                                                                                                                                                                                                                      | `packages/db`, `shared/permissions.ts`                                            | —                                                                                        | alterar permissões remotas (proibido)                       |
| 3.1 | 3    | Plano CA2-07: serviço sem retirada                                                     | `newServiceSchema.pickup` obrigatório (`shared/schemas/commercial.ts`); rota sempre cria retirada                                                                                                                                                                    | `shared/schemas/commercial.ts`, `services/routes.ts`, `new-service-page.tsx`      | criação e chegada com e sem retirada; validações; falhas                                 | recebimento sem retirada (origem) e custos de transporte    |
| 3.2 | 3    | Fase 1 §4.3 opção B: titular e mão de obra prevista no fechamento ("intenção técnica") | OS automática usa `NO_EXTRA_PERMISSIONS`, sem titular nem mão de obra; nenhuma coluna de intenção em `commercial_order_items`                                                                                                                                        | schema/migration, `services/routes.ts`, `service-orders/auto.ts`, `finance/labor` | persistência, validação, geração da OS, alteração posterior, sem pagamento duplicado     | confundir previsto com pago; permissão do tablet na geração |

Fora deste trabalho (registrado, não tratado): D9 previa que a data de início também definisse a
**ordem** na fila (não implementado; a data virou trava de liberação) — exige decisão; geometria
estrita e script de migrações encadeadas fora do CI; Safari/WebKit e tablets físicos.

## Lote 1 — Fase 4 (pré-planejamento) — concluído

| Item | Resultado                                                                                                                                                                                                                                                                                                                                                                                      | Commit    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1.1  | `releaseDueTasks` seleciona, na fila semanal, só tarefas cuja **própria** OS (par plano + OS) chegou à data de início; auditoria só quando alguma tarefa muda; seleção ordenada. Regras de liberação inalteradas. Testes de regressão (duas OS em dias diferentes; liberação concorrente) **falhavam antes** e passam depois.                                                                  | `4a2830c` |
| 1.2  | CA4-21 com data fixa numa quarta-feira futura: a verificação final roda sempre (antes era pulada aos domingos). Nenhuma asserção removida.                                                                                                                                                                                                                                                     | `e71c2ed` |
| 1.3  | CA4-23: pipeline, prévia, planejar, reprogramar e publicar — tablet 403 em todas, painel só leitura 403 nas de escrita e 200 nas de leitura, anônimo 401; plano, item, tarefas, auditoria e eventos idênticos. Corrigido teste antigo que chamava `PUT /planned/undefined`. Autorização: regra de acesso da rota (hook `onRequest`, antes do corpo e do handler) — ponto único da arquitetura. | `1587616` |
| 1.4  | Rascunho esquecido em semana passada: comportamento explícito atual testado (segue visível como rascunho, nada é liberado nem transferido sozinho, tablet não vê, prévia avisa "data já passou", gestor reprograma). **Regra automática não definida no requisito → decisão pendente** (opções: manter manual; alerta na Central; transferir para a semana atual).                             | `ffb6da8` |

Resultados (locais nesta máquina, no commit `ebc8f36`): pré-planejamento 16/16; suíte completa da API
457 aprovados, 5 ignorados por desenho; lint, typecheck, formatação e build sem erros; E2E 32/32.
**CI nº 95 (`ebc8f36`): verde.** Homologação e produção: não publicado.

## Lote 2 — Fase 3 (recebimentos compartilhados) — concluído

| Item | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Commit               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2.1  | Teste **determinístico** da corrida do CA3-10: ponto de sincronização só para testes (`arrivalTestHooks`, indefinido em produção) força B a ler a retirada, A a confirmar e gravar, e só então B a ler o saldo. Confere 201/409, recebimento e OS únicos, saldo, obrigação única, retirada concluída, autoria e aviso removido. **Controle negativo**: sem a correção `87f7103`, o teste falha com o 400 original.                                                                           | `aa58c22`            |
| 2.2  | Reavaliação após a chegada (plano CA3-10): `registerReceipt` (ponto único — tablet e painel) reavalia, na mesma transação, as tarefas que aguardam início nas OS abertas com as peças recebidas. Com a OS gerada na chegada (D1), o caso real é a OS anterior à chegada (dados legados). Testes: normal, repetição, falha intermediária (desfaz junto) e concorrência (uma liberação). Controle negativo: sem a chamada, 3 dos 4 falham. Materiais já eram reavaliados (`refreshReadiness`). | `c1db2ee`            |
| 2.3  | Cobertura: data/hora gravadas (janela da requisição, resposta e auditoria; valor informado no painel gravado exatamente); recusas sem efeito (404, 403, retirada cancelada 409); pedido antigo confirmado no tablet sem OS automática; **E2E** da chave de idempotência no navegador (resposta perdida + tempo real retido → nova tentativa com a mesma chave, um recebimento e uma OS; controle negativo com chave nova falha).                                                             | `53ab31a`, `683c942` |
| 2.4  | `recebimentos.registrar` em instalações existentes: o seed só preenche funções vazias e a migration da Fase 3 não concedia. Nova migration `20261220000000_recebimentos_permissao_funcoes` (só dados, idempotente, mesmo padrão das migrations de produção e presença) + reversão manual (limitação documentada: não distingue concessão manual anterior); encadeada no script de migrações. Testada com os arquivos reais. **Não aplicada em nenhum ambiente remoto.**                      | `8f62287`            |

Observação (não alterada): com o tempo real ativo, uma resposta perdida é recuperada pelo
evento e o tablet mostra "Este aviso já foi atualizado… em outro aparelho ou não está mais
pendente" — seguro (sem duplicação), mas o texto não diz que foi o próprio aparelho.

Resultados (locais, commit `683c942`): API 466 aprovados, 5 ignorados por desenho; lint,
typecheck, formatação e build sem erros; E2E 33/33 (inclui o novo `recebimentos-rede`).
**CI nº 96 (`683c942`): verde.** O `scripts/test-evolution-migrations.sh` foi atualizado, mas
**não foi executado** nesta etapa. Homologação e produção: não publicado.

## Lote 3 — Fase 2 (Novo serviço) — concluído

| Item | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Commit    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 3.1  | **Retirada opcional.** `pickup` nulo/ausente é válido: o cliente entrega as peças na tapeçaria. Nenhuma retirada, responsável, participante, custo de logística, agenda ou notificação de retirada é criado; nenhum endereço, data, horário ou situação é inventado (cliente novo sem endereço fica sem endereço; cliente existente não recebe o endereço principal por padrão). O pedido guarda a marca explícita `customer_drop_off` (migration aditiva `20261227000000_servico_sem_retirada`, reversão bloqueada se houver pedido marcado) e aparece como "Aguardando entrega do cliente"; agendar uma retirada depois desmarca. A chegada (recebimento "entregue pelo cliente" no painel) gera a OS automática como antes. Com retirada, o fluxo anterior não mudou (testes antigos inalterados). Tela: escolha "Buscar na casa do cliente" / "Cliente entrega na tapeçaria".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `5aa7427` |
| 3.2  | **Titular e mão de obra prevista no fechamento** (Fase 1 §4.3 B). Rastreio: tela (titular e "mão de obra prevista por unidade" por peça) → contrato (`newServiceSchema`, mão de obra exige titular) → API (mesmas permissões da OS: `producao.planejar`; `financeiro.ver` + `financeiro.gerenciar`; mesma elegibilidade: titular ativo com produção, mão de obra só para tapeceiro principal) → persistência (`commercial_order_items.planned_*`, migration aditiva `20261228000000_titular_mao_de_obra_prevista` com CHECK no banco) → OS gerada na chegada (titular da peça + mão de obra combinada = valor por unidade × quantidade que chegou, pela mesma função da OS manual) → planejamento (peça já com titular) → financeiro (obrigação PREVISTO, nada pago; chegadas parciais somam o previsto sem duplicar; repetição e concorrência não duplicam). **Previsto ≠ pago:** nada financeiro nasce no fechamento. **Titular indisponível na chegada** (inativo, sem produção): a OS nasce sem titular e sem mão de obra, a chegada nunca é bloqueada, aviso na OS e na auditoria (`service_order.planned_intent_not_applied`); se só deixou de ser tapeceiro principal, o titular é aplicado e a mão de obra não. **Alteração posterior:** `PUT /api/v1/orders/:id/planned-intent` (versão do pedido; vale só para as OS geradas a partir de então — OS e valores já gerados não mudam; sem `financeiro.ver` o valor não é visto nem alterado; trocar o titular de quem tem valor previsto exige permissão financeira) e diálogo no detalhe do pedido. Legado: pedidos sem intenção seguem exatamente como antes. | `e2e124b` |

Testes do lote: `novo-servico` (+5: sem retirada, validação, falha intermediária, idempotência,
agendamento posterior), `titular-previsto` (10: persistência, validação, permissões, chegada
parcial, repetição, concorrência, titular indisponível, deixou de ser tapeceiro principal, legado,
alteração posterior com versão e permissões), `migrations` (+2: as duas migrations e reversões com
os arquivos reais, CHECK no banco, reversão bloqueada com dados); E2E `novo-servico` (+2: sem
retirada até a OS; titular/mão de obra no fechamento, alteração antes da chegada e OS com eles).
Controle negativo: sem aplicar a intenção na chegada, 4 dos 10 testes de `titular-previsto` falham.
O E2E encontrou e corrigiu dois defeitos antes do commit (alerta sem `data-testid`; diálogo sem
chave de idempotência — a rota passou a seguir o padrão do PUT do pedido: versão, sem chave).

Correções de infraestrutura de teste no lote (sem mudar asserções):

- `079ced4` — `resetDatabase` repete o TRUNCATE em deadlock (40P01). Na suíte completa local,
  `realtime.test.ts` falhou uma vez no `beforeEach` (TRUNCATE × tarefa periódica do
  `startBackground()`); isolado passou 3/3. Só o auxiliar de teste mudou.
- `5a23981` — `scripts/test-evolution-migrations.sh`, **executado pela primeira vez desde o Lote 2**:
  a 1ª execução falhou porque a migration de dados `20261220` acrescenta, por desenho, três
  permissões (a verificação "dados legados idênticos" não previa isso) e porque a reversão dela é
  incondicional (não pode constar entre as reversões que devem ser recusadas). Corrigido: permissões
  legadas conferidas à parte (preservadas; só `recebimentos.registrar` acrescentada às 3 funções;
  reversão volta exatamente ao legado) e o check "write" passou a criar serviço sem retirada com
  titular/mão de obra previstos.

Resultados verificados (locais, nesta máquina):

- API: `titular-previsto` 10/10, `novo-servico` e `migrations` completos aprovados; suíte completa
  (commit `e2e124b`): 482 aprovados, 1 falha (o deadlock acima, corrigido em `079ced4` e
  reexecutado: `realtime` + `migrations` 20/20), 5 ignorados por desenho.
- E2E completo: **35/35** (inclui os 2 novos do Novo serviço).
- Lint, typecheck, formatação e build sem erros.
- Migrações encadeadas (`5a23981`): legado `839770a` → todas as migrations (12 da Evolução e da
  Simplificação) com dados legados idênticos; reversão completa com schema idêntico ao legado
  (`pg_dump -s`) e dados idênticos; com dados novos, as 10 reversões condicionais **recusadas**
  (inclusive `20261227` e `20261228`) sem alterar nada; backup e restauração verificados.
- **CI nº 98 (`e2e124b`): verde.** CI dos commits seguintes: ver relatório final.
  Homologação e produção: não publicado; nenhuma migration executada fora desta máquina.

## Situação final das Fases 2–4

Requisitos obrigatórios das três fases atendidos e com evidência local e de CI (não validados em
ambiente real). Das três decisões que estavam pendentes, duas foram aprovadas e implementadas
(rascunhos de semanas passadas: tratamento manual com aviso; mensagem após resposta perdida) e
uma continua em aberto (D9 — ver abaixo). Dependem da VM/homologação (não executados): aplicar as
migrations `20261220`, `20261227` e `20261228` com backup prévio; testes físicos em tablets reais e
Safari/WebKit. Fase 5 **não** iniciada.

## Decisões funcionais finais (pós-estabilização)

Três decisões aprovadas pelo responsável após o Lote 3. Resultados abaixo só do que foi
verificado; homologação e produção continuam **não** validadas (dependem da verificação e da
homologação controlada).

### 1. Rascunhos de semanas passadas — tratamento manual (implementado, `8921cd4`)

- Nada é transferido, reagendado ou alterado automaticamente (comportamento testado no Lote 1,
  item 1.4, mantido).
- Aviso ao gestor pela **Central de atenção** (mecanismo existente, derivado a cada consulta;
  nada é gravado): tipo `RASCUNHO_ANTIGO`, um item por semana anterior à atual com tarefas ainda
  em rascunho (plano em rascunho ou serviço acrescentado a semana publicada e não republicado),
  chave estável `RASCUNHO_ANTIGO:<plano>`, categoria "Ação necessária", contagem de serviços e
  link para Produção → A planejar.
- Sem duplicidade por ciclo: o aviso não é armazenado, então consultas e ciclos de liberação
  repetidos devolvem o mesmo item; testado que tarefas, itens, auditoria e eventos ficam
  idênticos. O aviso não bloqueia nada (reprogramação continua livre e faz o aviso sumir).
- Testes (`pre-planejamento`, describe G): sem rascunho antigo; rascunho da semana atual (sem
  aviso); rascunho antigo (um aviso); repetição; não bloqueio; tablet sem acesso (403).
  Controle negativo: sem o aviso, 2 dos 3 testes falham.

### 3. Mensagem do tablet após resposta perdida (implementado, `c8a69fb`)

- Resposta perdida na confirmação de chegada (falha de rede no envio): "Não foi possível
  confirmar se sua ação foi concluída. Atualize a tela e confira o status antes de tentar
  novamente." Mesma mensagem quando, depois disso, o aviso some da lista ou muda de versão.
- Sem resposta perdida neste tablet, os textos deixaram de atribuir a causa a outro aparelho
  (não comprovável): "Esta chegada não está mais pendente." e "Este aviso foi atualizado depois
  que a tela abriu. Confira o saldo atual antes de confirmar."
- API (409 de versão, tablet de chegada, recebimento no painel e materiais): "Este recebimento
  já foi atualizado. Confira o saldo atual antes de confirmar."
- Idempotência preservada: a nova tentativa manual reaproveita a mesma chave; nada é reenviado
  sozinho (E2E confere uma única chamada e um único recebimento).
- Testes: API com a mensagem exata; E2E `recebimentos-rede` (resposta perdida sem e com tempo
  real) e `recebimentos` (tela desatualizada, texto neutro).

### 2. D9 — data de início e ordem da fila — **NÃO implementado (ambiguidade)**

Decisão D9 original (Fase 1, §6 e tabela de decisões): a data de início "define semana e ordem,
**não horário**" e mantém a fila semanal. Implementação atual (verificada no código):

- Ordem da fila (`compareQueue`, `shared/production-domain.ts`, usada pela API e pelo painel):
  **semana → prioridade (Urgente/Alta/Normal/Baixa) → posição definida pelo gestor
  (`queuePosition`) → sequência da etapa → número da tarefa**. A data de início não entra.
- A data de início (`production_plan_items.start_date`, só **data**, sem horário) é apenas a
  trava de liberação (nenhuma tarefa é liberada antes dela).
- A posição do gestor é gravada só pela reordenação manual, que posiciona **todas** as tarefas
  da pessoa naquela semana e é validada por faixa de prioridade e dependências; reprogramar ou
  transferir a OS volta a posição para vazia.

Por que parou: a prioridade pode ser preservada (data depois da prioridade), mas a regra
aprovada não diz como a data convive com a **posição definida pelo gestor**, que é uma regra
operacional existente. As alternativas mudam comportamento de forma diferente:

| Opção | Ordem                                            | Efeito                                                                                                                                                                            |
| ----- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | semana → prioridade → **data** → posição → …     | a data manda; o gestor só reordena dentro da mesma data e a reordenação passa a recusar ordem contra a data (muda a regra de reordenação)                                         |
| B     | semana → prioridade → posição → **data** → …     | a posição manda; depois de qualquer reordenação a data deixa de influenciar aquela pessoa/semana, e um serviço reprogramado (posição vazia) vai para o fim mesmo se começar antes |
| C     | ordem atual; a data define a **posição inicial** | ao planejar/reprogramar, a tarefa entra na posição correspondente à data (dentro da faixa de prioridade); o gestor continua podendo reordenar depois                              |

Além disso, "data **e horário**": não existe horário de início no modo fila semanal (a decisão
original exclui horário); incluir horário exige campo novo, migration e tela. **Decisão
pendente:** escolher A, B ou C e confirmar se o horário deve ser criado. Recomendação técnica:
**C, só com a data** (não muda a reordenação nem a trava de liberação). Nada foi alterado na fila.

Resultados verificados das decisões finais (locais, commit `e6b347e`): API completa 486 aprovados,
5 ignorados por desenho; E2E completo **36/36**; lint, typecheck, formatação e build sem erros.
**CI nº 102 (`c8a69fb`), 103 (`8921cd4`) e 104 (`e6b347e`): verdes.** Homologação e produção:
não publicado; nenhuma alteração remota.
