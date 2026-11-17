# 17/11/2026 — Homologação de `aa7ba96` (multi-empresa, etapas 2, 3 e 4)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta foi criada pelo "Criar conta" (teste do dono).

- Commit: `aa7ba96a264ad85eeb77fb26f03d7ec72d1dd4a1` (branch `claude/project-thread-x4iibr`; `FETCH_HEAD` conferido, a branch não tinha avançado). Multi-empresa sobre `64c238f` (`docs/MULTI-EMPRESA.md`): `company_id` em cada linha, com a Cenário Estofados como empresa nº 1, dona de todos os dados existentes; numeração por empresa (`company_counters`); trava no banco (RLS) com o papel `cenario_app`; "Criar conta" e painel "Empresas".
- Versão antes: `64c238f0ad949afff1b13e8e9a4f1b643fcea277` · depois: `aa7ba96a264ad85eeb77fb26f03d7ec72d1dd4a1` (etiqueta, pilha e migrada).
- Build `bf59e951-adcc-44f5-a52c-c567eceaf9ba`: SUCCESS (02:11:31 → 02:16:50 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:f8800e7fa3c42d44d038f79520058e7f0e43b8b9a7f4a189a917b934d9ce8508`
  - web `sha256:c3b48fe57d70954aaf7c4701b45dd65d5c45af964475566e8b1ea55dd906b906`
- Migrations (3, nesta ordem), aplicadas em **29 s**:
  - `20270701000000_multi_empresa_etapa2` (688 comandos): `company_id` e `company_counters`. As 30 sequências de numeração dão lugar aos contadores, que partem do último valor de cada uma.
  - `20270708000000_multi_empresa_etapa3` (330 comandos): papel `cenario_app` (NOLOGIN, sem superusuário, sem BYPASSRLS) e RLS com políticas por empresa.
  - `20270715000000_multi_empresa_etapa4` (5 comandos): chave de `module_settings` por empresa; `created_at`, `blocked_at` e `blocked_reason` em `company_settings`.
- Ponto de recuperação: `cenario-staging-20261117T021920Z` (versão `64c238f`, impressão `2dd1b120280bd4f2499a18278986439d`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                                            | Resultado                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 02:10       | verificar, version, health, gate_status, disk_status                                                                | canal OK; ativa `64c238f`; saudável; portão fechado; disco 51% (14 GB livres)                                                                                                                                                                              |
| 02:11–02:16 | imagens (ausentes) → build-iniciar / build-acompanhar                                                               | SUCCESS                                                                                                                                                                                                                                                    |
| 02:17:16    | gate_open                                                                                                           | aberto                                                                                                                                                                                                                                                     |
| 02:17:20    | prepare_version                                                                                                     | OK; digests acima; imagem: 47 migrations, banco: 44                                                                                                                                                                                                        |
| 02:18:46    | migration_precheck                                                                                                  | exatamente as 3 pendentes, na ordem; esquema compatível; nenhuma incompleta, desconhecida, divergente ou fora de ordem                                                                                                                                     |
| 02:19       | database_fingerprint e database_counts (antes)                                                                      | registradas                                                                                                                                                                                                                                                |
| 02:19:11    | maintenance_on                                                                                                      | API e web paradas (02:19:14)                                                                                                                                                                                                                               |
| 02:19:17    | recovery_point_create                                                                                               | `cenario-staging-20261117T021920Z`                                                                                                                                                                                                                         |
| 02:20:12    | backup_validate                                                                                                     | SHA256SUMS conferido                                                                                                                                                                                                                                       |
| 02:20:22    | migrate                                                                                                             | 3 aplicadas em 29 s                                                                                                                                                                                                                                        |
| 02:21:07    | migration_verify                                                                                                    | 47/47, nenhuma pendente                                                                                                                                                                                                                                    |
| 02:21:18    | activate_version                                                                                                    | Saúde OK (disco 59%, memória 1024 MB)                                                                                                                                                                                                                      |
| 02:22:2x    | gate_close                                                                                                          | fechado                                                                                                                                                                                                                                                    |
| 02:22+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_counts, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔ (login e telas do painel com os dados de antes); api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`** na partida da API ("API Cenário Gestão pronta") |

Indisponibilidade: cerca de 3 min (02:19:14 → ~02:22:10).

## Contagens e impressão digital antes/depois

A comparação foi feita pela contagem exata de cada tabela na impressão digital.

- Tabelas: 167 → 168. A nova é `company_counters`, com 30 linhas, uma por numeração. Nenhuma tabela sumiu.
- **Nenhuma contagem caiu.** A única que cresceu foi `_prisma_migrations` (44 → 47). Total de linhas: 2.481 → 2.514 (+3 migrations e +30 contadores).
- `company_id` presente em 163 tabelas. As 63 tabelas com dados mantiveram a mesma contagem e mudaram de impressão só pela coluna nova. As 103 restantes, quase todas vazias, ficaram com impressão idêntica.
- Exemplos (antes → depois): `domain_events` 1099 → 1099, `audit_logs` 314 → 314, `notifications` 189 → 189, `attendance_corrections` 113 → 113, `operational_attendances` 109 → 109, `role_permissions` 80 → 80, `production_task_events` 60 → 60, `quote_catalog_items` 35 → 35, `sessions` 33 → 33.

## Observação para antes da produção: `infra/` regredida na branch

O merge `8e3c027` ("Merge 64c238f … na branch do multi-empresa") deixou `infra/` diferente de `64c238f`:
10 arquivos, +27 −455 linhas, entre eles `infra/homolog/gcp/vm.sh`, `infra/prod/gcp/vm.sh`, os
`startup.sh`, `Caddyfile.prod`, `docker-compose.prod.yml`, e a remoção de
`infra/prod/gcp/testes/ensaio-deploy-banco-limpo.sh` e `test_deploy_banco_limpo.sh`. Entre o que sai
está, por exemplo, a checagem de cópia externa (`vm.sh envio-externo`).

Esta homologação não foi afetada: o deploy troca só as imagens, e os scripts da VM
(`/opt/cenario`) não mudam. Mas, se a branch for juntada à linha de produção como está, essas
melhorias de `infra/` voltam atrás. Convém refazer o merge mantendo o `infra/` de `64c238f` antes de
promover.

Não verificado por mim: "Criar conta", o painel "Empresas" e o isolamento entre duas empresas com
login, que ficam para o teste do dono.

Retorno, se necessário: **`rollback_to_recovery_point`**, que volta banco e versão para `64c238f`.
Voltar só a versão NÃO é seguro depois do migrate, porque a versão anterior não trabalha com a trava
do banco. As reversões SQL em `packages/db/rollback/2027071500*`, `2027070800*` e `2027070100*` se
recusam a rodar se houver mais de uma empresa.
