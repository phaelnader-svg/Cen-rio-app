# Simplificação — Fase 2/10: Novo serviço (cliente, serviço fechado e retirada em um fluxo)

> Tudo executado **localmente**, em PostgreSQL 16 descartável e com **dados fictícios**. Nada foi
> publicado, nenhuma migration rodou no Google Cloud, a homologação não foi tocada, nenhum
> pagamento foi feito e o VerificaPro não foi alterado. A Fase 3 **não** foi iniciada.

## 1. SHA inicial e final

| Item                                                | Valor                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Branch                                              | `claude/cenario-gestao-fase-1-zf3bj2`                                        |
| SHA inicial (HEAD local = `origin`, worktree limpa) | `5cf5e03` (Fase 1)                                                           |
| Versão informada na homologação                     | `eb3fe2a` — não verificada (sem acesso de rede à homologação neste ambiente) |
| SHA final                                           | último commit desta fase na branch (ver §15)                                 |

Decisões aplicadas (aprovadas pelo gestor): **D1** — a OS nasce somente na confirmação da chegada
física; **D2** — sem módulo de orçamentos; **D3** — Thiago é o responsável padrão da equipe
própria, configurável em Empresa.

## 2. Resumo das alterações

- **Uma tela, um formulário, uma confirmação**: `/painel/servicos/novo` (entrada no menu, logo
  abaixo de "Início", e botão "Novo serviço" no Início).
- **Uma operação atômica e idempotente** no servidor (`POST /api/v1/services`): cliente (novo ou
  existente, com endereço novo opcional) + pedido fechado + peças + valores + retirada + responsável
  - participantes + custo previsto da logística, tudo numa única transação.
- **OS automática na chegada**: o recebimento das peças de um pedido do Novo serviço cria a OS na
  mesma transação, só com as peças efetivamente recebidas; repetir não duplica.
- **Equipe própria** com responsável padrão configurável (Thiago) e **sem** custo de
  terceirização; **terceirizada** com André por padrão, Izaías como participante e **um** valor
  total.
- **Serviços de domínio extraídos das rotas** (cliente, pedido, retirada, OS), reutilizados pelas
  rotas antigas e pelo fluxo novo — sem segundo cadastro de serviços.
- **Correção de um problema comprovado dentro do escopo**: um custo de viagem em retirada/entrega
  da **equipe própria** era creditado ao recebedor da logística terceirizada (André). Agora é
  recusado com mensagem clara (§10).

## 3. Arquitetura implementada

```
Tela Novo serviço ──► POST /api/v1/services (idempotente, WEB)
                       └─ $transaction
                          1. createCustomer()         customers/service.ts   (ou cliente existente + endereço)
                          2. createOrder()            orders/service.ts      (autoServiceOrder = true)
                          3. responsável padrão       services/routes.ts     (equipe própria: Empresa; terceirizada: recebedor)
                          4. createPickup()           pickups/service.ts     (+ upsertTripCost da Fase 6, PREVISTO)
                          5. auditoria "service.created" + eventos (order/pickup/customer)
Recebimento (POST /api/v1/receipts, rota existente)
                       └─ $transaction (pedido e peças travados)
                          … recebimento como antes …
                          autoServiceOrderForReceipt() service-orders/auto.ts
                             └─ createServiceOrder()  service-orders/service.ts (mesmas validações da OS manual)
```

Eventos são gravados no outbox **dentro** da transação e entregues após o commit (mecanismo
existente). Nenhuma chamada externa ocorre dentro das transações.

## 4. Entidades reutilizadas

| Entidade                                    | Uso na Fase 2                                                 |
| ------------------------------------------- | ------------------------------------------------------------- |
| `Customer` / `CustomerAddress`              | cliente novo/existente; endereço com complemento e referência |
| `CommercialOrder` / `CommercialOrderItem`   | **registro do serviço fechado** antes da chegada (D1)         |
| `PickupRequest` (+ eventos)                 | agendamento por horário único de chegada (correção global)    |
| `LogisticsCost` (+ participantes, rateio)   | valor total único, PREVISTO no agendamento (Fase 6)           |
| `Receipt`                                   | confirmação de chegada — gatilho da OS                        |
| `ServiceOrder` / `ServiceOrderItem`         | OS gerada automaticamente (mesma função da OS manual)         |
| `CompanySettings`                           | responsável padrão da equipe própria                          |
| `AuditLog`, `DomainEvent`, `IdempotencyKey` | auditoria, tempo real, idempotência                           |

## 5. Novas entidades

**Nenhuma tabela nova.** Apenas colunas aditivas (§14).

## 6. Contratos de API

| Método e rota                       | Acesso                                            | Descrição                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/services/new-defaults` | WEB + `pedidos.gerenciar` + `retiradas.gerenciar` | padrões do formulário: responsável da equipe própria (com pendência), responsável terceirizado, pessoas por equipe, valor sugerido (só com `financeiro.gerenciar`), flags de permissão |
| `POST /api/v1/services`             | idem + `Idempotency-Key`                          | operação composta; `201` → `NewServiceResultDto` (cliente, pedido, retirada, custo previsto só com `financeiro.ver`)                                                                   |
| `GET /api/v1/company/own-team`      | WEB + `empresa.ver` **ou** `retiradas.gerenciar`  | responsável padrão, pendência (`NAO_CONFIGURADO`/`INATIVO`/`INELEGIVEL`) e candidatos                                                                                                  |
| `PUT /api/v1/company/own-team`      | WEB + `empresa.configurar`                        | `{ userId \| null, version }` — validado, auditado, com controle de versão                                                                                                             |

Contrato do corpo (`newServiceSchema`, `packages/shared/src/schemas/commercial.ts`):
`customer` = `{mode:'EXISTENTE', customerId, addressId?, newAddress?}` ou
`{mode:'NOVO', kind, name, phone, whatsapp, email, document, notes, address, allowSimilar}`;
`service` = `{contractedService, agreedValueCents?, paymentTerms?, promisedDate?, technicalNotes?,
items[{pieceType, description, quantity, serviceType, fabric…?, technicalNotes?}]}`;
`pickup` = `{scheduledDate?, windowStart?, team, logisticsUserId?, participantUserIds[], amountCents?,
instructions?, notes?}`. **Sem horário de término.**

Compatibilidade (aditivo): `ReceiptDto.generatedServiceOrder`, `OrderDto.autoServiceOrder /
promisedDate / technicalNotes`. Todos os endpoints anteriores continuam com o mesmo contrato.

## 7. Regras de criação automática da OS

Implementadas em `apps/api/src/modules/service-orders/auto.ts`, chamadas pelo recebimento
existente (`apps/api/src/modules/receipts/routes.ts`) — **não dependem de nenhuma tela da Fase 3**.

1. Só para pedidos do Novo serviço (`auto_service_order = true`); pedidos antigos seguem o fluxo
   manual (CA2-22).
2. Nunca no fechamento: sem recebimento, não há OS; a criação manual antes da chegada continua
   bloqueada (regra preservada).
3. **Uma OS por recebimento**, com **somente** as peças daquele recebimento ainda sem OS:
   `quantidade = min(recebida na linha, recebida − devolvida − já em OS)`; ordem = ordem das peças
   no serviço.
4. Idempotência em três camadas: chave de idempotência do recebimento (reenvio devolve o mesmo
   recebimento), busca prévia por `source_receipt_id` e **índice único** no banco; gatilho no
   banco garante que a OS pertence ao **mesmo pedido** do recebimento.
5. A OS herda: pedido, cliente, peças, quantidades, descrições, tipo de serviço, tecido,
   observações técnicas, prazo combinado; o histórico da retirada permanece no pedido/retirada.
6. **Não** atribui tapeceiro, **não** cria mão de obra, **não** cria tarefas, **não** inclui em
   planejamento, **não** publica nada. Fica disponível para "A planejar" (Fase 4).
7. Receita: nenhuma conta a receber é criada; a OS usa a participação proporcional do valor do
   pedido (regra existente da Fase 11) — sem receita duplicada.
8. Se a criação da OS falhar, o recebimento inteiro é desfeito (mesma transação).

## 8. Recebimentos parciais

- Peças ausentes **não** são marcadas como recebidas: o pedido fica `RECEBIDO_PARCIAL` e o saldo
  pendente por peça continua no pedido.
- Cada chegada posterior gera **uma nova OS** só com o que chegou; a soma das quantidades em OS é
  sempre igual ao total recebido (testado).
- Peça já colocada manualmente em outra OS não é incluída de novo.
- Dois recebimentos simultâneos da mesma peça: o segundo é recusado (409) pela trava do pedido e
  pelo saldo; uma única OS é criada (testado).

## 9. Configuração da equipe própria

- Empresa → cartão **"Retiradas da equipe própria"** → _Responsável padrão da equipe própria_.
- Referência ao **usuário real** (`company_settings.own_team_default_user_id`, chave estrangeira).
- Elegível = funcionário ativo com permissão de executar produção (mesma regra da equipe própria
  no restante do sistema). André/Izaías (logística terceirizada) são recusados.
- Padrão inativo/inelegível/ausente → **pendência visível** no Empresa e no Novo serviço; a API
  recusa salvar retirada da equipe própria sem responsável escolhido — **nunca** escolhe outro
  silenciosamente.
- Protegido por `empresa.configurar`, com controle de versão e auditoria
  (`company.own_team_default_changed`, antes/depois).
- O seed define Thiago **somente se nada estiver configurado** (nunca sobrescreve a escolha).

## 10. Regras financeiras

- Agendamento **não gera pagamento nem conta a pagar**: o custo da viagem nasce `PREVISTO`
  (Fase 6) e só vira obrigação do recebedor configurado quando a retirada é realizada/recebida.
- Terceirizada: **um** custo por viagem (índice existente), valor total, participantes não são
  credores (R$ 100 com André e Izaías = uma obrigação de R$ 100 para André, quando devida).
- **Correção comprovada**: antes, informar custo em retirada/entrega da **equipe própria** criava
  uma obrigação para o recebedor terceirizado. Agora: recusado no Novo serviço, em
  `POST /api/v1/pickups`, em `POST /api/v1/deliveries`, e ao mudar uma retirada com custo para
  equipe própria. As telas de retirada e entrega só mostram o campo de custo para a terceirizada.
  Custos da equipe própria continuam pelos lançamentos de custo da OS (regra existente).
- Valor fechado do pedido exige `pedidos.valores`; o custo exige `financeiro.gerenciar` —
  verificados no servidor, não só na tela.
- Fechamento semanal (Fase 7) inalterado: o custo entra no mesmo fluxo quando devido.

## 11. Permissões e auditoria

| Parte                                    | Permissão exigida no servidor                                              |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Usar o Novo serviço                      | `pedidos.gerenciar` **e** `retiradas.gerenciar`, sessão WEB                |
| Cadastrar cliente ou endereço            | `clientes.gerenciar`                                                       |
| Valor fechado / condições                | `pedidos.valores`                                                          |
| Valor da logística                       | `financeiro.gerenciar` (o valor só volta na resposta com `financeiro.ver`) |
| Configurar responsável da equipe própria | `empresa.configurar`                                                       |

Auditoria (mesma transação): `customer.created`, `customer.address_added`, `order.created`,
`pickup.created`, `finance.trip_cost_agreed`, `service.created`, `receipt.registered` (com a OS
gerada), `service_order.created` ("gerada automaticamente pelo recebimento …"),
`company.own_team_default_changed`. CSRF: a verificação de origem existente vale para as rotas
novas (testado). O roteiro e o celular da logística continuam **sem valores**.

## 12. Idempotência e concorrência

- `POST /api/v1/services` e `POST /api/v1/receipts` exigem `Idempotency-Key`: duplo clique ou
  reenvio devolvem a mesma resposta; a tela gera uma chave por intenção e troca após erro.
- Mesma chave simultânea: uma execução; a outra recebe a mesma resposta ou 409 "em andamento".
- Chaves diferentes para o **mesmo cliente novo**: a trava consultiva do cadastro serializa; a
  segunda recebe "possível duplicidade" — um único cliente.
- Recebimento: trava do pedido e das peças + saldo + índice único da OS por recebimento.
- Configuração da empresa: trava da linha + versão (409 se desatualizada).

## 13. Compatibilidade com dados antigos

- Nenhum pedido antigo é convertido (`auto_service_order` = `false` por padrão).
- OS existentes, planejamentos publicados, custos, contas a receber/pagar e auditoria não são
  alterados pela migration.
- As rotas antigas (cliente, pedido, retirada, OS) agora chamam os mesmos serviços de domínio e
  passaram na regressão completa.

## 14. Migrations e rollback

Migration aditiva `packages/db/prisma/migrations/20261129000000_novo_servico`:

| Tabela                   | Alteração                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `commercial_orders`      | `auto_service_order BOOLEAN NOT NULL DEFAULT false`, `promised_date DATE`, `technical_notes VARCHAR(4000)` |
| `commercial_order_items` | `service_type`, `fabric_name`, `fabric_color`, `fabric_reference`, `technical_notes` (todas anuláveis)     |
| `company_settings`       | `own_team_default_user_id UUID` → `users(id)` `ON DELETE SET NULL`                                         |
| `service_orders`         | `source_receipt_id UUID` **único** → `receipts(id)` + gatilho "mesmo pedido, imutável"                     |

Rollback: `packages/db/rollback/20261129000000_novo_servico.down.sql`. **Deixa de ser seguro**
(e por isso **recusa** antes de alterar qualquer coisa) quando existe pedido do Novo serviço, OS
gerada automaticamente, especificação de peça ou prazo/observação técnica gravados — nesses casos
a reversão perderia o vínculo OS ↔ recebimento e o combinado com o cliente; recupera-se pelo
backup anterior à migration. A configuração do responsável padrão é só configuração.

Teste encadeado (`scripts/test-evolution-migrations.sh`, PostgreSQL 16 local): legado (`839770a`) → todas as
migrations, incluindo `20261129000000_novo_servico`: dados legados idênticos (98 tabelas), índices
preservados (40 novos); rollback em ordem (novo serviço → roteiro → 7 → 6 → 5 → 3 → 2) com schema
idêntico ao legado; com dados novos, **cada** rollback recusou de forma atômica (`novo_servico`:
"Reversão bloqueada: 3 registro(s) do Novo serviço"); backup e restauração conferidos em 111
tabelas. ✔

**Nenhuma migration foi aplicada na homologação.**

## 15. Testes executados

Tudo em PostgreSQL 16 local descartável, dados fictícios, Chromium (Playwright 1.56.1).

| Suíte                                                                                                                                                                   | Resultado                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint (`pnpm lint`, `--max-warnings=0`)                                                                                                                                  | ✔ limpo                                                                                                                                                                                            |
| Tipos (`pnpm typecheck`: shared, db, api, web, e2e)                                                                                                                     | ✔ limpo                                                                                                                                                                                            |
| Build do web (`next build`, usado pelo E2E)                                                                                                                             | ✔                                                                                                                                                                                                  |
| Formatação (Prettier nos arquivos alterados)                                                                                                                            | ✔                                                                                                                                                                                                  |
| API — `novo-servico.test.ts` (unitário/integração/transação/idempotência/concorrência/permissões/valores/recebimento parcial/OS automática/tempo real)                  | ✔ **14/14**                                                                                                                                                                                        |
| API — regressão dos módulos refatorados (clientes, pedidos/retiradas, recebimentos/OS, tempo real comercial, correção global, custos de logística) logo após a extração | ✔ 52/52                                                                                                                                                                                            |
| API — suíte completa                                                                                                                                                    | ✔ **400 aprovados**, 5 arquivos ignorados (desempenho/migração, ativados por variável de ambiente)                                                                                                 |
| Migração, rollback e restauração (`scripts/test-evolution-migrations.sh`)                                                                                               | ✔ (§14)                                                                                                                                                                                            |
| E2E — `novo-servico.spec.ts` (Novo serviço, duplicidade, equipe própria, celular do André, chegada parcial → OS)                                                        | ✔                                                                                                                                                                                                  |
| E2E — suíte completa + geometria estrita (390/768/1280/1440)                                                                                                            | ✔ **30/30** (14,9 min), após a correção abaixo; geometria: 56 telas × 4 larguras = 224 medições, **0** desalinhamentos, **0** rolagem horizontal, **0** campo estourado, alturas de campo 36/44 px |

Correção durante os testes: o novo botão do cartão de Empresa chamava-se "Salvar" e colidia com o
botão do formulário existente (o teste `admin.spec.ts` acusou a ambiguidade). Renomeado para
"Definir responsável"; o teste existente não foi alterado.

## 16. Matriz CA2-01 a CA2-26

| CA     | Critério                                         | Evidência                                                                                                                                                                                 | Resultado     |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| CA2-01 | Novo serviço acessível diretamente               | menu (abaixo de Início) + botão no Início; E2E entra pelo Início                                                                                                                          | ✔            |
| CA2-02 | Cliente novo no mesmo formulário                 | API A1; E2E passo 1                                                                                                                                                                       | ✔            |
| CA2-03 | Cliente existente reutilizado sem duplicação     | API A2 (reuso, endereço novo, semelhante → candidatos, CPF igual bloqueia); E2E passo 2                                                                                                   | ✔            |
| CA2-04 | Pedido fechado criado corretamente               | API A1 (`auto_service_order`, itens, prazo, observações)                                                                                                                                  | ✔            |
| CA2-05 | Várias peças no mesmo serviço                    | API A1 (sofá + 2 poltronas); E2E (2 linhas)                                                                                                                                               | ✔            |
| CA2-06 | Valor comercial preservado sem receita duplicada | API A1/C1 (valor no pedido; 0 contas a receber; OS com participação proporcional)                                                                                                         | ✔            |
| CA2-07 | Retirada com data e horário único de chegada     | API A1 (`windowEnd` nulo); API D2 (data sem chegada = 400)                                                                                                                                | ✔            |
| CA2-08 | Equipe própria com Thiago configurável           | API B1/B2; E2E passo 3                                                                                                                                                                    | ✔            |
| CA2-09 | Terceirizada André + Izaías, valor único         | API A1 (um custo de R$ 100, participantes não credores); E2E                                                                                                                              | ✔            |
| CA2-10 | Sem pagamento prematuro                          | API A1 (custo PREVISTO, sem conta a pagar)                                                                                                                                                | ✔            |
| CA2-11 | Agenda e roteiro corretos                        | API B3 (lista de retiradas, roteiro do gestor, celulares de André e Izaías sem valores); E2E passo 4                                                                                      | ✔            |
| CA2-12 | Falha em qualquer etapa desfaz tudo              | API A3 (falha na retirada, no custo e no pedido: contagens idênticas)                                                                                                                     | ✔            |
| CA2-13 | Repetição não duplica                            | API A4 (mesma chave → mesma resposta)                                                                                                                                                     | ✔            |
| CA2-14 | Simultâneas não duplicam                         | API A4 (mesma chave e chaves diferentes)                                                                                                                                                  | ✔            |
| CA2-15 | OS não criada antes do recebimento               | API C1 (0 OS; OS manual continua bloqueada)                                                                                                                                               | ✔            |
| CA2-16 | Chegada cria OS automaticamente                  | API C1; E2E passo 5                                                                                                                                                                       | ✔            |
| CA2-17 | Repetir recebimento não duplica OS/peças         | API C2 (mesma chave), C3 (simultâneos; índice único no banco)                                                                                                                             | ✔            |
| CA2-18 | Parcial preserva ausentes                        | API C2 (RECEBIDO_PARCIAL; segunda chegada → segunda OS; soma = recebido); E2E passo 5                                                                                                     | ✔            |
| CA2-19 | OS mantém vínculos e valores                     | API C1 (pedido, cliente, recebimento, prazo, tecido, observações; receita do pedido)                                                                                                      | ✔            |
| CA2-20 | OS não publica produção                          | API C1 (0 tarefas, 0 item de plano, 0 mão de obra, sem titular)                                                                                                                           | ✔            |
| CA2-21 | Permissões financeiras e operacionais            | API D1 (cada parte com sua permissão; tablet e origem estranha recusados)                                                                                                                 | ✔            |
| CA2-22 | Registros antigos funcionam                      | API C4 (pedido antigo sem OS automática; OS manual ok); regressão completa; teste de migração                                                                                             | ✔            |
| CA2-23 | Interface responsiva e padronizada               | geometria estrita da nova tela em 390/768/1280/1440: campos 44 px, 0 desalinhamento, 0 rolagem horizontal, 0 campo estourado                                                              | ✔ (Chromium) |
| CA2-24 | Tempo real e reconexão                           | API D3 (`order.created`, `pickup.created`, `service_order.created`, `receipt.registered` com a OS); reconexão: mesmo mecanismo, coberta pelos E2E existentes (`tablet-sync`, `team-week`) | ✔            |
| CA2-25 | Migration, rollback, restauração                 | `scripts/test-evolution-migrations.sh`                                                                                                                                                    | ✔            |
| CA2-26 | Regressão completa API e E2E                     | API 400 ✔; E2E 30/30 ✔                                                                                                                                                                  | ✔            |

## 17. Evidências visuais

`docs/evidencias/simplificacao-fase-2/`:

| Arquivo                              | Conteúdo                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `01-novo-servico-formulario.png`     | formulário completo (cliente novo, 2 peças, retirada terceirizada, resumo) — 1440 px        |
| `02-novo-servico-confirmacao.png`    | página de confirmação (pedido, data/chegada, equipe, valor previsto, "Aguardando retirada") |
| `03-novo-servico-equipe-propria.png` | possível duplicidade resolvida + equipe própria com Thiago sugerido                         |
| `04-celular-andre-roteiro.png`       | celular do André (390 px): parada com chegada, sem valores                                  |
| `05-recebimento-os-automatica.png`   | chegada parcial registrada e OS gerada automaticamente                                      |

`docs/evidencias/simplificacao-fase-2/geometria/`: `geometria.json` completo da execução final
(todas as telas) e capturas da tela Novo serviço em 390, 768, 1280 e 1440 px.

## 18. Riscos e pendências

1. **Safari/WebKit e aparelhos físicos não testados** nesta fase (somente Chromium).
2. **Participantes sem custo** (ex.: equipe própria com ajudante) ficam registrados nas
   observações da retirada, porque o modelo da Fase 6 guarda participantes no custo da viagem; o
   roteiro mostra a parada ao responsável, mas não ao participante sem custo. Avaliar na Fase 3.
3. **Contas a pagar de compras** continuam fora do escopo (já registrado na Fase 1).
4. A área coletiva de recebimentos nos tablets (avisos, confirmação por qualquer funcionário,
   proteção visual contra confirmações simultâneas) é **Fase 3** — nesta fase a OS automática já
   funciona pelos recebimentos existentes (painel e API).
5. O seed define Thiago como padrão só se a configuração estiver vazia; em ambientes já
   configurados nada muda (decisão D3 respeitada pela tela de Empresa).

## 19. GO/NO-GO técnico para a Fase 3

| Item                                                                 | Situação        |
| -------------------------------------------------------------------- | --------------- |
| Novo serviço em uma tela/uma operação, atômica e idempotente         | ✔              |
| OS somente na chegada, sem duplicidade, parcial correto              | ✔              |
| Equipe própria (Thiago configurável) × terceirizada (valor único)    | ✔              |
| Regras financeiras preservadas + correção do custo da equipe própria | ✔              |
| Permissões, auditoria, CSRF, privacidade da logística                | ✔              |
| Migration aditiva, rollback condicionado, backup/restauração         | ✔ (local)      |
| Regressão completa (API 400, E2E 30/30, geometria estrita)           | ✔              |
| Safari/WebKit e aparelhos físicos                                    | ⚠️ não testados |

**GO técnico para iniciar a Fase 3** (Recebimentos compartilhados), condicionado à sua
autorização explícita. A publicação desta fase na homologação exige aplicar a migration
`20261129000000_novo_servico` pelo runbook (backup antes) — **não executada**.
