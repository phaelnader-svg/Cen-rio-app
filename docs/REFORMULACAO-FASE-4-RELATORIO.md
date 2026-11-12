# Reformulação — Fase 4: relatório técnico

Tudo foi feito **somente no ambiente de desenvolvimento isolado** (PostgreSQL 16 local e
descartável, navegador local). Nenhum deploy, merge, migration em ambiente compartilhado ou
alteração da homologação (ativa `3e0d2d0`, candidata `de31aa7`), da candidata de retorno, do
branch padrão ou da produção. A homologação manual integrada **não** foi iniciada.

- Branch: `claude/reformulacao-fase-4`, derivada de `781e3b8` (commit final validado da Fase 3).
- Commits: `5f86201` (API, parcial), `2bba804` (fase completa), e o commit deste relatório.
- Legenda: **[TESTADO]** coberto por teste que passou · **[MEDIDO]** observado em execução isolada
  · **[INSPECIONADO]** verificado por leitura de código ou captura · **[NÃO TESTADO]**.

## 1. Escopo e entregas

| #   | Escopo               | Entrega                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Painel diário        | Seção **"Hoje"** no Início: serviços em execução (tarefas em execução/pausadas), quem está na oficina (presença do dia sem saída), peças prontas aguardando entrega (com dias parada), pendências (mesma Central de atenção, 5 primeiras) e os alertas internos do usuário. Rota `GET /api/v1/management/today`; cada seção só vem para quem já podia ver o dado. |
| 2   | Alertas internos     | `PRAZO_EM_RISCO` (motor de prazos: em risco/atrasado → `os.gerenciar`), `PECA_PRONTA_SEM_ENTREGA` (pronta há 2+ dias → `entregas.gerenciar`), `MATERIAL_FALTANTE` (produção nos próximos 2 dias com material pendente → `os.gerenciar` e `compras.gerenciar`). **Só o sininho interno**: nenhum e-mail, WhatsApp ou outro canal.                                  |
| 3   | Produtividade        | Consulta reescrita em lote (mesma regra): o número de consultas deixou de crescer com a equipe. Nova rota `GET /api/v1/production/productivity` (`producao.planejar`) e aba **"Produtividade"** na Programação semanal. Só contagens, minutos e percentuais; a rota do Financeiro continua igual (`financeiro.ver`).                                              |
| 4   | Ações sugeridas hoje | Montadas dos mecanismos existentes (prazos, estado da OS da Fase 0, pré-planejamento, qualidade, peças prontas, materiais, Central de atenção). Cada uma tem **título, porquê e link**; nenhuma tem botão de ação nem executa nada.                                                                                                                               |

## 2. Arquivos e migration

**Sem migration.** O tipo do aviso (`notifications.kind`) já é texto livre; nada no schema mudou
(`git diff 781e3b8 -- packages/db` vazio).

- API: `modules/management/today.ts` (novo: alertas + painel), `modules/production/productivity.ts`
  (novo), `modules/finance/results.ts` (`productivity()` em lote), `modules/production/plans.ts` e
  `core/permissions.ts` (`loadUsersPermissions`: permissões da equipe em 2 consultas), `app.ts`
  (rotas e cronômetro de 5 min dos alertas, desligado nos testes como os demais).
- Shared: `today.ts` (DTOs e limites), três tipos de aviso em `production-domain.ts`.
- Web: `components/admin/today-panel.tsx` (novo), `dashboard.tsx`,
  `components/finance/productivity-table.tsx` (tabela compartilhada), `finance-page.tsx`,
  `components/production/productivity-tab.tsx` (novo), `weekly-schedule-page.tsx`.
- Testes: `apps/api/test/fase4-hoje-alertas.test.ts` (9), `tests/e2e/specs/zz-fase4-hoje.spec.ts`
  (2), mapa de acesso em `rodada4-travas-estruturais.test.ts` (2 rotas novas).

## 3. Pontos de atenção

### 3.1 Alertas: idempotência, resolução e isolamento [TESTADO]

- Chave estável por fato (`PRAZO_EM_RISCO:<os>:<estado>`, `PECA_PRONTA_SEM_ENTREGA:<peça>:<dia>`,
  `MATERIAL_FALTANTE:<os>`) + o mecanismo de aviso já existente: recalcular não duplica.
- Trava consultiva (`pg_try_advisory_xact_lock`): recálculos simultâneos não se atropelam (teste
  com 4 em paralelo → 1 aviso por pessoa).
- Quando o fato deixa de existir (prazo renegociado, peça entregue, material chegou), o aviso é
  resolvido sozinho.
- O recálculo não altera OS, peças, tarefas, entregas, materiais, contas a pagar ou a receber
  (teste compara o estado antes/depois).

### 3.2 Painel "Hoje" e sugestões [TESTADO]

- Seções por permissão (sem permissão = `null`, nunca zero); usuário só com `clientes.ver` → 403.
- Nenhuma chave de valor (`*Cents`, preço, custo, salário…) no painel, para nenhum perfil.
- Sugestões: cada item tem exatamente `key, title, why, link, priority`; o E2E confere que não há
  botões dentro do bloco. Ler o painel não altera nada.

### 3.3 Produtividade [TESTADO + MEDIDO]

- A rota operacional devolve **as mesmas linhas** da rota do Financeiro e nenhuma chave de valor.
- Quem tem só `producao.planejar` recebe 403 na rota do Financeiro; quem tem só `producao.ver`
  recebe 403 na operacional. Permissões financeiras preservadas.
- Lentidão: antes eram ~7 consultas por pessoa + 1 por tarefa concluída. Medido por contagem de
  consultas: **19 consultas fixas**, iguais com 7 ou 13 pessoas (antes da correção do carregamento
  de permissões, o mesmo teste mostrava 19 → 31). O teste da produtividade do Financeiro
  (`finance.test.ts`) continua passando com a nova implementação.

## 4. Testes

Ver a seção 8 (rodada final). Testes novos: API 9/9, E2E 2/2 (1440 e 390 px).

## 5. Migrations e recuperação

Nada novo no banco. A recuperação da Fase 4 é só de aplicação: voltar para o código da Fase 3
(`781e3b8`) funciona sobre o mesmo schema. Antes de voltar, resolver os avisos novos para que o
código anterior não mostre avisos de um tipo que ele não conhece:
`UPDATE notifications SET resolved_at = now() WHERE resolved_at IS NULL AND kind IN
('PRAZO_EM_RISCO','PECA_PRONTA_SEM_ENTREGA','MATERIAL_FALTANTE');` [INSPECIONADO]

## 6. Capturas

`docs/evidencias/reformulacao-fase-4/`: `inicio-hoje-{desktop,mobile}.png` e
`programacao-produtividade-{desktop,mobile}.png` (1440 px e 390 px). Banco E2E recém-criado: as
seções aparecem vazias, com uma OS sem programação para mostrar a sugestão "Planejar".

## 7. Riscos da Fase 4

1. Os alertas são recalculados a cada 5 minutos: um fato pode levar até 5 min para aparecer ou
   sumir no sininho. O painel "Hoje" (peças, execução, sugestões) é calculado na hora.
2. Quem tem `os.gerenciar` e `compras.gerenciar` ao mesmo tempo recebe **um** aviso de material
   por OS, não dois (a chave é por usuário). [TESTADO, com o gestor, que tem as duas]
3. "Pronta desde" usa o último evento de etapa da peça. Peças que ficaram prontas antes da
   existência desse evento contam 0 dia (não geram alerta) — risco de alerta a menos, nunca a
   mais. [INSPECIONADO]
4. Quantidade de avisos numa oficina com muitas OS atrasadas: um por OS por gestor. Sem limite de
   volume; se ficar ruidoso, ajustar os limites (`READY_WITHOUT_DELIVERY_DAYS`,
   `MATERIAL_ALERT_DAYS`).
5. Não validado em tablet físico nem Safari; não validado em homologação.

## 8. Resultado final

- **Totais (rodada final, ponta da Fase 4):** shared 151/151 · web 22/22 · API **1009 passaram,
  0 falharam, 13 pulados** (opcionais de desempenho e proxy, como antes) · E2E completo **68/68**
  (66 anteriores + 2 da Fase 4, sem nenhuma falha na rodada) · typecheck, lint, formatação e build
  (API e web) sem erros.
- **Migrations:** cadeia completa (`scripts/test-evolution-migrations.sh`) aprovada: aplica,
  reverte, reaplica idêntico; recusa atômica com dados de cada fase; backup e restauração.
- **Compatibilidade:** a Fase 4 não tem migration; o schema é o mesmo validado na Fase 3
  (`3e0d2d0` + pastas das Fases 2 e 3: 971 passaram, 1 falha estática esperada, 13 pulados). Não
  foi reexecutada, porque nada no banco mudou.
- **Rodada anterior:** a 1ª rodada da API teve 2 falhas no teste de travas estruturais, causadas
  por eu ter acrescentado as 2 rotas novas à **linha de base congelada** de `9fb1786`. Desfeito
  (a linha de base não deve mudar); nenhuma mudança na aplicação.

**Veredito: GO COM RESSALVAS** para aprovação técnica da Fase 4. Ressalvas: alertas com até 5 min
de atraso e sem limite de volume; "pronta desde" conta a menos para peças antigas; nada validado em
homologação, tablet físico ou Safari.
