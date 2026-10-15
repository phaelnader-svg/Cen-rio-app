# Homologação do `406fde7` — publicação autônoma controlada

Data: 2026-10-15 (UTC). Ambiente: homologação `cenario-homolog` (projeto `cenariogestao`). Produção fora do escopo e não tocada.
Executado inteiramente pela infraestrutura de autonomia (identidade `claude-operador`, operações nomeadas do runner 2.0.0,
gatilho de build com `cenario-build`), sem SSH e sem Cloud Shell. Código da aplicação: `406fde70d88396e874cc6194960523d0dee02fd5`, inalterado.

**Classificação: GO WITH CAVEATS** (ressalvas no fim).

## 1. Estado inicial (antes de qualquer MUTATING)

| Item                               | Observado                                                                                          | Esperado     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------ |
| Versão ativa / candidata / migrada | `eb3fe2a` / `eb3fe2a` / `eb3fe2a`                                                                  | `eb3fe2a`    |
| Migrations                         | 18 aplicadas, 0 falhas; 7 pendentes na imagem `406fde7` (exatamente as previstas)                  | 18 + 7       |
| Contêineres                        | 5 em execução; api, web, postgres `healthy`                                                        | —            |
| Disco `/`                          | 20 GB, 5,8 GB livres (70%)                                                                         | ~5,8 GB      |
| Memória                            | 1048 MB disponíveis; swap 146 MB usados                                                            | —            |
| Saúde                              | `health` OK, `/api/ready` 200                                                                      | —            |
| Portão de publicação               | **ABERTO** (ficou assim desde a instalação)                                                        | —            |
| Imagens `406fde7`                  | inexistentes                                                                                       | inexistentes |
| Artifact Registry                  | 6 imagens: `fd6dc19`, `4f9b1ae`, `eb3fe2a` (api/web)                                               | —            |
| Backups                            | 9 diários, o último de 14/10 17:13 UTC                                                             | —            |
| Operação concorrente               | nenhuma (todos os jobs do runner nas 2 h anteriores eram desta sessão; nenhuma build em andamento) | —            |
| Impressão digital do banco         | `48ef1f94f8ab1bf7722c173366683cb7` (3690 itens)                                                    | —            |

Nenhuma divergência material.

## 2. Disco

- **Nenhuma limpeza foi feita**: o catálogo do runner não tem operação de remoção de imagens. Para criar uma seria preciso publicar uma
  nova versão do runner, e o bucket de versões do runner é, por desenho, só de publicação humana.
- Medição: depois do pull do `406fde7` (+2,2 GB) ficaram **3,6 GB livres (81%)**, acima do mínimo de 3 GB que o `preparar-versao` exige.
  Banco de 17 MB e backups de ~5 MB: margem suficiente para esta rodada.
- Candidatas à remoção numa rodada futura: imagens `fd6dc19` e `4f9b1ae` (não usadas por contêiner nem necessárias ao rollback,
  que é para `eb3fe2a`).

## 3–5. Build

| Item        | Valor                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Caminho     | `operar.py build-iniciar 406fde7` → Pub/Sub `cenario-homolog-build` → gatilho `cenario-homolog-build-autonomo`         |
| Build ID    | `5ba8c6db-4818-4c4b-aad0-21276fe6e60f` — **SUCCESS** (05:28:08 → 05:33:05 UTC)                                         |
| Conta       | `cenario-build@cenariogestao.iam.gserviceaccount.com` (nenhum `cloudbuild.builds.create` pelo operador)                |
| Fonte       | `gs://cenariogestao-homolog-build/source/406fde70d88396e874cc6194960523d0dee02fd5.tgz` (`git archive` do commit exato) |
| Etapas      | fonte ✔ · api ✔ · web ✔                                                                                             |
| api:406fde7 | `sha256:28f724bf9081c7d76830583ca2a8a32398ea90f426421f746b8a2aac49d45e15`                                              |
| web:406fde7 | `sha256:eca612f4b170f205acc064424195748bb763037a72a002cea000b6c9def58a8d`                                              |

Os digests puxados na VM pelo `prepare_version` são os mesmos. A imagem não migra na partida (`api-iniciar.sh` presente).

## 6–8. Ponto de recuperação, backup e impressão digital

1. `migration_precheck`: o SQL instalado na VM (`9f29300`) cobre só as migrations da Evolução, já aplicadas. Ele não bloqueia nem cobre as 7 novas.
   Por isso as 7 foram revisadas no código: todas aditivas; dependem de dados só no INSERT idempotente de permissões e nos 2 modelos com ids fixos.
   `migration_status version=406fde7`: pendentes = as 7 esperadas; no banco e ausentes da imagem: nenhuma; iniciadas e não concluídas: nenhuma.
2. `maintenance_on` (05:35:36): API e web paradas; o proxy responde 503.
3. `recovery_point_create`: backup `cenario-staging-20261015T053547Z`.
   - Contém `database.dump`; SHA256SUMS conferido.
   - Restauração de teste em banco separado **idêntica** ao original: 3690 itens, 111 tabelas, 31 colunas financeiras, 539 restrições, 348 índices, 60 gatilhos, 25 sequências.
   - 26 definições reescritas pelo PostgreSQL no dump/restore, equivalentes e iguais à referência.
   - Cópia fora da VM enviada a `gs://cenariogestao-homolog-backups/backups/`.
4. `backup_validate` independente: SHA256SUMS conferido.
5. Impressão digital:
   - **antes** `48ef1f94f8ab1bf7722c173366683cb7`, igual à da auditoria, portanto nada foi gravado entre auditoria e backup;
   - **depois** das migrations `140428a4d28eab36a4dffc7828f36c8a`.

## 9–10. Migrations

`migrate 406fde7`: banco idêntico ao ponto (0 min); aplicadas em 11 s, todas com sucesso:

1. `20261129000000_novo_servico` ✔
2. `20261206000000_recebimentos_compartilhados` ✔
3. `20261213000000_pre_planejamento` ✔
4. `20261220000000_recebimentos_permissao_funcoes` ✔
5. `20261227000000_servico_sem_retirada` ✔
6. `20261228000000_titular_mao_de_obra_prevista` ✔
7. `20261230000000_modelos_simplificados` ✔

`migration_verify 406fde7`: **25/25**; 0 pendentes, 0 desconhecidas, 0 incompletas, 0 revertidas.

Diferenças na impressão digital, antes → depois:

| Tabela                                                                                                                   | Antes | Depois            | Leitura                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| `production_templates`                                                                                                   | 3     | **5**             | os 2 modelos simplificados (ids `5f5e…0001` e `…0002`)                                                 |
| `production_template_steps`                                                                                              | 14    | **19**            | 3 etapas (reforma) + 2 (cabeceiras)                                                                    |
| `role_permissions`                                                                                                       | 75    | **78**            | `recebimentos.registrar` para as 3 funções previstas (`tapeceiro`, `cabeceiras_qualidade`, `ajudante`) |
| `users`                                                                                                                  | 7     | 7                 | nenhum usuário nem responsável inventado; seed não executado                                           |
| `logistics_trip_participants`, `material_arrivals`                                                                       | —     | 0                 | tabelas novas, vazias                                                                                  |
| `commercial_orders`, `commercial_order_items`, `company_settings`, `production_plan_items`, `receipts`, `service_orders` | n     | n (mesmas linhas) | o hash muda só por causa das colunas novas com padrão (sem reescrita de dados)                         |
| Colunas financeiras existentes                                                                                           | —     | iguais            | só aparece a nova `planned_labor_unit_cents` (vazia)                                                   |

Limitação: o runner não tem consulta por função ou por modelo (SQL só em constantes). A atribuição exata às 3 funções vem do
SQL da migration, que filtra por essas chaves com `ON CONFLICT DO NOTHING`, mais o acréscimo de exatamente 3 linhas.

## 11–13. Ativação, contêineres e saúde

- `activate_version 406fde7`: etiqueta local fixada (drop-in do systemd); `vm.sh ativar` subiu API e web (a manutenção terminou aí); **Saúde: OK**.
- `version`: drop-in `406fde7` · ambiente da pilha `406fde7` · candidata `406fde7` · migrada `406fde7`.
- `gate_close`: portão **fechado**.
- Contêineres: api e web `healthy` (recriados com as imagens novas), postgres `healthy`, caddy e backup em execução; nenhum reinício após a subida.
- `health`, `status`, `containers_status`, `smoke_test` (`vm.sh saude`), `network_status`: OK.
  - proxy exige credencial (401 + Basic);
  - `/api/ready` → `{"status":"ready"}`;
  - `/entrar` 200 e JavaScript da tela 200;
  - sem HTTP/3;
  - certificado com 84 dias;
  - 25 migrations.
- `run_homologation_tests suite=completo`: suítes saude ✔, acesso ✔, websocket ✔.

## 14. Testes funcionais

O runner não tem testes funcionais com usuário (por desenho, sem credenciais de aplicação). A cobertura funcional do `406fde7` vem do
**CI nº 112** (run 38644798546), que rodou o **mesmo commit** e passou: format, lint, typecheck, migrations do zero com
`prisma migrate diff` sem divergência, build, `pnpm test` (API, shared, inclusive proxy Caddy real), `pnpm test:backup` e E2E Playwright.

| Área                                               | Testes no `406fde7`                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recebimentos; chegada parcial/repetida/idempotente | `apps/api/test/recebimentos-compartilhados.test.ts`, `receipts-service-orders.test.ts`, `tests/e2e/specs/recebimentos.spec.ts`, `recebimentos-rede.spec.ts` |
| Serviço sem retirada                               | `apps/api/test/novo-servico.test.ts`, `tests/e2e/specs/novo-servico.spec.ts`                                                                                |
| Titular e mão de obra prevista                     | `apps/api/test/titular-previsto.test.ts`                                                                                                                    |
| Permissões de recebimento                          | `recebimentos-compartilhados.test.ts`, `commercial-realtime.test.ts`, `migrations.test.ts`                                                                  |
| Fila/planejamento, D9, rascunhos antigos manuais   | `apps/api/test/pre-planejamento.test.ts`, `packages/shared/test/production.test.ts`                                                                         |
| Fechamento financeiro e concorrência               | `apps/api/test/closing.test.ts`, `closing-perf.test.ts`, `tests/e2e/specs/team-closing.spec.ts`                                                             |
| Tablets e resposta perdida                         | `tests/e2e/specs/tablets.spec.ts`, `recebimentos-rede.spec.ts`, `apps/api/test/sync-audit.test.ts`                                                          |
| Modelos simplificados, D6/D7/D14                   | `apps/api/test/modelos-simplificados.test.ts`, `packages/shared/test/modelos-simplificados.test.ts`, `tests/e2e/specs/modelos-simplificados.spec.ts`        |
| D8 (ninguém aprova a própria peça)                 | `apps/api/test/quality.test.ts`, `packages/shared/test/quality.test.ts`                                                                                     |
| Migrations (incl. reversão condicionada)           | `apps/api/test/migrations.test.ts`                                                                                                                          |

## 15. WebSocket

`websocket_test`: handshake em `/api/realtime` pelo proxy → 401 sem sessão (esperado; prova o encaminhamento até a API).
O Caddy registrou dois `101` de sessões reais encerradas na entrada da manutenção (05:35:35).

## 16. Logs e anomalias (últimos 30–40 min)

- API: 25 linhas `info` e **1 `warn`**: `TRUST_PROXY confia numa FAIXA inteira (172.28.0.0/24)`. Nenhum erro, nenhum 5xx.
- Web: sem erros. Postgres: sem `ERROR`/`FATAL`/`PANIC`.
- Caddy: 200 ×17, 307 ×4, 308 ×3, 401 ×10, 101 ×2; **nenhum 5xx** e nenhum erro.
- Docker e unidade `cenario-homolog`: só a parada pedida (manutenção); sem OOM, crash ou reinício.
- Runner: 39 jobs aceitos, todos concluídos (o último em execução era a própria coleta); nenhum recusado, falho ou interrompido.

## 17. Disco e memória finais

Disco 3,6 GB livres (81%) · memória disponível 1038 MB · swap 101 MB.
Uso de memória: api 98/512 MiB, web 141/448 MiB, postgres 86/448 MiB, caddy 31/192 MiB, backup 15/256 MiB.

## 18. Problemas encontrados (classificados)

| #   | Problema                                                                                                                             | Classe                   | Impacto                                                               | Ação                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| P1  | Sem operação de limpeza de imagens; 3,6 GB livres não comportam outra versão (~2,2 GB) dentro do mínimo de 3 GB                      | infraestrutura/autonomia | o próximo deploy será recusado pelo `preparar-versao`                 | nova operação `docker_image_prune_unused` no runner, publicada por humano (`publicar-runner`), antes da próxima versão |
| P2  | `/opt/cenario` em `9f29300`: o compose da VM ainda usa `TRUST_PROXY=172.28.0.0/24` (o repositório já fixa o Caddy em `172.28.0.250`) | deploy (scripts da VM)   | só aviso; limites por IP funcionam, com confiança na sub-rede interna | atualizar os scripts da VM pelo fluxo humano                                                                           |
| P3  | `migration_precheck` (SQL `preflight-evolucao.sql`) não cobre as migrations da Simplificação                                         | infraestrutura/autonomia | nenhum nesta rodada (migrations aditivas e verificadas)               | atualizar o SQL de pré-verificação junto com P2                                                                        |
| P4  | O operador não lê o bucket de backups                                                                                                | — (por desenho)          | a cópia externa é confirmada só pelo log da VM                        | nenhuma                                                                                                                |

Nenhum problema de migration nem problema funcional da aplicação encontrado.

## 19. Rollback

Nenhum. Ponto de recuperação disponível: `cenario-staging-20261015T053547Z` (versão `eb3fe2a`, impressão `48ef1f94…`), por `rollback_to_recovery_point`.

## 20. Classificação: **GO WITH CAVEATS**

- Publicação íntegra: build do commit exato com a conta restrita, backup restaurado e conferido, 7/7 migrations, 25/25 verificadas,
  versão ativa coerente nos três registros, saúde, smoke, acesso e WebSocket OK, sem 5xx nem crash.
- Ressalvas:
  - não houve teste funcional com usuários reais na homologação; o funcional vem do CI do mesmo commit;
  - P1 (margem de disco para a próxima versão);
  - P2 e P3 (scripts da VM defasados, só com aviso).
