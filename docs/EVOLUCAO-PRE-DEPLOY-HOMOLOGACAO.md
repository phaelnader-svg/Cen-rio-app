# Cenário Gestão — Pré-deploy controlado da Evolução completa (Fases 1–8) na homologação

> **Somente preparação, auditoria, testes locais e documentação. Nenhum deploy foi executado.**
> Nada foi feito no Google Cloud: nenhum comando na VM, nenhuma migration na nuvem, nenhum build
> no Cloud Build, nenhum recurso criado, nenhuma alteração de DNS/firewall, nenhum dado real lido.
> Todos os resultados abaixo são de **ensaios locais com dados sintéticos**. O estado REAL da
> homologação **não foi verificado** e deve ser auditado pelo operador (§11) antes de qualquer passo.

## 1. Identificação

| Item                      | Valor                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                    | `claude/cenario-gestao-fase-1-zf3bj2`                                                                                                    |
| SHA inicial (Fase 8)      | `e344dd6`                                                                                                                                |
| Commits desta preparação  | `b5b9bb7` (migrations explícitas + passos controlados), `735ddfe` (correções achadas no ensaio + evidências), `6239e2e` (este documento) |
| SHA final                 | HEAD da branch: `6239e2e` + o commit seguinte, que só registra este SHA (sem mudança de código ou script) — use `git log -1`             |
| Versão publicada (relato) | `fd6dc19` — **não confirmada no ambiente real** (§11)                                                                                    |
| Código da aplicação       | idêntico a `e344dd6` (`git diff e344dd6 HEAD -- apps packages pnpm-lock.yaml package.json` vazio)                                        |
| Diferença para `e344dd6`  | só `infra/homolog/**` (Dockerfile/partida da API, Compose, Caddy, scripts), docs e evidências                                            |

### 1.1 Etiqueta das imagens a publicar

A etiqueta é o SHA curto do **HEAD no momento do build** (`operador.sh build` recusa árvore suja).
Deve ser o SHA final desta branch (§1, último commit). As imagens do ensaio (`b5b9bb7`) têm o
**mesmo código de aplicação e a mesma partida da API**; depois delas mudaram só scripts da VM
(`vm.sh`, auditoria) e documentação — nada dentro da imagem.

## 2. Inventário: versão publicada × candidata

### 2.1 Versão publicada `fd6dc19` (conforme o repositório)

- Código de aplicação = `839770a` (pré-Evolução): **12 migrations**.
- Imagem da API: `CMD pnpm db:migrate && node …` → **aplica migrations sozinha ao iniciar**.
- Compose `cenario-homolog`: `postgres:16-alpine` (448 MB), `api` (512 MB, heap 320 MB), `web`
  (448 MB), `caddy:2.10-alpine` (192 MB), `backup` `postgres:16` (256 MB). Volumes `pgdata`,
  `storage`, `backups`, `caddy_data`.
- Variáveis geradas na VM por `vm.sh gerar-env` (Secret Manager + metadado `cenario-tag`); o
  serviço systemd roda `gerar-env && iniciar` no boot ⇒ **`cenario-tag` decide a versão que sobe
  num reinício**.

### 2.2 Candidata (este branch)

| Área                  | Mudança desde `fd6dc19`                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Arquivos              | 203 alterados (108 em `apps/` + `packages/`)                                                                                                                                                                       |
| Migrations            | **+5** (`20261018000000_fila_semanal`, `20261025000000_distribuicao_automatica`, `20261101000000_mao_de_obra_revisao`, `20261108000000_custos_logistica`, `20261115000000_fechamento_semanal`) → 17 no total       |
| Rollback manual       | 5 scripts em `packages/db/rollback/*.down.sql` — **recusam** havendo qualquer dado novo                                                                                                                            |
| Dependências          | `package.json` e `pnpm-lock.yaml` **sem mudança**; Node 22.23.3, pnpm 10.28.0, Prisma 6.19.3                                                                                                                       |
| Variáveis de ambiente | `apps/api/src/env.ts` **sem mudança**; Compose: `CHECKPOINT_DISABLE=1`, `MIGRATE_ON_START=${CENARIO_MIGRATE_ON_START:-0}` (só no serviço `api`)                                                                    |
| Permissões (catálogo) | sem mudança                                                                                                                                                                                                        |
| Seed                  | `seed.ts` grava `stepClass` (classificação de etapa) — só afeta `vm.sh semear`, que **não** é usado na atualização                                                                                                 |
| Partida da API        | `infra/homolog/api-iniciar.sh`: com `MIGRATE_ON_START=0` **não altera o banco**; confere `db:status` e **recusa iniciar** (código 78) com migration pendente/falha                                                 |
| Caddy                 | HTTP/3 desligado (`protocols h1 h2`), página HTML no 401, **503 "em manutenção"** (JSON na API) com API/web paradas                                                                                                |
| Scripts               | `vm.sh`: `preparar-versao`, `manutencao`, `ponto-recuperacao`, `migrar`, `ativar`, `recuperar`, `impressao-digital`, `preflight`; `atualizar` **desativado**; `operador.sh passo …`, `definir-etiqueta`, `auditar` |
| Volumes               | os mesmos 4; nenhum novo; nenhum dado de arquivo migrado                                                                                                                                                           |
| Dependências externas | as mesmas (Artifact Registry, Secret Manager, bucket de backups, Let's Encrypt); nenhuma nova                                                                                                                      |

## 3. Migrations: conteúdo, risco, bloqueios e tempo

### 3.1 O que cada uma faz nos dados existentes

| Migration                 | Tabelas existentes alteradas                                                               | Dados existentes tocados                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `fila_semanal`            | `production_plans`, `production_tasks` (colunas, 1 FK, 1 CHECK, gatilhos)                  | planos legados marcados `LEGADO`                                                                                         |
| `distribuicao_automatica` | `company_settings`, `production_tasks`, `production_template_steps`, `service_order_items` | `UPDATE production_template_steps SET step_class` (classificação)                                                        |
| `mao_de_obra_revisao`     | `production_payables` (2 índices únicos **substituídos**)                                  | `INSERT INTO labor_reviews` para conflitos legados de titular; índices novos são **mais fracos** que os antigos          |
| `custos_logistica`        | `logistics_costs`, `logistics_cost_allocations`, `company_settings` (+3 tabelas novas)     | `UPDATE logistics_costs SET status='CANCELADO' WHERE cancelled_at IS NOT NULL`; CHECKs (`amount_cents>0` já era exigido) |
| `fechamento_semanal`      | só tabelas novas (7) + gatilhos                                                            | nenhum                                                                                                                   |

Todas as restrições novas em tabelas existentes são **iguais ou mais fracas** que as legadas: dado
legado válido não as viola. Três índices são substituídos de propósito
(`production_payables_item_active`, `production_payables_order_active`,
`logistics_cost_allocations_logistics_cost_id_service_order__key`).

`sql/preflight-evolucao.sql` (transação READ ONLY, roda na auditoria e antes de `migrar`) confere o
que faria uma migration falhar: objetos com nomes que as migrations criam, duplicidades que os
índices únicos novos recusariam, valores fora dos CHECKs, tipos desconhecidos, linhas de
configuração. No banco sintético no schema publicado: **todos ✔** (evidência
`docs/evidencias/pre-deploy/00-auditoria-somente-leitura.txt`).

### 3.2 Bloqueios e tempo

- `ADD COLUMN` sem default volátil: só metadados (bloqueio `ACCESS EXCLUSIVE` de milissegundos).
- `CREATE INDEX` (não concorrente): bloqueio `SHARE` na tabela durante a construção — proporcional
  ao tamanho. `ADD CONSTRAINT … FOREIGN KEY/CHECK`: varredura de validação.
- `UPDATE`s acima: proporcionais às linhas de 3 tabelas pequenas.
- **Todas rodam com API e web paradas** (janela de manutenção): não há concorrência a bloquear.
- Medido no ensaio (dados sintéticos, 16 MB): **5 migrations em 6 s** (`migrar` completo em 8 s).
  O volume real é desconhecido: a auditoria (§11) mostra tamanho do banco e linhas por tabela;
  com volumes de homologação (centenas a milhares de linhas) espera-se < 1 min na e2-small.
  Nenhuma migration identificada como lenta.

### 3.3 Comportamento transacional (comprovado)

Cada migration roda **na sua própria transação**. Falha na 4ª (ensaio, etapa 4: objeto conflitante
plantado) ⇒ 1ª–3ª **ficam aplicadas**, a 4ª é desfeita por inteiro (coluna `logistics_costs.status`
não existe) e fica marcada como falha em `_prisma_migrations`. Ou seja: **o banco fica num estado
intermediário entre versões** — nenhuma das duas imagens corresponde a ele. Daí:

- a imagem nova **recusa iniciar** (etapa 4b: `API NÃO iniciada: há migrations pendentes ou com falha`);
- a saída é **`recuperar --sim`** para o ponto de recuperação (etapa 4c), nunca trocar a imagem.

## 4. Backup, ponto de recuperação e restauração

### 4.1 O que é o ponto de recuperação (`vm.sh ponto-recuperacao`)

1. Exige API e web **paradas** (nada grava no banco).
2. Backup completo: `pg_dump -Fc` de todo o banco + arquivos privados (`/data/storage`) +
   `SHA256SUMS` (`scripts/backup.sh`).
3. Confere o `SHA256SUMS`.
4. **Restauração de teste em banco separado** (`cenario_restore_check`), recriado vazio, e
   comparação por **impressão digital** (`sql/impressao-digital.sql`): conteúdo de **todas** as
   tabelas por hash de linha, contagens, catálogo (índices, restrições, gatilhos, FKs/vínculos),
   22 somas de colunas financeiras e estado das migrations. Tem que ser **idêntica**.
5. Envia ao bucket (cópia fora da VM). Falha em qualquer item ⇒ ponto **não** registrado.
6. Registra pasta, horário, versão e impressão do banco. `migrar` só roda se o banco atual tiver
   **exatamente** essa impressão (nada gravado depois) e o ponto tiver ≤ 240 min.

### 4.2 Restauração (`vm.sh recuperar --sim`)

Exige o metadado `cenario-tag` igual à versão do ponto; para API/web; faz um backup de segurança
do estado atual (para análise); **recria o banco vazio** (`DROP DATABASE … WITH (FORCE)`) e
restaura; restaura os arquivos; confere a impressão (**idêntica** ou não inicia); grava a versão
do ponto no ambiente e sobe; roda `saude`.

**Defeito do procedimento antigo, comprovado localmente:** `pg_restore --clean` sobre um banco já
migrado **falha** (`cannot drop constraint users_pkey … because other objects depend on it
(service_order_items_upholsterer_user_id_fkey, service_order_item_owner_changes_*_fkey)`) e o banco
fica com as 17 migrations — restauração aparente que não volta nada. Corrigido: o banco é sempre
recriado vazio antes do `pg_restore` (`restaurar_em`), também em `vm.sh restaurar`.

### 4.3 Limites (leia antes de autorizar)

- **Trocar a imagem Docker NÃO é rollback.** A imagem antiga lê o schema novo, mas ignora a
  semântica nova (estornos, fila, titular, revisões, fechamento) e o banco continua migrado.
- **Rollback de schema** (`packages/db/rollback`) só funciona **sem nenhum dado novo**; havendo
  qualquer um, recusa antes de alterar. Não é o caminho de recuperação desta atualização.
- **Recuperação = restaurar o ponto. Tudo o que for gravado depois do ponto se PERDE** (ensaio,
  etapa 9: cliente criado após o ponto existia e sumiu na recuperação). Mitigação: janela curta,
  testes só com dados fictícios, anotar manualmente qualquer lançamento feito após a ativação,
  decidir GO/NO-GO pós-publicação **antes** de liberar a equipe.

## 5. Ensaio local completo (evidência)

`infra/homolog/gcp/testes/ensaio-atualizacao.sh` usa a pilha REAL de homologação
(`docker-compose.homolog.yml`, Caddy com HTTPS e autenticação, PostgreSQL 16, contêiner de backup)
e o `vm.sh` deste commit, com imagens `fd6dc19` (conferidas pelas impressões gravadas na preparação
GCP) e candidata `b5b9bb7`, e um banco sintético no schema publicado (12 migrations). Resultado:
**`ENSAIO: OK`** (`docs/evidencias/pre-deploy/ensaio-atualizacao.txt`).

| Etapa | Verificação                                                                                                                                                                                                        | Resultado |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 0     | Pilha publicada `fd6dc19`, 12 migrations, `saude` 18 ✔                                                                                                                                                            | ✔        |
| 0b    | Auditoria só leitura (como Cloud Shell → VM): 34 ✔ · 0 ✘; banco e contêineres **idênticos** depois                                                                                                                | ✔        |
| 1     | `atualizar` desativado (saída 2); `migrar` com API rodando recusado; sem portão recusado (3)                                                                                                                       | ✔        |
| 2     | `preparar-versao`: digests, imagem não migra na partida, 17 × 12 migrations, disco; nada reiniciado; versão antiga recusada                                                                                        | ✔        |
| 3     | `manutencao`: API 503 JSON `MANUTENCAO`, painel 503 HTML; `migrar` sem ponto recusado                                                                                                                              | ✔        |
| 4     | Falha **intermediária** (4ª migration): 3 aplicadas, 4ª desfeita, estado parcial                                                                                                                                   | ✔        |
| 4b    | Imagem nova **recusa iniciar** com migration falha                                                                                                                                                                 | ✔        |
| 4c    | `recuperar` recusa com metadado errado; com o certo: banco **idêntico** ao ponto, 12 migrations, `saude` OK                                                                                                        | ✔        |
| 5     | Ponto (restauração de teste idêntica: 99 tabelas, 22 colunas financeiras); escrita após o ponto ⇒ `migrar` recusa; novo ponto; `migrar` 8 s; `ativar` recusa sem `cenario-tag`; com ele: 17 migrations, `saude` OK | ✔        |
| 6     | Login do gestor e 7 rotas (OS, planos, fechamento semanal, mão de obra, custos logísticos, painel financeiro, qualidade) 200 via proxy; painel financeiro 200                                                      | ✔        |
| 7     | `migrate deploy` repetido: nada pendente (idempotente); `migrar` de novo recusado                                                                                                                                  | ✔        |
| 8     | Falha de **inicialização** (segredo inválido): `ativar` falha com diagnóstico; corrigido ⇒ OK, banco intocado                                                                                                      | ✔        |
| 9     | Recuperação **depois do uso**: registro criado após o ponto é **perdido** (risco documentado)                                                                                                                      | ✔        |

**Integridade antes × depois da migração** (`01-impressao-publicada.txt` × `05-impressao-candidata.txt`):
mesmas contagens em todas as tabelas legadas; as **22 somas financeiras legadas idênticas**
(R$ 18.005,60 no total sintético); 9 somas novas, todas zero; hashes mudam só nas tabelas que
ganharam colunas (`company_settings`, `logistics_costs`, `logistics_cost_allocations`,
`production_payables`, `production_plans`, `production_tasks`, `production_template_steps`,
`service_order_items`). A Fase 8 (`scripts/test-evolution-migrations.sh`) já comparou **por valor
todas as colunas** de 98 tabelas do legado `839770a` → idênticas.

**Defeitos dos scripts encontrados pelo ensaio e corrigidos (`735ddfe`):**

1. `recuperar` reexportava as imagens antigas do ambiente (precedência sobre `--env-file`) e subia
   **de novo a versão nova** depois de restaurar o banco antigo — a API recusava e a recuperação
   falhava. Agora recarrega o ambiente e confere a versão antes de subir.
2. Armadilha `RETURN` global em `saude` disparava fora da função (`hdr: unbound variable`):
   `ativar`/`recuperar` terminavam com erro mesmo com saúde OK.
3. `compose up` com dependência não saudável abortava sem a mensagem de recuperação.
4. A auditoria enviada por `bash -s` era cortada: `docker exec -i` consumia o restante do script.
   Agora vai dentro de uma função lida por inteiro, com a entrada fechada.

Testes de scripts: `test_vm_sh.sh` e `test_homolog_sh.sh` — **todos os cenários OK**; `bash -n` em
todos os scripts; `prettier --check .` limpo.

## 6. Imagens Docker

| Item                   | Resultado (build local de `b5b9bb7`)                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Contexto               | export limpo (`git archive`); `.dockerignore`/`.gcloudignore` conferidos por `conferir-contexto.sh` no `operador.sh build`    |
| Base                   | `node:22.23.3-bookworm` (fixa); Node v22.23.3, pnpm 10.28.0, Prisma 6.19.3; usuário `node`                                    |
| Healthcheck            | API `/api/ready` (start 60 s), web `/entrar` (start 30 s)                                                                     |
| Partida                | API: `sh infra/homolog/api-iniciar.sh`; 17 migrations na imagem                                                               |
| Segredos               | só `/app/.env.example`; nenhuma variável de proxy/segredo no histórico                                                        |
| Tamanho                | 3,38 GB por imagem (api e web compartilham ~tudo); maior camada `pnpm install` 1,21 GB                                        |
| Camadas novas na VM    | ≈ 1,6 GB (install 1,21 GB + build 286 MB + código 40 MB + corepack 21 MB) se a base for a mesma; até ≈ 3,4 GB se a base mudou |
| Tempo de build (local) | 189 s (api + web)                                                                                                             |

Observações honestas:

- O build **do ensaio** usou uma variante do Dockerfile só da sandbox (+2 linhas com a CA do proxy
  local e `NODE_EXTRA_CA_CERTS`). O Cloud Build usa o `infra/homolog/Dockerfile` **sem mudança**.
- O Docker Hub respondeu **429 Too Many Requests** para `node:22.23.3-bookworm` aqui (contornado
  com a mesma versão já local). O Cloud Build também baixa do Docker Hub anonimamente: um 429 faz o
  build falhar (sem efeito na VM; repetir mais tarde). A VM **não** precisa do Docker Hub nesta
  atualização: `postgres`/`caddy` já estão nela e não mudam.
- Na e2-small o **build não roda na VM** (Cloud Build); a VM só baixa as imagens
  (`preparar-versao`, fora da janela).

## 7. Runbook de publicação (16 itens) — SÓ COM AUTORIZAÇÃO EXPLÍCITA

Execução no **Cloud Shell**, num clone deste repositório no SHA aprovado. Cada comando do
`operador.sh` mostra o que vai fazer e pede `sim`. **Não use** `operador.sh atualizar`,
`vm.sh atualizar`, o item 4 do `homolog.sh plano-publicacao` nem o runbook §14 da Fase 8: são
o fluxo antigo, que migrava na partida sem ponto de recuperação.

```bash
# Preparação do clone (Cloud Shell)
git clone https://github.com/phaelnader-svg/cen-rio-app.git ~/cenario-pre-deploy 2>/dev/null || true
cd ~/cenario-pre-deploy && git fetch origin claude/cenario-gestao-fase-1-zf3bj2
git checkout --detach <SHA-APROVADO> && git log --oneline -1 && git status --short   # deve estar limpo
```

| #   | Item                     | Comando / ação                                                                                                                                                                                                                       | Esperado / critério                                                                                                                                                                   |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Confirmar versão atual   | `bash infra/homolog/gcp/operador.sh auditar` (só leitura)                                                                                                                                                                            | `cenario-tag=fd6dc19`; contêineres `running healthy`; 12 migrations, nenhuma falha; pré-verificação toda ✔; disco ≥ 5 GB; último backup íntegro. Divergência ⇒ **parar** e reavaliar |
| 2   | Janela de manutenção     | Combinar ~90 min com a equipe; ninguém lançando; tablets em repouso                                                                                                                                                                  | Aviso dado; responsável presente                                                                                                                                                      |
| 3   | Bloquear novas operações | (a) antes da janela: `operador.sh atualizar-config` (leva scripts/Caddy novos; recria **só** o proxy; guarda cópia anterior). (b) na janela: `operador.sh passo manutencao`                                                          | (a) `saude` OK, versão ainda `fd6dc19`. (b) API 503 JSON “em manutenção”, painel 503                                                                                                  |
| 4   | Backup pré-deploy        | `operador.sh passo ponto-recuperacao`                                                                                                                                                                                                | `✔ … íntegro (SHA256SUMS)`, `✔ PONTO DE RECUPERAÇÃO: <pasta>`; **anotar a pasta**                                                                                                   |
| 5   | Teste de restauração     | incluído no item 4 (banco separado, impressão **IDÊNTICA**); opcional fora da VM: `operador.sh trazer-backup <pasta>` (só copia e confere o SHA-256)                                                                                 | Qualquer diferença ⇒ ponto não registrado ⇒ **abortar** (item 15)                                                                                                                     |
| 6   | Build das imagens        | **antes da janela**: `operador.sh build` (Cloud Build, custo §9)                                                                                                                                                                     | `✔ Imagens publicadas com a etiqueta <SHA>`                                                                                                                                          |
| 7   | Digests e etiquetas      | Cloud Shell: `gcloud artifacts docker images describe us-east1-docker.pkg.dev/cenariogestao/cenario-homolog/{api,web}:<SHA> --format='value(image_summary.digest)'`; VM: `operador.sh passo preparar-versao <SHA>` (antes da janela) | Digests iguais nos dois lados; `a imagem nova NÃO migra na partida`; 17 migrations na imagem; disco ≥ 3 GB; **nada reiniciado**                                                       |
| 8   | Atualizar configuração   | Feito no item 3a (arquivos) e item 9b (`cenario-tag`). Segredos/variáveis: **nenhuma mudança**                                                                                                                                       | —                                                                                                                                                                                     |
| 9   | Migrations controladas   | (a) `operador.sh passo migrar <SHA>`; (b) `operador.sh definir-etiqueta <SHA>`                                                                                                                                                       | (a) banco idêntico ao ponto, pré-verificação sem bloqueios, 5 `Applying`, `✔ migrations aplicadas`; (b) metadado = `<SHA>`. Falha em (a) ⇒ item 16                                   |
| 10  | Iniciar serviços         | `operador.sh passo ativar <SHA>`                                                                                                                                                                                                     | API `healthy`; `Saúde: OK`                                                                                                                                                            |
| 11  | Testes de saúde          | `operador.sh saude`                                                                                                                                                                                                                  | 18 ✔ (contêineres, proxy 401, HTTPS+API+banco, web, Safari/HTTP/3, certificado, backup, **17 migrations**, disco, memória)                                                           |
| 12  | Login e permissões       | §8.1 e §8.2 (gestor, tablets)                                                                                                                                                                                                        | Gestor entra; tablet sem acesso ao financeiro; rotas proibidas 403                                                                                                                    |
| 13  | Testes financeiros       | §8.3 (dados fictícios; **Pix só registrado, nunca real**)                                                                                                                                                                            | Somas conferem; estorno e duplicidade corretos                                                                                                                                        |
| 14  | Produção e tablets       | §8.2 e §8.4                                                                                                                                                                                                                          | Fila, distribuição e tempo real funcionando                                                                                                                                           |
| 15  | Critérios de abortar     | §7.1                                                                                                                                                                                                                                 | —                                                                                                                                                                                     |
| 16  | Recuperação              | §7.2                                                                                                                                                                                                                                 | —                                                                                                                                                                                     |

Ordem que minimiza a indisponibilidade: **fora da janela** 1 → 6 → 7 (`preparar-versao`) → 3a;
**na janela** 3b → 4/5 → 9a → 9b → 10 → 11 → 12–14 → decisão. A API fica fora só entre 3b e 10
(estimativa: 5–15 min + testes).

Reinício inesperado da VM durante a janela: o serviço sobe a versão de `cenario-tag`. Antes de 9b
⇒ sobe `fd6dc19` (que migraria se houvesse pendência **da sua própria** versão — não há; com o
banco já migrado, a imagem antiga lê o schema novo, sonda da Fase 8). Depois de 9b ⇒ sobe a nova,
que **recusa** iniciar se as migrations não estiverem completas. Em ambos os casos: `operador.sh
saude` e decidir entre continuar e recuperar.

### 7.1 Critérios de abortar (⇒ §7.2)

- auditoria do item 1 diverge do esperado (versão, migrations, falha, disco < 5 GB, backup inválido);
- ponto de recuperação não registrado (checksum, restauração não idêntica, bucket);
- `migrar` falhou ou pré-verificação acusou dados;
- `ativar`: API não fica `healthy` em ~5 min, ou `saude` com ✘ após uma correção de configuração;
- qualquer soma/valor financeiro divergente; valor visível em tablet; permissão indevida;
- RSS da API > 480 MB sustentado ou memória disponível da VM < 150 MB;
- tablet não sincroniza em tempo real após reconexão.

### 7.2 Runbook de recuperação

| Situação                                         | Ação                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Falha **antes** de `migrar` (itens 1–7)          | Nada mudou no banco. Se em manutenção: `operador.sh passo ativar fd6dc19` (metadado já é `fd6dc19`). Se `atualizar-config` causou problema no proxy: restaurar `/opt/cenario.anterior-<data>` e `vm.sh aplicar-config`  |
| Falha **durante** `migrar` (estado parcial)      | **Não iniciar a API.** `operador.sh passo recuperar --sim` (metadado ainda `fd6dc19`). Confere impressão idêntica, sobe `fd6dc19`, `saude`. Investigar o log `migracao-<SHA>-<data>.log` em `/var/lib/cenario`          |
| Falha de **inicialização** após migrar           | Ver `docker compose logs api`. Se for configuração: corrigir e `passo ativar <SHA>` (banco intocado, ensaio etapa 8). Se não: `definir-etiqueta fd6dc19` → `passo recuperar --sim`                                      |
| Falha **depois do uso** (testes já gravaram)     | Decisão do proprietário. Recuperar = `definir-etiqueta fd6dc19` → `passo recuperar --sim` ⇒ **perde tudo o que foi gravado após o ponto** (anotar antes). Alternativa: corrigir para frente com nova versão             |
| Recuperação recusada (“banco restaurado difere”) | Não iniciar nada. O backup de segurança do estado anterior fica em `/data/backups`; a cópia do ponto está no bucket (`trazer-backup` só copia e confere). Parar e reavaliar comigo antes de qualquer restauração manual |

Trocar só a imagem (`fd6dc19`) **não** é recuperação aceitável (§4.3).

## 8. Roteiro de testes pós-publicação (dados fictícios; Pix nunca real)

Registrar por item: aparelho, sistema, navegador, horário, resultado (OK/FALHA) e captura.

### 8.1 Gestor (MacBook, Safari)

1. Senha do proxy uma vez → tela de entrada → login do gestor de teste.
2. **OS**: criar OS fictícia com 2 peças (cliente “Teste Homologação”).
3. **Tapeceiro por peça**: definir titular de cada peça; trocar um titular (histórico registrado).
4. **Distribuição**: abrir a distribuição do plano; conferir etapas atribuídas por peça.
5. **Planejamento semanal**: publicar a semana; ver a fila de cada funcionário.
6. **Prioridades**: reordenar a fila de um funcionário com motivo → tablet atualiza sem recarregar.
7. **Estoque**: entrada e reserva de material fictício; saldo confere.
8. **Qualidade**: inspeção da peça concluída (aprovar uma, reprovar outra com motivo).
9. **Logística**: agendar retirada e entrega (endereço fictício); custo previsto aparece.
10. **Financeiro**: painel abre; mão de obra, custos logísticos e fechamento semanal abrem; CSV
    abre no Numbers com acentos.

### 8.2 Funcionários (tablets físicos; celular para logística)

| Pessoa         | Verificar                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| João           | “Cheguei”; Minha semana (atual + próximas 3 + “Ver todas”); iniciar/pausar/concluir; **não** vê “Meus valores”; nenhum valor financeiro na tela |
| Ricardo        | Tarefas das peças em que é titular; “Meus valores” **com PIN**, some sozinho; PIN errado repetido ⇒ bloqueio; não vê valores de terceiros       |
| Márcio         | Fila própria; “Tenho um problema” → ocorrência chega ao painel                                                                                  |
| Thiago         | Tarefa de apoio/ajuda; reordenação do gestor aparece em tempo real                                                                              |
| André / Izaías | Celular: só as próprias retiradas/entregas, **sem valores**; “Saí para entrega” / concluir; modo avião 1 min e voltar ⇒ reconcilia sem duplicar |

Cliente aparece reduzido (“Nome I.”) em todos os tablets.

### 8.3 Financeiro (painel do gestor/financeiro)

1. **Mão de obra por peça**: valor por peça e titular; soma = soma das peças.
2. **Privacidade**: valores só no painel autorizado e em “Meus valores” do próprio titular.
3. **Aprovação da qualidade**: mão de obra só fica elegível após aprovação; reprovada não entra.
4. **Custos de retirada/entrega**: realização constitui a obrigação do recebedor; previsto ≠ devido.
5. **Rateio**: custo de viagem com 2 OS ⇒ soma do rateio = custo; revisão gera nova versão.
6. **Fechamento semanal**: totais por pessoa = soma das obrigações; conferir; reabrir com motivo.
7. **Pagamento parcial**: registrar Pix **fictício** (só lançamento) parcial ⇒ saldo correto.
8. **Estorno**: estornar o parcial ⇒ saldo volta; histórico mostra os dois lançamentos.
9. **Duplicidade**: duplo clique / reenvio do mesmo registro ⇒ **um** lançamento só.
10. Conferir no fim: soma do fechamento = soma da mão de obra + custos logísticos da semana.

### 8.4 Dispositivos

| Dispositivo       | Verificar                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Safari no MacBook | Senha do proxy pedida uma vez por sessão; fechar/reabrir mantém a sessão (ou pede login conforme a política); janela privada |
| Safari no iPhone  | Mesmo fluxo; tela legível; indicador “Tempo real ativo”                                                                      |
| Tablets físicos   | Pareamento; sessão sobrevive a bloqueio de tela                                                                              |
| Reconexão         | Wi-Fi desligado durante uma ação e religado ⇒ ação aplicada **uma** vez                                                      |
| Tempo real        | Ação no tablet aparece no painel e vice-versa em segundos, sem recarregar                                                    |

## 9. Custos e recursos (e2-small)

| Recurso                             | Situação na atualização                                                                                                                           | Risco / custo                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| VM e2-small (2 vCPU compart., 2 GB) | Sem mudança. Limites somados 1.856 MB; uso medido no ensaio ≈ 300 MB (api 88, web 119, postgres 77); API como processo real: pico 325 MB (Fase 8) | Swap de 2 GB evita OOM; `migrar` roda com API/web paradas (sem pico duplo)                           |
| CPU                                 | `docker pull`/descompressão (~1,6–3,4 GB) e `pg_dump`/restauração de teste                                                                        | Rajadas da e2-small: `preparar-versao` **fora** da janela                                            |
| Disco pd-balanced 20 GB             | +1,6 a 3,4 GB de imagens; + backup do ponto + banco temporário da restauração de teste (≈ 2× o banco)                                             | Exigido ≥ 5 GB livres na auditoria; **manter** as imagens `fd6dc19` até o aceite (são a recuperação) |
| Cloud Build                         | 1 build (api + web) ≈ 6–10 min                                                                                                                    | Dentro da cota gratuita mensal de minutos; 429 do Docker Hub = repetir                               |
| Artifact Registry                   | +1 par de imagens (≈ 1,3–1,6 GB comprimidas); 0,5 GB grátis                                                                                       | ≈ US$ 0,10/GB-mês acima ⇒ ≈ US$ 0,15–0,30/mês com 2 versões guardadas                                |
| Bucket de backups                   | +1 backup (tamanho do banco + arquivos)                                                                                                           | Centavos                                                                                             |
| Tráfego                             | Registro → VM na mesma região                                                                                                                     | Sem custo                                                                                            |

A base anterior (VM + disco + IP + snapshots) foi estimada em ≈ US$ 19,3/mês (relatório GCP); a
atualização adiciona ≈ US$ 0,2–0,4/mês. **Fica no limite de US$ 20 sem margem**: conferir com
`bash infra/homolog/gcp/homolog.sh custos` antes. Nenhum aumento de VM, disco ou serviço é proposto.

## 10. Matriz GO / NO-GO

| Critério                                                                        | Evidência                               | Situação                        |
| ------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------- |
| Código da Evolução aprovado (Fase 8: API 377/377, E2E 27/27)                    | relatório Fase 8                        | ✔                              |
| Migrations sem migrate implícito; API recusa estado parcial                     | ensaio 2, 4b                            | ✔ (local)                      |
| Pré-verificação dos dados que fariam migration falhar                           | ensaio 0b, 5                            | ✔ (sintético)                  |
| Backup + restauração de teste idêntica antes de migrar                          | ensaio 5                                | ✔ (local)                      |
| Falha intermediária recuperável, banco idêntico ao ponto                        | ensaio 4, 4c                            | ✔ (local)                      |
| Falha de inicialização sem tocar no banco                                       | ensaio 8                                | ✔ (local)                      |
| Integridade financeira legada após migrar                                       | 22 somas idênticas; Fase 8 por valor    | ✔ (sintético)                  |
| Imagens sem segredos, versões fixas, healthchecks                               | §6                                      | ✔ (build local)                |
| Scripts de preparação testados                                                  | `test_vm_sh`, `test_homolog_sh`, ensaio | ✔                              |
| **Estado real da homologação** (versão, migrations, disco, backups, permissões) | `operador.sh auditar`                   | **NÃO VERIFICADO** — operador   |
| Pré-verificação no **banco real**                                               | idem                                    | **NÃO VERIFICADO**              |
| Imagens no Artifact Registry e digests                                          | itens 6–7                               | **NÃO EXECUTADO** (autorização) |
| Custos dentro do limite                                                         | `homolog.sh custos`                     | **NÃO VERIFICADO** — operador   |
| Testes físicos (Safari, iPhone, tablets)                                        | §8                                      | **NÃO EXECUTADO**               |

**Decisão:** **GO para a PREPARAÇÃO da publicação** (procedimento, scripts e imagens prontos e
ensaiados localmente). **Publicação: NO-GO até** (1) a auditoria só leitura real (§11) sair
conforme o esperado e (2) autorização explícita do proprietário para os itens da §12.

## 11. Comandos exatos para o Cloud Shell (somente leitura)

Nenhum destes comandos altera recursos, lê valores de segredos, executa migrations, builds,
backups ou restaurações. Única ressalva: se for o **primeiro** SSH da sua conta nesta VM, o
`gcloud compute ssh` registra a sua chave pública (já ocorreu nas etapas anteriores).

```bash
cd ~/cenario-pre-deploy && git log --oneline -1       # clone do §7, no SHA aprovado

# Auditoria completa: conta/projeto, VM, rede/firewall, Secret Manager (nomes e papéis),
# Artifact Registry (etiquetas/digests/IAM), bucket, e dentro da VM (via IAP): versões,
# contêineres, saúde, memória/disco, volumes, migrations, pré-verificação, backups, certificado.
bash infra/homolog/gcp/operador.sh auditar            # gera auditoria-homolog-<data>.txt (sem segredos)

# Auditoria de infraestrutura existente e custos com preços oficiais
bash infra/homolog/gcp/homolog.sh auditar
bash infra/homolog/gcp/homolog.sh custos
```

Equivalentes manuais (se preferir conferir item a item):

```bash
P=cenariogestao; Z=us-east1-b; VM=cenario-homolog
gcloud config get-value account; gcloud projects describe $P --format='value(lifecycleState)'
gcloud compute instances describe $VM --zone=$Z --project=$P --format=json \
  | jq -r '.status, (.machineType|split("/")|last), (.metadata.items[]|select(.key=="cenario-tag")|.value)'
gcloud compute firewall-rules list --project=$P --format='table(name,sourceRanges.list(),allowed[].map().firewall_rule().list(),targetTags.list())'
for s in homolog-postgres-password homolog-token-hash-secret homolog-admin-password homolog-proxy-password homolog-gate-token; do
  gcloud secrets get-iam-policy $s --project=$P --format='value(bindings.role)'; done
gcloud artifacts docker images list us-east1-docker.pkg.dev/$P/cenario-homolog --include-tags --project=$P
gcloud artifacts repositories get-iam-policy cenario-homolog --location=us-east1 --project=$P
gcloud compute ssh $VM --zone=$Z --project=$P --tunnel-through-iap --command='
  cat /opt/cenario/VERSAO; df -h /; free -m; sudo docker ps --format "{{.Names}} {{.Image}} {{.Status}}";
  sudo docker system df; sudo docker volume ls;
  sudo docker exec cenario-homolog-postgres-1 psql -U cenario -d cenario_homolog -At \
    -c "set default_transaction_read_only=on" \
    -c "select count(*), count(*) filter (where finished_at is null) from _prisma_migrations";
  sudo ls -lt /var/lib/docker/volumes/cenario-homolog_backups/_data | head -5'
```

**Envie-me o arquivo `auditoria-homolog-<data>.txt`** (não contém segredos) para a reavaliação.

## 12. Ações que exigem autorização adicional

| Ação                                              | Efeito                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `operador.sh build`                               | Cloud Build + imagens no Artifact Registry (custo pequeno)              |
| `operador.sh atualizar-config`                    | Grava arquivos em `/opt/cenario` e recria o proxy (segundos fora do ar) |
| `operador.sh passo preparar-versao <SHA>`         | Baixa ~1,6–3,4 GB de imagens para o disco da VM                         |
| `operador.sh passo manutencao`                    | Tira a aplicação do ar                                                  |
| `operador.sh passo ponto-recuperacao`             | Backup na VM, banco temporário de teste, envio ao bucket                |
| `operador.sh passo migrar <SHA>`                  | **Aplica as 5 migrations no banco real**                                |
| `operador.sh definir-etiqueta <SHA>`              | Muda o metadado da VM (versão do próximo boot)                          |
| `operador.sh passo ativar <SHA>`                  | Sobe a versão nova                                                      |
| `operador.sh passo recuperar --sim`               | Restaura o ponto (**perde o posterior**)                                |
| `operador.sh trazer-backup <pasta>`               | Copia backup do bucket para a VM                                        |
| Limpeza de imagens antigas na VM / no registro    | Só após aceite; remove a possibilidade de recuperação rápida            |
| Qualquer aumento de VM/disco, snapshots, serviços | Custo                                                                   |

Nada desta lista foi executado.

## 13. Incidente na homologação: “restauração de teste NÃO idêntica” (investigação e correção)

**Relato (homologação real):** configuração `4f9b1ae` instalada; imagens novas baixadas;
`ponto-recuperacao` criou o backup e conferiu o SHA-256; a restauração em `cenario_restore_check`
terminou; o comparador acusou **NÃO idêntica**; ponto **não** registrado; nenhuma migration
executada. **Não tenho acesso à VM:** a causa abaixo foi **reproduzida localmente**, não observada
na VM. A confirmação real é o passo 3 da §13.4.

### 13.1 Causa raiz (reproduzida em PostgreSQL 16 local, dados sintéticos)

O comparador antigo juntava **todo o catálogo** (gatilhos + índices + restrições) num único md5
do **texto** gerado pelo PostgreSQL (`pg_get_constraintdef`, `indexdef`). Esse texto não é estável
na **primeira** ida e volta dump/restore de um banco criado pelas migrations. O PostgreSQL reescreve
expressões equivalentes:

```
original : CHECK (((status)::text = ANY ((ARRAY['ABERTO'::character varying, …])::text[])))
restaurado: CHECK (((status)::text = ANY (ARRAY[('ABERTO'::character varying)::text, …])))
```

- O banco da homologação foi criado pelo `prisma migrate deploy` e **nunca** tinha sido restaurado.
  Reproduzido com a imagem `fd6dc19` + `backup.sh` + `restore.sh` reais: **22 restrições CHECK**
  com texto reescrito. A mesma contagem de itens do catálogo (844), md5 diferente; **todas** as tabelas,
  migrations e somas financeiras idênticas.
- O diagnóstico antigo (`cut -d'|' -f1-3`) cortava justamente o md5, então **não mostrava nada**.
- O ensaio anterior não pegou o problema porque o banco “publicado” do ensaio vinha de um
  `pg_restore` (texto já normalizado; a 2ª ida e volta é estável).
- O script antigo, rodado no mesmo banco do novo ensaio, reproduz a mensagem exata
  (`restauracao-teste/00c-ponto-script-antigo.txt`: “Diferenças …” seguida de nada).

**Outras hipóteses verificadas:**

| Hipótese                       | Resultado                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordem das linhas               | `ORDER BY r::text` já era determinística; agora com ordenação binária (`COLLATE "C"`), independente da collation do banco                                                                                                                                                                            |
| Fuso/DateStyle/formatos        | Uma configuração no nível do banco (`ALTER DATABASE … SET`), que o `pg_dump` não leva, mudaria o texto de datas. Agora fixados na sessão; teste aprova com fuso `America/Sao_Paulo` e `DateStyle SQL, DMY` no original                                                                               |
| Sequências, índices, gatilhos  | Estáveis no dump/restore; agora comparados item a item                                                                                                                                                                                                                                               |
| Gravações durante a comparação | API/web paradas na manutenção; o serviço `backup` só faz `pg_dump` (leitura) e o timer de envio não toca no banco. Ainda assim a impressão do original agora é tirada **antes** do backup e **depois** da conferência; se mudou, o resultado é “original mudou” (código 2), com as conexões listadas |
| Escolha do backup              | **Defeito real, independente:** `ls -1d cenario-* \| tail -1` escolhe pelo **nome**. Uma pasta com nome que ordene depois (ex.: `cenario-staging-2999…`, `cenario-zz…`) seria comparada no lugar do backup recém-criado. Corrigido: a pasta vem da saída do próprio `backup.sh`                      |
| `recuperar` com a mesma causa  | **Defeito latente:** `recuperar` comparava o banco restaurado com o md5 do original e **recusaria uma recuperação legítima** na VM. Corrigido (§13.2)                                                                                                                                                |

### 13.2 Correção (sem afrouxar a verificação)

- `sql/impressao-digital.sql`: 3.313 itens em vez de 1 linha de catálogo: conteúdo de cada tabela,
  cada coluna (tipo, nulidade, identidade, collation, posição), cada restrição/índice/gatilho
  pela **estrutura** (colunas, referências, ações, validação, sem texto), funções (md5 do corpo),
  tipos/enums, **sequências** (antes não comparadas), definições em texto (`def-*`), migrations e
  as 22 somas financeiras. A saída é determinística (fuso, formatos, `search_path` e ordenação fixos).
- `conferencia-restauracao.sh`: aprova **só se**:
  1. o original não mudou durante a conferência;
  2. dados, estrutura, sequências, migrations e financeiro da restauração forem **iguais** ao original;
  3. as definições `def-*` forem o mesmo conjunto e, em texto, **iguais** às de uma restauração
     **só de esquema** do original feita na mesma hora (banco `cenario_restore_ref`, separado);
  4. a referência reproduzir a estrutura do original.

  Diferenças são listadas item a item. Nas tabelas aparecem só as colunas divergentes e as chaves
  técnicas (uuid/inteiro), nunca valores; nas somas financeiras aparecem os totais.

- `vm.sh ponto-recuperacao`: impressão antes do backup; pasta tirada da saída do backup; grava a
  impressão esperada de qualquer restauração daquele backup (`ponto-restaurado.impressao`, com
  md5 no arquivo do ponto). `recuperar` compara com ela, e um ponto antigo sem esse arquivo é
  recusado.
- `restaurar-teste` sem pasta usa o backup mais recente **por data**; `saude` também.
- Nenhuma mudança na aplicação nem nas imagens: as imagens `4f9b1ae` já baixadas continuam válidas
  (o código da aplicação é o mesmo); **não é preciso novo build**.

### 13.3 Testes

- `testes/test_conferencia_restauracao.sh`. PostgreSQL 16 alpine (como a VM), migrations aplicadas
  diretamente, scripts reais de backup e restauração. Resultado: **todos os cenários OK**
  (`restauracao-teste/test_conferencia_restauracao.txt`):
  - o comparador antigo reproduz a falha;
  - o novo aprova e lista as 22 reescritas;
  - fuso/DateStyle do banco não interferem;
  - **recusa e localiza** 14 alterações reais: +1 centavo, texto de linha, linha a menos, linha a
    mais, índice, chave estrangeira, CHECK com mesmo nome, gatilho desativado, sequência,
    migration desfeita, padrão, tipo de coluna, tabela removida, outra coluna financeira;
  - gravação no original durante a conferência → código 2;
  - backup corrompido → recusado pelo SHA-256, destino intocado;
  - com uma isca de nome posterior, a pasta usada é a do backup recém-criado;
  - o diagnóstico não mostra valores de linhas.
- Ensaio completo com a pilha real e o `vm.sh` novo, banco criado pelas migrations da `fd6dc19` e
  isca de backup: **`ENSAIO: OK`** (`restauracao-teste/ensaio-atualizacao.txt`). Destaques:
  - etapa 0c: o script antigo falha como na VM;
  - etapa 4: o 1º ponto aprova, com 22 definições reescritas listadas;
  - etapas 4c e 9: `recuperar` passa a comparar com a impressão esperada;
  - etapa 5: o ponto usa a pasta do próprio backup, não a isca.
- `test_vm_sh.sh` e `test_homolog_sh.sh`: todos OK.

### 13.4 Procedimento seguro na homologação (SÓ COM AUTORIZAÇÃO, um passo por vez)

Estado esperado: configuração `4f9b1ae` na VM, API/web em manutenção, sem ponto, banco com 12
migrations. O backup da tentativa que falhou fica onde está (nada é apagado).

```bash
# 0. Cloud Shell: clone no SHA desta correção (ver §1 / mensagem de entrega)
cd ~/cenario-pre-deploy && git fetch origin claude/cenario-gestao-fase-1-zf3bj2
git checkout --detach <SHA-FINAL> && git log --oneline -1 && git status --short    # limpo

# 1. SOMENTE LEITURA — confirma o estado e o indício da causa no banco real (nada é alterado)
bash infra/homolog/gcp/operador.sh auditar
gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap --command='
  sudo docker exec cenario-homolog-postgres-1 psql -U cenario -d cenario_homolog -At \
    -c "set default_transaction_read_only = on" \
    -c "select count(*) from pg_constraint where pg_get_constraintdef(oid) like '\''%])::text[])%'\''" \
    -c "select count(*), count(*) filter (where finished_at is null) from _prisma_migrations";
  sudo ls -1t /var/lib/docker/volumes/cenario-homolog_backups/_data | head -5'
#    Esperado: 1ª contagem > 0 (CHECKs com o texto que a restauração reescreve); 12|0; o backup da
#    tentativa no topo. Se a 1ª contagem for 0, a causa provável é outra: NÃO prossiga, envie-me a saída.

# 2. (AUTORIZAÇÃO) Leva à VM os scripts corrigidos; recria SÓ o proxy; guarda a cópia anterior.
#    Com a manutenção ativa, a "saude" ao final acusa API/web paradas: esperado.
bash infra/homolog/gcp/operador.sh atualizar-config

# 3. (AUTORIZAÇÃO) Confirma a causa no backup REAL da tentativa, sem tocar no original:
#    restaura em bancos separados (cenario_restore_check / cenario_restore_ref), confere e apaga os dois.
gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap \
  --command='sudo /opt/cenario/infra/homolog/gcp/vm.sh restaurar-teste <pasta-do-backup-da-tentativa>'
#    Esperado: "✔ dados, estrutura, … IGUAIS", "• N definição(ões) com texto reescrito",
#    "✔ Restauração de teste … IDÊNTICA". Qualquer "✘": PARE e me envie a saída (não contém
#    valores de linhas nem segredos).

# 4. (AUTORIZAÇÃO) Novo ponto de recuperação (novo backup + conferência + bucket)
bash infra/homolog/gcp/operador.sh passo ponto-recuperacao
#    Esperado: "• pasta deste backup: cenario-staging-<agora>", "✔ … IDÊNTICA",
#    "✔ PONTO DE RECUPERAÇÃO: …". Anote a pasta.

# 5. PARE. migrar / definir-etiqueta / ativar exigem nova autorização (runbook §7, itens 9–16).
#    Se for interromper aqui: operador.sh passo ativar fd6dc19 (volta ao ar sem migrar).
```

A etiqueta das imagens nos passos seguintes continua `4f9b1ae` (`passo migrar 4f9b1ae`,
`definir-etiqueta 4f9b1ae`, `passo ativar 4f9b1ae`).
