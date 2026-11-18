# 18/11/2026 — Produção: deploy de `3baddd3` (melhorias 133–172 da rodada 2 e contrato cortado entre páginas)

- **Pedido e aprovação:** dono, 17/11/2026. A versão traz as melhorias 133–172 da segunda rodada
  (aparência e textos, proposta editável, tablet, landing e login) e a correção do contrato cortado entre
  páginas. A aprovação de produção veio dele, ao colar o texto do deploy. Versão
  `3baddd33008982ef9a6ffbac0f57487151f52154` (branch `claude/project-thread-pszvea`, PR #15).
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **O que entrou:**
  - código (web, api e shared): 15 commits e 174 arquivos sobre `be53c16`, nada em `infra/`;
  - **uma** migration aditiva, `20270801000000_textos_proposta`: 3 colunas que aceitam vazio em
    `quote_settings` (`proposal_title` VARCHAR(120), `proposal_intro` VARCHAR(400) e `proposal_thanks`
    VARCHAR(600)). Não altera dados; reversão em `packages/db/rollback/`.
- **Homologação:** `docs/operacoes/2026-11-18-homologacao-3baddd3.md` (branch
  `claude/operacoes-homologacao-3baddd3`, commit `10f735c`); build `84c16c3f-9a07-474a-865f-2220a0cb1e4a`.
  Testes no commit exato: `orcamentos.test.ts` 8/8, `melhorias-rodada2.test.ts` 16/16,
  `devices.test.ts` 13/13 e `packages/shared/test` 134/134.
- **Disco:** 31 GiB livres (36%) no início, acima do limite de 12 GiB. **Não houve limpeza de imagens.**
- **Imagens:** o gatilho de promoção não existe (`cenario-prod-promocao` → 404, nada publicado). O dono
  promoveu no Cloud Shell: `crane copy -j 1` por digest (api 01:13–01:23, web 01:23), depois
  `promover-imagens.sh` para conferir ("já promovida"). Em `cenario-prod` (API do Artifact Registry e
  `prepare_version` na VM): api `sha256:1095df3e04440e7eaced6c1bc7e9ef9af558aeeec6ebfdbf2a0924de0c959cd7`,
  web `sha256:89deafae7ca52533656df6119a206f8004fa9b0696da7aab508cd8a364e17bdc` (iguais às homologadas).
- **Versão:** `be53c16639cc39e450629466279f4e596a2b5c19` → `3baddd33008982ef9a6ffbac0f57487151f52154`
  (etiqueta, pilha, candidata e migrada).
- **Scripts da VM:** sem mudança (`d6d30306de26`). Como pedido, não rodei `vm_scripts_diff`,
  `vm_scripts_update` nem `apply_stack_config`.
- **Banco:** 49 → 50 migrations. Pendente no precheck: exatamente `20270801000000_textos_proposta` (1
  comando). **Tempo do migrate: 9 s.**
- **Ponto de recuperação:** `cenario-production-20261118T012622Z` (versão `be53c16`, impressão
  `02a6f0fd0018d9e463c37f0653c7753d`): restauração de teste IDÊNTICA, no bucket, SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                         | Resultado                                                                                 |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 01:12:03    | verificar, version, health, gate_status, disk_status                             | canal OK; ativa `be53c16`; saudável; portão fechado; disco 36% (31 GiB livres)            |
| 01:12       | migration_status, imagens                                                        | 49 aplicadas; imagens ausentes em `cenario-prod`                                          |
| 01:12       | promover (gatilho)                                                               | tópico inexistente (404): parado, nada alterado                                           |
| 01:13–01:23 | promoção pelo dono no Cloud Shell                                                | concluída; digests conferidos                                                             |
| 01:23:50    | gate_open                                                                        | aberto                                                                                    |
| 01:23:54    | prepare_version                                                                  | digests homologados na VM; não migra na partida; 50 na imagem × 49 no banco; 28 GB livres |
| 01:25:23    | migration_precheck                                                               | 1 pendente (a esperada); esquema compatível; PREFLIGHT OK                                 |
| 01:25:41    | database_fingerprint, database_counts (antes)                                    | 6300 itens                                                                                |
| 01:25:56    | maintenance_on                                                                   | API e web paradas (01:26:10)                                                              |
| 01:26:16    | recovery_point_create                                                            | `cenario-production-20261118T012622Z`, IDÊNTICA, no bucket                                |
| 01:26:45    | backup_validate                                                                  | SHA256SUMS conferido                                                                      |
| 01:26:50    | database_fingerprint (referência, em manutenção)                                 | idêntica à de 01:25:41                                                                    |
| 01:27:06    | migrate                                                                          | banco idêntico ao ponto; 1 aplicada em 9 s                                                |
| 01:27:27    | migration_verify                                                                 | 50/50; nada pendente, desconhecido ou incompleto                                          |
| 01:27:30    | database_fingerprint (ainda em manutenção)                                       | só as diferenças previstas (abaixo): seguiu                                               |
| 01:27:45    | activate_version                                                                 | contêineres saudáveis; Saúde OK (50 migrations, disco 41%, memória 2737 MB)               |
| 01:28:06    | maintenance_off                                                                  | Saúde OK                                                                                  |
| 01:28:16    | gate_close                                                                       | fechado                                                                                   |
| 01:28+      | version, smoke_test, websocket_test, testes acesso, contagens, fingerprint, logs | todos OK (abaixo)                                                                         |

- **Indisponibilidade:** ≈2 min (01:26:02 → ~01:27:55).
- **Contêineres:** api e web nos digests homologados (`images_cleanup_plan`); `be53c16` protegida como
  versão do ponto de recuperação.
- **Testes:** `smoke_test` Saúde OK; `websocket_test` 401 sem sessão (esperado); `run_homologation_tests
suite=acesso` Acesso OK.
- **Logs (10 min):**
  - api sem nível ≥ 40; web sem erros; PostgreSQL sem ERROR/FATAL;
  - **0 `permission denied`** e 0 erros de row-level security;
  - Caddy: 37 respostas **503**, todas entre 01:26:02 e 01:27:54, durante a manutenção e a subida da API
    (`/api/realtime` de navegadores reconectando e `/api/sync/events` de tablets);
  - **fora da janela de manutenção: 0 respostas 5xx**; nenhum 404.
- **Contagens (exatas, pela impressão digital), referência em manutenção × depois:**
  - **nenhuma contagem caiu**;
  - `_prisma_migrations` 49 → 50; `status_samples` 120 → 121 (uma amostra a cada 5 minutos).
- **Impressão digital:**
  - estrutura: só as 3 colunas novas de `quote_settings` (`proposal_title`, `proposal_intro`,
    `proposal_thanks`, todas anuláveis);
  - somas financeiras: idênticas;
  - md5 mudou só em:
    - `quote_settings` (as colunas novas entram vazias em cada linha; a contagem é a mesma);
    - `_prisma_migrations`;
    - `status_samples`, `sessions` e `oauth_grants` (uso normal; `oauth_grants` com a mesma contagem).
- **Conferido de fora:** `/`, `/entrar`, `/painel/orcamentos`, `/painel/servicos/novo` e `/api/ready` → 200.
  - Nenhum link de proposta aberto, nenhum orçamento editado, nenhuma proposta aprovada, nenhum serviço
    registrado, nenhuma conta de teste criada e dados "[Exemplo]" intactos.
- **Não verificado por mim:** as telas com login (proposta editável, textos fixos da proposta na Base de
  dados, tablet, contrato sem corte entre páginas). Ficam para o teste do dono.
- **Retorno, se necessário:** `rollback_to_recovery_point` (volta para `be53c16` e desfaz a migration;
  perde o gravado depois de 01:26:43). Como a migration só adiciona colunas que aceitam vazio,
  `rollback_version be53c16639cc39e450629466279f4e596a2b5c19` também funciona; nesse caso as colunas
  ficam sem uso.
- **Observação:** entre os dois passos do dono no Cloud Shell, chegou a esta sessão a saída de uma
  atualização do ambiente de teste do Firma Viva (`firma-teste.sh atualizar`, `13309d9`). Ela não tem
  relação com este deploy e não foi tratada aqui.
