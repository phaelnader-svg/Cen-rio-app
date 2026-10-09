# Homologação no Google Cloud — preparação final (relatório)

> **Nada foi criado no Google Cloud.** Nenhuma VM, API, bucket, segredo, IP, regra de firewall ou
> registro DNS foi criado ou alterado; nenhum deploy foi feito; nenhuma migration rodou fora do
> ambiente local. Esta execução alterou **apenas o repositório**, como autorizado. Só dados
> fictícios. Base: `84b4c9b` (branch `claude/cenario-gestao-fase-1-zf3bj2`).

Decisões recebidas: projeto `cenariogestao`; VM Compute Engine **e2-small** em **us-east1**;
domínio `teste.cenariogestao.com.br` (DNS na Hostinger, a confirmar); HTTPS obrigatório;
autenticação adicional no proxy além do login do sistema; PostgreSQL sem exposição pública; SSH
só por IAP; sem integração bancária, pagamentos externos ou dados reais.

## 1. O que foi preparado no repositório

| Arquivo                                               | Conteúdo                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/homolog/Dockerfile`                            | Base `node:22.23.3-bookworm` fixa (já traz OpenSSL 3 e certificados): **sem `apt-get`**, o passo que não podia ser verificado. API com `exec node` (recebe o SIGTERM: encerramento seguro). Web iniciada direto pelo Node (sem o processo extra do pnpm). Healthchecks nas duas imagens.                                                             |
| `infra/homolog/docker-compose.homolog.yml`            | Um arquivo para a verificação local e para a VM: imagens por variável (local ou Artifact Registry), limites de memória, heap do Node limitado, PostgreSQL ajustado para 2 GB, rede interna fixa (`172.28.0.0/24`, usada no `TRUST_PROXY`), rotação de logs, PostgreSQL sem porta publicada, backup diário (`postgres:16`) só depois da API saudável. |
| `infra/homolog/Caddyfile.homolog`                     | HTTPS automático, HSTS, `noindex`, limite de 10 MB e a **autenticação adicional** (§2).                                                                                                                                                                                                                                                              |
| `infra/homolog/env.homolog.example`                   | Modelo sem segredos (só para a verificação local).                                                                                                                                                                                                                                                                                                   |
| `infra/homolog/gcp/vm.sh`                             | Operação dentro da VM: `gerar-env` (Secret Manager → `/run/cenario/env`, memória, 600), `iniciar`, `status`, `saude`, `semear`, `backup`, `enviar-backups`, `restaurar-teste`, `restaurar … --sim`, `atualizar <etiqueta>` (com backup e reversão), `parar`.                                                                                         |
| `infra/homolog/gcp/startup.sh`                        | Partida da VM (idempotente): Docker Engine + Compose (repositório oficial), 2 GB de swap, serviço systemd da pilha e timer diário de envio dos backups.                                                                                                                                                                                              |
| `infra/homolog/gcp/operador.sh`                       | No seu computador: `criar-segredos`, `build`, `enviar-pacote`, `atualizar`, `senhas`, `saude` — cada um pede confirmação.                                                                                                                                                                                                                            |
| `infra/homolog/gcp/cloudbuild.yaml`                   | Build manual das duas imagens no Cloud Build → Artifact Registry.                                                                                                                                                                                                                                                                                    |
| `infra/homolog/gcp/lifecycle-30d.json`                | Ciclo de vida do bucket: apaga backups com mais de 30 dias.                                                                                                                                                                                                                                                                                          |
| `tests/e2e/homolog/…`, `playwright.homolog.config.ts` | O roteiro ao vivo agora também roda contra a pilha atrás do proxy (credenciais do proxy, HTTPS) e ganhou o teste "0. Proxy".                                                                                                                                                                                                                         |

## 2. Autenticação adicional no proxy

1. Primeiro acesso: o Caddy pede **usuário e senha do proxy** (basic auth) antes de qualquer coisa
   do sistema. Sem credencial, ou com senha errada: 401, nenhuma página, API ou WebSocket.
2. Senha aceita: o Caddy grava o cookie `cenario_homolog` (token aleatório de 64 hexadecimais,
   30 dias, `Secure`, `HttpOnly`, `SameSite=Lax`) — só **depois** de validar a senha (bloco
   `route`, testado: senha errada não recebe o cookie).
3. Com o cookie, tudo passa sem pedir a senha de novo: telas, API, **WebSocket**, service worker e
   o app adicionado à tela inicial. Cookie falso: 401.
4. Depois, o login normal do sistema (e-mail/senha no painel, código + PIN nos tablets).

Senha do proxy: no Secret Manager; o hash bcrypt é calculado na própria VM. Para revogar todos os
acessos ao proxy: nova versão do segredo `homolog-gate-token` e `vm.sh gerar-env && vm.sh iniciar`.

## 3. WebSocket atrás do proxy — verificado

Pilha completa em contêineres, local, com Caddy em `https://localhost` (certificado interno),
autenticação adicional ligada e limites de memória. Roteiro ao vivo **4/4**:

| Teste                                                                                                                                                                                                                                                                                        | Resultado |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0. Proxy: sem credencial 401 em `/painel`, `/api/ready` e `/api/realtime`; senha errada 401 (sem cookie); senha certa grava cookie `Secure`/`HttpOnly`; cookie falso 401; **só com o cookie**: login, nenhuma requisição usando a senha do proxy, WebSocket `wss://…/api/realtime` conectado | OK        |
| 1. API pelo domínio: saúde, prontidão, anônimo 401, origem estranha 403, senha errada 401, CSP                                                                                                                                                                                               | OK        |
| 2. Oficina: dados fictícios, programação, **4 tablets simultâneos**, Márcio sem rede enquanto o gestor muda a prioridade e reconexão com o estado atualizado (WebSocket via proxy), inspeção em tempo real, celular do André, financeiro                                                     | OK        |
| 3. 24 telas × desktop e celular (48 visitas) sem erro, com título, sem rolagem                                                                                                                                                                                                               | OK        |

Evidências: `docs/evidencias/homologacao-gcp-local/` (`resultado.json`, `telas.json`, capturas).

## 4. Memória da e2-small — medida

Amostragem a cada 2 s durante o roteiro completo (painel + 4 tablets + celular):

| Contêiner | Pico medido | Limite configurado                     |
| --------- | ----------- | -------------------------------------- |
| postgres  | 137 MiB     | 448 MiB                                |
| api       | 125 MiB     | 512 MiB (heap 320 MB)                  |
| web       | 150 MiB     | 448 MiB (heap 256 MB)                  |
| caddy     | 78 MiB      | 192 MiB (subido de 128 após a medição) |
| backup    | 16 MiB      | 256 MiB                                |
| **Soma**  | **506 MiB** | 1.856 MiB                              |

e2-small: 2 GB de RAM. Sistema + Docker ≈ 250–350 MB → uso estimado ≈ 0,8–0,9 GB no pico, com
≈ 1,1 GB livres (≈ 2× o pico dos contêineres). A soma dos limites passa da RAM física de
propósito: são tetos individuais, com 2 GB de swap como rede de segurança. **Conclusão:
suficiente.** Não medido: o desempenho de CPU da e2-small (2 vCPU compartilhadas com rajadas) —
medir na homologação. O build das imagens **não** roda na VM (Cloud Build).

## 5. Backups e restauração — verificados na pilha

- `vm.sh backup`: banco (`pg_dump` 16) + arquivos + SHA-256 → volume `backups` (14 dias); envio ao
  bucket (pulado localmente: sem bucket).
- Foto real enviada pelo proxy → backup → `vm.sh restaurar-teste`: banco separado, contagens
  idênticas (usuários, clientes, OS, tarefas, auditoria, eventos, arquivos, 12 migrations), banco
  temporário removido.
- Perda simulada (arquivos apagados) → `vm.sh restaurar <pasta> --sim` (backup de segurança
  automático antes) → arquivo de volta com **SHA-256 idêntico** e baixado pela API (200).
- Fora da VM: `enviar-backups` usa nomes novos (a conta da VM só cria objetos; não lê nem apaga).
  **Não testado** contra um bucket real.
- Snapshots diários do disco (7 dias) — comandos no §9.

## 6. Partida, saúde e encerramento — verificados localmente

`vm.sh iniciar` (todos saudáveis), `vm.sh saude` (contêineres, proxy exigindo autenticação, HTTPS +
API + banco, web, validade do certificado, idade do último backup, disco, memória: **OK**),
`vm.sh parar` → `iniciar` (volta saudável, dados preservados), troca de etiqueta do
`vm.sh atualizar` (testada no arquivo de variáveis). A API registra "Encerrando com segurança…" no
SIGTERM (antes, `sh` como processo principal engolia o sinal). **Não testados aqui** (dependem do
Google Cloud): `gerar-env`, `startup.sh`, `operador.sh`, `cloudbuild.yaml`.

## 7. Segredos e permissões mínimas

| Segredo (Secret Manager, região us-east1) | Uso                                               |
| ----------------------------------------- | ------------------------------------------------- |
| `homolog-postgres-password`               | Banco                                             |
| `homolog-token-hash-secret`               | Tokens de sessão                                  |
| `homolog-admin-password`                  | Gestor de teste (seed; trocar no primeiro acesso) |
| `homolog-proxy-password`                  | Autenticação adicional (hash calculado na VM)     |
| `homolog-gate-token`                      | Cookie de acesso do proxy                         |

5 versões ativas (gratuito até 6). Valores gerados aleatoriamente pelo `operador.sh`; nunca
aparecem em arquivos versionados nem em disco na VM (só em `/run`, memória).

Conta de serviço `cenario-homolog-vm` (sem a conta padrão do Compute): `secretAccessor` **apenas
nesses 5 segredos**; `artifactregistry.reader` **no repositório**; `storage.objectCreator`
**no bucket** (cria, não lê nem apaga); `logging.logWriter`. Você administra com sua conta; nenhuma
chave JSON de conta de serviço.

## 8. Custos estimados (us-east1)

Preços de lista em US$, 730 h/mês, conferidos em fontes públicas (algumas de terceiros; confirme na
Calculadora de Preços do Google Cloud). E2 não tem desconto por uso contínuo.

| Item                                                                                                     | Base de cálculo  | US$/mês           |
| -------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| VM e2-small                                                                                              | ≈ 0,0168/h       | 12,23             |
| Disco pd-balanced 20 GB                                                                                  | ≈ 0,10/GB        | 2,00              |
| IPv4 externo fixo em uso                                                                                 | 0,005/h          | 3,65              |
| Snapshots (7 dias; ~8–12 GB armazenados: sistema, imagens, swap, dados)                                  | ≈ 0,05/GB        | 0,40–0,60         |
| Cloud Storage (backups < 1 GB/mês; 5 GB grátis em us-east1; ~30 envios)                                  | —                | 0,00              |
| Artifact Registry (~0,9 GB por versão; 3 versões com camadas compartilhadas ≈ 1,5–2,7 GB; 0,5 GB grátis) | 0,10/GB          | 0,10–0,25         |
| Cloud Build (~10–15 min por build; 2.500 min/mês grátis)                                                 | —                | 0,00              |
| Secret Manager (5 versões, poucas leituras)                                                              | 6 versões grátis | 0,00              |
| Saída de dados para o Brasil (homologação: ~3–5 GB/mês; 1 GB grátis)                                     | ≈ 0,19/GB        | 0,40–0,80         |
| Logs e métricas (sem agente pago)                                                                        | cotas gratuitas  | 0,00              |
| IAP (SSH)                                                                                                | —                | 0,00              |
| **Total sem tributos**                                                                                   |                  | **≈ 18,80–19,55** |

**Tributos e câmbio** (dependem de como a conta é faturada — confira na sua fatura):

- **Cartão internacional, cobrança em dólar:** IOF de **3,5%** sobre compras internacionais
  (alíquota vigente em 2026, segundo as fontes consultadas) + spread cambial do cartão →
  ≈ US$ 19,50–20,25 + spread. Em reais: total × cotação do dia da fatura.
- **CNPJ faturado pela Google Cloud Brasil, em reais:** a empresa anunciou preços em reais com os
  tributos incluídos; o valor exato (ISS, PIS/COFINS) aparece na nota — não foi possível confirmar
  as alíquotas em documentação oficial atual.

**Desligar a VM fora dos testes economiza menos do que parece:** com a VM parada, o IP fixo passa a
custar 0,01/h (o dobro). Ex.: ligada 8 h × 22 dias → VM ≈ 2,95 + IP ≈ 6,42 + disco 2,00 + resto
≈ 1,5 → **≈ 12,90/mês**.

Orçamento sugerido: **US$ 30/mês**, alertas em 50%, 90% e 100% (você já tem alertas).

## 9. Comandos exatos para a implantação futura (NÃO executados)

Pré-requisitos no seu computador: `gcloud` autenticado na sua conta, `git`, `openssl`; clone na
branch e no commit a implantar, sem mudanças pendentes.

```bash
PROJECT=cenariogestao; REGION=us-east1; ZONE=us-east1-b; VM=cenario-homolog
SA=cenario-homolog-vm@$PROJECT.iam.gserviceaccount.com
BUCKET=gs://cenariogestao-homolog-backups; REPO=cenario-homolog
DOMAIN=teste.cenariogestao.com.br; ADMIN_EMAIL=gestor@teste.cenariogestao.com.br
gcloud config set project $PROJECT
```

**1. APIs** (cobram só pelo uso):

```bash
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com iap.googleapis.com
```

**2. Artifact Registry + limpeza (mantém 3 versões):**

```bash
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION
cat > /tmp/limpeza.json <<'EOF'
[{"name":"manter-3","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},
 {"name":"apagar-resto","action":{"type":"Delete"},"condition":{"tagState":"any"}}]
EOF
gcloud artifacts repositories set-cleanup-policies $REPO --location=$REGION --policy=/tmp/limpeza.json
```

**3. Segredos e build:**

```bash
bash infra/homolog/gcp/operador.sh criar-segredos
bash infra/homolog/gcp/operador.sh build          # etiqueta = commit atual
```

**4. Conta de serviço e permissões mínimas:**

```bash
gcloud iam service-accounts create cenario-homolog-vm --display-name="VM homologação Cenário"
for s in homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
gcloud artifacts repositories add-iam-policy-binding $REPO --location=$REGION \
  --member=serviceAccount:$SA --role=roles/artifactregistry.reader
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/logging.logWriter
```

**5. Bucket de backups (privado, 30 dias):**

```bash
gcloud storage buckets create $BUCKET --location=$REGION --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update $BUCKET --lifecycle-file=infra/homolog/gcp/lifecycle-30d.json
gcloud storage buckets add-iam-policy-binding $BUCKET --member=serviceAccount:$SA --role=roles/storage.objectCreator
```

**6. IP fixo e firewall** (80/443 públicos — exigidos pelo certificado e pelo iPhone em dados
móveis, protegidos pela autenticação do proxy; SSH só do IAP):

```bash
gcloud compute addresses create $VM-ip --region=$REGION
gcloud compute firewall-rules create $VM-web --allow=tcp:80,tcp:443 --target-tags=$VM --source-ranges=0.0.0.0/0
gcloud compute firewall-rules create $VM-iap-ssh --allow=tcp:22 --target-tags=$VM --source-ranges=35.235.240.0/20
```

**7. VM** (Shielded VM, OS Login, configuração não secreta nos metadados):

```bash
gcloud compute instances create $VM --zone=$ZONE --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB --boot-disk-type=pd-balanced \
  --address=$VM-ip --tags=$VM --service-account=$SA --scopes=cloud-platform \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=enable-oslogin=TRUE,cenario-project=$PROJECT,cenario-region=$REGION,cenario-repo=$REPO,cenario-tag=$(git rev-parse --short HEAD),cenario-domain=$DOMAIN,cenario-bucket=$BUCKET,cenario-basic-user=homologacao,cenario-admin-email=$ADMIN_EMAIL \
  --metadata-from-file=startup-script=infra/homolog/gcp/startup.sh
```

**8. Snapshots diários (7 dias):**

```bash
gcloud compute resource-policies create snapshot-schedule $VM-diario --region=$REGION \
  --daily-schedule --start-time=06:00 --max-retention-days=7
gcloud compute disks add-resource-policies $VM --zone=$ZONE --resource-policies=$VM-diario
```

**9. Arquivos na VM e pilha:**

```bash
bash infra/homolog/gcp/operador.sh enviar-pacote
gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap --command="sudo systemctl restart cenario-homolog && sudo /opt/cenario/infra/homolog/gcp/vm.sh status"
```

A API aplica as migrations no banco **da homologação** ao iniciar.

**10. DNS na Hostinger (você):** hPanel → Domínios → `cenariogestao.com.br` → DNS / Nameservers →
adicionar registro **A**, nome `teste`, valor = IP de
`gcloud compute addresses describe $VM-ip --region=$REGION --format='value(address)'`, TTL 300.
Se houver registro **CAA** no domínio, incluir `0 issue "letsencrypt.org"`.

**11. Seed, verificação e restauração de teste:**

```bash
gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap --command="sudo /opt/cenario/infra/homolog/gcp/vm.sh semear"
bash infra/homolog/gcp/operador.sh saude
gcloud compute ssh $VM --zone=$ZONE --tunnel-through-iap --command="sudo /opt/cenario/infra/homolog/gcp/vm.sh backup && sudo /opt/cenario/infra/homolog/gcp/vm.sh restaurar-teste"
gcloud storage ls $BUCKET            # o backup enviado precisa aparecer
bash infra/homolog/gcp/operador.sh senhas
```

Depois, do seu computador (dados fictícios + roteiro completo contra o domínio real):

```bash
HOMOLOG_URL=https://$DOMAIN HOMOLOG_EMAIL=$ADMIN_EMAIL HOMOLOG_PASSWORD='<senha do gestor>' \
  HOMOLOG_BASIC_USER=homologacao HOMOLOG_BASIC_PASSWORD='<senha do proxy>' \
  node scripts/homolog-dados-sinteticos.mjs 5
cd tests/e2e && HOMOLOG_WEB_URL=https://$DOMAIN SEED_ADMIN_EMAIL=$ADMIN_EMAIL SEED_ADMIN_PASSWORD='<senha>' \
  HOMOLOG_BASIC_USER=homologacao HOMOLOG_BASIC_PASSWORD='<senha do proxy>' \
  pnpm exec playwright test -c playwright.homolog.config.ts
```

**Reversão:** `bash infra/homolog/gcp/operador.sh atualizar <etiqueta anterior>` (imagens);
`vm.sh restaurar <pasta> --sim` (dados; backup de segurança automático antes); recriar o disco a
partir de um snapshot (máquina inteira); remover o registro A `teste` (tira do ar para os
usuários).

**Encerramento completo (custo zero):** comandos do `HOMOLOGACAO-GCP-PLANO.md` §9.3, acrescidos de
`gcloud secrets delete homolog-proxy-password` e `gcloud secrets delete homolog-gate-token`.

## 10. Testes executados nesta etapa

| Teste                                                                                            | Resultado                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build das imagens `api` e `web` com o Dockerfile novo (sem `apt-get`)                            | OK. Neste ambiente de desenvolvimento a rede exige o certificado do proxy local para baixar pacotes do npm; ele foi acrescentado só numa cópia temporária do Dockerfile (o arquivo do repositório roda inalterado no Cloud Build) |
| `docker compose config`                                                                          | Válido                                                                                                                                                                                                                            |
| Pilha completa local com Caddy HTTPS + autenticação adicional                                    | Saudável                                                                                                                                                                                                                          |
| Roteiro ao vivo pelo proxy (4 testes, inclusive WebSocket só com cookie e 4 tablets)             | **4/4**                                                                                                                                                                                                                           |
| `vm.sh`: iniciar, status, saude, semear, backup, restaurar-teste, restaurar --sim, parar/iniciar | OK                                                                                                                                                                                                                                |
| Restauração de arquivo real (SHA-256)                                                            | Idêntico                                                                                                                                                                                                                          |
| Encerramento seguro da API (SIGTERM)                                                             | OK                                                                                                                                                                                                                                |
| `scripts/homolog-dados-sinteticos.mjs` pelo proxy                                                | Com credencial do proxy: 3 clientes/pedidos/OS criados; sem credencial: recusado (401)                                                                                                                                            |
| Restauração de teste após backup novo                                                            | Contagens idênticas                                                                                                                                                                                                               |
| ShellCheck em todos os scripts de operação                                                       | Sem avisos                                                                                                                                                                                                                        |
| `pnpm check` (formatação, lint, typecheck, testes)                                               | Passou: API 295, shared 53, web 6                                                                                                                                                                                                 |
| `pnpm test:e2e` (suíte do navegador, com o helper de tablet alterado)                            | **21/21**; auditoria visual com 144 combinações sem defeito                                                                                                                                                                       |

## 11. Pendências

1. **Confirmar o DNS na Hostinger:** daqui não foi possível consultar os nameservers (a consulta foi
   bloqueada pela rede do ambiente). O domínio raiz resolve para `2.57.91.91` e
   `teste.cenariogestao.com.br` ainda **não existe** (sem conflito). Confirme com
   `nslookup -type=NS cenariogestao.com.br` e `nslookup -type=CAA cenariogestao.com.br`.
2. **Não testados aqui (dependem do Google Cloud):** `startup.sh`, `vm.sh gerar-env`, envio ao
   bucket com a permissão só de criação, `operador.sh`, `cloudbuild.yaml`, certificado Let's
   Encrypt real, desempenho de CPU da e2-small. Serão verificados no passo 11.
3. **iPhone/Safari com a autenticação do proxy:** o comportamento do basic auth num app
   adicionado à tela inicial do iOS não foi testado (só Chromium). Se o iOS não exibir o pedido
   de senha no modo app, o primeiro acesso deve ser feito no Safari (o cookie vale para a sessão
   do Safari); validar na homologação.
4. Confirmar os preços na calculadora oficial e a forma de faturamento (dólar com IOF ou reais com
   tributos incluídos).

## Fontes de preços e limites

- [Compute Engine — nível gratuito e regiões](https://cloud.google.com/free/docs/compute-getting-started)
- [Preço e2-small (agregadores)](https://www.devzero.io/instances/gcp/e2-small) ·
  [cloudprice.net](https://cloudprice.net/gcp/compute/instances/e2-small)
- [IP externo](https://cloud.google.com/vpc/pricing-announce-external-ips) ·
  [Saída de dados (VPC)](https://cloud.google.com/vpc/pricing-announce)
- [Snapshots](https://cloud.google.com/compute/pricing-announce?hl=en) ·
  [Cloud Storage](https://cloud.google.com/storage/pricing)
- [Artifact Registry](https://cloud.google.com/artifact-registry/pricing?hl=pt) ·
  [Cloud Build](https://cloud.google.com/build/pricing?hl=pt-BR) ·
  [Secret Manager](https://cloud.google.com/secret-manager/pricing)
- [IOF 2026 (ARQ Finance)](https://arqfinance.com/articles/?p=2031) ·
  [Nomad — IOF](https://www.nomadglobal.com/conteudos/o-que-e-iof)
- [Google Cloud no Brasil, cobrança em reais](https://www.datacenterdynamics.com/br/not%C3%ADcias/google-cloud-platform-s%C3%A3o-paulo-menor-lat%C3%AAncia-e-pagamentos-em-reais/)
