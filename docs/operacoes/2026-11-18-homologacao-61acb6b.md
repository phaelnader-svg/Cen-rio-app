# 18/11/2026 — Homologação de `61acb6b` (fluxo da OS: Aprovar, peça na tapeçaria, Gerar OS, Material comprado)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhum orçamento aprovado, nenhum serviço fechado, nenhuma OS gerada, nenhum
material marcado, nenhum link de cliente aberto.

- Commit: `61acb6b4e8d8a8d3c2a370cd3f349ca8a6620a60` (branch `claude/project-thread-q0ti23`; `FETCH_HEAD` conferido, a branch não tinha avançado), sobre `3baddd3`. O diff tem 61 arquivos (+1464 −344). Sem `infra/`, sem variável nova. Em `packages/db`, só a migration abaixo, o `schema.prisma` e a reversão.
- Versão antes: `3baddd33008982ef9a6ffbac0f57487151f52154` · depois: `61acb6b4e8d8a8d3c2a370cd3f349ca8a6620a60` (etiqueta, pilha e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `94f781f0-d81a-484a-b402-a9c6955849ae`: SUCCESS (17:28:23 → 17:33:56 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:5042c4e31369cb13f73bcb0531cbf31caecb31f91ffa8eedbd1a3312684a3251`
  - web `sha256:7550f85cce50fcfbe84bd92c80b3d11c31f9186e9031a7778863958144da2ff1`
- Migration: `20270808000000_os_material_comprado` (3 comandos), aplicada em **48 s**. Acrescenta `material_purchased_at` e `material_purchased_by_id` (FK para `users`, ON DELETE SET NULL) em `service_orders` e preenche `material_purchased_at = created_at` nas OS existentes. Reversão: `packages/db/rollback/20270808000000_os_material_comprado.down.sql`.
- Ponto de recuperação: `cenario-staging-20261118T173603Z` (versão `3baddd3`, impressão `da2334bc194ed719956cf0c24808368d`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 17:27       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `3baddd3` (scripts `d6d30306de26`); saudável; portão fechado; disco 52% (14 GB livres, sem limpeza)                                                                        |
| 17:28–17:33 | imagens (ausentes) → build-iniciar / build-acompanhar                  | SUCCESS                                                                                                                                                                                    |
| 17:34:00    | gate_open                                                              | aberto                                                                                                                                                                                     |
| 17:34:04    | prepare_version                                                        | OK; digests acima; imagem: 51 migrations, banco: 50; disco livre 12 GB                                                                                                                     |
| 17:35:30    | migration_precheck                                                     | exatamente 1 pendente: `20270808000000_os_material_comprado`; esquema compatível                                                                                                           |
| 17:35       | database_fingerprint e database_counts (antes)                         | registradas (`pickup_requests` 3, `pickup_events` 14, `service_orders` 3)                                                                                                                  |
| 17:35:57    | maintenance_on                                                         | API e web paradas (17:35:59)                                                                                                                                                               |
| 17:36:00    | recovery_point_create                                                  | `cenario-staging-20261118T173603Z`                                                                                                                                                         |
| 17:37:16    | backup_validate                                                        | SHA256SUMS conferido                                                                                                                                                                       |
| 17:37:20    | migrate                                                                | 1 aplicada em 48 s                                                                                                                                                                         |
| 17:38:26    | migration_verify                                                       | 51/51, nenhuma pendente                                                                                                                                                                    |
| 17:38:29    | activate_version                                                       | Saúde OK (disco 60%, memória 1025 MB)                                                                                                                                                      |
| —           | maintenance_off                                                        | não necessário: a ativação já subiu API e web (saudáveis)                                                                                                                                  |
| 17:39:3x    | gate_close                                                             | fechado                                                                                                                                                                                    |
| 17:39+      | version, smoke_test, websocket_test, run_homologation_tests `completo` | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔                                                                                                          |
| 17:45:3x    | database_counts e database_fingerprint (depois), logs                  | tirados depois do primeiro ciclo de 5 min do timer de chegada; api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`** e **nenhum "Falha ao marcar as retiradas chegadas"** |

Indisponibilidade: cerca de 3 min 25 s (17:35:59 → ~17:39:24).

## Chegada automática das peças (efeito esperado)

O catálogo de operações não tem consulta por estado das retiradas, então não deu para contar antes
quantas estavam AGENDADA, EM_EXECUCAO ou RETIRADA_REALIZADA com data passada. O efeito foi medido
pela impressão digital, que mostra que **1 retirada** passou sozinha para a tapeçaria:
`pickup_events` 14 → 15 (+1 evento), e `pickup_requests` com a mesma contagem (3) e outro
conteúdo.

As demais mudanças vêm todas dessa mesma chegada, como faz `apps/api/src/modules/pickups/arrival.ts`:

- `commercial_order_items` e `commercial_orders` (5 linhas cada, mesma contagem): quantidade recebida do pedido (`markPickupArrived`);
- `notifications` (199, mesma contagem): a notificação da retirada foi resolvida (`resolvePickupAssignment`);
- `audit_logs` 324 → 325 e `domain_events` 1147 → 1150: auditoria e eventos da retirada e do pedido.

## Contagens e impressão digital antes/depois

- 174 tabelas antes e depois. **Nenhuma contagem caiu.**
- Cresceram: `_prisma_migrations` (50 → 51), `pickup_events` (+1), `audit_logs` (+1), `domain_events` (+3) e `status_samples` (320 → 322, a amostra periódica).
- Estrutura: só `service_orders` mudou, com as 2 colunas novas e a FK `service_orders_material_purchased_by_id_fkey`. As 3 OS existentes receberam `material_purchased_at`.
- Mudaram de conteúdo, com a mesma contagem, só `service_orders`, `pickup_requests`, `commercial_orders`, `commercial_order_items` e `notifications`, todas explicadas acima. As demais ficaram iguais.

## Testes do repositório (passo 6)

Rodados no commit exato (worktree de `61acb6b`, `pnpm install --frozen-lockfile`), contra um banco
PostgreSQL 16 local e descartável, criado do zero pelas 51 migrations:

| Arquivo                                  | Resultado                   |
| ---------------------------------------- | --------------------------- |
| `apps/api/test/fluxo-os.test.ts`         | **8 de 8**                  |
| `apps/api/test/novo-servico.test.ts`     | **23 de 23**                |
| `apps/api/test/pre-planejamento.test.ts` | **25 de 25**                |
| `apps/api/test/titular-previsto.test.ts` | **7 de 7**                  |
| `packages/shared/test` (inteiro)         | **22 arquivos, 134 de 134** |

O banco de teste, o papel temporário e a cópia de trabalho foram apagados ao fim.

## Páginas

`/`, `/entrar`, `/painel`, `/painel/orcamentos`, `/painel/pedidos`, `/painel/os` e
`/painel/producao/a-planejar`: pela internet, sem a senha do proxy, toda a homologação responde 401 do
Caddy. As telas e as respostas 200 ficam para o teste do dono, com login.

Retorno, se necessário: `rollback_to_recovery_point` (volta banco e versão para `3baddd3`, com a
migration desfeita e a retirada que chegou sozinha de volta ao estado anterior).
