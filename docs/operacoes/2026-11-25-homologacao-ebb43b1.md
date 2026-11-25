# 25/11/2026 — Homologação de `ebb43b1` (lista Comprar + o que cada aparelho mostra + site para assistentes de IA) — **caso A**

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma OS gerada, nenhum "Comprei" ou "Material comprado" marcado, nenhum
aparelho alterado.

## Homologação anterior interrompida: `6d2650c`

A homologação de `6d2650c99c0ecef4ed021f6d8fffe722ce10bca8` foi interrompida a pedido do dono, que
mandou o texto único de `ebb43b1`. Chegou a fazer, sem mudar a versão ativa nem o banco: build
`89798c22-3c93-4313-a8a0-6b99408872f3` (SUCCESS), `gate_open` e o início do `prepare_version` (a
candidata ficou em `6d2650c`). Conferido às 00:11 UTC: ativa e migrada continuavam `e10362e`, saúde OK,
portão aberto. A homologação seguiu como **caso A** (ativa `e10362e`, 55 migrations).

## `ebb43b1`

- Commit: `ebb43b1c7ad291556df7334a070c19705c2ef173` (branch `claude/project-thread-4r7xfw`; `git cat-file -t` = `commit`; contém `6d2650c` e `e10362e`; o `FETCH_HEAD` era esse mesmo hash). De `6d2650c` para `ebb43b1`, só `apps/web`. Sem variável nova nem `infra/`.
- Versão antes: `e10362ed1bcb1a57f72dbf61989b0105ddca77b2` · depois: `ebb43b1c7ad291556df7334a070c19705c2ef173` (etiqueta, pilha, candidata e migrada). Scripts da VM inalterados (`d6d30306de26`).
- Build `2a4ad933-fce5-4ead-84e0-10adda4f594d`: SUCCESS (00:13:28 → 00:19:02 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:2ace551c1008060c47d1fc3a64cf045b6d293f8c6ac2c1f5098cd1c80684f148`
  - web `sha256:7d31b6e251896797b9dc4135fda6b6bb81b2f7962338802373925a4d84a51ac8`
- Migration: `20270902000000_aparelho_mostra` (2 comandos: tipo `device_shows` e coluna `devices.shows` NOT NULL DEFAULT 'TUDO'), aplicada em **44 s**. Reversão: `packages/db/rollback/20270902000000_aparelho_mostra.down.sql`.
- Ponto de recuperação: `cenario-staging-20261125T002209Z` (versão `e10362e`, impressão `677792de805ce3cdc16f272f8df76be6`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00:04       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `e10362e`; saudável; portão fechado; disco 52%                                                                                    |
| 00:04–00:11 | `6d2650c`: build, gate_open, prepare_version (interrompido)            | ver acima                                                                                                                                         |
| 00:13–00:19 | imagens de `ebb43b1` (ausentes) → build-iniciar / build-acompanhar     | SUCCESS                                                                                                                                           |
| 00:19       | images_cleanup_plan → images_cleanup                                   | removidas 2 imagens (`70b8d51`, api e web; continuam no Artifact Registry; volumes não tocados); livre: 11,13 → 13,46 GiB                         |
| 00:19:55    | prepare_version (portão já aberto)                                     | OK; digests acima; imagem: 56 migrations, banco: 55; disco livre 12 GB                                                                            |
| 00:21:42    | migration_precheck                                                     | **caso A**: exatamente 1 pendente, `20270902000000_aparelho_mostra`; esquema compatível                                                           |
| 00:21       | database_fingerprint e database_counts (antes)                         | registradas                                                                                                                                       |
| 00:22:03    | maintenance_on                                                         | API e web paradas (00:22:05)                                                                                                                      |
| 00:22:06    | recovery_point_create                                                  | `cenario-staging-20261125T002209Z`                                                                                                                |
| 00:23:22    | backup_validate                                                        | SHA256SUMS conferido                                                                                                                              |
| 00:23:25    | migrate                                                                | 1 aplicada em 44 s                                                                                                                                |
| 00:24:20    | migration_verify                                                       | 56/56, nenhuma pendente                                                                                                                           |
| 00:24:23    | activate_version                                                       | Saúde OK (disco 61%, memória 1021 MB); API e web de pé, então o `maintenance_off` não foi necessário                                              |
| 00:26:1x    | gate_close                                                             | fechado                                                                                                                                           |
| 00:26+      | version, smoke_test, websocket_test, run_homologation_tests `completo` | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔                                                                 |
| 00:31:21    | database_counts, database_fingerprint (depois), logs                   | mais de um ciclo de 5 min depois da ativação; api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`** e **nenhuma falha de timer** |

Indisponibilidade: cerca de 4 min (00:22:05 → ~00:26:05).

## Contagens e impressão digital antes/depois

177 tabelas antes e depois. **Nenhuma contagem caiu.** Cresceram só `_prisma_migrations` (55 → 56)
e `status_samples` (2128 → 2130). Estrutura: só o tipo `device_shows` (TUDO, PRODUCAO, LOGISTICA) e a
coluna `devices.shows` com padrão `'TUDO'`. Os 2 aparelhos existentes ficaram, com a mesma contagem,
em `TUDO`, que é o padrão da coluna. Nenhuma outra tabela mudou.

## Testes do repositório (passo 6)

Rodados no commit exato (worktree de `ebb43b1`, `pnpm install --frozen-lockfile`). Os da API rodaram
contra um banco PostgreSQL 16 local e descartável criado pelas 56 migrations:

| Arquivo                                                 | Resultado                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/api/test/fluxo-os.test.ts`                        | **12 de 12**                                                                                             |
| `apps/api/test/devices.test.ts`                         | **14 de 14**                                                                                             |
| `apps/api/test/fase1-materiais-estoque-entrega.test.ts` | **15 de 15**                                                                                             |
| `apps/api/test/oficina-sem-tablet.test.ts`              | **9 de 9**                                                                                               |
| `apps/api/test/multi-empresa-banco.test.ts`             | **9 de 9**                                                                                               |
| `apps/api/test/multi-empresa-mapa.test.ts`              | **7 de 7**                                                                                               |
| `apps/api/test/multi-empresa-vazamento.test.ts`         | **4 de 4** (a varredura cobre todas as rotas GET sem parâmetro, incluindo `/api/v1/os-materials/to-buy`) |
| `apps/api/test/rodada4-travas-estruturais.test.ts`      | **19 de 19**                                                                                             |
| `apps/web/test/agentes.test.ts` (sem banco)             | **9 de 9**                                                                                               |

## Endereços para assistentes de IA

Desta sessão não deu para conferir pela homologação: o proxy de saída respondeu `502` ao abrir
`teste.cenariogestao.com.br`, e a sessão também não tem a senha do proxy da homologação. Por isso o web
do **commit exato** foi levantado localmente (`next dev` no worktree de `ebb43b1`, porta local), e os
mesmos endereços foram chamados ali. Todos leem só `components/site/config.ts`, sem banco nem sessão.

| Endereço                                            | Resposta                                                                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/robots.txt`                                       | 200 `text/plain`. Libera `/llms.txt`, `/.well-known/`, `/info/` e `/openapi.json`; bloqueia `/painel`, `/tablet`, `/entrar`, `/api/`, `/autorizar`, `/ambiente-interativo`, `/proposta/`, `/album/` e `/agendar/` |
| `/sitemap.xml`                                      | 200 `application/xml`                                                                                                                                                                                             |
| `/.well-known/api-catalog`                          | 200 `application/linkset+json`                                                                                                                                                                                    |
| `/.well-known/agent-card.json`                      | 200 `application/json`                                                                                                                                                                                            |
| `/.well-known/mcp/server-card.json`                 | 200 `application/json`                                                                                                                                                                                            |
| `/.well-known/agent-skills/index.json`              | 200 `application/json`                                                                                                                                                                                            |
| `/.well-known/agent-skills/cenario-gestao/SKILL.md` | 200 `text/markdown`                                                                                                                                                                                               |
| `/llms.txt`                                         | 200 `text/markdown`                                                                                                                                                                                               |
| `/openapi.json`                                     | 200 `application/openapi+json`                                                                                                                                                                                    |
| `/info/produto`                                     | 200 `application/json`                                                                                                                                                                                            |

- **Digest:** o sha256 do `SKILL.md` baixado (`49d66eff…7bd144`) é **igual** ao `digest` do `index.json`.
- **Link:** `GET /` traz `Link: </.well-known/api-catalog>; rel="api-catalog", …`.
- **MCP:** `tools/call ver_planos` responde com "R$ 399,00". `tools/list` lista 5 ferramentas (`sobre_o_cenario_gestao`, `ver_planos`, `como_criar_conta`, `falar_com_a_equipe`, `perguntas_frequentes`), todas com `readOnlyHint: true`.
- **A2A:** `message/send` com "Quanto custa?" responde com os planos (R$ 399 e R$ 599).
- **Isolamento:** nenhum desses arquivos (fora o `robots.txt`, que só bloqueia) menciona `/painel`, `/tablet`, `/proposta`, `/album`, `/agendar` ou `/api/v1`. O único nome além de "Cenário" é "Firma Viva", que é o nome do produto do plano de R$ 599, não um cliente.

O servidor local foi parado. O banco de teste, o papel temporário e a cópia de trabalho foram apagados
ao fim.

Não verificado por mim, na homologação: as respostas reais desses endereços, `/painel/os`,
`/painel/estoque-oficina`, `/painel/dispositivos` e `GET /api/v1/os-materials/to-buy` com sessão. Isso
fica para o teste do dono.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `e10362e`, com 55 migrations).
