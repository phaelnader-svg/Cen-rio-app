# Produção com banco limpo (`696e3e9`) — pacote, ensaio local e veredito

Situação: **pacote pronto e ensaio local aprovado. Nada foi feito na produção.**

Na produção:

- nenhuma escrita;
- nenhum reinício;
- nenhuma migration;
- volume `pgdata` intocado;
- nenhum script novo instalado.

Evidências: `docs/evidencias/producao-ensaio-banco-limpo/`.

## Veredito: **GO COM RESSALVAS**

O procedimento está comprovado de ponta a ponta. **As pendências bloqueantes são só 3**, todas
externas ao código (seção 5).

## 1. Pacote de scripts do deploy

| Item            | Valor                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / commit | `claude/deploy-banco-limpo` · **`9ff142e274b1cc04953bbfb5161a7940962530d5`**                                                                                           |
| Base            | `2f078850696c`: scripts atuais da VM (`c32df97`) + correção do envio de backups; **sem `/conheca`**                                                                    |
| Pacote          | `scripts-9ff142e274b1.tar.gz` (sha256 de referência `c8c293b1…028cdc`)                                                                                                 |
| Mudança efetiva | **1 linha** do Compose: o PostgreSQL monta `pgdata_2026_11` em vez de `pgdata`. O `pgdata` continua declarado, com um comentário "nunca remover sem decisão explícita" |
| Outros arquivos | 2 testes: `test_deploy_banco_limpo.sh` e `ensaio-deploy-banco-limpo.sh`                                                                                                |

**Teste `test_deploy_banco_limpo.sh`: 13/13 ✔.** Ele compara a configuração **resolvida** do Compose
(com `docker compose config`) entre a base e o pacote:

- o PostgreSQL usa só o volume novo;
- api, web, caddy e backup estão **idênticos**;
- web sem `SITE_COMERCIAL` (a `/conheca` continua desligada);
- **nenhuma outra diferença**;
- `pgdata` continua declarado;
- o `vm.sh` nunca remove volumes;
- no Git, só mudam o Compose e os 2 testes.

**Ele reprova as versões erradas:**

| Versão errada                         | Resultado |
| ------------------------------------- | --------- |
| Sem a troca de volume                 | 5 falhas  |
| Com a `/conheca` ligada               | 3 falhas  |
| Com o `pgdata` removido da declaração | 1 falha   |

**Regressão:** `test_vm_sh_prod.sh` 90/90 e `test_provisionar.sh` 48/48.

## 2. Ensaio local completo (`ensaio-deploy-banco-limpo.sh`): **OK, 0 falhas**

Pilha real de produção, com imagens construídas da fonte de `7b4177b` (atual) e de `696e3e9`
(nova), e os `vm.sh` reais de antes e depois. Executado em 13/11, às 22:08 UTC.

| Etapa                          | Resultado                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **E1** Produção atual simulada | `7b4177b` no volume `pgdata`: 33 migrations, gestor e 3 clientes marcadores; login OK    |
| **E2** Deploy                  | Ver a lista abaixo da tabela                                                             |
| **E3** Falha simulada          | API derrubada depois da ativação: a saúde **reprova** ("contêiner api: ausente")         |
| **E4** Retorno                 | Ver a lista abaixo da tabela                                                             |
| **E5** Novo deploy             | Volta ao volume novo: banco novo **idêntico** ao de antes do retorno, login do gestor OK |

**E2 — deploy, nesta ordem:**

1. manutenção;
2. scripts novos;
3. **"banco NOVO (nenhuma tabela)"** no volume novo;
4. ponto de recuperação do banco vazio, com restauração idêntica;
5. preflight: **37 pendentes**, sem divergência;
6. **37/37 aplicadas**;
7. ativação;
8. `semear`: **1 usuário (o gestor), 0 clientes, 0 OS**;
9. login do gestor com a senha do bootstrap;
10. saúde e acesso OK.

**E4 — retorno, nesta ordem:**

1. manutenção;
2. scripts anteriores;
3. **volume antigo intocado durante todo o deploy**: hash do conteúdo idêntico antes e depois;
4. o PostgreSQL volta ao volume antigo ("já tem 119 tabelas");
5. preflight da versão antiga OK;
6. `7b4177b` ativa;
7. **dados antigos IDÊNTICOS**: 112 tabelas de negócio, os 3 marcadores presentes, login OK;
8. **volume novo preservado**.

O ensaio só falhou nas duas primeiras execuções porque o próprio teste inseria os clientes marcadores
sem colunas obrigatórias. Depois da correção do teste, a terceira execução passou sem falhas.

## 3. Indisponibilidade estimada

| Trecho                                                 | Ensaio local (medido) | Produção (estimado)                                                                                      |
| ------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------- |
| Deploy: manutenção → versão nova ativa e gestor criado | **42 s**              | **5 a 8 min**: o runner leva de 5 a 25 s por operação, e o ponto de recuperação faz restauração de teste |
| Retorno, se necessário                                 | **29 s**              | **3 a 5 min**                                                                                            |
| Janela a reservar                                      | —                     | **30 min**, fora do expediente, mais o recadastro da equipe (~30 a 45 min, com o sistema já no ar)       |

O download das imagens (`prepare_version`) e o backup final do banco antigo acontecem **antes** da
manutenção, sem indisponibilidade.

## 4. Procedimento final

**Suas intervenções manuais: 2 blocos no Cloud Shell antes da janela, 1 SSH depois e o recadastro
pela interface.**

### 4.1 Antes da janela: você, no Cloud Shell

```bash
cd <seu clone>; git fetch origin claude/deploy-banco-limpo && git checkout 9ff142e274b1cc04953bbfb5161a7940962530d5

# (1) promover as imagens homologadas de 696e3e9 para a produção (exige os digests autorizados)
bash infra/prod/gcp/promover-imagens.sh 696e3e9ddc5f1c803a4b9244a075ed498ad81be3 \
  sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f \
  sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72

# (2) publicar o pacote de scripts do deploy (só cria objetos no bucket de versões)
SVER=$(git rev-parse HEAD | cut -c1-12); T=$(mktemp -d)
git archive --format=tar HEAD infra/prod scripts/backup.sh scripts/restore.sh | gzip -n -9 > "$T/scripts-$SVER.tar.gz"
sha256sum "$T/scripts-$SVER.tar.gz" | cut -d' ' -f1 | tee "$T/scripts-$SVER.sha256"
gcloud storage cp "$T/scripts-$SVER.tar.gz" "$T/scripts-$SVER.sha256" gs://cenariogestao-prod-runner-versoes/ \
  --project=cenariogestao --if-generation-match=0
```

Confirme também que você tem acesso à senha **inicial** do gestor (`prod-admin-password` no Secret
Manager). O gestor novo nasce com ela.

### 4.2 Pelo runner: eu, com sua autorização de escrita para `claude-operador-prod`

| Momento    | Operações                                                                                                          | Para se…                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Antes      | `verificar`, `imagens 696e3e9…`, `vm_scripts_diff version=9ff142e274b1`                                            | Imagens ausentes ou com outro digest; diff além do Compose, do `vm.sh`/`startup.sh` da correção e dos testes |
| Antes      | `gate_open` → `prepare_version 696e3e9…` → `backup_create` (banco antigo, com envio ao bucket) → `gate_close`      | Digest diferente; disco < 10 GB; envio com erro                                                              |
| **Janela** | `gate_open` → **`maintenance_on`** → `vm_scripts_update version=9ff142e274b1` → `stack_bootstrap version=696e3e9…` | Sem "banco NOVO (nenhuma tabela)" → retorno                                                                  |
| Janela     | `recovery_point_create` → `migration_precheck` → `migrate` → `activate_version` → `seed_bootstrap`                 | Diferente de 37 aplicadas, API sem saúde ou seed diferente de "só o gestor" → retorno                        |
| Janela     | `gate_close` → `smoke_test`, `websocket_test`, `run_homologation_tests completo`, `database_counts`                | Qualquer ✘ crítico → retorno                                                                                 |

**Retorno, testado no ensaio E4:**

1. `gate_open` → `maintenance_on`;
2. `vm_scripts_restore`;
3. `stack_bootstrap version=7b4177b…`;
4. `rollback_version 7b4177b…`;
5. `gate_close`.

### 4.3 Depois da janela: você

1. **SSH**, para aplicar a unidade corrigida do envio de backups (o mesmo passo validado na
   homologação), com o portão fechado:

   ```bash
   gcloud compute ssh cenario-prod --zone=southamerica-east1-b --tunnel-through-iap
   test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO — PARE" || sudo bash /opt/cenario/infra/prod/gcp/startup.sh
   sudo systemctl start cenario-backup-upload.service && sudo /opt/cenario/infra/prod/gcp/vm.sh envio-externo; exit
   ```

2. **Pela interface:**
   - entrar como gestor e trocar a senha;
   - cadastrar a equipe e os PINs;
   - vincular os tablets;
   - preencher os dados da empresa.

**Simplificação.** O pacote do deploy já contém a correção do envio de backups. Se o deploy for nos
próximos dias, **não é preciso instalar a correção separadamente antes**: ela entra no mesmo
`vm_scripts_update`, e o SSH do 4.3 acontece uma vez só. Os 22 backups pendentes já estão no bucket.
Até o deploy, os novos backups ficam só na VM: repita o envio emergencial se passar de alguns dias.

## 5. Pendências realmente bloqueantes

1. **Autorização de escrita para `claude-operador-prod` e autorização do deploy.** São suas e
   separadas.
2. **Acesso à senha inicial do gestor** (`prod-admin-password`). Sem ela, não há login depois do
   deploy.
3. **Validação automática da correção de backup na homologação**, nas execuções de 14/11 e 15/11 às
   07:30 UTC (acompanhamento agendado). Se falhar, a correção entra no deploy, mas o SSH do 4.3 vira
   investigação.

**Não bloqueiam:**

- o roteiro mínimo de 45 min na homologação (recomendado, sua decisão);
- a lista da equipe e dos tablets para o recadastro;
- a escolha do horário.
