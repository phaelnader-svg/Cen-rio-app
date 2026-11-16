# 16/11/2026 — Homologação de `b4d08d4` (módulo Orçamentos, PR #6)

Pedido do dono ("pode mandar para homologacao"). Somente homologação (`teste.cenariogestao.com.br`,
operador `claude-operador`). Produção não tocada.

- Commit: `b4d08d4b67760747ab605c94fb750af4353ebf67` (branch `claude/project-thread-b1a5c4`): Orçamentos sobre a linha de produção `7898dab`, que já contém a agenda de Retiradas (`b2f12a8`).
- Versão antes: `b2f12a84a0550491299861e4a3198e23bdd47887` · depois: `b4d08d4b67760747ab605c94fb750af4353ebf67` (etiqueta, pilha e migrada).
- Build `d59dce9b-65fc-4a5b-bad1-3a8be59a69a5`: SUCCESS (21:57:01 → 22:02:29 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:d36b00d4b9b16d7663d2ffd8ac2ac7bc5c427941f8dc93896fd0f8c373451707`
  - web `sha256:471d5b422e86aee73264a6bade66c6947606ef13fce84bbe28dad1370c6b9983`
- Migration: `20270413000000_orcamentos` (cria `quote_catalog_items`, `quote_settings` e `quotes`, com a base inicial de preços; nenhuma tabela existente é alterada). Reversão manual: `packages/db/rollback/20270413000000_orcamentos.down.sql`, que recusa se houver orçamento salvo.
- Ponto de recuperação: `cenario-staging-20261116T220514Z` (versão `b2f12a8`, impressão `d0daa5f9350fd0466f0672cc537f2c00`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                           | Resultado                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 21:56       | verificar, version, health, gate_status, disk_status                                               | canal OK; ativa `b2f12a8`; saudável; portão fechado; disco 67% (9,4 GB livres)                                                                                                                               |
| 21:56–22:02 | imagens (ausentes) → build-iniciar / build-acompanhar                                              | SUCCESS                                                                                                                                                                                                      |
| 22:02       | images_cleanup_plan → images_cleanup                                                               | removidas 6 imagens antigas não protegidas da VM (`0348dcf`, `9fb6b03` e `0a2546f`, api e web; continuam no Artifact Registry); livre: 9,40 → 16,04 GiB. Mantidas a versão ativa e a do ponto de recuperação |
| 22:03:16    | gate_open                                                                                          | aberto                                                                                                                                                                                                       |
| 22:03:20    | prepare_version                                                                                    | OK; digests acima; imagem: 40 migrations, banco: 39                                                                                                                                                          |
| 22:04:46    | migration_precheck                                                                                 | exatamente 1 pendente: `20270413000000_orcamentos` (20 comandos); esquema compatível                                                                                                                         |
| 22:05       | database_fingerprint (antes)                                                                       | registrada                                                                                                                                                                                                   |
| 22:05:05    | maintenance_on                                                                                     | API e web paradas (22:05:08)                                                                                                                                                                                 |
| 22:05:11    | recovery_point_create                                                                              | `cenario-staging-20261116T220514Z`                                                                                                                                                                           |
| 22:05:55    | backup_validate                                                                                    | SHA256SUMS conferido                                                                                                                                                                                         |
| 22:05:58    | migrate                                                                                            | 1 aplicada em 57 s                                                                                                                                                                                           |
| 22:07:14    | migration_verify                                                                                   | 40/40, nenhuma pendente                                                                                                                                                                                      |
| 22:07:20    | activate_version                                                                                   | Saúde OK (disco 51%, memória 1066 MB)                                                                                                                                                                        |
| 22:08:25    | gate_close                                                                                         | fechado                                                                                                                                                                                                      |
| 22:08+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros                                                                                   |

Impressão digital antes/depois: surgiram só as 3 tabelas novas: `quote_catalog_items` (35 linhas da
base inicial), `quote_settings` (1) e `quotes` (0), com suas colunas, índices e restrições. Fora delas,
apenas o registro de migrations passou de 39 para 40. Nenhuma tabela existente mudou.

Indisponibilidade: cerca de 3 min 15 s (22:05:08 → ~22:08:23).

`/painel/orcamentos`: a rota existe na imagem (`apps/web/app/painel/orcamentos/page.tsx`). Daqui, sem a
senha do proxy, a URL responde 401 (o proxy), como qualquer página da homologação. A tela com login
fica para o teste do dono.

Retorno, se necessário: `rollback_to_recovery_point` (volta banco e versão para `b2f12a8`).
