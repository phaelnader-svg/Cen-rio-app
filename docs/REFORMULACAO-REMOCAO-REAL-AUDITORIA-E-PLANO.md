# Remoção real dos processos burocráticos: auditoria e plano

Situação: **auditoria somente leitura. Nada foi implementado.**

- A E1 em homologação (`0348dcf`) não foi alterada.
- Produção não foi tocada.
- Nenhuma migration foi executada.
- A E2 não foi iniciada.

Base auditada: commit `0348dcf` (E1), que é a `696e3e9` mais o padrão "materiais desligado". Foram
quatro levantamentos independentes no código e nos documentos. As referências são `arquivo:linha`.

## 0. Diagnóstico

1. **As fases anteriores trocaram "simplificar" por "desligar".**
   - Fase 0: "Interruptores (logística, ajuda, embalagem) … padrão = tudo ligado"
     (`REFORMULACAO-FASE-0-RELATORIO.md:10`).
   - Fase 1: "para valer 'sem logística' o gestor precisa desligar os interruptores"
     (`REFORMULACAO-FASE-1-RELATORIO.md:355`).
   - Fase 3: "Saíram do menu (páginas, rotas e permissões preservadas)".
   - E1: "o controle formal inteiro continua existindo e volta a bloquear se o gestor ligar a trava"
     (`E1-MATERIAIS-RELATORIO.md:39`).
   - Resultado: quatro interruptores (`logistica`, `ajuda`, `embalagem`, `materiais` em
     `packages/shared/src/modules.ts`). Todo o processo formal continua vivo por trás deles.
2. **Os interruptores nem cobrem tudo.**
   - A trava de `logistica` só barra 5 rotas: criar retirada, criar/editar/confirmar entrega e Novo
     serviço com retirada.
   - Transições, roteiro, ocorrências, custos de viagem e a Central de atenção funcionam com ela
     desligada.
3. **O requisito "OS nasce no fechamento" não está atendido.**
   - `service-orders/service.ts:54-58` recusa: "A OS técnica só pode ser criada depois que a peça
     chegar à oficina".
   - A OS automática só nasce no recebimento físico (`receipts/service.ts:188` →
     `service-orders/auto.ts:45`).
   - Em 2026-10, a decisão "D1" escolheu manter a OS só na chegada
     (`SIMPLIFICACAO-FASE-1-AUDITORIA-ARQUITETURA.md:829`, `SIMPLIFICACAO-FASE-2-NOVO-SERVICO.md:16`).
     Ela contraria o requisito atual.
4. **Produção hoje está com banco novo e vazio** (deploy de 14/11). Não há em produção nenhum
   registro de retirada, compra, embalagem ou reserva em andamento. O risco a dados históricos se
   concentra na **homologação** e no **volume antigo preservado** (`pgdata`, sem uso).

## 1. Inventário das funcionalidades a remover

| #   | Funcionalidade                                | O que existe hoje                                                                                                                                                                                                                                                                 | Fica algo?                                                                 |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R1  | Logística (módulo)                            | interruptor `logistica`; equipe própria e "terceirizada" (papel `logistica_terceirizada`); tablet "só logística"                                                                                                                                                                  | não                                                                        |
| R2  | Retiradas                                     | `/painel/retiradas`; `pickups/*`; retirada no Novo serviço e no pedido; "Equipe própria" em Empresa                                                                                                                                                                               | só histórico                                                               |
| R3  | Entregas agendadas e expedição                | `/painel/entregas` (agenda, prontas, expedição, ocorrências); CRUD e execução de `/deliveries`; ocorrências logísticas                                                                                                                                                            | **a entrega direta na OS** (usa a tabela `deliveries` com `origin=DIRETA`) |
| R4  | Rotas e veículos                              | `/painel/roteiro`; `logistics/route`; sequência; viagens do dia no tablet                                                                                                                                                                                                         | não                                                                        |
| R5  | Custos de viagem                              | `finance/trip-costs.ts` (previsto → devido → conta a pagar); `logistics-defaults`; pendência **bloqueante** `CUSTO_NAO_INFORMADO` no fechamento semanal; "viagem gratuita"                                                                                                        | só histórico (lançamentos e pagamentos antigos)                            |
| R6  | Medições formais                              | `/painel/medicoes`, `/painel/planejamento` ("planejamento de sexta"); `measurements/*`; tablet "Medições atribuídas"; "Solicitar medição" na OS                                                                                                                                   | só histórico                                                               |
| R7  | Solicitações e aprovações de materiais        | revisão, aprovação e devolução de solicitação; `material_requirements`; previsões pré-OS (`material-forecasts`); "Materiais aprovados"                                                                                                                                            | só histórico                                                               |
| R8  | Compras                                       | `/painel/compras`; `purchase-orders/*` (rascunho, confirmar, cancelar, saldo, excedente); necessidades; faltas                                                                                                                                                                    | só histórico                                                               |
| R9  | Fornecedores                                  | `/painel/fornecedores`; `suppliers/*`                                                                                                                                                                                                                                             | só histórico (referenciados por compras e contas a pagar)                  |
| R10 | Recebimento formal de materiais               | `/painel/recebimento-materiais`; `material-receipts/*`; chegada física e conferência (`arrivals/purchase-orders`, `material-arrivals`); estorno; decisão de recusa; tablet "materiais comprados"                                                                                  | só histórico                                                               |
| R11 | Estoque formal e reservas                     | `/painel/estoque` (itens, movimentos, reservas, sobras); `stock-*`, `material-leftovers/*`                                                                                                                                                                                        | só histórico                                                               |
| R12 | Prontidão e bloqueios por material            | `/painel/prontidao`; `material-readiness`; `materials_readiness` na OS; bloqueio `MATERIAIS`; estado "Aguardando materiais"; conflito de plano "MATERIAIS"; prazos e Central "a comprar", "compra aguardando", "chegadas a conferir"                                              | não                                                                        |
| R13 | Interruptor "Travas de materiais"             | chave `materiais`                                                                                                                                                                                                                                                                 | não                                                                        |
| R14 | Embalagem                                     | estágios `AGUARDANDO_EMBALAGEM`/`EM_EMBALAGEM`; `quality/packaging.ts`; tarefa EMBALAGEM criada na aprovação; checagem "Embalagem concluída"; aba Embalagens; tablet `PackagingPanel`; interruptor `embalagem`; `packaging_required`; prontidão de retorno (`rollback-readiness`) | só histórico                                                               |
| R15 | Recebimento de peças como pré-requisito da OS | `/painel/recebimentos`; OS só depois da chegada; bloqueio `PECA_NAO_RECEBIDA`; pré-planejamento só com peça recebida; status do pedido por retirada                                                                                                                               | ver decisão D1                                                             |

Ficam **todas** as funcionalidades da lista do dono:

- clientes, orçamentos e informações comerciais;
- OS no fechamento;
- descrição, fotos e referências;
- lista simples de materiais com "comprado" e "na oficina";
- produção, planejamento semanal, tablets e qualidade simplificada;
- entrega direta na OS;
- histórico, financeiro e produtividade.

## 2. Telas, rotas, APIs, validações e configurações afetadas

### 2.1 Web: telas e menu (`apps/web`)

| Remover (rota e componente)                                                                                                         | Menu (`components/admin/nav.ts`)                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/painel/retiradas` · `commercial/pickups-page`, `pickup-detail`, `pickup-form`                                                     | "Retiradas" (136-142)                                                                              |
| `/painel/roteiro` · `quality/route-page`                                                                                            | "Roteiro do dia" (143-149)                                                                         |
| `/painel/entregas`, `/entregas/[id]`, `/entregas/ocorrencias/[id]` · `quality/delivery-pages`                                       | "Expedição e entregas" (261-266)                                                                   |
| `/painel/recebimentos`, `/recebimentos/novo` (D1)                                                                                   | "Recebimentos" (150-155)                                                                           |
| `/painel/compras/**`, `/fornecedores`, `/recebimento-materiais`, `/estoque`, `/prontidao`, `/materiais` · `components/purchasing/*` | Compras, Fornecedores, Recebimento de materiais, Estoque, Prontidão, Materiais aprovados (212-254) |
| `/painel/medicoes/**`, `/painel/planejamento` · `components/measurements/*`                                                         | "Medições" (157-162)                                                                               |
| `/painel/estoque-oficina` (D2)                                                                                                      | "Estoque da oficina" (234-240)                                                                     |
| Empresa → **Funcionalidades** (`company-page.tsx:362-420`) e "Equipe própria" (270-282)                                             | —                                                                                                  |
| `finance/trip-cost.tsx`; lançar custo logístico; "viagem sem custo" no fechamento                                                   | —                                                                                                  |

Telas que ficam, mas mudam:

- **Novo serviço:** só "cliente traz" ou nada; sem retirada; não exige `retiradas.gerenciar`
  (`new-service-page.tsx`, `nav.ts:106`).
- **Pedido:** sem "Solicitar retirada" e sem previsões de material (`order-detail.tsx`).
- **OS:**
  - aba Materiais só com a lista simples (sai `OsMaterialsOverview`, `MaterialsTab` e "Solicitar
    medição");
  - Resumo sem "Prontidão para produção" formal;
  - "Qualidade e entrega" sem embalagem.
- **Entrega direta:** perde o ramo "logística ligada".
- **Produção:**
  - modelos e tarefas sem a caixa "exige materiais";
  - planejamento e pré-planejamento sem "materiais" nem exigência de peça recebida.
- **Qualidade:** sem a aba Embalagens.
- **Início e "Hoje":** sem retiradas, roteiro, "aguardando material" e "na embalagem".
- **Tablet:**
  - saem `logistics.tsx`, `measurements.tsx`, `arrivals.tsx` (peças de retirada e materiais), o perfil
    "só logística", o `PackagingPanel` e o aviso por prontidão formal;
  - fica o aviso pela lista simples.

**URLs antigas:** cada rota removida passa a responder "Esta funcionalidade foi removida do Cenário
Gestão" (404 próprio), sem tela operacional.

### 2.2 API (`apps/api/src/modules`)

| Remover (escrita e operação)                                                                                                                                                                                | Leitura que fica (só histórico, sem tela operacional)                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| `pickups/*` (POST, PUT, transition); `PUT /pickups/:id/logistics`                                                                                                                                           | dados de retirada só dentro da linha do tempo da OS                                  |
| `/deliveries` POST, PUT, confirm, cancel, depart, arrive, items, install, complete, frustrate; `logistics/people`, `jobs`, `route*`, `payment-report`, `pickups/:id/step`; ocorrências logísticas (escrita) | entregas antigas na linha do tempo da OS; entrega direta pela rota da OS             |
| `company/own-team`; `finance/trip-costs*`, `logistics-defaults`, `logistics-costs` (POST, cancel, adjustments, constitute), `trip-costs/free`, `logistics-weekly`                                           | `GET finance/logistics-costs` no relatório histórico de custos                       |
| `measurements/*`, `material-requirements/*`, `material-forecasts/*`, `materials/consolidated                                                                                                                | planning`                                                                            | revisões de medição na linha do tempo |
| `suppliers/*`, `purchase-orders/*`, `purchasing/*`, `material-receipts/*`, `arrivals/purchase-orders`, `material-arrivals`, `stock-*`, `material-leftovers/*`, `material-readiness`                         | custos formais antigos no resultado por OS e nos relatórios (somados, não editáveis) |
| `POST/DELETE service-orders/:id/materials` (necessidade formal); `PUT production-tasks/:id/materials`                                                                                                       | —                                                                                    |
| `packaging/*`; `system/rollback-readiness`                                                                                                                                                                  | embalagens antigas na linha do tempo                                                 |
| `GET/PUT company/modules`, `GET /api/v1/modules`                                                                                                                                                            | —                                                                                    |
| `arrivals/pickups/:id/confirm` e, conforme D1, `receipts`                                                                                                                                                   | recebimentos antigos na linha do tempo                                               |

Fica e é adaptado:

- `services` (Novo serviço);
- `service-orders` (criação no fechamento);
- `os-materials` (lista simples; sai a "conciliação com compra");
- `direct-delivery` e `revert`;
- `quality` (inspeção sem embalagem);
- `production` (sem `MATERIAIS` e sem `PECA_NAO_RECEBIDA`, conforme D1);
- `finance` (fechamento sem pendência de viagem);
- `management` (Hoje, Central de atenção, painel);
- `deadlines`.

### 2.3 Validações e bloqueios a eliminar

| Validação                                                                                  | Onde                                                                              | Ação                                             |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| OS só depois da chegada física; quantidade limitada ao recebido                            | `service-orders/service.ts:54-58, 68-76`                                          | eliminar (D1)                                    |
| Bloqueio `PECA_NAO_RECEBIDA`                                                               | `production/common.ts:469`, `tasks.ts:1034`                                       | eliminar, ou só aviso (D1)                       |
| Bloqueio `MATERIAIS` e `taskMaterialsReady`                                                | `production-domain.ts:268`; `production/common.ts:321-372, 462, 479-480, 549-555` | eliminar                                         |
| Publicação: conflito "MATERIAIS"; pré-planejamento `materialsBlocked` e "só peça recebida" | `plans.ts:217-288`; `pre-planning.ts:160-177, 333-345, 425`                       | eliminar                                         |
| "Embalagem concluída" para estar pronta e para a entrega direta                            | `quality-domain.ts:319, 340-341, 367-368`; `quality/common.ts:399-409`            | eliminar                                         |
| Aprovação cria embalagem e tarefa EMBALAGEM                                                | `inspections.ts:561-612`; `production/tasks.ts:979, 1177`                         | eliminar                                         |
| Fechamento recusa conferir com `CUSTO_NAO_INFORMADO`                                       | `finance/closing.ts:440-482, 774-781`                                             | eliminar                                         |
| Novo serviço exige `retiradas.gerenciar`                                                   | `services/routes.ts:42-45`                                                        | eliminar                                         |
| Desligar logística exige nada em andamento                                                 | `company/routes.ts:72-114`                                                        | eliminar (some com os interruptores)             |
| Entrega direta recusa peça "numa entrega da logística"                                     | `direct-delivery.ts:99-106`                                                       | eliminar (não haverá mais entregas da logística) |

**Ficam (legítimos):**

- OS inativa;
- plano não publicado;
- sem responsável;
- dependências entre etapas;
- bloqueio manual;
- ocorrência bloqueante;
- execução simultânea;
- tarefa já concluída;
- qualidade exige etapas e correções concluídas;
- permissões.

### 2.4 Configurações e flags

| Item                                                                                                                                                                                                       | Ação                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaves `logistica`, `embalagem`, `materiais` em `modules.ts`                                                                                                                                               | eliminar do código                                                                                                                                                         |
| Chave `ajuda`                                                                                                                                                                                              | D3                                                                                                                                                                         |
| Leitores: `core/modules.ts`, `useModules`, filtro `module` do menu, avisos escondidos por módulo                                                                                                           | eliminar, se não sobrar chave                                                                                                                                              |
| Tabela `module_settings`                                                                                                                                                                                   | fica no banco (linhas antigas ignoradas; já é o comportamento para chave desconhecida, `modules.ts:70-77`)                                                                 |
| `company_settings.default_pickup_cost_cents`, `own_team_default_user_id`, `measurement_weekday`                                                                                                            | colunas ficam; o código deixa de ler                                                                                                                                       |
| Permissões `retiradas.*`, `logistica.executar`, `medicoes.*`, `materiais.*`, `compras.*`, `estoque.conferir`, `estoque.autorizar` (e `estoque.ver`/`gerenciar` conforme D2), `recebimentos.registrar` (D1) | sair do catálogo (`packages/shared/src/permissions.ts`)                                                                                                                    |
| Papel "Logística terceirizada"                                                                                                                                                                             | sai dos papéis padrão                                                                                                                                                      |
| Seed                                                                                                                                                                                                       | não cria mais André, Izaías, Thiago nem a equipe própria                                                                                                                   |
| Permissões que ficam com texto novo                                                                                                                                                                        | `entregas.gerenciar` ("marcar como entregue / desfazer"); `devolucoes.gerenciar` (D4); `os.gerenciar` ("criar OS"); descrições do papel Gestor e de `financeiro.gerenciar` |

## 3. Dependências que precisam ser eliminadas

1. **Entrega direta ↔ núcleo da logística.** `direct-delivery.ts` usa `shipping.deliveryEvent`,
   `deliveryDomainEvent`, `readinessOfItem` e `refreshItemStage` (`quality/common.ts`). É preciso
   extrair o mínimo para um módulo próprio, "entrega da OS", e apagar o resto de `shipping.ts`. A
   tabela `deliveries` continua sendo a gravação da entrega direta.
2. **Financeiro ↔ logística.**
   - Remover:
     - a criação de custos de viagem (`syncTripCost`/`upsertTripCost`, chamados por receipts, orders,
       service-orders, pickups e quality);
     - a pendência `CUSTO_NAO_INFORMADO` e "viagem gratuita";
     - a instrução de pagamento na parada;
     - a condição `CARTAO_RETIRADA` para pedidos novos;
     - o gatilho de cobrança `RETIRADA` para cobranças novas.
   - Manter só para leitura: custos, pagamentos e participantes antigos (fechamento, Meus Ganhos,
     resultado por OS e relatórios).
3. **Financeiro ↔ compras e estoque.**
   - `syncFormalMaterialCosts`/`stockAverageCost` deixam de gerar lançamentos novos (não há mais
     compras). Os lançamentos antigos em `service_order_costs` continuam somando.
   - A conciliação "é o mesmo" (`os-materials …/reconcile`, `finance/costs.ts:97-187`) é removida.
   - `materialSummary` e `forgottenReservations` passam a ler só a lista simples e o histórico.
   - O custo `MATERIAL_OS` da lista simples **fica**.
4. **Lista simples ↔ formal.**
   - Os campos `linked_purchase_item_id`, `linked_cost_id` e `reconciliation*` deixam de ser escritos
     (os antigos ficam).
   - `category_id`/`inventory_item_id` dependem de D2.
5. **Produção ↔ materiais, peças e embalagem.**
   - `requiresMaterials` perde efeito: a coluna fica, a caixa sai da tela e os modelos padrão deixam
     de marcá-la.
   - Saem a atividade EMBALAGEM, o estado operacional "Embalagem" e "Aguardando materiais".
6. **Pedido e Novo serviço ↔ retirada e recebimento.**
   - O status do pedido deixa de depender de retirada (`commercial/status.ts:31-39`).
   - Cancelar o pedido deixa de cancelar retiradas.
   - A OS nasce no fechamento (D1).
7. **Devoluções e correções ↔ recebimento e entrega.** `quality/returns.ts` cancela a entrega e as
   reservas. É preciso adaptar a devolução para a entrega direta (D4).
8. **Central de atenção, "Hoje", prazos e painel.** Saem:
   - itens de compras, chegadas, medições, logística, embalagem e "próximos 3 dias";
   - `MATERIAL_FALTANTE` formal (fica pela lista simples);
   - motivos de prazo `MATERIAIS` e `ENTREGA_FRUSTRADA`.
9. **Tempo real, avisos e anexos.**
   - Eventos `PACKAGING_*`, `STOCK_*`, `PURCHASE_ORDER_*`, `MEASUREMENT_*`, `MATERIAL_*` (exceto
     `OS_MATERIALS_CHANGED`) e `ENTREGA_*`.
   - Avisos `EMBALAGEM_LIBERADA`, `ENTREGA_AGENDADA`, `ENTREGA_ATRIBUIDA`, `OCORRENCIA_LOGISTICA` e
     `SALDO_COMPRA_ENCERRADO`.
   - Entidade de anexo PACKAGING (as fotos antigas continuam legíveis).
10. **Privacidade de dispositivo** por `logistica.executar` (`core/device-privacy.ts:40-55`).

## 4. Riscos para dados históricos e financeiro

| #   | Risco                                                                                                                                 | Onde                                                        | Mitigação                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **Fechamento semanal travado** por pendência de viagem de semanas antigas                                                             | `closing.ts:440-482`                                        | A pendência é removida. Semanas já conferidas não mudam (o snapshot fica gravado em `weekly_closings`)                                                                                                |
| H2  | **Cobrança com gatilho RETIRADA** de pedidos antigos cuja retirada nunca acontece                                                     | `revenue.ts:179-219`                                        | Levantar em leitura. Se houver, decidir caso a caso (D5): mudar para DATA ou ENTREGA, com auditoria. Em produção não há nenhuma                                                                       |
| H3  | **Cobrança e mão de obra "na entrega"**                                                                                               | `finance-domain.ts:376`; `quality/common.ts:382-388`        | Continuam pela entrega direta, que grava `deliveries` e `delivery_items` como hoje. O teste é o mesmo da Fase 3 (reversão)                                                                            |
| H4  | **Peças paradas em `AGUARDANDO_EMBALAGEM`/`EM_EMBALAGEM`**; tarefas e registros de embalagem abertos                                  | `fulfillment_stage`, `packaging_records`, tarefas EMBALAGEM | O estágio é recalculado sem embalagem e a peça vai a "pronta para entrega". Registros e tarefas abertos são encerrados por rotina única auditada (D6). Na homologação, contar antes                   |
| H5  | **Compras, reservas, medições e retiradas em andamento** (em homologação) ficam sem tela                                              | várias                                                      | Rotina única auditada para encerrar ou cancelar o que está aberto, preservando os registros (D6). Em produção: nada aberto                                                                            |
| H6  | **Custos de material formais** continuam no resultado por OS                                                                          | `costs.ts`, `results.ts`                                    | Continuam somando e não podem mais ser editados ou estornados. É preciso aceitar que correções antigas deixam de ser possíveis                                                                        |
| H7  | **Linha do tempo da OS e Meus Ganhos** leem tabelas de logística e medição                                                            | `management/routes.ts:277-342`; `my-earnings.ts`            | Manter essas leituras (só leitura). Teste: OS antiga com retirada, entrega, medição e compra mostra o histórico igual                                                                                 |
| H8  | **Permissões antigas gravadas** em `role_permissions`/`user_permissions`                                                              | banco                                                       | O catálogo novo ignora as chaves desconhecidas; é preciso testar. As linhas ficam                                                                                                                     |
| H9  | **Retorno de versão**: o código antigo religa a logística, a embalagem e as travas, e trata a entrega direta como pendência sem custo | `REFORMULACAO-FASE-1-REVISAO-FINAL.md:136-140`              | Sem migration, o retorno da aplicação é possível, mas o código antigo volta com todos os processos. Recomendação: voltar só por correção para frente; o ponto de recuperação fica como último recurso |
| H10 | **Apagar dados**                                                                                                                      | gatilhos `BEFORE DELETE`, FKs `Restrict`                    | Nenhuma tabela ou linha é apagada. A limpeza estrutural, se um dia houver, é uma etapa separada, com sua autorização                                                                                  |

## 5. Arquitetura operacional simplificada

```
Cliente → Orçamento/pedido → [Fechar serviço] → OS (já nasce aqui)
           │                                   ├─ descrição, fotos, referências
           │                                   ├─ lista simples de materiais (comprado ✓ / na oficina ✓, custo opcional)
           │                                   └─ (opcional) "peça chegou na oficina" — só registro (D1)
           ↓
   Planejamento semanal → Tablet: iniciar / pausar / retomar / concluir
           ↓                (bloqueios: só dependência, responsável, publicação, ocorrência, manual)
   Qualidade simplificada ("Tudo conforme", autoaprovação com justificativa, correções)
           ↓
   Pronta para entrega → [Marcar como entregue na OS] (desfazer controlado)
           ↓
   Financeiro (cobrança, mão de obra, custos simples, fechamento, produtividade) · Histórico
```

**Módulos que ficam no código:**

- clientes, comercial (pedido e orçamento), serviços (Novo serviço);
- OS, os-materials, service-models (materiais padrão como sugestão);
- produção (modelos, planejamento, tarefas, distribuição), tablet, presença;
- qualidade (inspeções e correções), "entrega da OS" (extraída de `quality`);
- financeiro, gestão (Hoje e Central de atenção enxutos), prazos, ocorrências de produção;
- arquivos, auditoria, dispositivos e sessões;
- ajuda (D3), mapa da oficina (D7), devoluções (D4).

**Módulos que saem do código operacional:**

- pickups, arrivals, receipts (D1), measurements, materials, purchasing;
- inventory (D2), a parte de logística de quality, packaging, a parte de logística de
  finance/trip-costs;
- o sistema de interruptores.

O que for preciso para ler o histórico vira **funções de leitura** usadas só pela linha do tempo, pelos
relatórios e por Meus Ganhos.

## 6. Decisões que preciso de você antes de implementar

| #      | Decisão                                                                                                            | Recomendação                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | Chegada física do móvel: hoje a OS só nasce no recebimento                                                         | **OS nasce no fechamento.** "Chegou na oficina" vira só uma marcação opcional na OS, sem bloquear tarefa. Somem a tela Recebimentos, o bloqueio `PECA_NAO_RECEBIDA` e a exigência no pré-planejamento |
| **D2** | "Estoque simples da oficina" (`/painel/estoque-oficina`): não depende do formal, mas não está na lista do que fica | **Remover da operação.** A lista simples da OS não precisa dele (os vínculos são opcionais), e os dados ficam                                                                                         |
| **D3** | Pedidos de ajuda pelo tablet: não estão em nenhuma das listas                                                      | **Manter, sem interruptor** (sempre disponível). Ou remover, se você considerar burocracia                                                                                                            |
| **D4** | Devoluções e correção de recebimento                                                                               | **Manter só "devolução de peça entregue"**, que reabre para correção. Sai a correção de recebimento                                                                                                   |
| **D5** | Cobranças antigas com gatilho "na retirada" (só homologação)                                                       | Converter para DATA, com auditoria, caso a caso                                                                                                                                                       |
| **D6** | Registros abertos em homologação (retiradas e entregas agendadas, compras, reservas, medições, embalagens)         | Rotina única auditada: encerrar ou cancelar sem apagar. Precisa da sua autorização, com contagem prévia                                                                                               |
| **D7** | Mapa da oficina (local das peças)                                                                                  | Manter, porque é controle simples. Saem só os locais ligados à logística ou à embalagem                                                                                                               |
| **D8** | Medidas técnicas da peça na OS (largura, altura etc., sem fluxo)                                                   | Manter como campo opcional da descrição. Não é o fluxo formal de medição                                                                                                                              |
| **D9** | Base do trabalho                                                                                                   | A partir da E1 (`0348dcf`) mais a correção de teste `29dc333`. A E1 deixa de existir como etapa, porque o interruptor dela some                                                                       |

## 7. Plano de implementação (etapas pequenas e testáveis)

Cada etapa é um commit testado, com relatório e deploy em homologação **só com sua autorização**.
Produção só no fim.

| Etapa                                                                  | Escopo                                                                                                                                                                                                                                                                                                                                                                                                                         | Teste de aceite da etapa                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S0 — Rede de segurança**                                             | 1) Suíte "remoção real": a lista de rotas que precisam responder 404, de URLs da web que precisam mostrar "removida", de itens proibidos no menu e de chaves proibidas no catálogo de permissões e módulos. Começa falhando e vai ficando verde a cada etapa. 2) "Retrato" do financeiro e da linha do tempo de OS antigas (fixtures com retirada, entrega, compra, medição e embalagem), para provar que o histórico não muda | Linha de base gravada                                                                                                                                      |
| **S1 — Embalagem**                                                     | Remover estágios, checagem, módulo `packaging`, tarefa EMBALAGEM, aba, tablet, interruptor `embalagem`, `rollback-readiness`. A aprovação vai direto a "pronta para entrega"                                                                                                                                                                                                                                                   | Aprovar → pronta → entregar na OS; mão de obra "aprovação" e "entrega" iguais; rotas `packaging` com 404; histórico de embalagem visível na linha do tempo |
| **S2 — Travas e prontidão de materiais**                               | Remover `MATERIAIS`, `taskMaterialsReady`, `materials_readiness`, conflito de plano, "Aguardando materiais", interruptor `materiais`, caixa "exige materiais", prontidão na OS, `/prontidao`                                                                                                                                                                                                                                   | Tarefa inicia sem compra nem medição (cenários A–E da E1 sem interruptor); o bloqueio legítimo continua                                                    |
| **S3 — Medições e solicitações**                                       | Remover medições, solicitações, aprovações, previsões, "materiais aprovados", planejamento de sexta, tablet de medições                                                                                                                                                                                                                                                                                                        | 404 nas rotas; OS e tablet sem medições; histórico de medição na linha do tempo                                                                            |
| **S4 — Compras, fornecedores, recebimento formal, estoque e reservas** | Remover o módulo `purchasing`, `material-receipts`, `arrivals` de materiais, `stock-*`, sobras, conciliação "é o mesmo"; custos formais antigos só leitura; D2 (estoque da oficina)                                                                                                                                                                                                                                            | Lista simples completa (comprado e na oficina independentes, custo `MATERIAL_OS`); resultado por OS antigo com os mesmos totais; 404 nas rotas             |
| **S5 — OS no fechamento (D1)**                                         | O Novo serviço cria a OS na hora; sem limite pelo recebido; sem `PECA_NAO_RECEBIDA`; status do pedido sem retirada; "chegou na oficina" opcional                                                                                                                                                                                                                                                                               | Fechar o serviço → OS existe → planejar → tablet inicia sem chegada registrada                                                                             |
| **S6 — Logística**                                                     | Remover retiradas, entregas agendadas, expedição, roteiro, ocorrências logísticas, equipe e papel, tablet de logística, custos de viagem, pendência do fechamento, `CARTAO_RETIRADA` e gatilho RETIRADA para novos; extrair "entrega da OS"                                                                                                                                                                                    | Entrega direta e desfazer iguais aos testes da Fase 3; fechamento confere sem viagem; Meus Ganhos e relatórios antigos iguais; 404 nas rotas               |
| **S7 — Interruptores, permissões, papéis e seed**                      | Remover o sistema de módulos (ou só `ajuda`, conforme D3), a tela Funcionalidades, permissões e papéis removidos, textos                                                                                                                                                                                                                                                                                                       | O catálogo não tem as chaves; usuários com permissões antigas gravadas entram normalmente                                                                  |
| **S8 — Central de atenção, Hoje, prazos, painel e avisos**             | Enxugar conforme o §3.8–9                                                                                                                                                                                                                                                                                                                                                                                                      | Nenhum item, aviso ou link aponta para processo removido                                                                                                   |
| **S9 — Rotina única de dados abertos (D5/D6)**                         | Só se você autorizar, depois da contagem em leitura na homologação                                                                                                                                                                                                                                                                                                                                                             | Contagens antes e depois; nada apagado; auditoria                                                                                                          |
| **S10 — Regressão e homologação**                                      | Suítes completas, E2E, auditoria de navegação por perfil, deploy em homologação, sua validação funcional                                                                                                                                                                                                                                                                                                                       | Critérios do §8                                                                                                                                            |

## 8. Critérios de aceite: removido, e não oculto

1. **Rotas:** toda rota de escrita da lista do §2.2 responde **404** (não 403 e não "desligado"). Um
   teste automatizado enumera as rotas registradas no Fastify e falha se alguma removida existir.
2. **Web:**
   - nenhum item de menu, botão ou link leva a funcionalidade removida, conferido por auditoria de
     navegação em todos os perfis;
   - as URLs antigas mostram "funcionalidade removida";
   - os componentes e arquivos removidos não existem no código, conferido por teste estrutural que
     procura os nomes.
3. **Configuração:** não existe interruptor para logística, embalagem ou materiais, nem tela
   "Funcionalidades" com essas chaves. Gravar uma linha antiga em `module_settings` não muda nada.
4. **Permissões:** o catálogo não tem `retiradas.*`, `logistica.executar`, `compras.*`, `medicoes.*`,
   `materiais.*`, `estoque.conferir` nem `estoque.autorizar`. A tela de Funções não as oferece.
5. **Fluxo de ponta a ponta sem burocracia:** cliente → fechar serviço → OS nasce → lista simples
   (comprado ✓, na oficina ✓) → planejar → tablet inicia, pausa, retoma e conclui sem compra,
   medição, recebimento ou chegada → "Tudo conforme" → pronta → "Marcar como entregue" → financeiro
   (cobrança "na entrega" vence; mão de obra liberada) → desfazer funciona.
6. **Bloqueios legítimos** continuam: dependência, responsável, plano não publicado, tarefa concluída,
   execução simultânea, ocorrência bloqueante, permissões.
7. **Histórico preservado:**
   - o retrato do S0 é idêntico depois de todas as etapas: totais financeiros, resultado por OS,
     fechamentos conferidos, Meus Ganhos e linha do tempo de OS com retirada, entrega, compra,
     medição e embalagem;
   - a impressão digital do banco da homologação não perde linhas;
   - nenhuma tabela foi apagada.
8. **Configuração padrão:** um banco novo funciona sem nenhuma intervenção manual, porque não há o
   que ligar ou desligar.

## 9. Migração e compatibilidade, sem perda de dados

- **Nenhuma migration de esquema** nas etapas S1–S8. Tabelas, colunas e gatilhos ficam. O código
  deixa de escrever e só lê o que o histórico precisa.
- **Dados abertos** (só homologação): rotina única, auditada e idempotente, depois de contagem em
  leitura e com sua autorização (S9). Ela muda situação, nunca apaga. Em produção não há nada aberto.
- **Estágio das peças:** o recálculo sem embalagem acontece na primeira leitura ou na rotina S9, com
  auditoria.
- **Retorno:** cada etapa é só de aplicação. Voltar uma etapa é `rollback_version` para a anterior,
  sem migration, mas o código antigo religa os processos (risco H9). O ponto de recuperação continua
  existindo para cada deploy.
- **Limpeza estrutural futura** (apagar tabelas e colunas sem uso): fora deste plano. Exige uma
  autorização específica e um backup verificado.
- **Produção:** banco novo. As etapas chegam a ela só depois da homologação aprovada, com o mesmo
  procedimento protegido.

## 10. Próximo passo

Preciso da sua aprovação deste plano e das decisões **D1–D9**. A primeira etapa a implementar seria
a **S0** (rede de segurança), seguida da **S1** (embalagem, a mais isolada). Até lá, nada é
alterado no código nem na homologação.
