# 27/11/2026 — Homologação de `df7a104` (painel etapa 2 e etapa 3: chuva, empresa parada, avaliação, padrão da casa)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada. Nenhum dado alterado; nenhum login criado.

- Commit: `df7a10449c47c9c01857925d28a626beacdeb6b6` (branch `claude/project-thread-cet22y`, que aponta para esse mesmo hash; `git cat-file -t` = `commit`; contém `cb54d23`). De `cb54d23` para cá, 110 arquivos. Em `packages/db` e `infra`, exatamente os 6 esperados: as 2 migrations, `schema.prisma`, `src/tenancy.ts` e as 2 reversões. Nada em `infra/`.
- Versão antes: `cb54d23746df8248330e309f2f4ab6cb668a2b15` · depois: `df7a10449c47c9c01857925d28a626beacdeb6b6` (etiqueta, pilha, candidata e migrada). Scripts da VM inalterados (`8d8a6e76ee4b`).
- Build `6a81270f-7c74-4517-be64-76b05809bf5f`: SUCCESS (03:16:24 → 03:22:34 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:ec1a27ee730fe219c05f62e2347b212cf581149c8e14cd6dac864734f94508db`
  - web `sha256:9bc2023ffd0ff30a6f25fd9facaf90f2e159d706e44720253f4351971132ba44`
- Migrations: 2 novas, aplicadas em **30 s** (66 → 68). SQL lido antes: só acrescentam, sem `UPDATE` nem `DELETE`.
  - `20270913000000_painel_etapa2`: colunas novas em `company_settings` (10), `contact_requests` (2) e `platform_settings` (`message_templates` com padrão `{}` e `pix_city`); tabelas `payment_proofs` e `screen_views` (empresa: RLS ligada e forçada, política `empresa`) e `platform_push_subscriptions` (sistema, da plataforma, sem RLS por empresa, como as demais `platform_*`); GRANT ao `cenario_app` nas 3.
  - `20270914000000_etapa3`: colunas novas em `company_settings` (aviso de chuva, local do tempo, `idle_notice_at`), `deliveries` (nota do cliente) e `quote_settings` (`care_texts` com padrão `{}`, `min_profit_bps`); tabela `house_standards` (RLS ligada e forçada, política `empresa`, GRANT).
- Ponto de recuperação: `cenario-staging-20261127T032557Z` (versão `cb54d23`, 66 migrations, impressão `72ab9c57a43fba3e51c93959447fdd09`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate folder=…`: SHA256SUMS conferido, em comando separado, antes do `migrate`.

| Hora (UTC)  | Operação                                                               | Resultado                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 03:15       | verificar, version, health, gate_status, disk_status                   | canal OK; ativa `cb54d23` (66 migrations); saudável; portão fechado; disco 62% (**11 GB livres**). Acima de 10 GB: limpeza não rodada                                                                                                                                                   |
| 03:16–03:22 | imagens (ausentes) → build-iniciar / build-acompanhar                  | SUCCESS                                                                                                                                                                                                                                                                                 |
| 03:22:54    | gate_open                                                              | aberto                                                                                                                                                                                                                                                                                  |
| 03:22:58    | prepare_version                                                        | OK; digests acima; imagem: 68 migrations, banco: 66; disco livre 9 GB depois de baixar                                                                                                                                                                                                  |
| 03:25:25    | migration_precheck                                                     | exatamente as 2 pendentes esperadas (19 e 10 comandos); esquema compatível                                                                                                                                                                                                              |
| 03:25       | database_counts e database_fingerprint (antes)                         | registradas (189 tabelas)                                                                                                                                                                                                                                                               |
| 03:25:47    | maintenance_on                                                         | API e web paradas (03:25:51)                                                                                                                                                                                                                                                            |
| 03:25:54    | recovery_point_create                                                  | `cenario-staging-20261127T032557Z`; restauração de teste IDÊNTICA; enviado ao bucket                                                                                                                                                                                                    |
| 03:27:02    | backup_validate `folder=cenario-staging-20261127T032557Z`              | SHA256SUMS conferido                                                                                                                                                                                                                                                                    |
| 03:27:11    | migrate                                                                | 2 aplicadas em 30 s                                                                                                                                                                                                                                                                     |
| 03:27:54    | migration_verify                                                       | 68/68, nenhuma pendente                                                                                                                                                                                                                                                                 |
| 03:27:58    | activate_version                                                       | Saúde OK (disco 71%, memória 1017 MB); API e web de pé                                                                                                                                                                                                                                  |
| 03:29:14    | gate_close                                                             | fechado                                                                                                                                                                                                                                                                                 |
| 03:30       | version, smoke_test, websocket_test, run_homologation_tests `completo` | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; disco 71% (8,3 GB livres)                                                                                                                                                                            |
| 03:59:07    | database_counts, database_fingerprint, container_logs api/web, health  | depois de **30 min 20 s** com a API no ar (desde 03:28:47): api e web com 0 respostas 5xx, 0 erros, **nenhum `permission denied`**, nenhum `"Falha ao`/`"Falha no`, nenhum erro de `sendDueNotices`, `sendIdleNotices` ou `rainRound`; só 2 rejeições 401 sem sessão (suítes de acesso) |

Indisponibilidade: cerca de 2 min 56 s (03:25:51 → 03:28:47).

## Contagens e impressão digital antes/depois

189 → **193 tabelas**, 66 → 68 migrations. **Nenhuma contagem caiu.** Diferenças:

- Novas e vazias: `payment_proofs`, `screen_views`, `platform_push_subscriptions` e `house_standards` (0 linhas cada).
- 55 colunas novas no total (as 4 tabelas novas e as colunas acrescentadas às existentes).
- `company_settings` (2 linhas), `platform_settings` (1), `quote_settings` (1): mesmas contagens; o hash mudou porque as colunas novas com padrão (`fee_emails`, `message_templates`, `care_texts`) passaram a ter valor nas linhas existentes.
- `status_samples` (2741 → 2748) e a sua sequência, como sempre.
- `sessions`, `notifications`, `outbound_emails`, `deliveries` e as demais: iguais.

## Previsão do tempo e aviso de empresa parada

- **Previsão do tempo: não foi exercitada neste ciclo.** O `rainRound` só consulta depois das 16h (horário de São Paulo) e só para empresas com entrega ou retirada no dia seguinte. A janela de 30 min foi de 00:28 a 00:59 em São Paulo, então nenhuma consulta a `api.open-meteo.com` ou `geocoding-api.open-meteo.com` foi feita, e não houve erro. O catálogo de operações também não tem como testar a saída da VM para esses endereços. Fica para a primeira tarde (ver nos logs a partir das 16h, se houver entrega ou retirada marcada para o dia seguinte).
- **Avisos de empresa parada: 0 chegaram a algum aparelho.** `platform_push_subscriptions` está vazia (ninguém ativou as notificações do painel na homologação), então não há para quem enviar. Não dá para dizer se o `idle_notice_at` foi marcado numa empresa: o hash de `company_settings` mudou por causa das colunas novas, e a impressão digital não mostra valores. Nenhum erro de `sendIdleNotices` nos logs.

## Testes do repositório (commit exato, banco descartável)

Worktree de `df7a104`, `pnpm install --frozen-lockfile`, Postgres 16 local com banco e papel
descartáveis (apagados no fim). As suítes da api rodaram uma de cada vez.

| Suíte                                                                                                                                            | Resultado                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| api: `etapa3`, `termometro`, `ligacoes-a`, `ligacoes-b`, `ligacoes-c`, `rodada4-travas-estruturais`, `multi-empresa-banco`, `multi-empresa-mapa` | **8 arquivos, 81/81**                                                                                                      |
| api: suíte inteira (132 arquivos)                                                                                                                | **124 passaram**, 7 pulados, **1 falhou** (a antiga conhecida); **1089 testes passaram** + 3 falhas esperadas + 14 pulados |
| web (`vitest run`)                                                                                                                               | 10 arquivos, **91 passaram + 3 falhas esperadas** (94)                                                                     |
| shared (`vitest run`)                                                                                                                            | 22 arquivos, **134/134**                                                                                                   |

A única falha é a antiga conhecida, que não é desta versão: `escritorio-financeiro.test.ts` >
"pagamento só vira pago pela conciliação; reimportar o extrato não duplica". O pedido citava 1.051
testes passando; aqui foram 1.089.

A homologação continua inalcançável desta sessão (o proxy de saída não abre
`teste.cenariogestao.com.br`), então as rotas novas (`/api/public/avaliar/:id` e o 206 do
`/api/files` para vídeo) não foram chamadas no ar; ficam cobertas pelos testes acima.

## Disco

Antes: 11 GB livres (62%). Depois: **8,3 GB livres (71%)**. A próxima homologação vai precisar de
`images_cleanup` antes do `prepare_version`. Ficam protegidas as imagens de `df7a104` (ativa) e
`cb54d23` (ponto de recuperação).

Retorno, se necessário: `rollback_to_recovery_point`, que volta para `cb54d23` com 66 migrations.
