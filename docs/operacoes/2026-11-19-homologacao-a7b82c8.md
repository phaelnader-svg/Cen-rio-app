# 19/11/2026 — Homologação de `a7b82c8` (ajudante livre pega a preparação + company.id para aplicativos)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma tarefa iniciada, nenhum plano criado.

- Commit: `a7b82c8489c1e832f9ac1ce5e43536de7b3dbb89` (branch `claude/project-thread-9nydrz`; `git cat-file -t` = `commit`; o `FETCH_HEAD` era esse mesmo hash), sobre `70b8d51`. O diff tem 33 arquivos (+784 −377). Sem rota nova, variável nem `infra/`. Em `packages/db`: a migration abaixo, a reversão e `src/seed.ts`.
- Versão antes: `70b8d51c37840c34ec8a33e5735abf154fa44668` · depois: `a7b82c8489c1e832f9ac1ce5e43536de7b3dbb89` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `7e52c1dc-8598-43b4-8c35-387225a3da5c`: SUCCESS (14:29:19 → 14:35:05 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:e512af0dc951f9b1ca46e36b3ddf83371095244514b1ed1f70684a752d29cff1`
  - web `sha256:e232dd99bd8dff2a1539851a74a2b8a01bcaadde0d242a11a34c315fe70bae76`
- Migration: `20270901000000_preparacao_livre` (2 comandos, só dados), aplicada em **44 s**. Ela tira o responsável das tarefas de preparação de planos `FILA_SEMANAL` ainda não iniciadas (`RASCUNHO`, `BLOQUEADA`, `PROGRAMADA`, `LIBERADA`) e o responsável padrão dos passos de preparação dos modelos. Nenhuma tabela ou coluna muda. Reversão: `packages/db/rollback/20270901000000_preparacao_livre.down.sql`.
- Ponto de recuperação: `cenario-staging-20261119T143739Z` (versão `70b8d51`, impressão `5ef9fd6eafe5b437fa9618ccdb42532b`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 14:28       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `70b8d51`; saudável; portão fechado; disco 52% (14 GB livres, sem limpeza)                                                |
| 14:29–14:35 | imagens (ausentes) → build-iniciar / build-acompanhar                  | SUCCESS                                                                                                                                   |
| 14:35:19    | gate_open                                                              | aberto                                                                                                                                    |
| 14:35:23    | prepare_version                                                        | OK; digests acima; imagem: 55 migrations, banco: 54; disco livre 12 GB                                                                    |
| 14:37:00    | migration_precheck                                                     | exatamente 1 pendente: `20270901000000_preparacao_livre`; esquema compatível                                                              |
| 14:37       | database_fingerprint e database_counts (antes)                         | registradas (`production_tasks` 10, `production_plans` 2, `production_template_steps` 19)                                                 |
| 14:37:30    | maintenance_on                                                         | API e web paradas (14:37:33). Necessário porque o `recovery_point_create` exige manutenção                                                |
| 14:37:36    | recovery_point_create                                                  | `cenario-staging-20261119T143739Z`                                                                                                        |
| 14:38:41    | backup_validate                                                        | SHA256SUMS conferido                                                                                                                      |
| 14:38:45    | migrate                                                                | 1 aplicada em 44 s                                                                                                                        |
| 14:39:39    | migration_verify                                                       | 55/55, nenhuma pendente                                                                                                                   |
| 14:39:45    | activate_version                                                       | Saúde OK (disco 61%, memória 1011 MB); API e web de pé, então o `maintenance_off` não foi necessário                                      |
| 14:41:0x    | gate_close                                                             | fechado                                                                                                                                   |
| 14:41:21    | database_fingerprint (logo depois da migration)                        | `production_tasks` e `production_template_steps` com impressão idêntica à de antes                                                        |
| 14:41+      | version, smoke_test, websocket_test, run_homologation_tests `completo` | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔                                                         |
| 14:45:32    | database_counts, database_fingerprint (depois), logs                   | depois de um ciclo de 5 min do timer; api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`** e **nenhuma falha de timer** |

Indisponibilidade: cerca de 3 min 30 s (14:37:33 → ~14:41:00).

## Preparações que ficaram livres: **0**

O catálogo de operações não tem consulta SQL livre, então a contagem pedida no passo 3 não pôde ser
feita diretamente. O efeito foi medido pela impressão digital. A migration grava
`assignee_user_id = NULL`, `version + 1` e `updated_at = now()` em cada tarefa que pega, e
`default_assignee_user_id = NULL` em cada passo de modelo que pega. Mesmo assim, as impressões de
`production_tasks` (10 linhas) e `production_template_steps` (19 linhas) ficaram **idênticas** antes e
depois. Portanto, na homologação a migration **não alterou nenhuma linha**: nenhuma preparação ficou
livre e nenhum modelo perdeu responsável padrão. Ela não teve dados elegíveis aqui; o efeito real fica
para a produção.

## Contagens e impressão digital antes/depois

177 tabelas antes e depois, 55/55 migrations, estrutura igual. **Nenhuma contagem caiu e nenhuma
tabela mudou de conteúdo.** Cresceram só `_prisma_migrations` (54 → 55) e `status_samples`
(571 → 573, a amostra periódica).

## Testes (passo 5)

A suíte `completo` da VM roda só saúde, acesso e websocket. Os testes da lista são do repositório e
foram rodados no commit exato (worktree de `a7b82c8`, `pnpm install --frozen-lockfile`), contra um
banco PostgreSQL 16 local e descartável, criado do zero pelas 55 migrations:

| Arquivo                                              | Resultado    |
| ---------------------------------------------------- | ------------ |
| `apps/api/test/preparacao-livre.test.ts`             | **2 de 2**   |
| `apps/api/test/distribution.test.ts`                 | **9 de 9**   |
| `apps/api/test/tablet-week.test.ts`                  | **4 de 4**   |
| `apps/api/test/pre-planejamento.test.ts`             | **25 de 25** |
| `apps/api/test/modelos-simplificados.test.ts`        | **8 de 8**   |
| `apps/api/test/privacy.test.ts`                      | **2 de 2**   |
| `apps/api/test/autorizacao-aplicativos.test.ts`      | **7 de 7**   |
| `apps/api/test/jogo-planta.test.ts`                  | **5 de 5**   |
| `apps/api/test/jogo-agentes.test.ts`                 | **3 de 3**   |
| `apps/api/test/multi-empresa-vazamento.test.ts`      | **4 de 4**   |
| `apps/api/test/criar-conta.test.ts`                  | **12 de 12** |
| `packages/shared/test/distribution.test.ts`          | **4 de 4**   |
| `packages/shared/test/modelos-simplificados.test.ts` | **4 de 4**   |

Total: 13 arquivos, 89 de 89. **Não rodado:** `team-queue`, que só existe como teste de ponta a ponta
(`tests/e2e/specs/team-queue.spec.ts`) e precisa do sistema inteiro no navegador. O banco de teste, o
papel temporário e a cópia de trabalho foram apagados ao fim.

## Páginas

`/`, `/entrar`, `/painel` e `/tablet`: pela internet, sem a senha do proxy, toda a homologação
responde 401 do Caddy. As telas ("Para quem estiver livre" no tablet, "Livre para os ajudantes" na OS,
no planejamento e no quadro) ficam para o teste do dono, com login.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `70b8d51`). Aqui a migration não
alterou nenhuma linha, mas na produção voltar só a versão não devolve os responsáveis antigos.
