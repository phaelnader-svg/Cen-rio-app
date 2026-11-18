# 18/11/2026 — Produção: deploy de `61acb6b` (novo fluxo da OS: chegada da peça, OS à mão e "Material comprado")

- **Pedido e aprovação:** dono, 18/11/2026. A aprovação de produção veio dele, ao colar o texto do
  deploy. Versão `61acb6b4e8d8a8d3c2a370cd3f349ca8a6620a60` (branch `claude/project-thread-q0ti23`). A
  versão muda o fluxo da OS:
  - fechar o serviço cria só o pedido e a retirada;
  - a peça chega na tapeçaria pelo botão no pedido, ou sozinha 1 hora depois do horário da retirada;
  - a OS é gerada à mão no pedido, preenchida com o orçamento;
  - a OS só entra na programação da semana depois do botão "Material comprado".
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **O que entrou:**
  - código (web, api e shared): 2 commits e 61 arquivos sobre `3baddd3`, nada em `infra/`. Inclui o timer
    de 5 em 5 minutos, por empresa (`autoReceiveDuePickups`, `apps/api/src/app.ts:379-386`), que marca
    como "na tapeçaria" as retiradas AGENDADA, EM_EXECUCAO ou RETIRADA_REALIZADA com horário + 1 h já
    passado. O primeiro ciclo roda 5 minutos depois da partida da API;
  - **uma** migration, `20270808000000_os_material_comprado`:
    - `material_purchased_at` TIMESTAMPTZ(3) e `material_purchased_by_id` UUID em `service_orders`, as
      duas aceitando vazio, com FK para `users` (`ON DELETE SET NULL`);
    - o único `UPDATE` preenche `material_purchased_at = created_at` nas OS existentes.
- **Homologação:** `docs/operacoes/2026-11-18-homologacao-61acb6b.md` (branch
  `claude/operacoes-homologacao-61acb6b`, commit `a66c0ae`); build `94f781f0-d81a-484a-b402-a9c6955849ae`.
  Testes no commit exato: `fluxo-os.test.ts` 8/8, `novo-servico.test.ts` 23/23,
  `pre-planejamento.test.ts` 25/25, `titular-previsto.test.ts` 7/7 e `packages/shared/test` 134/134.
- **Disco:** 28 GiB livres (41%) no início, acima do limite de 12 GiB. **Não houve limpeza de imagens.**
- **Imagens:** o gatilho de promoção não existe (`cenario-prod-promocao` → 404, nada publicado). O dono
  promoveu no Cloud Shell: `crane copy -j 1` por digest (api 17:53–18:02, web 18:02), depois
  `promover-imagens.sh` para conferir ("já promovida"). Em `cenario-prod` (API do Artifact Registry e
  `prepare_version` na VM): api `sha256:5042c4e31369cb13f73bcb0531cbf31caecb31f91ffa8eedbd1a3312684a3251`,
  web `sha256:7550f85cce50fcfbe84bd92c80b3d11c31f9186e9031a7778863958144da2ff1` (iguais às homologadas).
- **Versão:** `3baddd33008982ef9a6ffbac0f57487151f52154` → `61acb6b4e8d8a8d3c2a370cd3f349ca8a6620a60`
  (etiqueta, pilha, candidata e migrada).
- **Scripts da VM:** sem mudança (`d6d30306de26`). Como pedido, não rodei `vm_scripts_diff`,
  `vm_scripts_update` nem `apply_stack_config`.
- **Banco:** 50 → 51 migrations. Pendente no precheck: exatamente `20270808000000_os_material_comprado` (3
  comandos). **Tempo do migrate: 9 s.**
- **Ponto de recuperação:** `cenario-production-20261118T180830Z` (versão `3baddd3`, impressão
  `1db9f2153c9c964a0f803f4e43e3bdb8`): restauração de teste IDÊNTICA, no bucket, SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                         | Resultado                                                                                 |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 17:50:01    | verificar, version, health, gate_status, disk_status                             | canal OK; ativa `3baddd3`; saudável; portão fechado; disco 41% (28 GiB livres)            |
| 17:50       | migration_status, imagens                                                        | 50 aplicadas; imagens ausentes em `cenario-prod`                                          |
| 17:50       | promover (gatilho)                                                               | tópico inexistente (404): parado, nada alterado                                           |
| 17:53–18:02 | promoção pelo dono no Cloud Shell                                                | concluída; digests conferidos                                                             |
| 18:05:41    | gate_open                                                                        | aberto                                                                                    |
| 18:05:48    | prepare_version                                                                  | digests homologados na VM; não migra na partida; 51 na imagem × 50 no banco; 26 GB livres |
| 18:07:28    | migration_precheck                                                               | 1 pendente (a esperada); esquema compatível; PREFLIGHT OK                                 |
| 18:07:38    | database_fingerprint, database_counts (antes)                                    | 6303 itens (11 pedidos, 4 retiradas, 13 eventos de retirada, 10 OS)                       |
| 18:08:04    | maintenance_on                                                                   | API e web paradas (18:08:19)                                                              |
| 18:08:25    | recovery_point_create                                                            | `cenario-production-20261118T180830Z`, IDÊNTICA, no bucket                                |
| 18:08:54    | backup_validate                                                                  | SHA256SUMS conferido                                                                      |
| 18:09:00    | database_fingerprint (referência, em manutenção)                                 | igual à de 18:07:38, menos +1 `status_samples`                                            |
| 18:09:12    | migrate                                                                          | banco idêntico ao ponto; 1 aplicada em 9 s                                                |
| 18:09:32    | migration_verify                                                                 | 51/51; nada pendente, desconhecido ou incompleto                                          |
| 18:09:40    | database_fingerprint (ainda em manutenção)                                       | só as diferenças previstas: seguiu                                                        |
| 18:09:55    | activate_version                                                                 | API pronta às 18:10:08; Saúde OK (51 migrations, disco 46%, memória 2733 MB)              |
| 18:10:24    | maintenance_off                                                                  | Saúde OK                                                                                  |
| 18:10:34    | gate_close                                                                       | fechado                                                                                   |
| ~18:15:08   | 1º ciclo do timer de chegada automática                                          | sem erro ("Falha ao marcar as retiradas chegadas": 0)                                     |
| 18:16:17+   | version, smoke_test, websocket_test, testes acesso, contagens, fingerprint, logs | todos OK (abaixo)                                                                         |

- **Indisponibilidade:** ≈2 min (18:08:10 → ~18:10:06).
- **Contêineres:** api e web nos digests homologados (`images_cleanup_plan`); `3baddd3` protegida como
  versão do ponto de recuperação.
- **Testes:** `smoke_test` Saúde OK; `websocket_test` 401 sem sessão (esperado); `run_homologation_tests
suite=acesso` Acesso OK.
- **Logs (15 min, tirados depois do 1º ciclo do timer):**
  - api sem nível ≥ 40; web sem erros; PostgreSQL sem ERROR/FATAL;
  - **0 `permission denied`**, 0 erros de row-level security e **0 "Falha ao marcar as retiradas
    chegadas"**;
  - Caddy: 67 respostas **503**, todas entre 18:08:10 e 18:10:06, durante a manutenção
    (`/api/realtime` e `/api/sync/events` de navegadores e tablets);
  - **fora da janela de manutenção: 0 respostas 5xx**; nenhum 404.
- **Estrutura e dados conferidos em manutenção, logo depois da migration:**
  - estrutura: só `service_orders` mudou (`material_purchased_at`, `material_purchased_by_id` e a FK
    `service_orders_material_purchased_by_id_fkey`);
  - md5 mudou só em `service_orders` (dados, pelo `material_purchased_at`) e em `_prisma_migrations`;
  - somas financeiras: idênticas;
  - nenhuma contagem caiu.
- **Retiradas que chegaram sozinhas:** **no máximo 1.**
  - Entre a impressão logo depois da migration e a de 18:16, `pickup_events` passou de 13 para 14, e
    `pickup_requests` mudou de md5 com a mesma contagem (4). Ou seja, **exatamente 1 retirada passou para
    "na tapeçaria"** depois da ativação.
  - Mas, às 18:16:31, um usuário usou o botão **"peça chegou"** num pedido
    (`POST /api/v1/orders/c15818e5-…/arrived`, resposta 200). Esse botão chama a mesma rotina
    (`receivePickupAtWorkshop`) e também gera 1 evento de retirada quando o pedido tem retirada
    pendente.
  - O timer não escreve log quando dá certo, e o operador não lê linhas do banco. Por isso não dá para
    separar daqui se essa retirada chegou pelo timer (às ~18:15:08) ou pelo botão (às 18:16:31).
  - Os números (`audit_logs` +9 = 3 orçamentos + 4 OS canceladas + 1 "peças chegaram" + 1 chegada de
    retirada) confirmam **uma única chegada de retirada** no total.
  - No histórico da retirada, a chegada pelo timer aparece com a anotação "automático, 1 hora depois do
    horário agendado", e a do botão com "peça chegou, marcado no pedido".
- **Uso real depois da ativação (registrado nos logs da API, não feito por mim):**
  - 3 mudanças de situação de orçamento (18:11–18:12);
  - 4 OS canceladas (18:13);
  - 1 "peça chegou" no pedido (18:16:31).
  - Isso explica as outras mudanças no fingerprint "depois": `quotes`, `service_orders`,
    `service_order_items`, `service_order_revisions` (+4), `quality_events` (+4), `commercial_orders`,
    `commercial_order_items`, `audit_logs` (+9), `domain_events` (+15), `idempotency_keys` (+1),
    `sessions`, `oauth_grants` e `status_samples` (+2).
- **Contagens, referência antes da migration × depois:** **nenhuma caiu.** Estrutura fora de
  `service_orders`: nenhuma mudança. Somas financeiras: idênticas.
- **Conferido de fora:** `/`, `/entrar`, `/painel/orcamentos`, `/painel/pedidos`, `/painel/os`,
  `/painel/producao/a-planejar` e `/api/ready` → 200.
  - Nenhum link de proposta aberto, nenhum orçamento aprovado, nenhum serviço fechado, nenhuma OS gerada,
    nenhum material marcado, nenhuma conta de teste criada e dados "[Exemplo]" intactos.
- **Não verificado por mim:** o fluxo novo com login (fechar serviço → pedido e retirada, chegada da peça,
  gerar OS à mão, "Material comprado" e a programação). Fica para o teste do dono.
- **Retorno, se necessário:** `rollback_to_recovery_point` (volta para `3baddd3` e desfaz a migration;
  perde o gravado depois de 18:08:52, **incluindo as ações reais acima**: os 4 cancelamentos de OS, as
  mudanças de orçamento e a chegada). Como as colunas novas aceitam vazio, `rollback_version
3baddd33008982ef9a6ffbac0f57487151f52154` também funciona e preserva os dados.
