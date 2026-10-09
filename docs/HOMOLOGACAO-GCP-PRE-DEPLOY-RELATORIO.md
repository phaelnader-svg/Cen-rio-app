# Homologação no Google Cloud — Relatório de pré-implantação

> **Situação:** preparação concluída **somente no repositório**. Nada foi publicado. O ambiente do
> Claude Code continua **sem credenciais do Google Cloud** (`gcloud auth list` → nenhuma conta;
> leitura do projeto → `CREDENTIALS_MISSING`). Por isso **nenhum recurso real foi lido, criado ou
> alterado por mim**, e nenhuma chave foi solicitada. A auditoria e a configuração do estado real
> foram transformadas em comandos idempotentes para você executar no Cloud Shell (§11).
>
> Base: branch `claude/cenario-gestao-fase-1-zf3bj2`. HEAD remoto conferido antes de começar:
> `9568efe`. Scripts e testes: commit `f4f32fd`. Este relatório: o commit seguinte.

## Atualização após a auditoria real

A auditoria no Cloud Shell confirmou a VM, a VPC, os 5 segredos e o bucket. Dois achados foram
corrigidos (nenhum controle de segurança ou limite de custo foi desativado):

1. **`custos` encontrava só 3 de 5 SKUs (faltavam disco e snapshots).** Causa: a regra estrita
   exigia que o disco pd-balanced tivesse **us-east1 como única** região; a SKU real cobre várias
   regiões (a versão anterior, que aceitava "us-east1 entre as regiões", chegou a US$ 19,29). A
   regra do disco passou a aceitar SKUs que **incluem** us-east1; continuam recusados o disco
   regional ("Regional Balanced PD Capacity"), Hyperdisk, Spot/compromisso e SKUs só de outras
   regiões. **Snapshots** (desativados) saíram da estimativa: entram apenas quando a agenda
   `cenario-homolog-diario` existe, e aí com a regra estrita (só us-east1). O limite de US$ 20 e o
   bloqueio sem preço oficial continuam. Se ainda faltar alguma SKU, `homolog.sh custos
--diagnosticar` lista as candidatas reais (só leitura) — nenhum preço é presumido.
2. **Quatro permissões `storage.buckets.*` apontadas como ausentes.** Falso negativo: o
   `testIamPermissions` do **projeto** só avalia permissões do tipo projeto e nunca devolve as de
   bucket. Agora elas são testadas **no próprio bucket** (`storage/v1/b/<bucket>/iam/testPermissions`).

`configurar` revisado: faz apenas inclusões (ciclo de vida, `objectCreator` da VM, metadados não
secretos e, se faltar, `secretAccessor`), mostra o plano e pede confirmação; não toca firewall,
portas, DNS, VM em execução nem outros projetos; sem `--com-snapshots` não cria snapshots. Se o
bucket já tiver uma regra de ciclo de vida própria, ela **não** é sobrescrita (aviso) e os demais
itens seguem.

## Atualização: falha do primeiro Cloud Build (436c51a7)

**Causa raiz:** o `.gcloudignore` criado nesta preparação tinha o padrão `storage` sem `/`. Nessa
sintaxe (a do `.gitignore`), padrão sem `/` vale em **qualquer nível**: além da pasta de dados
`/storage/`, excluía o código `apps/api/src/core/storage/` (`storage.ts`, `upload.ts`) do envio
ao Cloud Build, e o tsup não encontrou os módulos. Os arquivos sempre estiveram versionados; o
`.gitignore` (ancorado, `/storage/`) e o `.dockerignore` (ancorado por natureza) estavam corretos.

**Correção:** o `.gcloudignore` passou a reaproveitar o `.gitignore` (`#!include:.gitignore`) e
exclui só `.git`, `.github` e caches locais. Novo `infra/homolog/gcp/conferir-contexto.sh` compara,
sem custo, o que o gcloud enviaria (`gcloud meta list-files-for-upload`) com `git ls-files`; o
`operador.sh build` o executa e **recusa o envio** se faltar qualquer arquivo versionado.

**Verificação local (Linux, Docker, contexto idêntico ao enviado):** com o `.gcloudignore` antigo,
os mesmos 3 erros do Cloud Build; com o novo, imagens `api` e `web` construídas (Prisma gerado,
`dist/server.js`, Next.js com 44 páginas), conteúdo conferido. Testes da API exigem PostgreSQL e
não foram executados nesta etapa.

Legenda usada abaixo: **[verificado]** = executado aqui, com evidência · **[informado]** = dado
que você passou, ainda não conferido · **[a auditar]** = será conferido por `homolog.sh auditar`
· **[pendente]** = depende de autorização ou da aplicação rodando.

## 1. Recursos encontrados

Não pude inspecionar o projeto (sem credenciais). O inventário abaixo é o **informado** por você;
o `homolog.sh auditar` (§11, passo 2) confere cada item e lista **tudo** o que gera cobrança.

| Recurso              | Informado                                                                                                                   | O que a auditoria confere                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VM `cenario-homolog` | e2-small, us-east1-b, Debian 12, pd-balanced 20 GB, RUNNING, IP interno 10.50.0.2, Docker 29.9.0, Compose v5.6.0, swap 2 GB | tipo, zona, disco (tamanho/tipo/imagem/apagar-com-a-VM), rede/sub-rede, IPs, etiqueta `cenario-homolog`, conta de serviço, **escopos de acesso**, Shielded VM, OS Login, porta serial, `startup-script`, metadados        |
| IP externo           | 136.108.15.103 estático                                                                                                     | se está **reservado** (estático) e EM USO; descobre o **nome** do recurso pelo endereço; IPs reservados sem uso                                                                                                           |
| Rede                 | VPC `cenario-homolog-vpc`, sub-rede `cenario-homolog-subnet` (us-east1, 10.50.0.0/24)                                       | modo personalizado, **sem peering**, sub-redes, todas as regras de firewall da VPC, rede `default` (se existir)                                                                                                           |
| Firewall             | `cenario-homolog-iap-ssh` (35.235.240.0/20)                                                                                 | só TCP 22, só da faixa do IAP, só na etiqueta; **nenhuma** outra entrada; 80/443 fechadas; sondagem externa de 22/80/443/5432/3000/4000                                                                                   |
| Conta de serviço     | `cenario-homolog-vm@…`                                                                                                      | ativa, **sem chaves privadas**, papéis no projeto (sem Owner/Editor/Storage Admin…), papéis no bucket, acesso em outros projetos                                                                                          |
| Segredos             | 5 (`homolog-*`), `secretAccessor` individual                                                                                | existência, versões ativas, replicação, `secretAccessor` da VM em cada um, ausência de acesso público — **sem ler valores**                                                                                               |
| Bucket               | `gs://cenariogestao-homolog-backups`, us-east1, STANDARD, UBLA, prevenção de acesso público                                 | região, classe, UBLA, PAP, IAM público, ciclo de vida, retenção de exclusão reversível (soft delete), versões, papéis da VM, tamanho                                                                                      |
| Orçamentos           | alertas existentes                                                                                                          | valor, limiares e **escopo** (só este projeto × toda a conta de faturamento)                                                                                                                                              |
| Dentro da VM         | —                                                                                                                           | Debian 12, Docker/Compose, contêineres (devem ser 0), volumes, swap (ativa e no fstab), disco, portas escutando (só 22), portão, systemd, `gcloud`, atualizações automáticas, reinício pendente, escopos vistos de dentro |
| Outros projetos      | VerificaPro                                                                                                                 | lista os projetos visíveis e confirma que a conta da VM **não** tem papel neles (só leitura; nada é alterado)                                                                                                             |

## 2. Recursos ausentes

Conhecidos pelo que foi informado e pelo que os scripts exigem:

| Item                                                                               | Situação               | Quem resolve                                                         |
| ---------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| Ciclo de vida do bucket (30 dias)                                                  | não comprovado         | `homolog.sh configurar` (autorizado)                                 |
| `roles/storage.objectCreator` da VM no bucket                                      | não configurado        | `homolog.sh configurar` (autorizado)                                 |
| Metadados `cenario-*` da VM (configuração não secreta lida pelo `vm.sh`)           | provavelmente ausentes | `homolog.sh configurar` (autorizado)                                 |
| Arquivos em `/opt/cenario`, serviços systemd, atualizações automáticas             | ausentes               | `homolog.sh preparar-vm` (portão fechado, nada iniciado)             |
| Agenda de snapshots (7 dias)                                                       | ausente                | **decisão sua** (custo): `configurar --com-snapshots`                |
| Artifact Registry, Cloud Build, imagens, etiqueta `cenario-tag`                    | ausentes (intencional) | publicação — exige nova autorização                                  |
| Regra de firewall 80/443, registro DNS `teste`                                     | ausentes (intencional) | publicação — exige nova autorização                                  |
| Portão `/etc/cenario/publicacao-autorizada`                                        | ausente (intencional)  | publicação — exige nova autorização                                  |
| Desconhecidos até a auditoria: escopos da VM, OS Login, `gcloud` na VM, nome do IP | [a auditar]            | auditoria aponta; mudanças de escopo exigem parar a VM (sua decisão) |

## 3. Problemas identificados

Divergências entre o plano anterior e a realidade, e falhas encontradas nos scripts:

| #   | Gravidade | Problema                                                                                                                                                                                                                                                                        |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Alta**  | `etapa1-infra.sh` assumia a rede `default` (criaria regras de firewall nela e procuraria sub-rede `default`), um IP chamado `cenario-homolog-ip` e uma regra de bloqueio própria. O `criar` tentaria recriar recursos; o `encerrar` apagaria tudo. Incompatível com a VPC real. |
| P2  | **Alta**  | `startup.sh` reiniciava `cenario-homolog.service` sempre que `vm.sh` existisse — copiar os arquivos para a VM **iniciaria PostgreSQL, migrations e a aplicação**. Não havia portão de publicação.                                                                               |
| P3  | **Alta**  | `operador.sh senhas` imprimia a senha do proxy e a do gestor em sequência, sem checar terminal: iriam para logs, `tee`, gravações de sessão.                                                                                                                                    |
| P4  | Média     | Envio dos backups com `gcloud storage cp --if-generation-match=0`: não está garantido que o comando não faça leituras/listagens (que a conta da VM não terá); e o arquivo era registrado como "enviado" mesmo sem conferir o resultado de cada envio.                           |
| P5  | Média     | `startup.sh` só reconhecia swap chamada `/swapfile`: com a swap atual tendo outro nome, criaria **uma segunda** swap de 2 GB e outra linha no fstab.                                                                                                                            |
| P6  | Média     | Se a VM foi criada com os **escopos padrão** (comum ao escolher uma conta de serviço pelo `gcloud` sem `--scopes`), o Secret Manager e a gravação no bucket serão negados mesmo com o IAM correto. Precisa ser auditado; a correção exige parar a VM.                           |
| P7  | Baixa     | Configuração não secreta (`cenario-project`, `cenario-bucket`…) era colocada na criação da VM pelo script antigo; na VM criada manualmente provavelmente não existe.                                                                                                            |
| P8  | Baixa     | `operador.sh build` enviaria todo o diretório ao Cloud Build (sem `.gcloudignore`), inclusive `node_modules` locais, e cria um bucket `PROJETO_cloudbuild` (custo pequeno, mas é um recurso a mais).                                                                            |
| P9  | Baixa     | Atualizações automáticas de segurança não eram configuradas pelos scripts.                                                                                                                                                                                                      |

Verificados como **compatíveis** (sem mudança): caminhos (`/opt/cenario/infra/homolog/...`, `../../scripts` montado no contêiner de backup), imagens (`postgres:16-alpine`, `postgres:16` para `pg_dump` da mesma versão, `caddy:2.10-alpine`, Node 22 no Dockerfile), variáveis do Compose, PostgreSQL 16 sem porta publicada, WebSocket (`/api/realtime` passa pelo `reverse_proxy` do Caddy com o cookie de acesso), volumes persistentes (`pgdata`, `storage`, `backups`, `caddy_data`), Secret Manager (5 nomes iguais aos informados), backup local (14 dias), HTTPS automático do Caddy, reinício automático (`restart: unless-stopped`), restauração de teste em banco separado e atualização com reversão por etiqueta (`vm.sh atualizar`).

## 4. Correções realizadas no repositório

Commit `f4f32fd`:

- **Novo `infra/homolog/gcp/homolog.sh`** (Cloud Shell, um comando por etapa): `auditar` (só leitura, §1), `custos`, `configurar` (só o que falta e está autorizado; mostra o plano; exige digitar `configurar cenariogestao`; relê o estado real no fim), `preparar-vm` (exige commit limpo e portão fechado; exige digitar `preparar cenario-homolog`), `testar-config`, `relatorio`, `tudo` (para na primeira falha), `plano-publicacao` e `plano-encerramento` (só imprimem). Todos os comandos usam `--project=cenariogestao`; nenhum cria VM, rede, firewall, IP, Artifact Registry, Cloud Build ou DNS; nenhum apaga; nenhum lê segredos. Registros em `~/cenario-homolog-relatorios/` (permissão 600).
- **Novo `vm-inspecao.sh`**: inspeção somente leitura dentro da VM, enviada por IAP (`bash -s`).
- **`vm.sh`**: portão de publicação (`/etc/cenario/publicacao-autorizada`) em `gerar-env` e `iniciar` (sem ele, sai com código 3 sem tocar Docker nem Secret Manager); envio dos backups pela **API JSON do Cloud Storage** com o token da VM num arquivo 600 (fora dos argumentos), `ifGenerationMatch=0` (nunca sobrescreve), 200 = enviado, 412 = já estava, qualquer outro código **não** é registrado e o comando termina com erro; objetos em `backups/`. Novo `verificar-preparo` (não inicia nada; §8).
- **`startup.sh`**: aceita **qualquer** swap ativa ou declarada no fstab; ativa `unattended-upgrades` (sem reinício automático); serviços systemd com `ConditionPathExists` do portão; só reinicia a pilha se o portão existir. Docker existente é mantido. Não é instalado como `startup-script` (roda só quando você executa `preparar-vm`).
- **`operador.sh`**: `senhas` removido. `mostrar-credencial proxy|gestor` exibe **uma** credencial só em terminal interativo (recusa pipe/arquivo), pede confirmação e, após Enter, limpa a tela e o histórico de rolagem. `enviar-pacote` → `homolog.sh preparar-vm`. Novo `trazer-backup` (sua conta lê o bucket e copia para a VM, para o teste de restauração).
- **`lifecycle-30d.json`**: apaga tudo aos 30 dias e os objetos de teste (`testes-preparo/`) aos 1 dia.
- **`.gcloudignore`**: limita o que o Cloud Build receberia (só na publicação).
- **`etapa1-infra.sh` e seu teste: retirados** (P1). O cálculo de preços (`precos_catalogo.py`) foi mantido e agora é chamado por `homolog.sh custos`.
- Documentos anteriores (`PLANO`, `PREPARACAO`, `ETAPA1`) receberam aviso apontando para este relatório.

## 5. Segurança e permissões

**Permissões da conta da VM (mínimas):**

| Onde              | Papel                                    | Permite                                      | Situação            |
| ----------------- | ---------------------------------------- | -------------------------------------------- | ------------------- |
| Cada segredo (×5) | `secretmanager.secretAccessor`           | ler só aquele segredo                        | [informado]         |
| Bucket de backups | `storage.objectCreator`                  | só **criar** objetos (sem ler/listar/apagar) | `configurar`        |
| Projeto           | nenhum                                   | —                                            | [a auditar]         |
| Artifact Registry | `artifactregistry.reader` no repositório | baixar as imagens                            | publicação (futuro) |

Proibidos e verificados pela auditoria: Owner, Editor, Storage Admin/Object Admin/Object Viewer/Object User, papéis legados do bucket, Secret Manager Admin, Compute Admin, papéis de IAM/Resource Manager. Nenhum é removido automaticamente: se aparecer, o `configurar` **recusa** e pede ajuste manual. Não foi adicionado `logging.logWriter` (os logs dos contêineres ficam na VM, com rotação de 3×10 MB).

| Requisito                            | Situação                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Firewall mínimo, sem 80/443          | [a auditar] regra única do IAP; a auditoria falha se houver outra entrada ou 80/443                                                          |
| SSH só por IAP                       | [a auditar] + sondagem externa da porta 22 (deve estar fechada)                                                                              |
| IAM mínimo, sem chaves privadas      | [a auditar]                                                                                                                                  |
| Segredos fora do Git, nunca exibidos | [verificado] nenhum script exibe valor; teste confirma que `verificar-preparo` não imprime o valor; `mostrar-credencial` só em terminal      |
| Contêineres                          | [verificado] limites de memória, rede interna própria, logs com rotação; [a auditar] nenhum contêiner rodando agora                          |
| PostgreSQL sem porta pública         | [verificado] Compose publica só 80/443 (caddy); `verificar-preparo` confere isso na VM                                                       |
| Arquivos privados                    | [verificado] `/run/cenario/env` 600 em memória; token de upload em arquivo 600; registros do Cloud Shell 600                                 |
| Cookies                              | [verificado em etapa anterior] cookie de acesso `Secure; HttpOnly; SameSite=Lax`; cookies da aplicação `COOKIE_SECURE=true`                  |
| Proteção adicional (Caddy)           | [verificado em etapa anterior] senha do proxy antes de qualquer página; cookie só após a senha                                               |
| WebSocket autenticado                | [verificado em etapa anterior] passa pelo mesmo cookie do proxy + sessão da aplicação; [pendente] repetir na nuvem                           |
| Logs sem senhas                      | Caddy omite por padrão `Authorization`/`Cookie` nos logs; o cookie do `saude` vai em arquivo, não em argumento; [pendente] conferir na nuvem |
| Atualizações de segurança            | `preparar-vm` ativa `unattended-upgrades`; [a auditar] estado atual                                                                          |
| Recuperação após reinício            | [verificado em teste] serviços instalados e condicionados ao portão; [pendente] reinício real após publicar                                  |
| Nenhum dado real                     | [verificado] só dados fictícios; e-mail do gestor em domínio de teste                                                                        |

**Credenciais de teste sem cair em logs:** no Cloud Shell, `bash infra/homolog/gcp/operador.sh mostrar-credencial proxy` (e depois `gestor`). Só funciona em terminal interativo; não use dentro de `script`, `tee` ou gravação de tela; anote num gerenciador de senhas; tecle Enter para apagar a tela. Nenhuma etapa automatizada exibe credenciais.

**Decisões suas apontadas pela auditoria (nada é mudado automaticamente):** escopos da VM (se não forem `cloud-platform`, trocar exige parar a VM ~2 min — comandos em `plano-publicacao`); OS Login (recomendado; ativar pode mudar sua forma atual de entrar por SSH).

## 6. Backup e restauração

| Camada          | O quê                                   | Retenção                                                                | Situação                                                |
| --------------- | --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| Local (VM)      | `pg_dump` + arquivos, `SHA256SUMS`      | 14 dias (`BACKUP_RETENTION_DAYS=14`)                                    | pronto; roda só depois da publicação                    |
| Bucket privado  | `backups/<pasta>.tar`, diário 07:30 UTC | apagados aos 30 dias (+ 7 dias de exclusão reversível padrão do bucket) | `configurar` aplica o ciclo de vida e o `objectCreator` |
| Snapshots disco | disco inteiro, diário 06:00 UTC         | 7 dias, só em us-east1                                                  | **opcional, custo extra** — só com `--com-snapshots`    |

A conta da VM **só cria** objetos: não lê, não lista, não apaga e não sobrescreve. Um invasor na VM não consegue apagar os backups do bucket. A leitura (restauração) é feita pela **sua** conta: `operador.sh trazer-backup <pasta>` baixa o arquivo, copia para a VM e confere o `SHA256SUMS`.

**Testes de backup/restauração para a etapa autorizada (dados fictícios), em ordem:**

1. `vm.sh semear` e o roteiro E2E criam dados fictícios.
2. `vm.sh backup` → pasta nova local + envio ao bucket (`✔ … enviado`).
3. `homolog.sh testar-config` já terá provado: gravar ✔, regravar 412, ler/listar/apagar 403.
4. `operador.sh trazer-backup <pasta>` → `✔ backup copiado e íntegro`.
5. `vm.sh restaurar-teste <pasta>` → restaura num banco **separado** e compara contagens (usuários, clientes, OS, tarefas, auditoria, eventos, arquivos, migrations); o banco temporário é apagado.
6. (opcional) restauração completa `vm.sh restaurar <pasta> --sim` (faz backup de segurança antes).

## 7. Custos estimados

Preços de lista em US$, sem tributos. O valor oficial é recalculado por `homolog.sh custos` (catálogo do Cloud Billing; nunca presume preço). **Sua última consulta oficial** (comando `verificar` anterior, no Cloud Shell) deu **US$ 19,29/mês\*\* para VM + disco + IP + ~10 GB de snapshots.

| Situação                | Item                                                                                                                           | Referência de lista                | US$/mês                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------- |
| existente               | VM e2-small (730 h; E2 não tem desconto por uso contínuo)                                                                      | vCPU + 2 GiB, us-east1             | ≈ 12,2                 |
| existente               | Disco pd-balanced 20 GB                                                                                                        | ≈ 0,10/GB                          | ≈ 2,0                  |
| existente               | IPv4 estático em uso                                                                                                           | 0,005/h (**0,01/h se a VM parar**) | ≈ 3,65                 |
| existente               | Bucket (≈1–2 GB de backups, Standard us-east1)                                                                                 | ≈ 0,02/GB + operações              | 0,02–0,05              |
| existente               | Secret Manager (5 versões ativas; 6 gratuitas)                                                                                 | 0,06/versão acima da cota          | 0,00                   |
| existente               | IAP, VPC, firewall, conta de serviço, Logging (50 GiB grátis)                                                                  | —                                  | 0,00                   |
| **adicional (decisão)** | Snapshots 7 dias (incrementais, ≈10–15 GB)                                                                                     | ≈ 0,05/GB regional                 | ≈ 0,50–0,75            |
| adicional (publicação)  | Artifact Registry (0,5 GB grátis)                                                                                              | 0,10/GB acima                      | 0,00–0,15              |
| adicional (publicação)  | Cloud Build (2.500 min/mês grátis, e2-standard-2)                                                                              | —                                  | 0,00                   |
| variável                | Saída de dados à internet (1 GB/mês grátis da América do Norte)                                                                | ≈ 0,12–0,19/GB conforme destino    | 0,00–0,60              |
| tributos/câmbio         | IOF de 3,5% em cartão internacional; variação do dólar; se faturado pela Google Cloud Brasil em reais, tributos locais na nota | —                                  | +3,5% ou conforme nota |

**Leitura:** base informada 19,29 (já com snapshots) + variáveis ≤ ~0,8 → **≈ 19,3–20,1 sem tributos**; com IOF, ≈ 20,0–20,8. **Fica no limite de US$ 20, sem margem.** O orçamento só avisa; não impede cobranças.

**Alternativas (nada é contratado nem redimensionado sem sua decisão):**

1. **Não ativar snapshots agora** (recomendado): economiza ≈ 0,5–1,0/mês; os dados ficam protegidos pelos backups local (14 d) e no bucket (30 d); a VM é reproduzível pelos scripts. Base ≈ 18,3–18,8 + variáveis.
2. Limpar imagens antigas do Artifact Registry (manter 2 versões) para ficar na cota gratuita.
3. Parar a VM em períodos longos sem testes: economiza a VM (~0,017/h), mas o IP passa a 0,01/h; ganho líquido ≈ 0,012/h (≈ 8,6/mês se ficasse o mês todo parada).
4. Ao encerrar, **liberar o IP** (parado ele custa ≈ 7,30/mês) — §13.

## 8. Testes executados

Todos executados neste ambiente, sem Google Cloud, com resultado conferido:

| Teste                                                                                           | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------ |
| ShellCheck 0.11.0 (`-S warning`) em `infra/homolog/gcp/*.sh`, testes, `backup.sh`, `restore.sh` | **sem avisos**. Restam só notas informativas SC2015 (`a && ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |     | falha`, seguro porque `ok`/`falha` sempre retornam 0) e uma SC2016 intencional |
| `bash -n` em todos os scripts                                                                   | OK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ruff check --select F` (pyflakes) nos Python                                                   | OK; todos os subcomandos e opções do `gcloud` usados conferidos com `gcloud … --help` (SDK local)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test_precos_catalogo.py` (pytest)                                                              | **20 passaram**, 18 subtestes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test_homolog_sh.sh` — 20 cenários, 135 verificações                                            | **todos OK**: auditoria só lê e acha as 3 pendências reais; acusa escopos padrão, firewall aberto, 2ª VM, disco órfão, papel amplo no bucket, VM inacessível; `configurar` cancela com confirmação errada, faz **exatamente 3 escritas**, confere e é **idempotente**; snapshots só com a opção; recusa com `objectAdmin`; `preparar-vm` recusa sem confirmação, com portão aberto e com mudança não commitada; script remoto executado numa raiz temporária guarda a versão anterior e o conteúdo pré-existente e aborta com portão aberto; `custos` 0/3/2; `tudo` para na 1ª falha; planos sem chamar o gcloud; `mostrar-credencial` recusa fora de terminal e limpa a tela em terminal real; **nenhum comando proibido** em nenhum cenário |
| `test_vm_sh.sh` — 14 cenários, 63 verificações                                                  | **todos OK**: envio com só-criação (200), sem reenvio, 412 = já enviado, 403 não registrado e erro, checksum inválido recusado, token nunca exposto; portão bloqueia `gerar-env`/`iniciar` sem chamar Docker/Secret Manager; `verificar-preparo` (Compose válido, só 80/443, segredos sem valor exibido, gravar ✔ / regravar 412 / ler-listar-apagar 403); `startup.sh` mantém swap, só ativa a do fstab, cria uma única vez, idempotente, não inicia sem portão e reinicia com ele                                                                                                                                                                                                                                                          |
| `docker compose config` com valores fictícios                                                   | OK; portas publicadas: `80 443`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cloudbuild.yaml` e `lifecycle-30d.json`                                                        | YAML/JSON válidos (não executados)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Prettier nos documentos e JSON alterados (inclusive este)                                       | OK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `git fsck`                                                                                      | sem erros (só um blob solto, normal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 9. Testes pendentes

Dependem de você no Cloud Shell (estado real) — **não declarados aprovados**:

- `homolog.sh auditar` (inventário real, IAM, firewall, sondagem externa, inspeção da VM).
- `homolog.sh configurar` e sua confirmação por releitura; `homolog.sh testar-config` (inclui o teste **real** de permissões do bucket com um objeto fictício em `testes-preparo/`).

Dependem da aplicação rodando (após autorização de publicação):

- HTTPS/Let's Encrypt, proxy (401 sem senha), cookie, WebSocket pela internet, `vm.sh saude`.
- Roteiro E2E (`tests/e2e/homolog`) contra `teste.cenariogestao.com.br`, inclusive no iPhone.
- Backup → bucket → `trazer-backup` → `restaurar-teste` (§6).
- Reinício da VM com a pilha voltando sozinha; atualização e reversão por etiqueta; consumo de memória real (referência local: pico de 506 MiB nos contêineres).
- Conferência dos logs (Caddy, API) sem senhas/cookies.

## 10. Riscos conhecidos

| Risco                                                                                                      | Mitigação                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Escopos da VM sem `cloud-platform`                                                                         | auditoria acusa; correção exige parar a VM (decisão sua)                              |
| Custo no limite de US$ 20 (sem margem; IOF/câmbio por fora)                                                | sem snapshots; limpeza de imagens; alertas do orçamento                               |
| `gcloud compute ssh` pode registrar uma chave SSH nos metadados do projeto se o OS Login estiver desligado | auditoria mostra; recomendação de OS Login                                            |
| e2-small (2 GB) no limite com a pilha + swap                                                               | limites por contêiner; swap; `saude` checa memória                                    |
| Exclusão reversível do bucket (7 dias) mantém objetos apagados cobrando por mais 7 dias                    | valor irrisório; pode ser desligada se preferir                                       |
| Imagens públicas (Docker Hub) com limite de downloads                                                      | poucas imagens, baixadas uma vez                                                      |
| Hostinger DNS: propagação/erro no registro A                                                               | TTL 300; conferir antes de liberar 80/443                                             |
| Instruções desta auditoria escritas sem acesso ao projeto                                                  | tudo é conferido pela auditoria antes de qualquer escrita; escritas pedem confirmação |

## 11. Comandos necessários no Cloud Shell

Abra o Cloud Shell no projeto `cenariogestao` e execute, um passo por vez:

```bash
# 1. Código no commit preparado (repositório privado: o git pede seu usuário do GitHub e um token pessoal)
git clone https://github.com/phaelnader-svg/Cen-rio-app.git && cd Cen-rio-app   # (ou: git pull)
git checkout claude/cenario-gestao-fase-1-zf3bj2 && git pull
git log --oneline -1

# 2. Auditoria (só leitura) — envie-me o resumo final e as linhas ✘ / ? se houver
bash infra/homolog/gcp/homolog.sh auditar

# 3. Custos com preços oficiais
bash infra/homolog/gcp/homolog.sh custos

# 4. Configurar só o que falta (mostra o plano; digite: configurar cenariogestao)
bash infra/homolog/gcp/homolog.sh configurar
#    snapshots SÓ se você aprovar o custo:  ... configurar --com-snapshots

# 5. Preparar a VM (portão fechado; digite: preparar cenario-homolog)
bash infra/homolog/gcp/homolog.sh preparar-vm

# 6. Testar tudo sem iniciar nada
bash infra/homolog/gcp/homolog.sh testar-config

# 7. Relatório final das etapas
bash infra/homolog/gcp/homolog.sh relatorio
```

Ou os passos 2–7 de uma vez, parando na primeira falha: `bash infra/homolog/gcp/homolog.sh tudo`.
Os registros ficam em `~/cenario-homolog-relatorios/` (sem segredos; o `relatorio` confere).
Se algo falhar, **nada mais é executado**; o estado fica como estava antes daquela etapa (cada escrita é aditiva e conferida).

## 12. Plano de rollback

| O que foi feito         | Como desfazer                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ciclo de vida do bucket | `gcloud storage buckets update gs://cenariogestao-homolog-backups --clear-lifecycle --project=cenariogestao`                                                                                                                      |
| `objectCreator` da VM   | `gcloud storage buckets remove-iam-policy-binding gs://cenariogestao-homolog-backups --member=serviceAccount:cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com --role=roles/storage.objectCreator --project=cenariogestao` |
| Metadados `cenario-*`   | `gcloud compute instances remove-metadata cenario-homolog --zone=us-east1-b --project=cenariogestao --keys=cenario-project,cenario-region,cenario-repo,cenario-domain,cenario-bucket,cenario-basic-user,cenario-admin-email`      |
| Snapshots (se ativados) | `gcloud compute disks remove-resource-policies <disco> --zone=us-east1-b --resource-policies=cenario-homolog-diario --project=cenariogestao` e `resource-policies delete`                                                         |
| Arquivos na VM          | versão anterior em `/opt/cenario.anterior-<data>`: `sudo mv -T /opt/cenario /opt/cenario.descartada && sudo mv -T /opt/cenario.anterior-<data> /opt/cenario`                                                                      |
| Serviços systemd        | `sudo systemctl disable --now cenario-homolog.service cenario-backup-upload.timer` (não fazem nada com o portão fechado)                                                                                                          |
| Publicação (futura)     | `homolog.sh plano-publicacao` → bloco "Despublicar" (para a pilha, fecha o portão, remove a regra 80/443; dados preservados)                                                                                                      |

## 13. Plano de encerramento para evitar cobranças

`bash infra/homolog/gcp/homolog.sh plano-encerramento` **só imprime** a sequência. Resumo:

- **Pausar:** parar a VM — deixa de cobrar a VM; disco (≈2/mês) e IP (≈7,30/mês parado) continuam.
- **Encerrar:** baixar os backups → apagar a VM (o disco vai junto se "apagar com a VM" = true, a auditoria mostra) → conferir discos órfãos → **liberar o IP** → apagar snapshots/agenda → bucket → segredos → conta de serviço → regras de firewall → sub-rede e VPC → (se publicados) Artifact Registry e bucket do Cloud Build → registro DNS na Hostinger.
- Conferir em Faturamento → Relatórios (filtro: projeto `cenariogestao`) por 2–3 dias.
- Nada disso toca o VerificaPro: todos os comandos levam `--project=cenariogestao`.

## 14. Checklist Go/No-Go

Para **autorizar a publicação**, todos devem estar ✔:

- [ ] `auditar` sem ✘ (inclui: uma única VM, sem disco/IP órfão, só a regra do IAP, 80/443 fechadas, sondagem externa fechada, conta da VM sem papéis amplos e sem chaves, sem acesso a outros projetos, nenhum contêiner rodando)
- [ ] Escopos da VM = `cloud-platform`
- [ ] `configurar` concluído e idempotente (segunda execução: "Nada a configurar")
- [ ] `custos` dentro do limite **e** decisão sobre snapshots registrada
- [ ] `preparar-vm` OK com o commit aprovado
- [ ] `testar-config` OK (bucket: gravar ✔, regravar 412, ler/listar/apagar 403; segredos acessíveis; Compose válido; só porta 22 escutando)
- [ ] Decisão sobre OS Login
- [ ] Autorização explícita para: Artifact Registry + Cloud Build, regra 80/443, registro DNS, abertura do portão (PostgreSQL, migrations, aplicação)

**Situação atual: NO-GO** para publicação — os itens acima ainda não foram executados no projeto real. **GO** para você executar os passos 1–7 da §11 (todos dentro da autorização atual).

## 15. Próxima etapa recomendada

1. Você executa a §11 no Cloud Shell (sem snapshots, salvo decisão em contrário) e me envia os resumos de `auditar`, `custos` e `testar-config` (eles não contêm segredos).
2. Eu analiso e corrijo o que aparecer, sem publicar.
3. Com o checklist da §14 completo, você decide sobre a publicação. Só então: Artifact Registry + build, DNS na Hostinger, regra 80/443, portão, `semear`, `saude`, E2E e o teste de backup/restauração da §6 — seguindo `homolog.sh plano-publicacao`.

**Nenhuma implantação será feita sem a sua autorização explícita.**
