# Homologação no Google Cloud — Etapa 1 (infraestrutura mínima)

> **Atualização (pré-implantação):** a infraestrutura foi criada manualmente, numa VPC exclusiva
> (`cenario-homolog-vpc`), não na rede `default`. O `etapa1-infra.sh` foi **retirado** (o `criar` e o
> `encerrar` dele não correspondem aos recursos reais). A preparação agora é feita pelo
> `infra/homolog/gcp/homolog.sh` — ver [`HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md`](HOMOLOGACAO-GCP-PRE-DEPLOY-RELATORIO.md).

> **Situação: NÃO executada.** O ambiente do Claude Code não tem credenciais do Google Cloud
> (`gcloud` sem conta autenticada; chamada de leitura ao projeto → `CREDENTIALS_MISSING`). Nada foi
> criado, habilitado ou alterado no Google Cloud. Não foi sugerido armazenar uma chave de conta de
> serviço neste ambiente: isso contrariaria a decisão de segurança já tomada (nenhuma chave JSON
> fora do Google). A Etapa 1 foi preparada para ser executada **por você no Cloud Shell**, com a
> sua própria conta, por um script com verificações prévias, confirmação explícita e encerramento.

Escopo autorizado: VM e2-small, disco persistente, IP estático, conta de serviço exclusiva,
Secret Manager, bucket privado de backups, firewall mínimo e acesso administrativo por IAP.
Fora do escopo (Etapa 2 ou não previsto): publicação da aplicação, Artifact Registry, Cloud
Build, regras 80/443, DNS, balanceador, Cloud SQL.

## 1. Verificações prévias

| #   | Verificação                           | Situação                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Branch, HEAD e estado                 | ✔ `claude/cenario-gestao-fase-1-zf3bj2`, HEAD `9be8187` (antes desta etapa), sem mudanças pendentes, igual ao remoto                                                                                                                                                        |
| 2   | Relatório de preparação e plano       | ✔ revisados; a separação entre Etapa 1 e Etapa 2 está no §4                                                                                                                                                                                                                 |
| 3   | Custos na calculadora oficial         | ⏳ as páginas oficiais de preços são dinâmicas e não abrem neste ambiente. O script lê o **catálogo oficial de preços** (API do Cloud Billing) com a sua conta — no Cloud Shell, o `verificar` calculou **US$ 19,29/mês** sem tributos; entradas para a calculadora no §3    |
| 4   | Projeto e conta de faturamento        | ⏳ depende da sua conta → `etapa1-infra.sh verificar`                                                                                                                                                                                                                        |
| 5   | Orçamento restrito ao projeto         | ⏳ `verificar` lista cada orçamento e marca ⚠ os que cobrem **todos** os projetos da conta de faturamento                                                                                                                                                                   |
| 6   | Permissões necessárias                | ⏳ `verificar` testa as 11 permissões exatas na sua conta (`testIamPermissions`)                                                                                                                                                                                             |
| 7   | Scripts de implantação e encerramento | ✔ revisados; ShellCheck sem avisos; **todas as opções do gcloud usadas foram conferidas** na ajuda do gcloud 570 (31 opções)                                                                                                                                                |
| 8   | Nenhum segredo em logs                | ✔ corrigido nesta revisão (§2)                                                                                                                                                                                                                                              |
| 9   | Política de backup e retenção         | ✔ §5                                                                                                                                                                                                                                                                        |
| 10  | VerificaPro intocado                  | ✔ todos os comandos usam `--project=cenariogestao` fixo; nomes exclusivos com prefixo `cenario-homolog`; o script lista os outros projetos visíveis apenas para mostrar que não serão tocados; nenhum orçamento, conta de faturamento ou recurso fora do projeto é alterado |

## 2. Revisão de segurança dos scripts (correções feitas)

- **Senha do proxy fora dos argumentos de processo:** o hash bcrypt agora é gerado com a senha
  pela entrada padrão (`printf … | caddy hash-password`), não por `--plaintext` (visível em `ps`).
- **Cookie de acesso fora dos argumentos do curl:** a verificação de saúde usa um cabeçalho em
  arquivo temporário com permissão 600.
- **Envio ao bucket só com permissão de criação:** `--if-generation-match=0` (pré-condição de "não
  existe"), em vez de `--no-clobber`, que pode exigir leitura.
- Segredos: gerados com `openssl rand` e enviados ao Secret Manager pela entrada padrão; nunca
  impressos; na VM só em `/run/cenario/env` (memória, 600). O registro da criação
  (`etapa1-<data>.log`) contém apenas nomes e resultados.

## 3. Custo mensal estimado da Etapa 1 (us-east1, sem tributos)

| Item                                                                                        | US$/mês           |
| ------------------------------------------------------------------------------------------- | ----------------- |
| VM e2-small, 730 h                                                                          | 12,23             |
| Disco pd-balanced 20 GB                                                                     | 2,00              |
| IPv4 estático em uso                                                                        | 3,65              |
| Snapshots diários (7 dias; ~8–12 GB)                                                        | 0,40–0,60         |
| Bucket (< 1 GB; cota gratuita em us-east1), Secret Manager (5 versões; 6 grátis), IAP, logs | 0,00              |
| **Total Etapa 1**                                                                           | **≈ 18,30–18,50** |

Abaixo do limite de US$ 20/mês. A Etapa 2 acrescenta ≈ US$ 0,50–1,10 (Artifact Registry e saída
de dados), mantendo ≈ US$ 18,80–19,55. Tributos: IOF de 3,5% + spread se a cobrança for em
dólar no cartão; em reais com CNPJ, tributos na nota (ver `HOMOLOGACAO-GCP-PREPARACAO.md` §8).

**Entradas para a Calculadora de Preços** (cloud.google.com/products/calculator):

- Compute Engine: 1 instância, Linux gratuito, **e2-small**, região **us-east1**, 730 h/mês,
  disco de inicialização **Balanced persistent disk 20 GB**, 1 IP externo (em uso);
  snapshots: 10 GB.
- Cloud Storage: us-east1, Standard, 1 GB, 100 operações de classe A.
- Secret Manager: 5 versões ativas, 100 acessos/mês.

### 3.1 Consulta oficial de preços (`precos_catalogo.py`) — corrigida após o timeout no Cloud Shell

O primeiro `criar` no Cloud Shell parou com `TimeoutError` (nada foi criado): a consulta trazia
páginas de 5.000 SKUs com timeout fixo de 30 s, sem novas tentativas, e o `criar` consultava o
catálogo **duas vezes** (no `verificar` e no plano). Além disso, a estimativa acima do limite só
gerava um aviso — não bloqueava. Agora:

- **Timeout e tentativas:** 60 s por requisição (páginas de 5.000 SKUs), até 3 tentativas com
  espera de 2 s e 4 s, prazo total de 300 s; parada assim que os 5 itens são encontrados (§3.2).
- **Resposta validada:** JSON completo, SKUs exigidas presentes, preço em USD, unidade esperada
  (`h`, `GiBy.h`, `GiBy.mo`) e valor plausível; paginação anormal é recusada. Resposta incompleta
  nunca vira estimativa nem é guardada.
- **Reutilização da consulta oficial:** cada consulta bem-sucedida fica em
  `~/.cache/cenario-homolog/precos-etapa1.json` (permissão 600) com **fonte** (Cloud Billing
  Catalog API, endereço oficial), **data da consulta**, **validade de 24 h**, conta e SKUs (id,
  descrição, unidade, preço unitário). Se a consulta nova falhar, a guardada é usada **somente**
  se for da mesma fonte oficial, estiver íntegra e dentro da validade; o total é sempre
  **recalculado** dos preços unitários com as quantidades fixas do script (um total editado no
  arquivo é ignorado; preço absurdo, item faltando, validade estendida ou data futura → recusada).
- **Sem preço inventado:** sem consulta oficial válida (nova ou guardada), não há estimativa.
- **Limite efetivo:** `LIMITE_USD=20.00` no script. O `criar` **bloqueia** — antes da confirmação
  manual — se não houver estimativa válida ou se ela passar do limite. O `criar` não consulta a
  rede de novo: usa a consulta que o `verificar` acabou de fazer ou validar.
- **Confirmação manual preservada:** continua sendo preciso digitar `cenariogestao`.

### 3.2 Segunda correção — "paginação anormal (mais de 60 páginas)"

**Causa:** o catálogo de preços do Compute Engine tem dezenas de milhares de SKUs, e a API v1
(`services.skus.list`) **não oferece filtro** por descrição, região ou SKU — só serviço (no
caminho), moeda e data. A v2beta também só filtra por serviço, e a busca de preço por ID nela
exige **chave de API** (um recurso novo, fora do autorizado). A correção anterior tinha reduzido a
página para 500 SKUs com teto de 60 páginas (30.000 SKUs): os itens estavam além disso. (A versão
original percorria o catálogo inteiro em páginas de 5.000 — por isso a primeira verificação chegou
a US$ 19,29 —, mas sem tentativas, e expirou na segunda consulta.)

**Agora:**

- Página do **tamanho máximo oficial (5.000)** e teto explícito de **100.000 SKUs examinadas
  (20 páginas)** — menos páginas que antes, cobrindo mais; para assim que os 5 itens aparecem
  e registra em que página/posição cada um foi achado.
- **Identificação estrita** (todas com cobrança `OnDemand`, moeda USD e unidade conferida):

  | Item              | Regra                                                                                                  | Unidade                    |
  | ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------- |
  | vCPU e2-small     | descrição `E2 Instance Core running in Americas`, regiões incluem `us-east1`                           | `h` (× 0,5 vCPU × 730 h)   |
  | Memória e2-small  | `E2 Instance Ram running in Americas`, regiões incluem `us-east1`                                      | `GiBy.h` (× 2 GiB × 730 h) |
  | Disco pd-balanced | começa com `Balanced PD Capacity`, região **somente** `us-east1`                                       | `GiBy.mo` (× 20)           |
  | IPv4 estático     | `External IP Charge on a Standard VM`, SKU **`C054-7F72-A02E`** (anúncio oficial; outro ID → recusado) | `h` (× 730)                |
  | Snapshots         | começa com `Storage PD Snapshot`, região **somente** `us-east1` (sem arquivo/instantâneo)              | `GiBy.mo` (× 10)           |

  Iscas recusadas (testadas): `E2 Custom Instance …`, `Spot Preemptible E2 …`, compromissos,
  `Regional Balanced PD Capacity …`, disco de outra região, `Hyperdisk …`, snapshot
  multirregional ou de arquivo e IP de VM Spot.

- **Condição de cobrança dos snapshots:** sem local definido, o Google guarda snapshots em local
  multirregional (outro preço). A agenda agora usa `--storage-location=us-east1`, coerente com o
  preço regional usado na estimativa; o `verificar-infra` confere.
- **`verificar` com estado claro:** sem estimativa oficial válida, termina em
  **"VERIFICAÇÃO: BLOQUEADA"** e sai com erro (antes mostrava "OK"); o `criar` não avança.
  Corrigido também: falha de conta/projeto no `verificar` agora sai com erro.
- Cache v2 (as consultas guardadas na versão anterior são recusadas e refeitas); na
  reutilização, as mesmas regras são reaplicadas às SKUs guardadas.

Testes (sem rede externa; catálogo, `gcloud` e `curl` falsos):

```bash
python3 -m unittest discover -s infra/homolog/gcp/testes -v      # 20 testes da consulta e do cache
bash infra/homolog/gcp/testes/test_etapa1_bloqueio.sh             # 8 cenários do script completo
```

## 4. O que a Etapa 1 cria (e o que não cria)

| Recurso             | Configuração                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APIs                | `compute`, `iam`, `secretmanager`, `storage`, `iap` (sem custo próprio)                                                                                                                                                |
| Conta de serviço    | `cenario-homolog-vm`, sem chaves                                                                                                                                                                                       |
| Permissões da conta | `secretmanager.secretAccessor` só nos 5 segredos; `storage.objectCreator` só no bucket (cria; não lê nem apaga); `logging.logWriter`                                                                                   |
| Segredos            | 5, replicação em us-east1, valores aleatórios                                                                                                                                                                          |
| Bucket              | `gs://cenariogestao-homolog-backups`, us-east1, Standard, acesso uniforme, prevenção de acesso público, exclusão após 30 dias                                                                                          |
| IP estático         | `cenario-homolog-ip`, us-east1                                                                                                                                                                                         |
| Firewall            | `cenario-homolog-iap-ssh`: TCP 22 **só** de `35.235.240.0/20` (IAP), prioridade 900; `cenario-homolog-bloqueio`: **nega toda entrada** para a VM, prioridade 1000 (sobrepõe as regras padrão da rede, como SSH aberto) |
| VM                  | `cenario-homolog`, e2-small, us-east1-b, Debian 12, Shielded VM (Secure Boot, vTPM, integridade), OS Login, conta de serviço exclusiva; partida instala Docker + Compose e 2 GB de swap                                |
| Disco               | pd-balanced 20 GB, apagado junto com a VM                                                                                                                                                                              |
| Snapshots           | agenda diária `cenario-homolog-diario`, 7 dias                                                                                                                                                                         |
| **Não cria**        | Artifact Registry, Cloud Build, regras 80/443, balanceador, Cloud SQL, DNS                                                                                                                                             |

**Nenhum serviço acessível publicamente:** sem arquivos em `/opt/cenario`, o serviço systemd da
pilha não inicia (`ConditionPathExists`); nenhum contêiner roda; o firewall nega toda entrada
exceto SSH vindo do IAP.

## 5. Banco, armazenamento e backups (estado após a Etapa 1)

- **Banco:** ainda **não existe** — o PostgreSQL é um contêiner criado na Etapa 2, no disco da VM,
  sem porta publicada.
- **Arquivos do sistema:** volume Docker no disco da VM (Etapa 2).
- **Backups** (política, ativa a partir da Etapa 2): backup diário do banco + arquivos com SHA-256
  na VM por **14 dias**; cópia diária no bucket por **30 dias**; snapshots do disco por **7 dias**
  (já ativos na Etapa 1). Restauração testada localmente (`HOMOLOGACAO-GCP-PREPARACAO.md` §5).

## 6. Como executar a Etapa 1 (você, no Cloud Shell)

1. Abra o **Cloud Shell** no console do Google Cloud, no projeto `cenariogestao` (conta dona do
   projeto).
2. Traga o repositório no commit desta etapa: `git clone` (com acesso ao GitHub) ou baixe o ZIP da
   branch no GitHub e envie pelo botão "Upload" do Cloud Shell; entre na pasta.
3. Verificação (só leitura):
   ```bash
   bash infra/homolog/gcp/etapa1-infra.sh verificar
   ```
   Prossiga só com **"VERIFICAÇÃO: OK"**, orçamento marcado ✔ (escopo só `cenariogestao`) e total
   ≤ ~US$ 20. Se aparecer ✘ ou ⚠, pare e me envie a saída.
4. Plano e criação (pede para digitar `cenariogestao`):
   ```bash
   bash infra/homolog/gcp/etapa1-infra.sh planejar
   bash infra/homolog/gcp/etapa1-infra.sh criar
   ```
5. Aguarde ~3 min e confira:
   ```bash
   bash infra/homolog/gcp/etapa1-infra.sh verificar-infra
   ```
   Esperado: VM RUNNING e2-small; disco 20 GB com snapshots; portas 22/80/443 **fechadas** na
   internet; dentro da VM: Docker e swap instalados, nenhum contêiner, `/opt/cenario` vazio,
   5 segredos legíveis pela conta da VM; bucket: gravação OK, leitura e exclusão **negadas**;
   bucket privado com exclusão em 30 dias; **"INFRAESTRUTURA DA ETAPA 1: OK"**.
6. Me envie a saída de `verificar`, `criar` (ou o arquivo `etapa1-*.log`) e `verificar-infra`:
   com ela preencho o relatório final da Etapa 1 (recursos, configuração, custo, segurança,
   firewall, banco/armazenamento, permissões, testes, pendências, próximos passos).

**Desfazer tudo:** `bash infra/homolog/gcp/etapa1-infra.sh encerrar` (pede para digitar
`apagar cenariogestao`).

## 7. Pendências

1. Execução da Etapa 1 com a sua conta (§6) — não há credenciais do Google Cloud neste ambiente.
2. Conferências que dependem da sua conta: faturamento, escopo do orçamento, permissões, preços
   oficiais (o `verificar` faz as quatro).
3. Não verificados aqui por falta de acesso: os nomes de campos de saída usados no
   `verificar-infra` (ex.: `public_access_prevention`) e a leitura do catálogo de preços; se algum
   formato divergir, a verificação mostra ✘/⚠ em vez de falhar silenciosamente.
4. Confirmar o DNS na Hostinger (pendência anterior; só necessário na Etapa 2).

## 8. Próximo passo (Etapa 2, aguardando sua autorização)

Artifact Registry + build no Cloud Build; regras 80/443 (prioridade 900, acima do bloqueio);
envio dos arquivos à VM; seed com dados fictícios; registro A `teste` na Hostinger;
certificado Let's Encrypt; verificação completa — conforme `HOMOLOGACAO-GCP-PREPARACAO.md` §9.
