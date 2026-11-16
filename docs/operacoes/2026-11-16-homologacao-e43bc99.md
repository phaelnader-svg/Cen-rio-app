# 16/11/2026 — Homologação de `e43bc99` (remoção de módulos S2–S7 + Orçamentos, Retiradas e landing)

Pedido do dono ("sim": mandar para homologação a remoção de módulos). Somente homologação
(`teste.cenariogestao.com.br`, operador `claude-operador`). Produção não tocada.

- Commit: `e43bc994de89254d5265894839970c43e2b75f53` (branch `claude/project-thread-dr7pqa`). Remove de verdade Recebimentos, Medições, Pedidos de ajuda, Compras e Recebimento de materiais (S2, S3, S4, S5 e S7; relatório em `docs/REFORMULACAO-REMOCAO-S2-S7-RELATORIO.md`), juntado com `a91fc42` (Orçamentos, agenda de Retiradas e landing `180d120`). Contém `b4d08d4`. Sem mudança em `packages/db`.
- Versão antes: `b4d08d4b67760747ab605c94fb750af4353ebf67` · depois: `e43bc994de89254d5265894839970c43e2b75f53` (etiqueta, pilha e migrada).
- Build `d6e343eb-43b2-4a4d-b793-34ebe276901e`: SUCCESS (22:38:54 → 22:43:47 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:fe30ea8b271c07d7ae5a79860a20476be02ecff8c59dda669714598499b6e26a`
  - web `sha256:e6d36a3b566b008f7cdcdc36d85c9442ee81b5129290f633727f533af4f94440`
- Migrations: nenhuma nova (40 na imagem e 40 no banco). Os dados dos módulos removidos continuam nas tabelas, sem tela.
- Ponto de recuperação: `cenario-staging-20261116T224544Z` (versão `b4d08d4`, impressão `5ee69f76408796955716311dcef48617`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                           | Resultado                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 22:38       | verificar, version, health, gate_status, disk_status                                               | canal OK; ativa `b4d08d4`; saudável; portão fechado; disco 51% (14 GB livres)                                              |
| 22:38–22:43 | imagens (ausentes) → build-iniciar / build-acompanhar                                              | SUCCESS                                                                                                                    |
| 22:43:55    | gate_open                                                                                          | aberto                                                                                                                     |
| 22:43:58    | prepare_version                                                                                    | OK; digests acima; imagem: 40 migrations, banco: 40                                                                        |
| 22:45:14    | migration_precheck                                                                                 | 0 pendentes; 40 na imagem, 40 no banco                                                                                     |
| 22:45       | database_fingerprint (antes)                                                                       | registrada                                                                                                                 |
| 22:45:34    | maintenance_on                                                                                     | API e web paradas (22:45:38)                                                                                               |
| 22:45:40    | recovery_point_create                                                                              | `cenario-staging-20261116T224544Z`                                                                                         |
| 22:46:24    | backup_validate                                                                                    | SHA256SUMS conferido                                                                                                       |
| 22:46:28    | migrate                                                                                            | 0 aplicadas ("up to date"); rodado porque o `activate_version` exige o `migrate` da mesma versão                           |
| 22:47:12    | migration_verify                                                                                   | 40/40, nenhuma pendente                                                                                                    |
| 22:47:18    | activate_version                                                                                   | Saúde OK (disco 59%, memória 1046 MB)                                                                                      |
| 22:48:34    | gate_close                                                                                         | fechado                                                                                                                    |
| 22:48+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros |

Impressão digital antes/depois: **idêntica**. Nenhuma tabela, coluna, restrição ou valor mudou.

Indisponibilidade: cerca de 3 min (22:45:38 → ~22:48:32).

Rotas (passo 6), conferência sem login: pela internet não deu para separar 404 de 401. O proxy da
homologação exige senha antes da API, e as 9 rotas responderam `401` do Caddy
(`WWW-Authenticate: Basic`). Por isso a conferência foi feita no código do commit exato
(`apps/api/src`, sem testes):

| Rota                                    | Esperado | No código de `e43bc99`                                                            |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `GET /api/v1/receipts/pending`          | removida | ausente                                                                           |
| `GET /api/v1/measurements`              | removida | ausente (só resta `/api/v1/service-orders/:id/items/:itemId/measurements`, da OS) |
| `GET /api/v1/purchase-orders`           | removida | ausente                                                                           |
| `GET /api/v1/help-requests`             | removida | ausente                                                                           |
| `GET /api/v1/material-receipts/pending` | removida | ausente                                                                           |
| `GET /api/v1/pickups`                   | existe   | registrada                                                                        |
| `GET /api/v1/service-orders`            | existe   | registrada                                                                        |
| `GET /api/v1/inventory/items`           | existe   | registrada                                                                        |
| `POST /api/v1/orders/:id/arrived`       | existe   | registrada (`apps/api/src/modules/orders/routes.ts`)                              |

Não verificado por mim: as respostas 404/401 reais dessas rotas atrás do proxy e as telas com login
(Novo serviço gerando a OS no fechamento), que ficam para o teste do dono.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `b4d08d4`) ou `rollback_version
b4d08d4b67760747ab605c94fb750af4353ebf67`. Como não houve migration, voltar só a versão também é
seguro: os dados não mudam.
