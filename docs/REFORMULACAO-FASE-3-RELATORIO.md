# Reformulação — Fase 3: relatório técnico

Tudo foi feito **somente no ambiente de desenvolvimento isolado** (PostgreSQL 16 local e
descartável, navegador local). Nenhum deploy, merge, migration em ambiente compartilhado ou
alteração da homologação (ativa `3e0d2d0`, candidata `de31aa7`), do branch padrão ou da produção.
A Fase 4 **não** foi iniciada.

- Branch: `claude/reformulacao-fase-3` (derivada de `dcae84f`, Fase 2 aprovada).
- Commit final: ver a seção 10.
- Legenda: **[TESTADO]** coberto por teste que passou · **[MEDIDO]** observado em execução isolada
  · **[INSPECIONADO]** verificado por leitura de código ou captura · **[NÃO TESTADO]**.

## 1. Escopo e entregas

| #   | Escopo                                | Entrega                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Qualidade simplificada                | **"Tudo conforme — aprovar"**: marca como conformes os itens ainda não conferidos e aprova numa transação; recusa se houver item não conforme (aí é reprovação). **D4**: o gestor (`qualidade.gerenciar`) aprova a própria execução **só com justificativa** (mín. 10 caracteres), gravada com identidade e data; auditoria própria **destacada** (`quality.inspection_self_approved`, filtro "Exceções destacadas"). Demais executores seguem sem decidir. Reprovar e gerar correção, iguais. |
| 2   | Embalagem opcional                    | Interruptor "Embalagem obrigatória" da Fase 0 passou a ser configurável. Desligado, a peça aprovada fica **pronta para entrega** sem embalagem. A exigência é **gravada na aprovação** (`packaging_required`): ligar/desligar depois não muda o que já foi decidido; embalagens abertas continuam. Ligado, fluxo de sempre.                                                                                                                                                                    |
| 3   | Programação semanal unificada         | "Produção — A planejar" e "Planejamento de produção" viraram **uma tela** ("Programação semanal": abas Serviços e Semana detalhada) com **um único diálogo de publicação** (prévia + observação). Regras de prioridade, responsáveis e datas são as do servidor (sem mudança). Endereços antigos abrem a aba correspondente; notificações antigas continuam válidas.                                                                                                                           |
| 4   | Estados visíveis                      | Selo único do estado geral (regra da Fase 0) na lista de OS, no pedido, no histórico do cliente e no cabeçalho da OS, calculado em lote pela **mesma** regra. "Aberta" deixou de aparecer ao lado de "Entregue" (o status gravado no banco não muda).                                                                                                                                                                                                                                          |
| 5   | Menu simplificado                     | Área Produção de **11 para 8** itens. Saíram do menu (páginas, rotas e permissões preservadas): "Planejamento de sexta" (link em Medições), "Competências da equipe" (link na Programação semanal) e as duas telas de planejamento (substituídas pela Programação semanal).                                                                                                                                                                                                                    |
| 6   | Reversão controlada da entrega direta | **Implementada** após aprovação específica (seção 3.6): só a última entrega direta, em até 7 dias, `entregas.gerenciar` + `financeiro.gerenciar`, justificativa, prévia, histórico preservado, auditoria destacada; bloqueios financeiros e operacionais; transação atômica com revalidação.                                                                                                                                                                                                   |

## 2. Arquivos e migration

**Migration aditiva** `20270323000000_reformulacao_fase_3` (sha256 `1bbfc4f6…`), reversão
`packages/db/rollback/20270323000000_reformulacao_fase_3.down.sql` (sha256 `f78fec5a…`):

- `quality_inspections.self_approval_reason` (anulável) + CHECK (só em inspeção aprovada, ≥ 10
  caracteres úteis);
- `quality_inspections.packaging_required` (padrão `true`: inspeções existentes mantêm o
  comportamento de sempre).

Nenhuma linha existente muda; nada é removido. As migrations das Fases 1 e 2 não mudaram.

Código (58 arquivos em relação a `dcae84f`), principais: `quality/inspections.ts` (aprovação),
`quality/common.ts` (prontidão/etapa com embalagem dispensada), `shared/quality-domain.ts` (regra
de decisão, "Tudo conforme", prontidão), `shared/modules.ts` (embalagem configurável),
`audit/routes.ts` + `admin/audit-page.tsx` (destaque), `tablet/quality.tsx` (tela da inspeção, usada
no painel e no tablet), `production/weekly-schedule-page.tsx` + `publish-week-dialog.tsx`,
`service-orders/operational.ts` (estado em lote), `commercial/os-state.tsx` (selo único), menu.

## 3. Pontos de atenção

### 3.1 Autoaprovação do gestor (D4) [TESTADO]

- Sem justificativa ou com menos de 10 caracteres: recusada, nada gravado.
- Com justificativa: inspeção aprovada; `decided_by`, `decided_at` e `self_approval_reason`
  gravados; dois registros de auditoria (a aprovação e a **exceção destacada**, com o nome, a
  peça e a justificativa no resumo); a auditoria filtra só as exceções.
- Executor que não é gestor: recusado mesmo com justificativa. Inspetor designado que não executou:
  decide sem marca de autoaprovação. Designar a si mesmo como inspetor continua recusado.
- Regra alterada de propósito (D4): o teste antigo "4b. D8 — nem o gestor" foi **reescrito** para a
  regra nova (o gestor executor decide, mas a aprovação exige justificativa); o restante dele
  (designação recusada, inspetor designado decide) foi mantido.
- Decisão de desenho: o gestor que executou **pode reprovar** a própria peça sem justificativa
  (reprovar não é conflito de interesse). Se preferir manter a reprovação bloqueada, é uma linha.

### 3.2 Embalagem e efeitos financeiros [TESTADO]

Com a embalagem desligada, provado por teste:

- a peça aprovada vai a **pronta para entrega**, sem registro de embalagem; o aviso "pronta para
  entrega" continua saindo (uma vez por aprovação);
- **mão de obra**: a regra "aprovada na qualidade" libera na aprovação (como já liberava antes da
  embalagem); a regra "entregue ao cliente" **continua prevista** até a entrega — nada é liberado
  antes;
- **cobrança** com vencimento na entrega continua "aguardando entrega" até a entrega efetiva;
- **entrega direta** passa a ser elegível quando todas as peças estão aprovadas, sem a pendência
  "embalagem concluída"; a peça ainda não inspecionada **não** lista mais "embalagem" como pendência
  (antes listaria, por engano — corrigido);
- **prazos** seguem a etapa da peça (mesma regra).

Mudar o interruptor depois não altera o já decidido (embalagem aberta continua exigida; peça
aprovada sem embalagem continua pronta). Quem não tem `empresa.configurar` não muda o interruptor.

### 3.3 Programação semanal [TESTADO]

As E2E de produção, pré-planejamento, fila semanal, distribuição e modelos continuam passando
pela tela nova (endereços antigos), publicando pelo diálogo único. A regra de publicação não
mudou: publica as tarefas em rascunho do plano (a condição do botão é a mesma de antes).

### 3.4 Estados [TESTADO + INSPECIONADO]

O mesmo cálculo (`loadOperationalStates`) serve a lista de OS, o pedido, o cliente e o cabeçalho;
a E2E confere que o selo da lista é igual ao estado do cabeçalho. Nenhum estado gravado no banco
foi alterado (o cálculo é só leitura).

### 3.6 Desfazer a entrega direta (D5) [TESTADO]

Regra aprovada: `docs/REFORMULACAO-FASE-3-REGRA-REVERSAO-ENTREGA.md`, com as condições da
aprovação. Implementação: `apps/api/src/modules/quality/direct-delivery-revert.ts` (prévia e
confirmação usam a **mesma** análise), tela "Desfazer entrega" na aba Qualidade e entrega da OS.

- **Quem e o quê:** só a última entrega direta não desfeita da OS; até 7 dias da confirmação;
  `entregas.gerenciar` **e** `financeiro.gerenciar` (painel); justificativa de 10 a 500
  caracteres; prévia com peças, mão de obra que volta a prevista, cobranças que voltam a
  "aguardando entrega" e prazo que reabre (ou a lista de bloqueios).
- **Bloqueios (recusa sem gravar nada):** mão de obra "entregue ao cliente" das peças com qualquer
  pagamento; semana do fechamento **conferida** (a da liberação ou de mudança de valor posterior);
  cobrança com vencimento na entrega com recebimento registrado a partir do dia da entrega
  (recebimento **estornado** não conta — o dinheiro não ficou); entrega posterior, devolução,
  cancelamento da OS ou alteração técnica depois da entrega; prazo de 7 dias vencido.
- **O que grava (aditivo):** a entrega continua `CONCLUIDA` e é marcada como desfeita (quem,
  quando, justificativa); itens `NAO_ENTREGUE` e inativos; evento `ENTREGA_DIRETA_DESFEITA` no
  histórico da entrega; peças voltam à localização anterior (ou expedição) e a "pronta para
  entrega" pelo recálculo de sempre; mão de obra "na entrega" volta a prevista **sem competência**
  (a data de liberação é limpa — senão o fechamento ainda a contaria); auditoria destacada
  `delivery.direct_reverted` com os efeitos. Outras obrigações, pagamentos, recebimentos e custos
  não são tocados.
- **Proteções:** uma transação; travas OS → entrega → peças (mesma ordem da entrega direta);
  revalidação completa depois das travas; recusa se a entrega da prévia não for mais a última;
  rota idempotente; repetição devolve "já desfeita".
- **Ajuste encontrado:** a data de conclusão da OS (resultado financeiro) passou a contar só itens
  efetivamente entregues.
- **Testes (8 de API + E2E):** fluxo completo com nova entrega e nova reversão (múltiplas
  entregas); permissões (só uma das duas permissões = 403); bloqueios por recebimento após a
  entrega (e liberação após o estorno), semana conferida e pagamento parcial, cada um sem alterar
  nada; prazo, alteração técnica e devolução; entrega parcial (a entrega anterior da logística
  fica intacta); concorrência (duas confirmações simultâneas = uma reversão) e idempotência; falha
  simulada no meio = nada alterado; E2E pela tela (prévia, justificativa, histórico na entrega).

Qualidade (decisão da aprovação): o gestor que executou **reprova** a própria peça sem
justificativa, com a reprovação registrada na auditoria (testado); aprovar a própria execução
continua exigindo justificativa de no mínimo 10 caracteres.

### 3.5 Menu [TESTADO]

Teste do menu atualizado: área Produção com 8 links na ordem esperada e as 4 páginas retiradas do
menu continuam existindo; E2E confirma que abrem pelo endereço.

## 4. Testes

| Suíte                                                | Resultado                                                                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared                                               | **151 passaram**, 0 falharam                                                                                                                                                                                                           |
| web (unitários)                                      | **22 passaram**, 0 falharam                                                                                                                                                                                                            |
| API, suíte completa                                  | **1000 passaram, 0 falharam, 13 pulados** (após a reversão: 999 + a trava estrutural ajustada para a chave nova; os 13 são os opcionais pré-existentes)                                                                                |
| E2E de navegador, suíte completa                     | **66 passaram, 0 falharam, 0 pulados** (rodada final, com a E2E da reversão; 18,9 min) — ver 10.1 sobre as rodadas anteriores                                                                                                          |
| Lint, typecheck, formatação, build                   | **sem erros nem avisos**; build do web ok                                                                                                                                                                                              |
| Cadeia completa de migrations                        | **passou**: aplica sobre o legado com dados idênticos; reverte (a da Fase 3 primeiro) e reaplica idêntico; com dados novos recusa cada reversão de forma atômica — Fase 3: "2 registro(s) da Fase 3"; backup e restauração verificados |
| Compatibilidade `3e0d2d0` no schema novo (Fases 2+3) | **971 passaram, 1 falha estática esperada, 13 pulados** — a mesma trava de leitura de arquivo das Fases 1 e 2 (não conhece as cláusulas `ON UPDATE CASCADE` da migration da Fase 2); nenhum teste de execução falhou                   |

Testes novos: API `fase3-qualidade-embalagem` (6), shared (regra D4 e "Tudo conforme"); E2E
`zz-fase3-qualidade-programacao` (2) e `zz-fase3-capturas`; etapa de escrita da Fase 3 no
`evolution-migration.check`. Testes alterados para regras novas aprovadas (não enfraquecidos):
`quality.test` 4b (D4), `modules.test` e `fase0-modulos-ajuda` (embalagem configurável),
`fase0-funcionalidades` E2E (interruptor da embalagem habilitado), `rodada4-menu` (menu novo).

## 5. Migrations e recuperação

- A reversão `.down.sql` **recusa** se existir autoaprovação justificada ou inspeção aprovada sem
  embalagem (o código anterior voltaria a exigir uma embalagem que nunca foi criada).
- Recuperação sem perda: como nas fases anteriores, volta só a aplicação (versão de retorno =
  código anterior + pasta desta migration); o banco não volta.
- **Ressalva do retorno**: peças aprovadas com a embalagem desligada e ainda **não entregues**
  apareceriam no código anterior como "aguardando embalagem", sem registro de embalagem. Antes de
  voltar a versão: conferir `SELECT count(*) FROM quality_inspections WHERE NOT packaging_required
AND status = 'APROVADA'` com peças não entregues e entregá-las (ou religar a embalagem) antes.

## 6. Capturas

`docs/evidencias/reformulacao-fase-3/{1440,390}/`: inspeção com autoaprovação (aberta e aprovada),
programação semanal (Serviços e Semana detalhada), lista de OS com estado, cabeçalho da OS,
funcionalidades da empresa e auditoria com exceção destacada. O E2E das capturas confere ausência
de rolagem horizontal e de erro de página. Observação (anterior à Fase 3): na "Semana detalhada"
em 390 px, a tabela de tarefas rola dentro do cartão e o placeholder do campo de motivo fica
cortado — o mesmo da tela antiga de planejamento; não alterado.

## 7. Ressalvas da Fase 2 (continuam abertas, sem evidência nova)

1. Migração futura das fotos antigas (com backup e autorização).
2. Medição do consumo de CPU do tratamento de imagens na VM.
3. Construção da versão de retorno integrada.
4. Validação funcional completa em homologação.

## 8. Riscos da Fase 3

1. Retorno de versão com peças aprovadas sem embalagem e não entregues (seção 5).
2. A autoaprovação é uma exceção de controle: depende do uso consciente do gestor; a auditoria
   destacada é o controle compensatório.
3. A reversão da entrega direta (item 6) continua **não implementada** até a aprovação da regra.

## 9. Pendências

- Aprovação da regra de reversão da entrega direta (D5) para implementar.
- D6 e D7 ficam para a Fase 4, conforme o plano.

## 10. Resultado final

- **Branch:** `claude/reformulacao-fase-3`. **Commit final:** o commit que contém esta versão do
  relatório (informado no encerramento).
- **Totais (rodada final, com a reversão):** shared 151/151 · web 22/22 · API 1000 passaram, 0
  falharam, 13 pulados · E2E 66/66 · lint, typecheck, formatação e build sem erros.
- **Migrations:** cadeia completa aprovada (aplica, reverte, reaplica idêntico; recusa atômica com
  dados de cada fase, inclusive da Fase 3; backup e restauração).
- **Compatibilidade:** `3e0d2d0` + pastas das migrations das Fases 2 e 3: 971 passaram, 1 falha
  estática esperada (leitura de arquivo, não execução), 13 pulados.
- **Ambientes:** homologação (ativa `3e0d2d0`, candidata `de31aa7`), branch padrão
  (`claude/cenario-gestao-fase-1-zf3bj2`) e produção **não foram alterados**; nenhum deploy,
  migration compartilhada, build em nuvem ou chamada ao executor de homologação.

### 10.1 Rodadas anteriores da E2E (falhas investigadas)

1. 1ª rodada completa: `production.spec` falhou porque o novo E2E da Fase 3 criava o plano da
   semana atual antes dele (dependência de ordem entre specs); o spec novo passou a rodar no fim
   (`zz-`). Nenhuma mudança na aplicação.
2. 2ª rodada (interrompida por reinício do contêiner) e 3ª rodada: os dois specs novos da Fase 3
   procuravam o funcionário "Ricardo", que outro spec altera na suíte completa; passaram a usar
   qualquer tapeceiro ativo. Nenhuma mudança na aplicação.
3. `measurements.spec` falhou uma vez (tela de login no meio do teste) e **não se repetiu** nas duas
   rodadas completas seguintes nem isoladamente — registrado como instabilidade pontual do E2E.

**Veredito: GO COM RESSALVAS** para aprovação técnica da Fase 3 (itens 1 a 6). Ressalvas:

1. A reversão da entrega direta é uma exceção financeira controlada: depende das permissões e
   da auditoria destacada; foi validada só em ambiente isolado.
2. Retorno de versão exige tratar antes as peças aprovadas sem embalagem e não entregues (seção 5).
3. As ressalvas da Fase 2 continuam abertas (seção 7).
4. Validação funcional integrada só na homologação final.

Fase 3 validada (itens 1 a 6). Conforme a autorização, a Fase 4 começa a partir deste commit.
