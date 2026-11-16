# Remediação pós-auditoria — Rodada 3 (fechamento dos requisitos parciais)

**Base:** funcional `34412d5`, documentação `5d27874`.
**Branch:** `claude/cenario-gestao-fase-1-zf3bj2`.
**Escopo:**

- os 36 requisitos IMPLEMENTADO PARCIALMENTE da Rodada 2;
- F9-02, a única linha "sem teste suficiente" pedida explicitamente.

**Fora do escopo** (por instrução do proprietário):

- as outras 33 linhas sem teste suficiente;
- as seis reversões históricas (F1-05);
- Safari, tablets físicos e rede física;
- produção.

Cada item foi classificado pelas regras A–I da Rodada 3. SUBSTITUÍDO só com evidência documental.
As decisões do proprietário desta rodada foram F8-03 (opção C), F2-18/F2-11, F7-06 e F10-19.

Preservado sem mudança de regra:

- D9–D13, F2-08 e F3-17;
- PREVISTO ≠ DEVIDO;
- fonte financeira única;
- privacidade do tablet;
- Central derivada (nada gravado por ela);
- `finance.own_changed` sem valores.

## 1. Decisões do proprietário aplicadas

### F8-03 — previsto sem semana financeira (opção C)

- Meus Ganhos mostra o item PREVISTO como "Sem semana definida" e "ainda não é devido".
- A semana e a data **planejadas** aparecem à parte, em `plannedFor`, rotuladas como "informação do
  planejamento". Origem da informação:
  - mão de obra: a etapa pendente mais próxima da própria pessoa (semana do plano e data programada);
  - logística: a data agendada da viagem.
- Nunca se usa `created_at`, `updated_at`, a semana atual, a semana da OS ou a da última tarefa.
- É só leitura. O fechamento não muda, nada é gravado e nenhum histórico é criado.
- Reprogramar a etapa muda a informação e não toca a obrigação, os eventos financeiros nem o
  fechamento.

Código: `apps/api/src/modules/finance/my-earnings.ts` (`plannedForForecast`),
`packages/shared/src/types-finance.ts`, `apps/web/components/tablet/my-values.tsx`.

### F2-18 / F2-11 — custo operacional da retirada pela equipe própria

- A retirada ou entrega feita pela equipe própria pode ter custo real registrado, no Novo serviço e
  no endpoint antigo `POST /api/v1/pickups`. Esse custo é do tipo **OPERACIONAL**, sobre o mesmo
  modelo `logistics_costs`. Não existe segunda fonte de custo.
- O custo OPERACIONAL **não é dívida com o funcionário**. Ele não tem:
  - recebedor;
  - conta a pagar;
  - obrigação de produção;
  - pagamento;
  - entrada no fechamento;
  - entrada em Meus Ganhos;
  - evento `finance.own_changed`.
- Ele entra no relatório de margem da OS, como custo real.
- O histórico fica registrado na auditoria `finance.trip_cost_operational` e no evento financeiro
  `CUSTO_OPERACIONAL`. Cancelar a viagem cancela o custo e preserva o histórico.
- Trocar a equipe não converte um custo no outro. Nos dois sentidos, a troca é recusada enquanto
  houver custo ativo do outro tipo.
- Migration **aditiva** `20270223000000_custo_operacional_equipe_propria`. Ela só amplia a regra
  `logistics_costs_phase6` para aceitar `OPERACIONAL`; nenhuma linha é alterada. A reversão é
  condicionada (`packages/db/rollback/…down.sql`) e é recusada se existir custo operacional ativo.
- Entradas, pagamentos e terceirizada continuam como antes.

### F7-06 — tablet mínimo

- O tablet continua mostrando o início previsto (`Início previsto às …`).
- A observação do gestor aparece **somente** no trabalho externo. Nesse caso ela é o local ou a
  descrição do trabalho, informação inequivocamente operacional.
- Nas ausências, folgas, férias e atestados, a nota é a justificativa livre do gestor. O modelo não
  distingue o que nela é operacional e o que é administrativo, disciplinar ou de saúde. Por isso ela
  não chega ao tablet, nem pelo DTO `attendance/me` nem pelo aviso enviado ao funcionário. O aviso
  passa a levar só o fato; o mesmo já valia para folgas e férias do calendário. A justificativa
  continua no painel e no histórico.
- Limitação documentada: não foi criada nenhuma classificação "operacional × privada" para a nota.

### F10-19 — revisão por devolução resolvida pelo fluxo financeiro canônico

Não há botão "revisão concluída" e nada é resolvido por leitura, prazo ou rotina. O aviso
`REVISAO_DEVOLUCAO` da peça é resolvido quando há evidência canônica de que a revisão terminou:

| Desfecho da revisão                              | Ação canônica existente                          | Resolve                                                     |
| ------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| Valor não é devido                               | cancelar a mão de obra (`cancelLabor`)           | sim (Rodada 3, 1ª parte)                                    |
| Valor alterado                                   | ajuste justificado (`adjustLabor`)               | sim, no ajuste                                              |
| Valor mantido                                    | quitação integral (`payLabor` → PAGO)            | sim; pagamento parcial não resolve                          |
| OS inteira (legado)                              | resolução da revisão (`resolveLaborReview`)      | sim (Rodada 2)                                              |
| **Peça já quitada antes da devolução e mantida** | nenhuma: ajustar, cancelar e pagar são recusados | **não** (o aviso segue ativo até um estorno + nova decisão) |

- Uma nova devolução reativa o mesmo aviso pela mesma chave (ativo e não lido, sem duplicar).
- Ajustes simultâneos: um vence e o outro é recusado pela versão. O aviso é resolvido uma vez.

Não se abriu `LaborReview` para a peça. Isso travaria ajuste e pagamento de um valor que a Fase 12
define como "continua devido" (`remediation.test.ts` › "peça devolvida com trabalho executado").
Seria mudança de regra de negócio, e por isso não foi feita.

## 2. Matriz dos 37 itens (ANTES → DEPOIS)

Legenda: **C** = IMPLEMENTADO E COMPROVADO · **P** = IMPLEMENTADO PARCIALMENTE · **S** =
SUBSTITUÍDO POR DECISÃO · **T** = IMPLEMENTADO SEM TESTE SUFICIENTE.

| ID      | Antes | Ação                                                                                                                                 | Prova                                                         | Depois |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------ |
| F1-03   | P     | Cada tabela extra rastreada até um pedido do proprietário (ex.: `customer_payment_reports` msg-48584:400; feriados/folgas msg-52006) | evidência documental nas mensagens citadas                    | S      |
| F1-05   | P     | Nada (as seis reversões históricas ficaram fora por instrução)                                                                       | `docs/PLANO-DE-REVERSAO.md` §2 (linhas (b))                   | P      |
| F1-08   | P     | Teste de instalação existente da 20270126                                                                                            | `migrations.test.ts` › F1-08                                  | C      |
| F1-09   | P     | Corte de eventos por tipo de sessão (tablet não recebe audiência gerencial)                                                          | `rodada3-financeiro` › F1-09; shared `rodada3` › F1-09 (2)    | C      |
| F1-12a  | P     | Script da migração encadeada cobre a cadeia completa; job `evolution-migrations` no CI                                               | `scripts/test-evolution-migrations.sh`; CI                    | C      |
| F1-14   | P     | Plano de reversão por fase em um documento                                                                                           | `docs/PLANO-DE-REVERSAO.md`                                   | C      |
| F1-15a  | P     | Divergência no recebimento de peça de cliente vira item da Central                                                                   | `rodada3-central` › F1-15a                                    | C      |
| F2-11   | P     | Endpoints antigos voltam a aceitar o custo da equipe própria (OPERACIONAL), compatíveis                                              | `novo-servico` › CA2-08 e › Rodada 3 (F2-18/F2-11)            | C      |
| F2-18   | P     | Custo operacional da equipe própria (decisão do proprietário); migration 20270223                                                    | `novo-servico` › Rodada 3 (F2-18/F2-11); › migration 20270223 | C      |
| F2-24   | P     | E2E 390 px do Novo serviço com asserção de geometria; resumo quebra linha                                                            | E2E `novo-servico.spec.ts` (390 px)                           | C      |
| F5-01b  | P     | Abrangência fixada pelo proprietário: "reforma de sofá e cabeceira"                                                                  | msg-37383:3 (autorização da Fase 5)                           | S      |
| F6-03   | P     | Fila Recebimentos por situação                                                                                                       | `rodada3-compras` › F6-03; shared › F6-03                     | C      |
| F6-07b  | P     | Prova de concorrência real (trava da necessidade) em vez de gatilho de banco                                                         | `rodada3-compras` › F6-07b (2)                                | C      |
| F6-10   | P     | CSV bruto rotulado em toda linha e no nome                                                                                           | `rodada3-compras` › F6-10; shared › F6-10 (2)                 | C      |
| F6-14   | P     | Alerta "em rascunho há N dias" (D10) na lista e na Central                                                                           | `rodada3-compras` › F6-14; shared › F6-14 (2)                 | C      |
| F6-18a  | P     | Aviso de que a saída livre não cobre a necessidade                                                                                   | `rodada3-compras` › F6-18a                                    | C      |
| F7-06   | P     | Decisão do proprietário: início previsto mantido; nota só do trabalho externo                                                        | `attendance` › F7-06 (Rodada 3)                               | S      |
| F8-03   | P     | Opção C: previsto "sem semana", planejamento só informativo                                                                          | `rodada3-financeiro` › F8-03                                  | C      |
| F8-06   | P     | Trabalho concluído sem valor: estado "valor ainda não disponível", fora dos totais                                                   | `rodada3-financeiro` › F8-06 (2)                              | C      |
| F9-02   | T     | Confirmação exige desbloqueio D12 válido; auditoria só com método e validade                                                         | `rodada3-financeiro` › F9-02 (2)                              | C      |
| F10-02  | P     | Menu com Materiais aprovados; quadro de produção filtrável                                                                           | E2E `gestao.spec.ts` (Início/menu/Recebimentos)               | C      |
| F10-04  | P     | Item "a planejar" na Central                                                                                                         | `rodada3-central` › F10-04                                    | C      |
| F10-05  | P     | Retiradas dos próximos 2 dias (Central + Início), link para o roteiro                                                                | `rodada3-central` › F10-05/06; › F10-14                       | C      |
| F10-06  | P     | Retirada feita aguardando chegada                                                                                                    | `rodada3-central` › F10-05/06                                 | C      |
| F10-09  | P     | Tarefa BLOQUEADA com prazo distante; só impedimento real conta                                                                       | `rodada3-central` › F10-09/13f/21l                            | C      |
| F10-13f | P     | Idem F10-09 (produção)                                                                                                               | `rodada3-central` › F10-09/13f/21l                            | C      |
| F10-13g | P     | Embalagem aprovada sem responsável                                                                                                   | `rodada3-central` › F10-13g                                   | C      |
| F10-14  | P     | Links que abrem o item exato                                                                                                         | `rodada3-central` › F10-14                                    | C      |
| F10-17  | P     | Avisos persistidos resolvidos pela ação canônica (sem duplicidade com a Central)                                                     | `rodada3-resolucao` (5); `rodada2-eventos` › F10-19           | C      |
| F10-18  | P     | Permissão por domínio em cada cartão                                                                                                 | `rodada3-central` › F10-18 (2)                                | C      |
| F10-19  | P     | Atribuição de retirada, encerramento sem andamento, revisão por devolução (cancelar, ajustar, quitar)                                | `rodada3-resolucao` (5); `rodada3-financeiro` › F10-19 (3)    | **P**  |
| F10-20b | P     | Antes/depois nas ações financeiras                                                                                                   | `rodada3-financeiro` › F10-20b                                | C      |
| F10-21i | P     | Total de pendências do Início = total da Central                                                                                     | `rodada3-central` › Início (total)                            | C      |
| F10-21k | P     | Pré-produção e bloqueios separados na distribuição                                                                                   | `rodada3-central` › Início (total)                            | C      |
| F10-21l | P     | Bloqueados = impedimento real de produção, exibido                                                                                   | `rodada3-central` › F10-09/13f/21l                            | C      |
| F10-21r | P     | Obrigações logísticas como subconjunto das contas a pagar                                                                            | `rodada3-central` › obrigações logísticas                     | C      |
| F10-22  | P     | Regressão integral no SHA final + este relatório                                                                                     | §4                                                            | C      |

**F10-19 continua PARCIAL.** Pela regra do proprietário, só vira COMPROVADO se **todos** os tipos
tiverem caminho canônico de resolução. Falta um caso: a peça que já estava quitada antes da
devolução e cujo valor é mantido. Para ela não existe ação canônica de encerramento sem inventar uma.

**F1-05 continua PARCIAL.** As seis reversões históricas ficaram fora por instrução do proprietário.

## 3. Totais (284 requisitos)

| Classificação                     | Rodada 2 | Rodada 3 |
| --------------------------------- | -------- | -------- |
| IMPLEMENTADO E COMPROVADO         | 206      | **238**  |
| IMPLEMENTADO PARCIALMENTE         | 36       | **2**    |
| IMPLEMENTADO SEM TESTE SUFICIENTE | 34       | **33**   |
| NÃO IMPLEMENTADO                  | 0        | 0        |
| DIVERGENTE                        | 0        | 0        |
| SUBSTITUÍDO POR DECISÃO           | 6        | **9**    |
| NÃO COMPROVADO                    | 2        | 2        |
| **Total**                         | 284      | 284      |

Conta: 36 parciais = 31 → C, 3 → S (F1-03, F5-01b, F7-06) e 2 → P (F1-05, F10-19). F9-02 passa de
"sem teste suficiente" para C. 206 + 31 + 1 = 238.

## 4. Validação final

SHA final de código e de validação: **`c240387`**. Banco PG16 local recriado do zero.

| Etapa                                                     | Resultado                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| format / lint / typecheck                                 | OK                                                              |
| migrations do zero + `migrate diff` (schema)              | OK (33 migrations, sem divergência)                             |
| build                                                     | OK                                                              |
| shared                                                    | 134/134                                                         |
| web                                                       | 6/6                                                             |
| API                                                       | 836 passaram, 10 ignorados (846), 0 falhas                      |
| backup / restauração                                      | OK (119 tabelas comparadas por valor)                           |
| E2E completo                                              | 50/50                                                           |
| `scripts/test-evolution-migrations.sh`                    | OK (legado → 33; reversão e reaplicação da 20270223 e 20270216) |
| CI execução 182 (`verify`, `e2e`, `evolution-migrations`) | verde                                                           |

Durante a rodada:

- **Correção de teste.** Duas falhas de teste foram corrigidas: a tipagem no teste de ajustes
  simultâneos, e `meus-ganhos` › 25/26, cuja lista de campos permitidos passou a aceitar o
  `plannedFor` da decisão F8-03.
- **CI dividido.** O `verify` já usava 44 dos 45 minutos de limite, e na execução 181 o E2E foi
  cortado por tempo. O limite **não** foi aumentado: o E2E passou a um job próprio (`e2e`, em
  paralelo), e o `verify` mantém os 45 minutos.

## 5. Homologação

Fluxo seguro `operar.py`, versão `c240387`. A evidência está na pasta `hml3` do scratchpad.

| Passo                                       | Resultado                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| build pelo gatilho + imagens                | api `sha256:c962763c…`, web `sha256:138dfbcf…`                                            |
| impressão digital (antes)                   | registrada                                                                                |
| portão aberto → `prepare_version`           | **recusado**: disco livre 2 GB (mínimo 3 GB); nada alterado                               |
| manutenção → ponto de recuperação           | `cenario-staging-20261021T172659Z` (versão 34412d5); restauração de teste IDÊNTICA        |
| `backup_validate` / `backup_restore_test`   | OK / IDÊNTICA                                                                             |
| `images_cleanup_plan` → `images_cleanup`    | só as imagens de `e4d6010` (deixaram de ser protegidas com o novo ponto); 1,05 → 3,19 GiB |
| `prepare_version`                           | OK (4 GB livres; banco intocado)                                                          |
| `migration_precheck`                        | OK: 1 pendente (20270223), esquema compatível                                             |
| `migrate` / `migration_verify`              | aplicada em 11 s / 33 de 33, nenhuma pendente                                             |
| `activate_version`                          | OK                                                                                        |
| health / smoke / websocket / suíte completa | OK                                                                                        |
| versão                                      | etiqueta e pilha em `c240387`                                                             |
| logs (api, web, caddy, postgres)            | sem erro                                                                                  |
| impressão digital (depois)                  | igual à de antes, salvo a regra ampliada e o registro da migration 33                     |
| portão                                      | **fechado**                                                                               |

Nenhuma infraestrutura, IAM, DNS, firewall, VM ou Caddy foi alterado. A limpeza de imagens usou a
operação existente e respeitou as versões protegidas.

**Produção não foi tocada.**

## 6. Pendências que continuam abertas

| Item   | Situação                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------- |
| F10-19 | Peça quitada antes da devolução com valor mantido: sem ação canônica de encerramento           |
| F1-05  | Seis reversões históricas sem `.down.sql` (fora do escopo; reversão pelo ponto de recuperação) |
| —      | 33 linhas "sem teste suficiente"; Safari e dispositivos físicos; produção (fora do escopo)     |
