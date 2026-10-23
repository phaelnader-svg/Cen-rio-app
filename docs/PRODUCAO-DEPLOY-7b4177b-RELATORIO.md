# Deploy de produção — `7b4177b` (2026-10-23)

Autorização expressa do proprietário para publicar `7b4177b15a930b85d985a59a9182b579760c5a7b` com as
imagens que ele promoveu manualmente ao Artifact Registry `cenario-prod`. Procedimento usado: o fluxo
seguro existente (`operar.py` com `CENARIO_AMBIENTE=prod` → runner → `vm.sh`), sem SSH, sem SQL manual,
sem build.

## Resumo

| Item                    | Valor                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Operador                | `claude-operador-prod` (assinatura de JWT como `claude-operador` recusada: 403)          |
| VM                      | `cenario-prod` (runner 2.2.0, scripts `/opt/cenario` em `c32df97`)                       |
| SHA anterior            | `9fb1786beddae28c34b20a0922b42989ecb0fbf2`                                               |
| SHA publicado           | `7b4177b15a930b85d985a59a9182b579760c5a7b`                                               |
| API em execução         | `sha256:993230244c5a43a9b0bce3c6abf1bc874202da6396c222351252012d38083bd9` (= autorizado) |
| WEB em execução         | `sha256:0ca94f888ad973a0f728e697656dd2b7f987e892daa986c83fddcb62823ceca8` (= autorizado) |
| Migrations              | 31 → **33/33** (só as 2 oficiais)                                                        |
| Ponto de recuperação    | `cenario-production-20261023T011727Z` (01:17:42Z, versão `9fb1786`)                      |
| Janela de manutenção    | 01:17:21Z → 01:19:08Z (~2 min, proxy respondendo 503)                                    |
| Rollback                | não necessário                                                                           |
| Portão ao final         | **fechado**                                                                              |

## Sequência (horários UTC)

| Hora     | Operação                                     | Resultado                                                                       |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| 01:12:34 | `verificar` (`gate_status` + `version`)      | portão fechado; etiqueta, pilha, candidata e migrada = `9fb1786`                |
| 01:13    | `health`, `containers_status`, `resources`   | tudo saudável; memória 2,7 GB livre; disco 21%                                  |
| 01:13    | `database_status`, `migration_status`        | PostgreSQL 16.15, 15 MB, sem bloqueios; 31 aplicadas                            |
| 01:13    | `imagens 7b4177b` + API do Artifact Registry | as duas etiquetas existem, digests idênticos aos autorizados; etiquetas imutáveis |
| 01:14:10 | `database_fingerprint`, `database_counts`    | impressão de referência registrada                                              |
| 01:15:03 | `gate_open`                                  | portão aberto                                                                   |
| 01:15:09 | `prepare_version 7b4177b`                    | digests baixados = autorizados; imagem não migra na partida; 33 × 31; 34 GB livres |
| 01:16:4x | `migration_precheck 7b4177b`                 | PREFLIGHT OK: 2 pendentes, nada incompleto/desconhecido/divergente/fora de ordem |
| 01:17:21 | `maintenance_on`                             | API e web paradas                                                               |
| 01:17:27 | `recovery_point_create`                      | backup + SHA-256 + restauração de teste em banco separado IDÊNTICA + bucket     |
| 01:18    | `backup_validate`                            | SHA256SUMS conferido                                                            |
| 01:18    | `database_fingerprint`                       | idêntica à de 01:14 (nenhuma gravação no intervalo)                             |
| 01:18:34 | `migrate 7b4177b`                            | banco idêntico ao ponto; preflight OK; 2 migrations aplicadas em 9 s            |
| 01:18:4x | `migration_verify 7b4177b`                   | 33 × 33; nenhuma pendente, desconhecida ou com falha                            |
| 01:19:08 | `activate_version 7b4177b`                   | API saudável; `vm.sh saude`: OK                                                 |
| 01:19–20 | `smoke_test`, `websocket_test`, `run_homologation_tests completo`, `version`, `images_cleanup_plan` | tudo OK; contêineres nos digests autorizados |
| 01:21    | `container_logs` ×5, `application_logs` ×3   | sem erro (abaixo)                                                               |
| 01:21    | `database_fingerprint`, `database_counts`    | só as diferenças previstas (abaixo)                                             |
| 01:22    | `gate_close`, `gate_status`, `health`, `migration_verify` | portão fechado; API 200; 33/33                                     |

Ordem do portão: o pedido previa abrir o portão só depois do ponto de recuperação. No mecanismo oficial,
porém, `preparar-versao`, `manutencao` e `ponto-recuperacao` exigem o portão (`need_portao`), e o
`migration_precheck` precisa da imagem baixada por `prepare_version`. Segui a ordem oficial
(`docs/HOMOLOGACAO-AUTONOMIA-OPERACOES.md` §2). Antes de qualquer mudança no banco ou na versão ativa,
estavam cumpridos: pré-checagem, impressão digital, ponto de recuperação, backup validado, imagens e
digests conferidos, migrations conferidas. O próprio `migrar` recusa sem ponto recente e com impressão
igual ao banco.

## Pré-checagem

- Ambiente: produção (`cenario-prod`, projeto `cenariogestao`, perfil `prod` do runner).
- Identidade: `claude-operador-prod`. Assinar como `claude-operador` (homologação): 403.
- Versão ativa: `9fb1786`. 31 migrations. Contêineres saudáveis havia 3 dias.
- Disco: 21% (38 GB livres). Memória: 2,7 GB disponíveis. Swap praticamente sem uso.
- Repositório: `9fb1786` é ancestral de `7b4177b`. Entre os dois, só **dois arquivos de migration
  adicionados** e nenhum alterado:
  - `20270216000000_notificacoes_resolvidas`: `ALTER TABLE notifications ADD COLUMN resolved_at TIMESTAMPTZ(3)` (anulável, sem default, sem backfill);
  - `20270223000000_custo_operacional_equipe_propria`: recria a CHECK `logistics_costs_phase6` acrescentando `'OPERACIONAL'` (nenhuma linha alterada).
- Scripts da VM: entre `c32df97` (instalado) e `7b4177b` só mudaram `provisionar.sh` (Cloud Shell) e
  testes. `vm.sh`, Compose, Caddyfile e runner são iguais. Por isso não houve `vm_scripts_update`.
- Rollback disponível: `rollback_to_recovery_point` (ponto novo) e imagens de `9fb1786` protegidas na VM.

## Impressão digital antes × depois

Mecanismo: `vm.sh impressao-digital` (contagem e md5 de cada tabela, colunas, restrições, índices,
gatilhos, sequências, somas de todas as colunas `*_cents`, migrations). 4127 → 4128 itens.

Diferenças, todas previstas pelas migrations oficiais:

| Item                                   | Antes                   | Depois                         | Motivo                                                 |
| -------------------------------------- | ----------------------- | ------------------------------ | ------------------------------------------------------ |
| `_prisma_migrations`                   | 31 linhas               | 33 linhas                      | as 2 migrations                                        |
| `migracoes\|aplicadas`                 | 31                      | 33                             | idem                                                   |
| coluna `notifications.resolved_at`     | —                       | `timestamp(3) with time zone`, anulável | migration `notificacoes_resolvidas`           |
| md5 de `notifications`                 | 4 linhas                | 4 linhas, md5 novo             | o md5 é de `r::text` (linha inteira); a coluna nova NULL muda o texto |
| CHECK `logistics_costs_phase6`         | 4 situações             | + `'OPERACIONAL'`              | migration `custo_operacional_equipe_propria`           |

Sem mudança: todas as outras tabelas (contagem e md5), as 36 somas financeiras, restrições, índices,
gatilhos e sequências. Nenhuma perda, duplicação nem alteração financeira ou comercial. `database_counts`:
igual, exceto `_prisma_migrations` 31 → 33.

## Validação pós-deploy

- `health`, `smoke_test` (`vm.sh saude`), `run_homologation_tests completo` (saúde, acesso, websocket): OK.
  - Contêineres healthy; `/api/ready` 200; `APP_ENV=production`;
  - HTTP→HTTPS 308; www→canônico 301; `/entrar` 200; JavaScript da tela 200; HSTS; sem HTTP/3;
  - rotas gerenciais, financeiras, auditoria e funcionários com 401 sem sessão;
  - WebSocket `/api/realtime` 401 sem sessão;
  - certificado válido até 17/01/2027; último backup 0 h; 33 migrations; disco 29%; memória 2,8 GB.
- Web: Next.js 15.5.28 "Ready in 1759ms".
- Logs (20 min): API sem nível ≥ 40 e sem erro do Prisma; Caddy sem 5xx, sem 404 e sem `error`;
  PostgreSQL só checkpoints; runner sem falhas; docker só eventos `info` (pull com os digests autorizados).

### O que NÃO foi provado nesta sessão

- **Login com credencial, `/tablet` e `/painel` com sessão**: o ambiente desta sessão bloqueia o
  domínio de produção (proxy 403). Não tenho, nem devo usar, credenciais de usuário. As checagens de
  página vieram da VM: `/entrar` + JS 200 e rotas protegidas 401.
- **Tráfego autenticado na versão nova**: até o fechamento, nenhuma requisição autenticada chegou a
  `7b4177b`. As requisições reais vistas nos logs (01:02Z) e o WebSocket `101` (fechado às 01:17:20Z pela
  manutenção) eram da versão anterior.
- **Tablets físicos**: a homologação não prova a produção.

## Riscos residuais

1. Login, `/tablet`, `/painel` e WebSocket autenticado em produção ainda não foram exercitados com
   usuário real. A exceção de cliente no `/tablet` da versão antiga só está descartada em produção depois
   do teste físico.
2. Sessões abertas antes da janela foram desconectadas (manutenção de ~2 min). Clientes reconectam.
3. Um `rollback_to_recovery_point` a partir de agora perderia o que for gravado depois de 01:17:42Z.
   `rollback_version 9fb1786` seria recusado: o banco agora tem 2 migrations que `9fb1786` não conhece,
   e o runner exige `rollback_to_recovery_point` nesse caso. Na prática, o caminho de volta é o ponto de
   recuperação.
4. As imagens de `9fb1786` continuam na VM (protegidas como versão do ponto). Não rodei `images_cleanup`.

## Confirmações

- F10-19 não foi alterado; nenhuma funcionalidade nova; nenhuma regra de negócio; nenhuma migration
  histórica; nenhum SQL manual; nenhuma credencial de homologação.
- Nenhuma imagem foi reconstruída: as imagens em execução são as promovidas, com os digests autorizados.
- Produção está em `7b4177b15a930b85d985a59a9182b579760c5a7b`, portão fechado, ponto
  `cenario-production-20261023T011727Z` e backups preservados (VM e `gs://cenariogestao-prod-backups`).

## Pedido ao proprietário

Teste os **tablets físicos em produção** (`/tablet`), além de entrar pelo `/entrar` e abrir o `/painel`
com um gestor. Confira também se as notificações em tempo real chegam. Informe o resultado antes de
qualquer nova rodada.
