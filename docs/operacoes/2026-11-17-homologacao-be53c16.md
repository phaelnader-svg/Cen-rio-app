# 17/11/2026 — Homologação de `be53c16` (Orçamentos: Editar, Fechar serviço e link da proposta, PR #14)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta criada. Nenhum orçamento editado, nenhuma proposta aprovada,
nenhum serviço registrado, nenhum link de proposta de cliente aberto.

- Commit: `be53c16639cc39e450629466279f4e596a2b5c19` (branch `claude/project-thread-r6mrbg`; `FETCH_HEAD` conferido, a branch não tinha avançado), sobre `a4fc510`. O diff toca 12 arquivos (+951 −316). Entra: "Editar" em Orçamentos salvos (`PUT /api/v1/quotes/:id` com `version`); Novo serviço a partir do orçamento; link da proposta com a aparência de "Visualizar proposta". Sem migration, sem variável nova, sem `infra/`, sem `packages/db`.
- Versão antes: `a4fc5100e97801807533c60d32bdf718db75d086` · depois: `be53c16639cc39e450629466279f4e596a2b5c19` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `e467a00e-65f9-43da-8883-7c006913ad6a`: SUCCESS (21:25:00 → 21:30:01 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:a8a99e3a8998114f38fc01d2e3f0c433bb32e2e7547f4e35407e5e4844314cff`
  - web `sha256:32610d88b76d4e506a3b92273877a62066461d22529ce0a21e3f83ebe85aebb7`
- Migrations: nenhuma nova (49 na imagem e 49 no banco).
- Ponto de recuperação: `cenario-staging-20261117T213225Z` (versão `a4fc510`, impressão `e4d29458513999dcbf4ec21e29e5cbd4`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                                            | Resultado                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21:24       | verificar, version, health, gate_status, disk_status                                                                | canal OK; ativa `a4fc510` (scripts `d6d30306de26`); saudável; portão fechado; disco 52% (14 GB livres, sem limpeza)                                        |
| 21:24–21:30 | imagens (ausentes) → build-iniciar / build-acompanhar                                                               | SUCCESS                                                                                                                                                    |
| 21:30:17    | gate_open                                                                                                           | aberto                                                                                                                                                     |
| 21:30:21    | prepare_version                                                                                                     | OK; digests acima; imagem: 49 migrations, banco: 49; disco livre 12 GB                                                                                     |
| 21:31:58    | migration_precheck                                                                                                  | 0 pendentes                                                                                                                                                |
| 21:32       | database_fingerprint e database_counts (antes)                                                                      | registradas                                                                                                                                                |
| 21:32:19    | maintenance_on                                                                                                      | API e web paradas (21:32:21)                                                                                                                               |
| 21:32:23    | recovery_point_create                                                                                               | `cenario-staging-20261117T213225Z`                                                                                                                         |
| 21:33:39    | backup_validate                                                                                                     | SHA256SUMS conferido                                                                                                                                       |
| 21:33:43    | migrate                                                                                                             | 0 aplicadas ("up to date"); só registra a versão                                                                                                           |
| 21:34:27    | migration_verify                                                                                                    | 49/49, nenhuma pendente                                                                                                                                    |
| 21:34:31    | activate_version                                                                                                    | Saúde OK (disco 60%, memória 1025 MB)                                                                                                                      |
| —           | maintenance_off                                                                                                     | não necessário: a ativação já subiu API e web (saudáveis)                                                                                                  |
| 21:36:1x    | gate_close                                                                                                          | fechado                                                                                                                                                    |
| 21:36+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_counts, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`** |

Indisponibilidade: cerca de 3 min 30 s (21:32:21 → ~21:35:50).

## Contagens e impressão digital antes/depois

174 tabelas antes e depois. **Nenhuma contagem caiu e nenhuma tabela mudou de conteúdo.** A única
diferença é `status_samples` (80 → 81 linhas) e a sua sequência, com a amostra periódica de status.

## Testes do repositório (passo 6)

A suíte da VM não cobre Orçamentos. Os arquivos abaixo foram rodados no commit exato (worktree de
`be53c16`, `pnpm install --frozen-lockfile`), contra um banco PostgreSQL 16 local e descartável, criado
do zero pelas 49 migrations:

| Arquivo                                    | Resultado    | Inclui                                                              |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------- |
| `apps/api/test/orcamentos.test.ts`         | **8 de 8**   | "editar um orçamento salvo mantém número e link e refaz os valores" |
| `apps/api/test/melhorias-rodada2.test.ts`  | **16 de 16** | "o cliente abre o link, vê só a proposta e aprova"                  |
| `packages/shared/test/quotes-edit.test.ts` | **4 de 4**   | —                                                                   |

O banco de teste, o papel temporário e a cópia de trabalho foram apagados ao fim.

Não verificado por mim: Orçamentos salvos com o botão "Editar", `/painel/servicos/novo?orcamento=…` e
o visual novo do link da proposta. Isso fica para o teste do dono, com login. Nenhum link de cliente
real foi aberto.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `a4fc510`). Como não houve migration,
voltar só a versão também é seguro.
