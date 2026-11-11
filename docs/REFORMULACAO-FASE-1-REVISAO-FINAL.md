# Reformulação — Fase 1: revisão final antes da homologação

Escopo: integridade financeira, regressões e compatibilidade. Tudo foi feito **somente no ambiente
de desenvolvimento**, em PostgreSQL 16 local e descartável. Nenhum deploy, merge, migration em
ambiente compartilhado ou alteração de infraestrutura ou VM.

- Branch: `claude/reformulacao-fase-1`.
- Ponto de partida da revisão: `8f89832`.
- Ponta final: ver a seção 8.

Legenda: **[TESTADO]** coberto por teste que passou · **[MEDIDO]** observado em execução real
isolada · **[ESTIMADO]** cálculo com base declarada · **[NÃO TESTADO]**.

## 1. Custos de material: formal × informado na OS

### 1.1 Como era contabilizado (investigação)

O livro de custos `service_order_costs` é **imutável** e é a fonte do realizado da OS. Ele recebe
entradas por duas vias independentes:

| Via                      | O que gera lançamento                                                                                                                                | Origem no livro                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Formal (antes da Fase 1) | recebimento de compra **exclusiva** da OS (estorno compensa); saída de estoque comum para a OS (devolução compensa); transferência de sobra entre OS | `COMPRA_EXCLUSIVA`, `ESTORNO_COMPRA`, `SAIDA_ESTOQUE`, `DEVOLUCAO_ESTOQUE`, `SOBRA_SAIDA`, `SOBRA_ENTRADA` |
| Lista simples (Fase 1)   | linha "comprada" com custo informado; mudanças entram por compensação                                                                                | `MATERIAL_OS`                                                                                              |
| Manual (antes da Fase 1) | lançamento do gestor no financeiro                                                                                                                   | `AJUSTE_MANUAL`                                                                                            |

Problemas que a versão `8f89832` ainda tinha:

1. **Dupla contagem possível e não resolvível.** O mesmo tecido comprado pelo fluxo formal e
   anotado com custo na lista da OS entrava duas vezes. Havia só um aviso genérico, sem nenhuma
   forma de dizer "é o mesmo" ou "é outro".
2. **Previsão também duplicava.** A previsão somava o custo informado à previsão formal.
3. **O aviso ignorava compra confirmada ainda não recebida.** Sem lançamento formal no livro, nada
   avisava, mas a duplicidade apareceria no recebimento.

### 1.2 Mecanismo implementado: conciliação explícita [TESTADO]

**Quando uma linha fica PENDENTE.** É a linha da lista com custo informado, numa OS que também tem
custo formal (item de compra exclusiva em pedido ativo ou lançamento formal positivo de compra,
estoque ou sobra).

- **Nada é deduzido por valores ou nomes iguais.** Valores idênticos continuam pendentes (há teste
  específico).
- **Pendente continua contando.** Nenhum custo some do resultado. O resultado e a aba Materiais
  mostram a quantidade de linhas e o valor realizado em risco: "Conciliação pendente…".

**Quem decide.** O financeiro, com `financeiro.ver` + `financeiro.gerenciar`, na própria linha da aba
Materiais da OS:

- **VINCULADO** a um registro formal **específico** da mesma OS (item de compra ou lançamento do
  livro). É o mesmo material: o custo informado deixa de contar, por **lançamento compensatório**
  novo, e a previsão também o exclui. O valor informado continua visível como histórico.
- **DISTINTO.** É outro material: o custo continua contando, sem aviso.
- **Desfazer** volta a linha para pendente. O livro recebe a diferença; nada é apagado.

**Salvaguardas:**

- Registro de outra OS, pedido inativo ou formato inválido é recusado (422/400).
- Versão desatualizada é recusada (409).
- Repetir a mesma decisão não grava nada.
- Toda decisão é auditada (`service_order.material_list_reconciled`).
- Vínculo com item de um pedido que deixou de estar ativo (ex.: cancelado) **deixa de valer
  sozinho**. A linha volta a pendente e o custo informado volta a contar.
- Vínculo com compra que depois teve **estorno de recebimento**: nada muda sozinho, porque o estorno
  pode ser parcial e o vínculo continuar certo. O resultado mostra "Conciliação a revisar".

**Lançamentos existentes nunca mudam.** O teste fotografa o livro e prova que as linhas anteriores
continuam idênticas, com apenas compensações novas no fim. O livro continua imutável por gatilho.

Nenhuma regra financeira existente mudou: o fluxo formal, o livro, as origens e os relatórios são
os mesmos. A migration ganhou 5 colunas na tabela nova da Fase 1, com CHECK de coerência e chaves
estrangeiras `RESTRICT`. A alteração foi feita na própria migration
`20270309000000_materiais_estoque_entrega`, que **nunca foi aplicada fora de bancos isolados**.
Assim, a homologação continua recebendo uma migration só.

Lançamentos manuais (`AJUSTE_MANUAL`) não entram na conciliação, porque são correções livres do
gestor e não registros de compra. Ver os riscos na seção 7.

## 2. Entrega direta [TESTADO]

| Exigência                                                 | Prova                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserva todos os efeitos financeiros da entrega anterior | Mesmo cenário pelos dois caminhos (logística completa × direta), com a mesma asserção: saldo "na entrega" vence hoje, mão de obra com regra "entrega concluída" passa a `LIBERADO`, resultado `delivered=true` com `completedAt` = momento da entrega, nenhuma conta a pagar |
| Sem cobranças ou comissões duplicadas                     | Três requisições simultâneas + repetição: 1 entrega, 1 cobrança, 1 mão de obra, mesma data de liberação; mais nenhum registro                                                                                                                                                |
| Não altera de novo peças já entregues                     | Sofá entregue pela logística, depois "Marcar como entregue": a direta leva **só** as poltronas. Sofá idêntico no banco (linha, etapa, eventos) e mão de obra do sofá idêntica                                                                                                |
| Impede entrega sem qualidade obrigatória                  | Inspeção pendente e inspeção reprovada: 422, nada gravado                                                                                                                                                                                                                    |
| Requisições simultâneas                                   | Trava da OS e das peças + índice único; testado com 2 e com 3 chamadas simultâneas                                                                                                                                                                                           |
| Não depende da logística                                  | Com o módulo desligado, a entrega direta funciona                                                                                                                                                                                                                            |
| Sem frete e fora do fechamento                            | Na rota real do custo de viagem (`PUT`): 422 "sem viagem". Fechamento semanal sem pendência para a direta, com controle positivo: uma viagem da logística sem custo vira pendência                                                                                           |

**Problemas encontrados nos meus próprios testes, corrigidos:**

- Uma asserção era sempre verdadeira (`… ?? true`). Virou `delivered === true` e
  `completedAt != null`.
- O teste do custo de viagem usava uma rota inexistente e passava por 404. Agora usa o `PUT` real e
  exige a recusa de negócio.

## 3. Instabilidade do `team-issues` [MEDIDO]

**Causa raiz.** O helper E2E `setPin` considerava o PIN salvo quando aparecia o texto "PIN do tablet
definido". Esse texto **já aparece** se o funcionário tinha PIN definido por outro spec. A navegação
seguinte (`/painel/dispositivos`) abortava o `PUT` ainda em andamento, e o tablet tentava o PIN novo
com o antigo valendo. Isoladamente, num banco novo, o texto só aparece depois da gravação, por isso
passava.

**Prova (sonda temporária, removida).** Com o `PUT` do PIN atrasado em 2 s:

| Helper    | Requisições pendentes ao retornar |
| --------- | --------------------------------- |
| antigo    | **1**                             |
| corrigido | **0**                             |

**Correção.** O helper passa a esperar a janela fechar e o aviso "PIN atualizado…". É mais estrito,
e nenhum teste foi afrouxado.

## 4. Compatibilidade com a versão ativa em homologação (`a7f4f93`) [MEDIDO]

| Verificação                                                                                          | Resultado                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suíte completa da API da **versão antiga** (`a7f4f93` + pasta da migration) sobre o schema da Fase 1 | **943 passaram, 1 falhou, 13 pulados** (957). A falha é a trava **estática** antiga `rodada4-travas-estruturais`: a lista de exceções dela não conhece as strings da migration nova. É verificação de arquivo, não de execução                                                                                                                                                                                        |
| Código antigo lendo e escrevendo um banco **com dados da Fase 1**                                    | Entrega direta (com saldo e mão de obra), três conciliações (vinculada, pendente, distinta), estoque simples com ajuste e rolo, e `logistica` e `materiais` desligados. Todas as leituras com 200; resultado das OS, data de conclusão, vencimento da cobrança e custo de material **idênticos**; o livro **não** foi alterado pelas leituras antigas; criou cliente, pedido, recebimento, OS e custo manual sem erro |
| Volta para a versão nova sobre o mesmo banco                                                         | 39 de 39 verificações. Lê o que a antiga escreveu e volta a respeitar os interruptores desligados pelo gestor                                                                                                                                                                                                                                                                                                         |
| Prisma da versão antiga **sem** a pasta da migration                                                 | `migrate status`: "up to date"; `migrate deploy`: nada a aplicar. O Prisma sozinho não bloqueia                                                                                                                                                                                                                                                                                                                       |
| Executor das VMs                                                                                     | `migration_verify` e `rollback_version` recusam banco com migration "desconhecida" da imagem (documentado em `docs/HOMOLOGACAO-AUTONOMIA-OPERACOES.md`)                                                                                                                                                                                                                                                               |
| Cadeia de migrations desde o legado (`scripts/test-evolution-migrations.sh`) com a migration final   | **passou**: aplica, reverte e reaplica idêntico; recusada sem mutação com dados da Fase 1; backup e restauração verificados                                                                                                                                                                                                                                                                                           |

**Conclusão: será necessária uma versão de retorno**, como na Fase 0:

- Ela é o código `a7f4f93` + a pasta `20270309000000_materiais_estoque_entrega` byte a byte idêntica
  (migration sha256 `fde31ad9…`; `.down.sql` sha256 `9a83de12…`).
- Foi montada e testada **localmente**, sem branch publicada nem imagem construída. Construí-la no
  Cloud Build exige sua autorização.

**Como a versão antiga se comporta com dados da Fase 1** (ressalvas do retorno):

1. **Interruptores.** Ela ignora `logistica` e `materiais` desligados: a logística e as travas de
   material **voltam a valer sozinhas**. Os registros do gestor ficam preservados e voltam a valer
   ao reinstalar a Fase 1.
2. **Fechamento semanal.** Uma entrega direta da semana aparece como pendência **bloqueante**
   "realizada sem custo informado". Saída pela tela existente: confirmar como gratuita.
3. **Custo de viagem.** Ela **aceita** custo de viagem numa entrega direta (HTTP 200 medido).
   Orientação: não lançar.
4. **Roteiro do dia.** A entrega direta aparece no roteiro, já concluída (só informativo).
5. **Lista de materiais, conciliação e estoque simples** ficam inertes e invisíveis.
   - O custo `MATERIAL_OS` (com as compensações) continua no livro, no resultado e nos relatórios,
     então os valores realizados são os mesmos.
   - A previsão antiga não soma os custos informados.
   - Não há aviso de conciliação pendente.
6. **Entregas** voltam a ser só pela logística, que fica ligada automaticamente.

## 5. Estratégia de retorno não destrutivo

Não depende de restaurar banco antigo.

1. **Preferencial: corrigir para frente.** O banco fica como está, e só a aplicação muda.
2. **Retorno da aplicação.** `rollback_version` para a **versão de retorno** (`a7f4f93` + pasta da
   migration).
   - Banco intocado; os dados da Fase 1 ficam preservados e inertes.
   - Aplicar as orientações das ressalvas 2 e 3.
   - Reinstalar a Fase 1 depois retoma tudo, inclusive as decisões dos interruptores e da
     conciliação, como medido.
3. **Remover o schema da Fase 1 (`.down.sql`).** Só se nenhum dado da Fase 1 tiver sido gravado: o
   script **recusa**, de forma atômica, se houver qualquer registro.
4. **Restauração do ponto de recuperação.** Último recurso: perde o que foi gravado depois dele.

## 6. Espaço em disco da homologação

### 6.1 Base

- **[MEDIDO na Fase 0].** Cada versão (api + web) aumentou o disco em **2,14 GiB**: de 9,659 GB para
  11,96 GB, e de 4,68 para 2,54 GiB livres.
- **[MEDIDO hoje].** Entre `a7f4f93` e a Fase 1 há **zero diferença** em `pnpm-lock.yaml`, nos
  `package.json` e no `Dockerfile`. O código muda em cerca de 6,2 mil linhas (algumas centenas de
  KB). Logo, o tamanho por versão fica igual, **~2,14 GiB [ESTIMADO]**.
- Não foi possível construir as imagens aqui: o `corepack` não acessa a rede de dentro do build
  local. Mudar o Dockerfile para isso falsearia a medida.

### 6.2 Regra do executor

`preparar-versao` exige `df --output=avail -BG / ≥ 3`. O `-BG` arredonda **para cima**: na prática,
passa com pouco mais de 2 GiB. Foi o que aconteceu na Fase 0, com 2,54 GiB.

### 6.3 Contas a partir de 4,67 GiB livres

| Cenário                                                                                                                           | Livre depois                                    | Situação                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baixar só a Fase 1                                                                                                                | ~2,53 GiB                                       | Passa no limite, só pelo arredondamento, como na Fase 0. **Sem folga** para logs, backup do ponto de recuperação e camadas temporárias do `docker pull` |
| Fase 1 + versão de retorno, ambas na VM                                                                                           | ~0,4 GiB                                        | **Não cabe**                                                                                                                                            |
| Recomendação mínima: limpar uma versão não protegida (~2,1 GiB) antes de preparar a Fase 1, com o retorno só no Artifact Registry | ~6,8 GiB → ~4,7 GiB após a Fase 1               | Para retornar, baixar o retorno deixaria ~2,5 GiB: passa                                                                                                |
| Retorno pronto na VM (troca imediata)                                                                                             | precisa de ~7,3 GiB livres antes (2 × 2,14 + 3) | Faltam ~2,6 GiB: duas versões não protegidas limpas, ou **aumento do disco de 20 GB**                                                                   |

As versões não protegidas são as do plano oficial `images_cleanup_plan`, que é somente leitura. Nada
foi limpo nem alterado; as duas opções exigem sua autorização.

## 7. Riscos financeiros remanescentes

1. **Conciliação depende de decisão humana.** Enquanto pendente, o custo informado conta, então
   pode haver custo a maior; nunca a menor. O resultado mostra o valor em risco.
2. **Vínculo com registro estornado.** Não muda sozinho, só pede revisão. Se ninguém revisar, um
   estorno parcial pode deixar o custo a menor nessa linha.
3. **Lançamento manual (`AJUSTE_MANUAL`) não entra na conciliação.** Se alguém lançar manualmente o
   mesmo material também informado na lista, o sistema não aponta.
4. **Entrega direta sem desfazer.** Correção só por suporte técnico; a proposta continua no relatório
   principal.
5. **Durante um retorno à versão antiga:** pendência de fechamento e aceitação de custo de viagem na
   entrega direta (seção 4), com orientação operacional.
6. **Tela de conciliação sem E2E.** Coberta pela API. O E2E cobre a lista de materiais, mas não o
   vínculo (o fluxo formal de compra pelo navegador é longo).

## 8. Commits desta revisão e resultados finais

Preenchido ao final (seção "Resultado da revisão").
