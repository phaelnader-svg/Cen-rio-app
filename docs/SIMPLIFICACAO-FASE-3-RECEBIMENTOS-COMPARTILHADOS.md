# Simplificação — Fase 3/10: Recebimentos compartilhados, confirmação rápida e sincronização entre tablets

> Tudo foi executado **localmente**, em PostgreSQL 16 descartável e com **dados fictícios**. Nada
> foi publicado. Não houve Cloud Build, nenhuma alteração no Google Cloud, nenhuma migration na
> homologação, nenhum dado real, nenhum pagamento e nenhuma mensagem externa. O VerificaPro não foi
> alterado. A Fase 4 **não** foi iniciada.

## 1. SHA inicial e final

| Item                            | Valor                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                          | `claude/cenario-gestao-fase-1-zf3bj2`                                                                                                                                                       |
| SHA inicial                     | `4dcc8ed` (fim da Fase 2; HEAD local = `origin`, worktree limpa)                                                                                                                            |
| Versão informada na homologação | `eb3fe2a` — não verificada (sem acesso de rede à homologação neste ambiente)                                                                                                                |
| Commits da fase                 | `63e7a4f` API/banco · `4b45a6d` telas · `3b2da9a` E2E · `71dee85` conferência obrigatória · `eba207f` ordem das peças · `322ba0a` ajustes E2E · `b34b8e9`, `f1490f4` evidências · relatório |
| SHA final                       | o commit que adiciona este relatório (último da branch; ver `git log`)                                                                                                                      |

## 2. Resumo da implementação

- **Central compartilhada "Aguardando chegada"** nos tablets (`GET /api/v1/arrivals`). Ela separa
  **Peças de clientes** e **Materiais comprados**. Não há fila por funcionário: todos os
  autorizados veem os mesmos avisos.
- **Confirmação rápida de peças** (`POST /api/v1/arrivals/pickups/:id/confirm`):
  - um toque confirma tudo; quem recebeu menos ajusta com − / +;
  - o sistema registra usuário, aparelho, data/hora e auditoria;
  - a OS da Fase 2 nasce só com as peças que chegaram;
  - o saldo continua aguardando.
- **Confirmação rápida de materiais** por pedido de compra
  (`POST /api/v1/arrivals/purchase-orders/:id/confirm`):
  - somente quantidades **físicas**, sem distribuição por OS;
  - itens controlados em metros registram a **chegada física** (ex.: 2 rolos) **sem inventar
    metragem**, e o estoque só recebe na **conferência técnica** posterior.
- **Uma confirmação válida por chegada.** A defesa fica no banco e na API, não só no botão:
  - versão esperada (409 "já foi atualizado em outro aparelho");
  - `Idempotency-Key`;
  - travas `FOR UPDATE`;
  - saldo pendente;
  - restrições de integridade.
- **Tempo real:** confirmou em um tablet, o aviso some dos outros sem recarregar. Uma tela de
  confirmação aberta sobre dados antigos mostra "Já atualizado em outro aparelho" e bloqueia o
  envio até a pessoa conferir o saldo atual.
- **Participantes operacionais estruturados** (`logistics_trip_participants`): não ficam mais em
  observação de texto livre. João, participando da retirada do Thiago, vê a parada no próprio
  roteiro sem custo. A participação **não gera pagamento**; André continua o único recebedor da
  logística terceirizada.
- **Painel do gestor (telas existentes):**
  - Recebimentos mostra a situação da retirada, quem confirmou, em qual aparelho e a OS criada.
  - Recebimento de materiais lista as chegadas físicas aguardando conferência, com o botão
    "Conferir".

## 3. Fluxos existentes reutilizados

| Fluxo existente                                             | Como foi reutilizado                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recebimento de peças (`POST /api/v1/receipts`)              | Lógica extraída para `receipts/service.ts › registerReceipt()`. O painel e o tablet usam **a mesma função**; não há segundo sistema de recebimentos.                                                                                         |
| OS automática da Fase 2 (`autoServiceOrderForReceipt`)      | Chamada dentro da mesma transação do recebimento, sem alteração de regra.                                                                                                                                                                    |
| Recebimento de materiais (`POST /api/v1/material-receipts`) | Lógica extraída para `purchasing/receipts.ts › registerMaterialReceipt()`. Foi reutilizada pela confirmação rápida (itens contáveis) e pela conferência técnica (`arrivalId`). Estoque, reservas, prontidão e divergências seguem idênticos. |
| Custo de viagem da Fase 6 (`syncTripCost`)                  | Inalterado. A retirada parcialmente recebida vai a "Retirada realizada" e o custo segue a regra de devido já existente.                                                                                                                      |
| Roteiro diário (`/api/v1/logistics/route`)                  | Os participantes estruturados entram nas paradas. Quem executa produção (`producao.executar`) vê **só** as próprias paradas.                                                                                                                 |
| WebSocket/outbox                                            | Eventos existentes (`receipt.registered`, `pickup.*`, `order.*`, `material_receipt.*`) mais `material.arrival_registered`, gravados na transação e entregues após o commit.                                                                  |
| Permissão `recebimentos.registrar`                          | Já existia (painel) e foi reutilizada para a central de peças nos tablets.                                                                                                                                                                   |
| Privacidade do tablet (`shortCustomerName`)                 | Aplicada a toda resposta de recebimento para sessões de tablet.                                                                                                                                                                              |

## 4. Alterações na API

| Endpoint                                                                       | Acesso                                                                        | Descrição                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/arrivals`                                                         | qualquer sessão                                                               | `{ pieces, materials }`. `pieces` é `null` sem `recebimentos.registrar`. Sem valores; no tablet, o nome do cliente é reduzido ("Helena F.").                                      |
| `POST /api/v1/arrivals/pickups/:id/confirm`                                    | `recebimentos.registrar`, idempotente                                         | `{ version, lines?, problem? }`. Sem `lines`, confirma o saldo da retirada. Devolve `ArrivalConfirmationDto` com recebimento, OS criada, saldo restante, quem confirmou e quando. |
| `POST /api/v1/arrivals/purchase-orders/:id/confirm`                            | qualquer funcionário (como o recebimento de materiais existente), idempotente | `{ version, lines[{purchaseOrderItemId, quantity, physicalUnit?}], problem? }`. Contáveis viram recebimento; itens em metros viram chegada física `CH-xxxxx`.                     |
| `GET /api/v1/material-arrivals?status=`                                        | painel com `estoque.ver`, `compras.ver` ou `estoque.gerenciar`                | Chegadas físicas (quem, aparelho, quando, problema, conferência).                                                                                                                 |
| `POST /api/v1/material-receipts`                                               | inalterado                                                                    | Aceita `expectedVersion?` e `arrivalId?` (conferência). Recusa (409) itens com chegada física pendente fora da conferência.                                                       |
| `POST/PUT /api/v1/pickups`, `POST /api/v1/deliveries`, `POST /api/v1/services` | inalterado                                                                    | Aceitam `participantUserIds` (participantes operacionais estruturados).                                                                                                           |
| `GET /api/v1/receipts*`                                                        | inalterado                                                                    | Passa a incluir `device` (aparelho que confirmou). Para tablets, o nome do cliente é reduzido.                                                                                    |
| `GET /api/v1/logistics/route` e `/logistics/jobs`                              | + `producao.executar` no roteiro                                              | Inclui as paradas em que a pessoa é **participante**. Quem não é gestor vê só as próprias.                                                                                        |

Contratos (zod/TS) em `packages/shared`:

- `confirmPieceArrivalSchema`, `confirmMaterialArrivalSchema`;
- `PHYSICAL_UNITS`, `ARRIVAL_PROBLEMS`;
- `PieceArrivalDto`, `MaterialArrivalDueDto`, `ArrivalsDto`, `ArrivalConfirmationDto`,
  `MaterialArrivalDto`;
- evento `MATERIAL_ARRIVAL_REGISTERED`.

## 5. Alterações nos tablets

- Novo bloco **"Aguardando chegada"** no Início, com contador (`tile-arrivals`). O bloco
  "Recebimento de materiais" detalhado continua existindo.
- Tela com duas seções. Cada cartão mostra:
  - tipo e identificação (`Retirada RT-…` / `Pedido CP-…`);
  - descrição resumida ("Sofá da sala e mais 1 — Helena F.");
  - **Situação** (ex.: "A caminho da oficina", "Previsto para hoje");
  - quantidades esperadas;
  - botão grande **Confirmar chegada** / **Confirmar materiais**.
- Tela de confirmação:
  - passos − / + (padrão = saldo);
  - para itens em metros, a contagem física com a escolha rolo(s) / volume(s) / pacote(s);
  - **Informar problema** opcional e recolhido;
  - um botão grande de confirmar.
- Resultado: quem confirmou e quando, recebimento, chegada física, **OS criada** e "Ainda
  aguardando: N".
- **Nunca** mostra sucesso antes da resposta do servidor. Sem conexão, o botão fica desativado e
  aparece o aviso.
- Falha de rede: a **mesma** chave de idempotência é reaproveitada na nova tentativa, então nada é
  duplicado. Qualquer outra resposta gera uma chave nova.
- **409 ou tela desatualizada:** aparece "Já atualizado em outro aparelho. Confira o saldo atual
  antes de confirmar" com o botão "Ver saldo atual". O envio fica bloqueado até a pessoa conferir.
- **"Minhas retiradas e entregas de hoje"** (equipe própria): paradas em que a pessoa é
  responsável ou participante. É só leitura, com endereço, horário de chegada ao cliente e
  equipe, e sem valores.
- Sem valores, sem "atrasado" e sem rolagem horizontal em 390/768/1280/1440 (E2E, §16).

## 6. Regras de recebimento de peças

1. A central lista retiradas `AGENDADA` (só a partir do dia agendado), `EM_EXECUCAO`,
   `RETIRADA_REALIZADA` e `COM_OCORRENCIA` de pedidos não cancelados com saldo pendente. O saldo
   de cada peça é o mínimo entre (quantidade da retirada − já recebida por ela) e o pendente do
   pedido.
2. **Horário = chegada ao CLIENTE.** As situações exibidas são:
   - "Retirada de hoje — chegada ao cliente HH:MM";
   - a partir do horário: "Retirada prevista — equipe no cliente a partir das HH:MM";
   - "Em coleta no cliente";
   - "A caminho da oficina";
   - "Chegou em parte — aguardando o restante";
   - "Retirada com ocorrência".

   **Nenhuma** situação de "atraso" existe (testado: o texto nunca contém "atras").

3. Não é possível confirmar peça de outro pedido, peça repetida ou quantidade acima do saldo da
   retirada ou do pedido.
4. A confirmação registra:
   - pedido, retirada, peças e quantidades;
   - `receivedByEmployeeId` (funcionário do tablet);
   - `registeredById` (usuário);
   - **`device_id`** (aparelho);
   - `receivedAt`;
   - auditoria `receipt.registered` (com `deviceId` e `generatedServiceOrderId`).
5. **Parcial:** a retirada fica "Retirada realizada" com evento `RECEBIMENTO_PARCIAL` e saldo no
   aviso. Ela só fica "Recebida na oficina" quando **todas** as peças dela chegaram. Antes da
   Fase 3, o primeiro recebimento parcial fechava a retirada (problema corrigido, §19).
6. Cada recebimento cria **uma** OS (Fase 2, D1) só com as peças dele. A chegada do restante
   cria a OS desse novo recebimento. Repetir não duplica (`source_receipt_id` único).
7. Problema opcional: "Informar problema" grava a observação como divergência do recebimento e
   marca a condição das peças como `REGULAR`.

## 7. Regras de recebimento de materiais

1. A central lista pedidos `CONFIRMADO` / `PARCIALMENTE_RECEBIDO` com saldo por item. O saldo é
   quantidade + excedente − recebido − encerrado, e itens com chegada física pendente ficam fora
   da lista. Mostra "Previsto para hoje", "Previsto para dd/mm" ou "Sem previsão de entrega".
2. **Contáveis** (peça, placa, unidade, embalagem):
   - a quantidade informada vira o recebimento normal (estoque/OS como antes);
   - o padrão é o saldo.
3. **Controlados em metros ou m²** (tecido sempre; outros se cadastrados assim):
   - a confirmação rápida só aceita um **número inteiro de volumes físicos** (rolo, volume,
     pacote…);
   - ela cria a chegada física `CH-xxxxx` (`PENDENTE_CONFERENCIA`);
   - **não** entra metro algum no estoque.

   Cinco rolos **nunca** viram cinco metros.

4. **Conferência técnica** (painel → Recebimento de materiais → "Conferir"):
   - usa o formulário existente com `arrivalId`;
   - a pessoa informa a **medida real** e confirma a especificação;
   - só então entra no estoque e a chegada fica `CONFERIDA` (vínculo único com o recebimento).
   - Fora da conferência, o mesmo item é recusado (409) para não contar a remessa duas vezes.
5. **Parcial:** registra só o informado; o resto continua aguardando. Não há saldo fictício.
6. **Informar problema** (opcional): faltando, diferente, danificado, quantidade divergente ou
   outro, com observação.
   - "Diferente" e "danificado" sobre um item registram o material como **recusado**: não fica
     disponível sem a decisão do gestor (fluxo de divergência existente).
   - "Faltando" e "quantidade divergente" registram a divergência (`INCOMPLETO`).
7. Nenhuma conta a pagar é criada ou alterada pelos recebimentos (testado por contagem).

## 8. Concorrência e idempotência

| Camada                  | Proteção                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Banco                   | Travas `FOR UPDATE` no pedido comercial e nas peças (peças) e no pedido de compra e nos itens (materiais). Restrições `recebido ≤ quantidade`. `source_receipt_id` único na OS. `material_receipt_id` único na chegada física. `CHECK`s de status e formato. |
| Versão                  | A retirada e o pedido de compra são conferidos **dentro** da transação travada; versão diferente = **409** "já foi atualizado em outro aparelho". A versão do pedido de compra agora sobe a **cada** recebimento (antes, só quando a situação mudava).       |
| Idempotência            | `Idempotency-Key` (usuário + chave): a repetição devolve **a mesma resposta** sem regravar.                                                                                                                                                                  |
| Saldo                   | Recalculado com as travas; nunca acima do pendente.                                                                                                                                                                                                          |
| Requisições simultâneas | Duas confirmações com a mesma versão: uma vence (201) e a outra recebe 409. Uma só OS, um só recebimento, nenhum lançamento financeiro novo (testado com `Promise.all`).                                                                                     |
| Parciais em sequência   | João confirma 2 de 3 sofás; Márcio, com a versão atual, confirma o 3º sofá + poltrona. As duas valem, sem perda nem duplicação (testado).                                                                                                                    |
| Frontend                | Só complementa: botão bloqueado durante o envio, aviso de tela desatualizada e a mesma chave na nova tentativa após falha de rede.                                                                                                                           |

## 9. Eventos em tempo real

- Na confirmação de peças, os eventos `receipt.registered`, `pickup.status_changed`,
  `order.updated` e `service_order.created` são gravados no outbox **na transação** e entregues
  após o commit.
- Na de materiais, os eventos são `material_receipt.*` e `purchase_order.*`, mais
  `material.arrival_registered` para a chegada física.
- O web invalida as chaves `arrivals`, `material-arrivals` e `logistics-route` para esses
  prefixos (`lib/realtime.tsx`). O aviso some dos demais tablets sem recarregar (testes de API e
  E2E com dois tablets).
- **Reconexão:** o mecanismo existente reenvia o que ficou para trás (teste: um tablet que
  reconecta a partir de uma sequência antiga recebe o `receipt.registered` perdido). Ao recarregar a central, os avisos
  resolvidos desaparecem.
- Os eventos do pedido que chegam aos tablets da produção (que agora podem confirmar chegada)
  levam **só** `id`, `code`, `status` e `version`. Um teste novo verifica as chaves exatas, e
  tablets sem permissão comercial continuam sem receber `customer.*`.

## 10. Permissões e privacidade

- **Peças de clientes:** `recebimentos.registrar` (já existente). Entra no padrão das funções
  tapeceiro, cabeceiras/qualidade e ajudante. **Não** entra na logística terceirizada: André e
  Izaías não veem a central de peças (`pieces = null`, 403 na confirmação).
- **Materiais:** qualquer funcionário, como o recebimento de materiais já era.
- Confirmar recebimento **não** dá acesso a preços, compras, mão de obra, pagamentos,
  planejamento ou financeiro: nenhuma permissão além de `recebimentos.registrar` foi concedida.
  Testado: o tablet do João recebe 403 em `/finance/labor`, `/finance/payables`,
  `/material-arrivals` e `/purchasing/needs`.
- Tablet: o nome do cliente é reduzido em **toda** resposta de recebimento (central, lista,
  detalhe, pendentes, confirmação). Não há valores comerciais, custos de compra nem pagamentos nas
  respostas (testado com busca por `Cents|price|valor|amount`).
- **Instalações existentes:** o seed só preenche funções **vazias**, então funções já
  configuradas **não** ganham `recebimentos.registrar` automaticamente. O gestor concede em
  **Funções e permissões** aos que devem confirmar peças (pendência operacional, §20). Nenhuma
  permissão foi enfraquecida.

## 11. Participantes de logística

- Tabela `logistics_trip_participants` (retirada **ou** entrega, um usuário uma vez por viagem,
  `CHECK` de exatamente uma viagem, removida com a viagem).
- São quatro papéis separados:
  - **responsável pela execução**: `logisticsUserId` / `responsibleUserId`;
  - **participantes operacionais**: a tabela nova;
  - **recebedor financeiro**: o configurado na Fase 6;
  - **valor total combinado**: o custo da viagem.
- Cada participante é validado (ativo, com `logistica.executar` ou `producao.executar`). O
  responsável é ignorado se também for listado.
- O Novo serviço deixou de gravar "Participantes: …" nas observações e envia a lista
  estruturada.
- **Equipe própria sem custo:** João participante vê a parada no roteiro e nos trabalhos. Não há
  custo nem obrigação (testado).
- **Terceirizada (R$ 100, André + Izaías):** um único custo e um único credor (André). Izaías
  participante vê a parada (testado).

## 12. Integração com OS

- A OS nasce **somente** no recebimento (nenhuma antes), com o cliente e o pedido corretos e só as
  peças efetivamente recebidas.
- Os valores comerciais são preservados e não há receita duplicada.
- **Nenhum** tapeceiro é escolhido, **nenhuma** tarefa é criada e **nenhum** planejamento é
  publicado. Isso foi verificado nos testes; nada da Fase 4 foi implementado.
- A OS fica disponível para a fila A planejar da Fase 4.

## 13. Integração com compras e estoque

- Os conceitos ficam separados: **chegada física** (`material_arrivals`), **conferência
  técnica** (recebimento com `arrivalId`) e **disponível para uso** (regras de estoque e
  divergência existentes).
- O mesmo cadastro de materiais e o mesmo recebimento são usados; não há segundo cadastro.
- **Não é possível:**
  - saldo negativo;
  - recebimento acima do pendente;
  - entrada duplicada (versão, idempotência, travas e bloqueio de itens com chegada pendente);
  - duplicação de contas a pagar;
  - conversão de unidades;
  - liberação de material divergente sem autorização.

## 14. Migrations e rollback

**Migration `20261206000000_recebimentos_compartilhados`** (somente aditiva):

- `receipts.device_id`: nulo, FK para `devices`, `SET NULL`;
- tabela `logistics_trip_participants`;
- tabela `material_arrivals`;
- `CHECK`s: uma viagem por participante, status válido, conferida ⇒ recebimento,
  `lines` é array.

Nenhum dado existente é convertido. Não há nova restrição sobre tabelas antigas, então não há
conflito com dados legados.

**Rollback** `packages/db/rollback/20261206000000_recebimentos_compartilhados.down.sql`:

- **Recusa** (antes de qualquer alteração) se existir participante, chegada física ou
  recebimento com aparelho.
- Sem dados novos, remove as tabelas e a coluna e apaga o registro em `_prisma_migrations`.

**Teste encadeado** (`scripts/test-evolution-migrations.sh`, atualizado):

1. Legado `839770a` com o fluxo completo de 32 passos.
2. Todas as migrations, incluindo a da Fase 3.
3. Dados legados idênticos (md5 por coluna).
4. Código atual lê o legado.
5. Rollbacks **recebimentos → novo serviço → roteiro → 7 → 6 → 5 → 3 → 2**: schema idêntico ao
   legado (`pg_dump -s`) e dados idênticos.
6. Reaplica e cria dados novos, incluindo o participante da Fase 3 via `POST /api/v1/services`.
   Cada rollback é **recusado** sem mutação.
7. Backup e restauração verificados.

Resultado em §16. **Não** executado na homologação.

**Integridade financeira:** as somas de contas a pagar, mão de obra e a receber e as contagens de
pagamentos foram fotografadas antes e depois da migration e comparadas (idênticas). As contagens
de contas a pagar também foram verificadas nos testes de confirmação.

## 15. Compatibilidade com dados anteriores

- Recebimentos antigos ficam com `device_id` nulo e aparecem normalmente ("Confirmado por …").
- O recebimento pelo painel continua igual, sem versão e sem limitar ao saldo da retirada, como
  antes (teste "pedidos antigos").
- Retiradas antigas aparecem na central se estiverem em situação de recebimento.
- Participantes antigos que só existiam no custo de viagem (Fase 6) continuam valendo no roteiro
  e na lista de trabalhos (união com a tabela nova).
- O recebimento de materiais pelo painel e pelo tablet antigo ("Recebimento de materiais")
  continua funcionando.

## 16. Testes executados

Ambiente: PostgreSQL 16 local descartável, dados fictícios.

| Suíte                                                                                                   | Resultado                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/recebimentos-compartilhados.test.ts` (novo)                                              | 13/13                                                                                                                                                                              |
| `apps/api/test/commercial-realtime.test.ts` (+1 teste)                                                  | 5/5                                                                                                                                                                                |
| API completa (`vitest run`, todas as suítes)                                                            | 414 aprovados, 5 ignorados (verificações de migração, executadas pelo script) — 43 arquivos                                                                                        |
| Migração encadeada, rollback condicionado e backup/restauração (`scripts/test-evolution-migrations.sh`) | Aprovado: legado intacto; 8 rollbacks (schema/dados idênticos); 7 recusas atômicas; restauração (113 tabelas comparadas)                                                           |
| E2E `recebimentos.spec.ts` (novo: dois tablets + painel)                                                | 1/1                                                                                                                                                                                |
| E2E completo com geometria estrita (`E2E_GEOMETRIA=depois-fase3 E2E_GEOMETRIA_ESTRITO=1`)               | 31/31 (14,4 min); geometria 56 telas × 4 larguras: 0 desalinhamentos, 0 rolagem horizontal, 0 campos estourados                                                                    |
| Lint (`pnpm lint`) · Typecheck (todos os pacotes) · Build web · Prettier                                | Lint 0 erros · typecheck 0 erros · build web OK (`next build` do E2E) · Prettier OK nos arquivos-fonte (3 JSON de evidência de fases anteriores, não alterados, já fora do padrão) |

Os testes de API cobrem:

- **Central:** separação peças/materiais, privacidade, ausência de valores e de "atraso", e a
  retirada futura fora da lista.
- **Peças:**
  - confirmação rápida com quem, aparelho e quando;
  - parcial com a OS só do que chegou;
  - versão antiga → 409, sem duplicar;
  - duas simultâneas;
  - repetição idempotente;
  - **dois funcionários com parciais diferentes em sequência**;
  - tempo real e reconexão;
  - painel legado.
- **Materiais:**
  - contagem física, rolos sem metragem, parcial e versão antiga;
  - bypass da conferência recusado e conferência limitada à chegada;
  - conferência com 14,5 m;
  - simultâneas, material danificado não disponível e contas a pagar inalteradas.
- **Participantes e permissões:**
  - equipe própria sem custo;
  - terceirizada com um credor;
  - logística sem central de peças;
  - confirmação sem acesso financeiro;
  - nome reduzido no tablet.

**Não testado:** Safari/WebKit e tablets/celulares físicos **não** foram testados nesta fase e
**não** são declarados aprovados. Os testes usaram Chromium com viewport e toque emulados.

## 17. Matriz CA3-01 a CA3-26

| CA     | Critério                                              | Situação | Evidência                                                                                                       |
| ------ | ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| CA3-01 | Central Aguardando chegada disponível nos tablets     | Aprovado | API A; E2E (`tile-arrivals`, capturas 02 e 09)                                                                  |
| CA3-02 | Retiradas e materiais identificados separadamente     | Aprovado | API A; E2E (seções "Peças de clientes" / "Materiais comprados")                                                 |
| CA3-03 | Aviso respeita chegada ao cliente × chegada à oficina | Aprovado | API A (situações; "atras" ausente; retirada futura fora); E2E                                                   |
| CA3-04 | Funcionário autorizado confirma chegada de peças      | Aprovado | API B; E2E (João e Márcio)                                                                                      |
| CA3-05 | Registra usuário, dispositivo, data e hora            | Aprovado | API B (`device_id`, auditoria); E2E painel "Confirmado por João no aparelho Tablet João (Chegada)" (captura 08) |
| CA3-06 | OS automática após recebimento                        | Aprovado | API B; E2E `arrival-done-os` (captura 04)                                                                       |
| CA3-07 | Parcial gera OS apenas das peças recebidas            | Aprovado | API B (itens e quantidades da OS)                                                                               |
| CA3-08 | Peças ausentes permanecem pendentes                   | Aprovado | API B; E2E "Ainda aguardando: 1"                                                                                |
| CA3-09 | Repetição não duplica OS                              | Aprovado | API B (versão antiga e repetição: 1 OS)                                                                         |
| CA3-10 | Dois tablets simultâneos não duplicam recebimento     | Aprovado | API B e C (`Promise.all`: 201 + 409); E2E aviso "Já atualizado" (captura 05)                                    |
| CA3-11 | Repetição após falha de rede é idempotente            | Aprovado | API B (mesma chave → mesma resposta, nada regravado)                                                            |
| CA3-12 | Aviso desaparece dos tablets                          | Aprovado | API B (evento ao outro tablet); E2E (some dos dois tablets)                                                     |
| CA3-13 | Reconexão recupera estado                             | Aprovado | API B (reenvio após queda)                                                                                      |
| CA3-14 | Materiais por pedido, sem distribuição por OS         | Aprovado | API C; E2E (captura 06)                                                                                         |
| CA3-15 | Parcial de materiais mantém saldo                     | Aprovado | API C (15 → 5 pendentes); E2E (1 placa pendente)                                                                |
| CA3-16 | Unidades preservadas                                  | Aprovado | API C (2 rolos ≠ metros; conferência 14,5 m); E2E (rolos → conferência 24,5 m)                                  |
| CA3-17 | Divergências sem bloquear recebimentos normais        | Aprovado | API C (danificado recusado/indisponível; recebimento normal sem formulário)                                     |
| CA3-18 | Nenhuma entrada duplicada no estoque                  | Aprovado | API C (versão, simultâneas, bypass da conferência recusado)                                                     |
| CA3-19 | Nenhuma obrigação financeira duplicada                | Aprovado | API C (contas a pagar inalteradas); API D (um custo, um credor)                                                 |
| CA3-20 | Participantes sem custo aparecem no roteiro           | Aprovado | API D; E2E "Minhas retiradas e entregas de hoje" (captura 01)                                                   |
| CA3-21 | Participação não gera pagamento automático            | Aprovado | API D (nenhuma obrigação; terceirizada: só André)                                                               |
| CA3-22 | Funcionários não recebem dados financeiros            | Aprovado | API A e D; realtime (chaves exatas do evento); E2E (sem "R$")                                                   |
| CA3-23 | Permissões operacionais respeitadas                   | Aprovado | API D (logística sem peças; 403 em financeiro e compras)                                                        |
| CA3-24 | Dados legados preservados                             | Aprovado | API B (painel legado); script encadeado (dados legados idênticos)                                               |
| CA3-25 | Migration, rollback e backup/restauração              | Aprovado | §14, §16                                                                                                        |
| CA3-26 | Regressão completa da API, Web e E2E                  | Aprovado | §16                                                                                                             |

## 18. Evidências visuais

Capturas em `docs/evidencias/simplificacao-fase-3/` (geradas pelo E2E, dados fictícios):

| Arquivo                                          | Conteúdo                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `01-joao-inicio-minhas-retiradas.png`            | Início do João: participante da retirada do Thiago, sem valores      |
| `02-tablet-aguardando-chegada.png`               | Central com peças (nome reduzido) e materiais                        |
| `03-tablet-confirmacao-parcial.png`              | Confirmação de 2 de 3 peças                                          |
| `04-tablet-resultado-os.png`                     | Resultado: OS criada e "Ainda aguardando: 1"                         |
| `05-tablet-marcio-ja-atualizado.png`             | Tablet do Márcio: "Já atualizado em outro aparelho", envio bloqueado |
| `06-tablet-materiais-contagem-fisica.png`        | Placas (contagem) e manta em metros (2 rolos, sem metragem)          |
| `07-painel-chegadas-fisicas.png`                 | Painel: chegada `CH-…` aguardando conferência (quem, aparelho)       |
| `08-painel-recebimentos-quem-confirmou.png`      | Painel: "Confirmado por … no aparelho …" e OS criada                 |
| `09-aguardando-chegada-{390,768,1280,1440}.png`  | Central em quatro larguras (sem rolagem horizontal, verificado)      |
| `10-confirmar-materiais-{390,768,1280,1440}.png` | Confirmação em quatro larguras (sem rolagem horizontal, verificado)  |

A geometria das telas do painel está em `docs/evidencias/interface/depois-fase3/geometria.json`
(execução estrita).

## 19. Problemas encontrados e corrigidos

1. **Duplicidade entre tablets (achado da Fase 1).** Corrigido com versão, idempotência, travas e
   saldo (§8). A versão do pedido de compra agora sobe a cada recebimento: antes, dois parciais
   que não mudavam a situação deixavam a versão igual.
2. **Recebimento parcial fechava a retirada.** O primeiro parcial levava a retirada a "Recebida na
   oficina", e o restante deixava de aparecer como aguardando. Agora ela só fecha quando todas as
   peças chegaram.
3. **Participantes em texto livre (achado da Fase 2).** Agora são estruturados, aparecem no
   roteiro e na lista de trabalhos e não geram pagamento.
4. **Roteiro inacessível à equipe própria de produção.** O acesso ao roteiro passou a aceitar
   `producao.executar`, ainda limitado às próprias paradas.
5. **Privacidade.** Ao dar `recebimentos.registrar` aos tablets, as respostas de recebimento
   passariam o nome completo do cliente. Agora é reduzido para sessões de tablet. Um teste novo
   garante que eventos de pedido nos tablets da produção não carregam valores.
6. **Remessa contada duas vezes.** Era possível receber pelo painel um item cuja chegada física
   aguardava conferência. Agora é recusado (409) e a conferência só aceita os itens da própria
   chegada.
7. **Teste de isolamento do tempo real.** O tablet de referência ganhou permissão de recebimento.
   O teste agora usa uma função dedicada sem permissões comerciais, e foi acrescentado o teste
   para tablets da produção.

8. **Ordem das peças na central não determinística.** A regressão completa da API pegou a
   falha. As peças agora seguem a ordem do pedido.
9. **E2E existentes afetados pelos dados novos (não por regressão funcional):**
   - `team-logistics`: André, participante do custo da viagem, passou a ver essas retiradas na
     lista de trabalhos (comportamento pretendido da Fase 3). A verificação "sem valores"
     procurava `10000` e casava com o CEP fictício `01000000`; agora exige o número isolado.
   - `team-route-os`: a retirada criada pelo E2E novo às 00:00 virava a 1ª parada global do
     dia; passou para 23:00.

## 20. Pendências e riscos

- **Permissão em instalações existentes:** funções já configuradas não recebem
  `recebimentos.registrar` automaticamente. O gestor deve conceder em "Funções e permissões"
  antes do uso. Sem isso, os tablets mostram só materiais.
- **Safari/WebKit e aparelhos físicos** não testados. Exigem teste manual antes da publicação.
- **Sem conexão:** o bloqueio do botão segue o indicador de tempo real existente. O comportamento
  offline real (rede caindo no meio do envio) foi coberto por API (idempotência), mas não por
  emulação de rede no navegador.
- **Chegada física pendente esquecida:** fica visível no painel (Recebimento de materiais) até
  ser conferida. A recusa do recebimento comum obriga a conferência. Não há prazo nem alerta
  automático (Central do Gestor, Fase 10).
- A **situação "parcial" por item** da retirada não tem tela própria no painel: aparece na
  central, na lista de pendentes e no histórico de eventos da retirada.
- A migration **não** foi aplicada na homologação. A publicação segue o runbook (backup antes,
  migração explícita).

## 21. GO/NO-GO técnico para a Fase 4

**GO técnico** para a Fase 4. Os 26 critérios têm evidência; regressão completa da API, do web e do E2E aprovada; migration aditiva com rollback condicionado e restauração verificados. Condições antes do uso real (não bloqueiam o desenvolvimento da Fase 4): conceder `recebimentos.registrar` às funções que confirmarão peças; testar Safari/WebKit e tablets físicos; aplicar a migration na homologação somente com backup e autorização.

A Fase 4 **não** foi iniciada. Aguardando autorização explícita.
