# 17/11/2026 — Produção: deploy de `aa1554b` (multi-empresa)

- **Pedido e aprovação:** dono, 16/11/2026 às 23h49 (Brasília), fora do expediente da fábrica: "me mande
  o texto", pedindo o texto de produção do multi-empresa depois da homologação de `aa1554b`; texto
  entregue e enviado para execução. Versão `aa1554b3f1e240a2f92a03b500fc98e9762bb949` (branch
  `claude/project-thread-x4iibr`).
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **O que entrou:**
  - `company_id` em cada linha. A Cenário Estofados é a empresa nº 1, dona de todos os dados atuais, e a
    numeração continua de onde parou;
  - trava no banco (RLS) com o papel `cenario_app`;
  - "Criar conta" cria uma empresa nova, separada;
  - painel "Empresas" (só o gestor da empresa nº 1) para bloquear e liberar;
  - conexões externas continuam só na empresa nº 1;
  - fora do multi-empresa, tudo idêntico a `64c238f`, inclusive `infra/`.
- **Homologação:** `docs/operacoes/2026-11-17-homologacao-aa7ba96-multi-empresa.md` (migrations, 29 s,
  contagens iguais; branch `claude/operacoes-homologacao-aa7ba96`) e
  `docs/operacoes/2026-11-17-homologacao-aa1554b.md` (versão final; branch
  `claude/operacoes-homologacao-aa1554b`, build `c01c2cca-c0fa-482f-87aa-c0537f4de962`). As 3
  migrations de `aa1554b` são idênticas byte a byte às de `aa7ba96`, as que rodaram de fato na
  homologação.
- **Conferência das migrations antes de executar:**
  - etapa 2: as 30 sequências de numeração dão lugar a `company_counters`. Cada contador começa em
    `GREATEST(maior número existente, último valor da sequência)`;
  - etapa 3: `cenario_app` é `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`. A API assume o papel em cada
    transação. Migrations, backup e o `psql` do operador continuam como antes, sem a trava;
  - etapa 4: só acrescenta (chave de `module_settings` por empresa; criação e bloqueio em
    `company_settings`).
- **Imagens:** o gatilho de promoção não existe (`cenario-prod-promocao` → 404, nada publicado). O dono
  promoveu no Cloud Shell (`crane copy -j 1` por digest, depois `promover-imagens.sh` para conferir).
  Em `cenario-prod` (API do Artifact Registry e `prepare_version` na VM): api
  `sha256:f09020abf649efe387bc492bbd64f830ed905f2bb6fa34b5b3dcfe42ddc648bd`, web
  `sha256:212a044577d019fd7b23e129b2b1a421e1ba9a9e10b35ab0b0770e2bb9a7ec1e` (iguais às homologadas).
- **Versão:** `64c238f0ad949afff1b13e8e9a4f1b643fcea277` → `aa1554b3f1e240a2f92a03b500fc98e9762bb949`
  (etiqueta, pilha, candidata e migrada).
- **Scripts da VM:** sem mudança. `infra/` é idêntica a `64c238f` (`git diff` vazio), e o
  `vm_scripts_diff 180d12064ba1` deu "/opt/cenario já é idêntico ao pacote". Por isso não houve
  `vm_scripts_update`.
- **Banco:** 44 → 47 migrations, nesta ordem: `20270701000000_multi_empresa_etapa2` (688 comandos),
  `20270708000000_multi_empresa_etapa3` (330) e `20270715000000_multi_empresa_etapa4` (5). **Tempo do
  migrate: 11 s** (homologação: 29 s).
- **Ponto de recuperação:** `cenario-production-20261117T030958Z` (versão `64c238f`, impressão
  `c3161ecc43296a6660c8756521011133`): restauração de teste IDÊNTICA, no bucket, SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                         | Resultado                                                                                 |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 02:50       | verificar, version, health, gate_status, disk_status                             | canal OK; ativa `64c238f`; saudável; portão fechado; disco 53%                            |
| 02:50       | migration_status, imagens                                                        | 44 aplicadas; imagens ausentes em `cenario-prod`                                          |
| 02:51:26    | promover (gatilho)                                                               | tópico inexistente (404): parado, nada alterado                                           |
| 02:51–03:07 | promoção pelo dono no Cloud Shell                                                | concluída                                                                                 |
| 03:07:10    | imagens, vm_scripts_diff                                                         | digests homologados em `cenario-prod`; VM idêntica ao pacote                              |
| 03:07:32    | gate_open                                                                        | aberto                                                                                    |
| 03:07:36    | prepare_version                                                                  | digests homologados na VM; não migra na partida; 47 na imagem × 44 no banco; 21 GB livres |
| 03:09:16    | migration_precheck                                                               | as 3 pendentes, na ordem; esquema compatível; PREFLIGHT OK                                |
| 03:09:39    | database_fingerprint, database_counts (antes)                                    | 5467 itens; 27 tabelas com dados                                                          |
| 03:09:51    | maintenance_on                                                                   | API e web paradas (03:09:54)                                                              |
| 03:09:56    | recovery_point_create                                                            | `cenario-production-20261117T030958Z`, IDÊNTICA, no bucket                                |
| 03:10:25    | backup_validate                                                                  | SHA256SUMS conferido                                                                      |
| 03:10:39    | migrate                                                                          | banco idêntico ao ponto; 3 aplicadas em 11 s                                              |
| 03:11:01    | migration_verify                                                                 | 47/47; nada pendente, desconhecido ou incompleto                                          |
| 03:11:05    | database_counts e database_fingerprint (ainda em manutenção)                     | nenhuma contagem caiu (abaixo): seguiu para a ativação                                    |
| 03:11:55    | activate_version                                                                 | contêineres saudáveis; Saúde OK (47 migrations, disco 57%, memória 2775 MB)               |
| 03:12:17    | gate_close                                                                       | fechado                                                                                   |
| 03:13+      | version, smoke_test, websocket_test, testes acesso, contagens, fingerprint, logs | todos OK (abaixo)                                                                         |

- **Indisponibilidade:** ≈2 min (03:09:54 → ~03:12:02, web "Ready" às 03:12:02).
- **Contêineres:** api e web nos digests homologados (`images_cleanup_plan`); `64c238f` protegida como
  versão do ponto de recuperação.
- **Testes:** `smoke_test` Saúde OK; `websocket_test` 401 sem sessão (esperado); `run_homologation_tests
suite=acesso` Acesso OK.
- **Logs (10 min):**
  - api sem nível ≥ 40 e sem erro do Prisma; web "Ready in 1771ms", sem erros;
  - PostgreSQL e backup sem ERROR/FATAL;
  - Caddy: **0 respostas 5xx** (200, 308, 302, 401 e 101);
  - **0 ocorrências de `permission denied`** e 0 erros de row-level security em todos os logs.
- **Contagens (exatas, pela impressão digital) antes × depois:**
  - **nenhuma contagem caiu.** Só `_prisma_migrations` cresceu (44 → 47), e surgiu `company_counters`
    (30 contadores);
  - as 27 tabelas com dados mantiveram a contagem: `audit_logs` 26, `auth_throttle` 2,
    `commercial_order_items` 1, `commercial_orders` 1, `company_settings` 1, `customer_addresses` 1,
    `customers` 1, `domain_events` 14, `employees` 1, `idempotency_keys` 1, `item_locations` 8,
    `oauth_clients` 1, `pickup_events` 3, `pickup_request_items` 1, `pickup_requests` 1,
    `production_template_steps` 22, `production_templates` 5, `quality_template_items` 28,
    `quality_templates` 4, `quote_catalog_items` 35, `quote_settings` 1, `role_permissions` 81, `roles` 5,
    `sessions` 7, `user_roles` 1, `users` 1, `_prisma_migrations`;
  - as mesmas contagens conferidas ainda em manutenção (antes da ativação) e depois.
- **Impressão digital antes × depois** (5467 itens antes):
  - `company_id` presente em 163 tabelas;
  - das 27 tabelas com dados, o md5 mudou em 25:
    - 23 só pela coluna `company_id`;
    - `company_settings` pelas colunas da etapa 4 (`created_at`, `blocked_at`, `blocked_reason`);
    - `_prisma_migrations` pelas +3 linhas;
  - `auth_throttle` e `oauth_clients` (globais, sem `company_id`): idênticas;
  - **somas financeiras (56): idênticas.**
- **Conferido de fora:**
  - `/` 200, landing com o botão Entrar, sem `X-Robots-Tag`;
  - `/entrar` 200 (`noindex`), com o botão **"Criar conta"** (`data-testid="criar-conta"`) e o botão
    Entrar. Conferido no Chromium; a página não teve erro de JavaScript;
  - `GET /api/v1/platform/companies` (painel Empresas) 401 sem login; `/api/v1/game/spaces` e
    `/api/v1/service-orders` 401; `/api/ready` 200.
  - Nenhuma conta de teste criada.
- **Não verificado por mim:** o login do dono abrindo o painel com os dados de sempre (não houve acesso de
  navegador depois da ativação; todas as requisições nos logs eram dos testes automáticos), o painel
  "Empresas" com login e o "Criar conta" de ponta a ponta. Ficam para o teste do dono.
- **Retorno, se necessário:** `rollback_to_recovery_point` (volta banco e versão para `64c238f`; perde o
  gravado depois de 03:10:16). **Voltar só a versão NÃO é seguro depois do migrate**: a `64c238f` não
  trabalha com a trava nem com a numeração por empresa.
- **Lições:**
  - conferir as contagens ainda em manutenção, entre o `migration_verify` e o `activate_version`, deixa
    a decisão de voltar ao ponto de recuperação antes de qualquer acesso à versão nova;
  - o `database_counts` usa estatísticas do PostgreSQL; a contagem exata vem da impressão digital.
