# Homologação — autonomia operacional por operações nomeadas

Status: **preparado no repositório, ainda NÃO aplicado no Google Cloud.** O bootstrap abaixo é o único
passo manual. Escopo: **somente a homologação** do projeto `cenariogestao`; produção fica fora.

## 1. Arquitetura

```
 sessão do Claude Code (container)                         Google Cloud — projeto cenariogestao
 ───────────────────────────────────                       ─────────────────────────────────────
 operar.py ──signJwt (como claude-operador)──▶ IAM Credentials
     │      (o proxy da sessão injeta o token: Network Secret com a chave; a chave nunca entra no container)
     ├──publish {v:2, jwt}──────────────────▶ Pub/Sub cenario-homolog-comandos
     │                                               │ (assinatura cenario-homolog-comandos-vm: confirmação 60 s, retenção 10 min)
     │                                               ▼
     │                                        VM cenario-homolog · cenario-runner (systemd, root)
     │                                          valida o envelope inteiro → operação da tabela → vm.sh / docker compose
     │                                          (listas de argumentos, sem shell) → máscara de segredos
     │                                               │ só cria objetos (ifGenerationMatch=0)
     └──lê resultado/stdout/stderr◀────────── gs://cenariogestao-homolog-operacoes  (auditoria, 90 dias)
     ├── Compute API: estado/reset/start/stop SÓ da VM (papel cenarioOperadorVm na instância)
     └── Cloud Build (conta cenario-build) → Artifact Registry cenario-homolog (imagens por SHA)
```

**Fronteiras de confiança:**

- **Código que roda como root na VM** é só o runner e o `vm.sh`. Os dois vêm de publicação HUMANA:
  - o runner, de `gs://cenariogestao-homolog-runner-versoes`, que o operador não pode gravar, com SHA-256 conferido;
  - o `vm.sh`, do `preparar-vm`/`atualizar-config` feito por você.
- **Nenhuma operação altera arquivos do host** além de quatro coisas: o portão, a etiqueta local de versão, o
  estado do próprio runner e o que os scripts auditados (`vm.sh`) já fazem.
- **Código da aplicação** (imagens que o operador pode construir) roda **só dentro dos contêineres**. O Compose,
  que é humano, não usa `privileged` nem `docker.sock`.
- **A versão ativa** fica numa configuração local do systemd (`cenario-homolog.service.d/10-etiqueta.conf`,
  `CENARIO_TAG`, que o `vm.sh` prioriza sobre o metadado). Por isso o operador **não** recebe
  `compute.instances.setMetadata`, que permitiria um _startup-script_, ou seja, execução arbitrária como root.

## 2. Operações do runner

Classe READ_ONLY: até 2 em paralelo. MUTATING e DESTRUCTIVE: sempre sozinhas, em fila FIFO; nunca rodam junto
com outra operação. Timeout em segundos: mínimo/padrão/máximo. `*` = obrigatório. Nenhum parâmetro aceita
texto livre, caminho, comando, SQL ou script.

| Operação                     | Classe      | Timeout     | Parâmetros                                                                                                                                                                 | O que faz                                                                                                                                                                                                                     |
| ---------------------------- | ----------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | -------- |
| `activate_version`           | DESTRUCTIVE | 5/900/1800  | `version`\*: SHA hex 7–40                                                                                                                                                  | fixa a etiqueta local e vm.sh ativar <versão> (exige migrate da mesma versão)                                                                                                                                                 |
| `apply_stack_config`         | MUTATING    | 5/900/1800  | —                                                                                                                                                                          | aplica a configuração de /opt/cenario na versão ATIVA: vm.sh aplicar-config (valida o Caddyfile, recria o proxy) + vm.sh ativar <ativa> (recria só o que mudou; mesmas imagens; sem migration; exige o portão)                |
| `application_logs`           | READ_ONLY   | 5/60/300    | `unit`\*: allowlist (cenario-homolog, cenario-backup-upload, cenario-runner, docker); `lines`: inteiro 1–5000 (padrão 200); `since_minutes`: inteiro 1–10080 (padrão 1440) | journal de UMA unidade systemd da allowlist                                                                                                                                                                                   |
| `backup_create`              | MUTATING    | 5/1800/3600 | —                                                                                                                                                                          | vm.sh backup (backup imediato + envio ao bucket)                                                                                                                                                                              |
| `backup_list`                | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | pastas de backup na VM                                                                                                                                                                                                        |
| `backup_restore_test`        | MUTATING    | 5/1800/3600 | `folder`: `cenario-[A-Za-z0-9._-]{1,100}`                                                                                                                                  | vm.sh restaurar-teste [pasta] (bancos SEPARADOS; original só lido)                                                                                                                                                            |
| `backup_validate`            | READ_ONLY   | 5/600/1800  | `folder`\*: `cenario-[A-Za-z0-9._-]{1,100}`                                                                                                                                | SHA256SUMS de uma pasta de backup                                                                                                                                                                                             |
| `container_logs`             | READ_ONLY   | 5/60/300    | `service`\*: allowlist (postgres, api, web, caddy, backup); `lines`: inteiro 1–5000 (padrão 200); `since_minutes`: inteiro 1–10080 (padrão 1440)                           | logs de UM contêiner da allowlist (linhas e janela limitadas)                                                                                                                                                                 |
| `containers_status`          | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | estado e saúde de cada contêiner                                                                                                                                                                                              |
| `database_counts`            | READ_ONLY   | 5/120/600   | —                                                                                                                                                                          | linhas por tabela (estatísticas do PostgreSQL)                                                                                                                                                                                |
| `database_fingerprint`       | READ_ONLY   | 5/300/1200  | —                                                                                                                                                                          | vm.sh impressao-digital                                                                                                                                                                                                       |
| `database_status`            | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | tamanho, conexões, bloqueios e consultas longas                                                                                                                                                                               |
| `disk_status`                | READ_ONLY   | 5/120/600   | —                                                                                                                                                                          | disco, volumes Docker e pasta de backups                                                                                                                                                                                      |
| `gate_close`                 | MUTATING    | 5/30/60     | —                                                                                                                                                                          | fecha o portão de publicação                                                                                                                                                                                                  |
| `gate_open`                  | MUTATING    | 5/30/60     | —                                                                                                                                                                          | abre o portão de publicação                                                                                                                                                                                                   |
| `gate_status`                | READ_ONLY   | 5/30/60     | —                                                                                                                                                                          | portão de publicação aberto/fechado                                                                                                                                                                                           |
| `health`                     | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | saúde rápida: contêineres + /api/ready pelo proxy local                                                                                                                                                                       |
| `images_cleanup`             | MUTATING    | 5/300/900   | —                                                                                                                                                                          | remove SÓ imagens da aplicação sem contêiner e fora das versões protegidas, com `docker image rm` sem `--force`; espaço antes/depois e cada etiqueta/ID/digest removido; idempotente                                          |
| `images_cleanup_plan`        | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | inventário das imagens da aplicação com a decisão de cada uma (protegida e por quê, ou candidata); nada é removido                                                                                                            |
| `maintenance_off`            | MUTATING    | 5/900/1800  | —                                                                                                                                                                          | volta API e web na versão ativa (vm.sh ativar)                                                                                                                                                                                |
| `maintenance_on`             | MUTATING    | 5/300/900   | —                                                                                                                                                                          | vm.sh manutencao (para API e web)                                                                                                                                                                                             |
| `migrate`                    | DESTRUCTIVE | 5/1800/3600 | `version`\*: SHA hex 7–40                                                                                                                                                  | vm.sh migrar <versão> (exige ponto de recuperação)                                                                                                                                                                            |
| `migration_precheck`         | READ_ONLY   | 5/300/1200  | `version`: SHA hex 7–40 (padrão: a candidata)                                                                                                                              | vm.sh preflight <versão>: cadeia banco × imagem (incompleta, desconhecida, divergente, fora de ordem), esquema e dados incompatíveis com as pendentes                                                                         |
| `migration_status`           | READ_ONLY   | 5/120/600   | `version`: SHA hex 7–40                                                                                                                                                    | \_prisma_migrations; com version, compara com as migrations da imagem                                                                                                                                                         |
| `migration_verify`           | READ_ONLY   | 5/120/600   | `version`\*: SHA hex 7–40                                                                                                                                                  | banco × migrations da imagem: nenhuma pendente, com falha ou desconhecida                                                                                                                                                     |
| `network_status`             | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | portas em escuta e respostas HTTPS locais                                                                                                                                                                                     |
| `prepare_version`            | MUTATING    | 5/900/1800  | `version`\*: SHA hex 7–40                                                                                                                                                  | vm.sh preparar-versao <versão>                                                                                                                                                                                                |
| `recovery_point_create`      | MUTATING    | 5/3600/7200 | —                                                                                                                                                                          | vm.sh ponto-recuperacao (exige manutenção)                                                                                                                                                                                    |
| `resources`                  | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | memória, swap, disco, carga, uso do Docker                                                                                                                                                                                    |
| `restart_api`                | MUTATING    | 5/300/900   | —                                                                                                                                                                          | reinicia o contêiner da API                                                                                                                                                                                                   |
| `restart_application`        | MUTATING    | 5/300/900   | —                                                                                                                                                                          | reinicia API e web                                                                                                                                                                                                            |
| `restart_containers`         | DESTRUCTIVE | 5/600/1200  | —                                                                                                                                                                          | reinicia todos os contêineres da pilha                                                                                                                                                                                        |
| `restart_web`                | MUTATING    | 5/300/900   | —                                                                                                                                                                          | reinicia o contêiner web                                                                                                                                                                                                      |
| `rollback_to_recovery_point` | DESTRUCTIVE | 5/3600/7200 | —                                                                                                                                                                          | vm.sh recuperar --sim (volta banco e versão ao ponto de recuperação)                                                                                                                                                          |
| `rollback_version`           | DESTRUCTIVE | 5/900/1800  | `version`\*: SHA hex 7–40                                                                                                                                                  | volta só a aplicação a uma versão já ativada, se o banco for compatível                                                                                                                                                       |
| `run_homologation_tests`     | READ_ONLY   | 5/600/1800  | `suite`\*: allowlist (saude, acesso, websocket, completo)                                                                                                                  | suítes da VM: saude                                                                                                                                                                                                           | acesso | websocket | completo |
| `smoke_test`                 | READ_ONLY   | 5/180/600   | —                                                                                                                                                                          | vm.sh saude (verificação completa)                                                                                                                                                                                            |
| `status`                     | READ_ONLY   | 5/120/600   | —                                                                                                                                                                          | vm.sh status (contêineres, memória, disco)                                                                                                                                                                                    |
| `update_runner`              | DESTRUCTIVE | 5/300/600   | `version`\*: N.N.N                                                                                                                                                         | instala uma versão PUBLICADA (bucket de versões, gravação humana) com SHA-256                                                                                                                                                 |
| `version`                    | READ_ONLY   | 5/60/300    | —                                                                                                                                                                          | versões: runner, /opt/cenario, etiqueta ativa, imagens em execução                                                                                                                                                            |
| `vm_scripts_diff`            | READ_ONLY   | 5/120/600   | `version`\*: SHA hex 7–40                                                                                                                                                  | diferença exata entre /opt/cenario e o pacote PUBLICADO scripts-<versão> (por categoria: vm.sh, Compose, Caddy, auxiliares; diff unificado; arquivos só da VM)                                                                |
| `vm_scripts_restore`         | DESTRUCTIVE | 5/120/600   | —                                                                                                                                                                          | volta /opt/cenario à cópia guardada pelo último vm_scripts_update (nada reiniciado)                                                                                                                                           |
| `vm_scripts_update`          | DESTRUCTIVE | 5/300/900   | `version`\*: SHA hex 7–40                                                                                                                                                  | instala o pacote PUBLICADO scripts-<versão> (SHA-256, commit do git archive, só caminhos permitidos, sem links; vm.sh, Compose e Caddyfile validados antes); guarda a cópia anterior; mantém arquivos locais; nada reiniciado |
| `websocket_test`             | READ_ONLY   | 5/60/120    | —                                                                                                                                                                          | handshake WebSocket em /api/realtime pelo proxy                                                                                                                                                                               |

**Operações do cliente** (`operar.py`, pelas APIs do Google, sem passar pela VM):

| Comando                                      | Faz                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vm-status`                                  | estado da VM (Compute API)                                                                                                                                                                                      |
| `vm-reiniciar`, `vm-ligar`, `vm-desligar`    | reset, start e stop, somente desta VM                                                                                                                                                                           |
| `imagens <sha>`                              | se `api:<sha>` e `web:<sha>` existem no Artifact Registry                                                                                                                                                       |
| `build-iniciar <sha>`                        | envia a fonte do commit **exato** (`git archive`) e publica o pedido no tópico do gatilho `cenario-homolog-build-autonomo` (conta `cenario-build` fixa no gatilho); antes, confere que o gatilho usa essa conta |
| `build-status <id>`, `build-acompanhar <id>` | estado do build                                                                                                                                                                                                 |
| `testes-locais <suite> [--versao SHA]`       | suítes do repositório no container: api, web, shared, e2e, lint, typecheck, format (comandos fixos)                                                                                                             |
| `verificar`                                  | `status` + `version` pela fila (canal de ponta a ponta)                                                                                                                                                         |
| `teste-seguranca`                            | replay, claims adulteradas, kid forjado, envelope com campo de script, operação fora do catálogo assinada, parâmetro fora da allowlist assinado; todos devem ser recusados                                      |

**Fluxo "Homologue o commit X"**, sem comandos intermediários seus:

1. `verificar`, `version`, `health`, `migration_status version=X`
2. `imagens X`; se faltarem, `build-iniciar X` e `build-acompanhar`
3. `prepare_version version=X`
4. `gate_open` (se fechado)
5. `maintenance_on`
6. `recovery_point_create` (backup + SHA-256 + restauração de teste + cópia no bucket)
7. `backup_validate`
8. `migration_precheck version=X` (bloqueia: incompleta, desconhecida, divergente, fora de ordem, esquema ou dados)
9. `migrate version=X`
10. `migration_verify version=X`
11. `activate_version version=X`
12. `smoke_test`, `websocket_test`, `run_homologation_tests suite=completo`
13. `testes-locais e2e`
14. espaço: `images_cleanup_plan` → `images_cleanup` (antes do próximo `prepare_version`)
15. `container_logs` / `application_logs`
16. relatório

Em falha: `rollback_to_recovery_point`, ou `rollback_version` quando o banco é compatível.

## 3. Validação de cada job (falha fechada)

- **Envelope:** exatamente `{"v": 2, "jwt": …}`, com até 16 KiB. Qualquer outro campo, inclusive `script`, é recusado.
- **JWT:**
  - RS256 com `kid` da conta `claude-operador`, conferido com os certificados públicos do Google (`openssl`);
  - claims exatamente `iss, sub, aud, jti, iat, exp, vm, projeto, operacao, parametros, timeout_s, descricao`;
  - emissor = `claude-operador`, audiência `cenario-homolog-runner`, VM `cenario-homolog`, projeto `cenariogestao`;
  - validade de no máximo 15 min, com tolerância de 2 min no relógio.
- **Operação:** precisa estar na tabela.
- **Parâmetros:** schema estrito, sem chave a mais. SHA, pasta e versão por expressão regular; serviço, unidade e
  suíte por allowlist; inteiros com intervalo; booleanos recusados.
- **Timeout:** dentro do intervalo da operação.
- **Anti-replay e idempotência:** o `jti` (UUID v4) é reservado atomicamente (`mkdir`) antes da execução. O mesmo
  `jti` nunca roda de novo, nem depois de reiniciar. O resultado já gravado nunca é sobrescrito.
- **Queda:** um job "aceito/em execução" sem resultado vira `interrompido` na partida e **não** é reexecutado.
- **Certificados indisponíveis:** a mensagem volta à fila sem executar e expira em até 15 min.
- **Execução:**
  - somente listas de argumentos (sem `shell=True`, sem `sh -c`, sem `eval`);
  - ambiente mínimo e entrada fechada;
  - grupo de processos próprio; no timeout, SIGTERM e depois SIGKILL.
- **SQL:** só três consultas constantes do código (migrations, estado do banco, contagens). O restante passa pelos
  scripts auditados (`vm.sh impressao-digital`, `preflight`, `migrar`, `recuperar`).
- **Saída:** até 10 MiB por fluxo; o excesso é marcado como `truncado`.
- **Máscara:** valores de `/run/cenario/env` (≥ 8 caracteres), chaves privadas, `Authorization`, cookie do portão,
  tokens `ya29.`, senhas em URLs e `*PASSWORD/SECRET/TOKEN/HASH=`. Aplicada ao stdout, ao stderr, ao motivo e aos
  argumentos registrados.
- **Auditoria:**
  - `gs://…-operacoes/operacoes/<jti>/{envelope,stdout,stderr,resultado}` e `rejeitados/…`, só criação;
  - `/var/log/cenario-runner/auditoria.jsonl` (600);
  - Cloud Logging `cenario-runner`.
- **Partida:** recusa (código 78, fica parado) se os metadados não forem desta VM/projeto.
- **Desligamento de emergência:** `/etc/cenario/runner-desativado`.

## 4. IAM exato

| Identidade           | Onde                                         | Papel                                                                                                                                                              |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-operador`    | projeto                                      | `compute.viewer`, `logging.viewer`, `monitoring.viewer`, `cenarioOperadorBuild` (`cloudbuild.builds.{get,list}`: só consulta), `serviceusage.serviceUsageConsumer` |
| `claude-operador`    | VM `cenario-homolog`                         | `cenarioOperadorVm` = `compute.instances.{get,getSerialPortOutput,start,stop,reset}`                                                                               |
| `claude-operador`    | a própria conta                              | `cenarioAssinaJwt` = `iam.serviceAccounts.signJwt` (não cria tokens nem chaves)                                                                                    |
| `claude-operador`    | tópico `cenario-homolog-comandos`            | `pubsub.publisher`                                                                                                                                                 |
| `claude-operador`    | tópico `cenario-homolog-build`               | `pubsub.publisher` (pedidos de build ao gatilho)                                                                                                                   |
| `claude-operador`    | `gs://cenariogestao-homolog-operacoes`       | `storage.objectViewer`                                                                                                                                             |
| `claude-operador`    | `gs://cenariogestao-homolog-build`           | `storage.objectCreator`, `storage.objectViewer` (envia a fonte; não apaga nem sobrescreve)                                                                         |
| `claude-operador`    | repositório `cenario-homolog`                | `artifactregistry.reader`                                                                                                                                          |
| `cenario-build`      | projeto / repositório / build                | `logging.logWriter` / `artifactregistry.writer` / `storage.objectViewer`                                                                                           |
| `cenario-homolog-vm` | projeto                                      | `logging.logWriter`                                                                                                                                                |
| `cenario-homolog-vm` | assinatura `cenario-homolog-comandos-vm`     | `pubsub.subscriber`                                                                                                                                                |
| `cenario-homolog-vm` | `gs://…-operacoes` / `gs://…-runner-versoes` | `storage.objectCreator` / `storage.objectViewer`                                                                                                                   |

**Não concedido:**

- Owner, Editor e qualquer Admin de IAM/projeto;
- `setMetadata` ou SSH na VM;
- acesso a segredos;
- acesso ao bucket de backups e ao bucket de versões do runner;
- qualquer papel em `verificapro-8d3c8` ou em outro projeto (o bootstrap confere).

## 5. Bootstrap e verificação

No Cloud Shell, na raiz do repositório, com a chave SSH no ssh-agent:

```bash
git fetch origin && git checkout <SHA deste commit> && bash infra/homolog/gcp/autonomia/bootstrap.sh
```

**O que o bootstrap faz:**

1. Confere a conta (não pode ser uma conta de serviço), o projeto, a VM, a conta e o escopo da VM, a árvore limpa
   e a versão do runner.
2. Mostra o plano e pede a frase de confirmação.
3. Aplica tudo de forma idempotente.
4. Publica o runner (imutável, com SHA-256) e o instala pela sua sessão SSH.
5. Testa o canal com uma permissão **temporária** de assinatura para você, removida em seguida: `verificar` e
   `teste-seguranca`.
6. Confere o isolamento.
7. Pergunta se o tipo **"GCP access token (with Service Account Key)"** aparece em Network secrets. Só com
   "existe" cria a chave, num diretório 700. O conteúdo não é exibido nem registrado, o arquivo é baixado por
   `cloudshell download` e é destruído quando você confirma.

`plano` mostra sem alterar. `verificar` refaz o isolamento e o teste do canal.

### Publicação humana de uma versão nova do runner e dos scripts da VM (único passo humano)

```bash
git fetch origin && git checkout <SHA> && bash infra/homolog/gcp/autonomia/bootstrap.sh publicar-runner
```

Grava no bucket de versões (só você grava; imutável, `--if-generation-match=0`, com SHA-256):

- `runner-<N.N.N>.tar.gz` (os 4 arquivos do runner);
- `scripts-<commit 12>.tar.gz`: `git archive` do commit, só `infra/homolog` e `scripts/{backup,restore}.sh`
  (o mesmo conteúdo que `homolog.sh preparar-vm` copiava para /opt/cenario), `gzip -n` (reprodutível).

Não acessa a VM. Depois, pelo runner (autônomo): `update_runner version=N.N.N` → `vm_scripts_diff version=<commit>` →
`vm_scripts_update version=<commit>` → `gate_open` → `apply_stack_config` → `gate_close` → validações. O runner
confere, antes de qualquer troca, o SHA-256, que o pacote é o `git archive` do commit pedido (comentário pax), que
só há diretórios e arquivos regulares em `infra/homolog/…` e `scripts/{backup,restore}.sh`, que o `vm.sh` novo é
bash válido, que o Compose novo é válido com o ambiente atual e que o Caddyfile novo é aceito pelo Caddy da pilha.
Reversão: `vm_scripts_restore` + `apply_stack_config`. O claude-operador não grava no bucket de versões: não existe
caminho para ele instalar runner ou scripts que você não publicou.

### Limpeza de imagens (`images_cleanup_plan` / `images_cleanup`)

Só imagens do repositório da aplicação (`…/cenario-homolog/api|web`) com etiqueta SHA. Protegidas: a versão ativa;
a do ambiente da pilha; a candidata; a migrada; a do ponto de recuperação; a ativada antes da atual (histórico do
runner); a versão mais recente além da ativa (por ID de imagem distinto: apelidos da ativa não contam); toda versão
com qualquer imagem usada por contêiner (mesmo parado); e qualquer etiqueta com o mesmo ID de imagem protegida.
Nunca: `prune`, `--force`, volumes, contêineres, banco, backups ou imagens fora do repositório da aplicação
(postgres, caddy). Versão ativa desconhecida → nada é removido.

## 6. Revogação

Use `bash infra/homolog/gcp/autonomia/revogar.sh` com uma destas opções:

| Opção                              | Efeito                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `estado`                           | mostra a situação                                                                             |
| `pausar-runner` / `retomar-runner` | a VM para ou volta a ler a fila                                                               |
| `suspender` / `reativar`           | desativa ou reativa `claude-operador`; nada assina                                            |
| `revogar-chaves`                   | apaga as chaves; o Network Secret para de funcionar                                           |
| `remover-tudo`                     | chaves, ligações, contas, papéis e fila; desinstala o runner; os buckets ficam para auditoria |

Na VM: `touch /etc/cenario/runner-desativado`.

## 7. Riscos conhecidos

- **Código de aplicação.** Quem opera pode construir imagens a partir de commits e implantá-las. O código das
  imagens roda nos contêineres, com acesso ao banco e às variáveis da aplicação. É inerente ao deploy autônomo.
  Mitigações: só commits do repositório, imagens identificadas pelo SHA, histórico no git e auditoria de cada
  `activate_version`.
- **Cloud Build: o operador não cria builds.** Quem cria uma build escolhe a conta em que ela roda, e o
  Cloud Build não exige `actAs` para a conta legada `NUM@cloudbuild.gserviceaccount.com`. Por isso
  `claude-operador` **não tem `cloudbuild.builds.create`** em lugar nenhum. As builds autônomas vêm de um
  **gatilho Pub/Sub** (`cenario-homolog-build-autonomo`) que você cria no bootstrap.
  - A conta (`cenario-build`) e os passos (`cloudbuild-autonomo.json`) ficam fixos no gatilho.
  - O operador só envia a fonte do commit (`git archive`) para `gs://…-homolog-build/source/<sha>.tgz` e publica
    `{tag, fonte}` no tópico `cenario-homolog-build`.
  - A build valida esses dois valores por expressão regular. Eles entram nos passos só como variáveis de
    ambiente, nunca como texto de script.
  - Sem `builds.create`, o operador não cria, não re-executa e não gatilha builds com nenhuma outra conta: nem a
    legada, nem a Compute com Editor, nem a da VM. Também não precisa de `actAs` em conta alguma.
  - O bootstrap bloqueia, sem alterar IAM, nestes casos:
    - o operador ou `cenario-build` tem papel com `builds.create`/`update`, `actAs`, tokens ou `setIamPolicy`;
    - o operador ou `cenario-build` age sobre alguma conta;
    - o gatilho existente difere do repositório;
    - outro gatilho escuta os tópicos do operador.
  - A conta legada e a conta padrão aparecem no plano com o uso atual. Remover o
    `cloudbuild.builds.builder` da legada fica como recomendação opcional: não afeta o operador.
- **Alcance do Network Secret.** A credencial vale para todas as sessões do ambiente do Claude Code onde está.
  Mantenha esse ambiente pessoal.
- **Chave JSON.** É persistente, porque não há credencial federada aceita pelos Network Secrets. Fica só no proxy.
  Revogação imediata por `revogar.sh`; rotação recomendada.
- **Recursos não testados com o Google real** (só com APIs falsas e OpenSSH local): `reboot_vm`/`start`/`stop`
  (a conta de serviço da VM pode exigir `actAs` no start, não concedido) e o fluxo do Cloud Build com conta
  própria.
- **Ainda não implementado.** O usuário técnico de testes da aplicação depende do schema da versão implantada e
  é a próxima operação a acrescentar (nova versão do runner). O `websocket_test` sem sessão comprova o caminho
  proxy → API (401 antes do upgrade), não o tempo real autenticado.
- **Scripts do host.** Mudanças em `infra/homolog` (vm.sh, Compose, Caddy) continuam exigindo publicação humana
  (`homolog.sh preparar-vm` ou `operador.sh atualizar-config`).

## 8. Testes

- `python3 -m unittest infra/homolog/gcp/autonomia/testes/test_runner.py`: runner real com APIs falsas
  (assinatura RS256 real), HTTPS local falso e `vm.sh`/`docker` falsos:
  - caminho feliz pelo cliente;
  - recusas: operação desconhecida, parâmetros extras ou inválidos, envelope com script, claims, assinatura,
    kid, alg none, expirado, futuro, malformado, base64, tamanho;
  - replay;
  - certificados indisponíveis (falha fechada);
  - máscara;
  - health/websocket/network;
  - migration_verify;
  - activate com etiqueta local;
  - portão, falha de passo, timeout com término do grupo, saída limitada;
  - exclusão mútua;
  - desligamento de emergência;
  - auditoria;
  - update_runner: versão publicada, SHA divergente, pacote com caminho, inexistente;
  - partida em VM errada;
  - job interrompido não reexecutado;
  - análise estática: sem shell, sem SQL dinâmico, schemas restritos.
- `bash infra/homolog/gcp/autonomia/testes/test_bootstrap.sh`: bootstrap, revogação e instalador com gcloud falso:
  - plano só lê; confirmação errada não altera nada;
  - o IAM aplicado é exatamente o da tabela acima;
  - idempotência;
  - chave só com confirmação e destruída depois;
  - recusas; isolamento;
  - todos os níveis de revogação;
  - instalação com configuração validada.
