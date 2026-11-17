# 17/11/2026 — Homologação de `bafae04` (ids da base de Orçamentos, PR #14)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta criada.

- Commit: `bafae04558b7008b6f55ef679311a66706b87054` (branch `claude/project-thread-r6mrbg`; `FETCH_HEAD` conferido, a branch não tinha avançado), sobre `d6d3030`. Antes, os itens que vieram prontos na base de Orçamentos tinham id `md5(...)::uuid` e caíam em "Identificador inválido.". A validação de ids passa a `z.guid()`. O diff só toca `apps/api/src`, `apps/api/test` e `packages/shared/src`: sem migration, sem variável nova, sem `infra/`.
- Versão antes: `d6d30306de266f6583353fe7b86bc5eaf8fb7854` · depois: `bafae04558b7008b6f55ef679311a66706b87054` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `bca30320-2abb-4761-be41-cc026b560eff`: SUCCESS (15:59:18 → 16:05:48 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:80dd16eefac7e3e31f4802bd8ff081caae058b69057f49a079ebe2aa67238df4`
  - web `sha256:aa63113b030c73b056c189b964164cbaf7e02c2683ebc35774bf113f8d7de9c1`
- Migrations: nenhuma nova (49 na imagem e 49 no banco).
- Ponto de recuperação: `cenario-staging-20261117T160813Z` (versão `d6d3030`, impressão `3b33dcf94556c2dee3501680e1b7c140`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                                            | Resultado                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15:58       | verificar, version, health, gate_status, disk_status                                                                | canal OK; ativa `d6d3030` (scripts `d6d30306de26`); saudável; portão fechado; disco 60% (12 GB livres)                                                     |
| 15:59–16:05 | imagens (ausentes) → build-iniciar / build-acompanhar                                                               | SUCCESS                                                                                                                                                    |
| 16:05:57    | gate_open                                                                                                           | aberto                                                                                                                                                     |
| 16:06:01    | prepare_version                                                                                                     | OK; digests acima; imagem: 49 migrations, banco: 49; disco livre 10 GB                                                                                     |
| 16:07:39    | migration_precheck                                                                                                  | 0 pendentes                                                                                                                                                |
| 16:07       | database_fingerprint e database_counts (antes)                                                                      | registradas                                                                                                                                                |
| 16:08:03    | maintenance_on                                                                                                      | API e web paradas (16:08:06). Necessário porque o `recovery_point_create` exige manutenção                                                                 |
| 16:08:09    | recovery_point_create                                                                                               | `cenario-staging-20261117T160813Z`                                                                                                                         |
| 16:09:25    | backup_validate                                                                                                     | SHA256SUMS conferido                                                                                                                                       |
| 16:09:29    | migrate                                                                                                             | 0 aplicadas ("up to date"). Rodado porque o `activate_version` exige o `migrate` da mesma versão                                                           |
| 16:10:23    | migration_verify                                                                                                    | 49/49, nenhuma pendente                                                                                                                                    |
| 16:10:29    | activate_version                                                                                                    | Saúde OK (disco 68%, memória 1040 MB)                                                                                                                      |
| 16:11:34    | gate_close                                                                                                          | fechado                                                                                                                                                    |
| 16:11+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_counts, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`** |

Indisponibilidade: cerca de 3 min 20 s (16:08:06 → ~16:11:26).

Não houve `vm_scripts_diff`, `vm_scripts_update` nem `apply_stack_config`.

## Contagens e impressão digital antes/depois

174 tabelas antes e depois. **Nenhuma contagem caiu e nenhuma tabela mudou de conteúdo.** A única
diferença é `status_samples` (15 → 16 linhas) e a sua sequência, com a amostra periódica de status.

## Correção dos ids (`PATCH /api/v1/quotes/catalog/<id>` com id md5)

A suíte `completo` da VM roda só saúde, acesso e websocket. Ela **não** executa os testes do
repositório, então não cobre `apps/api/test/orcamentos.test.ts`. Por isso esse arquivo foi rodado à
parte, no commit exato (worktree de `bafae04`, `pnpm install --frozen-lockfile`), contra um banco
PostgreSQL 16 local e descartável, criado do zero pelas 49 migrations e apagado ao fim:
**6 testes, 6 passaram**. Entre eles está o teste novo "itens que vieram prontos na base (id md5)
aceitam alterar preço e entram no orçamento", que troca o id de um item por `md5(...)::uuid` e
altera o preço e usa o item no orçamento.

Não verificado por mim: Orçamentos > Base de dados no painel do gestor e a alteração de preço de um
item pronto na homologação. Isso fica para o teste do dono, com login.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `d6d3030`). Como não houve
migration, voltar só a versão também é seguro.
