# Produção — auditoria pré-deploy, SOMENTE LEITURA (candidata `696e3e9`)

- Data: 2026-11-13, operações entre **17:20:36Z e 17:23:22Z** (UTC).
- Ambiente: "Cenário — Produção", conta `claude-operador-prod`, VM `cenario-prod` (`southamerica-east1-b`).
- Candidata analisada (**não implantada**): commit `696e3e9ddc5f1c803a4b9244a075ed498ad81be3`,
  api `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f`,
  web `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72`. O build `f007753` não foi usado.
- Evidências brutas (com o mascaramento do runner, sem segredos): `docs/evidencias/producao-auditoria-696e3e9/`.
- Este relatório é factual. **Não contém veredito de deploy**; a sessão de origem consolida.

## 0. Escopo cumprido e o que NÃO foi feito

- `operar.py catalogo` executado primeiro (`00-catalogo.json`). **Todas** as operações executadas são
  de classe `READ_ONLY` no catálogo e estão na lista autorizada.
- Nenhuma operação MUTATING/DESTRUCTIVE, nenhum `vm-*` de ação, nenhum `build-*`/`testes-locais`, nenhum
  gcloud de escrita, nada de IAM/segredos, nenhum teste que cria dados.
- **`migration_precheck` NÃO executado**: a imagem da candidata não está na VM (§1, §9). Ele exigiria
  baixá-la (`prepare_version`), o que está fora da autorização.
- **`migration_status version=696e3e9…` NÃO executado**: com `version`, o runner faz `docker run` da
  imagem da candidata (`cenario_runner.py`, `comparar_migracoes`), o que faria o Docker **baixar** a
  imagem. Usei `migration_status` sem versão e comparei com o repositório no commit candidato.
- Logs: as linhas brutas de `container_logs` **não** foram gravadas no repositório (podem conter IP e
  dados pessoais). Só as contagens (`20-container_logs-contagens.txt`).

## 1. Versão ativa

| Item                                  | Valor                                                                                   | Hora UTC / job                       | ✔/✘ |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ | --- |
| VM                                    | `cenario-prod`, RUNNING, e2-medium, último início 2026-10-18T23:28Z, sem parada         | 17:20:36 (`vm-status`)               | ✔   |
| Canal do operador                     | `CANAL: OK` (`gate_status` + `version`)                                                 | 17:20:38 (`9ce2bcde…`, `f9df9578…`)  | ✔   |
| Runner                                | 2.2.0                                                                                   | 17:20:38 (`version`)                 | ✔   |
| Scripts da VM (`/opt/cenario`)        | `c32df97ebf64`                                                                          | idem                                 | —   |
| Etiqueta local (drop-in)              | `7b4177b15a930b85d985a59a9182b579760c5a7b`                                              | idem                                 | —   |
| Etiqueta do ambiente da pilha         | `7b4177b…`                                                                              | idem                                 | —   |
| Candidata registrada na VM            | `7b4177b…` (**não** é `696e3e9`)                                                        | idem                                 | —   |
| Migrada                               | `7b4177b…`                                                                              | idem                                 | —   |
| Imagem `api` em execução (ID)         | `sha256:993230244c5a43a9b0bce3c6abf1bc874202da6396c222351252012d38083bd9` (`api:7b4177b…`) | 17:22:07 (`images_cleanup_plan`)     | —   |
| Imagem `web` em execução (ID)         | `sha256:0ca94f888ad973a0f728e697656dd2b7f987e892daa986c83fddcb62823ceca8` (`web:7b4177b…`) | idem                                 | —   |
| Imagens também na VM                  | `api`/`web:9fb1786…` (`6e4a225d…`/`7b99ebc1…`), protegidas como versão do ponto de recuperação | idem                          | —   |
| Portão de publicação                  | **fechado**                                                                             | 17:20:38 e 17:21:40 (`gate_status`)  | ✔   |

Observações (fatos do repositório, sem efeito na VM):

- `7b4177b` **não é ancestral** de `696e3e9` (`git merge-base --is-ancestor` → 1; 279 commits de
  `7b4177b` não estão em `696e3e9`, 45 no sentido inverso). As 33 migrations de `7b4177b` são
  **byte a byte idênticas** em `696e3e9` (`git diff --quiet` nas 33 pastas).
- A correção de segurança de `7b4177b` (`next` 15.5.28) **está** em `696e3e9` (`apps/web/package.json`
  e `pnpm-lock.yaml`: `next@15.5.28`).
- Os IDs de imagem mostrados pelo Docker são o mesmo tipo de identificador que os digests autorizados
  da candidata (comparar com `docs/evidencias/homologacao-correcoes-deploy/21-images.txt`).

## 2. Saúde

| Verificação                                       | Resultado                                                        | Hora UTC (job)                 | ✔/✘ |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------ | --- |
| Contêineres (`status`, `containers_status`)       | api/postgres/web `running healthy`; caddy/backup `running`; "Up 3 weeks" | 17:20:58 (`2c5ad5a1…`), 17:21:07 (`2829809b…`) | ✔ |
| `health`                                          | 5 contêineres ✔; `/api/ready` pelo proxy: 200                    | 17:21:13 (`c82abed1…`)         | ✔   |
| `smoke_test` (`vm.sh saude`)                      | **Saúde: OK** (25 checagens ✔, 0 ✘)                          | 17:22:38 (`575d8184…`)         | ✔   |
| ↳ HTTPS + API + banco                             | `{"status":"ready"}`, `APP_ENV=production`                       | idem                           | ✔   |
| ↳ Proxy                                           | HTTP→HTTPS 308; www→canônico 301; HSTS; sem HTTP/3; tela 200; JS 200 | idem                       | ✔   |
| ↳ Rotas protegidas sem sessão                     | 6 rotas → 401                                                    | idem                           | ✔   |
| ↳ **Certificado**                                 | válido por **mais 64 dias** (até **2027-01-17 15:47:23 GMT**)    | idem                           | ✔   |
| ↳ Último backup / migrations / disco / memória    | 0 h / 33 aplicadas, nenhuma pendente / 29% / 2710 MB disponíveis | idem                           | ✔   |
| `websocket_test`                                  | `/api/realtime` pelo proxy: 401 (esperado sem sessão)            | 17:22:47 (`bc705a3b…`)         | ✔   |
| `network_status`                                  | escutas externas só 22, 80, 443 (53 e 25 só no loopback); `/painel`, `/api/ready`, `/entrar`: 200 | 17:21:37 (`d9f784a0…`) | ✔ |
| `database_status`                                 | PostgreSQL 16.15; 17 MB; 10 conexões; 0 aguardando bloqueio; consulta ativa mais longa 0 s | 17:21:47 (`4b7ab322…`) | ✔ |

## 3. Recursos (`resources`, 17:21:19Z, `ca65da2b…`)

| Item          | Valor                                                                 | ✔/✘ |
| ------------- | --------------------------------------------------------------------- | --- |
| Memória       | 3924 MB total; 1219 usados; **2705 disponíveis**                      | ✔   |
| Swap          | 2 GB (`/swapfile`); 32,8 MB usados                                    | ✔   |
| Disco `/`     | 49 GB; 14 GB usados; 34 GB livres; **29%** (alerta em 80%)            | ✔   |
| Carga         | 0,58 / 0,17 / 0,05 (1/5/15 min); uptime 25 dias                       | ✔   |
| CPU contêineres | 0,00–0,21%                                                          | ✔   |
| Memória/limite | web 177/640 MiB; api 160 MiB/1 GiB; caddy 59/192 MiB; backup 24/384 MiB; postgres 86 MiB/1 GiB | ✔ |

## 4. Migrations: aplicadas × candidata

`migration_status` (17:21:44Z, `e4861cae…`): **33 aplicadas**, todas concluídas, nenhuma revertida,
`applied_steps_count=1`. 31 em 2026-10-19T16:45Z (primeiro deploy) e 2 em 2026-10-23T01:18Z.

Commit candidato: **37** pastas em `packages/db/prisma/migrations` (+ `migration_lock.toml`). As 33
aplicadas são as 33 primeiras, com nomes iguais e conteúdo idêntico ao de `7b4177b`. Nenhuma migration
existe no banco e falta no candidato.

**Faltam 4** (todas aditivas):

| # | Migration                                   | O que faz                                                                                                                                                                                                                                                                                                                                                           | Risco para os dados reais |
| - | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1 | `20270302000000_modulos_configuraveis`      | Cria `module_settings` (vazia), 2 CHECK e FK → `users` (SET NULL).                                                                                                                                                                                                                                                                                                  | Baixo. Tabela nova. A FK pega lock `SHARE ROW EXCLUSIVE` breve em `users` (6 linhas). Sem NOT NULL em tabela existente, sem backfill, sem conversão. |
| 2 | `20270309000000_materiais_estoque_entrega`  | Cria `inventory_categories`, `inventory_items`, `fabric_rolls`, `inventory_adjustments` (com gatilho imutável `cenario_reject_mutation()`) e `service_order_materials`, com índices, CHECK e FKs → `users`, `service_orders`, `purchase_order_items`, `service_order_costs`. **Altera tabelas existentes:** `deliveries ADD COLUMN origin VARCHAR(20) NOT NULL DEFAULT 'LOGISTICA'` + CHECK; `service_order_costs`: `DROP` e `ADD` do CHECK `service_order_costs_kind`, acrescentando a origem `MATERIAL_OS`. | Baixo. `NOT NULL` **com** default constante: no PG 16 é só metadado, sem reescrita. `deliveries` tem 0 linhas. O novo CHECK é revalidado em `service_order_costs` sob `ACCESS EXCLUSIVE`, mas a tabela tem 1 linha e a lista nova contém a antiga (o mesmo conjunto + `MATERIAL_OS`), então a linha existente continua válida. Entre o DROP e o ADD, a mesma transação mantém o lock. As FKs pegam locks breves nas tabelas referenciadas (dezenas de linhas). Dependências conferidas no fingerprint: a função `cenario_reject_mutation()` existe; o CHECK antigo existe com a lista de 7 origens. |
| 3 | `20270316000000_reformulacao_fase_2`        | `stored_files`: 6 colunas novas **anuláveis**, índice único `thumb_key` e CHECK `stored_files_processed`. Cria `service_model_materials` (usa os enums `piece_type` e `service_type`). `service_order_materials`: coluna `source_model_material_id` + FK + índice. | Baixo. As colunas são anuláveis, sem default nem backfill. O CHECK é validado nas **3** linhas de `stored_files`: com as colunas novas NULL, cai no ramo "tudo NULL" e passa. O índice único é criado sobre valores NULL (3 linhas). Os enums existem com os valores esperados (fingerprint). |
| 4 | `20270323000000_reformulacao_fase_3`        | `quality_inspections`: `self_approval_reason` (anulável) + CHECK; `packaging_required BOOLEAN NOT NULL DEFAULT true`. `deliveries`: `reverted_at`, `reverted_by_id`, `revert_reason` (anuláveis), FK → `users` e CHECK `deliveries_revert` (depende de `origin`, da #2). | Baixo. `NOT NULL DEFAULT true` constante: só metadado. `quality_inspections` e `deliveries` têm 0 linhas, então os CHECKs validam nada. Depende da ordem (#2 antes de #4), garantida pelo nome. |

Resumo de risco (pela leitura do SQL; **não substitui** o `migration_precheck`, que não pôde rodar):
nenhuma migration apaga, converte tipo ou faz backfill, e nenhuma acrescenta `NOT NULL` sem default.
As tabelas existentes afetadas (`deliveries` 0, `service_order_costs` 1, `stored_files` 3,
`quality_inspections` 0 linhas) são pequenas, então os locks `ACCESS EXCLUSIVE` duram pouco. As FKs
para `users`, `service_orders`, `purchase_order_items` e `service_order_costs` pegam lock
`SHARE ROW EXCLUSIVE` breve nessas tabelas.

## 5. Esquema atual × exigido

| Item                                                     | Resultado                                                                                       | ✔/✘/limitação |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| Migrations do banco ⊂ candidato                          | 33/33 presentes no candidato; 0 desconhecidas; 0 incompletas                                    | ✔             |
| Objetos das 4 pendentes já existem?                      | Não: nenhuma das tabelas novas aparece no fingerprint, nem as colunas novas de `deliveries`, `stored_files` e `quality_inspections`. Sem conflito de criação. | ✔ |
| Pré-requisitos das pendentes                             | `cenario_reject_mutation()`, enums `piece_type`/`service_type`, CHECK `service_order_costs_kind` (lista antiga), tabelas referenciadas: presentes | ✔ |
| `migration_precheck version=696e3e9` (preflight do runner) | **Não executado**: a imagem da candidata não está na VM nem no `cenario-prod`                  | limitação     |

Objetos no fingerprint (17:21:57Z): 11 funções, 66 gatilhos, 388 índices, 622 restrições, 47 tipos.

## 6. Integridade dos dados (só números)

`database_counts` (17:21:51Z, `92e45534…`) e `database_fingerprint` (17:21:57Z, `4d50fa57…`). O
fingerprint tem uma linha por tabela (contagem + hash do conteúdo) e as definições do esquema; está
em `14-database_fingerprint.txt`, sem valores de linhas.

| Agregado                                          | Valor |
| ------------------------------------------------- | ----- |
| Tabelas de usuário (inclui `_prisma_migrations`)  | 119   |
| Tabelas com linhas / vazias                       | 59 / 60 |
| Maiores                                           | `domain_events` 606, `audit_logs` 235, `role_permissions` 86, `notifications` 75, `attendance_corrections` 69, `operational_attendances` 68 |
| Cadastro                                          | `users` 6, `employees` 6, `roles` 6, `user_roles` 9, `devices` 6, `sessions` 21 |
| Operação                                          | `customers` 7, `commercial_orders` 7, `service_orders` 7, `service_order_items` 7, `receipts` 7, `production_tasks` 21, `production_plans` 3, `purchase_orders` 2 |
| Financeiro                                        | `customer_receivables` 13, `customer_payments` 1, `financial_events` 23, `production_payables` 1, `service_order_costs` 1 |
| Tabelas que as migrations pendentes alteram       | `deliveries` 0, `service_order_costs` 1, `stored_files` 3, `quality_inspections` 0 |

A produção **tem dados reais** (pedidos, OS, recebíveis): não é mais o banco vazio do primeiro deploy.
Tamanho do banco: 17 MB.

## 7. Arquivos e volumes (`disk_status`, 17:21:28Z, `10921408…`)

| Item                          | Valor                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| `/dev/sda1`                   | 49 GB, 14 GB usados, 34 GB livres (29%)                       |
| Imagens Docker                | 7 (5 em uso), 8,995 GB; recuperável 941 kB                    |
| Volumes locais                | 5 (5 em uso), 98,87 MB                                        |
| Contêineres                   | 5, 110,6 kB                                                   |
| Cache de build                | 0                                                             |
| `/data/backups`               | 23 MB                                                         |
| `stored_files` (banco)        | 3 registros                                                   |
| `images_cleanup_plan` (17:22:07Z) | **0 candidatas à remoção**; protegidas: `7b4177b` (ativa) e `9fb1786` (ponto de recuperação); 33,58 GiB livres; nada removido |

Espaço para a candidata: ~4 GB por imagem (≈ 8 GB para o par api+web, pela homologação). Cabe nos
33,6 GiB livres: ficariam ~25 GiB, acima dos 10 GB que `preparar-versao` exige.

## 8. Backups

| Item                                     | Resultado                                                                                              | Hora UTC (job)           | ✔/✘/limitação |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ | ------------- |
| `backup_list`                            | **28** pastas, de `20261019T164122Z` a `20261113T164142Z`: 1 por dia às ~16:41Z + 2 extras (`20261019T164342Z`, `20261023T011727Z`, este 1 min antes das 2 migrations de 23/10) | 17:22:03 (`1ae46458…`) | ✔ |
| Mais recente                             | `cenario-production-20261113T164142Z`: **~40 min** de idade na hora da consulta                       | —                        | ✔             |
| `backup_validate` (SHA-256) do mais recente | `SHA256SUMS conferido`                                                                              | 17:22:28 (`83a437cc…`)   | ✔             |
| Envio ao bucket `cenariogestao-prod-backups` | Não verificado: nenhuma operação da lista autorizada lê o bucket (`application_logs unit=cenario-backup-upload` não estava autorizada) | — | limitação |
| Snapshots do disco (`gcloud compute snapshots list`) | **403**: `Required 'compute.snapshots.list' permission for 'projects/cenariogestao'`. Não contornado. | 17:23:22 | limitação |
| Ponto de recuperação vigente             | A VM protege `9fb1786` como "versão do ponto de recuperação" (primeiro deploy, banco vazio). Não há ponto registrado posterior aos dados reais. Um ponto novo exige `recovery_point_create` (MUTATING), fora desta auditoria. | 17:22:07 | registro |

## 9. Imagens da candidata no Artifact Registry `cenario-prod`

`operar.py imagens 696e3e9ddc5f1c803a4b9244a075ed498ad81be3` (17:20:37Z):

| Imagem                     | Existe em `cenario-prod`? | ✔/✘ |
| -------------------------- | ------------------------- | --- |
| `api:696e3e9…`             | **não**                   | ✘   |
| `web:696e3e9…`             | **não**                   | ✘   |

As imagens da candidata **ainda precisam de promoção** (`infra/prod/gcp/promover-imagens.sh`, conta
do dono) com os digests autorizados `264884b3…` (api) e `cb76d474…` (web). Pelo repositório, esses
são os digests da imagem `696e3e9` ativa na homologação. **Nada foi promovido.**

## 10. Logs recentes

`container_logs` com `lines=5000 since_minutes=10080`, entre 17:22:58Z e 17:23:22Z. Contagens em
`20-container_logs-contagens.txt`.

| Serviço  | Janela efetivamente coberta              | 5xx   | Nível ≥ 50 (pino) | Linhas ERROR/FATAL | Observação |
| -------- | ---------------------------------------- | ----- | ----------------- | ------------------ | ---------- |
| api      | 2026-11-12T21:00Z → 2026-11-13T17:22Z (**~20 h**: atingiu o limite de 5000 linhas) | **0** (2xx 2485, 4xx 18) | **0** (só nível 30) | 0 | limitação: não cobre os 7 dias |
| caddy    | 2026-11-06T17:35Z → 2026-11-13T17:22Z (~7 dias) | **0** (1xx 22, 2xx 1542, 3xx 2824, 4xx 483) | — | 0 | cobre a semana toda pelo proxy |
| web      | 2026-11-07 → 2026-11-13                  | —     | —                 | 7                  | 7× "The Server Reference ID did not match the expected format" (Server Action malformada; origem não confirmada); nenhuma 5xx no caddy |
| postgres | 2026-11-09 → 2026-11-13                  | —     | —                 | 1                  | 1× violação de unicidade `devices_name_key` (2026-11-11T16:50Z) |
| backup   | 2026-11-07 → 2026-11-13                  | —     | —                 | 0                  | — |

## 11. Limitações registradas

1. `migration_precheck version=696e3e9` não executado: a imagem não está na VM, e baixá-la exige
   `prepare_version` (MUTATING). Substituído pela comparação `migration_status` × repositório (§4–5).
2. `migration_status version=696e3e9` não executado: faria `docker run` (pull) da imagem da candidata.
3. Snapshots: 403 (`compute.snapshots.list`). Não contornado.
4. Envio de backups ao bucket não verificado (nenhuma operação autorizada o lê).
5. Logs da API: só ~20 h cobertas (teto de 5000 linhas do catálogo). Para 5xx nos 7 dias, vale o caddy.
6. O ponto de recuperação protegido na VM é o do banco vazio (`9fb1786`). Nenhum foi criado nesta
   auditoria (MUTATING).

## 12. Operações executadas (todas READ_ONLY)

| # | Operação                                      | Início UTC | Job (jti)                               | Saída |
| - | --------------------------------------------- | ---------- | --------------------------------------- | ----- |
| 0 | `catalogo` (local)                            | 17:20      | —                                       | 0     |
| 1 | `vm-status` (Compute API, GET)                | 17:20:36   | —                                       | 0     |
| 2 | `imagens 696e3e9…` (Artifact Registry, GET)   | 17:20:37   | —                                       | 1 (ausentes) |
| 3 | `verificar` (`gate_status` + `version`)       | 17:20:38   | `9ce2bcde…`, `f9df9578…`                | 0     |
| 4 | `status`                                      | 17:20:58   | `2c5ad5a1-2f41-40de-a1a9-0cf5f275deb2`  | 0     |
| 5 | `containers_status`                           | 17:21:07   | `2829809b-e822-48a0-896e-37a39f078fdc`  | 0     |
| 6 | `health`                                      | 17:21:13   | `c82abed1-0f14-41a3-a45b-8f9cfcf039ba`  | 0     |
| 7 | `resources`                                   | 17:21:19   | `ca65da2b-c636-40f5-a2fe-2cb711bf7511`  | 0     |
| 8 | `disk_status`                                 | 17:21:28   | `10921408-30f8-4522-a9d9-f6bd15fd29f2`  | 0     |
| 9 | `network_status`                              | 17:21:37   | `d9f784a0-76d4-4960-96c0-2906be6f0d2b`  | 0     |
| 10 | `gate_status`                                | 17:21:40   | `2361afe4-e979-4d0a-a396-e7a06e4602f5`  | 0     |
| 11 | `migration_status` (sem versão)              | 17:21:44   | `e4861cae-904a-449b-8b8e-9955318ae0ac`  | 0     |
| 12 | `database_status`                            | 17:21:47   | `4b7ab322-ecf2-4aaf-9625-3fa1bca728f2`  | 0     |
| 13 | `database_counts`                            | 17:21:51   | `92e45534-f76e-412a-b787-88dda55110ee`  | 0     |
| 14 | `database_fingerprint`                       | 17:21:57   | `4d50fa57-1844-4b99-8cce-73e456223554`  | 0     |
| 15 | `backup_list`                                | 17:22:03   | `1ae46458-5723-4092-ae5b-f7d4d79b3000`  | 0     |
| 16 | `images_cleanup_plan` (só o plano)           | 17:22:07   | `c9f2596d-ea4f-4ca3-8e62-299b66c8f53a`  | 0     |
| 17 | `backup_validate folder=cenario-production-20261113T164142Z` | 17:22:28 | `83a437cc-21aa-4187-b423-dbeb29389820` | 0 |
| 18 | `smoke_test`                                 | 17:22:38   | `575d8184-c64d-48a1-92b7-faaaf88f1b97`  | 0     |
| 19 | `websocket_test`                             | 17:22:47   | `bc705a3b-966e-433d-80f2-af03a40da31b`  | 0     |
| 20 | `container_logs` api/web/caddy/postgres/backup | 17:22:58–17:23:20 | `545d988c…`, `3fabbbc7…`, `ddd1aa5a…`, `e677e360…`, `0be3b572…` | 0 |
| 21 | `gcloud compute snapshots list` (leitura)    | 17:23:22   | —                                       | 1 (403) |
