# 17/11/2026 — Homologação de `aa1554b` (multi-empresa com `infra/` e landing de `64c238f`)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhuma conta foi criada pelo "Criar conta" (teste do dono).

- Commit: `aa1554b3f1e240a2f92a03b500fc98e9762bb949` (branch `claude/project-thread-x4iibr`; `FETCH_HEAD` conferido, a branch não tinha avançado). Corrige o que o relatório de `aa7ba96` apontou (`docs/operacoes/2026-11-17-homologacao-aa7ba96-multi-empresa.md`, branch `claude/operacoes-homologacao-aa7ba96`).
- Diferença de `aa7ba96`: 18 arquivos devolvidos ao estado de `64c238f`:
  - `infra/` (`vm.sh`, `startup.sh`, `Caddyfile.prod`, `docker-compose.prod.yml` e os testes do banco limpo);
  - a landing da raiz (`apps/web/app/page.tsx`, `apps/web/app/(site)/layout.tsx`, `apps/web/components/site/`);
  - `apps/web/test/site.test.ts`, `apps/api/test/proxy-caddy-prod.test.ts` e um relatório antigo;
  - uma quebra de linha em `apps/api/src/core/storage/image.ts`.

  Conferido: `git diff --stat 64c238f aa1554b -- infra` sai **vazio**. Nada mudou em `packages/db`.

- Versão antes: `aa7ba96a264ad85eeb77fb26f03d7ec72d1dd4a1` · depois: `aa1554b3f1e240a2f92a03b500fc98e9762bb949` (etiqueta, pilha e migrada).
- Build `c01c2cca-c0fa-482f-87aa-c0537f4de962`: SUCCESS (02:34:24 → 02:39:45 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:f09020abf649efe387bc492bbd64f830ed905f2bb6fa34b5b3dcfe42ddc648bd`
  - web `sha256:212a044577d019fd7b23e129b2b1a421e1ba9a9e10b35ab0b0770e2bb9a7ec1e`
- Migrations: nenhuma nova (47 na imagem e 47 no banco).
- Ponto de recuperação: `cenario-staging-20261117T024222Z` (versão `aa7ba96`, impressão `1fbc15dcd1fd9d778272d3aa6203ee5a`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC)  | Operação                                                                                           | Resultado                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 02:33       | verificar, version, health, gate_status, disk_status                                               | canal OK; ativa `aa7ba96`; saudável; portão fechado; disco 59% (12 GB livres)                                                                                                                                    |
| 02:34–02:39 | imagens (ausentes) → build-iniciar / build-acompanhar                                              | SUCCESS                                                                                                                                                                                                          |
| 02:40:03    | gate_open                                                                                          | aberto                                                                                                                                                                                                           |
| 02:40:06    | prepare_version                                                                                    | OK; digests acima; imagem: 47 migrations, banco: 47; disco livre 10 GB                                                                                                                                           |
| 02:41:54    | migration_precheck                                                                                 | 0 pendentes; 47 na imagem, 47 no banco                                                                                                                                                                           |
| 02:42       | database_fingerprint (antes)                                                                       | registrada                                                                                                                                                                                                       |
| 02:42:13    | maintenance_on                                                                                     | API e web paradas (02:42:16)                                                                                                                                                                                     |
| 02:42:19    | recovery_point_create                                                                              | `cenario-staging-20261117T024222Z`                                                                                                                                                                               |
| 02:43:14    | backup_validate                                                                                    | SHA256SUMS conferido                                                                                                                                                                                             |
| 02:43:18    | migrate                                                                                            | 0 aplicadas ("up to date"). Rodado porque o `activate_version` exige o `migrate` da mesma versão                                                                                                                 |
| 02:44:12    | migration_verify                                                                                   | 47/47, nenhuma pendente                                                                                                                                                                                          |
| 02:44:18    | activate_version                                                                                   | Saúde OK (disco 67%, memória 1057 MB)                                                                                                                                                                            |
| 02:45:23    | gate_close                                                                                         | fechado                                                                                                                                                                                                          |
| 02:45+      | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros; **nenhum `permission denied`**; API partiu normalmente ("API Cenário Gestão pronta") |

Impressão digital antes/depois: **idêntica**. Nenhuma tabela, coluna, restrição ou valor mudou.

Indisponibilidade: cerca de 3 min 5 s (02:42:16 → ~02:45:21).

Não verificado por mim: a landing da raiz, "Criar conta" e o painel "Empresas" com login, que ficam
para o teste do dono.

Retorno, se necessário: `rollback_to_recovery_point` (volta para `aa7ba96`). Como não houve migration,
voltar só a versão também é seguro.
