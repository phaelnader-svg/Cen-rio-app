# 17/11/2026 — Homologação de `a4fc510` (Orçamentos: faixa dos salvos e número do próximo orçamento, PR #14)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta criada, nenhuma numeração alterada, nenhum orçamento criado.

- Commit: `a4fc5100e97801807533c60d32bdf718db75d086` (branch `claude/project-thread-r6mrbg`; `FETCH_HEAD` conferido, a branch não tinha avançado), sobre `bafae04`. O diff toca 5 arquivos: `apps/api/src/modules/quotes/routes.ts`, `apps/api/test/orcamentos.test.ts`, `apps/web/components/quotes/quote-base.tsx`, `apps/web/components/quotes/saved-quotes.tsx` e `packages/shared/src/quotes.ts`. Sem migration, sem variável nova, sem `infra/`.
- Versão antes: `bafae04558b7008b6f55ef679311a66706b87054` · depois: `a4fc5100e97801807533c60d32bdf718db75d086` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `e8fe4c19-7b0e-40b2-95b7-75d586fae11e`: SUCCESS (16:51:27 → 16:56:58 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:8b93d54bd97c65ede3ff05590d82a0e284a48a41d669ee62bbbeb98cd77ce0c7`
  - web `sha256:590992a95a793273198014ba08ca0cde768c4994a2e543cb7fb30c6fa9c8128a`
- Migrations: nenhuma nova (49 na imagem e 49 no banco).
- Ponto de recuperação: `cenario-staging-20261117T165903Z` (versão `bafae04`, impressão `8da45e846a678641cafd960736ad2853`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                                            | Resultado                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16:50       | verificar, version, health, gate_status, disk_status                                                                | canal OK; ativa `bafae04` (scripts `d6d30306de26`); saudável; portão fechado; disco 68% (**9,1 GB livres**, abaixo de 12 GB)                                                                                                                  |
| 16:51       | images_cleanup_plan → images_cleanup                                                                                | removidas 6 imagens antigas não protegidas da VM (`6d8e445`, `aa1554b` e `aa7ba96`, api e web; continuam no Artifact Registry); livre: 9,03 → 15,84 GiB. Mantidas a versão ativa (`bafae04`) e a do ponto de recuperação anterior (`d6d3030`) |
| 16:51–16:56 | imagens (ausentes) → build-iniciar / build-acompanhar                                                               | SUCCESS                                                                                                                                                                                                                                       |
| 16:57:08    | gate_open                                                                                                           | aberto                                                                                                                                                                                                                                        |
| 16:57:12    | prepare_version                                                                                                     | OK; digests acima; imagem: 49 migrations, banco: 49; disco livre 14 GB                                                                                                                                                                        |
| 16:58:39    | migration_precheck                                                                                                  | 0 pendentes                                                                                                                                                                                                                                   |
| 16:58       | database_fingerprint e database_counts (antes)                                                                      | registradas                                                                                                                                                                                                                                   |
| 16:58:54    | maintenance_on                                                                                                      | API e web paradas (16:58:57)                                                                                                                                                                                                                  |
| 16:59:00    | recovery_point_create                                                                                               | `cenario-staging-20261117T165903Z`                                                                                                                                                                                                            |
| 17:00:15    | backup_validate                                                                                                     | SHA256SUMS conferido                                                                                                                                                                                                                          |
| 17:00:18    | migrate                                                                                                             | 0 aplicadas ("up to date"); só registra a versão                                                                                                                                                                                              |
| 17:01:23    | migration_verify                                                                                                    | 49/49, nenhuma pendente                                                                                                                                                                                                                       |
| 17:01:29    | activate_version                                                                                                    | Saúde OK (disco 52%, memória 1036 MB)                                                                                                                                                                                                         |
| —           | maintenance_off                                                                                                     | não necessário: a ativação já subiu API e web (saudáveis)                                                                                                                                                                                     |
| 17:02:4x    | gate_close                                                                                                          | fechado                                                                                                                                                                                                                                       |
| 17:02+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_counts, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`**                                                                                    |

Indisponibilidade: cerca de 3 min 35 s (16:58:57 → ~17:02:32).

## Contagens e impressão digital antes/depois

174 tabelas antes e depois. **Nenhuma contagem caiu e nenhuma tabela mudou de conteúdo.** A única
diferença é `status_samples` (25 → 26 linhas) e a sua sequência, com a amostra periódica de status.

## Testes de Orçamentos (passo 6)

A suíte da VM não cobre Orçamentos. `apps/api/test/orcamentos.test.ts` foi rodado no commit exato
(worktree de `a4fc510`, `pnpm install --frozen-lockfile`), contra um banco PostgreSQL 16 local e
descartável, criado do zero pelas 49 migrations. Resultado: **7 testes, 7 passaram**:

- serviço do tapeceiro cria o do ajudante, renomeia junto e exclui junto;
- calcula como o modelo, recusa preço pendente e numera a partir de 10200;
- itens que vieram prontos na base (id md5) aceitam alterar preço e entram no orçamento;
- **a empresa escolhe o número do próximo orçamento (nunca abaixo de um já usado)**;
- O.S. exige tapeceiro responsável; excluir esconde o orçamento;
- backup exporta e importa a base (com vínculo do ajudante);
- quem só vê não altera; quem não tem permissão não vê.

O banco de teste, o papel temporário e a cópia de trabalho foram apagados ao fim.

Não verificado por mim: Orçamentos > Orçamentos salvos (faixa horizontal) e Base de dados ("Número do
próximo orçamento") no painel do gestor. Isso fica para o teste do dono, com login.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `bafae04`). Como não houve migration,
voltar só a versão também é seguro.
