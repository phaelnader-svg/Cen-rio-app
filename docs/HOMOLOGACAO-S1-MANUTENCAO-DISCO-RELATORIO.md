# Homologação — manutenção do espaço em disco (após o deploy da S1)

Data: 15/11/2026, 04:00–04:05 UTC. **Só a VM `cenario-homolog`.** Produção não foi acessada. Sem
deploy, migration, merge ou mudança funcional. Evidências:
`docs/evidencias/homologacao-s1-manutencao-disco/`.

## 1. Antes da limpeza

| Verificação                            | Resultado                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambiente                               | ✔ operador `claude-operador@cenariogestao`, ambiente `homolog`                                                                                                                                     |
| Versão ativa                           | ✔ `9fb6b032c3c2…` (S1): etiqueta, pilha, candidata e migrada                                                                                                                                       |
| Disco                                  | 30 GB, **25 GB usados, 3,08 GiB livres (90%)**                                                                                                                                                      |
| Docker (`docker system df`)            | imagens: 19 (5 em uso), 21,49 GB; contêineres: 5 ativos; volumes locais: 5, 108 MB, todos em uso; cache de build: 0                                                                                 |
| Candidatas (`images_cleanup_plan`)     | 12 imagens api/web de 6 versões antigas: `696e3e9`, `341badb`, `63674f1`, `3e0d2d0`, `de31aa7` e `a7f4f93`. Cada uma ocupa ~4 GB nominais com camadas compartilhadas. Nenhuma é usada por contêiner |
| Protegidas                             | `9fb6b03` (ativa) e `0348dcf` (E1, retorno e ponto de recuperação). caddy, postgres:16 e postgres:16-alpine ficam fora da limpeza                                                                   |
| Necessárias para recuperação imediata? | Não. O retorno é para a `0348dcf`, que foi mantida. As 6 versões candidatas e a `0348dcf` estão no Artifact Registry (14/14 conferidas) e podem ser baixadas de novo com `prepare_version`          |

## 2. Execução

Operação nomeada `images_cleanup`: `docker image rm <etiqueta>` **sem `--force`**, só das
candidatas, de modo que o Docker recusaria uma imagem em uso. Não rodei `prune` e não toquei em
volumes, contêineres, backups ou dados.

**Removidas (12/12):** `api` e `web` de `696e3e9ddc5f…`, `341badb59624…`, `63674f1d116e…`,
`3e0d2d0f3eb8…`, `de31aa738f59…` e `a7f4f930e8ff…`.

## 3. Depois da limpeza

| Item                              | Resultado                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Disco                             | **12 GB usados, 16,08 GiB livres (43%)**: 13,01 GiB recuperados                                                                               |
| Docker                            | imagens: 7 (5 em uso), 7,5 GB; contêineres: 5 ativos; volumes: 5, 108 MB (inalterados)                                                        |
| S1 ativa                          | ✔ `9fb6b03` em etiqueta, pilha, candidata e migrada                                                                                          |
| `health`                          | ✔ 6/6                                                                                                                                        |
| `smoke_test`                      | ✔ **20/20, "Saúde: OK"**                                                                                                                     |
| `run_homologation_tests completo` | ✔ **29/29** (saúde, acesso e websocket)                                                                                                      |
| `websocket_test`                  | ✔                                                                                                                                            |
| Logs da API e da web              | 0 erros                                                                                                                                       |
| Dados                             | impressão digital idêntica à do fim do deploy da S1 (0 linhas diferentes)                                                                     |
| Portão de publicação              | fechado                                                                                                                                       |
| Retorno para a E1                 | ✔ disponível: imagens `api`/`web:0348dcf…` na VM (protegidas) e no registro. Ponto de recuperação `cenario-staging-20261115T034025Z` intacto |

O retorno continua sendo o da seção 8 de `docs/HOMOLOGACAO-S1-DEPLOY-RELATORIO.md`:
`gate_open` → `rollback_version version=0348dcfd8e5fdf9eccfb73e244cfa37af2520653` →
`gate_close` → `smoke_test`.

## 4. Confirmações

Produção intocada. Sem deploy, migration, merge ou alteração funcional. A S2 não foi iniciada. A
S1 continua aguardando a sua validação funcional.
