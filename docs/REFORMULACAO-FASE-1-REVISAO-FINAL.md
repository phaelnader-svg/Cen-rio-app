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

### 8.1 Commits (sobre `8f89832`)

| SHA                                   | Conteúdo                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `799b47d`                             | Conciliação explícita do custo de material, testes de efeitos financeiros da entrega direta e correção de uma asserção sempre verdadeira |
| `4696912`                             | E2E: `setPin` espera a gravação do PIN (causa do `team-issues`)                                                                          |
| `f03c42b`                             | Testes do custo de viagem e do fechamento com a rota real (a anterior passava por 404)                                                   |
| `f0c2866`                             | Aviso de revisão quando o registro formal vinculado teve estorno                                                                         |
| `e2d8676` e o commit deste fechamento | Documentação desta revisão                                                                                                               |

### 8.2 Resultados

Execuções completas, sem concorrência, na ponta `f0c2866`. Os commits seguintes são só de
documentação.

| Verificação                                                             | Resultado                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API, suíte completa                                                     | **972 passaram, 0 falharam, 13 pulados** (985; 82 arquivos passaram; 7 pulados são os opcionais pré-existentes de desempenho e proxy) |
| API, testes da Fase 1                                                   | 19 em `fase1-materiais-estoque-entrega` + 9 em `fase1-revisao-financeira`, todos passando (incluídos acima)                           |
| Pacote compartilhado                                                    | 150 de 150                                                                                                                            |
| Web (vitest)                                                            | 21 de 21                                                                                                                              |
| E2E completo (Playwright, sem novas tentativas)                         | **55 de 55** em 15,6 min, inclusive `team-issues` (lista abaixo)                                                                      |
| Cadeia de migrations desde o legado                                     | passou (código 0)                                                                                                                     |
| Suíte da versão antiga (`a7f4f93` + migration) sobre o schema da Fase 1 | 943 passaram, 1 falha estática esperada, 13 pulados (seção 4)                                                                         |
| Versão antiga com dados da Fase 1 / volta para a nova                   | todas as leituras e escritas OK, valores idênticos (seção 4); nova: 39 de 39                                                          |
| Lint, formatação, typecheck (5 pacotes), build                          | sem erros                                                                                                                             |

Lista integral do E2E:

| #   | Spec e cenário                                                                                                                                                                                | Tempo |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | aa-fase1-materiais-estoque-entrega.spec.ts:21:1: materiais necessários: lista inline, flags independentes, custo e aviso                                                                      | 3.0s  |
| 2   | aa-fase1-materiais-estoque-entrega.spec.ts:67:1: estoque da oficina: categoria, material, ajuste com histórico e arquivamento                                                                 | 2.1s  |
| 3   | aa-fase1-materiais-estoque-entrega.spec.ts:105:1: logística desligada: menu sem roteiro e entrega pela OS; religar volta ao normal                                                            | 2.9s  |
| 4   | admin.spec.ts:6:3: Painel administrativo › rotas do painel exigem autenticação                                                                                                                | 545ms |
| 5   | admin.spec.ts:11:3: Painel administrativo › credenciais inválidas exibem erro sem revelar se o e-mail existe                                                                                  | 602ms |
| 6   | admin.spec.ts:19:3: Painel administrativo › gestor entra, navega e cadastra um funcionário                                                                                                    | 1.5s  |
| 7   | admin.spec.ts:62:3: Painel administrativo › validação no formulário de empresa e salvamento com versão                                                                                        | 1.4s  |
| 8   | cobranca.spec.ts:23:3: Cobrança do cliente › Novo serviço 50/50 → Financeiro do pedido → recebimento da entrada                                                                               | 2.5s  |
| 9   | commercial-flow.spec.ts:19:3: Fase 2 — cliente → pedido → retirada → recebimento → OS › fluxo completo, com bloqueio da OS antes do recebimento e histórico técnico                           | 6.0s  |
| 10  | commercial-flow.spec.ts:121:3: Fase 2 — cliente → pedido → retirada → recebimento → OS › outra sessão do painel vê o novo pedido em tempo real                                                | 2.5s  |
| 11  | compras-etapa2.spec.ts:59:3: Compras e materiais sem duplicidade — Etapa 2 › remedição substitui a necessidade (decisão na aprovação) e não soma                                              | 3.6s  |
| 12  | compras-etapa3.spec.ts:45:3: Compra antes da chegada — Etapa 3 › previsão no pedido → Pré-chegada → chegada → medição substitui                                                               | 3.4s  |
| 13  | compras-sem-duplicidade.spec.ts:60:3: Compras e materiais sem duplicidade › A comprar consolidado com estoque livre, Reservar explícito e recusa "Não repor"                                  | 5.8s  |
| 14  | fase0-funcionalidades.spec.ts:11:1: funcionalidades: desligar e religar os pedidos de ajuda pelo painel                                                                                       | 2.2s  |
| 15  | gestao.spec.ts:33:3: Gestão: Início, Central e ação no contexto › gestor vê, identifica a pendência, abre o contexto, age e a pendência some                                                  | 4.5s  |
| 16  | gestao.spec.ts:118:3: Gestão: Início, Central e ação no contexto › Início: total da Central, a planejar e bloqueios; menu e Recebimentos                                                      | 3.4s  |
| 17  | measurements.spec.ts:99:3: Fase 3 — medições e solicitações de materiais › gestor delega a Ricardo, tablet mede e envia, gestor devolve, Ricardo corrige, gestor aprova                       | 9.0s  |
| 18  | measurements.spec.ts:244:3: Fase 3 — medições e solicitações de materiais › rotina de sexta: o gestor mede pelo painel                                                                        | 2.9s  |
| 19  | modelos-simplificados.spec.ts:38:3: Simplificação Fase 5 — modelos simplificados › modelo de reforma com responsável por etapa e geração de 3 tarefas pelo planejamento                       | 2.8s  |
| 20  | novo-servico-rede.spec.ts:29:1: Novo serviço: resposta perdida depois da gravação não duplica (mesma chave)                                                                                   | 2.2s  |
| 21  | novo-servico.spec.ts:38:3: Simplificação Fase 2 — Novo serviço › cliente novo + serviço + retirada em um formulário; roteiro do André; OS na chegada                                          | 6.5s  |
| 22  | novo-servico.spec.ts:192:3: Simplificação Fase 2 — Novo serviço › cliente entrega na tapeçaria: sem retirada; o recebimento no painel gera a OS                                               | 2.2s  |
| 23  | novo-servico.spec.ts:227:3: Simplificação Fase 2 — Novo serviço › titular e mão de obra previstos no fechamento; alteração antes da chegada; OS nasce com eles                                | 3.1s  |
| 24  | novo-servico.spec.ts:286:3: Simplificação Fase 2 — Novo serviço › 390 px: preencher e salvar o Novo serviço no celular, sem rolagem horizontal                                                | 2.0s  |
| 25  | prazos.spec.ts:33:3: Prazos e serviços em risco › Início → Central filtrada → alterar prazo do pedido (SIM às OS) → contagens atualizadas                                                     | 5.2s  |
| 26  | pre-planejamento.spec.ts:99:3: Simplificação Fase 4 — pré-planejamento › recebido → A planejar → Ricardo/Márcio → publicar semana → tablets                                                   | 14.1s |
| 27  | production.spec.ts:18:3: Fase 5 — motor de produção e planejamento semanal › gestor planeja e publica; João conclui a preparação e libera a tarefa do Márcio em tempo real                    | 15.9s |
| 28  | purchasing.spec.ts:38:3: Fase 4 — compras, recebimento e estoque › medição até prontidão completa, com recebimento pelo tablet e sem iniciar produção                                         | 11.9s |
| 29  | recebimentos-rede.spec.ts:27:1: queda de rede depois do envio: nova tentativa usa a mesma chave e nada duplica                                                                                | 4.0s  |
| 30  | recebimentos-rede.spec.ts:133:1: resposta perdida com o tempo real ativo: aviso some, mensagem aprovada, nada reenviado sozinho                                                               | 5.5s  |
| 31  | recebimentos-rede.spec.ts:207:1: aviso some sem resposta perdida neste tablet: texto neutro, sem atribuir a outro aparelho                                                                    | 3.8s  |
| 32  | recebimentos.spec.ts:47:3: Simplificação Fase 3 — Aguardando chegada › dois tablets: chegada parcial, aviso de atualização, materiais e conferência                                           | 9.4s  |
| 33  | rodada2-central.spec.ts:34:3: Rodada 2 — Central derivada, Meus Ganhos ao vivo e indicadores › valor muda → celular atualiza sozinho; Central: confirmação → pagamento; links; Início; avisos | 8.2s  |
| 34  | tablet-sync.spec.ts:5:3: Tablets, sessões e sincronização › vinculação, login por PIN, sessão persistente e atualização em tempo real                                                         | 5.1s  |
| 35  | tablet-sync.spec.ts:50:3: Tablets, sessões e sincronização › sinais de sincronização e reconciliação após queda de conexão                                                                    | 7.5s  |
| 36  | tablet-sync.spec.ts:127:3: Tablets, sessões e sincronização › revogação remota de sessão e de dispositivo                                                                                     | 4.6s  |
| 37  | tablets.spec.ts:44:3: Fase 6 — interface operacional dos tablets › Meu dia, execução simplificada, avisos, reprogramação e queda de conexão                                                   | 12.2s |
| 38  | team-closing.spec.ts:46:3: Evolução Fase 7 — fechamento semanal geral › conferir, registrar Pix, reabrir, estornar; celular; sem acesso para tablets e logística                              | 18.0s |
| 39  | team-distribution.spec.ts:40:3: Evolução Fase 3 — distribuição automática › titular por peça, geração sem distribuição manual, substituição auditada e fila do titular                        | 12.3s |
| 40  | team-finance.spec.ts:32:3: Fase 11 — financeiro operacional › cobrança, recebimento parcial, valor de produção, despesa, painel e "Meus valores" no tablet                                    | 15.3s |
| 41  | team-help.spec.ts:59:3: Fase 8 — ajuda e reprogramação › pedido normal, apoio no tablet, urgente escalado e aprovação do gestor                                                               | 25.8s |
| 42  | team-issues.spec.ts:63:3: Fase 9 — central de atenção e ocorrências › Márcio registra o problema, gestor delega ao Thiago, verifica e Márcio retoma                                           | 18.3s |
| 43  | team-labor.spec.ts:45:3: Evolução Fase 5 — mão de obra dos tapeceiros › valor por peça na OS, substituição com revisão, resolução e "Meus valores" com PIN                                    | 12.3s |
| 44  | team-logistics.spec.ts:41:3: Evolução Fase 6 — custos de retirada e entrega › padrões → agendar com custo total → realizar → obrigação única → pagar, estornar, ajustar, conciliar            | 8.8s  |
| 45  | team-negociacao.spec.ts:37:3: R2 — negociação, confirmação semanal e portão de pagamento › pedido no celular → aprovação → sem confirmação recusado → André confere → Pix                     | 9.2s  |
| 46  | team-presenca-apoio.spec.ts:40:3: Simplificação Fase 7 — presença e apoio › expediente esquecido, feriado, férias por intervalo e tablet sem pontualidade                                     | 8.2s  |
| 47  | team-presence.spec.ts:62:3: Fase 7 — presença operacional › Cheguei, ausência presumida com impacto, correção, chegada tardia e encerramento                                                  | 13.3s |
| 48  | team-quality.spec.ts:75:3: Fase 10 — qualidade, embalagem e entrega › produção → reprovação → correção → aprovação → embalagem → agenda → entrega                                             | 33.4s |
| 49  | team-queue.spec.ts:46:3: Evolução Fase 2 — fila semanal › publica sem horário, tablet segue a fila, início explícito e continuidade em dois dias                                              | 15.7s |
| 50  | team-route-os.spec.ts:66:3: Correção global — OS completa e roteiro da logística › OS com titular e mão de obra; retirada com chegada; roteiro reordenado; celular do André                   | 6.6s  |
| 51  | team-week.spec.ts:49:3: Evolução Fase 4 — Minha semana › gestor + 4 tablets: destaque, próximas, fila completa, titular, bloqueio, reordenação, reconexão e virada do dia                     | 14.3s |
| 52  | team-workshop.spec.ts:56:3: Fase 12 — painel + quatro tablets simultâneos › chegada, início simultâneo, queda de conexão, prioridade e inspeção em tempo real                                 | 22.8s |
| 53  | zz-fluxo-transversal.spec.ts:146:3: Rodada 4 — fluxo transversal completo › do Novo serviço ao pagamento, com D12/D13, privacidade e Central                                                  | 43.0s |
| 54  | zz-geometria.spec.ts:136:3: Interface — geometria dos formulários › todas as telas e formulários em diálogo, em 390/768/1280/1440                                                             | 5.1m  |
| 55  | zz-visual-audit.spec.ts:97:3: Fase 12 — auditoria visual › todas as telas do painel e do tablet, em desktop, tablet e celular                                                                 | 2.6m  |

## 9. Veredito

**GO COM RESSALVAS para implantar em homologação**, somente após sua autorização. Condições:

1. **Disco** (seção 6). Antes de `prepare_version` da Fase 1, liberar ~2,1 GiB pela limpeza oficial
   de uma versão não protegida, ou aumentar o disco. Sem isso, a Fase 1 entra só no limite do
   arredondamento e o retorno não cabe. Exige autorização sua.
2. **Versão de retorno** (seção 4). Construir no Cloud Build `a7f4f93` + a pasta da migration
   (byte a byte idêntica) **antes** de implantar a Fase 1, e mantê-la no Artifact Registry.
   Exige autorização.
3. **Orientações para um eventual retorno:** confirmar entregas diretas da semana como gratuitas no
   fechamento e não lançar custo de viagem nelas.
4. **Riscos financeiros aceitos** (seção 7): conciliação depende de decisão humana; pendente conta a
   maior, nunca a menor.

Nada foi implantado, mesclado, migrado fora de banco isolado, limpo ou alterado em infraestrutura.
