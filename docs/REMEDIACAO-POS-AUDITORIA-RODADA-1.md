# Remediação pós-auditoria — Rodada 1 (integridade operacional e financeira)

Base: `AUDITORIA-RASTREABILIDADE-10-FASES-9fb1786` (284 requisitos). Escopo fechado: **F2-08, F3-17,
F8-11 (+F8-03/F8-06 avaliados), F9-03 (+F9-06), F10-15**. Nada mais da auditoria foi alterado.
Produção fora do escopo: nenhum acesso, deploy, migration ou dado de produção.

**Nenhuma migration nova.** Nenhuma migration histórica foi tocada.

---

## A. F2-08 — idempotência do "Novo serviço" na tela

**Problema.** Em qualquer erro, a tela trocava a chave de idempotência (`onError: idem.current =
newIdempotencyKey()`). Se o servidor gravou e a resposta se perdeu, a nova tentativa ia com chave
nova: segundo pedido, segunda retirada, segundo conjunto de cobranças.

**Causa raiz.** A tela tratava "resultado desconhecido" (falha de rede) igual a "recusado".

**Solução** (`apps/web/components/commercial/new-service-page.tsx`), sem mudar o backend e sem
segunda fonte de idempotência:

- **Falha de rede** (`NETWORK_ERROR`): mantém a MESMA chave e mostra "Não foi possível confirmar se
  o serviço foi salvo. Toque em salvar de novo sem alterar nada: se ele já foi registrado, o sistema
  mostra o mesmo serviço e não cria outro." _(texto novo; o do tablet de chegadas não foi alterado)_.
- **Erro respondido pelo servidor** (400/409/422 de negócio): a chave continua. É seguro porque
  `plugins/idempotency.ts` apaga o registro da chave em toda resposta de erro.
- **Mesma chave com dados alterados** (422 `IDEMPOTENCY_CONFLICT`): não cria nada. A tela avisa que
  o envio anterior pode ter sido registrado. Uma chave nova só é gerada se a pessoa escolher, de
  forma deliberada, **"Registrar como outro serviço"**.
- **Sucesso:** a confirmação mostra o serviço. "Novo serviço" recarrega a tela, o que gera chave
  nova.

**Risco residual (backend, fora do escopo).** Se o processo cair depois do commit e antes de gravar a
resposta da chave, o registro "em processamento" expira em 2 min e a repetição re-executa. Esse
caminho não foi alterado.

## B. F3-17 — chegada física × conferência técnica × liberação

### Regra atual reconstruída (antes)

- Tablet "Chegou" (`POST /arrivals/purchase-orders/:id/confirm`):
  - metros/m² → `MaterialArrival` (`PENDENTE_CONFERENCIA`), sem estoque;
  - **todo o resto** → `registerMaterialReceipt` com `specConfirmed: true` **automático**, inclusive
    espuma comprada exclusivamente para a OS. Ou seja, conferência presumida sem ninguém conferir.
- Painel/tablet "Recebimento de materiais" (`POST /material-receipts`): cada linha aceita exige a
  marcação explícita "Conferi referência, cor e especificação" (`specConfirmed`).
- Disponibilidade:
  - estoque (`ESTOQUE`): `onHand` só com recebido conforme;
  - OS (`EXCLUSIVO_OS`): cobertura = `receivedQuantity` (só aceito), que alimenta a prontidão
    (`materialsReadiness`).

### Regra definida (D5 aplicada, mínima)

Regra única: `requiresTechnicalConference` em `packages/shared/src/measurements-domain.ts`.

|                                             | Regra                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(a) Exigem conferência técnica**          | Material controlado em metros/m² **ou** comprado exclusivamente para uma OS (`EXCLUSIVO_OS`: tecido, espuma etc. da peça do cliente)                                                                                                       |
| **(b) Aceitos por contagem**                | Material comum de estoque (`ESTOQUE`) contável (placa, peça, unidade, embalagem)                                                                                                                                                           |
| **(c) Quando entram no estoque**            | Estoque comum contável: na contagem da porta. Metros/m² de estoque: na conferência, com a medida real                                                                                                                                      |
| **(d) Quando ficam disponíveis**            | Contável de estoque: na contagem. Os de (a): só quando uma pessoa registra a conferência (`specConfirmed` explícito) pela chegada (`arrivalId`) ou no formulário completo de recebimento                                                   |
| **(e) Quando satisfazem a prontidão da OS** | Só a quantidade **aceita** na conferência entra em `receivedQuantity` / cobertura (regra existente, `requirementCoverage`)                                                                                                                 |
| **(f) Divergência e dano**                  | "Diferente"/"danificado" na porta: (a) fica na chegada com o problema registrado; estoque comum vai como recusado. Na conferência, recusado (`rejectedQuantity` + motivo) nunca fica disponível; aceitar exige a marcação da especificação |

### Mudança

- `arrivals/routes.ts`: no "Chegou", os itens de (a) contáveis passam a ser **chegada física**, como
  os metros. São registrados na própria unidade, nunca acima do que falta.
- `conference` no item da central de chegadas.
- Aviso no tablet e texto da conferência no painel.

Não há estoque paralelo. Também não há nova entidade nem migration: tudo reaproveita
`MaterialArrival`, `MaterialReceipt`, o estoque e as reservas existentes.

**Comportamento operacional que muda.** A espuma/peça exclusiva da OS conta na porta como antes, mas
só libera a OS depois da conferência. Enquanto a chegada aguarda conferência, o saldo do item fica
suspenso na central dos tablets, como já acontecia com os rolos de tecido. Depois da conferência, o
saldo volta como pedido − aceito.

**Quem faz o quê (decisão do proprietário).**

- **Recebimento físico** ("Chegou" na central compartilhada): qualquer funcionário autorizado pela
  regra existente — sem mudança.
- **Conferência técnica**: exige a permissão nova `estoque.conferir` ("Conferência técnica de
  material", grupo Compras e estoque, crítica), do modelo de permissões existente. O Gestor a tem
  por definição (catálogo completo); qualquer outra pessoa só com concessão explícita (função ou
  permissão individual) — nenhum nome fixo no código. Não houve migration: permissões são texto e
  o Gestor resolve o catálogo inteiro em código.
- A API recusa (403) a conferência de uma chegada (`arrivalId`) e qualquer linha de material de (a)
  — aceita ou recusada — de quem não tem a permissão. Material comum de estoque contável continua
  pelo formulário de recebimento para quem recebe, sem a permissão.
- Telas: "Conferir" fica desabilitado sem a permissão; no formulário de recebimento os itens de (a)
  aparecem travados com o aviso para registrar só a chegada.

## C. F8 — PREVISTO × DEVIDO em "Meus Ganhos"

- **F8-11 (corrigido, só rótulos).** A linha do item escrevia "devido" mesmo para previsto. Agora:
  - previsão → "previsto R$ X (ainda não é devido)";
  - item no fechamento (semana ou saldo anterior) → "devido R$ X · a receber R$ Y".

  Nada mudou na fonte, nas regras do DEVIDO, no fechamento ou no D13.

- **F8-03 (PARADO, documentado).** O recorte "previsto da semana" exigiria uma data de competência
  para o que ainda não foi liberado. Essa data não existe nas fontes canônicas:
  - `eligibleAt` só nasce na liberação;
  - o fechamento inclui de propósito toda previsão em qualquer semana (ressalva 5 do R1).

  Cortar só no "Meus Ganhos" faria a tela divergir do fechamento, cujos valores são os mesmos por
  regra. Cortar no fechamento muda o cálculo, o que é proibido. Fica para decisão: qual data define
  a semana de uma previsão.

- **F8-06 (PARADO, documentado).** Serviço executado sem obrigação lançada só apareceria lendo
  tarefas concluídas como "ganho", o que seria uma segunda fonte. Isso ainda mistura casos que por
  regra não geram valor:
  - APOIO_PROLONGADO sem ProductionPayable;
  - retrabalho sem pagamento automático.

  Exige regra nova do proprietário.

## D. F9-03 / F9-06 — versão e retrato da confirmação semanal

**Problema.**

- A confirmação gravava o retrato das linhas e o hash, mas não a versão do fechamento semanal.
- Não havia registro de quando uma confirmação deixou de valer.
- A API só devolvia a última confirmação.

**Solução sem migration.** A tabela é imutável por gatilho, então uma coluna `invalidated_at`
exigiria afrouxar o gatilho. O mecanismo existente, `financial_events`, é suficiente:

- **Versão.** O evento `CONFIRMADA` / `EXCECAO_ADMINISTRATIVA` da própria conferência passa a gravar
  `closingVersion` e `closingStatus` do fechamento do gestor no momento (null = semana ainda não
  conferida).
- **Estado exato.** O estado é identificado por três coisas juntas:
  - o retrato imutável das linhas (`items`);
  - o SHA-256 (`hash`);
  - a versão do fechamento.

  Uma semana conferida pelo gestor fica congelada: mudar exige reabrir, e reabrir sobe a versão.

- **Invalidação.** Quando uma nova conferência ou exceção é registrada, cada conferência anterior
  dessa pessoa e semana cujo retrato não confere mais ganha um evento `INVALIDADA`, uma única vez.
  O evento registra quando, por qual conferência e quais linhas mudaram. As linhas antigas ficam
  intactas.
- **Histórico.** `WeekConfirmationDto.history` (tablet e fechamento) traz todas as conferências da
  semana com:
  - versão do fechamento e hash;
  - status ao vivo: confirmação do profissional `VIGENTE` ou `INVALIDA` (regra integral abaixo);
    exceção administrativa `VIGENTE`, `EM_PARTE` ou `INVALIDA` (linha a linha, inalterada);
  - linhas alteradas;
  - `invalidatedAt` e `invalidatedBy`.

  O motivo interno de exceção nunca é exposto.

**Legado (sem backfill).**

- Conferências anteriores a esta rodada não têm `closingVersion` (null).
- Também não têm evento `INVALIDADA` até a próxima conferência da mesma pessoa e semana.

Nada foi recalculado ou inventado para o passado.

**Regra final D13 (decisão do proprietário, nesta rodada).** A confirmação do profissional vale
INTEIRA ou não vale: ela cobre pagamentos somente enquanto o seu retrato (hash) é exatamente o estado
atual das linhas devidas daquela pessoa naquela semana. Se qualquer item ou valor do retrato mudar —
ou um item novo entrar no fechamento da semana — a confirmação inteira fica inválida, inclusive para
as linhas que não mudaram. Pagamento direto, parcial, em lote e antecipação ficam bloqueados até uma
nova confirmação do estado atualizado. Pagamento já feito não faz parte da linha (pagar em parte
não invalida). A confirmação antiga permanece no histórico, marcada `INVALIDA`. A exceção
administrativa não foi alterada (continua cobrindo exatamente as linhas que o gestor liberou).

## E. F10-15 — contagens da Central

**Problema.** `counts` = `filtered.length` sobre fontes lidas com `take` 100/300 (subcontagem acima
do limite). O título "N chegada(s)" usava o tamanho da lista limitada.

**Solução.**

- As fontes da Central são lidas por inteiro, sem `take`. As contagens por categoria são feitas
  sobre todos os itens, com os filtros, a deduplicação entre fontes e as permissões, que continuam
  as mesmas.
- A **lista** devolvida continua limitada: `ATTENTION_LIST_LIMIT` = 300, com os mais urgentes
  primeiro. O campo novo `total` acompanha a lista, e a tela mostra "Mostrando os N mais urgentes
  de M".
- O cartão agregado de chegadas usa `count()` da fonte.

**Por que não `count()` em cada fonte.** As categorias e a inclusão de vários itens dependem de regras
calculadas em código:

- prazo pela regra única;
- risco de prazo da ocorrência;
- supressão de duplicatas entre fontes (tarefa com ocorrência aberta, tarefa de correção);
- filtros por funcionário, responsável, OS e data.

Reescrever essas regras em SQL criaria uma segunda cópia delas, com risco de divergir da lista.
A contagem sobre o conjunto completo é exata pela mesma regra da lista. O Início já usava
`count()`/`groupBy` e não mudou.

### Volume e desempenho (medido)

`apps/api/test/central-volume.test.ts` (na regressão: 100, 1 000 e 3 000 ocorrências abertas;
`CENTRAL_PERF=1` acrescenta 10 000), com cliente Prisma instrumentado, na mesma máquina dos testes:

| Ocorrências abertas | Total contado | Consultas SQL | Registros de topo carregados | Tempo da chamada |
| ------------------- | ------------- | ------------- | ---------------------------- | ---------------- |
| 100                 | 100           | 42            | 107                          | 144 ms           |
| 1 000               | 1 000         | 42            | 1 007                        | 339 ms           |
| 3 000               | 3 000         | 42            | 3 007                        | 805 ms           |
| 10 000              | 10 000        | 42            | 10 007                       | 5 027 ms         |

- Consultas: **constantes** (42), sem N+1 — o teste falha se mudar com o volume.
- Registros: **lineares** no número de exceções abertas (+7 fixos). Os `include` de cada linha
  (tarefa, OS, pessoas) aumentam o volume transferido por linha; o teste conta só o topo.
- Tempo: cresce mais que linearmente acima de alguns milhares (montagem e ordenação de todos os
  itens em memória a cada chamada; sem cache).

**Complexidade e risco.** O custo por chamada é O(E) leituras + O(E log E) ordenação, E = exceções
abertas de todas as fontes (não o histórico). Na operação esperada (dezenas a poucas centenas de
exceções abertas) fica bem abaixo de 1 s. O risco é uma fonte acumular milhares de exceções nunca
resolvidas (ex.: ocorrências abertas esquecidas): a Central fica lenta (≈5 s com 10 000).

**Dívida técnica concreta (não feita nesta rodada — refatoração maior).** Expor cada fonte como um
"provedor" único com duas operações sobre a MESMA regra de domínio — `count` agregado por categoria
(predicados SQL gerados da própria regra) e `list` limitado — ou materializar as exceções abertas
(tabela de projeção atualizada por evento). Gatilho para fazer: Central acima de ~1 s em homologação
ou mais de ~2 000 exceções abertas.

---

## Pendências da auditoria que continuam abertas

Todas as demais linhas não comprovadas da auditoria continuam como estavam (ver o relatório da
rodada). Desta rodada ficam explicitamente pendentes:

| Item   | Situação                                                                               |
| ------ | -------------------------------------------------------------------------------------- |
| F8-03  | Recorte semanal do previsto: sem fonte canônica, precisa de decisão                    |
| F8-06  | Serviços executados sem valor: precisa de regra nova                                   |
| F9-02  | Não existe `pin_verified` explícito (a rota exige o token D12)                         |
| F10-15 | Dívida de escala: contagem exata por leitura completa (ver "Volume e desempenho")      |
| F2-08  | Janela de queda do processo entre o commit e a gravação da resposta da chave (backend) |
