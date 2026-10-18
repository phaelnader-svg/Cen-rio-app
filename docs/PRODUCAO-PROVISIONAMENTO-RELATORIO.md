# Relatório — provisionamento do ambiente de produção

## 1. Classificação: **PRODUÇÃO NÃO PROVISIONADA**

A infraestrutura de produção está **pronta como código**, documentada e testada localmente. Isso inclui
um ensaio real do primeiro deploy, com as imagens de `9fb1786`, 31 migrations, restauração idêntica e
rollback.

**Nenhum recurso foi criado no Google Cloud** e o DNS não foi alterado. A conta desta sessão
(`claude-operador`, da homologação) foi criada sem permissão para criar VM, rede, IAM, segredo ou bucket.
Ampliar essa conta é proibido pela própria autorização. Por isso existe uma barreira humana inevitável
(seção "Ação humana").

O primeiro deploy de `9fb1786` **não** foi feito: os gates de infraestrutura, DNS e operador ainda não
existem.

| #   | Item                          | Situação                                                                                                                                                                                                                                     |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | Projeto GCP                   | `cenariogestao` (o mesmo da homologação, com separação por recurso, identidade e permissão)                                                                                                                                                 |
| 3   | Região                        | `southamerica-east1`                                                                                                                                                                                                                         |
| 4   | Zona                          | `southamerica-east1-b`                                                                                                                                                                                                                       |
| 5   | VM                            | `cenario-prod` — **a criar** por `provisionar.sh`                                                                                                                                                                                           |
| 6   | Machine type                  | e2-medium                                                                                                                                                                                                                                    |
| 7   | CPU/RAM                       | 2 vCPU compartilhadas / 4 GB                                                                                                                                                                                                                 |
| 8   | Disco                         | 50 GB pd-balanced, não apagado com a VM; snapshots diários (14 dias)                                                                                                                                                                         |
| 9   | IP                            | `cenario-prod-ip`, estático — **a reservar** (o valor só existe depois do provisionamento)                                                                                                                                                  |
| 10  | Domínio                       | `cenariogestao.com.br` (canônico); `www` → 301 para o canônico                                                                                                                                                                              |
| 11  | DNS                           | **Não alterado.** Não deu para consultar os registros daqui (o proxy bloqueia DNS). `provisionar.sh dns` prova os registros atuais (8.8.8.8 e 1.1.1.1) antes de qualquer mudança e mostra só `A @` e `CNAME www`. `teste` não é tocado. |
| 12  | HTTPS/certificado             | Caddy com Let's Encrypt, depois do DNS; HSTS; HTTP→HTTPS 308; sem HTTP/3                                                                                                                                                                     |
| 13  | Caddy                         | `infra/prod/Caddyfile.prod`, separado da homologação; validado com `caddy validate`                                                                                                                                                         |
| 14  | Containers                    | postgres, api, web, caddy e backup (`infra/prod/docker-compose.prod.yml`, projeto `cenario-prod`, rede 172.29.0.0/24, limites de memória)                                                                                                  |
| 15  | Banco                         | PostgreSQL `cenario_prod` em volume próprio, sem porta publicada                                                                                                                                                                             |
| 16  | Banco novo                    | Sim, por projeto: `iniciar-banco` cria um volume vazio. Nenhuma cópia ou restauração da homologação existe no fluxo.                                                                                                                         |
| 17  | Migrations                    | Só pelo repositório (31, `migrate` explícito; `MIGRATE_ON_START=0`). No ensaio: 31 pendentes → 31 aplicadas, nada divergente.                                                                                                               |
| 18  | Seed/bootstrap                | **Não executado em produção.** Projeto: só as classes A, B e o gestor (C), com `SEED_TEAM=false`. A equipe de exemplo é excluída.                                                                                                           |
| 19  | Sem dados sintéticos          | Garantido: `vm.sh semear` recusa um banco com mais de 1 funcionário e confere 1 funcionário, 1 usuário e 0 clientes, pedidos, OS ou dispositivos (ensaio: OK)                                                                               |
| 20  | Secrets novos                 | `prod-postgres-password`, `prod-token-hash-secret` e `prod-admin-password`, gerados no Cloud Shell e passados pela entrada padrão. Nenhum valor aparece em Git, log, argumento ou relatório (testado). **Ainda não criados.**                 |
| 21  | Operador de produção          | `claude-operador-prod`: papéis próprios no nível da instância, fila, buckets e audiência `cenario-prod-runner`. Runner 2.2.0 com o perfil `prod`. **Ainda não criado.**                                                                      |
| 22  | Isolamento homolog/prod       | Testado: cada runner recusa a identidade, a audiência, a VM e o bucket do outro, e o perfil incoerente na partida; `provisionar.sh verificar` reprova uma ligação cruzada                                                                    |
| 23  | IAM                           | Mínimo: a VM tem `logWriter`, leitura de 3 segredos, só criação no bucket e leitura do registro. Owner, Editor, storage.admin e qualquer ligação com "homolog" são recusados.                                                                |
| 24  | Firewall                      | `cenario-prod-web`: 80/443; `cenario-prod-iap-ssh`: 22 só do IAP 35.235.240.0/20. Postgres nunca exposto.                                                                                                                                  |
| 25  | Backup                        | Diário (banco e arquivos, SHA-256), enviado a `gs://cenariogestao-prod-backups` só por criação                                                                                                                                              |
| 26  | Retenção                      | 30 dias na VM, 90 dias no bucket, snapshots por 14 dias                                                                                                                                                                                      |
| 27  | Validação do backup           | `backup_validate` — ensaio: OK                                                                                                                                                                                                                |
| 28  | Restore test                  | Em bancos separados, por impressão digital — ensaio: IDÊNTICO                                                                                                                                                                                 |
| 29  | Recovery point                | Criado antes das migrations, mesmo com o banco vazio — ensaio: OK                                                                                                                                                                             |
| 30  | Rollback                      | `rollback_version` / `rollback_to_recovery_point` — ensaio: rollback ao ponto OK                                                                                                                                                              |
| 31  | Logs                          | Docker json-file 20 MB × 5; `container_logs`/`application_logs`; auditoria do runner no bucket de operações                                                                                                                                  |
| 32  | Health                        | `vm.sh saude`: contêineres, ready, `production`, acesso, certificado, backup, migrations, disco e memória (ensaio: OK)                                                                                                                       |
| 33  | WebSocket                     | 401 sem sessão e 101 com sessão (ensaio: OK)                                                                                                                                                                                                  |
| 34  | Disco                         | Alerta em 80%; `preparar-versao` exige 10 GB livres; limpeza protege as versões ativa e anterior e o ponto de recuperação                                                                                                                    |
| 35  | Custo mensal                  | ~US$ 52–58 (detalhe em `docs/PRODUCAO.md` §12)                                                                                                                                                                                              |
| 36  | Arquivos                      | `docs/PRODUCAO.md`, `infra/prod/**`, runner 2.2.0, `operar.py` (`CENARIO_AMBIENTE=prod`), testes e evidências em `docs/evidencias/producao/`                                                                                               |
| 37  | SHA publicado                 | **Nenhum** (gates não satisfeitos). O alvo continua `9fb1786beddae28c34b20a0922b42989ecb0fbf2`.                                                                                                                                             |
| 38  | Prova do SHA ativo            | Não aplicável. As imagens são promovidas pelo digest homologado (api `sha256:6e4a225d…f848`, web `sha256:7b99ebc1…f822`).                                                                                                                  |
| 39  | Migrations ativas             | Não aplicável (só no ensaio: 31/31)                                                                                                                                                                                                           |
| 40  | Smoke                         | Não aplicável (ensaio: acesso e login do gestor OK)                                                                                                                                                                                           |
| 41  | Fingerprint                   | Não aplicável (ensaio: idêntico após a restauração)                                                                                                                                                                                           |
| 42  | Caveats                       | (a) O `claude-operador` da homologação tem `compute.viewer`/`logging.viewer` no projeto: ele **vê** os metadados não secretos da VM de produção, sem operar. Removê-los muda a homologação, e a decisão é sua. (b) A promoção das imagens e o DNS não são verificáveis daqui. |
| 43  | Homologação intacta           | Sim: `teste.cenariogestao.com.br`, `9fb1786`, 31/31, banco e operador atuais. Nada criado, alterado ou limpo. Suítes da homologação sem regressão.                                                                                          |
| 44  | Sem dados comerciais reais    | Sim (não existe banco de produção)                                                                                                                                                                                                            |
| 45  | Ação humana                   | Uma (abaixo)                                                                                                                                                                                                                                  |

## Ação humana

**O que falta:**

- criar os recursos de produção no GCP: VM, rede, firewall, IP, segredos, buckets, registro, conta da
  VM e operador;
- promover as imagens;
- apontar o DNS na Hostinger;
- colocar a credencial do `claude-operador-prod` num ambiente novo do Claude Code.

**Por que não pode ser automatizado daqui:**

- A única identidade desta sessão é o operador da homologação, criado intencionalmente sem poderes
  administrativos. Usá-la ou ampliá-la para criar a produção violaria o isolamento exigido.
- A Hostinger não é alcançável a partir daqui.
- Os Network Secrets são definidos por você, por ambiente.
- A publicação do runner é, por projeto, uma barreira humana.

**Ação única:**

1. No Cloud Shell do projeto `cenariogestao`, com a sua conta de proprietário, na raiz do repositório
   (branch `claude/cenario-gestao-fase-1-zf3bj2`), execute:

   ```
   bash infra/prod/gcp/provisionar.sh tudo
   ```

2. Siga as confirmações. O script prova o DNS atual antes de pedir a mudança na Hostinger e entrega a
   chave para o Network Secret de um **ambiente novo** do Claude Code. Depois, ele apaga a chave local.

**Como comprovar:**

1. No Cloud Shell, execute `bash infra/prod/gcp/provisionar.sh verificar`. Ele deve mostrar
   `ISOLAMENTO: OK`.
2. Numa sessão nova, no ambiente de produção, execute
   `CENARIO_AMBIENTE=prod python3 infra/homolog/gcp/autonomia/operar.py verificar`. Ele deve identificar
   `cenario-prod`, o runner 2.2.0 com o perfil `prod`, o portão fechado e nada iniciado.

A partir daí, o primeiro deploy de `9fb1786` segue o runbook de `docs/PRODUCAO.md` §9, gate a gate.
