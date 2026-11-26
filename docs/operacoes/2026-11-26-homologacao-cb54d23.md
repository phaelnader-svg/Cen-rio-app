# 26/11/2026 — Homologação de `cb54d23` (empresa nova do site ganha o começo guiado)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhum dado alterado por mim; nenhum login criado.

- Commit: `cb54d23746df8248330e309f2f4ab6cb668a2b15` (branch `claude/project-thread-cet22y`, que aponta para esse mesmo hash; `git cat-file -t` = `commit`; contém `831fc74`). De `831fc74` para cá, exatamente os 4 arquivos esperados: `rodada4-travas-estruturais.test.ts`, a migration `20270912000000_comeco_guiado_recentes` e as reversões `20270911000000_comeco_guiado.down.sql` (agora completa) e `20270912000000_comeco_guiado_recentes.down.sql`.
- Versão antes: `831fc74373a98b7dd83f50e7a7dfb57b813b27f4` · depois: `cb54d23746df8248330e309f2f4ab6cb668a2b15` (etiqueta, pilha, candidata e migrada). Scripts da VM inalterados (`8d8a6e76ee4b`).
- Build `e24bcace-5452-45e8-be3d-c683209ef7ae`: SUCCESS (22:15:05 → 22:21:29 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:af7d63116da4cf679149db3cc7a9c503e8a37bb271be717360184d358e97c832`
  - web `sha256:734f342a6b1df89638cf5e0b9dbfd8233e0a2944d416e447d64a5716b28a7122`
- Migration `20270912000000_comeco_guiado_recentes`, aplicada em **22 s** (65 → 66). SQL lido antes: um único `UPDATE` em `company_settings`, com bypass de RLS, só nas linhas com `is_platform = false`, `is_demo = false`, `created_at >= 2026-11-24 00:00 (-03)`, `setup_answers IS NULL` e `onboarding_emails` = `{boas-vindas,dia-2,dia-5,fim-teste}`. Nessas linhas, só `setup_done_at`, `getting_started_hidden_at` (para nulo) e `onboarding_emails` (para `{boas-vindas}`) mudam.
- Ponto de recuperação: `cenario-staging-20261126T222421Z` (versão `831fc74`, 65 migrations, impressão `d2bbee9d3485f5861b6a648945c2e826`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate folder=…`: SHA256SUMS conferido, em comando separado, antes do `migrate`.

| Hora (UTC)  | Operação                                                                                                                | Resultado                                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22:14       | verificar, version, health, gate_status, disk_status                                                                    | canal OK; ativa `831fc74` (65 migrations); saudável; portão fechado; disco 53% (**14 GB livres**). Acima de 10 GB: limpeza não rodada                                                                                                                                                                      |
| 22:15–22:21 | imagens (ausentes) → build-iniciar / build-acompanhar                                                                   | SUCCESS                                                                                                                                                                                                                                                                                                    |
| 22:21:55    | gate_open                                                                                                               | aberto                                                                                                                                                                                                                                                                                                     |
| 22:21:59    | prepare_version                                                                                                         | OK; digests acima; imagem: 66 migrations, banco: 65; disco livre 11 GB depois de baixar                                                                                                                                                                                                                    |
| 22:23:56    | migration_precheck                                                                                                      | exatamente 1 pendente: `20270912000000_comeco_guiado_recentes` (3 comandos); esquema compatível                                                                                                                                                                                                            |
| 22:24       | database_counts e database_fingerprint (antes)                                                                          | registradas (189 tabelas; `company_settings` 2 linhas, hash `fd589cdc…`; `outbound_emails` 0)                                                                                                                                                                                                              |
| 22:24:15    | maintenance_on                                                                                                          | API e web paradas (22:24:17)                                                                                                                                                                                                                                                                               |
| 22:24:19    | recovery_point_create                                                                                                   | `cenario-staging-20261126T222421Z`; restauração de teste IDÊNTICA; enviado ao bucket                                                                                                                                                                                                                       |
| 22:25:38    | backup_validate `folder=cenario-staging-20261126T222421Z`                                                               | SHA256SUMS conferido                                                                                                                                                                                                                                                                                       |
| 22:25:48    | migrate                                                                                                                 | 1 aplicada em 22 s                                                                                                                                                                                                                                                                                         |
| 22:26:21    | migration_verify                                                                                                        | 66/66, nenhuma pendente                                                                                                                                                                                                                                                                                    |
| 22:26:25    | activate_version                                                                                                        | Saúde OK (disco 62%, memória 1027 MB); API e web de pé                                                                                                                                                                                                                                                     |
| 22:27:42    | gate_close                                                                                                              | fechado                                                                                                                                                                                                                                                                                                    |
| 22:28       | database_fingerprint (logo depois da migration), version, smoke_test, websocket_test, run_homologation_tests `completo` | `company_settings` com o **mesmo hash** de antes; todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; disco 62% (11 GB livres)                                                                                                                                              |
| 22:57:35    | database_counts, database_fingerprint, container_logs api/web, health                                                   | depois de **30 min 22 s** com a API no ar (desde 22:27:13), duas passadas da tarefa de 15 min: api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`**, nenhum `"Falha ao`, nenhum erro de `sendDueNotices` nem de `sendOnboardingEmails`; só 2 rejeições 401 sem sessão (suítes de acesso) |

Indisponibilidade: cerca de 2 min 56 s (22:24:17 → 22:27:13).

## Efeito da migration

- **Empresas alteradas pelo `UPDATE`: 0.** O catálogo não tem SQL livre, mas a impressão digital dá o hash do conteúdo de cada tabela. O hash de `company_settings` ficou **igual** antes e depois da migration (`fd589cdcd598f33df7a3e6eec8119600`, 2 linhas), então nenhuma linha mudou. As 2 linhas da homologação são o registro da plataforma (id 0, excluído pelo `is_platform = false`) e a empresa 1, que não atende a todas as condições do `WHERE`.
- **E-mails `teste-*` na fila: 0.** `outbound_emails` tinha 0 linhas antes e continuou com 0 depois de duas passadas da tarefa de 15 min.
- Ou seja: na homologação não havia empresa de teste criada pelo site a partir de 24/11 sem responder as perguntas, e nada mudou para os usuários. O comportamento pedido é coberto pelo `comeco-guiado.test.ts` (abaixo).

## Contagens e impressão digital antes/depois

189 tabelas antes e depois, 65 → 66 migrations, estrutura igual. **Nenhuma contagem caiu e nenhuma
tabela mudou de conteúdo.** As únicas diferenças são o registro de migrations e `status_samples`
(2681 → 2688) com a sua sequência.

## Testes do repositório (commit exato, banco descartável)

Worktree de `cb54d23`, `pnpm install --frozen-lockfile`, Postgres 16 local com banco e papel
descartáveis (apagados no fim). As suítes da api rodaram uma de cada vez.

| Suíte                                                                                           | Resultado                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| api: `rodada4-travas-estruturais`, `comeco-guiado`, `multi-empresa-banco`, `multi-empresa-mapa` | **4 arquivos, 42/42**                                                                                                  |
| api: suíte inteira (126 arquivos)                                                               | **118 passaram**, 7 pulados, **1 falhou** (a antiga conhecida); 1025 testes passaram + 3 falhas esperadas + 14 pulados |
| web (`vitest run`)                                                                              | 10 arquivos, **91 passaram + 3 falhas esperadas** (94)                                                                 |
| shared (`vitest run`)                                                                           | 22 arquivos, **134/134**                                                                                               |

A única falha é a antiga conhecida, que não é desta versão: `escritorio-financeiro.test.ts` >
"pagamento só vira pago pela conciliação; reimportar o extrato não duplica".

Não testei aqui as reversões (`*.down.sql`) num banco: o pedido diz que já foram testadas no
desenvolvimento, e a homologação não as executa.

## Disco

Antes: 14 GB livres (53%). Depois: **11 GB livres (62%)**. Ficam protegidas as imagens de `cb54d23`
(ativa) e `831fc74` (ponto de recuperação).

Retorno, se necessário: `rollback_to_recovery_point`, que volta para `831fc74` com 65 migrations.
