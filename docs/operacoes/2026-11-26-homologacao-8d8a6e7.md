# 26/11/2026 — Homologação de `8d8a6e7` (voz da Conversar pelo servidor + telefone obrigatório)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhum dado alterado; nenhum login criado.

- Commit: `8d8a6e76ee4b57d1078b46e110752c2021897510` (branch `claude/project-thread-5acf26`, que aponta para esse mesmo hash; `git cat-file -t` = `commit`; contém `b125f47` e `7078fd7`). De `b125f47` para cá, 46 arquivos. Em `infra/`, exatamente os 5 esperados (os dois Compose, os dois `vm.sh` e `infra/voz/ligar-voz.sh`); `packages/db` sem mudança.
- Versão antes: `b125f47469ee325906e72ebb3ed80e6381df31e8` · depois: `8d8a6e76ee4b57d1078b46e110752c2021897510` (etiqueta, pilha, candidata e migrada). Scripts da VM: `b125f47469ee` → `8d8a6e76ee4b`.
- Build `78ec3793-3d20-4bdc-bce6-0ca860b71ed3`: SUCCESS (16:53:22 → 16:59:16 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:cf39466ebe7a6264012125063fc840b393a611de0b689f0ce1de5deac202aad2`
  - web `sha256:226260d2aa6f4af041e033ed133078a55475aa810ecc9fb299599832eb54c7c5`
- Migrations: nenhuma nova (64 na imagem e 64 no banco).
- Ponto de recuperação: `cenario-staging-20261126T170150Z` (versão `b125f47`, 64 migrations, impressão `ec0c3893a3a0e0820998cfc1d00b98ce`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate folder=…`: SHA256SUMS conferido, em comando separado.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16:52       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `b125f47` (64 migrations); saudável; portão fechado; disco 53% (**14 GB livres**). Acima de 10 GB: limpeza de imagens não necessária e não rodada                                                                                                                                      |
| 16:53–16:59 | imagens (ausentes) → build-iniciar / build-acompanhar                  | SUCCESS                                                                                                                                                                                                                                                                                                |
| 16:59:23    | gate_open                                                              | aberto                                                                                                                                                                                                                                                                                                 |
| 16:59:26    | prepare_version                                                        | OK; digests acima; imagem: 64 migrations, banco: 64; disco livre 11 GB depois de baixar                                                                                                                                                                                                                |
| 17:01:23    | migration_precheck                                                     | 0 pendentes (esperado)                                                                                                                                                                                                                                                                                 |
| 17:01       | database_counts e database_fingerprint (antes)                         | registradas (186 tabelas)                                                                                                                                                                                                                                                                              |
| 17:01:43    | maintenance_on                                                         | API e web paradas (17:01:46)                                                                                                                                                                                                                                                                           |
| 17:01:47    | recovery_point_create                                                  | `cenario-staging-20261126T170150Z`; restauração de teste IDÊNTICA; enviado ao bucket                                                                                                                                                                                                                   |
| 17:03:15    | backup_validate `folder=cenario-staging-20261126T170150Z`              | SHA256SUMS conferido                                                                                                                                                                                                                                                                                   |
| 17:03:24    | migrate                                                                | 0 aplicadas ("up to date"). Não estava na lista do pedido, mas o `activate_version` exige o `migrate` da mesma versão                                                                                                                                                                                  |
| 17:04:08    | migration_verify                                                       | 64/64, nenhuma pendente                                                                                                                                                                                                                                                                                |
| 17:04:15    | activate_version                                                       | Saúde OK (disco 62%, memória 1021 MB); API e web de pé                                                                                                                                                                                                                                                 |
| 17:05:43    | gate_close                                                             | fechado                                                                                                                                                                                                                                                                                                |
| 17:05:47    | vm_scripts_diff `8d8a6e76ee4b`                                         | pacote íntegro (52 arquivos). `vm.sh`: só a leitura de `homolog-speech-api-key` no `gerar-env`, a função `atualizar_voz` e a chamada dela no `aplicar_config`. Compose: só `SPEECH_API_KEY: ${SPEECH_API_KEY:-}`. Caddy 0, auxiliares 0, só na VM 0                                                    |
| 17:05:56    | vm_scripts_update                                                      | 2 arquivos; Caddyfile validado; cópia anterior em `/opt/cenario.anterior-20261126T170559Z-d1f2c690`                                                                                                                                                                                                    |
| 17:06:02    | gate_open                                                              | aberto                                                                                                                                                                                                                                                                                                 |
| 17:06:05    | apply_stack_config                                                     | caddy e api recriados; Saúde OK. **"Chave da IA: ligada."**, **"Chave do e-mail: ligada."**, **"Voz da Conversar: ligada."** e **"WhatsApp (Meta): configuração incompleta; botão Conectar WhatsApp espera."** Nenhum valor aparece na saída                                                           |
| 17:07:32    | gate_close                                                             | fechado                                                                                                                                                                                                                                                                                                |
| 17:08       | version, smoke_test, websocket_test, run_homologation_tests `completo` | `/opt/cenario` = `8d8a6e76ee4b`; todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; disco 62% (11 GB livres)                                                                                                                                                           |
| 17:38:37    | database_counts, database_fingerprint, container_logs api/web, health  | depois de **31 min** com a API no ar (desde 17:07:06), um ciclo completo do aviso de vencimento: api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`**, nenhum `"Falha ao`, nenhum erro de `sendDueNotices`, nenhuma chave nos logs; só 2 rejeições 401 sem sessão (suítes de acesso) |

Indisponibilidade: cerca de 3 min 20 s na troca de versão (17:01:46 → ~17:05:05) e alguns segundos na
recriação da API pelo `apply_stack_config` (até 17:07:06).

## Contagens e impressão digital antes/depois

186 tabelas antes e depois, 64/64 migrations, estrutura igual. **Nenhuma contagem caiu e nenhuma
tabela mudou de conteúdo.** A única diferença é `status_samples` (2617 → 2625) e a sua sequência.

## Testes do repositório (commit exato, banco descartável)

Worktree de `8d8a6e7`, `pnpm install --frozen-lockfile`, Postgres 16 local com bancos e papel
descartáveis (apagados no fim). As suítes da api rodaram uma de cada vez.

| Suíte                                                                                 | Resultado                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| api: `escritorio-voz` + `escritorio-conversa`                                         | **2 arquivos, 8/8**                                                                                        |
| api: `criar-conta` + `melhorias-onda1` + `painel-plataforma`                          | **3 arquivos, 31/31**                                                                                      |
| api: suíte inteira (`vitest run`, 125 arquivos)                                       | 116 passaram, 7 pulados, **2 falharam** (1017 testes passaram + 3 falhas esperadas + 14 pulados; 2 falhas) |
| web (`vitest run`)                                                                    | 10 arquivos, **91 passaram + 3 falhas esperadas** (94; o pedido citava 90)                                 |
| shared (`vitest run`)                                                                 | 22 arquivos, **134/134**                                                                                   |
| `infra/homolog/gcp/testes/test_vm_sh.sh` e `infra/prod/gcp/testes/test_vm_sh_prod.sh` | todos os cenários OK                                                                                       |

As 2 falhas da suíte inteira da api:

1. **Antiga conhecida, não é desta versão:** `escritorio-financeiro.test.ts` > "pagamento só vira pago pela conciliação; reimportar o extrato não duplica".
2. **NOVA, desta versão:** `fase0-privacidade-estado.test.ts` > "Privacidade do cliente nos tablets (varredura de todas as rotas de tablet) > produção: nenhum dado pessoal nem valor em nenhuma rota…".
   - Mensagem: `Ricardo /api/auth/signup-config trouxe valores: expected '{"captchaSiteKey":null,…' not to match /"[a-zA-Z]*Cents"/`.
   - Causa: o teste percorre todas as rotas que um tablet de produção alcança e exige que nenhuma devolva campos `…Cents`. A rota pública `GET /api/auth/signup-config` passou a devolver `pricing.plans[].monthlyCents` (os preços de venda dos planos: 39900 e 59900).
   - É determinística: na `b125f47`, a suíte inteira passou nesse teste (só a falha antiga apareceu).
   - Não é vazamento de dado de cliente nem de valor da oficina: são os preços públicos do produto, que já aparecem na página de vendas. Mas o teste reprova e o pedido dizia que tudo precisa passar.
   - **Não alterei código nesta sessão.** A correção é do desenvolvimento: tirar `/api/auth/signup-config` (rota pública, igual para todos) da varredura de valores do teste, ou mudar o nome do campo (por exemplo, `monthlyPrice` em reais) e ajustar as telas de Entrar e Criar conta. Sugiro a primeira.

## Rotas

A homologação continua inalcançável desta sessão: o proxy de saída não abre
`teste.cenariogestao.com.br` (resposta 000) e não há a senha do proxy. O catálogo também não chama
rotas da API. Por isso as rotas foram conferidas **localmente, no commit exato**: banco descartável
recém-criado só com as 64 migrations, API com `tsx` e web com `NODE_ENV=production SITE_COMERCIAL=1 next build && next start`.

- `GET /api/v1/office/voice` sem sessão: **401**. `POST /api/v1/office/voice` sem sessão: 401.
- `POST /api/auth/signup` só com e-mail e senha: **400** `VALIDATION_ERROR` ("Nome da empresa é obrigatório."). Nenhuma conta criada: `company_settings` ficou com 2 linhas e `users` com 0.
- `GET /api/v1/platform/companies` sem sessão do painel: **401**.
- `GET /api/auth/signup-config`: 200 com `pricing.trialDays = 7`, `annualDiscountPct = 15` e `pricing.plans` com **2 planos**: `gestao` 39900 e `gestao_jogo` 59900, iguais aos padrões de `platform_settings` no banco local.
- `/conheca`: 200, com "Criar minha conta" (6 vezes) e "Agendar demonstração" (4 vezes). `/`, `/entrar`, `/dono` e `/plataforma/entrar`: 200.

**Não verificado:** as mesmas rotas na própria homologação. Em particular, não comparei os preços do
`signup-config` com os valores que o dono possa ter salvo em "Planos e preços" na homologação. A
impressão digital não mostra os valores das colunas, mas mostra que `platform_settings` não mudou de
conteúdo nesta homologação.

## Disco

Antes: 14 GB livres (53%). Depois: **11 GB livres (62%)**. Ficam protegidas as imagens de `8d8a6e7`
(ativa) e `b125f47` (ponto de recuperação).

Retorno, se necessário:

- Dos scripts: `vm_scripts_restore` e depois `apply_stack_config`.
- Da versão: `rollback_to_recovery_point`, que volta para `b125f47` com 64 migrations.
