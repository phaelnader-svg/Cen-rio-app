# Fase 4 — Compras, recebimento de materiais e estoque híbrido: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento) |
| SHA inicial (fim da Fase 3)    | `461ffde` (igual ao `origin` no início)                                         |
| Commit da Fase 4               | `aa6d02d` (banco, API, telas, testes e documentação)                            |
| SHA final do código verificado | `aa6d02d` — este relatório é o commit seguinte                                  |

## 2. Estado inicial do repositório

- Branch correta, árvore limpa, `HEAD` = `origin` = `461ffde`.
- Relatórios das Fases 1–3 e documentação de arquitetura, segurança e operação lidos; migrations,
  schema Prisma, rotas e catálogo de permissões inspecionados.
- Testes antes de qualquer alteração (`pnpm check`, PostgreSQL 16 real): API **114/114**,
  compartilhado **19/19**, web **6/6**; formatação, lint e typecheck sem erros.
- Entidades já existentes de materiais: `material_requirements` (com `origin =
SOLICITACAO_APROVADA` desde a Fase 3), `material_requests`/`material_request_items`,
  `measurements`. Nenhuma tabela de compras/estoque existia.
- **Divergências e lacunas registradas antes de implementar:**
  1. Reabrir uma aprovação (Fase 3) apaga as necessidades aprovadas; com compras vinculadas isso
     falharia por chave estrangeira (erro 500) — faltava uma regra explícita.
  2. Planejamento de sexta e lista consolidada mostravam "Comprado/Recebido" como "Fase 4" e a
     prontidão "Materiais" da OS era fixa em `FASE_FUTURA` — esperado na Fase 3, a substituir agora.
  3. Fase 2: estorno de recebimento **de peças de clientes** continua pendente (não confundido com
     o recebimento de materiais desta fase; registrado na seção 13).
  - Nenhuma divergência entre o código e os relatórios anteriores foi encontrada.

## 3. Estruturas reutilizadas

| Já existia                                                                                     | Uso na Fase 4                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `material_requirements` aprovadas (Fase 3)                                                     | Base das compras (origem de cada quantidade); nada duplicado                    |
| Medições e solicitações (status, histórico)                                                    | Prontidão "aguardando aprovação"; regras da Fase 3 preservadas                  |
| Regras de unidade (`UNITS_BY_KIND`, `unitError`), consolidação e `describeMaterial`            | Validação de compras, estoque e sobras; planejamento com comprado/recebido real |
| Sessões, permissões por rota, CSRF, idempotência, `version` + `FOR UPDATE`, auditoria imutável | Todas as rotas novas                                                            |
| Outbox `domain_events`, hub WebSocket, reenvio após reconexão                                  | Eventos de compras, recebimento, estoque e prontidão                            |
| Tablet (PIN, tela inicial, componentes ampliados), `MoneyInput`, Dialog/Field/Tabs/Section     | Telas novas no mesmo design                                                     |

## 4. Funcionalidades implementadas

**Fluxo:** solicitação aprovada → compra → recebimento físico → conferência → reserva por OS →
prontidão — sem iniciar produção.

- **Central de compras:** necessidades aprovadas de OS abertas com OS de origem, prazo,
  prioridade, quantidade aprovada, já em compra, a comprar, fornecedor e preço das compras
  existentes, e a etapa de cada material (solicitado → aprovado → comprado → parcialmente
  recebido → recebido e conferido → reservado → disponível).
- **Pedidos de compra** (`CP-00001`): criados a partir das necessidades selecionadas; fornecedor,
  data prevista, itens, quantidades, unidades, preço unitário e total (centavos), OS vinculadas,
  observações, situação (rascunho, confirmado, parcialmente recebido, recebido, cancelado) e
  histórico imutável. Só o gestor (`compras.aprovar`) confirma ou cancela. Sem pagamentos.
  - **Tecido/exclusivo:** uma linha por OS; nunca vai para o estoque comum.
  - **Materiais comuns:** uma linha consolidada com várias origens (quantidade de cada OS
    preservada); o material do catálogo é localizado ou criado pela especificação.
  - Não compra mais que o aprovado, nem a partir de previsão manual ou solicitação não aprovada.
- **Fornecedores:** nome/razão social, contato, telefone, e-mail, endereço, categorias,
  observações, ativo.
- **Recebimento de materiais** (`RM-00001`): qualquer funcionário (painel ou tablet), sem preços;
  pedido, material, quantidade recebida em ordem, quantidade com problema (incorreto, danificado,
  incompleto, outro + descrição), conferência obrigatória de referência/especificação, quem e
  quando (e o tablet usado). Parcial permitido; acima do pedido só com **excedente autorizado**
  pelo gestor; o que chega com problema não fica disponível e gera divergência.
- **Estorno auditável:** lançamento compensatório (o recebimento original não muda), com
  quantidade, motivo, responsável, data e impacto (estoque antes/depois, situação do pedido).
  Somente `estoque.autorizar` (gestor). Recusado se deixaria o estoque negativo ou abaixo do
  reservado para OS.
- **Estoque híbrido:** catálogo de materiais comuns (`MT-00001`, sem tecido), saldo físico,
  reservado e disponível, entradas (compra/ajuste), saídas (para OS/ajuste), histórico de
  movimentações imutável, estoque mínimo com alerta. Reservas por OS bloqueiam o material:
  duas OS nunca reservam a mesma quantidade. Ao receber uma compra consolidada, o que entrou é
  reservado automaticamente para as OS de origem.
- **Sobras:** OS de origem, referência, cor, quantidade restante, unidade, localização, condição e
  reaproveitamento. Ficam na OS original; transferência para outra OS só autorizada pelo gestor,
  com motivo, histórico imutável e especificação compatível.
- **Prontidão de materiais** por OS (sem levantamento, aguardando aprovação, aguardando compra,
  aguardando recebimento, parcialmente disponível, completo, com divergência), calculada só a
  partir de registros reais — não há como "marcar como completo". Não libera produção, não cria
  tarefas, não altera datas.

## 5. Banco e migrations

Migration `20261009000000_compras_estoque` — **aditiva**, aplicada sobre o banco de
desenvolvimento com dados das Fases 1–3 (nenhum `DROP`; nada apagado):

- Tabelas: `suppliers`, `purchase_orders`, `purchase_order_items`, `purchase_allocations`,
  `purchase_order_history`, `material_receipts`, `material_receipt_lines`,
  `material_receipt_reversals`, `stock_items`, `stock_movements`, `stock_reservations`,
  `material_leftovers`, `material_leftover_transfers`; coluna `service_orders.materials_readiness`.
  Nenhuma entidade de materiais da Fase 3 foi duplicada (as compras apontam para
  `material_requirements`).
- Restrições: estoque `on_hand ≥ 0`, `reserved ≥ 0`, `reserved ≤ on_hand`; catálogo sem tecido e
  unidade compatível; movimentação com sinal coerente ao tipo e saldos válidos; item exclusivo
  sempre com OS e item de estoque sempre com material do catálogo; tecido só exclusivo; inteiros
  fora de m/m²; recebido líquido ≤ pedido + excedente; linha recebida com conferência quando há
  aceito e com tipo de problema quando há recusado; pedido confirmado exige fornecedor;
  coerência de cancelamento; sobra ≤ inicial; transferência entre OS diferentes.
- Triggers de imutabilidade: histórico de compras, recebimentos, linhas, estornos,
  movimentações e transferências. Índices por situação, fornecedor, OS, material/situação.
- Concessão de `compras.*` e `estoque.*` à função Gestor.

## 6. APIs (`/api/v1`)

| Rota                                                                                                       | Acesso                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /suppliers` · `POST /suppliers` · `PUT /suppliers/:id`                                                | ver: `compras.ver`/`gerenciar`/`aprovar` · alterar: `compras.gerenciar` |
| `GET /purchasing/needs` (central de compras)                                                               | `compras.ver`, `compras.gerenciar` ou `compras.aprovar`                 |
| `GET /purchase-orders`, `GET /purchase-orders/:id`                                                         | idem                                                                    |
| `POST /purchase-orders` (idempotente), `PUT /purchase-orders/:id` (rascunho)                               | `compras.gerenciar`                                                     |
| `POST /purchase-orders/:id/confirm` (idempotente), `POST …/cancel`, `POST …/items/:itemId/authorize-extra` | `compras.aprovar`                                                       |
| `GET /material-receipts/pending`, `POST /material-receipts` (idempotente)                                  | qualquer funcionário autenticado (painel ou tablet)                     |
| `GET /material-receipts`, `GET /material-receipts/:id`                                                     | `compras.ver` ou `estoque.*`                                            |
| `POST /material-receipts/lines/:id/reverse` (idempotente)                                                  | `estoque.autorizar`                                                     |
| `GET /stock-items`, `GET /stock-movements`, `GET /stock-reservations`, `GET /material-leftovers`           | `estoque.ver`, `estoque.gerenciar` ou `compras.ver`                     |
| `POST /stock-items`, `PUT /stock-items/:id`, `POST …/adjust`, `POST …/issue` (idempotentes)                | `estoque.gerenciar`                                                     |
| `POST /stock-reservations` (idempotente), `POST …/:id/release`, `POST …/:id/consume`                       | `estoque.gerenciar`                                                     |
| `POST /material-leftovers`, `POST …/:id/discard` · `POST …/:id/transfer` (idempotente)                     | `estoque.gerenciar` · `estoque.autorizar`                               |
| `GET /material-readiness`, `GET /service-orders/:id/material-readiness`                                    | `os.ver`, `estoque.ver`, `compras.ver` ou `materiais.ver`               |

Todas com validação zod, mensagens em português, auditoria, eventos persistentes, bloqueio de
linha (`FOR UPDATE`) nas operações de saldo, `version` nas edições e erros consistentes
(400/403/404/409/422). Rotas existentes ajustadas: `GET /service-orders/:id` passou a trazer
`readiness.materialsState` e `readiness.materials` calculado; `POST
/measurements/:id/request/reopen` recusa (422) quando já há compra, reserva ou transferência.

## 7. Telas administrativas

1. **Compras** (`/painel/compras`): abas _A comprar_ (necessidades, seleção para pedido) e
   _Pedidos de compra_ (busca e situação; total e divergência).
2. **Fornecedores** (`/painel/fornecedores`): lista, cadastro e edição.
3. **Novo pedido** (`/painel/compras/novo`): linhas por OS (tecido) ou consolidadas (comuns) com
   origens, quantidade, preço unitário e total.
4. **Detalhe do pedido** (`/painel/compras/[id]`): itens com recebido/pendente/com problema,
   preços, OS vinculadas, recebimentos com estornos, histórico; ações confirmar, cancelar,
   autorizar excedente, estornar, registrar recebimento.
5. **Recebimento de materiais** (`/painel/recebimento-materiais`): mesma conferência do tablet.
6. **Estoque** (`/painel/estoque`): materiais (físico, reservado, disponível, mínimo; novo,
   ajustar, reservar), 7. **Movimentações**, 8. **Reservas por OS** (entregar, liberar), 9. **Sobras** (registrar, transferir com autorização).
7. **Prontidão de materiais** (`/painel/prontidao`): OS abertas com situação e materiais
   disponíveis.

- **OS → aba Materiais:** prontidão, materiais aprovados com aprovado/comprado/recebido/
  reservado/disponível e etapa, compras, recebimentos, reservas, sobras e pendências — além das
  solicitações e previsões existentes. O item "Materiais" da prontidão da OS deixou de ser "fase
  futura".
- **Planejamento de sexta:** colunas Comprado/Recebido com dados reais e checklist de compra.
- Navegação: Compras, Fornecedores, Recebimento de materiais, Estoque e Prontidão; "Compras e
  estoque" saiu de "Próximas fases". Conferido em desktop (1440 px) e celular (390 px, sem
  rolagem horizontal).

## 8. Telas dos tablets

Bloco **Recebimento de materiais** na tela inicial, com o número de pedidos aguardando chegada
(atualizado em tempo real) → lista de pedidos pendentes → conferência por material (especificação
em destaque, destino/OS, pedido, já recebido, falta) com campos grandes: recebido em ordem, com
problema, tipo e descrição do problema, e confirmação "Conferi referência, cor e especificação" →
botão fixo **Confirmar recebimento** → tela de confirmação com o número `RM-`. Nenhum preço,
total ou condição comercial aparece (testado na API e no E2E). Otimizado para 1280×800.

## 9. Permissões

| Permissão                                                           | Padrão |
| ------------------------------------------------------------------- | ------ |
| `compras.ver` — Ver compras e fornecedores                          | Gestor |
| `compras.gerenciar` — Preparar pedidos de compra (crítica)          | Gestor |
| `compras.aprovar` — Confirmar e cancelar compras (crítica)          | Gestor |
| `estoque.ver` — Ver estoque e prontidão                             | Gestor |
| `estoque.gerenciar` — Movimentar estoque (crítica)                  | Gestor |
| `estoque.autorizar` — Autorizar estornos e transferências (crítica) | Gestor |

O recebimento de materiais não exige permissão específica: qualquer funcionário autenticado
(inclusive tablets de produção) registra, sem ganhar acesso a compras, preços ou estoque.

## 10. Eventos

`supplier.changed`, `purchase_order.created/updated/confirmed/cancelled`,
`material.partially_received`, `material.received`, `material_receipt.reversed`,
`stock.reserved`, `stock.released`, `stock.moved`, `material.shortage_detected` (estoque abaixo do
mínimo ou recebimento com divergência), `material.readiness_changed`, `leftover.changed`.
Os que interessam ao chão de fábrica (pedido confirmado/cancelado, recebido, estornado) vão a
todos; os demais, à gestão. Payloads só com identificadores, códigos e situações — sem preços.
Gravados na mesma transação da alteração (outbox), entregues em ordem e reenviados após
reconexão (testado); o cliente invalida as consultas afetadas (idempotente).

## 11. Testes e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                         | Resultado                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| API — integração (Vitest, 17 arquivos)                        | **130/130** (114 das Fases 1–3 + 16 novos)                          |
| Pacote compartilhado — unitários                              | **24/24** (19 + 5 novos)                                            |
| Web — unitários                                               | **6/6**                                                             |
| E2E Playwright (build de produção, painel e tablet separados) | **12/12** (11 das Fases 1–3 + 1 novo), após a correção do defeito 1 |
| Backup + restauração (agora com dados da Fase 4)              | **aprovado**                                                        |
| Prettier, ESLint, typecheck dos 5 pacotes, build de produção  | **sem erros**                                                       |

| Cenário exigido                                          | Onde                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Compra a partir de solicitação aprovada                  | `purchasing.test.ts` (tecido exclusivo), `purchasing.spec.ts`                             |
| Tentativa de compra de solicitação não aprovada          | `purchasing.test.ts` (previsão manual e solicitação em revisão → 422)                     |
| Compra de tecido exclusivo da OS                         | `purchasing.test.ts` (linha por OS; duas OS na mesma linha → 400)                         |
| Compra consolidada de materiais comuns                   | `purchasing.test.ts` (origens preservadas, reserva automática por OS)                     |
| Recebimento completo / parcial / incorreto               | `purchasing.test.ts`, `purchasing.spec.ts` (tablet)                                       |
| Recebimento duplicado                                    | mesma chave → mesmo registro; dois simultâneos → só um aceito                             |
| Estorno auditável                                        | `purchasing.test.ts` (compensatório, impacto, bloqueio por reserva, só gestor)            |
| Reserva simultânea para duas OS                          | `purchasing.test.ts` (uma 201, outra 409; saldo correto)                                  |
| Proteção contra estoque negativo                         | `purchasing.test.ts` (ajuste, saída, banco) e teste de backup                             |
| Transferência autorizada de sobras                       | `purchasing.test.ts` (403 sem autorização, 422 incompatível, 200 autorizada)              |
| Tentativa de usar tecido de outra OS                     | `purchasing.test.ts` (recebido da OS A não cobre a OS B; tecido não sai do estoque comum) |
| Prontidão parcial / completa                             | `purchasing.test.ts`, `shared/purchasing.test.ts`, `purchasing.spec.ts`                   |
| Recebimento pelo tablet                                  | `purchasing.test.ts` (sem preços, dispositivo registrado), `purchasing.spec.ts`           |
| Permissões                                               | `purchasing.test.ts` (comprador, consulta, tablet, estoquista)                            |
| Sincronização em tempo real / reconexão                  | `purchasing-realtime.test.ts`                                                             |
| Fluxo E2E medição → … → prontidão completa, sem produção | `purchasing.spec.ts` (sem botão/rota de produção; aba Produção bloqueada)                 |
| Regressão das Fases 1, 2 e 3                             | todas as suítes anteriores executadas e aprovadas                                         |

## 12. Defeitos encontrados e corrigidos

1. **Limite de requisições compartilhado por todos os usuários.** O limite global (600/min) era
   por IP, mas atrás do proxy do Next todos os navegadores chegam do mesmo endereço; o E2E de
   tablets passou a receber "Muitas requisições" depois do fluxo de compras. Agora o limite é por
   sessão (cookie de sessão/dispositivo, com o IP como alternativa), com teste dedicado.
2. **Reabertura de aprovação com compras** quebraria por chave estrangeira → regra explícita
   (422) com mensagem orientando ajustar pelas compras.
3. Teste de concorrência de recebimento esperava apenas 409; o segundo envio, serializado pelo
   bloqueio, encontra o pedido já recebido (422) — comportamento correto; teste ajustado para
   exigir exatamente um recebimento.
4. Mudanças intencionais refletidas em testes anteriores (com comentário): prontidão "Materiais"
   da OS deixou de ser `FASE_FUTURA` (2 testes de API) e o planejamento de sexta deixou de mostrar
   "Fase 4" (1 E2E).

## 13. Pendências e riscos

- **Fase 2 — estorno de recebimento de peças de clientes:** continua pendente (não implementado
  nesta fase, para não confundir com materiais).
- Cancelamento de OS (Fase 2) não libera automaticamente reservas nem cancela compras ligadas a
  ela; a lista de compras ignora OS canceladas. Tratar junto com o fluxo de cancelamento.
- Pedido parcialmente recebido não pode ser cancelado nem "encerrado com saldo"; hoje exige
  estorno. Encerramento de saldo pode entrar numa evolução.
- Edição de rascunho existe na API (`PUT`); na interface o rascunho é refeito (cancelar e criar).
- Sem pagamentos, notas fiscais, contratos ou avaliação de fornecedores (fora do escopo).
- CI do GitHub não executado neste ambiente; nenhum deploy.
- E2E somente em Chromium; números `CP-`, `RM-`, `MT-` podem ter lacunas (sequência do banco).

## 14. Evidências do fluxo completo

E2E `purchasing.spec.ts` (servidores reais; painel e tablet em navegadores separados): o gestor
solicita medição de rotina, informa tecido Linho Bege 10 m (exclusivo) e grampos 2 embalagens
(estoque), envia, inicia a revisão e aprova; a OS mostra **Aguardando compra**. Cadastra o
fornecedor, seleciona os dois materiais na central de compras, informa preços (total R$ 496,80),
salva o rascunho e confirma; a OS mostra **Aguardando recebimento**. O tablet do Thiago mostra
"1" pedido sem recarregar, sem nenhum "R$"; Thiago confere e recebe 10 m e 2 embalagens; o pedido
fica **Recebido**, os grampos entram no estoque e ficam reservados para a OS; a prontidão fica
**Completo** na lista e na OS, com o aviso de que isso não autoriza o início da produção; não há
botão de produção e a aba Produção segue bloqueada.

Capturas (dados fictícios) em [`docs/evidencias/fase-4/`](evidencias/fase-4/): pedidos de
compra, pedido recebido, estoque, movimentações, prontidão, aba Materiais da OS (completo),
planejamento com comprado/recebido, tablet (início com contador, pendentes, conferência com
divergência, registrado), pedido com divergência e compras no celular.

## 15. Próximos passos (Fase 5 — aguardando autorização)

1. Programação semanal (sextas) usando a prontidão de materiais como um dos critérios, junto com
   medições, responsável e dependências — a liberação da produção continua sendo da programação.
2. Tratar o cancelamento de OS com compras/reservas e o estorno de recebimento de peças (Fase 2).
3. Executar o CI no GitHub e definir hospedagem.
