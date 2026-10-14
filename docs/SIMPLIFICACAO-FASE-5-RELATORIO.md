# Simplificação — Fase 5/10: Modelos de produção simplificados

> Tudo foi executado **localmente**, em PostgreSQL 16 local (127.0.0.1) e com **dados fictícios**.
> Nada foi publicado. Não houve deploy, commit, push, merge nem troca de branch; nenhuma migration
> em homologação ou produção; nenhum acesso a GCP, VM, SSH, Cloud Shell ou Docker remoto; nenhum
> script da auditoria de infraestrutura foi executado. Decisões aprovadas e aplicadas: **D6, D7,
> D8 e D14**.

## 1. Branch e HEAD

| Item                   | Valor                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Branch                 | `claude/cenario-gestao-fase-1-zf3bj2` (inalterada)                                        |
| HEAD inicial           | `a42b16f3d88c598a49bf78a28afb1ae0b9c77883`, árvore limpa                                  |
| HEAD final             | o mesmo `a42b16f` — **sem commit** (alterações na árvore de trabalho, aguardando revisão) |
| Última migration antes | `20261228000000_titular_mao_de_obra_prevista`                                             |

## 2. Arquivos alterados e justificativa

| Arquivo                                                               | Justificativa                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/production-domain.ts`                            | `SIMPLIFIED_PRODUCTION_TEMPLATES`: os dois modelos novos (ids fixos, iguais aos da migration).                                                                                                                                                                                                                                                                             |
| `packages/shared/src/distribution-domain.ts`                          | `selectProductionTemplate` (regra única de escolha) e `stepAssigneeProblem` (tapeçaria nunca tem responsável padrão).                                                                                                                                                                                                                                                      |
| `packages/shared/src/schemas/production.ts`, `types-production.ts`    | Modelo: `serviceTypes`; etapa: `defaultAssigneeUserId` (validação e DTO).                                                                                                                                                                                                                                                                                                  |
| `packages/shared/src/quality-domain.ts`                               | `canDecideInspection` (D8): quem executou nunca decide — inclusive o gestor; a antiga "autorização do executor" deixou de liberar.                                                                                                                                                                                                                                         |
| `packages/shared/src/schemas/quality.ts`                              | Comentário: `authorizeExecutor` mantido só por compatibilidade.                                                                                                                                                                                                                                                                                                            |
| `packages/db/prisma/schema.prisma`                                    | `production_templates.service_types`; `production_template_steps.default_assignee_user_id` (FK para `users`).                                                                                                                                                                                                                                                              |
| `packages/db/prisma/migrations/20261230000000_modelos_simplificados/` | Migration de schema + dados (seção 3).                                                                                                                                                                                                                                                                                                                                     |
| `packages/db/rollback/20261230000000_modelos_simplificados.down.sql`  | Reversão condicionada.                                                                                                                                                                                                                                                                                                                                                     |
| `packages/db/src/seed.ts`                                             | Responsável inicial da etapa de preparação dos modelos novos (João na reforma, Thiago na cabeceira) só em modelo **nunca editado** (versão 1), etapa vazia e com **um único** funcionário ativo com o nome; ajuste final (seção 11).                                                                                                                                       |
| `apps/api/src/modules/production/distribution.ts`                     | `templateFor` usa a regra única (peça + serviço; geral como fallback); responsável por etapa com precedência sobre o global; leitura de pendências com a mesma regra.                                                                                                                                                                                                      |
| `apps/api/src/modules/production/pre-planning.ts`                     | "A planejar" mostra/valida o modelo pela mesma regra (antes: só tipo de peça).                                                                                                                                                                                                                                                                                             |
| `apps/api/src/modules/production/plans.ts`                            | Cadastro de modelos: grava/devolve tipos de serviço e responsável por etapa; recusa responsável em tapeçaria (também com classe derivada) e quem não executa produção.                                                                                                                                                                                                     |
| `apps/api/src/modules/quality/inspections.ts`                         | D8: decisão e designação de inspetor recusam o executor (sem exceção).                                                                                                                                                                                                                                                                                                     |
| `apps/web/components/production/templates-page.tsx`                   | Editor de modelos: tipos de serviço e "Responsável padrão" por etapa (sem isso, salvar apagaria a configuração).                                                                                                                                                                                                                                                           |
| `apps/web/components/quality/quality-pages.tsx`                       | Removida a opção "Autorizo quem executou o serviço a inspecionar" (D8).                                                                                                                                                                                                                                                                                                    |
| `scripts/test-evolution-migrations.sh`                                | Inclui a migration nova nas reversões e confere os modelos legados à parte (a migration acrescenta registros por desenho).                                                                                                                                                                                                                                                 |
| Testes                                                                | `packages/shared/test/modelos-simplificados.test.ts` (novo), `packages/shared/test/quality.test.ts`, `apps/api/test/modelos-simplificados.test.ts` (novo), `apps/api/test/quality.test.ts`, `apps/api/test/migrations.test.ts`, `apps/api/test/evolution-migration.check.ts`, `tests/e2e/specs/modelos-simplificados.spec.ts` (novo), `tests/e2e/specs/team-week.spec.ts`. |

**Não alterados:** `apps/api/src/modules/finance/**` e `packages/shared/src/finance-domain.ts`
(`git diff` vazio) — nenhuma fórmula, valor, titularidade financeira ou regra de remuneração mudou.

## 3. Migrations e rollback

`20261230000000_modelos_simplificados` (aditiva):

- `production_templates.service_types service_type[] DEFAULT '{}'` — modelos existentes ficam
  "gerais" (comportamento anterior);
- `production_template_steps.default_assignee_user_id UUID` + FK `users` (`ON DELETE RESTRICT`);
- CHECK `production_template_steps_default_assignee_not_upholstery`: etapa TAPECARIA nunca tem
  responsável padrão;
- dados: os dois modelos novos com **ids fixos** e `WHERE NOT EXISTS` (idempotente); nenhum
  modelo existente é editado, desativado ou apagado.

Rollback (`packages/db/rollback/…down.sql`), manual, com backup e aplicação parada. **Recusa**
sem alterar nada se: houver tarefa gerada por um modelo simplificado; ou outro modelo tiver tipo
de serviço / outra etapa tiver responsável padrão (configuração do gestor se perderia). Sem uso,
remove os dois modelos, as colunas, as restrições e o registro em `_prisma_migrations`.

Validação: `prisma migrate deploy` num banco local vazio + `prisma migrate diff` (banco × schema)
= vazio; teste de migration (seção 6); script de migrações encadeadas (seção 6).

## 4. Modelos e regras implementados

| Modelo                                  | Peças              | Serviço          | Etapas (classe → responsável)                                                                                                                                                  |
| --------------------------------------- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reforma de estofados (simplificado)     | Sofá, canto alemão | Reforma completa | 1. Desmontagem e preparação (PREPARACAO → padrão da etapa: João) · 2. Corte e costura (TAPECARIA → titular) · 3. Montagem e acabamento (TAPECARIA → titular; depende de 1 e 2) |
| Fabricação de cabeceiras (simplificado) | Cabeceira          | Fabricação       | 1. Corte e preparação (PREPARACAO → padrão da etapa: Thiago) · 2. Tapeçaria e acabamento (TAPECARIA → titular; depende de 1)                                                   |

- **Escolha (D6):** só modelos ativos com o tipo de peça; primeiro o específico do serviço, senão
  o geral (antigo); empate = o mais antigo. Inativo nunca é escolhido. As demais combinações
  (ex.: sofá em troca de tecido, cabeceira em reparo, poltronas) seguem nos modelos antigos.
- **Titular:** regra existente, sem mudança (titular por peça; tapeçaria só com ele; gatilho do
  banco). **D7:** Thiago só é titular se tiver a competência `CORTE_COSTURA`, concedida pelo
  cadastro de competências — nenhum nome no código de regra. Com Thiago titular, as duas etapas
  da cabeceira ficam com ele (preparação pelo padrão da etapa, tapeçaria pelo titular).
- **Responsável por etapa:** padrão da etapa → senão o global da preparação (fallback). Padrão
  inelegível (inativo/sem competência) = pendência visível, nunca outra pessoa. Tarefas já geradas
  não mudam (só um responsável vazio é completado ao reprocessar, regra existente).
- **D8:** ninguém decide (aprovar/reprovar) a peça que executou — nem o gestor; o executor não pode
  ser designado inspetor, nem com "autorização". O gestor executor usa a designação existente de
  inspetor substituto; quem não executou decide normalmente.
- **D14:** mão de obra inalterada (seção 7).
- **Configuração inicial:** o seed preenche João e Thiago nas etapas de preparação dos modelos
  novos só enquanto o modelo não foi editado pelo gestor (versão 1) e a etapa está vazia; o
  gestor altera em Produção → Modelos e o seed nunca sobrescreve (seção 11).

## 5. Matriz CA5

| CA     | Critério                                                                                                                | Testes                                                                                                                                                                      | Resultado |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| CA5-01 | Reforma: exatamente 3 tarefas, João + titular + titular                                                                 | API `modelos-simplificados` "CA5-01" (inclui dependências, canto alemão, troca de tecido no modelo antigo, "A planejar"); E2E `modelos-simplificados.spec.ts`               | ✔        |
| CA5-02 | Cabeceira: 2 tarefas; Thiago titular por competência faz as duas; Ricardo/Márcio → Thiago prepara, titular na tapeçaria | API "CA5-02" (recusa sem competência, concessão pelo cadastro, Ricardo, Márcio, reparo no modelo antigo)                                                                    | ✔        |
| CA5-03 | Executor nunca aprova a própria peça, inclusive o gestor; substituto autorizado decide                                  | API `quality` casos 4 e 4b (aprovar, reprovar, designar a si mesmo, "autorização" recusada, tablet do executor); shared `quality` (regra pura)                              | ✔        |
| CA5-04 | Serviço em andamento mantém modelo e tarefas                                                                            | API "CA5-04" (tarefa iniciada; reprocessar e pedir troca de modelo não alteram nada; serviço novo usa o modelo novo)                                                        | ✔        |
| CA5-05 | Mão de obra inalterada                                                                                                  | API "CA5-05" (gerar não cria valor; mesmo resultado no modelo novo e no antigo; valor só com o titular; Thiago e João seguem sem obrigação por peça); `finance/**` sem diff | ✔        |
| CA5-06 | Sem duplicação (repetida e concorrente)                                                                                 | API "CA5-06" (reprocessar 1+3 concorrentes; mesma OS em outra semana 201/409; índice único recusa duplicata; reversão bloqueada por tarefas)                                | ✔        |
| Extra  | Responsável por etapa, cadastro e inatividade                                                                           | API "responsável por etapa…" e "cadastro do modelo…"; shared `modelos-simplificados`                                                                                        | ✔        |

## 6. Suítes executadas (locais)

| Comando                                                                   | Resultado                                                                                | Código |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| `cd packages/shared && npx vitest run --dir test`                         | 15 arquivos, **87/87**                                                                   | 0      |
| `cd apps/api && npx vitest run test/modelos-simplificados.test.ts`        | **7/7**                                                                                  | 0      |
| `cd apps/api && npx vitest run test/migrations.test.ts`                   | **11/11**                                                                                | 0      |
| `cd apps/api && npx vitest run` (suíte completa da API)                   | 49 arquivos aprovados, 6 ignorados; **500 aprovados, 10 ignorados**                      | 0      |
| `pnpm --filter @cenario/e2e test` (build + E2E) — 1ª execução             | 36 aprovados, **2 falharam** (ver abaixo)                                                | 1      |
| `pnpm --filter @cenario/e2e test:only` — após as correções                | **38/38**                                                                                | 0      |
| `PG_BASE=<local> bash scripts/test-evolution-migrations.sh` — 1ª execução | falhou na comparação de dados legados (ver abaixo)                                       | 1      |
| idem, após o ajuste do script                                             | migração encadeada, 13 reversões limpas, 11 recusas atômicas, backup/restauração: **ok** | 0      |
| `pnpm lint`                                                               | sem erros/avisos                                                                         | 0      |
| `pnpm format:check`                                                       | conforme                                                                                 | 0      |
| `pnpm -r typecheck`                                                       | 5 pacotes sem erro                                                                       | 0      |

Ignorados na API: suítes de desempenho (`*-perf`, só com variável de ativação) e a do Caddy
(exige Caddy) — condicionais por desenho; nenhum teste novo ignorado.

Falhas encontradas e tratamento (nenhuma ocultada):

1. **E2E `modelos-simplificados`** — seletor do próprio teste (`Titular da peça` também casava com
   a opção "Tapeçaria (titular da peça)"); corrigido com `exact`.
2. **E2E `team-week` (Evolução Fase 4, "Minha semana")** — consequência **esperada** do D6: com o
   sofá em reforma completa no modelo novo, o João passa de 4 para 3 tarefas e o cenário deixa de
   conseguir provar o limite "até três próximas" (CA4-03). Não é regressão da Fase 4. Correção:
   o fixture escolhe **explicitamente** o modelo antigo para o sofá (opção de modelo por peça já
   existente); **nenhuma asserção mudou**.
3. **Script de migrações encadeadas** — a comparação de tabelas inteiras acusou as linhas novas em
   `production_templates/_steps` (acréscimo por desenho, como já ocorria com `role_permissions`).
   Ajuste: essas duas tabelas passam a ser comparadas só nos registros legados (todas as colunas
   legadas) e, após a reversão, exige-se que os modelos novos não existam mais.

Testes existentes alterados por decisão aprovada (não para aceitar erro):
`apps/api/test/quality.test.ts` caso 4 e `packages/shared/test/quality.test.ts` afirmavam que o
executor "autorizado pelo gestor" aprovava a própria peça — exatamente o que o D8 proíbe; passaram
a provar a recusa.

## 7. Preservação

- **Fases 1–4:** nenhum código delas foi reescrito; regressão completa da API e do E2E verde. O
  único ajuste em teste antigo além do D8 é o fixture do `team-week` (item 2 acima).
- **Registros legados:** modelos antigos intactos (registros, etapas, versão — provado no teste de
  migration e no script encadeado); tarefas já geradas mantêm modelo, versão e responsáveis
  (CA5-04).
- **Regras financeiras (D14):** `finance/**` sem alteração; CA5-05.

## 8. Pendências reais

1. **Configuração em instalações existentes:** a migration cria os modelos sem responsável por
   etapa; o seed (procedimento `migrate → seed` do runbook) preenche João/Thiago só se houver
   **exatamente um** funcionário ativo com esse nome e o modelo ainda não tiver sido editado.
   Funcionários não têm identificador estável além do id (o nome não é único) e as configurações
   existentes (responsável global da preparação, inspetor, equipe própria) têm outro significado,
   por isso não foram reaproveitadas. Ausente ou repetido: nada é configurado, o motivo aparece no
   log do seed e o gestor configura em Produção → Modelos. Sem configuração, a preparação da
   cabeceira cai no responsável global (João).
2. **D7 é configuração:** enquanto o Thiago não receber `CORTE_COSTURA`, não pode ser titular de
   cabeceira (recusa explícita).
3. **D8 na prática:** se o Thiago (inspetor principal) executa a cabeceira, a inspeção sempre pede
   substituto ou decisão de um gestor que não executou; a configuração antiga de
   `executorAuthorizedById` em inspeções abertas deixa de valer (o gestor redesigna).
4. **Abrangência dos modelos novos:** só "reforma completa" (sofá/canto alemão) e "fabricação"
   (cabeceira). Outros serviços seguem nos modelos antigos; ampliar é configuração (tipos de
   serviço no cadastro), não código.
5. **Testes de API usam o seed (só modelos antigos):** as suítes antigas continuam exercitando os
   modelos gerais; os modelos novos são exercitados pela suíte própria (instalada pelos mesmos
   comandos da migration), pelo E2E e pelo script encadeado — que usam migrations reais.
6. Não verificado: Safari/WebKit e tablets físicos; homologação (fora do escopo).

## 9. Confirmação

Não houve deploy, acesso remoto (GCP, VM, SSH, Cloud Shell, Docker remoto), migration em ambiente
real, SQL em banco real, commit, push, merge, troca de branch nem alteração de infraestrutura. O
banco usado foi o PostgreSQL local (bancos `cenario_test`, `cenario_e2e_test`, um banco de
rascunho já removido e o `cenario_evo_migration_test` do script, removido ao final); a worktree
temporária do script foi removida.

## 10. Recomendação

**Fase 5 concluída** (implementação, migrations, CA5-01 a CA5-06 com evidência executada e
regressão verde), **aguardando revisão** e autorização para commit. A Fase 6 não foi iniciada.

## 11. Ajuste final do seed (após a revisão independente)

- **Antes:** o seed preenchia o responsável inicial sempre que a etapa estava vazia e escolhia
  o primeiro funcionário com o nome (`findFirst`). Como o procedimento de publicação roda
  `migrate → seed`, uma etapa esvaziada de propósito pelo gestor (decisão de usar o responsável
  global) voltaria a ser preenchida; nomes repetidos levariam a uma escolha arbitrária.
- **Agora (`packages/db/src/seed.ts`):** preenche só se o modelo simplificado está na **versão 1**
  (toda gravação pelo cadastro incrementa a versão; a migration grava 1; o próprio seed não
  altera a versão), a etapa de preparação está vazia e existe **um único** funcionário ativo com
  o nome exato. Caso contrário não altera nada e registra o motivo no log. Modelos antigos nunca
  são tocados. Distribuição, competências, inspeção e financeiro: sem alteração.
- **Testes** (`apps/api/test/modelos-simplificados.test.ts`, describe "Seed dos modelos
  simplificados"): modelo não editado e vazio → João/Thiago aplicados; seed repetido não muda
  nenhuma etapa e os modelos antigos seguem sem responsável; modelo editado com etapa vazia →
  continua vazia; modelo editado com outro responsável → preservado após três execuções;
  funcionário ausente → nada configurado e motivo no log; dois "Thiago" ativos → nada
  configurado e motivo no log; com um único João de novo → aplicado.
- **Execução:** `npx vitest run test/modelos-simplificados.test.ts test/migrations.test.ts` →
  **21/21** (código 0); E2E `modelos-simplificados.spec.ts` (banco E2E criado por migrations +
  seed oficiais) → **1/1**; typecheck de `@cenario/db` e `@cenario/api`, eslint e prettier dos
  arquivos alterados → sem erros. A bateria completa não foi repetida (ajuste restrito ao seed e
  aos seus testes).
