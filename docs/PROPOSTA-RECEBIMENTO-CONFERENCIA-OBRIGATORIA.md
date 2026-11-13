# Proposta técnica — separar chegada e entrada no estoque, com conferência obrigatória

**Situação: proposta. NÃO implementada.** Por decisão, a regra atual continua valendo. Nada neste
documento foi alterado no código, no banco ou na homologação. A implementação depende de
autorização posterior.

## 1. Regra atual (versão `696e3e9`)

Todo item de pedido de compra cai num destes dois casos. O que separa os dois é a função
`requiresTechnicalConference(item)` (`packages/shared/src/measurements-domain.ts`).

| Item do pedido                                                                                            | Exemplo                       | Registro da chegada                                                                                                                                                              | Entrada no estoque                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Técnico**: unidade decimal (metros ou m²) **ou** compra exclusiva de uma OS (`EXCLUSIVO_OS`)            | tecido, espuma de uma OS      | Qualquer funcionário registra a **chegada física**: `MaterialArrival`, situação `PENDENTE_CONFERENCIA`                                                                           | Só na **conferência**, por quem tem `estoque.conferir`. O sistema grava então o recebimento com a medida real           |
| **Não técnico**: contável (placas, peças, unidades, embalagens) **e** comprado para o estoque (`ESTOQUE`) | grampos, botões, pés de móvel | Qualquer funcionário (`ANY_EMPLOYEE`), pelo painel (`POST /api/v1/material-receipts`) ou pela confirmação rápida do tablet (`POST /api/v1/arrivals/purchase-orders/:id/confirm`) | **Imediata**: no mesmo passo, `registerMaterialReceipt` lança `ENTRADA_COMPRA` e faz as reservas automáticas para as OS |

Proteções que já existem e continuam valendo:

- **Limite da quantidade recebida**: o recebimento não passa do pedido mais o excedente
  autorizado pelo gestor.
- **Concorrência**: há versão esperada do pedido, e a segunda confirmação feita sobre uma tela
  antiga é recusada.
- **Material com problema**: o que chega diferente ou danificado nunca fica disponível.
- **Rastreabilidade**: autor, dispositivo e histórico ficam no pedido e na auditoria.
- **Sem valores para quem não tem permissão**: a lista de pendências não mostra preços nem custos.

**O que fica em aberto:** no caso não técnico, quem só deveria **registrar que chegou** acaba
**colocando o material no estoque** e disparando reservas, sem que ninguém autorizado confira.

## 2. Proposta

**Toda chegada passa a ser só chegada física. A entrada no estoque acontece apenas na conferência.**
O fluxo que hoje existe para o material técnico seria reaproveitado para todos os itens.

### 2.1 Interruptor, sem migration

- Novo interruptor da empresa: **"Conferência obrigatória no recebimento"**, em Empresa →
  Funcionalidades.
- Ele fica gravado na tabela que já guarda os interruptores (`ModuleSetting`, `key` de até 40
  caracteres).
- **Desligado (padrão na implantação):** comportamento idêntico ao atual.
- **Ligado:** vale para os registros feitos a partir da mudança; o histórico não muda.
- Versões antigas ignoram chaves desconhecidas (`resolveModules`). Por isso o retorno para a F′ ou
  para a R2 continua possível sem mudança de esquema.

### 2.2 Mudanças de comportamento com o interruptor ligado

| Ponto                                                    | Hoje                                | Com o interruptor ligado                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requiresTechnicalConference`                            | unidade decimal ou `EXCLUSIVO_OS`   | passa a valer **para todos os itens** (uma regra só, em `shared`, usada pela API, pela web e pelo tablet)                                                                                                                |
| Painel, `POST /material-receipts` sem `estoque.conferir` | lança o estoque do item não técnico | para quem não confere, registra a **chegada física** (`MaterialArrival` com a contagem na unidade do item); a resposta diz "aguardando conferência". Com `estoque.conferir`, a tela oferece "Registrar e conferir agora" |
| Tablet, confirmação rápida                               | item contável vira recebimento      | todo item vira **chegada física**; a tela do tablet não muda, só a mensagem final                                                                                                                                        |
| Conferência                                              | só para itens técnicos              | para todos, pela lista "aguardando conferência", que já existe. Aceita quantidade conferida, recusa e divergência; **só então** lança `ENTRADA_COMPRA` e faz as reservas                                                 |
| Situação do pedido de compra                             | muda no recebimento                 | continua `CONFIRMADO` ou `PARCIALMENTE_RECEBIDO` até a conferência; ganha a indicação "chegou, aguardando conferência"                                                                                                   |
| Prontidão de materiais da OS                             | material disponível no recebimento  | material "chegou, aguardando conferência". Com as **travas de materiais** ligadas, a produção só libera depois da conferência                                                                                            |

### 2.3 Efeitos colaterais a tratar

1. **Atraso operacional.** Material contável só fica disponível depois da conferência. Proposta:
   - um aviso interno "Chegada aguardando conferência há mais de N horas" no padrão dos alertas da
     Fase 4, recalculado e encerrado sozinho, sem envio externo;
   - um item em "Ações sugeridas hoje" para quem tem `estoque.conferir`.
2. **Alerta "Material faltante".** Ele não deve disparar para material que já chegou e só aguarda
   conferência. Esse material ganha uma situação própria no alerta.
3. **Contagem dupla.** A proteção atual continua: item com chegada pendente só entra no estoque
   pela conferência daquela chegada, e um novo recebimento direto do mesmo item é recusado.
4. **Divergência na conferência.** Se a quantidade conferida for menor que a contada, a diferença
   fica registrada na chegada e vai para a decisão "repor / não repor" que já existe (V4). Nada é
   ajustado sozinho.
5. **Permissões.** Nenhuma permissão nova. Registrar a chegada continua com qualquer funcionário,
   conferir continua com `estoque.conferir`, e alterar saldo diretamente continua com
   `estoque.gerenciar`.
6. **Chegadas pendentes ao desligar o interruptor.** Elas continuam pendentes até a conferência, e
   nada é convertido automaticamente. Se a conferência fosse pulada, o mesmo item poderia ser
   contado duas vezes.

### 2.4 Compatibilidade e retorno

- **Sem migration:** usa `MaterialArrival` e `ModuleSetting`, que já existem.
- **Retorno para a F′ ou a R2:** chegadas pendentes de itens contáveis aparecem na lista de
  conferência das versões antigas. A conferência antiga já aceita qualquer item da chegada, desde
  que quem confere tenha `estoque.conferir`. Antes da implementação, isso precisa ser confirmado
  por um teste de compatibilidade com a imagem de retorno.
- **Dados existentes:** nenhum recebimento ou movimento passado é alterado.

### 2.5 Testes necessários antes de qualquer deploy

- API:
  - interruptor desligado = comportamento idêntico ao atual, com os testes atuais sem mudança;
  - interruptor ligado:
    - quem não confere gera chegada e não gera `ENTRADA_COMPRA`;
    - a conferência lança a entrada exatamente uma vez;
    - duas conferências simultâneas da mesma chegada resultam em uma só;
    - receber direto um item com chegada pendente é recusado;
    - a divergência vai para a decisão V4;
    - a reserva automática só acontece na conferência;
    - a trava de produção espera a conferência.
- Tablet: confirmação rápida com o interruptor ligado, incluindo envio sem rede e
  re-sincronização.
- Web: lista de conferência com itens contáveis; perfil sem `estoque.conferir` não confere; nenhum
  valor visível para quem não tem permissão.
- E2E: o fluxo do pedido de compra até a OS liberada, com e sem o interruptor.
- Compatibilidade: chegada pendente criada pela versão nova e conferida pela imagem de retorno.

### 2.6 Esforço estimado

| Parte        | Escopo                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared`     | regra única com o interruptor; rótulos                                                                                                                                     |
| API          | `registerMaterialReceipt` e a confirmação rápida passam a desviar para a chegada quando o interruptor está ligado; prontidão e alertas reconhecem "aguardando conferência" |
| Web e tablet | interruptor em Empresa; mensagens; "Registrar e conferir agora" para quem confere                                                                                          |
| Testes       | os da seção 2.5                                                                                                                                                            |

Não há mudança de esquema, permissão nova nem efeito financeiro: o custo continua sendo apurado
pela compra, como hoje.

## 3. Decisões necessárias

1. Aprovar ou recusar a proposta.
2. Se aprovada, decidir duas coisas:
   - o valor de **N horas** para o aviso de chegada sem conferência (sugestão: 24 h);
   - se quem tem `estoque.conferir` pode registrar e conferir no mesmo passo (sugestão: sim, com
     registro separado dos dois eventos na auditoria).
3. Autorizar a implementação. Ela seguiria o mesmo processo das correções anteriores: ambiente
   isolado, testes, nova versão candidata e deploy em homologação só com nova autorização.
