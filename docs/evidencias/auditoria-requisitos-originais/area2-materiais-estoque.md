# Auditoria — Área 2 (Materiais e compras, R2.1–R2.15) e Área 3 (Estoque, R3.1–R3.8)

Versões: ANTES = `7b4177b` (estava em produção) · DEPOIS = `696e3e9` (em produção agora).
Estado de produção considerado: tabela `module_settings` vazia → todos os interruptores no PADRÃO,
inclusive `materiais` = LIGADO ("Travas de materiais na produção"); banco novo (vazio, só o que as
migrations gravam).

Método: leitura do código nas duas versões (`git show` / `git grep`), sem executar nada. Os relatórios
de fase serviram só para localizar código. Componentes, rotas de API, migrations e testes de API
sozinhos NÃO contam como "atendido"; a prova funcional exigida é E2E (Playwright).

## Fatos centrais (valem para várias linhas da tabela)

**F1 — Por padrão, a produção continua travada pelo fluxo formal de materiais.**
- `packages/shared/src/modules.ts:49-54 @696e3e9`: `materiais` tem `defaultEnabled: true`
  ("Ligada, as etapas que exigem material só são liberadas com compra recebida ou reserva").
- `apps/api/src/modules/production/common.ts:349-367 @696e3e9` (`taskMaterialsReady`): se a tarefa
  exige materiais e a trava está ligada, a tarefa só fica pronta quando a prontidão FORMAL da OS é
  `COMPLETO` (`readinessOf`, `apps/api/src/modules/purchasing/common.ts:858 @696e3e9`).
- `packages/shared/src/purchasing-domain.ts:264-273 @696e3e9` (`computeReadiness`): OS sem nenhuma
  necessidade formal → `SEM_LEVANTAMENTO` (≠ `COMPLETO`). Logo, **OS sem materiais formais fica
  bloqueada**. A prontidão só considera necessidades de origem comprável (solicitação APROVADA ou
  previsão de compra), via `chainsOf` (`purchasing/common.ts:~607`): exige medição → solicitação →
  aprovação → compra recebida (exclusiva da OS) ou reserva de estoque formal.
- `packages/shared/src/production-domain.ts:356 @696e3e9`: `requiresMaterials && !materialsReady`
  → bloqueio `MATERIAIS` → status `BLOQUEADA`.
- `apps/api/src/modules/production/tasks.ts:1031 @696e3e9`: iniciar tarefa exige status `LIBERADA`.
- Os modelos de produção gravados pelas migrations (banco novo os contém) marcam as etapas principais
  com `requires_materials = true`: `packages/db/prisma/migrations/20261010000000_producao/migration.sql:273-304`
  e `20261230000000_modelos_simplificados/migration.sql:37`; espelho em
  `packages/shared/src/production-domain.ts:597-610, 678-694, 716-732 @696e3e9` (Corte de tecido,
  Costura, Montagem, Revestimento, Preparação do MDF, Corte de espuma…).
- A lista simples ("Materiais necessários", tabela `service_order_materials`) **não entra** na
  prontidão: `apps/api/src/modules/os-materials/routes.ts` não chama `refreshReadiness`/
  `reevaluateTasks`; marcar "Na oficina" não libera nada. O comentário em
  `os-materials/routes.ts:36-41 @696e3e9` ("nada aqui trava a produção") só é verdade porque a lista
  é ignorada — a trava formal continua agindo.
- Prova automatizada (teste de API, não E2E) do próprio projeto:
  `apps/api/test/fase1-materiais-estoque-entrega.test.ts:426-428 @696e3e9` — "padrão LIGADO =
  comportamento anterior: sem levantamento, corte bloqueado por MATERIAIS"
  (`status: 'BLOQUEADA', blockers: ['MATERIAIS']`). As linhas 431-466 mostram que só DESLIGANDO o
  interruptor a OS sem materiais inicia.
- ANTES (`7b4177b`): `apps/api/src/modules/production/common.ts:328-349` — mesma regra, sem
  interruptor. Ou seja, no estado padrão de produção o comportamento do servidor **não mudou**.

**F2 — Publicação do plano semanal e pré-programação continuam sinalizando o bloqueio formal.**
- `apps/api/src/modules/production/plans.ts:274-288 @696e3e9`: conflito `MATERIAIS` ("exige
  materiais, que ainda não estão completos — ficará bloqueada"). Não impede publicar, mas a tarefa
  publicada nasce `BLOQUEADA`.
- `apps/api/src/modules/production/pre-planning.ts:333-345 @696e3e9`: `materialsBlocked` lista as OS
  com prontidão formal ≠ `COMPLETO` (só some com a trava desligada). ANTES: `pre-planning.ts:334-337 @7b4177b`.

**F3 — A tela da OS mostra a lista simples primeiro, mas o fluxo formal continua abaixo e é ele que
alimenta a "Prontidão para produção".**
- `apps/web/components/commercial/service-order-detail.tsx:439-446 @696e3e9`: aba Materiais =
  `OsMaterialList` (simples) + `OsMaterialsOverview` (formal) + `MaterialsTab` (formal: medições,
  "Solicitados e previstos", aviso "Materiais aprovados vêm das medições conferidas pelo gestor e
  seguem para Compras", linhas 987-991).
- `service-order-detail.tsx:299-323 @696e3e9`: Resumo da OS → "Prontidão para produção / Materiais"
  com o estado formal ("compras, recebimentos e reservas") e o texto "A produção só começa quando
  programação, materiais, responsável e dependências permitirem". Fonte:
  `apps/api/src/modules/service-orders/routes.ts:150-153 @696e3e9`.

**F4 — Menu: todo o fluxo formal continua presente por padrão, sem vínculo com interruptor.**
`apps/web/components/admin/nav.ts:212-254 @696e3e9`: Compras, Fornecedores, Recebimento de materiais
(sem filtro de permissão: aparece a QUALQUER funcionário, linhas 224-227), Estoque (formal), Estoque
da oficina (novo), Prontidão de materiais, Materiais aprovados, além de Medições (157-162). Nenhum
desses itens tem `module:`; mesmo com `materiais` desligado continuam no menu. ANTES:
`nav.ts:197-228 @7b4177b` (mesmos itens, sem "Estoque da oficina").

**F5 — Fluxo formal de compra continua exigindo fornecedor e aprovação.**
`apps/api/src/modules/purchasing/purchase-orders.ts:803-819 @696e3e9`: confirmar pedido exige
permissão `compras.aprovar` (`PURCHASE_APPROVE`), fornecedor ativo ("Escolha o fornecedor antes de
confirmar.") e preço em todos os itens; os itens só podem vir de necessidades APROVADAS
(`purchase-orders.ts:356, 413`). Recebimento formal exige conferência
(`packages/shared/src/schemas/purchasing.ts` `materialReceiptLineSchema`). Tecido é sempre
`EXCLUSIVO_OS` (só fica "coberto" quando recebido), então, com a trava ligada, uma etapa de corte de
tecido só libera após compra com fornecedor + confirmação + recebimento.

**F6 — Prova funcional E2E existente (DEPOIS):**
- `tests/e2e/specs/aa-fase1-materiais-estoque-entrega.spec.ts`, cenário 1 (linhas 21-65): na aba
  Materiais da OS, inclui "Tecido linho bege" com quantidade 8, unidade "m" e custo 540,00; marca
  "comprado" e confere que "na oficina" continua desmarcado; marca "na oficina"; inclui "Grampos"
  sem custo e confere campo vazio; remove. NÃO verifica efeito na produção.
- Mesmo spec, cenário 2 (linhas 67-103): Estoque da oficina — cria categoria, cadastra material com
  quantidade/unidade, ajusta 4 → 3 com motivo, vê histórico, arquiva e vê em "Mostrar arquivados".
  NÃO exercita rolos.
- Não existe E2E que: inicie produção com a lista simples; desligue/ligue o interruptor
  `materiais`; prove que OS sem materiais inicia; cadastre rolos de tecido. (`git grep` em
  `tests/e2e/specs` por `module-materiais`, `Travas de materiais`, `inventory-roll`, `requiresMaterials`:
  sem resultado.)
- ANTES (`7b4177b`): não há lista simples nem estoque simples (sem `service_order_materials`,
  `inventory_items`, `modules.ts`, `/painel/estoque-oficina`).

## Tabela

| ID | Requisito (resumo) | Antes (7b4177b) | Depois (696e3e9) | Evidência no código (path:line @sha) | Evidência funcional (E2E/ nenhuma) | Depende de interruptor? | Classificação | Correção necessária (mínima, sem inventar funcionalidade) |
|---|---|---|---|---|---|---|---|---|
| R2.1 | Informar na OS os materiais necessários | Só pelo fluxo formal (medição/solicitação ou "previsto" em `MaterialsTab`) | Lista "Materiais necessários" na aba Materiais da OS, edição na linha, é o primeiro bloco da aba | `apps/web/components/commercial/service-order-detail.tsx:439-446 @696e3e9`; `apps/api/src/modules/os-materials/routes.ts:232-275 @696e3e9`; `packages/shared/src/simple-materials.ts:62-72 @696e3e9` | `aa-fase1-materiais-estoque-entrega.spec.ts:21-65` | Não | ATENDIDO | — (ver interferência F3: blocos formais na mesma aba) |
| R2.2 | Cadastrar tecidos, espumas, madeiras, percintas, colas e outros | Só por `kind` do fluxo formal | Descrição livre (2–200) + categoria opcional (categorias próprias do estoque da oficina) | `simple-materials.ts:62-66 @696e3e9` | `aa-fase1-…spec.ts:31-35, 53` (tecido e grampos) | Não | ATENDIDO | — |
| R2.3 | Quantidades e unidades | Formal (quantidade/unidade na necessidade) | Quantidade opcional (até 3 casas) e unidade texto livre | `simple-materials.ts:35-43, 67-68 @696e3e9` | `aa-fase1-…spec.ts:32-33` (8 m) | Não | ATENDIDO | — |
| R2.4 | Marcar se cada material foi comprado | Não existia (só estado formal "Comprado" derivado de pedido) | Caixa "comprado" por linha | `simple-materials.ts:70 @696e3e9` | `aa-fase1-…spec.ts:42-46` | Não | ATENDIDO | — |
| R2.5 | Marcar se cada material está na oficina | Não existia (só "recebido/reservado" formal) | Caixa "na oficina" por linha + aviso "Existem materiais ainda não disponíveis na oficina." | `simple-materials.ts:71, 125 @696e3e9`; `os-materials/routes.ts:133` | `aa-fase1-…spec.ts:38-50` | Não | ATENDIDO (só como informação; não libera produção — ver R2.14) | — |
| R2.6 | As duas marcações independentes | Não existia | Independentes no schema e na UI | `simple-materials.ts:7-8, 70-71 @696e3e9` | `aa-fase1-…spec.ts:42-45` (comprado marcado, na oficina desmarcado) | Não | ATENDIDO | — |
| R2.7 | Não exigir pedidos formais de compra | Exigido de fato: tarefas com material só liberam com compra recebida ou reserva | A lista simples não exige; mas, no padrão, a liberação da produção continua dependendo da prontidão formal (compra recebida/reserva) | F1: `production/common.ts:349-367 @696e3e9`; `purchasing-domain.ts:264-273`; `modules.ts:49-54`; ANTES `common.ts:328-349 @7b4177b` | Nenhuma E2E; teste de API `fase1-…test.ts:426-428` prova o bloqueio no padrão | Sim (só some com `materiais` DESLIGADO) | NÃO ATENDIDO | Fazer a produção não depender da prontidão formal no estado padrão (ex.: `materiais` com `defaultEnabled: false`, `modules.ts:53`) |
| R2.8 | Não exigir cadastro obrigatório de fornecedores | Confirmar compra exige fornecedor; tecido só cobre com compra | Lista simples sem fornecedor; fluxo formal igual: confirmar pedido exige fornecedor ativo; com trava ligada, etapa de tecido só libera após compra confirmada e recebida | `purchase-orders.ts:816-817 @696e3e9`; F1, F5 | Nenhuma | Sim | NÃO ATENDIDO (no padrão) | Mesma de R2.7; nada a mudar no formulário de compras se a produção deixar de depender dele |
| R2.9 | Não exigir aprovação de compras | Prontidão só conta necessidades APROVADAS; confirmação exige `compras.aprovar` | Igual no padrão: só necessidades de solicitação aprovada contam; sem aprovação a OS fica `SEM_LEVANTAMENTO`/`AGUARDANDO_APROVACAO` → tarefa `BLOQUEADA` | `purchasing/common.ts:~607 (BUYABLE_ORIGINS) @696e3e9`; `purchase-orders.ts:803-806, 413`; F1 | Nenhuma | Sim | NÃO ATENDIDO (no padrão) | Mesma de R2.7 |
| R2.10 | Não exigir recebimento formal | Exclusivo da OS só cobre quando recebido e conferido | Igual no padrão; "Recebimento de materiais" continua no menu para todos | `purchasing-domain.ts` (`covered` = recebido/reservado) ; `nav.ts:224-227 @696e3e9` | Nenhuma | Sim | NÃO ATENDIDO (no padrão) | Mesma de R2.7 |
| R2.11 | Não exigir reserva de estoque | Material não exclusivo só cobre com reserva | Igual no padrão; lista simples não reserva nada | F1; `apps/api/src/modules/purchasing/stock.ts:310-501 @696e3e9` (reservas) | Nenhuma | Sim | NÃO ATENDIDO (no padrão) | Mesma de R2.7 |
| R2.12 | Informar custo quando conhecido | Só via compra formal | Custo opcional por linha (centavos), só para quem tem `financeiro.ver` | `simple-materials.ts:54-60, 72 @696e3e9`; `os-materials/routes.ts:42-56, ~240` ("Informar custo exige acesso ao financeiro.") | `aa-fase1-…spec.ts:34` (540,00, como admin) | Não | ATENDIDO (restrito a quem vê o financeiro) | — |
| R2.13 | Custo em branco quando desconhecido | Não existia | `null` = não informado (≠ zero) | `simple-materials.ts:53-60 @696e3e9` | `aa-fase1-…spec.ts:52-57` (campo vazio) | Não | ATENDIDO | — |
| R2.14 | Não bloquear início da produção por falta de informação de compras | Bloqueava (`MATERIAIS`) | Continua bloqueando no padrão; só desbloqueia com o interruptor desligado | F1, F2; `production-domain.ts:356 @696e3e9`; `tasks.ts:1031`; `plans.ts:274-288`; `pre-planning.ts:333-345`; teste de API `fase1-…test.ts:426-428` | Nenhuma E2E (nem do caminho desligado) | Sim | NÃO ATENDIDO | Mesma de R2.7 (trava desligada por padrão), com E2E que inicie uma tarefa sem compra |
| R2.15 | Iniciar OS sem materiais cadastrados | OS sem levantamento = `SEM_LEVANTAMENTO` → tarefas de corte/costura/montagem bloqueadas | Igual no padrão (modelos gravados pelas migrations têm `requires_materials = true`) | `purchasing-domain.ts:265 @696e3e9`; `common.ts:365`; `migrations/20261010000000_producao/migration.sql:273-304`; teste de API `fase1-…test.ts:426-428` | Nenhuma E2E | Sim | NÃO ATENDIDO | Mesma de R2.7, com E2E: OS sem nenhum material → tarefa LIBERADA → iniciada no tablet |
| R3.1 | Estoque simples, separado das exigências da OS | Só estoque formal (ligado a necessidades/reservas) | "Estoque da oficina" com tabelas próprias, sem baixa, reserva ou vínculo automático com OS | `apps/api/src/modules/inventory/routes.ts:177-700 @696e3e9`; `apps/web/components/inventory/inventory-page.tsx:50`; `nav.ts:234-240` | `aa-fase1-…spec.ts:67-103` | Não | ATENDIDO (convive com o "Estoque" formal — ver interferências) | — |
| R3.2 | Cadastrar materiais manualmente | Só no catálogo formal | Cadastro com nome, categoria, quantidade inicial, unidade | `inventory/routes.ts:~318 @696e3e9` | `aa-fase1-…spec.ts:79-86` | Não | ATENDIDO | — |
| R3.3 | Tecidos em rolos com metragens | Rolos só na chegada física do fluxo formal | Rolos por material com identificação e metros; ajuste/arquivamento de rolo; tela "+ Rolo" | `simple-materials.ts:257-266 @696e3e9`; `inventory/routes.ts:507-680`; `inventory-page.tsx:401-457, 514-530` | Nenhuma E2E (só teste de API `fase1-…test.ts:477`) | Não | NÃO VERIFICADO | Incluir E2E: cadastrar rolo com metragem, ajustar e ver total em metros |
| R3.4 | Categorias personalizadas | Não existia (tipos fixos) | Categorias próprias, nome único, arquivar | `simple-materials.ts:234-240 @696e3e9`; `inventory/routes.ts:177-290` | `aa-fase1-…spec.ts:74-77` | Não | ATENDIDO | — |
| R3.5 | Ajustar quantidades manualmente | Ajuste no estoque formal | Ajuste com motivo e histórico imutável (anterior → novo) | `inventory/routes.ts:~407 @696e3e9` | `aa-fase1-…spec.ts:88-95` | Não | ATENDIDO | — |
| R3.6 | Estoque opcional para a produção | Estoque formal (reserva) era um dos caminhos obrigatórios para liberar | Estoque da oficina é opcional; mas, no padrão, a produção ainda depende de reserva no estoque formal ou de compra recebida | F1; `stock.ts:310-501 @696e3e9` | Nenhuma E2E da produção | Sim | PARCIALMENTE ATENDIDO | Mesma de R2.7 (a produção não pode depender do estoque formal no padrão) |
| R3.7 | Arquivar materiais não usados | — (estoque formal) | Arquivar sempre; excluir só sem histórico | `inventory/routes.ts:~446-500 @696e3e9` | `aa-fase1-…spec.ts:97-102` | Não | ATENDIDO | — |
| R3.8 | Não obrigar vínculo material da OS ↔ item de estoque | Fluxo formal: necessidade não exclusiva precisa de item de estoque/reserva para cobrir | Lista simples: `inventoryItemId` opcional; E2E inclui material sem vínculo | `simple-materials.ts:65 @696e3e9` | `aa-fase1-…spec.ts:31-36` (sem vínculo) | Não | ATENDIDO (para a lista simples; o fluxo formal continua exigindo estoque/reserva para liberar — ver R2.11) | — |

### Contagem

- ATENDIDO: **14** (R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R2.12, R2.13, R3.1, R3.2, R3.4, R3.5, R3.7, R3.8)
- PARCIALMENTE ATENDIDO: **1** (R3.6)
- NÃO ATENDIDO: **7** (R2.7, R2.8, R2.9, R2.10, R2.11, R2.14, R2.15)
- NÃO VERIFICADO: **1** (R3.3)

Total: 23.

## Processos antigos que continuam interferindo

1. **Trava formal de materiais ligada por padrão** (F1). Em produção (`module_settings` vazia) a
   etapa com `requiresMaterials` só libera com prontidão formal `COMPLETO`. Uma OS registrada só com
   a lista simples — mesmo com tudo "Comprado" e "Na oficina" — fica com as etapas de corte,
   costura, montagem, revestimento etc. em `BLOQUEADA / MATERIAIS`. Uma OS sem material nenhum
   também (`SEM_LEVANTAMENTO`). Código: `production/common.ts:349-367`, `purchasing-domain.ts:264-273`,
   `modules.ts:49-54` @696e3e9; prova (teste de API): `fase1-materiais-estoque-entrega.test.ts:426-428`.
2. **Cadeia medição → solicitação → aprovação → compra/reserva → recebimento continua sendo o único
   caminho que alimenta a prontidão** (`readinessOf`, `purchasing/common.ts:858-930 @696e3e9`; conta
   medições em aberto e solicitações não aprovadas como pendência). A lista simples não alimenta.
3. **Publicação do plano e pré-programação** avisam "exige materiais… ficará bloqueada" e listam OS
   bloqueadas por materiais (`plans.ts:274-288`, `pre-planning.ts:333-345` @696e3e9).
4. **Resumo da OS** mostra "Prontidão para produção → Materiais: Pendente" com base em compras,
   recebimentos e reservas formais, mesmo com a lista simples completa
   (`service-order-detail.tsx:299-323`; `service-orders/routes.ts:150-153` @696e3e9).
5. **Aba Materiais da OS** mantém, abaixo da lista simples, a visão formal (`OsMaterialsOverview`) e
   o bloco "Solicitações e previstos" com medições e o texto "Materiais aprovados vêm das medições
   conferidas pelo gestor e seguem para Compras" (`service-order-detail.tsx:439-446, 987-1002`).
   Dois cadastros de material na mesma aba.
6. **Menu (padrão e também com o interruptor desligado)**: Compras, Fornecedores, Recebimento de
   materiais (visível a qualquer funcionário), Estoque (formal), Prontidão de materiais, Materiais
   aprovados, Medições — nenhum ligado a interruptor (`nav.ts:157-162, 212-254 @696e3e9`).
   Coexistem "Estoque" (formal, com reservas ligadas às necessidades das OS) e "Estoque da oficina"
   (simples), ambos no grupo "Compras".
7. **Vincular materiais formais a uma tarefa liga `requiresMaterials` automaticamente**
   (`production/tasks.ts:563-566 @696e3e9`), reforçando a trava.
8. **Única saída hoje é manual**: desligar "Travas de materiais na produção" em Empresa
   (`company/routes.ts:175-176 @696e3e9` reavalia as tarefas) ou desmarcar "exige materiais" tarefa
   por tarefa (`task-detail.tsx:425-426`) / etapa por etapa nos modelos (`templates-page.tsx:395-396`).
   Nenhum E2E prova esse caminho.
