# Homologação no Google Cloud — plano técnico (aguardando autorização)

> **Atualização:** decisões tomadas (e2-small em us-east1, autenticação adicional no proxy) e
> preparação concluída em [`HOMOLOGACAO-GCP-PREPARACAO.md`](HOMOLOGACAO-GCP-PREPARACAO.md), que
> prevalece sobre este plano nos comandos, segredos e custos.

> **Nada foi criado no Google Cloud.** Nenhum serviço foi habilitado, nenhum deploy foi feito,
> nenhum DNS foi alterado e nenhuma migration rodou fora do ambiente local. Este documento é o
> plano para sua decisão. Base: commit `9082d5d` da branch `claude/cenario-gestao-fase-1-zf3bj2`.
>
> Projeto: `cenariogestao` · Domínio: `cenariogestao.com.br` · Endereço de homologação:
> `teste.cenariogestao.com.br`.

## 1. Resumo da recomendação

> **Atualização (pré-implantação):** a infraestrutura foi criada manualmente, numa VPC exclusiva
> (`cenario-homolog-vpc`), não na rede `default`. O `etapa1-infra.sh` foi **retirado** (o `criar` e o
> `encerrar` dele não correspondem aos recursos reais). A preparação agora é feita pelo
> `infra/homolog/gcp/homolog.sh` — ver [`HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md`](HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md).

| Opção                                                                    | Custo mensal estimado (US$, sem impostos)    | Mudanças no código                                               | Recomendação                       |
| ------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| **A. VM e2-small + Docker Compose** (pilha `infra/homolog` já existente) | **≈ 19–20 (us-east1)** · ≈ 27–29 (São Paulo) | Mínimas (arquivos de implantação)                                | **Recomendada**                    |
| B. Cloud Run + Cloud SQL                                                 | ≈ 57–65                                      | Sim (armazenamento de arquivos, migrations, ajustes de execução) | Não para homologação               |
| C. VM e2-micro (nível gratuito)                                          | ≈ 4–5                                        | Mínimas                                                          | Não: memória insuficiente (medida) |

A opção A reaproveita exatamente a pilha que já foi verificada localmente na Fase 12 (contêineres
da API e da web, PostgreSQL 16, Caddy com HTTPS, backup diário com `pg_dump` 16 e restauração
conferida), tem o menor custo compatível com a memória medida e não exige mudanças no sistema.

## 2. O que existe no repositório (inspecionado)

- `infra/homolog/Dockerfile` — imagens `api` e `web` (Node 22, usuário sem privilégios; a API
  aplica as migrations ao iniciar e tem healthcheck em `/api/ready`).
- `infra/homolog/docker-compose.homolog.yml` — `postgres:16-alpine` sem porta publicada, `api`,
  `web`, `caddy:2-alpine` (portas 80/443) e `backup` (`postgres:16`, diário, 14 dias), volumes
  `pgdata`, `storage`, `backups`, `caddy_data`.
- `infra/homolog/Caddyfile.homolog` — HTTPS automático (Let's Encrypt), `/api/*` (inclusive o
  WebSocket) para a API, o resto para a web, HSTS, `X-Robots-Tag: noindex`, limite de 10 MB.
- `infra/homolog/env.homolog.example` — variáveis sem segredos; `.env.homolog` ignorado no Git e no
  Docker.
- `scripts/backup.sh` / `restore.sh` (checksum SHA-256, restauração em transação única),
  `scripts/homolog-dados-sinteticos.mjs`, `docs/HOMOLOGACAO.md`, `docs/OPERACAO.md`.
- A API recusa iniciar em `APP_ENV=staging` sem HTTPS nas origens, `COOKIE_SECURE=true` e
  `NODE_ENV=production`.

**Ainda não verificado:** a linha `apt-get install openssl ca-certificates` do Dockerfile (a
política de rede do ambiente de desenvolvimento bloqueou o repositório Debian; o restante foi
verificado com uma variante). O primeiro build no Cloud Build vai executá-la de fato.

## 3. Cloud Run é adequado? (análise do código, sem presumir)

| Requisito do sistema (no código)                                                                                                                                                                       | Cloud Run                                                                                                                                                                       | Veredito                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket `/api/realtime` com reconexão e retomada pela sequência (`apps/web/lib/realtime.tsx`)                                                                                                        | Suportado, mas a conexão é uma requisição sujeita ao tempo limite (máx. 60 min): cai e reconecta pelo menos a cada hora                                                         | Compatível (o cliente já reconecta e recupera eventos — testado)                                                                              |
| Hub de tempo real alimentado pelo banco (`LISTEN cenario_domain_events` + varredura a cada 2 s, `core/events/feed.ts`)                                                                                 | Precisa de CPU contínua e conexão persistente ao banco                                                                                                                          | Só com CPU sempre alocada                                                                                                                     |
| Tarefas em segundo plano por `setInterval` (`apps/api/src/app.ts`): processador de eventos, liberação de tarefas (30 s), ausência presumida (60 s), fila de ajuda e prazos (30 s), manutenção (15 min) | Por padrão a CPU é limitada fora de requisições e as instâncias podem ir a zero → as rotinas param                                                                              | **Só com faturamento por instância (CPU sempre alocada) e no mínimo 1 instância sempre ligada**                                               |
| Várias instâncias                                                                                                                                                                                      | Processador com `FOR UPDATE SKIP LOCKED` e manutenção com advisory lock são seguros; as demais rotinas são idempotentes, mas o limite de requisições é em memória por instância | Manter **1 instância** (mín. = máx. = 1)                                                                                                      |
| Arquivos privados (fotos, comprovantes) em disco local (`core/storage/storage.ts`, `LocalFileStorage`)                                                                                                 | Sistema de arquivos efêmero: **os arquivos se perdem** ao reiniciar a instância                                                                                                 | **Incompatível sem mudança**: montar Cloud Storage (FUSE) ou escrever um adaptador para Cloud Storage — ambos exigem desenvolvimento e testes |
| Migrations ao iniciar a API (`CMD pnpm db:migrate && …`)                                                                                                                                               | Cada nova revisão/instância rodaria migrations; o recomendado é um Cloud Run Job separado                                                                                       | Exige ajuste                                                                                                                                  |
| Domínio próprio                                                                                                                                                                                        | Mapeamento de domínio só em algumas regiões (não inclui `southamerica-east1`); fora delas, balanceador de carga pago                                                            | Usar região dos EUA ou pagar o balanceador                                                                                                    |
| PostgreSQL 16                                                                                                                                                                                          | Cloud SQL (menor instância compartilhada, sem SLA)                                                                                                                              | Funciona, com custo à parte                                                                                                                   |

**Conclusão:** o Cloud Run **funciona** para este sistema apenas com CPU sempre alocada, uma
instância fixa, armazenamento de arquivos reescrito para Cloud Storage e migrations separadas.
Isso custa ~3× a opção A e exige mudanças de código antes da homologação. Fica como evolução
possível para a produção, não para agora.

## 4. Arquitetura recomendada (opção A)

```
iPhone / tablets / painel ──HTTPS 443──▶ IP fixo ──▶ VM e2-small (Debian 12, Docker)
                                                     ├─ caddy  :80/:443  (Let's Encrypt, noindex)
                                                     │    ├─ /api/* e WebSocket ─▶ api :4000 (rede interna)
                                                     │    └─ resto ─────────────▶ web :3000 (rede interna)
                                                     ├─ postgres:16 (sem porta exposta, disco persistente)
                                                     ├─ backup (postgres:16): pg_dump + arquivos, diário
                                                     └─ envio diário dos backups ─▶ bucket privado (Cloud Storage)
Imagens: Cloud Build ─▶ Artifact Registry (privado) ─▶ VM
Segredos: Secret Manager ─▶ arquivo de variáveis em memória (/run) na partida da VM
Acesso administrativo: SSH só via IAP (sem porta 22 aberta à internet), OS Login
```

### 4.1 Frontend Next.js

Contêiner `web` (build de produção, `API_INTERNAL_URL=http://api:4000` gravado no build), atrás do
Caddy. Ajuste recomendado: iniciar com `node` direto no `next start` em vez de `pnpm --filter …`
(o processo `pnpm` extra ocupou 86 MB na medição).

### 4.2 API Fastify e WebSocket

Contêiner `api` com as rotinas em segundo plano funcionando continuamente (VM sempre ligada),
`APP_ENV=staging`, `COOKIE_SECURE=true`, `TRUST_PROXY` da rede interna do Docker,
`ALLOWED_ORIGINS=https://teste.cenariogestao.com.br`. O WebSocket passa pelo Caddy sem tempo
limite de 60 min.

### 4.3 PostgreSQL 16 isolado

Contêiner `postgres:16-alpine` exclusivo da homologação, volume no disco persistente da VM, sem
porta publicada (nem na VM, nem na internet). Ajustes para 2 GB de RAM: `shared_buffers=128MB`,
`max_connections=40`, `work_mem=4MB`. Nenhum dado real; nada compartilhado com produção.

### 4.4 Armazenamento privado de arquivos

Volume `storage` no disco persistente da VM (o mesmo `LocalFileStorage` já testado, sem mudança de
código), servido só pela API com verificação de permissão. Cópia diária (dentro do backup) para o
bucket privado.

### 4.5 HTTPS e domínio

- Registro **A** `teste.cenariogestao.com.br` → IP fixo da VM (TTL 300). **Você** altera o DNS no
  provedor do domínio, quando autorizar; se houver registro CAA, ele precisa permitir
  `letsencrypt.org`.
- Caddy obtém e renova o certificado sozinho (porta 80 aberta para o desafio HTTP).
- HSTS só no subdomínio de teste (sem `includeSubDomains`, para não afetar o domínio principal).

### 4.6 Segredos e credenciais

| Segredo               | Onde fica                                                                                    | Como chega à VM                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`   | Secret Manager (`homolog-postgres-password`)                                                 | Lido na partida por um serviço systemd e gravado em `/run/cenario/env` (memória, permissão 600) |
| `TOKEN_HASH_SECRET`   | Secret Manager (`homolog-token-hash-secret`)                                                 | idem                                                                                            |
| `SEED_ADMIN_PASSWORD` | Secret Manager (`homolog-admin-password`) — usado uma vez no seed; trocar no primeiro acesso | idem                                                                                            |

- Conta de serviço própria da VM (`cenario-homolog-vm`), **sem** a conta padrão do Compute e sem
  escopos amplos. Papéis mínimos: leitor do Artifact Registry no repositório; acesso só aos 3
  segredos; **somente criar objetos** no bucket de backup (não lê nem apaga — um invasor na VM
  não consegue destruir os backups); gravação de logs e métricas.
- Seu usuário administra; nenhuma chave JSON de conta de serviço é gerada.
- Segredos de homologação **nunca** reutilizados na produção.

### 4.7 Backups (três camadas)

1. **Aplicação (já existente):** contêiner `backup` grava diariamente banco (`pg_dump` 16, formato
   custom, verificado) + arquivos + SHA-256 no disco, 14 dias.
2. **Fora da VM:** envio diário dessas pastas para o bucket `cenariogestao-homolog-backups`
   (mesma região, classe Standard, acesso uniforme, bloqueio de acesso público, regra de ciclo de
   vida apagando após 30 dias).
3. **Disco:** agenda de snapshots diários do disco da VM com retenção de 7 dias (recuperação da
   máquina inteira).

Teste de restauração obrigatório antes de liberar a homologação (procedimento em `OPERACAO.md`,
num banco separado dentro da própria VM).

## 5. Custos estimados mensais

Valores de referência em US$, **sem impostos** (a fatura no Brasil vem em reais, com tributos e
conversão), 730 h/mês. Fontes secundárias divergem em alguns itens: **confirme na Calculadora de
Preços do Google Cloud** antes de autorizar.

### Opção A — região us-east1 (Carolina do Sul)

| Item                                                        | Estimativa  |
| ----------------------------------------------------------- | ----------- |
| VM e2-small (2 vCPU compartilhadas, 2 GB)                   | ≈ 12,2      |
| Disco pd-balanced 20 GB                                     | ≈ 2,0       |
| IP externo fixo em uso                                      | ≈ 3,65      |
| Snapshots diários (7 dias, incrementais)                    | ≈ 0,3–0,5   |
| Cloud Storage (backups ≤ 5 GB — nível gratuito em us-east1) | ≈ 0–0,2     |
| Artifact Registry (~3 GB, 0,5 GB grátis)                    | ≈ 0,25      |
| Cloud Build (até 2.500 min/mês grátis)                      | 0           |
| Secret Manager (3 versões ativas; 6 grátis)                 | 0           |
| Saída de dados (homologação, poucos GB)                     | ≈ 0,5       |
| Logs (dentro da cota gratuita)                              | 0           |
| **Total**                                                   | **≈ 19–20** |

### Opção A — região southamerica-east1 (São Paulo)

VM ≈ 19,4 + disco ≈ 3 + IP 3,65 + bucket e snapshots ≈ 1 + demais ≈ 1 → **≈ 27–29**. Ganho:
latência menor para a oficina (~20 ms contra ~120–150 ms em us-east1). Para homologação com
poucas pessoas, us-east1 atende; para **produção**, São Paulo é a escolha natural.

### Opção B — Cloud Run + Cloud SQL (us-east1)

API com 1 vCPU / 512 MiB sempre alocada (≈ 43 após a cota gratuita de vCPU) + web por requisição
(≈ 0–2) + Cloud SQL db-f1-micro (≈ 8–11) + armazenamento do banco e backups (≈ 2–3) + Cloud
Storage para arquivos (≈ 0–1) → **≈ 57–65**, sem contar o desenvolvimento necessário (§3).

### Opção C — e2-micro gratuita

VM e disco padrão de 30 GB no nível gratuito (us-east1/us-central1/us-west1), pagando o IP
(≈ 3,65) → **≈ 4–5**. **Não recomendada:** a medição real com painel + 4 tablets + celular deu
API ≈ 215 MB + Next.js ≈ 239 MB + PostgreSQL ≈ 150–250 MB, mais sistema e Caddy — acima de 1 GB.
Funcionaria só com swap e risco de travamentos por falta de memória.

## 6. Limites para reduzir gastos

- **Uma** VM, sem grupo de instâncias nem escalonamento automático; máquina fixa e2-small.
- Limites de memória por contêiner no Compose (api 600 MB, web 500 MB, postgres 500 MB, caddy
  100 MB, backup 200 MB) + 2 GB de swap: um vazamento não derruba a VM inteira.
- Disco de 20 GB fixo (sem aumento automático); snapshots com 7 dias; bucket com exclusão após 30
  dias; Artifact Registry com política de limpeza (manter as 3 últimas imagens).
- Cloud Build só disparado manualmente (sem gatilho automático a cada push).
- Sem balanceador de carga, sem Cloud SQL, sem NAT, sem agente de monitoramento pago.
- Orçamento: alertas em 50%, 90% e 100% (já configurado por você); sugerido orçamento de
  **US$ 30/mês** para a opção A.
- Desligar a VM fora dos períodos de teste (`gcloud compute instances stop`): sem cobrança de CPU;
  continua a do disco e do IP fixo (o IP reservado parado custa o dobro por hora, ≈ 7,30/mês).
- Encerramento da homologação: apagar tudo (§9.3) — custo volta a zero.

## 7. Riscos

| Risco                                                                                               | Mitigação                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homologação acessível pela internet (necessário para o iPhone em dados móveis e para o certificado) | Login obrigatório, bloqueio progressivo de senha/PIN, `noindex`, cabeçalhos de segurança, só dados fictícios; opcional: limitar a porta 443 ao IP fixo da oficina |
| VM única (sem alta disponibilidade)                                                                 | Aceitável em homologação; snapshots + backups fora da VM                                                                                                          |
| Linha `apt-get` do Dockerfile ainda não executada                                                   | Primeiro build no Cloud Build valida; se falhar, nada é implantado                                                                                                |
| Custos acima do previsto (preços de terceiros divergentes)                                          | Conferir na calculadora antes; alertas de orçamento; revisar a fatura na primeira semana                                                                          |
| Ataque à VM levando os backups junto                                                                | Conta de serviço só cria objetos no bucket (não lê nem apaga)                                                                                                     |
| Erro de DNS/certificado                                                                             | TTL curto (300 s); Caddy tenta de novo; checar CAA antes                                                                                                          |
| Migration com problema numa atualização                                                             | Backup + snapshot antes de cada atualização; reversão pela restauração (§9.2)                                                                                     |
| Latência maior em us-east1                                                                          | Medida durante a homologação; produção em São Paulo                                                                                                               |

## 8. Ajustes no repositório antes da implantação (pequenos; só após autorização)

1. `infra/homolog/docker-compose.gcp.yml` (sobreposição): imagens do Artifact Registry no lugar do
   `build`, `env_file: /run/cenario/env`, limites de memória, parâmetros do PostgreSQL.
2. `infra/homolog/Dockerfile`: `CMD` da web com `node` direto.
3. `infra/homolog/gcp/`: script de partida da VM (Docker, swap, leitura dos segredos para
   `/run/cenario/env`), timer systemd de envio dos backups ao bucket, `cloudbuild.yaml`.
4. Validação local do conjunto (como na Fase 12) antes de qualquer comando no Google Cloud.

## 9. Procedimento de implantação e reversão (comandos exatos; **não executados**)

Variáveis usadas abaixo (região us-east1; para São Paulo, trocar por `southamerica-east1` e zona
`southamerica-east1-a`):

```bash
PROJECT=cenariogestao; REGION=us-east1; ZONE=us-east1-b
VM=cenario-homolog; SA=cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com
BUCKET=gs://cenariogestao-homolog-backups; REPO=cenario-homolog
gcloud config set project $PROJECT
```

### 9.1 Implantação

1. **Conferir custos** na calculadora e **autorizar** (você).
2. Habilitar APIs (cobram só pelo uso):
   `gcloud services enable compute.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com`
3. Artifact Registry privado:
   `gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION`
4. Build das imagens (do seu computador, no diretório do repositório, commit fixo):
   `gcloud builds submit --config infra/homolog/gcp/cloudbuild.yaml --region=$REGION --substitutions=_TAG=$(git rev-parse --short HEAD)`
5. Segredos (valores gerados na hora, nunca digitados em arquivos):
   ```bash
   openssl rand -base64 24 | gcloud secrets create homolog-postgres-password --data-file=-
   openssl rand -base64 48 | gcloud secrets create homolog-token-hash-secret --data-file=-
   echo -n "Hml-$(openssl rand -hex 8)!" | gcloud secrets create homolog-admin-password --data-file=-
   ```
6. Conta de serviço e permissões mínimas:
   ```bash
   gcloud iam service-accounts create cenario-homolog-vm --display-name="VM homologação"
   for s in homolog-postgres-password homolog-token-hash-secret homolog-admin-password; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor; done
   gcloud artifacts repositories add-iam-policy-binding $REPO --location=$REGION --member=serviceAccount:$SA --role=roles/artifactregistry.reader
   gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/logging.logWriter
   ```
7. Bucket de backups privado com ciclo de vida de 30 dias:
   ```bash
   gcloud storage buckets create $BUCKET --location=$REGION --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update $BUCKET --lifecycle-file=infra/homolog/gcp/lifecycle-30d.json
   gcloud storage buckets add-iam-policy-binding $BUCKET --member=serviceAccount:$SA --role=roles/storage.objectCreator
   ```
8. Rede: IP fixo e firewall (só 80/443 públicos; SSH só pelo IAP):
   ```bash
   gcloud compute addresses create $VM-ip --region=$REGION
   gcloud compute firewall-rules create $VM-web --allow=tcp:80,tcp:443 --target-tags=$VM --source-ranges=0.0.0.0/0
   gcloud compute firewall-rules create $VM-iap-ssh --allow=tcp:22 --target-tags=$VM --source-ranges=35.235.240.0/20
   ```
9. VM (Shielded VM, OS Login, sem escopos amplos):
   ```bash
   gcloud compute instances create $VM --zone=$ZONE --machine-type=e2-small \
     --image-family=debian-12 --image-project=debian-cloud \
     --boot-disk-size=20GB --boot-disk-type=pd-balanced \
     --address=$VM-ip --tags=$VM --service-account=$SA --scopes=cloud-platform \
     --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
     --metadata=enable-oslogin=TRUE --metadata-from-file=startup-script=infra/homolog/gcp/startup.sh
   ```
   (Com `--scopes=cloud-platform`, o que vale são os papéis mínimos da conta de serviço do passo 6.)
10. Snapshots diários com 7 dias:
    ```bash
    gcloud compute resource-policies create snapshot-schedule $VM-diario --region=$REGION --daily-schedule --start-time=06:00 --max-retention-days=7
    gcloud compute disks add-resource-policies $VM --zone=$ZONE --resource-policies=$VM-diario
    ```
11. **DNS (você):** registro A `teste` → IP de `gcloud compute addresses describe $VM-ip --region=$REGION --format='value(address)'`, TTL 300.
12. Subir a pilha na VM (via `gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap`):
    `docker compose -f docker-compose.homolog.yml -f docker-compose.gcp.yml up -d` — a API aplica
    as migrations **no banco da homologação** ao iniciar; depois, uma vez:
    `docker compose … exec api pnpm db:seed`.
13. Verificação: `https://teste.cenariogestao.com.br/api/health` e `/api/ready`; login do gestor
    (trocar a senha); dados sintéticos (`scripts/homolog-dados-sinteticos.mjs`); roteiro ao vivo
    (`tests/e2e/homolog`) apontado para o domínio; backup manual e **teste de restauração** num
    banco separado; conferir o arquivo no bucket.
14. Só então: tablets e iPhone conforme `docs/HOMOLOGACAO.md` §5–6.

### 9.2 Reversão

- **Aplicação:** imagens marcadas pelo commit; voltar à versão anterior trocando a etiqueta na
  sobreposição do Compose e `docker compose … up -d`.
- **Banco:** as migrations só avançam. Antes de cada atualização: backup manual + snapshot do
  disco. Se uma migration der problema: parar a pilha, restaurar o backup anterior
  (`scripts/restore.sh`) ou recriar o disco a partir do snapshot, e subir a imagem anterior.
- **DNS:** remover o registro A `teste` tira a homologação do ar imediatamente para os usuários.

### 9.3 Encerramento completo (custo zero)

```bash
gcloud compute instances delete $VM --zone=$ZONE
gcloud compute addresses delete $VM-ip --region=$REGION
gcloud compute firewall-rules delete $VM-web $VM-iap-ssh
gcloud compute resource-policies delete $VM-diario --region=$REGION
gcloud compute snapshots list --filter="sourceDisk~$VM"   # apagar os snapshots listados
gcloud storage rm -r $BUCKET
gcloud artifacts repositories delete $REPO --location=$REGION
gcloud secrets delete homolog-postgres-password; gcloud secrets delete homolog-token-hash-secret; gcloud secrets delete homolog-admin-password
gcloud iam service-accounts delete $SA
```

E remover o registro DNS `teste`.

## 10. Decisões que preciso de você

1. Autorizar a opção A (ou outra).
2. Região: **us-east1** (≈ US$ 19–20/mês) ou **São Paulo** (≈ US$ 27–29/mês).
3. Onde está o DNS de `cenariogestao.com.br` (Registro.br, Cloudflare, outro) — a alteração será
   feita por você.
4. Se a porta 443 deve ficar aberta para qualquer IP (necessário para iPhone em dados móveis) ou
   restrita ao IP da oficina.
5. Autorizar os ajustes do §8 no repositório (sem efeito externo) antes de qualquer comando no
   Google Cloud.

## Fontes consultadas (preços e limites; conferir na calculadora oficial)

- [Cloud Run — Using WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
- [Cloud Run — Billing settings (CPU sempre alocada)](https://docs.cloud.google.com/run/docs/configuring/cpu-allocation)
- [Cloud Run — Locations (mapeamento de domínio)](https://docs.cloud.google.com/run/docs/locations)
- [Cloud Run pricing (resumo)](https://cloudchipr.com/blog/cloud-run-pricing)
- [Compute Engine — nível gratuito](https://cloud.google.com/free/docs/compute-getting-started)
- [Preços e2-small (agregadores)](https://www.devzero.io/instances/gcp/e2-small) ·
  [cloudprice.net](https://cloudprice.net/gcp/compute/instances/e2-small)
- [IP externo — preços](https://cloud.google.com/vpc/pricing-announce-external-ips)
- [Cloud SQL — preços (Bytebase)](https://www.bytebase.com/dbcost/cloudsql-pricing/)
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing?hl=pt)
- [Cloud Build pricing](https://cloud.google.com/build/pricing?hl=pt-BR)
- [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- [Compute Engine — anúncio de preços de snapshots](https://cloud.google.com/compute/pricing-announce?hl=en)
