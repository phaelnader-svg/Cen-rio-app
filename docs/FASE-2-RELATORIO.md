# Fase 2 — Clientes, pedidos, recebimento e ordens de serviço: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)       |
| SHA inicial (fim da Fase 1)    | `ef953da`                                                                             |
| Commits da Fase 2              | `d5ddd1d` (API, banco e testes de integração) · `c5ba6e6` (telas, E2E e documentação) |
| SHA final do código verificado | `c5ba6e6` — este relatório é o commit seguinte                                        |

Inspeção inicial: repositório limpo em `ef953da`, sem PR mesclado; `pnpm check` com 78 testes
aprovados e migrations em dia antes de qualquer alteração. Nenhuma estrutura da Fase 1 foi
recriada; a arquitetura (monólito modular, sessões, permissões, eventos/outbox, tempo real)
foi reutilizada.

## 2. Funcionalidades implementadas

**Fluxo:** Cliente → Pedido comercial → Solicitação de retirada → Recebimento físico → OS técnica.

- **Clientes:** PF/PJ, nome/razão social, nome fantasia, CPF/CNPJ opcional com validação dos
  dígitos, telefone, WhatsApp, e-mail, observações, vários endereços (principal único; remoção
  arquiva), pesquisa sem acentos por nome/documento/telefone/e-mail, filtros por tipo e cidade,
  arquivamento, histórico de serviços (pedidos e OS) e de alterações (auditoria com diferenças).
  **Duplicidade:** mesmo CPF/CNPJ é bloqueado (também por índice único); mesmo
  telefone/WhatsApp/e-mail ou nome idêntico gera alerta com os cadastros semelhantes, e o
  gestor pode confirmar "É outra pessoa".
- **Pedido comercial:** cliente, endereço da retirada (cópia preservada), serviço contratado,
  descrição preliminar, peças (tipo, descrição, quantidade, observações), fotografias, valor
  negociado e condições comerciais (permissão própria), observações, situação derivada e
  cancelamento com motivo (cancela as retiradas ativas). Edição respeita o que já foi
  retirado/recebido/alocado.
- **Retiradas:** pedido, cliente, endereço (cópia), data e janela, equipe (logística
  terceirizada/própria + observação), peças a retirar (sem exceder o disponível), instruções,
  referência externa, fotografias, situação com transições validadas (aguardando agendamento,
  agendada, em execução, retirada realizada, recebida na oficina, cancelada, com ocorrência) e
  **linha do tempo imutável**. Agenda semanal e lista. Confirmações registradas manualmente;
  modelo preparado para integração (origem `INTEGRACAO`, `external_reference`).
- **Recebimento físico:** data/hora (não futura), pedido, retirada de origem ou "entregue pelo
  cliente", peças e quantidades, condição física por peça, observações, divergências,
  localização inicial, responsável, fotografias. **Parcial** permitido; **duplicidade
  impedida** (idempotência, bloqueio de linhas, saldo pendente, restrição no banco, retirada já
  recebida). Registros imutáveis.
- **OS técnica:** número único, cliente e pedido de origem, itens com **código individual**
  (`OS-00012/2`), quantidades limitadas ao recebido e não alocado, tipo de serviço, instruções,
  tecido/cor/referência, espumas, medidas, observações, prazo prometido, prioridade, responsável
  técnico, fotografias (da OS e de cada peça), **histórico técnico numerado e imutável**,
  cancelamento (libera as peças). Abas preparadas para Programação, Produção, Qualidade e Entrega
  (indisponíveis, sem ação).
- **Regras de materiais e programação (estrutura):** materiais previstos por OS (tecido sempre
  "compra exclusiva da OS", garantido no banco; materiais comuns "de estoque"); medições de
  rotina (gestor, no dia configurado — sexta) × extraordinárias (outro dia ou tapeceiro com
  `medicoes.extraordinarias`); painel de prontidão informativo com `canStartProduction = false`.
  Nenhuma rota inicia produção e a previsão/chegada de materiais não dispara nada.

## 3. Tabelas e migrations

Migration `20261008100000_comercial_oficina` — **aditiva** (nenhuma tabela da Fase 1 alterada;
aplicada com sucesso sobre o banco de desenvolvimento já com dados da Fase 1):

`customers`, `customer_addresses`, `commercial_orders`, `commercial_order_items`,
`pickup_requests`, `pickup_request_items`, `pickup_events`, `receipts`, `receipt_lines`,
`service_orders`, `service_order_items`, `service_order_revisions`, `material_requirements`,
`attachments` (14 tabelas; fotos reutilizam `stored_files` da Fase 1).

Restrições em SQL: documento coerente com PF/PJ e único quando informado; um endereço principal
por cliente; `0 ≤ recebido ≤ quantidade`; consistência de cancelamento; janela de retirada
válida e data obrigatória quando agendada; origem do recebimento coerente com a retirada; tecido
somente `EXCLUSIVO_OS`; triggers de imutabilidade em `pickup_events`, `receipts`,
`receipt_lines` e `service_order_revisions`; concessão das novas permissões à função Gestor.

## 4. APIs criadas (`/api/v1`)

| Rota                                                                                                                                                                | Permissão                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /customers` (pesquisa e filtros), `GET /customers/:id`, `GET /customers/:id/history`                                                                           | `clientes.ver`                                               |
| `GET /customers/lookup` (resumo, sem dados pessoais)                                                                                                                | `clientes.ver` ou `pedidos.gerenciar`                        |
| `GET /customers/:id/addresses`                                                                                                                                      | `clientes.ver`, `pedidos.gerenciar` ou `retiradas.gerenciar` |
| `POST /customers` (idempotente), `PUT /customers/:id`, `POST /customers/:id/status`, `POST/PUT/DELETE /customers/:id/addresses[/:addressId]`                        | `clientes.gerenciar`                                         |
| `GET /orders`, `GET /orders/:id` (valores só com `pedidos.valores`)                                                                                                 | `pedidos.ver`                                                |
| `POST /orders` (idempotente), `PUT /orders/:id`                                                                                                                     | `pedidos.gerenciar` (+ `pedidos.valores` para valores)       |
| `POST /orders/:id/cancel`                                                                                                                                           | `pedidos.cancelar`                                           |
| `GET /pickups` (situação, período, pedido), `GET /pickups/:id`                                                                                                      | `retiradas.ver`                                              |
| `POST /pickups` (idempotente), `PUT /pickups/:id`, `POST /pickups/:id/transition`                                                                                   | `retiradas.gerenciar`                                        |
| `GET /receipts/pending`, `POST /receipts` (idempotente; painel ou tablet)                                                                                           | `recebimentos.registrar`                                     |
| `GET /receipts`, `GET /receipts/:id`                                                                                                                                | `pedidos.ver` ou `recebimentos.registrar`                    |
| `GET /service-orders`, `GET /service-orders/:id`, `GET /service-orders/:id/revisions`                                                                               | `os.ver`                                                     |
| `GET /service-orders/available`, `POST /service-orders` (idempotente), `PUT /service-orders/:id`, `PUT …/items/:itemId`, `POST/DELETE …/materials`, `POST …/cancel` | `os.gerenciar`                                               |
| `PUT /service-orders/:id/items/:itemId/measurements`                                                                                                                | `os.gerenciar` ou `medicoes.extraordinarias`                 |
| `GET/POST /attachments`, `DELETE /attachments/:id`                                                                                                                  | conforme o tipo de registro                                  |

Todas com validação (zod), auditoria, controle de versão nas edições e eventos persistentes.

## 5. Telas

Clientes (lista com pesquisa/filtros; cadastro com alerta de semelhança) · Ficha do cliente
(dados e endereços, histórico de serviços, alterações do cadastro) · Pedidos (lista e filtros)
· Novo pedido / Editar pedido · Detalhes do pedido (peças com retirada/recebido/em OS, retiradas,
recebimentos, OS, fotos, cancelamento) · Solicitação/edição de retirada · Retiradas (agenda
semanal e lista; detalhe com andamento e linha do tempo) · Recebimentos (aguardando chegada,
registrados) · Registrar recebimento · Ordens de serviço (lista) · Nova OS · Detalhes da OS (abas
Resumo, Peças e especificações, Materiais, Fotografias, Histórico; Programação, Produção,
Qualidade e Entrega bloqueadas como fase futura). Início do painel com indicadores do fluxo.
Navegação: os módulos "Pedidos" e "Ordens de serviço" saíram de "Próximas fases".

## 6. Permissões

Novas: `clientes.ver`, `clientes.gerenciar`_, `pedidos.ver`, `pedidos.gerenciar`_,
`pedidos.valores`_, `pedidos.cancelar`_, `retiradas.ver`, `retiradas.gerenciar`_,
`recebimentos.registrar`, `os.ver`, `os.gerenciar`_, `medicoes.extraordinarias` (\* = crítica).
O Gestor tem todas (garantido também em tempo de execução). As funções de produção **não**
receberam permissões comerciais por padrão; o gestor concede individualmente (ex.: Thiago com
`recebimentos.registrar`). A rota de permissões administrativas exige `painel.acessar`; o
registro de recebimento e a medição aceitam sessão de tablet com a permissão.

## 7. Eventos e sincronização

Eventos persistentes: `customer.created/updated`, `order.created/updated/cancelled`,
`pickup.created/updated/status_changed`, `receipt.registered`, `service_order.created/updated`,
`attachment.changed`. Audiência por permissão, agora combinável (`permission:a|permission:b`)
— o filtro de reconciliação por HTTP foi ajustado para isso. Payloads sem valores nem dados
pessoais. O painel invalida as consultas afetadas por cada evento; reconexão reenvia os eventos
perdidos (mesmo mecanismo da Fase 1).

## 8. Testes executados e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                         | Resultado                                               |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| API — integração (Vitest, 12 arquivos)                        | **97/97** (68 da Fase 1 + 29 da Fase 2), em 3 execuções |
| Pacote compartilhado — unitários                              | **13/13** (7 + 6 novos)                                 |
| Web — unitários                                               | **3/3**                                                 |
| E2E Playwright (build de produção, navegadores separados)     | **9/9** (7 da Fase 1 + 2 novos)                         |
| Backup + restauração (inclui dados da Fase 2)                 | **aprovado**                                            |
| Prettier, ESLint, typecheck dos 5 pacotes, builds de produção | **sem erros**                                           |

| Requisito                                              | Onde                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cadastro, edição e consulta de clientes                | `customers.test.ts`, `commercial-flow.spec.ts`                                                                                     |
| Criação de pedido comercial                            | `orders-pickups.test.ts`, `commercial-flow.spec.ts`                                                                                |
| Solicitação de retirada                                | `orders-pickups.test.ts`, `commercial-flow.spec.ts`                                                                                |
| Recebimento completo e parcial                         | `receipts-service-orders.test.ts`, `commercial-flow.spec.ts`                                                                       |
| Bloqueio de OS antes do recebimento                    | `receipts-service-orders.test.ts`, `commercial-flow.spec.ts`                                                                       |
| Criação de OS após recebimento; OS com múltiplas peças | `receipts-service-orders.test.ts`, `commercial-flow.spec.ts`                                                                       |
| Alteração técnica com histórico                        | `receipts-service-orders.test.ts`, `commercial-flow.spec.ts`                                                                       |
| Permissões administrativas e operacionais              | `customers`, `orders-pickups`, `receipts-service-orders` (tablet), `commercial-realtime` (fotos)                                   |
| Concorrência e duplicidade de recebimentos             | `receipts-service-orders.test.ts` (3 recebimentos simultâneos → 1 aceito; mesma chave → mesmo registro; OS simultâneas → 1 aceita) |
| Sincronização entre sessões                            | `commercial-realtime.test.ts`, `commercial-flow.spec.ts`                                                                           |
| Reconexão                                              | `commercial-realtime.test.ts` (eventos de retirada reenviados em ordem)                                                            |
| Migrations                                             | `migrations.test.ts` (banco do zero + restrições da Fase 2)                                                                        |
| Regressão da Fase 1                                    | todas as suítes anteriores executadas e aprovadas                                                                                  |

## 9. Evidências dos principais fluxos

E2E `fluxo completo` (servidores reais, navegador Chromium): cadastra cliente; um segundo
cadastro com o mesmo telefone mostra o alerta com o cliente semelhante e é confirmado; cria
pedido com sofá + 6 cadeiras e valor R$ 3.800,00; tenta abrir a OS e vê "Aguardando a chegada
das peças"; agenda a retirada (situação do pedido → "Retirada agendada"); registra "em
execução" e "retirada realizada" (linha do tempo); registra recebimento parcial (sofá + 4
cadeiras, divergência anotada); cria a OS com as quantidades recebidas (4 cadeiras sugeridas);
troca o tecido "Linho → Veludo" com motivo, e o histórico mostra a revisão; o pedido fica
"Recebido parcialmente". E2E `outra sessão`: um pedido criado numa sessão aparece na lista
aberta em outra, sem recarregar.

Percurso manual com capturas de tela (dados fictícios) também conferiu: ficha do cliente,
formulário de pedido, solicitação de retirada, agenda semanal, detalhe da retirada com
transições, formulário de recebimento, criação e detalhes da OS (medidas registradas como
"extraordinária" por ser quinta-feira), indicadores no início do painel e lista em celular.

## 10. Defeitos encontrados e corrigidos

1. **Filtros de situação sem validação** (`?status=XYZ` em pedidos, retiradas e OS) chegavam ao
   banco e resultariam em erro 500 → agora 400, com teste.
2. Título "OS OS-00001" duplicado e data crua (`2026-10-09`) no seletor de retirada do
   recebimento → corrigidos após revisão das capturas.
3. Teste E2E da Fase 1 que verificava "Ordens de serviço" como módulo indisponível → atualizado
   (mudança esperada: o módulo foi liberado), passando a verificar "Programação semanal" e o
   novo link.
4. Teste de backup não cobria dados da Fase 2 (origem vazia) → passa a inserir dados fictícios
   e conferir a imutabilidade dos recebimentos restaurados.

## 11. Pendências e riscos

- **CI do GitHub** não executado (sem execução de Actions neste ambiente); nenhum deploy.
- Recebimentos são imutáveis: correção de lançamento errado exigirá estorno (fase futura).
- Cancelamento de pedido com peças já na oficina é bloqueado (devolução é fase futura).
- Retirada com recebimento parcial é encerrada como "recebida na oficina"; peças restantes
  exigem nova retirada (divergências ficam anotadas).
- Telefone do cliente visível a quem vê retiradas (necessário à logística); um perfil
  específico de logística terceirizada fica para a integração futura.
- Números legíveis podem ter lacunas (sequência do banco).
- Pesquisa de clientes por `ILIKE` (adequada ao volume atual; índice trigram se crescer).
- Telas de tablet para recebimento/medição não foram criadas (APIs já aceitam sessão de tablet
  com permissão); E2E só em Chromium.

## 12. Próximos passos (Fase 3 — aguardando autorização)

1. Materiais e compras: necessidades por OS → compras (tecido por OS), estoque de comuns,
   conferência de chegada por qualquer funcionário autenticado — sem antecipar a programação.
2. Programação semanal (sextas) com liberação condicionada a programação, materiais,
   responsável e dependências.
3. Telas de tablet para recebimento de peças e medição extraordinária.
4. Executar o CI no GitHub e definir hospedagem.
