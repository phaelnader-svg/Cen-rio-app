# 18/11/2026 — Homologação de `3baddd3` (melhorias 133–172 e contrato entre páginas, PR #15)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta criada. Nenhum orçamento editado, nenhuma proposta aprovada,
nenhum serviço registrado, nenhum link de proposta de cliente aberto.

- Commit: `3baddd33008982ef9a6ffbac0f57487151f52154` (branch `claude/project-thread-pszvea`; `FETCH_HEAD` conferido, a branch não tinha avançado), sobre `be53c16`. O diff tem 174 arquivos (+1763 −912). Sem `infra/`, sem variável nova. Em `packages/db`, só a migration abaixo, o `schema.prisma` e a reversão.
- Versão antes: `be53c16639cc39e450629466279f4e596a2b5c19` · depois: `3baddd33008982ef9a6ffbac0f57487151f52154` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `84c16c3f-9a07-474a-865f-2220a0cb1e4a`: SUCCESS (00:04:27 → 00:10:22 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:1095df3e04440e7eaced6c1bc7e9ef9af558aeeec6ebfdbf2a0924de0c959cd7`
  - web `sha256:89deafae7ca52533656df6119a206f8004fa9b0696da7aab508cd8a364e17bdc`
- Migration: `20270801000000_textos_proposta` (1 comando: 3 colunas que aceitam vazio em `quote_settings`, `proposal_title` VARCHAR(120), `proposal_intro` VARCHAR(400) e `proposal_thanks` VARCHAR(600)), aplicada em **55 s**. Não altera dados. Reversão: `packages/db/rollback/20270801000000_textos_proposta.down.sql`.
- Ponto de recuperação: `cenario-staging-20261118T001246Z` (versão `be53c16`, impressão `5c66b094e5b132fb58b72391a5a388d0`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                                            | Resultado                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00:03       | verificar, version, health, gate_status, disk_status                                                                | canal OK; ativa `be53c16` (scripts `d6d30306de26`); saudável; portão fechado; disco 60% (11,22 GiB livres)                                                                                                                          |
| 00:04       | images_cleanup_plan → images_cleanup                                                                                | removidas 4 imagens antigas não protegidas da VM (`bafae04` e `d6d3030`, api e web; continuam no Artifact Registry); livre: 11,22 → 15,84 GiB. Mantidas a versão ativa (`be53c16`) e a do ponto de recuperação anterior (`a4fc510`) |
| 00:04–00:10 | imagens (ausentes) → build-iniciar / build-acompanhar                                                               | SUCCESS                                                                                                                                                                                                                             |
| 00:10:42    | gate_open                                                                                                           | aberto                                                                                                                                                                                                                              |
| 00:10:46    | prepare_version                                                                                                     | OK; digests acima; imagem: 50 migrations, banco: 49; disco livre 14 GB                                                                                                                                                              |
| 00:12:13    | migration_precheck                                                                                                  | exatamente 1 pendente: `20270801000000_textos_proposta`; esquema compatível                                                                                                                                                         |
| 00:12       | database_fingerprint e database_counts (antes)                                                                      | registradas                                                                                                                                                                                                                         |
| 00:12:36    | maintenance_on                                                                                                      | API e web paradas (00:12:40)                                                                                                                                                                                                        |
| 00:12:43    | recovery_point_create                                                                                               | `cenario-staging-20261118T001246Z`                                                                                                                                                                                                  |
| 00:13:37    | backup_validate                                                                                                     | SHA256SUMS conferido                                                                                                                                                                                                                |
| 00:13:41    | migrate                                                                                                             | 1 aplicada em 55 s                                                                                                                                                                                                                  |
| 00:14:57    | migration_verify                                                                                                    | 50/50, nenhuma pendente                                                                                                                                                                                                             |
| 00:15:00    | activate_version                                                                                                    | Saúde OK (disco 52%, memória 1020 MB)                                                                                                                                                                                               |
| —           | maintenance_off                                                                                                     | não necessário: a ativação já subiu API e web (saudáveis)                                                                                                                                                                           |
| 00:16:4x    | gate_close                                                                                                          | fechado                                                                                                                                                                                                                             |
| 00:16+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_counts, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`**                                                                          |

Indisponibilidade: cerca de 3 min 45 s (00:12:40 → ~00:16:25).

## Contagens e impressão digital antes/depois

174 tabelas antes e depois. **Nenhuma contagem caiu.** Cresceram só `_prisma_migrations` (49 → 50)
e `status_samples` (112 → 113, a amostra periódica). A única tabela que mudou de impressão foi
`quote_settings` (1 linha), pelas 3 colunas novas `proposal_title`, `proposal_intro` e
`proposal_thanks`. As demais ficaram iguais.

## Testes do repositório (passo 6)

Rodados no commit exato (worktree de `3baddd3`, `pnpm install --frozen-lockfile`), contra um banco
PostgreSQL 16 local e descartável, criado do zero pelas 50 migrations:

| Arquivo                                   | Resultado                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/orcamentos.test.ts`        | **8 de 8**                                                                                                          |
| `apps/api/test/melhorias-rodada2.test.ts` | **16 de 16**, incluindo "o cliente abre o link, vê só a proposta e aprova" (agora conferindo os textos da proposta) |
| `apps/api/test/devices.test.ts`           | **13 de 13**                                                                                                        |
| `packages/shared/test` (inteiro)          | **22 arquivos, 134 de 134**                                                                                         |

O banco de teste, o papel temporário e a cópia de trabalho foram apagados ao fim.

## Páginas

- "Essa página não existe": `apps/web/app/not-found.tsx`; "algo deu errado": `apps/web/app/error.tsx`. Os dois estão presentes no commit.
- `/`, `/entrar`, `/painel`, `/painel/orcamentos` e `/painel/servicos`: pela internet, sem a senha do proxy, toda a homologação responde 401 do Caddy. As telas e as respostas 200 ficam para o teste do dono, com login.

Retorno, se necessário: `rollback_to_recovery_point` (volta banco e versão para `be53c16`, com a
migration desfeita pelo ponto de recuperação).
