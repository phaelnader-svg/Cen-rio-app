# 28/11/2026 — Homologação de `e9d36e3` (botão "Chamar no WhatsApp")

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhum dado alterado; nenhum login criado.

- Commit: `e9d36e354adb65808c03971b4f655582fa1c4a44` (branch `claude/project-thread-59ws1j`, que aponta para esse mesmo hash; `git cat-file -t` = `commit`; contém `4b41e74`). De `4b41e74` para cá, 10 arquivos, todos em `apps/web/` (`components/site/*`, `components/platform/painel-extras.tsx`, `lib/origem.ts`, `test/lgpd.test.tsx` e `test/site.test.ts`). Nada em `packages`, `infra` nem `apps/api`.
- Versão antes: `4b41e7422a94b4635cfe23b6a20b4f1c23b11e8e` · depois: `e9d36e354adb65808c03971b4f655582fa1c4a44` (etiqueta, pilha, candidata e migrada). Scripts da VM inalterados (`8d8a6e76ee4b`).
- Build `ceeb5e31-f428-443e-b69d-3a20a713ab1b`: SUCCESS (02:36:34 → 02:42:53 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:d2bb00612f08779933b788b19d2bcfb1e9317f6aa63270626f5da9113a84b7ee`
  - web `sha256:6f71c317f947228e200362bc5bd66545f46d152a674d96a135678adc6de557f6`
- Migrations: nenhuma nova (69 na imagem e 69 no banco).
- Ponto de recuperação: `cenario-staging-20261128T024547Z` (versão `4b41e74`, 69 migrations, impressão `34418d519c9b09085a25be321213cc60`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate folder=…`: SHA256SUMS conferido, em comando separado.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                              |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 02:36       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `4b41e74` (69 migrations); saudável; portão fechado; disco 63% (**11 GB livres**). Acima de 10 GiB: limpeza não rodada |
| 02:36–02:42 | imagens (ausentes) → build-iniciar / build-acompanhar                  | SUCCESS                                                                                                                                |
| 02:43:16    | gate_open                                                              | aberto                                                                                                                                 |
| 02:43:20    | prepare_version                                                        | OK; digests acima; imagem: 69 migrations, banco: 69; disco livre 9 GB depois de baixar                                                 |
| 02:45:16    | migration_precheck                                                     | 0 pendentes (esperado)                                                                                                                 |
| 02:45       | database_counts e database_fingerprint (antes)                         | registradas (193 tabelas)                                                                                                              |
| 02:45:37    | maintenance_on                                                         | API e web paradas (02:45:40)                                                                                                           |
| 02:45:43    | recovery_point_create                                                  | `cenario-staging-20261128T024547Z`; restauração de teste IDÊNTICA; enviado ao bucket                                                   |
| 02:47:12    | backup_validate `folder=cenario-staging-20261128T024547Z`              | SHA256SUMS conferido                                                                                                                   |
| 02:47:21    | migrate                                                                | 0 aplicadas ("up to date")                                                                                                             |
| 02:47:54    | migration_verify                                                       | 69/69, nenhuma pendente                                                                                                                |
| 02:47:58    | activate_version                                                       | Saúde OK (disco 71%, memória 967 MB); API e web de pé                                                                                  |
| 02:49:14    | maintenance_off                                                        | sem efeito: API e web já estavam de pé                                                                                                 |
| 02:49:34    | gate_close                                                             | fechado                                                                                                                                |
| 02:49       | version, smoke_test, websocket_test, run_homologation_tests `completo` | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; disco 71% (8,2 GB livres)                           |
| 02:50:28    | database_counts, database_fingerprint, container_logs api/web          | api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`**, nenhum `"Falha ao`                                             |

Indisponibilidade: cerca de 3 min 8 s (02:45:40 → 02:48:48).

## Contagens e impressão digital antes/depois

193 tabelas antes e depois, 69/69 migrations, estrutura igual. **Nenhuma contagem caiu e nenhuma
tabela mudou de conteúdo.** A única diferença é `status_samples` (3020 → 3021) e a sua sequência.

## Conferência do botão

A página da homologação continua sem poder ser buscada desta sessão (o proxy de saída não abre
`teste.cenariogestao.com.br` e o catálogo não busca uma página qualquer). A conferência foi feita
numa **cópia local do commit exato compilada como produção** (`NODE_ENV=production SITE_COMERCIAL=1
next build && next start`), pedindo `/conheca` com o `Host` da produção e com o da homologação (os
dois deram o mesmo resultado):

| Texto em `/conheca` (200) | Ocorrências |
| ------------------------- | ----------- |
| `Chamar no WhatsApp`      | **4**       |
| `Chame no WhatsApp`       | **1**       |
| `Agendar demonstração`    | **0**       |
| `Agende uma demonstração` | **0**       |
| `wa.me/5512988218472`     | 10          |

Link do botão e da tarja: `https://wa.me/5512988218472?text=Olá! Quero conhecer o Cenário Gestão.`
(no HTML, com o texto codificado em URL).

## Testes do repositório (commit exato)

Worktree de `e9d36e3`, `pnpm install --frozen-lockfile`. A suíte da api não foi rodada, como pedido
(nenhum arquivo da api mudou).

| Suíte                 | Resultado                                              |
| --------------------- | ------------------------------------------------------ |
| web (`vitest run`)    | 11 arquivos, **96 passaram + 3 falhas esperadas** (99) |
| shared (`vitest run`) | 22 arquivos, **134/134**                               |

## Disco

Antes: 11 GB livres (63%). No final: **8,2 GB livres (71%)**. A próxima homologação vai precisar de
`images_cleanup` antes do `prepare_version`. Ficam protegidas as imagens de `e9d36e3` (ativa) e
`4b41e74` (ponto de recuperação).

Retorno, se necessário: `rollback_to_recovery_point`, que volta para `4b41e74` com 69 migrations.
