# Evolução Operacional — Fase 8: Auditoria integrada, remediação e preparação da homologação

> Fase de auditoria, testes, correção de defeitos comprovados e preparação de implantação.
> **Não é autorização de deploy.** Nada foi publicado; a homologação `teste.cenariogestao.com.br`
> (projeto `cenariogestao`, VM `cenario-homolog`) **não foi acessada**; nenhuma migration em nuvem,
> Cloud Build, DNS, firewall, Pix, e-mail ou mensagem externa; VerificaPro intocado; só dados
> sintéticos em PostgreSQL 16 local.

## 1. Branch, HEAD e worktree

| Item                | Início                                                                                                                                 | Fim                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Branch              | `claude/cenario-gestao-fase-1-zf3bj2`                                                                                                  | mesma                                 |
| HEAD                | `e72e386` (fim da Fase 7, conferido)                                                                                                   | informado na entrega (seção 5)        |
| Worktree            | limpa                                                                                                                                  | limpa; worktrees auxiliares removidas |
| Commit pré-Evolução | `839770a` — mesmo código de aplicação da imagem publicada `fd6dc19` (`git diff fd6dc19 839770a -- apps packages pnpm-lock.yaml` vazio) | —                                     |

## 2. Resumo executivo e escopo

A auditoria percorreu o **código real** das Fases 1–7 (matriz verificada por busca no código, não
pelos relatórios), executou os 10 cenários integrados num único fluxo contínuo, o financeiro de
ponta a ponta, a migração encadeada a partir do código anterior à Evolução, rollback, backup,
desempenho como processo real com o limite de memória da VM e resiliência a reinício.

Resultado: **nenhum P0**. Foram encontrados e corrigidos, com teste de reprodução antes e teste
verde depois, **3 defeitos P1** e **3 P2**:

1. **P1 — fuso fixo de −3 h** (pendente desde a Fase 1 e **omitido do relatório da Fase 7**): os
   períodos de todos os relatórios financeiros, a pontualidade da produtividade e o semanal da mão
   de obra usavam −3 h fixo em vez do fuso configurado; materiais aprovados entre 21h e 24h caíam no
   dia seguinte; “hoje” ignorava o relógio operacional.
2. **P1 — rollbacks inseguros**: os scripts de reversão das Fases 2 e 3 descartavam em silêncio a
   fila e a titularidade por peça; o da Fase 5 só recusava por acidente (falha de índice).
3. **P1 — verificação de backup incompleta**: o teste de backup comparava uma lista fixa de tabelas
   que não incluía nenhuma das tabelas novas (o backup real — `pg_dump` completo — estava correto).
4. **P2 — privacidade**: o nome completo do cliente chegava aos tablets da produção.
5. **P2 — E2E dependentes do relógio real** (medições “sexta” e tablets “Urgente”).
6. **P2 — evidência de migração não versionada** (scripts fora do repositório nas Fases 2–7).

Testes físicos (Safari/WebKit, iPhone, tablets) **NÃO TESTADOS** — WebKit não está instalado no
ambiente e a instalação de navegadores é vedada; roteiro manual na seção 12.

## 3. Matriz de rastreabilidade

Arquivo completo (≈100 linhas, cada teste localizado pelo título no código):
[`docs/evidencias/evolucao-fase-8/matriz-rastreabilidade.md`](evidencias/evolucao-fase-8/matriz-rastreabilidade.md).

Divergências documentação × código encontradas (todas tratadas ou registradas):

| #   | Divergência                                                                                                       | Tratamento                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | −3 h fixo: planejado para a Fase 2, adiado e **sumiu do relatório da Fase 7**; também em `period()`, nunca citado | **Corrigido** (`d89359c`)                                                   |
| 2   | Rota `/mine/queue/all` e evento `production.queue.reordered` (Fase 1) não existem                                 | Registrado (paginação no cliente; evento real `production.queue_reordered`) |
| 3   | `activity_assignment_rules` (Fase 1) substituída por `step_class` (Fase 3)                                        | Registrado                                                                  |
| 4   | Estorno de pagamento ao profissional previsto na Fase 5, implementado só na Fase 7                                | Registrado                                                                  |
| 5   | Conta semanal consolidada (Fase 1) substituída por visão calculada (Fase 7, D-1)                                  | Já documentado                                                              |
| 6   | Rollback da Fase 5 com recusa implícita; Fases 2–3 sem guarda                                                     | **Corrigido** (`25222fd`)                                                   |
| 7   | Evidência de migração das Fases 2–7 dependente de scripts fora do repositório                                     | **Versionado** (`1a8b3c2`)                                                  |
| 8   | CA5-14/CA6-16 aprovados com a falha de medições diagnosticada como “dia da semana” (era fuso)                     | Corrigido na Fase 7; reconfirmado                                           |

## 4. Achados por severidade

| ID  | Sev. | Achado                                                                                                                                  | Evidência / reprodução                                                   | Estado                                         |
| --- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| A1  | P1   | Períodos/prazos financeiros e semanal da mão de obra com −3 h fixo; materiais aprovados 21h–24h no dia seguinte; “hoje” fora do relógio | `timezone.test.ts`: 4 falhas antes / 6 de 6 depois (`fuso-*.txt`)        | Corrigido `d89359c`                            |
| A2  | P1   | Rollback 2/3 descartava fila/titular em silêncio; 5 recusava só por falha de índice                                                     | `test-evolution-migrations.sh` etapa 6 (cada rollback recusado, atômico) | Corrigido `25222fd`                            |
| A3  | P1   | `test-backup-restore.sh` não verificava as tabelas novas                                                                                | 111 tabelas comparadas por valor + catálogo de gatilhos/índices          | Corrigido `1a8b3c2`                            |
| A4  | P2   | Nome completo do cliente nos tablets da produção                                                                                        | `privacy.test.ts`: falha antes (nome completo) / verde depois            | Corrigido `252480b`                            |
| A5  | P2   | E2E de medições e tablets falhavam ao atravessar a meia-noite                                                                           | Relógio do servidor congelado (inclusive sexta 23h59); 3/3               | Corrigido `1f94a76`                            |
| A6  | P2   | Migração sem prova versionada                                                                                                           | Script encadeado versionado                                              | Corrigido `1a8b3c2`                            |
| R1  | P2   | Tela de distribuição do plano lenta sob carga contínua (p95 2,2 s com 8 painéis simultâneos)                                            | `memoria-api-processo.json`                                              | Aberto (proposta, seção 13)                    |
| R2  | P2   | `todayIso()` sem fuso explícito em algumas regras (vencimento de contas, data futura do Pix) usa o padrão `America/Sao_Paulo`           | inspeção + fuso único em uso                                             | Aberto (só afeta outro fuso)                   |
| R3  | P2   | Rótulos de inspeção/avisos de qualidade incluem o nome completo do cliente (tablet do Thiago)                                           | inspeção do código                                                       | Proposta (decisão do dono)                     |
| R4  | P2   | Prazo de medição calculado antes da meia-noite e enviado depois é recusado (mensagem clara; usuário escolhe nova data)                  | `timezone.test.ts` (400 “prazo no passado”)                              | Comportamento correto; melhoria de UX proposta |
| R5  | P2   | Comprovante só como referência textual; exportação só CSV (sem PDF)                                                                     | seção 13                                                                 | Proposta de fase futura                        |

Nenhum vazamento de valores, pagamento duplicado, atribuição incorreta de titular, perda de dados,
migration insegura ou falha de recuperação foi encontrado.

## 5. Correções e commits

| Commit    | Conteúdo                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d89359c` | Fuso da oficina: `period()`, pontualidade, semanal da mão de obra e materiais em dias locais; “hoje” pelo relógio operacional; `timezone.test.ts` |
| `1f94a76` | E2E determinísticos (relógio do servidor congelado; navegador em `America/Sao_Paulo`)                                                             |
| `fad723f` | Matriz de rastreabilidade                                                                                                                         |
| `252480b` | Nome do cliente reduzido nos tablets da produção; regressão de autorização (34 rotas × 4 perfis + CSRF)                                           |
| `25222fd` | Guardas explícitas nos rollbacks das Fases 2, 3 e 5                                                                                               |
| `1a8b3c2` | Migração encadeada versionada; backup comparando todas as tabelas por valor                                                                       |
| `fb7f85a` | Cenários integrados 1–10 e financeiro ponta a ponta                                                                                               |
| `5a842a1` | Resiliência a reinício da API; memória no teste do fechamento                                                                                     |
| `2a069de` | Memória como processo real (heap 320 MB), desempenho e sonda de imagem antiga                                                                     |
| (este)    | Relatório da Fase 8                                                                                                                               |

**Causa raiz do −3 h (A1).** `finance/common.ts` `period()` montava os limites como
`data UTC + 3 h` e `results.ts` deslocava `scheduledAt`/`completedAt` em −3 h fixos; `labor-review.ts`
usava `-03:00` literal. Em São Paulo (sem horário de verão desde 2019) isso coincide com o fuso
real — por isso os testes antigos passavam —, mas ignora `company_settings.timezone`. No
planejamento de materiais o limite era meia-noite **UTC**, o que exclui de fato as aprovações das
21h às 24h em Brasília. Correção: limites `zonedDateTime(dia, '00:00', fuso configurado)` e data
local por `Intl` no fuso configurado; sem deslocamento fixo algum. Casos executados: 20h59, 21h,
23h59 (sexta, no prazo) e 00h01 (sábado, atrasada); 31/10 23h59 × 01/11 00h01 (virada de mês);
Manaus (UTC−4) 23h30 (era classificada no dia seguinte); semanal com liberação domingo 23h30;
relógio em sexta 23h59 → sábado 00h01.

**Privacidade (A4).** Hook `preSerialization` nas rotas de produção e ajuda: em sessão DEVICE
todo `customerName` vira “Primeiro I.” (ex.: “Maria F.”) — contrato inalterado (string), aplicado no
servidor, painel e logística mantêm o nome completo (o André precisa do nome/endereço para entregar).

## 6. Matriz CA8-01..CA8-20

Comandos: API — `TEST_DATABASE_URL=…/cenario_test npx vitest run` (apps/api); E2E —
`E2E_DATABASE_URL=…/cenario_e2e_test npx playwright test` (tests/e2e); migração —
`PG_BASE=… scripts/test-evolution-migrations.sh`; memória — `DB_URL=… scripts/test-api-memory.sh 60 8`.

| CA     | Status                                                                 | Evidência executada                                                                                                                                              |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA8-01 | APROVADO                                                               | `matriz-rastreabilidade.md` (testes localizados no código; divergências seção 3)                                                                                 |
| CA8-02 | APROVADO                                                               | `integrated-evolution` #3 (LEGADO exige horário, fila sem horário); `queue.test` “LEGADO preservado”; migração: planos legados `LEGADO=1`                        |
| CA8-03 | APROVADO                                                               | `integrated-evolution` #4 (segunda → terça, mesma ordem e estado) e #10 (transferência sem duplicar); `queue.test` CA2-05                                        |
| CA8-04 | APROVADO                                                               | `integrated-evolution` #5+6 (ocorrência bloqueia, próxima executável sem reordenar, desbloqueio não interrompe)                                                  |
| CA8-05 | APROVADO                                                               | `integrated-evolution` #5+6 (concorrência 200+409; 1 ativa); `queue.test` CA2-08                                                                                 |
| CA8-06 | APROVADO                                                               | `integrated-evolution` #1+9 (reprocessar, concorrente, modelo editado: tarefas idênticas); `distribution.test` CA3-05                                            |
| CA8-07 | APROVADO                                                               | `integrated-evolution` #2 e #8 (titular exclusivo; substituição com motivo, tarefa ativa protegida, auditoria)                                                   |
| CA8-08 | APROVADO (Chromium) · **NÃO TESTADO** em Safari/WebKit e tablet físico | `tablet-week.test`, `e2e/team-week.spec.ts`, `zz-visual-audit` (144 telas×tamanhos)                                                                              |
| CA8-09 | APROVADO (Chromium/servidor) · **NÃO TESTADO** em rede/aparelho físico | `integrated-evolution` #7 (ao vivo + retomada pela sequência), `resilience.test` (reinício da API), `privacy.test` (autorização)                                 |
| CA8-10 | APROVADO                                                               | `labor.test`; `integrated-evolution` financeiro (revisão, divisão 300+500 reconhecida)                                                                           |
| CA8-11 | APROVADO                                                               | `labor.test` #4/#5 (PIN a cada abertura, bloqueio 429, sem acesso cruzado, `no-store`); `privacy.test` (34 rotas)                                                |
| CA8-12 | APROVADO                                                               | `integrated-evolution` financeiro (concluir não paga; liberação por qualidade); `closing.test` #2 (retrabalho sem duplicar)                                      |
| CA8-13 | APROVADO                                                               | `logistics-costs.test` (15) e `closing.test` #3 (R$ 100 → 33,34/33,33/33,33, uma obrigação; André único credor)                                                  |
| CA8-14 | APROVADO                                                               | `closing.test` #1 (R$ 8.100), #5 (saldo anterior); `integrated-evolution` financeiro                                                                             |
| CA8-15 | APROVADO                                                               | `integrated-evolution` (idempotente, acima do saldo 422, estorno imutável, reabertura); `closing.test` #2 (R$ 600 → R$ 800, concorrência)                        |
| CA8-16 | APROVADO                                                               | `timezone.test` (bordas e virada de mês; −3 h tratado na causa raiz); E2E com relógio congelado                                                                  |
| CA8-17 | APROVADO                                                               | `privacy.test` (nome reduzido; WS; 34 rotas × tablet/sem permissão/anônimo; CSRF)                                                                                |
| CA8-18 | APROVADO                                                               | `test-evolution-migrations.sh` (`migracao-encadeada.txt`) e `test-backup-restore.sh`                                                                             |
| CA8-19 | APROVADO (Chromium)                                                    | API 377/377 (0 falhas), shared 77/77, E2E 27/27, lint/format/typecheck/build limpos; desempenho e memória medidos (seções 7 e 10); WebKit NÃO TESTADO (seção 12) |
| CA8-20 | APROVADO (documento)                                                   | runbook (seção 14), roteiro físico (seção 12), GO/NO-GO (seção 15); nada publicado                                                                               |

**Não é 20/20:** CA8-08 e CA8-09 têm componente físico/Safari **NÃO TESTADO**.

## 7. Testes e evidências (incluindo falhas e reexecuções)

| Verificação                                                   | Resultado                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Regressão completa da API (`vitest run`)                      | **377 aprovados, 0 falhas** (40 arquivos; 5 de desempenho sob demanda, executados à parte)  |
| Novos nesta fase                                              | `timezone` 6, `privacy` 2, `integrated-evolution` 9, `resilience` 1                         |
| Shared                                                        | 77/77                                                                                       |
| E2E completo (Playwright, Chromium, fuso `America/Sao_Paulo`) | **27/27** (7,7 min); auditoria visual: 144 telas×tamanhos, 0 erros JS, 0 rolagem horizontal |
| Desempenho (Fases 2–7, sob demanda)                           | 5/5 aprovados (fila, distribuição, mão de obra, logística, fechamento)                      |
| Migração encadeada / backup                                   | `test-evolution-migrations.sh` ✔; `test-backup-restore.sh` ✔ (2 bancos)                   |
| Memória como processo real                                    | pico 325 MB / 512 MB, 0 erros                                                               |
| Lint, formatação, typecheck, build web                        | limpos                                                                                      |
| WebKit/Safari, aparelhos físicos                              | **NÃO TESTADO** (seção 12)                                                                  |

Falhas encontradas durante a fase e o que foi feito:

- `timezone.test.ts` — 4 falhas na reprodução (esperado) → 6/6 após a correção.
- `privacy.test.ts` — falha na reprodução (nome completo) → verde após a correção.
- `integrated-evolution.test.ts` — falhas iniciais eram premissas erradas do próprio teste
  (plano LEGADO exige data ao incluir OS; a ajuda é pedida por tapeceiro/qualidade, não pelo
  ajudante; nota de verificação mínima; estorno não gera “divergência” porque não muda o devido;
  data do Pix pelo relógio controlado). Nenhum defeito de produto; 9/9.
- `closing-perf.test.ts` — falhou após A1 porque usava a data real com o relógio congelado na
  segunda (Pix “futuro”); ajustado para a data do relógio. Em produção o relógio é o real.
- `test-evolution-migrations.sh` — ajustes do próprio script (rota inexistente no check; linhas em
  branco no `pg_dump`; a leitura grava sessão/auditoria; plano legado já ocupava a semana; três
  índices substituídos de propósito nas Fases 5–6 documentados em lista explícita).
- Carga de memória — a primeira medição foi descartada: o limite de 600 req/min por sessão devolveu
  429 (latências irreais). Refeita com uma sessão por trabalhador e ritmo abaixo do limite.

## 8. Migração e dados legados

`scripts/test-evolution-migrations.sh` (resultado: `migracao-encadeada.txt`):

1. Banco gerado pelas 12 migrations e pelo fluxo completo (32 passos) do **código legado `839770a`**:
   65 tabelas com dados; 1 OS, 8 tarefas, pagamentos 0+1+1, 81 auditorias, contas R$ 150,00,
   mão de obra R$ 1.250,00, a receber R$ 3.500,00.
2. Fotografia por valor de **todas as colunas existentes** de 98 tabelas, índices e schema.
3. `prisma migrate deploy` das 5 migrations da Evolução → **dados legados idênticos** nas 98 tabelas;
   índices preservados (3 substituídos de propósito: unicidade da mão de obra por peça **e**
   profissional; rateio por revisão); 39 índices novos; plano legado `LEGADO`, custo legado `LANCADO`.
4. Código atual lê o legado: planos, distribuição, tarefas, OS, painel financeiro, mão de obra,
   revisões, semanais, contas, fechamento (JSON/CSV), produtividade e margens — todos 200; soma da
   mão de obra igual à fonte.
5. Rollback 7→6→5→3→2 sem dados novos: **schema idêntico** ao legado (`pg_dump -s`) e dados idênticos.
6. Reaplicado; dados novos (fila, titular, divisão de obrigação, viagem devida, Pix): **cada um dos 5
   rollbacks é recusado** antes de qualquer alteração (“Reversão bloqueada: …”), schema, migrations e
   dados inalterados.
7. Backup e restauração do banco com dados de todas as fases: 111 tabelas por valor (89 com linhas).

## 9. Backup/restauração e limites do rollback

- O backup real (`scripts/backup.sh`) é `pg_dump` completo + arquivos + SHA-256: inclui todas as
  tabelas. O **teste** passou a comparar o conteúdo de todas as tabelas e o catálogo de gatilhos,
  índices e restrições (antes: contagem de lista fixa). Execuções: banco de teste (111 tabelas, 60
  com linhas) e banco com dados das Fases 2–7 (89 com linhas) — idênticos.
- **Rollback de schema não é garantido** quando já existem dados novos: todos os scripts recusam.
  A recuperação nesse caso é **restaurar o backup anterior** à atualização (perdendo o que foi
  lançado depois).
- **Imagem antiga sobre schema novo** (`sonda-imagem-antiga-schema-novo.json`): o código publicado
  hoje (`fd6dc19`) lê o banco migrado sem erro (painel, financeiro, tablet), mas **ignora a semântica
  nova** (estornos, fila, titular, revisões, fechamento). Não é um caminho de recuperação aceitável
  depois de uso real — só como contingência de minutos, antes de qualquer lançamento novo.
- Atenção operacional: a imagem da API executa `pnpm db:migrate` ao iniciar; publicar a imagem
  nova **aplica as 5 migrations** automaticamente.

## 10. Desempenho e ambiente

Ambiente: contêiner de desenvolvimento (Linux, PostgreSQL 16 em Docker local), medições locais —
**não** representam a VM de produção. Arquivos em `docs/evidencias/evolucao-fase-8/`.

| Medição (p50 / p95 ms)                          | Resultado |
| ----------------------------------------------- | --------- |
| Fila: ler fila (4 tablets)                      | 58 / 110  |
| Fila: iniciar/concluir (80 ações)               | 213 / 509 |
| Fila: publicar 200 tarefas                      | 3.982 ms  |
| Distribuição: incluir OS com distribuição       | 212 / 329 |
| Distribuição: ler distribuição (40 OS)          | 462 / 523 |
| Mão de obra: GET todas (120 valores)            | 121 / 160 |
| Logística: realização (constitui obrigação)     | 66 / 77   |
| Fechamento: GET da semana (160 obrigações)      | 77 / 105  |
| Fechamento: painel + 4 tablets simultâneos      | 100 / 142 |
| Pix registrado (baixa nas obrigações originais) | 337 / 428 |

**Memória como processo real** (`scripts/test-api-memory.sh`, `NODE_OPTIONS=--max-old-space-size=320`
como na VM e2-small, 60 s, 8 sessões do painel em paralelo): RSS ocioso **206 MB**, pico
**325 MB** (limite do contêiner 512 MB), **0 erros**. Sob carga contínua: fila 36/124; fechamento
370/607; CSV 258/369; mão de obra 312/491; plano 580/694; **distribuição 1.947/2.224** (R1). O
processo usa `tsx` (transpilação em tempo de execução): na imagem (`dist/`) o consumo tende a ser
menor. **Resiliência**: reinício da API preserva sessão do tablet, tarefa em execução, idempotência
(repetição devolve a mesma resposta, 1 evento) e a retomada do WebSocket pela sequência.

## 11. Segurança e privacidade

- **Autorização (novo teste)**: 34 rotas das Fases 2–7 × {tablet do Ricardo, tablet do Thiago,
  painel sem permissão, anônimo} → 403/401 em todas; mutação sem `Origin` ou com `Origin` estranho
  → 403, sem efeito.
- **PIN “Meus valores”**: exigido a cada abertura (sem autorização persistida no servidor),
  resposta `no-store`, ocultação automática na tela, bloqueio após tentativas (429), PIN de outra
  pessoa recusado, nenhum valor de terceiros (`labor.test` #4/#5).
- **Tablets**: nenhum valor financeiro nas respostas, WebSocket e avisos (`tablet-week` CA4-13);
  nome do cliente reduzido (A4). Logs com redação de segredos (`LOG_REDACT_PATHS`). CSV com proteção
  contra fórmula.
- **Pendente de decisão (R3)**: nome do cliente em rótulos de inspeção/avisos de qualidade.

## 12. Testes físicos pendentes e roteiro manual

**NÃO TESTADO**: Safari (MacBook), iPhone e tablets físicos; persistência de sessão em Safari atrás
do Caddy com autenticação adicional. Roteiro (usar a homologação somente após autorização):

1. **MacBook Safari (painel)** — login; abrir Financeiro → Fechamento semanal; trocar de semana e
   filtros; Detalhar; Registrar Pix (revisão → confirmar) com valor parcial; Conferir; Reabrir com
   motivo; CSV abre no Numbers com acentos; Produção → plano: reordenar a fila de um funcionário
   (motivo) e ver o tablet atualizar; fechar e reabrir o Safari → sessão continua (ou pede login
   conforme a política); repetir com a janela privada.
2. **iPhone (celular do André)** — parear; ver só as próprias retiradas/entregas, sem valores;
   “Saí para entrega” / concluir; modo avião por 1 min e voltar → reconcilia sem duplicar.
3. **Tablets (Ricardo, Márcio, João, Thiago)** — “Cheguei”; Minha semana mostra atual + próximas
   três + “Ver todas”; iniciar/pausar/retomar/concluir; desligar o Wi-Fi durante uma ação e religar
   → sem ação duplicada; o gestor reordena → aparece sem recarregar; cliente aparece como “Nome I.”;
   Ricardo abre “Meus valores” com PIN, a tela some sozinha; PIN errado várias vezes → bloqueio;
   João não vê “Meus valores”.
4. **Caddy/HTTPS** — certificado válido, WebSocket ativo (indicador “Tempo real ativo”), autenticação
   adicional pedida uma vez por sessão no Safari.

Registrar por aparelho: modelo, sistema, navegador, resultado e captura.

## 13. Riscos e limitações

- Medições locais ≠ produção; e2-small compartilha CPU (rajadas).
- R1 (distribuição lenta sob carga): leitura linear por peça; proposta — cache por plano ou
  paginação (fase futura, P2).
- R2/R3: ver seção 4 (propostas que dependem de decisão).
- **Comprovantes e exportações (escopo controlado)**: comprovante só como referência textual e
  exportação só CSV; **não implementado** upload nem PDF. Recomendação: **P2** — upload de
  comprovante reaproveitando os anexos protegidos (validação de tipo, tamanho, acesso só do
  financeiro, retenção) ≈ 1–2 dias; PDF do fechamento ≈ 1 dia. Fase futura, mediante aprovação.
- Rollback de schema impossível com dados novos (por desenho) — recuperação = restauração.

## 14. Runbook de publicação futura (somente documentação — NÃO executado)

Pré-requisito: autorização explícita do proprietário para publicar o SHA final desta fase.

1. **SHA aprovado**: HEAD final desta fase; conferir `git log --oneline -1` no Cloud Shell. Etiqueta
   da imagem = SHA (nunca `latest`).
2. **Revisão**: 5 migrations novas (`20261018…` a `20261115…`), todas aditivas; rollbacks em
   `packages/db/rollback/` recusam com dados novos. Reexecutar localmente
   `scripts/test-evolution-migrations.sh` no SHA aprovado.
3. **Custo**: build no Cloud Build (minutos gratuitos/baixo custo) + armazenamento no Artifact
   Registry (centavos); VM e disco inalterados. Conferir o alerta de orçamento antes.
4. **Recursos na VM**: `free -m` (≥ 300 MB livres + swap ativo), `df -h` (≥ 2 GB livres),
   `docker stats` estável; API com heap 320 MB / contêiner 512 MB (pico medido 325 MB).
5. **Backup e teste de restauração** (obrigatórios): `vm.sh backup` → `vm.sh restaurar-teste` deve
   concluir; anotar a pasta do backup; `vm.sh enviar-backups` (cópia fora da VM).
6. **Janela**: avisar a equipe; nenhum tablet em execução; nenhum fechamento/Pix sendo registrado.
7. **Deploy com checkpoints**: build da imagem do SHA; `vm.sh atualizar <SHA>` (faz backup, troca as
   imagens e inicia; a API aplica as migrations ao iniciar). Checkpoints: (a) `vm.sh saude`;
   (b) `prisma migrate status` = 17 aplicadas; (c) login do gestor; (d) um tablet abre Minha semana.
8. **Testes pós-deploy** (dados fictícios da homologação): fechamento da semana abre e exporta CSV;
   criar OS de teste com duas peças → distribuição; tablet inicia/conclui; “Meus valores” com PIN;
   cliente aparece reduzido no tablet; WebSocket ativo.
9. **Monitoramento** (24 h): logs da API (erros 5xx), `docker stats` (RSS < 450 MB), espaço em disco,
   certificados.
10. **Critérios de abortar**: migration falhou; `saude` falha após 2 tentativas; RSS > 480 MB
    sustentado; qualquer valor financeiro divergente; tablet sem sincronizar.
11. **Retorno de serviço**: _antes_ de qualquer lançamento novo — `vm.sh atualizar fd6dc19` (imagem
    antiga lê o schema novo, sonda da seção 9) e, se necessário, os scripts de rollback 7→2 (só
    funcionam sem dados novos). _Depois_ de lançamentos novos — **restaurar o backup do passo 5**
    (`vm.sh restaurar <pasta> --sim`) **e** `vm.sh atualizar fd6dc19`, aceitando a perda do que foi
    lançado após o deploy (janela curta e registro manual das operações do período como mitigação).
12. **Preservar**: segredos, Caddy/HTTPS, banco e dados existentes; não tocar no VerificaPro.

## 15. Decisão GO / NO-GO

**Homologação — GO técnico para PREPARAR a homologação**, com a regressão final verde (API 377/377,
E2E 27/27, shared 77/77): zero P0; correções P1 com teste;
segurança financeira e isolamento aprovados; migração, rollback condicionado e restauração
verificados; riscos residuais documentados. **GO técnico não é autorização de publicação.**

**Uso real em campo — NO-GO por enquanto (GO condicionado)**: exige validação física em Safari,
iPhone e tablets (seção 12) e aceite explícito do proprietário.
