# 17/11/2026 — Produção: deploy de `bafae04` (correção do "Identificador inválido." na base de Orçamentos)

- **Pedido e aprovação:** dono, 17/11/2026: "quando eu vou mudar os preços na base de dados do
  orçamento, fica como identificador inválido". A aprovação de produção veio dele, ao colar o texto do
  deploy. Versão `bafae04558b7008b6f55ef679311a66706b87054` (branch `claude/project-thread-r6mrbg`, PR
  #14).
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **O que entrou:** só código. A validação de ids passa de `z.string().uuid()` (estrita no zod 4) para
  `z.guid()`. Os itens que vieram prontos na base de Orçamentos têm id `md5(...)::uuid` e eram recusados.
  - Diff conferido contra `d6d3030`: 29 arquivos de código e teste; nada em `infra/` nem em
    `packages/db`.
  - Fora dos testes, as linhas alteradas são a troca de `uuid` por `guid` e a reformatação das mesmas
    chamadas.
- **Homologação:** `docs/operacoes/2026-11-17-homologacao-bafae04.md` (branch
  `claude/operacoes-homologacao-bafae04`, commit `0c0d140`); build `bca30320-2abb-4761-be41-cc026b560eff`;
  `apps/api/test/orcamentos.test.ts` 6/6 no commit exato.
- **Imagens:** o gatilho de promoção não existe (`cenario-prod-promocao` → 404, nada publicado). O dono
  promoveu no Cloud Shell: `crane copy -j 1` por digest (api 16:21–16:30, web 16:30), depois
  `promover-imagens.sh` para conferir ("já promovida"). Em `cenario-prod` (API do Artifact Registry e
  `prepare_version` na VM): api `sha256:80dd16eefac7e3e31f4802bd8ff081caae058b69057f49a079ebe2aa67238df4`,
  web `sha256:aa63113b030c73b056c189b964164cbaf7e02c2683ebc35774bf113f8d7de9c1` (iguais às homologadas).
- **Versão:** `d6d30306de266f6583353fe7b86bc5eaf8fb7854` → `bafae04558b7008b6f55ef679311a66706b87054`
  (etiqueta, pilha, candidata e migrada).
- **Scripts da VM:** sem mudança (`d6d30306de26`). Como pedido, não rodei `vm_scripts_diff`,
  `vm_scripts_update` nem `apply_stack_config`.
- **Banco:** 49/49, **0 pendentes**. O `migrate` rodou só para registrar a versão: "up to date", nada
  aplicado.
- **Ponto de recuperação:** `cenario-production-20261117T163922Z` (versão `d6d3030`, impressão
  `96e77f7b5a2ff9fd49c45d03149976a4`): restauração de teste IDÊNTICA, no bucket, SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                         | Resultado                                                              |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 16:16       | verificar, version, health, gate_status, disk_status                             | canal OK; ativa `d6d3030`; saudável; portão fechado; disco 67%         |
| 16:16       | migration_status, imagens                                                        | 49 aplicadas; imagens ausentes em `cenario-prod`                       |
| 16:17       | promover (gatilho)                                                               | tópico inexistente (404): parado, nada alterado                        |
| 16:21–16:30 | promoção pelo dono no Cloud Shell                                                | concluída; digests conferidos                                          |
| 16:36:47    | gate_open                                                                        | aberto                                                                 |
| 16:36:54    | prepare_version                                                                  | digests homologados na VM; não migra na partida; 49 × 49; 14 GB livres |
| 16:38:34    | migration_precheck                                                               | 0 pendentes; PREFLIGHT OK                                              |
| 16:38:53    | database_fingerprint, database_counts (antes)                                    | 6300 itens                                                             |
| 16:39:07    | maintenance_on                                                                   | API e web paradas (16:39:12)                                           |
| 16:39:17    | recovery_point_create                                                            | `cenario-production-20261117T163922Z`, IDÊNTICA, no bucket             |
| 16:39:46    | backup_validate                                                                  | SHA256SUMS conferido                                                   |
| 16:39:50    | database_fingerprint (referência, em manutenção)                                 | idêntica à de 16:38:53                                                 |
| 16:40:07    | migrate                                                                          | banco idêntico ao ponto; 0 pendentes; "up to date"                     |
| 16:40:28    | migration_verify                                                                 | 49/49                                                                  |
| 16:40:32    | activate_version                                                                 | contêineres saudáveis; Saúde OK (disco 72%, memória 2765 MB)           |
| 16:40:52    | maintenance_off                                                                  | Saúde OK                                                               |
| 16:41:02    | gate_close                                                                       | fechado                                                                |
| 16:41+      | version, smoke_test, websocket_test, testes acesso, contagens, fingerprint, logs | todos OK (abaixo)                                                      |

- **Indisponibilidade:** ≈1 min 30 s (16:39:12 → ~16:40:45; web "Ready" às 16:40:38).
- **Contêineres:** api e web nos digests homologados (`images_cleanup_plan`); `d6d3030` protegida como
  versão do ponto de recuperação.
- **Testes:** `smoke_test` Saúde OK; `websocket_test` 401 sem sessão (esperado); `run_homologation_tests
suite=acesso` Acesso OK.
- **Logs (10 min):**
  - api sem nível ≥ 40 e sem erro do Prisma; web sem erros; PostgreSQL sem ERROR/FATAL;
  - **0 `permission denied`** e 0 erros de row-level security;
  - Caddy: 17 respostas **503**, todas em `GET /api/realtime`, entre 16:39:12 e 16:40:43. Eram navegadores
    abertos tentando reconectar o WebSocket durante a manutenção; a última foi enquanto a API subia logo
    depois da ativação;
  - **depois disso, 0 respostas 5xx.**
- **Contagens (exatas, pela impressão digital), referência em manutenção × depois:**
  - **nenhuma contagem caiu**;
  - só `status_samples` cresceu (15 → 16; uma amostra a cada 5 minutos).
- **Impressão digital:**
  - estrutura (colunas, restrições, índices) e somas financeiras: idênticas;
  - md5 mudou só em `status_samples` (+1 amostra) e `sessions` (mesma contagem: atualização de uma sessão
    em uso depois da ativação).
- **Conferido de fora:**
  - `/`, `/entrar`, `/status`, `/painel/orcamentos`, `/api/ready` e `/api/public/status` → 200;
  - `GET /api/v1/quotes/catalog` sem login → 401.
  - Nenhum preço ou item da base alterado, nenhuma conta de teste criada, dados "[Exemplo]" intactos.
- **Não verificado por mim:** o login do dono, Orçamentos > Base de dados e a alteração de preço que
  falhava. Ficam para o teste do dono.
- **Disco (só leitura, nada removido):**
  - 72% usado, 13,26 GiB livres; o `prepare_version` exige 10 GB;
  - o `images_cleanup_plan` lista 18 imagens de versões antigas que podem sair da VM (continuam no
    Artifact Registry): `9fb1786`, `7b4177b`, `696e3e9`, `0a2546f`, `180d120`, `e43bc99`, `64c238f`,
    `aa1554b` e `6d8e445` (api e web);
  - `bafae04` (ativa) e `d6d3030` (ponto de recuperação) ficam protegidas;
  - recomendo rodar `images_cleanup` no próximo deploy, antes do `prepare_version`.
- **Retorno, se necessário:** `rollback_to_recovery_point` (volta para `d6d3030`; perde o gravado depois
  de 16:39:41). Como não houve migration, `rollback_version d6d30306de266f6583353fe7b86bc5eaf8fb7854`
  também é seguro e não mexe nos dados.
