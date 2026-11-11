# Reformulação — Fase 1: simplificação de materiais, estoque e entrega

Estado: **implementada e testada em ambiente isolado (PostgreSQL 16 local e descartável). NÃO
aplicada em homologação nem produção. Nenhum deploy, nenhuma migration fora do banco isolado,
nenhum merge na main.** Aguarda autorização do gestor para qualquer implantação.

Legenda usada abaixo: **[IMPL]** implementado · **[TEST]** coberto por teste automatizado que passou
· **[NÃO TESTADO]** sem prova automatizada · **[DECISÃO]** depende de decisão de negócio.

## 1. Branch e SHA inicial

- Branch: `claude/reformulacao-fase-1` (exclusiva desta fase).
- SHA inicial: `a7f4f930e8ff935a516b37b06e67e78ed1cb095b` (ponta da Fase 0, branch
  `claude/beautiful-curie-k2kvce`). Ancestralidade conferida com `git merge-base --is-ancestor`.
- Scripts das VMs (`infra/`, `scripts/` de implantação) **não foram alterados**. O único script
  tocado é o teste local `scripts/test-evolution-migrations.sh` (inclui a nova migration nas listas
  de reversão e recusa).

## 2. SHA final e commits

Ver a seção "Resultado final" no fim deste documento (preenchida no último commit).

## 3. Arquivos

**Banco**

- `packages/db/prisma/migrations/20270309000000_materiais_estoque_entrega/migration.sql` (novo)
- `packages/db/rollback/20270309000000_materiais_estoque_entrega.down.sql` (novo)
- `packages/db/prisma/schema.prisma`

**Compartilhado**

- `packages/shared/src/simple-materials.ts` (novo: schemas, DTOs e regra de custo)
- `modules.ts`, `events.ts`, `types-finance.ts`, `types-production.ts`, `types-quality.ts`, `index.ts`

**API**

- Novos: `modules/os-materials/routes.ts`, `modules/inventory/routes.ts`,
  `modules/quality/direct-delivery.ts`
- Alterados: `app.ts`, `company/routes.ts`, `finance/costs.ts`, `finance/results.ts`,
  `finance/closing.ts`, `finance/trip-costs.ts`, `production/common.ts`,
  `production/pre-planning.ts`, `production/tasks.ts`, `quality/attention.ts`, `quality/route.ts`,
  `quality/routes.ts`, `quality/shipping.ts`, `pickups/routes.ts`, `services/routes.ts`

**Web**

- Novos: `components/commercial/os-material-list.tsx`, `components/commercial/os-direct-delivery.tsx`,
  `components/inventory/inventory-page.tsx`, `app/painel/estoque-oficina/page.tsx`,
  `lib/simple-materials.ts`
- Alterados: `admin/nav.ts`, `commercial/service-order-detail.tsx`, `commercial/new-service-page.tsx`,
  `finance/costs.tsx`, `quality/delivery-pages.tsx`, `tablet/home.tsx`, `tablet/tasks.tsx`,
  `lib/api.ts`, `lib/realtime.tsx`

**Testes**

- Novos: `apps/api/test/fase1-materiais-estoque-entrega.test.ts` (19 testes),
  `tests/e2e/specs/fase1-materiais-estoque-entrega.spec.ts` (3 cenários)
- Ajustados: ver a seção 12, com o motivo de cada ajuste.

## 4. Migrations

Uma migration, **somente aditiva**: `20270309000000_materiais_estoque_entrega`.

| Objeto                     | O que faz                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inventory_categories`     | categorias próprias; nome único sem diferenciar maiúsculas; arquivamento                                               |
| `inventory_items`          | material do estoque simples: unidade, quantidade, custo de referência opcional, local, arquivamento                    |
| `fabric_rolls`             | rolos de tecido ligados a um material; identificação única; metragem                                                   |
| `inventory_adjustments`    | histórico de ajustes (anterior, novo, quem, quando, motivo); **imutável** por gatilho                                  |
| `service_order_materials`  | "Materiais necessários" da OS; remoção lógica (`removed_at`/`removed_by_id`)                                           |
| `deliveries.origin`        | coluna nova `NOT NULL DEFAULT 'LOGISTICA'`, CHECK `LOGISTICA`/`DIRETA`; todas as entregas existentes ficam `LOGISTICA` |
| `service_order_costs_kind` | CHECK recriado com as mesmas origens **mais** `MATERIAL_OS` (só amplia; nenhuma linha muda)                            |

- Chaves estrangeiras: `RESTRICT` para referências de negócio, `SET NULL` para usuários.
- Nenhum `DELETE`, `UPDATE` de dados, `TRUNCATE` ou `DROP` de tabela ou coluna. A trava estrutural
  `rodada4-travas-estruturais` lista as três ocorrências textuais e o motivo de cada uma: `ON UPDATE
CASCADE` das chaves novas, `BEFORE UPDATE OR DELETE` do gatilho de imutabilidade e o CHECK
  recriado.
- `prisma migrate diff` entre o schema e o banco migrado: **sem diferença**.
- Reversão condicionada (`.down.sql`): **recusa** se existir qualquer registro da Fase 1 (tabelas
  novas, entrega de origem diferente de `LOGISTICA` ou custo `MATERIAL_OS`). Sem dados novos,
  restaura o CHECK anterior, remove a coluna e as tabelas novas e apaga a linha da
  `_prisma_migrations`.

## 5. Arquitetura

- **Fonte da verdade dos materiais da OS:** a tabela `service_order_materials`. As marcações
  "comprado" e "na oficina" são independentes. A remoção é lógica e o histórico fica na auditoria.
- **Fonte da verdade do custo:** o livro de custos imutável `service_order_costs`. O custo da lista
  simples entra nele como origem `MATERIAL_OS` (categoria `MATERIAL`):
  - **Regra de reconciliação:** o custo realizado de uma linha é o `cost_cents` informado, se a linha
    estiver marcada como comprada e não removida; senão é 0. O livro recebe **deltas compensatórios**
    (lançamento, correção ou estorno) com chave determinística `os_material:<linha>:<n>` e
    `createMany … skipDuplicates`. Recalcular não duplica nada.
  - Sincronizado na hora em cada alteração da lista e também, de forma preguiçosa, nas leituras do
    resultado e do relatório de custos (como os custos formais já eram).
  - **Custo em branco ≠ zero:** `cost_cents NULL` = "não informado". Não gera lançamento e entra na
    contagem `unpricedLines` / `informedUnpriced`, que o resultado mostra como pendência.
  - **Custo não é pagamento:** nada cria conta a pagar, despesa ou baixa.
  - **Dupla contagem:** se a mesma OS tiver custo formal (compras e estoque formal) **e** custo
    informado na lista, o resumo marca `mixedSources` e o resultado exibe o aviso "confira se o mesmo
    material não foi lançado nos dois". A soma não é deduplicada automaticamente, porque o sistema não
    tem como saber se são o mesmo material ([DECISÃO], ver seção 15).
  - O valor do custo só aparece e só é editável para quem tem `financeiro.ver`. Os tablets nunca
    recebem custo.
- **Travas de produção:** novo interruptor `materiais` ("Travas de materiais na produção"):
  - **Ligado (padrão):** comportamento atual. A tarefa com `requiresMaterials` espera os materiais
    formais (bloqueio `MATERIAIS`).
  - **Desligado:** `taskMaterialsReady` considera os materiais prontos. A pré-programação não marca a
    OS como bloqueada por materiais, e as tarefas que esperavam só por isso são reavaliadas na hora.
    O tablet e a OS mostram o aviso discreto "Existem materiais ainda não disponíveis na oficina."
    Religar volta a travar e reavalia de novo. As demais regras (dependências, presença, qualidade)
    não mudam.
- **Estoque simples:** tabelas próprias, separadas do estoque formal (que continua igual).
  - **Nenhum vínculo automático com a OS:** sem baixa, sem reserva e sem movimentação.
  - A quantidade só muda por **ajuste manual**, que registra anterior, novo, quem, quando e motivo
    numa tabela imutável. O cadastro (PATCH) não aceita quantidade.
  - **Arquivar** sempre pode. **Excluir** só sem histórico e sem uso:
    - categoria: sem materiais e sem uso em OS;
    - material: sem ajustes, rolos ou uso em OS;
    - rolo: sem ajustes.
  - Não há exclusão em massa.
- **Entrega direta pela OS:** `POST /api/v1/service-orders/:id/deliver` grava uma **entrega já
  concluída de origem `DIRETA`**, com itens `ENTREGUE` e um evento `ENTREGA_DIRETA` ("Entrega
  confirmada diretamente pela OS … (sem roteiro nem viagem)"). Não inventa viagem: sem responsável
  de transporte, sem horário, sem custo de frete. Como é uma entrega concluída como as demais, todos
  os leitores que já dependiam de entrega funcionam pelos mesmos caminhos, uma única vez (seção 9).
- **Logística configurável:** a chave `logistica` passou a ser alterável:
  - **Desligar é recusado** (422, com os códigos) enquanto houver entrega ativa ou retirada em
    andamento. Assim, não fica nenhum fluxo pela metade.
  - **Desligada:** o servidor recusa criar, alterar ou confirmar entrega e criar retirada (409
    `MODULE_DISABLED`). O menu esconde Retiradas e Roteiro, o tablet da logística mostra um aviso,
    "Novo serviço" oferece só "Cliente entrega na tapeçaria", e a Central e a tela de peças prontas
    apontam para a aba **Entrega** da OS.
  - Dados e histórico continuam consultáveis.

## 6. Materiais — antes × depois

| Antes                                                                                                           | Depois                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Necessidade formal (requisito → aprovação → compra/reserva/recebimento) era o único jeito de registrar material | Lista simples "Materiais necessários" na aba Materiais da OS, editada na própria linha, sem janelas [IMPL][TEST]                |
| Produção travava (`MATERIAIS`) até o material formal ficar pronto                                               | Igual por padrão. Com "Travas de materiais" desligada, a produção segue e só aparece o aviso [IMPL][TEST]                       |
| Custo só via compras e estoque formais                                                                          | Custo opcional por linha. Comprado + custo = custo realizado no livro (`MATERIAL_OS`); sem custo = "não informado" [IMPL][TEST] |
| —                                                                                                               | Relatório de custos e CSV mostram a origem "Informado na OS" [IMPL][TEST na API]                                                |

O fluxo formal **continua existindo e funcionando** abaixo da lista simples, na mesma aba.

## 7. Estoque — antes × depois

| Antes                                                                   | Depois                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estoque formal com tipos fixos, reservas por OS, sobras e movimentações | Inalterado em `/painel/estoque`                                                                                                                                                         |
| —                                                                       | `/painel/estoque-oficina` ("Estoque da oficina"): categorias próprias, materiais, rolos, ajuste com motivo e histórico, arquivar e excluir com segurança [IMPL][TEST API + E2E escrito] |
| —                                                                       | Independente da OS: o teste prova que incluir material na OS não mexe na quantidade do estoque [TEST]                                                                                   |

Permissões: ver = `estoque.ver`, `estoque.gerenciar` ou `os.gerenciar` (para escolher o item na OS);
alterar = `estoque.gerenciar`; custo de referência só com `financeiro.ver`.

## 8. Entrega — antes × depois

| Antes                                                                                       | Depois                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Peça só virava ENTREGUE por entrega da logística (agendar → saída → peça a peça → concluir) | Igual. **Mais:** aba **Entrega** na OS com "Marcar como entregue" [IMPL][TEST]                                                                                                                               |
| —                                                                                           | Elegibilidade = a mesma da logística (`readinessOfItem`): tarefas, **inspeção aprovada**, sem correção, embalagem, sem bloqueio. Também barra OS cancelada e peça já em entrega da logística [TEST]          |
| —                                                                                           | Permissão `entregas.gerenciar`; ver = `os.ver` ou `entregas.ver` [TEST]                                                                                                                                      |
| —                                                                                           | Registra data e hora, usuário (auditoria `delivery.direct_completed`, evento da entrega, `createdBy`) e origem "confirmação direta pela OS" [TEST]                                                           |
| —                                                                                           | Idempotência (chave na rota e `created:false` ao repetir) e concorrência (trava da OS e das peças em ordem fixa, mais o índice único de entrega ativa): duas chamadas simultâneas geram **1** entrega [TEST] |
| —                                                                                           | Sem desfazer automático (proposta na seção 15)                                                                                                                                                               |

## 9. Dependências financeiras preservadas

A entrega direta é uma `Delivery` `CONCLUIDA` com itens `ENTREGUE`, então os mesmos caminhos
continuam valendo:

- etapa da peça → `ENTREGUE` (`refreshItemStage`), o que libera a mão de obra com regra "entrega
  concluída" [TEST indireto: etapa ENTREGUE];
- cobrança com gatilho `ENTREGA` passa a vencer na data da entrega (`dueContext`) [TEST: vence hoje];
- data de conclusão no resultado da OS e "serviço concluído" no pedido (leem entregas concluídas)
  [NÃO TESTADO especificamente para origem DIRETA; mesmo leitor];
- **fora** pela origem `DIRETA`: custo de frete (`upsertTripCost` recusa), pendência "custo não
  informado" do fechamento semanal, roteiro e filas da logística [TEST: sem custo de viagem e fora do
  roteiro].

Nenhum lançamento financeiro é criado pela entrega direta: ela só dispara os leitores existentes.
Assim, não há duplicidade.

## 10. Interruptores

| Chave       | Padrão | Configurável   | Efeito ao desligar                                                                                                   |
| ----------- | ------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `logistica` | ligado | **sim (novo)** | esconde telas operacionais e recusa novas entregas e retiradas; entrega pela OS; recusado com logística em andamento |
| `materiais` | ligado | **sim (novo)** | produção deixa de travar por materiais formais; aviso discreto                                                       |
| `ajuda`     | ligado | sim (Fase 0)   | inalterado                                                                                                           |
| `embalagem` | ligado | não            | inalterado (fase posterior)                                                                                          |

Em uma instalação existente **nada muda sozinho**: sem registro em `module_settings`, vale o padrão
(ligado = comportamento atual). Só o gestor com `empresa.configurar` altera, com auditoria, versão e
autor.

## 11. Compatibilidade

- A migration é aditiva. A versão anterior do app ignora as tabelas e colunas novas: `origin` tem
  padrão, e `MATERIAL_OS` só aparece se a Fase 1 for usada.
- O teste encadeado (`scripts/test-evolution-migrations.sh`) cobre a nova migration: reverte e
  reaplica sem perda quando não há dados, e é recusada sem mutação quando há dados da Fase 1.
- O check `evolution-migration.check.ts` (etapa `write`) cria material na OS com custo e um item do
  estoque e confere o lançamento `MATERIAL_OS`.
- **Limite do rollback:** com dados da Fase 1 gravados, o `.down.sql` recusa, de propósito. Voltar
  exige uma versão de retorno (seção 17). O executor `rollback_version` das VMs recusará versões
  anteriores por desconhecer a migration nova, como já acontecia na Fase 0.

## 12. Resultados dos testes

Ver "Resultado final" no fim do documento (números reais da última execução).

**Testes existentes ajustados**, sem remover testes e sem afrouxar asserções:

- `apps/api/test/fase0-modulos-ajuda.test.ts` e `packages/shared/test/modules.test.ts`: a logística
  agora é configurável e existe a chave `materiais`. As asserções mudaram para o novo conjunto exato,
  ainda por igualdade.
- `apps/api/test/rodada4-travas-estruturais.test.ts`: três exceções justificadas da nova migration.
  A comparação passou a exigir também a **contagem exata** de cada exceção (13 `ON UPDATE CASCADE`),
  o que é mais estrito que antes.
- `apps/web/test/rodada4-menu.test.ts`: novo item de menu "Estoque da oficina" na trava de áreas e
  permissões.
- `tests/e2e/specs/fase0-funcionalidades.spec.ts`: o interruptor da logística deixou de estar
  desabilitado. A asserção `toBeDisabled` virou `toBeEnabled` + `toBeChecked`.
- `apps/api/test/helpers.ts`: o cliente de teste aceita `PATCH`.

## 13. Testes não executados

- Homologação e produção: nada foi executado lá, de propósito.
- Teste funcional autenticado em ambiente real.
- Carga e desempenho das telas novas.
- Específico para a data de conclusão no resultado da OS e "serviço concluído" do pedido com entrega
  `DIRETA`: o leitor é o mesmo da logística, mas não há teste dedicado.
- Fluxo completo de "Marcar como entregue" pelo navegador (qualidade aprovada + embalagem) no E2E:
  coberto só na API. O E2E cobre a aba com bloqueios.

## 14. Problemas encontrados

- Execuções concorrentes de arquivos de teste no **mesmo** banco de teste geraram falhas em cascata
  (`quality`, `cobranca`, `finance`). Os mesmos arquivos passaram 100% isolados, e a suíte completa
  foi executada de novo sem concorrência (ver resultado final).
- A trava estrutural de migrations comparava listas com duplicatas por igualdade de chaves. Foi
  tratada com contagem explícita (seção 12).

## 15. Riscos e decisões pendentes

- **[DECISÃO] Dois estoques coexistem** (formal e da oficina). A Fase 1 não migra nem unifica.
  Definir no futuro se o formal será aposentado.
- **[DECISÃO] Dupla contagem** formal + lista simples: hoje só há aviso (`mixedSources`). Alternativa:
  proibir custo na lista simples quando a OS tem compra formal, ou usar uma única fonte por OS.
- **[DECISÃO] Padrão das travas de materiais:** ficou **ligado** para preservar o comportamento atual,
  como pede a regra de compatibilidade. Para valer "produção não é bloqueada por materiais", o gestor
  desliga "Travas de materiais na produção" em Empresa → Funcionalidades.
- **[DECISÃO] Desfazer entrega direta — proposta (não implementada):**
  - Ação explícita "Estornar entrega", só com `entregas.gerenciar` + motivo obrigatório, e só se
    nenhuma cobrança com gatilho ENTREGA tiver baixa.
  - Ela gravaria um evento de estorno (sem apagar a entrega), devolveria as peças a "pronta para
    entrega" e recalcularia os vencimentos.
  - Até lá, corrigir exige suporte técnico.
- Indicadores de prazo e de prontidão baseados no material formal continuam informativos quando as
  travas estão desligadas.
- A entrega direta entrega **todas** as peças pendentes da OS de uma vez. Entrega parcial pela OS não
  foi implementada [DECISÃO].

## 16. Plano de implantação futura em homologação (não executar sem autorização)

1. Backup do banco de homologação e conferência do espaço em disco.
2. Construir a versão a partir de `claude/reformulacao-fase-1` (SHA final).
3. `prisma migrate deploy` pelo procedimento normal das VMs (só a migration `20270309000000`).
4. Conferir:
   - `deliveries.origin = 'LOGISTICA'` em 100% das linhas;
   - `module_settings` sem alteração;
   - telas e fluxos atuais iguais com os padrões.
5. Validação funcional com dados fictícios: lista de materiais, estoque da oficina, interruptor de
   travas, desligar e religar a logística e entrega direta de uma OS fictícia com qualidade aprovada.
6. Só então decidir sobre os interruptores na homologação.

## 17. Estratégia de reversão não destrutiva

- **Sem uso da Fase 1:** `.down.sql` (testado) ou manter o schema e voltar o código. A migration é
  aditiva e o código anterior funciona com ela, desde que o executor aceite.
- **Com dados da Fase 1:** não reverter o schema. Publicar uma **versão de retorno**: o código da
  versão anterior + a pasta da migration `20270309000000` byte a byte idêntica, como feito para a
  Fase 0 (`claude/retorno-5ff1597-fase0`). Os dados novos ficam preservados e inertes.
- Antes de voltar: religar `logistica` e `materiais` no painel, para que a versão anterior opere como
  sempre.

## 18. Veredito

Ver "Resultado final".
