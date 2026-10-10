# Evolução Operacional — Fase 7: Fechamento semanal geral (tapeceiros + logística)

Branch `claude/cenario-gestao-fase-1-zf3bj2`. HEAD inicial **`05c0ae2`** (fim da Fase 6); HEAD final
informado na seção 14. Tudo executado **localmente**, com dados fictícios, em PostgreSQL 16 isolado
(contêiner local). **Não houve** deploy, acesso ao Google Cloud/homologação, migrations na nuvem,
publicação de imagens, DNS, Pix real, dados reais ou VerificaPro. A Fase 8 **não foi iniciada**.

---

## 1. Inventário (auditoria antes de codificar) e decisões

### 1.1 Fontes de verdade encontradas

| Valor                                    | Fonte de verdade (já existente)                                                                     | Pagamento / estorno                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Mão de obra (Ricardo, Márcio, …)         | `production_payables` — uma por **peça e profissional** (Fase 5; duas só após revisão resolvida)    | `professional_payments` (Fase 11/5). **Não havia estorno** → criado nesta fase |
| Logística (André)                        | `logistics_costs` DEVIDO + `account_payables` categoria LOGISTICA (Fase 6, uma por viagem)          | `payable_payments` + `payable_payment_reversals` (Fase 6)                      |
| Rateio por OS                            | `logistics_cost_allocations` (revisão corrente)                                                     | — (rateio é custo da OS, não obrigação)                                        |
| Revisões de titular                      | `labor_reviews` (Fase 5)                                                                            | —                                                                              |
| Fechamento / período / pagamento em lote | **Não existia.** Havia apenas os resumos semanais por módulo (`/labor-weekly`, `/logistics-weekly`) | —                                                                              |

### 1.2 Decisões

| #    | Decisão                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | **O fechamento é uma VISÃO** calculada sobre as fontes acima. Não há segundo livro-caixa nem obrigação consolidada. **Desvio consciente da proposta da Fase 1** (que previa uma conta a pagar semanal consolidada por profissional): ela duplicaria as obrigações por viagem da Fase 6 e por peça da Fase 5, e o item 5 desta fase proíbe criar novo payable/despesa. Nenhuma decisão financeira anterior foi alterada. |
| D-2  | **Competência:** semana = segunda 00:00 a domingo 23:59:59 **no fuso da oficina** (`company_settings.timezone`, America/Sao_Paulo). Um item entra na semana em que ficou **devido**: mão de obra pela liberação (`eligible_at`); logística pela realização/autorização (`due_at`); custo legado LANCADO (anterior à Fase 6) pela data do lançamento.                                                                    |
| D-3  | **Saldo anterior:** item devido antes da semana e ainda em aberto no início dela aparece como **saldo anterior identificado**, pelo valor em aberto naquele instante (nunca pelo valor cheio de novo).                                                                                                                                                                                                                  |
| D-4  | **Pagamentos contam pela data efetiva** (`paid_at`, data local): os da semana abatem a semana; os posteriores aparecem como “pago depois” e reduzem o saldo anterior da semana seguinte. **Pagamento estornado não conta em período algum** (o estorno fica no histórico).                                                                                                                                              |
| D-5  | Previsto (em execução/agendado), aguardando qualidade e em revisão são **situação atual** e **nunca** entram no pagável.                                                                                                                                                                                                                                                                                                |
| D-6  | **Pendências bloqueantes** da conferência: revisão de titular aberta, devido sem recebedor ativo (SEM_RECEBEDOR), viagem realizada sem custo informado e não confirmada como gratuita (CUSTO_NAO_INFORMADO), conta divergente do custo (DIVERGENCIA_CONTA). PECA_DEVOLVIDA é apenas aviso. Não se “congela” inconsistência.                                                                                             |
| D-7  | **Conferência** = retrato versionado (`weekly_closings`): autor, instante, versão, observação e snapshot dos devidos por item. Controle otimista por `version` + `pg_advisory_xact_lock` por semana. Mudança depois da conferência **não reescreve** o retrato: aparece como **divergência** listada.                                                                                                                   |
| D-8  | **Pix externo em lote** (`closing_payments`): só agrupa e rastreia. Cada parte chama a baixa **existente** (`payLabor` / `payPayable`) e liquida a **obrigação original**, da mais antiga para a mais nova (competência, código). Linhas travadas em ordem determinística e recalculadas após o bloqueio; excesso → 422; idempotency key obrigatória; nunca cria conta a pagar nem despesa.                             |
| D-9  | **Reabertura** exige `financeiro.ajustes` e motivo; pagamento/estorno continuam possíveis com a semana reaberta. Estorno de lote estorna cada baixa na obrigação original (com motivo), nunca apaga.                                                                                                                                                                                                                    |
| D-10 | **“Não informado” × “gratuita confirmada”:** viagem realizada sem custo é pendência; o gestor pode confirmar **gratuita** (`logistics_free_trips`, motivo obrigatório) — não cria débito; depois disso registrar custo é recusado.                                                                                                                                                                                      |
| D-11 | Nenhum dado bancário é armazenado: só método, data, valor, **referência opcional** (texto curto, ex.: id do comprovante) e observação.                                                                                                                                                                                                                                                                                  |
| D-12 | Lacuna fechada: `/logistics-costs/:id/constitute` aceitava tornar devido um custo PREVISTO por fora da realização; agora só aceita status DEVIDO (constituição da conta).                                                                                                                                                                                                                                               |

## 2. Arquitetura e schema

Migration **aditiva** `20261115000000_fechamento_semanal` (nenhuma coluna existente alterada):

| Tabela                           | Para quê                                                                                       | Proteções                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `weekly_closings`                | estado da semana (CONFERIDO/REABERTO), `version`, nota, motivo de reabertura, snapshot, totais | `week_start` único e **segunda-feira** (CHECK isodow=1); sem DELETE     |
| `weekly_closing_events`          | histórico (conferido, reaberto, pagamento, estorno) com autor e instante                       | somente inserção (trigger)                                              |
| `closing_payments`               | Pix/transferência externa agrupada (`PF-00001`), beneficiário, categoria, valor, data, método  | somente inserção; valor > 0; categoria válida                           |
| `closing_payment_parts`          | vínculo 1:1 com a baixa original (`professional_payment_id` **ou** `payable_payment_id`)       | exatamente uma fonte (CHECK); cada baixa só pertence a um lote (UNIQUE) |
| `closing_payment_reversals`      | estorno do lote (motivo)                                                                       | um por lote; somente inserção                                           |
| `professional_payment_reversals` | estorno de pagamento de produção (não existia)                                                 | um por pagamento; somente inserção                                      |
| `logistics_free_trips`           | viagem confirmada gratuita (retirada **ou** entrega) com motivo                                | uma por viagem; motivo ≥ 3 caracteres                                   |

Código: regras puras em `packages/shared/src/closing-domain.ts` (`closingWeekStart`,
`closingFigures`, `allocateClosingPayment`); serviço e rotas em
`apps/api/src/modules/finance/closing.ts`.

## 3. Rotas e telas

| Rota                                             | Permissão              | Observação                                                                  |
| ------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| `GET /api/v1/finance/weekly-closings`            | `financeiro.ver`       | semanas conferidas/reabertas                                                |
| `GET /api/v1/finance/weekly-closings/:weekStart` | `financeiro.ver`       | filtros `userId`, `category`, `status`; `?format=csv`; `no-store`           |
| `POST …/weekly-closings/:weekStart/confirm`      | `financeiro.gerenciar` | `version` + observação; recusa com pendência bloqueante                     |
| `POST …/weekly-closings/:weekStart/reopen`       | `financeiro.ajustes`   | `version` + motivo                                                          |
| `POST …/weekly-closings/:weekStart/payments`     | `financeiro.gerenciar` | idempotency key; 201; 422 se exceder o saldo                                |
| `POST …/closing-payments/:id/reverse`            | `financeiro.ajustes`   | motivo; 409 se já estornado                                                 |
| `POST …/labor/:id/payments/:paymentId/reverse`   | `financeiro.ajustes`   | estorno de pagamento de produção (IDOR: pagamento de outra obrigação → 404) |
| `POST …/trip-costs/free`                         | `financeiro.gerenciar` | confirma viagem gratuita (motivo)                                           |

Tela **Financeiro → Fechamento semanal** (`apps/web/components/finance/weekly-closing.tsx`):
semana (segunda) com navegação, filtros por tipo/situação/profissional, cartões de totais
(devido, pago na semana, saldo, saldo hoje, saldo anterior, previsto, aguardando, ajustes),
tabela por profissional e categoria com **Detalhar** (OS, peça, viagem, rateio, pagamentos,
estornos), pendências com ação, **Registrar Pix** com etapa de **revisão antes de confirmar**,
conferir/reabrir, pagamentos do lote com estorno, histórico e CSV. Estados vazio, carregando e erro;
BRL; período e critério escritos na tela.

## 4. Matriz de permissões (testada — #7 e E2E)

| Perfil                         | Ver fechamento | CSV | Conferir/pagar | Reabrir/estornar | Próprios valores           |
| ------------------------------ | -------------- | --- | -------------- | ---------------- | -------------------------- |
| Gestor (todas)                 | sim            | sim | sim            | sim              | —                          |
| `financeiro.ver`               | sim            | sim | **403**        | **403**          | —                          |
| `financeiro.ver` + `gerenciar` | sim            | sim | sim            | **403**          | —                          |
| Ricardo/Márcio (tablet, PIN)   | **403**        | 403 | 403            | 403              | sim (Meus valores, Fase 5) |
| André/Izaías (celular)         | **403**        | 403 | 403            | 403              | —                          |
| Painel sem financeiro          | **403**        | 403 | 403            | 403              | —                          |

Eventos em tempo real do fechamento vão só para a audiência do financeiro e **sem valores** no
payload; teste #7 confirma que os sockets de Ricardo e André não recebem nada do fechamento.

## 5. Critérios de aceite CA7-01..18

Evidências: `apps/api/test/closing.test.ts` (#1–#8), `packages/shared/test/closing.test.ts`,
`tests/e2e/specs/team-closing.spec.ts`, capturas em `docs/evidencias/evolucao-fase-7/`.

| CA     | Status   | Evidência executada                                                                                                                                                                       |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA7-01 | APROVADO | #1 (filtros por profissional, tipo, situação; semana inválida 400); E2E tela única com tapeçaria + logística; shared “semana segunda→domingo”; competência no fuso (#5)                   |
| CA7-02 | APROVADO | #1 (previsto fora do pagável), #2 (Exemplo C: previsto → aguardando → devido uma vez); shared “competência”                                                                               |
| CA7-03 | APROVADO | #1 (cada item com OS, peça, profissional; reconciliação item a item)                                                                                                                      |
| CA7-04 | APROVADO | #4 (revisão aberta: EM_REVISAO, fora do total, Pix 422, conferir 422; resolvida 300+500 = 800, dois créditos)                                                                             |
| CA7-05 | APROVADO | #2 (aprovação entra uma vez; **retrabalho após liberação + nova aprovação: ainda 1 obrigação, mesmo total**), #4 (sem duplicar após resolução)                                            |
| CA7-06 | APROVADO | #1 (André credor; Izaías sem linha, só como participante nas notas)                                                                                                                       |
| CA7-07 | APROVADO | #3 (Exemplo D: R$ 100 em 3 OS = 33,34+33,33+33,33, **uma** obrigação de R$ 100)                                                                                                           |
| CA7-08 | APROVADO | #3 (cancelada fora; frustrada só com taxa autorizada; sem custo = pendência; gratuita confirmada sem débito e sem custo posterior; recebedor inativo = pendência sem conta)               |
| CA7-09 | APROVADO | #1 (Exemplo A: **R$ 8.100** = 3.500 + 3.200 + 1.400; soma das linhas = total; cada item confere com a fonte)                                                                              |
| CA7-10 | APROVADO | #2 (Exemplo B: Pix R$ 600 → pago 600, saldo **R$ 800**); E2E registra Pix pela tela                                                                                                       |
| CA7-11 | APROVADO | #2 (mesma chave = mesmo resultado; duas baixas simultâneas do saldo: 201 + 422; acima do saldo 422); #6 (conferência dupla 200 + 409)                                                     |
| CA7-12 | APROVADO | #5 (semana anterior → saldo anterior identificado → semana seguinte só com o restante; pagamento posterior não some nem conta duas vezes); estornado não conta: #6 e shared “competência” |
| CA7-13 | APROVADO | #6 (conferir, divergência após ajuste, reabrir com motivo, reconferir, estorno do lote = estorno de cada baixa; tabelas somente inserção); E2E histórico                                  |
| CA7-14 | APROVADO | #7 (tablets, André, Izaías, sem permissão: 403 em leitura, CSV, lista, pagamento; leitura ≠ gestão; IDOR de pagamento 404; WebSocket sem dados); E2E tablets 403                          |
| CA7-15 | APROVADO | E2E desktop + celular 390×844 (capturas 01–05), confirmação de baixa em duas etapas, detalhes, estados de erro/vazio                                                                      |
| CA7-16 | APROVADO | seção 9 (migração do legado da Fase 6 sem alterar valores; rollback idêntico; rollback recusado com dados novos) e seção 10 (backup/restauração com hash de todas as tabelas)             |
| CA7-17 | APROVADO | regressão completa da API 359/359 (0 falhas), shared 77/77, E2E 27/27, lint/format/typecheck/build limpos                                                                                 |
| CA7-18 | APROVADO | seção 8 (medições reais) e #8 (ajuste de custo durante conferência; troca de titular durante pagamento; estado sempre consistente)                                                        |

## 6. Evidências de testes

| Verificação                                                                                                           | Resultado                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| API — fechamento (`closing.test.ts`)                                                                                  | **8/8**                                                      |
| Shared — regras (`closing.test.ts`)                                                                                   | 3/3 (pacote shared: **77/77**)                               |
| Suítes relacionadas (financeiro, mão de obra, logística, fluxo completo, segurança, integridade, qualidade, medições) | **110/110**                                                  |
| Regressão completa da API                                                                                             | **359 aprovados, 0 falhas** (5 de desempenho só sob demanda) |
| E2E completo (Playwright)                                                                                             | **27/27** (ver 6.1)                                          |
| Lint / formatação / typecheck                                                                                         | limpos                                                       |
| Build web (Next)                                                                                                      | ok                                                           |

### 6.1 Regressão completa

- **API:** `vitest run` completo — 36 arquivos, **359 testes aprovados, 0 falhas** (5 arquivos de
  desempenho pulados por padrão; executados à parte). Primeira regressão **totalmente verde** desde
  a Fase 5 (a falha de medições foi corrigida, ver 6.2).
- **E2E:** a primeira execução completa deu 25/27: as duas falhas (medições “rotina de sexta” e
  tablets “Urgente”) ocorreram porque a execução **atravessou a meia-noite local** (sexta 23:58 →
  sábado), mudando o “dia” de testes que dependem dele. As duas foram reexecutadas isoladamente
  (3/3) e a suíte completa foi repetida do zero: **27/27 aprovados (7,8 min)**. Fica registrado como
  risco de teste (dependência do relógio real nesses dois specs, preexistente, fora desta fase).
- **Shared:** 77/77. **Lint, formatação, typecheck:** limpos. **Build web:** ok.

### 6.2 Falha antiga de `measurements.test.ts` — corrigida isoladamente

- **Diagnóstico corrigido.** Os relatórios das Fases 5 e 6 atribuíram a falha ao **dia da semana**
  (“próxima sexta” no fim de semana). Isso estava **errado**. Reproduzido com relógio controlado, a
  causa é de **fuso**: o planejamento de materiais buscava medições concluídas com
  `completedAt >= meia-noite UTC` da data local; em Brasília (UTC−3), medições concluídas entre
  **21h e 24h** ficavam fora do período. As execuções anteriores ocorreram justamente nessa faixa.
- **Correção** (`a02643e`, isolada): limites do período em **dias locais da oficina**
  (`zonedDateTime(from,'00:00',tz)` a `zonedDateTime(to+1,'00:00',tz)`). Nenhuma regra de medições
  mudou.
- **Teste novo** com relógio controlado: 22:30 local → conta; 01:00 → conta; 23:30 do dia anterior →
  não conta. Falha sem a correção; com ela, `measurements.test.ts` **15/15**.

## 7. Números de reconciliação

**Exemplo A (#1):** Ricardo 5 peças = R$ 3.500,00; Márcio 4 peças = R$ 3.200,00 (a 5ª, R$ 850, em
produção = previsto); André 8 retiradas + 6 entregas × R$ 100 = R$ 1.400,00. **Devido R$ 8.100,00**;
previsto R$ 850,00 fora do pagável; Izaías sem linha.

**Exemplo B (#2):** Pix R$ 600 para André → pago R$ 600, saldo **R$ 800**; repetição com a mesma
chave não altera; restante R$ 800 liquida as 14 contas originais (14 contas `PAGO`, soma das baixas
R$ 1.400, **0 despesas novas**, 14 contas — nenhuma nova).

**Exemplo C (#2):** R$ 850 em produção = previsto; aguardando inspeção = “aguardando” (R$ 850);
liberado → Márcio R$ 4.050 em 5 itens, **uma** vez; retrabalho e nova aprovação não duplicam.

**Exemplo D (#3):** uma viagem de R$ 100 para 3 OS → rateio 33,34 + 33,33 + 33,33 e **uma**
obrigação de R$ 100 ao André.

**Legado migrado (seção 9):** Ricardo devido 700 / pago 300 / saldo 400 / previsto 500; Márcio
800/0/800; André 300 / **140** (o pagamento estornado na Fase 6 não conta) / 160 / previsto 100;
lançamento avulso legado (credor texto) 120/20/100. Total devido **R$ 1.920**, pago R$ 460, saldo
**R$ 1.460** = soma dos saldos nas fontes (`production_payables` + `account_payables`).

## 8. Desempenho (medido — `apps/api/test/closing-perf.test.ts`, `CLOSING_PERF=1`)

Volume: **40 OS, 200 tarefas publicadas, 80 valores de mão de obra liberados, 80 viagens devidas
(40 retiradas + 40 entregas) = 160 obrigações**, painel + **4 tablets** conectados por WebSocket;
20 repetições. Máquina do contêiner de desenvolvimento, API e banco locais.

| Operação                                           | p50 (ms) | p95 (ms) | máx (ms) |
| -------------------------------------------------- | -------- | -------- | -------- |
| GET fechamento da semana (painel)                  | 83       | 136      | 136      |
| GET fechamento CSV                                 | 79       | 101      | 101      |
| GET lista de fechamentos                           | 8        | 14       | 14       |
| Painel + 4 tablets simultâneos (rodada)            | 104      | 154      | 154      |
| GET fila do tablet durante o fechamento            | 61       | 82       | 85       |
| POST Pix em lote (baixas nas obrigações originais) | 354      | 528      | 528      |
| POST conferir (snapshot de 160 itens)              | 201      | 212      | 212      |
| POST reabrir                                       | 129      | 149      | 149      |

Arquivo: `docs/evidencias/evolucao-fase-7/desempenho.json`. Limitações: o limite de requisições é
por sessão (600/min); a preparação da carga troca de sessão. O Pix em lote é o mais lento por
travar e recalcular as obrigações do beneficiário dentro da transação (escolha de segurança).

## 9. Migration e rollback (legado real da Fase 6)

1. Worktree no código da Fase 6 (`05c0ae2`), banco `cenario_legacy7_test`, fixture pelas **APIs da
   Fase 6**: padrões de logística, 3 valores de mão de obra (2 liberados, 1 em produção), pagamento
   parcial de produção, 4 retiradas (3 realizadas, 1 agendada), pagamento integral, parcial e um
   pagamento **estornado** (Fase 6), lançamento manual LANCADO com credor texto e pagamento parcial.
2. Fotografia (contagens, somas e hashes de valores — scripts das Fases 5/6) → `prisma migrate deploy`
   → fotografia: **todas as linhas existentes idênticas**; só surgem as 7 tabelas novas vazias.
3. Rollback (`packages/db/rollback/20261115000000_fechamento_semanal.down.sql`) sem dados novos:
   **schema idêntico** ao anterior (`pg_dump -s`) e **dados idênticos**. Reaplicado.
4. Código da Fase 7 sobre o legado migrado: números da seção 7 conferidos; Pix em lote liquidou as
   contas originais de André (contas a pagar continuaram 4); estorno de um pagamento de produção
   **legado**; semana conferida.
5. Rollback com dados novos: **recusado** (“Reversão bloqueada: 7 registro(s) da Fase 7. Restaure o
   backup anterior à migration.”), schema inalterado (mesmo md5) e migration continua registrada.
   **Recuperação:** restaurar o backup anterior à migration e voltar ao código `05c0ae2`.

## 10. Backup e restauração

- `scripts/test-backup-restore.sh` (padrão do projeto): **✔ verificado** (17 migrations, contagens
  idênticas).
- Como a lista fixa do script não inclui as tabelas novas, foi feita também a comparação **por
  valor** de **todas as 111 tabelas** (md5 da linha inteira, ordenado) entre o banco legado migrado
  com dados da Fase 7 e sua restauração em banco separado: **idênticas**, incluindo
  `weekly_closings`, `weekly_closing_events`, `closing_payments`, `closing_payment_parts`,
  `professional_payment_reversals` e `payable_payment_reversals`.
- Gatilhos de imutabilidade continuam ativos após a restauração (UPDATE em `closing_payments` e
  DELETE em `weekly_closings` recusados).

## 11. Riscos

| Risco                                                                             | Mitigação                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Fechamento como visão: mudança retroativa numa fonte altera a semana já conferida | retrato versionado + divergência listada; reabertura com motivo; nada reescrito |
| Data de pagamento informada manualmente (pode cair em outra semana)               | competência explícita por `paid_at`; “pago depois” visível; testado (#5)        |
| Pix registrado no sistema ≠ Pix real                                              | revisão em duas etapas na tela; estorno auditável do lote                       |
| Lote longo trava obrigações do beneficiário                                       | bloqueio em ordem determinística; p95 528 ms com 160 obrigações                 |

## 12. Pendências

- Comprovante como arquivo anexo **não** foi implementado (só referência textual curta): evita guardar
  documento bancário sem necessidade; pode ser adicionado reaproveitando os anexos protegidos.
- Exportação PDF do fechamento: fora do escopo (CSV disponível).

## 13. Arquivos

API: `apps/api/src/app.ts`, `apps/api/src/modules/finance/{closing,labor,payables,trip-costs}.ts`,
`apps/api/src/modules/materials/routes.ts` (correção de medições). Banco:
`packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/20261115000000_fechamento_semanal/`,
`packages/db/rollback/20261115000000_fechamento_semanal.down.sql`. Shared:
`packages/shared/src/{closing-domain,index,types-finance}.ts`, `packages/shared/src/schemas/finance.ts`.
Web: `apps/web/components/finance/{weekly-closing,finance-page}.tsx`, `apps/web/lib/finance.ts`.
Testes: `apps/api/test/{closing,closing-perf,measurements}.test.ts`,
`packages/shared/test/closing.test.ts`, `tests/e2e/specs/team-closing.spec.ts`. Evidências:
`docs/evidencias/evolucao-fase-7/`.

## 14. SHAs

- HEAD inicial: `05c0ae2` (fim da Fase 6).
- `a02643e` — planejamento de materiais em dias locais (correção isolada da falha de medições).
- `5f99751` — migration aditiva, rollback com bloqueio, regras de competência (shared).
- `d854ba2` — API do fechamento (visão, conferência, Pix em lote, estornos) e testes.
- `c149dd6` — tela Financeiro → Fechamento semanal e E2E (com capturas).
- `320cfa3` — teste de desempenho e ajuste das ações da linha.
- `ee3fef2` — teste de retrabalho após liberação.
- Commit deste relatório = HEAD final (o SHA é informado na entrega, pois o arquivo não pode conter
  o próprio hash).
- Worktree: limpa após o push; worktree auxiliar da Fase 6 (fixture legada) removida.

## 15. GO / NO-GO

**GO técnico para a Fase 7.** CA7-01..18 **APROVADOS** com testes executados; regressão da API
359/359 sem falhas (primeira totalmente verde desde a Fase 5), E2E 27/27, shared 77/77; migração do
legado da Fase 6 sem alteração de valores, rollback idêntico quando permitido e **recusado** com dados
novos; backup/restauração idênticos por valor em todas as tabelas; desempenho medido.

Ressalvas: (1) dois specs E2E antigos dependem do relógio real e falham se a execução atravessar a
meia-noite local (registrado na 6.1); (2) comprovante só como referência textual (pendência 12).

**GO técnico não é autorização de publicação.** Nada foi publicado, nenhuma migration foi aplicada na
nuvem e nenhum Pix real foi feito. **Fase 8 não iniciada** — aguardando autorização explícita.
