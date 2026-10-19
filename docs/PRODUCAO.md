# Produção do Cenário Gestão — arquitetura, provisionamento e operação

Estado: **preparado e testado no repositório; NÃO aplicado no Google Cloud.** O provisionamento exige
uma conta com permissão de administrador no projeto (a sua). A sessão do Claude Code da homologação não
tem essa permissão por desenho: o `claude-operador` só tem `compute.viewer` e papéis estreitos da
homologação. Veja a §13.

## 1. Arquitetura

A mesma arquitetura homologada, numa infraestrutura de produção separada:

```
Internet → DNS (Hostinger: cenariogestao.com.br, www) → IP estático cenario-prod-ip
        → firewall cenario-prod-web (tcp 80/443) → VM cenario-prod
        → Caddy (HTTPS Let's Encrypt; www → canônico) → web (Next.js) / API (Fastify) → PostgreSQL 16
```

- Contêineres: `postgres`, `api`, `web`, `caddy` e `backup` (`infra/prod/docker-compose.prod.yml`).
  Só o Caddy publica portas, e só 80 e 443. PostgreSQL, API e web ficam na rede interna.
- Imagens: **as mesmas da homologação, byte a byte**. São promovidas por digest para o Artifact Registry
  `cenario-prod`, com etiquetas imutáveis, e identificadas pelo SHA do commit. A produção nunca constrói
  imagens e nunca usa `latest`.
- Banco: **novo e vazio**. Nada é copiado nem restaurado da homologação.
- Diferenças deliberadas em relação à homologação:
  - sem a camada de usuário/senha do proxy;
  - `APP_ENV=production`;
  - limites de memória para e2-medium;
  - backups retidos por 30 dias no volume e 90 no bucket;
  - alerta de disco em 80% (a homologação usa 85%).

## 2. Recursos (projeto `cenariogestao`, região `southamerica-east1`, zona `southamerica-east1-b`)

O projeto é o mesmo da homologação: a documentação não decidiu por outro, e a autorização prefere
mantê-lo. A separação é por recurso, identidade, segredo, bucket, firewall e permissão.

| Recurso                   | Nome                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VM                        | `cenario-prod` (e2-medium: 2 vCPU compartilhadas, 4 GB; Debian 12; VM protegida; proteção contra exclusão; OS Login; chaves SSH do projeto bloqueadas)                                      |
| Disco                     | 50 GB pd-balanced (o disco não é apagado com a VM) + snapshots diários `cenario-prod-diario` (14 dias)                                                                                      |
| Rede                      | `cenario-prod-vpc` / `cenario-prod-subnet` 10.60.0.0/24 (acesso privado ao Google)                                                                                                          |
| Firewall                  | `cenario-prod-web` (tcp 80/443, só a tag `cenario-prod`) e `cenario-prod-iap-ssh` (tcp 22 SÓ do IAP 35.235.240.0/20)                                                                        |
| IP                        | `cenario-prod-ip` (estático, regional, Premium)                                                                                                                                             |
| Conta da VM               | `cenario-prod-vm@` (`logging.logWriter`)                                                                                                                                                    |
| Segredos (Secret Manager) | `prod-postgres-password`, `prod-token-hash-secret`, `prod-admin-password` (réplica em São Paulo; só a conta da VM lê)                                                                       |
| Backups                   | `gs://cenariogestao-prod-backups` (acesso uniforme, sem acesso público, apagados aos 90 dias; a VM só CRIA objetos)                                                                         |
| Imagens                   | Artifact Registry `cenario-prod` (docker, etiquetas imutáveis; a VM só lê)                                                                                                                  |
| Operador automático       | `claude-operador-prod@`, fila `cenario-prod-comandos` → `cenario-prod-comandos-vm`, `gs://cenariogestao-prod-operacoes` (90 dias), `gs://cenariogestao-prod-runner-versoes` (só você grava) |

### Dimensionamento

Na homologação, uma e2-small (2 GB + 2 GB de swap) operou o painel e 4 tablets. A memória livre ficou
em ~1 GB e o disco de 20 GB chegou a 86%: cada versão tem imagens de ~3,7 GB.

Na produção:

- **e2-medium (4 GB)** dá folga para picos de memória (Next.js, Prisma, pg_dump) sem superdimensionar.
- **50 GB** comportam a versão ativa, a anterior, a candidata, volumes e backups (alerta em 80%).

Medidas no ensaio local, com o bootstrap e sem uso real: PostgreSQL ~92 MB, API ~101 MB, web ~125 MB e
Caddy ~16 MB, contra limites de 1 GB, 1 GB, 640 MB e 192 MB.

## 3. Segurança e isolamento

- **Identidades separadas.**
  - O runner da produção (o mesmo código do runner homologado, com o perfil `prod`) só aceita JWT
    assinado pelo Google para `claude-operador-prod`, com audiência `cenario-prod-runner`, VM
    `cenario-prod` e projeto `cenariogestao`.
  - Na partida, o runner recusa uma configuração incoerente: perfil prod com identidade, audiência ou
    bucket da homologação, e o inverso.
  - O operador da homologação não tem papel em nenhum recurso de produção, e o operador de produção não
    tem papel em nenhum recurso da homologação (`provisionar.sh verificar`).
- **Credenciais por ambiente do Claude Code.** A chave do `claude-operador-prod` vai para um **ambiente
  novo** do Claude Code (Network Secret), nunca para o da homologação. Uma sessão de homologação só
  consegue assinar como `claude-operador`.
- **Operações nomeadas.** O catálogo homologado não aceita shell, SQL, script nem caminho do cliente.
  Ele tem schemas estritos, allowlists, timeout, máscara de segredos, anti-replay, resultados imutáveis e
  desligamento de emergência. Em produção ele ganha só `stack_bootstrap` e `seed_bootstrap`, que valem
  só no perfil prod.
- **Barreira humana.** Runner e scripts da VM só são instalados a partir de pacotes que VOCÊ publica no
  bucket de versões, conferidos por SHA-256 e pelo commit. O operador não grava nesse bucket.
- **Sem acesso amplo.** Os papéis Owner/Editor/IAM Admin, metadados da VM, SSH, segredos e backups
  nunca são concedidos ao operador.
- **Escutas da VM.**
  - O portão de preparo (`vm.sh verificar-preparo`) só aceita a porta 22 fora do loopback (TCP). Ao
    reprovar, ele lista porta e processo.
  - A imagem debian-12 atual traz o `systemd-resolved` com LLMNR ativo, escutando em `0.0.0.0:5355`
    (TCP/UDP).
  - O `startup.sh` desativa LLMNR e mDNS de forma persistente, com o drop-in
    `/etc/systemd/resolved.conf.d/90-cenario-sem-llmnr.conf` (`LLMNR=no`, `MulticastDNS=no`).
  - O portão confere que nada escuta em 5355/5353, nem TCP nem UDP.
  - A porta não foi liberada no portão: liberar deixaria passar qualquer outro processo nela.
- **Visibilidade cruzada residual (ressalva).**
  - O `claude-operador` da homologação tem `compute.viewer` e `logging.viewer` no projeto, papéis
    anteriores a esta etapa. Com eles, ele **vê** os metadados não secretos da VM de produção e os logs
    do Cloud Logging, mas não opera nada.
  - A aplicação registra logs no próprio disco da VM (Docker), não no Cloud Logging.
  - Remover essa visibilidade exige mudar a homologação: é decisão sua.

## 4. Seed / bootstrap mínimo

Classificação do seed do repositório (`packages/db/src/seed.ts`):

| O que cria                                                 | Classe                       | Produção                            |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| Funções padrão e permissões                                | B — funções/permissões       | sim                                 |
| Configurações da empresa (horários levantados)             | A — estrutural               | sim                                 |
| Modelos de produção, checklists de qualidade, localizações | A — estrutural               | sim                                 |
| Primeiro gestor (só com `SEED_ADMIN_*`)                    | C — administrador necessário | sim (segredo `prod-admin-password`) |
| Ricardo, Márcio, Thiago, João, André, Izaías               | D/E — exemplo/homologação    | **não** (`SEED_TEAM=false`)         |
| Responsáveis padrão de etapas e da equipe própria          | dependem da equipe           | não aplicados (sem equipe)          |

O seed já suporta `SEED_TEAM=false`: nenhuma linha de código mudou.

`vm.sh semear`:

- **recusa** um banco que já tenha mais de um funcionário;
- confere o resultado: 1 funcionário (o gestor), 1 usuário, 0 clientes, 0 pedidos, 0 OS, 0 dispositivos.

### Primeiro gestor

- E-mail e nome são informados no `provisionar.sh infraestrutura` e ficam nos metadados não secretos da
  VM.
- A senha é gerada no Cloud Shell: 24 caracteres, letras e números, conforme a política do sistema. Ela
  vai **direto** ao Secret Manager pela entrada padrão e nunca aparece em tela, log, Git ou imagem.
- Para ler a senha (só você, no Cloud Shell):
  `gcloud secrets versions access latest --secret=prod-admin-password --project=cenariogestao`.
- No primeiro acesso, troque a senha em **Minha conta**.

## 5. Backup, restauração, ponto de recuperação, rollback

- **Backup diário.** O contêiner `backup` grava banco e arquivos com SHA-256, com retenção de 30 dias
  na VM. O timer `cenario-backup-upload` (07:30 UTC) envia ao bucket de produção, só criando objetos.
  O bucket guarda 90 dias e é criptografado em repouso pelo Google.
- **Snapshots** do disco da VM: diários, mantidos por 14 dias.
- **Restauração de teste** (`backup_restore_test`): é feita em bancos SEPARADOS, conferida item a item
  pela impressão digital. A produção só é lida.
- **Ponto de recuperação** (`recovery_point_create`): backup, checksum, restauração de teste idêntica,
  impressão digital e envio ao bucket. Ele também é validado no **primeiro deploy, com o banco vazio**.
- **Rollback:**
  - `rollback_version <v>`: volta só a aplicação, se o banco for compatível e a versão já tiver sido
    ativada;
  - `rollback_to_recovery_point`: volta banco e versão ao ponto. O que foi gravado depois do ponto se
    perde, e isso fica documentado.
- **Versões preservadas.** As imagens da versão ativa e da anterior não são removidas pela limpeza
  (`images_cleanup`, mesmas proteções da homologação). No Artifact Registry as etiquetas são imutáveis.

## 6. Promoção das imagens (§ Promoção)

`provisionar.sh promover` executa `infra/prod/gcp/promover-imagens.sh <sha> <digest-api> <digest-web>`
com a sua conta. Para cada imagem:

1. A origem `cenario-homolog/<svc>:<sha>` precisa ter **exatamente** o digest homologado; senão nada é
   copiado.
2. Uma etiqueta de produção já existente com outro digest nunca é sobrescrita.
3. A cópia é feita de registro para registro pelo digest, e o digest do destino é conferido.

Para a versão `9fb1786`:

- `api`: `sha256:6e4a225dc8fb8619d0165627f65828b0950f481f93b440cc95f1fbf5cac5f848`
- `web`: `sha256:7b99ebc11fbf700f4eee81acb0100d4ae1cdbdca24198b0bd166ad40fa0cf822`

Os dois vêm da build `d45323b6`, ativa e validada na homologação.

Nenhuma permissão é acrescentada na homologação. Uma promoção automática futura, por gatilho, exigiria
dar leitura do repositório da homologação a uma conta de produção: é decisão sua.

## 7. Provisionamento (Cloud Shell, sua conta)

```bash
git fetch origin && git checkout <commit deste documento>
eval "$(ssh-agent -s)"; ssh-add -t 1h ~/.ssh/google_compute_engine
bash infra/prod/gcp/provisionar.sh auditar      # só leitura (inclui o DNS atual)
bash infra/prod/gcp/provisionar.sh tudo         # infraestrutura → promover → preparar-vm → operador → dns → verificar → credencial
```

Cada etapa pede uma frase de confirmação e só cria o que falta (idempotente). Registros sem segredos
ficam em `~/cenario-prod-relatorios/`.

Teste do canal do operador (`operador` o executa ao final; `canal` o repete sozinho, sem criar, publicar ou
instalar nada):

- O dono não tem `iam.serviceAccounts.signJwt` (o papel Owner não inclui essa permissão). Por isso o teste
  concede a ele `cenarioProdAssinaJwt` sobre `claude-operador-prod` só durante o teste e remove no final.
- Enquanto essa permissão propaga, o `signJwt` responde 403 e o `operar.py` sai com 126, sem publicar
  nada. Só esse caso é repetido: até 32 tentativas a cada 15 s.
- Qualquer outra falha já passou pela fila e pelo runner. Ela não é repetida, para não reenviar jobs.
- Em produção, o `operar.py verificar` usa `gate_status` + `version`. Antes do primeiro deploy não existe
  `/run/cenario/env`: ele é gerado só pelo `stack_bootstrap`, com o portão aberto. Por isso `status`
  falharia por desenho.
- Canal e isolamento são contados separadamente. A etapa só termina com `ETAPA OPERADOR: OK`.

## 8. DNS e HTTPS

- `provisionar.sh dns` mostra os registros atuais em 8.8.8.8 e 1.1.1.1.
- Se a raiz já aponta para outro lugar, exige a confirmação de que o destino não é um serviço em uso.
- Depois imprime os registros a criar na Hostinger e espera a propagação. Ele nunca altera o DNS.
  - `A @ → <IP de cenario-prod-ip>`
  - `CNAME www → cenariogestao.com.br`
  - Não mexa em `teste` (homologação), MX, TXT e NS.
  - Se houver CAA sem `letsencrypt.org`, inclua `0 issue "letsencrypt.org"`.
- Domínio canônico: `cenariogestao.com.br`. O `www` redireciona com 301, e HTTP redireciona para HTTPS
  (308).
- O certificado é emitido pelo Caddy (Let's Encrypt) na primeira partida, **depois** do DNS correto.

## 9. Primeiro deploy (sessão no ambiente de PRODUÇÃO do Claude Code)

`export CENARIO_AMBIENTE=prod` e então, com `operar.py op …`, nesta ordem:

| #   | Operação                                                                                                                                                                     | Prova                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `verificar`, `version`, `disk_status`, `gate_status`                                                                                                                         | VM certa, nada iniciado, portão fechado                                    |
| 2   | `operar.py imagens 9fb1786…` (repositório `cenario-prod`)                                                                                                                    | imagens promovidas por digest                                              |
| 3   | `gate_open`                                                                                                                                                                  | portão aberto                                                              |
| 4   | `stack_bootstrap version=<sha>`                                                                                                                                              | etiqueta local fixada; ambiente gerado; só PostgreSQL e backup; banco NOVO |
| 5   | `prepare_version version=<sha>`                                                                                                                                              | digests; a imagem não migra na partida                                     |
| 6   | `recovery_point_create`, `backup_validate folder=…`                                                                                                                          | backup do banco vazio, restauração IDÊNTICA, bucket                        |
| 7   | `migration_precheck version=<sha>`                                                                                                                                           | 31 pendentes, nada divergente                                              |
| 8   | `migrate version=<sha>`                                                                                                                                                      | 31 aplicadas                                                               |
| 9   | `activate_version version=<sha>`                                                                                                                                             | API saudável + `vm.sh saude`                                               |
| 10  | `seed_bootstrap`                                                                                                                                                             | só o gestor e a configuração estrutural                                    |
| 11  | `gate_close`, `migration_verify`, `health`, `smoke_test`, `websocket_test`, `run_homologation_tests suite=completo`, `container_logs`, `database_fingerprint`, `disk_status` | 31/31, HTTPS, acesso, WebSocket, logs                                      |

O que confere a saúde de produção (`vm.sh saude`, sem criar nada):

- contêineres, `/api/ready`, `APP_ENV=production`;
- HTTP→HTTPS, www→canônico, tela de entrada e JavaScript, HSTS, sem HTTP/3;
- rotas gerenciais/financeiras/auditoria/Central com **401 sem sessão**, e WebSocket com 401 sem sessão;
- certificado, último backup, migrations, disco < 80% e memória.

## 10. Logs, saúde, disco

- **Logs:**
  - Docker json-file com rotação (20 MB × 5 por contêiner);
  - `container_logs` (api, web, postgres, caddy, backup);
  - `application_logs` (cenario-prod, cenario-backup-upload, cenario-runner, docker);
  - auditoria do runner no bucket de operações.
- **Disco:**
  - alerta em 80% (`saude`);
  - `preparar-versao` exige 10 GB livres;
  - `images_cleanup_plan` / `images_cleanup` (ativa, anterior, candidata e ponto protegidas);
  - snapshots fora do disco.

## 11. Emergência

- `provisionar.sh emergencia` desativa o `claude-operador-prod` e pausa o runner
  (`/etc/cenario/runner-desativado`).
- Na VM: `touch /etc/cenario/runner-desativado` ou `systemctl disable --now cenario-runner`.

## 12. Custo mensal estimado (US$, preços de lista, VM 24 h)

| Item                              | Estimativa       |
| --------------------------------- | ---------------- |
| VM e2-medium southamerica-east1   | ~39,00           |
| Disco 50 GB pd-balanced           | ~7,50            |
| IPv4 estático em uso              | ~3,65            |
| Snapshots (incrementais, 14 dias) | ~0,50–1,00       |
| Bucket de backups (1–5 GB)        | ~0,05–0,25       |
| Artifact Registry (4–8 GB)        | ~0,40–0,80       |
| Secret Manager, Pub/Sub, Logging  | ~0,20            |
| Saída de internet (dezenas de GB) | ~1–5             |
| **Total**                         | **~52–58 / mês** |

Premissas: sem descontos de uso contínuo nem créditos. Confira na calculadora do Google: os preços de
São Paulo são ~1,5× os de us-east1.

## 13. Por que o provisionamento precisa de você

- A sessão do Claude Code da homologação usa a credencial do `claude-operador`. Ela foi criada para
  **não** poder criar VM, rede, IAM, segredo ou bucket (`bootstrap.sh`, `PROIBIDOS`).
- Criar a produção exige uma conta com essas permissões: a sua, no Cloud Shell.
- O DNS está na Hostinger, que não é alcançável a partir daqui.
- A credencial do operador de produção só pode ir para um ambiente do Claude Code que você configure.

## 14. Testes (locais, sem nuvem)

| Teste                                                                                                                      | Cobre                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/prod/gcp/testes/test_provisionar.sh`                                                                                | plano só lê; recursos exatos; segredos novos nunca expostos; nada da homologação alterado; idempotência; isolamento reprova ligação cruzada; promoção por digest                                           |
| `infra/prod/gcp/testes/test_vm_sh_prod.sh`                                                                                 | backup só-criação; portão; `gerar-env` só com `prod-*`; Compose e `startup.sh` de produção                                                                                                                 |
| `infra/prod/gcp/testes/test_runner_prod.py`                                                                                | runner no perfil prod: identidade, audiência, VM, unidades, banco, pacote só `infra/prod`, primeira publicação, partida incoerente recusada, ferramentas compartilhadas idênticas                          |
| `infra/prod/gcp/testes/ensaio-primeiro-deploy.sh`                                                                          | pilha REAL de produção com as imagens de 9fb1786: banco novo → ponto (vazio) → preflight → 31 migrations → ativar → bootstrap mínimo → acesso → login do gestor → restauração idêntica → rollback ao ponto |
| Suítes da homologação (`test_runner.py`, `test_bootstrap.sh`, `test_vm_sh.sh`, `test_homolog_sh.sh`, `test_ssh_agente.sh`) | sem regressão                                                                                                                                                                                              |
