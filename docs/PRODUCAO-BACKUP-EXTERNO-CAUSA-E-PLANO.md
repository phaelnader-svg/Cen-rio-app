# Backup externo da produção — causa, evidências e plano de correção

Situação: **investigação concluída, somente leitura. Nenhuma correção executada.** Não houve backup
criado, envio, mudança de permissão, reinício nem alteração na produção.

Fontes:

- verificação do dono no Cloud Shell (R-4);
- `PRODUCAO-INVESTIGACAO-BACKUP-EXTERNO.md`: leitura pela conta `claude-operador-prod`, das 18:24 às
  18:26 UTC de 13/11;
- evidências em `docs/evidencias/producao-investigacao-backup/`;
- análise do código nesta sessão.

## 1. Causa (confirmada)

**É um defeito de configuração da VM, presente desde a preparação da produção, e não uma falha de
envio.**

`infra/prod/gcp/startup.sh` cria o serviço de envio `cenario-backup-upload.service` com a condição
`ConditionPathExists=/etc/cenario/publicacao-autorizada`, ou seja, **o portão de publicação**. Esse
portão fica **fechado de propósito** na operação normal: ele só é aberto durante deploys e
operações de manutenção.

Resultado: o timer diário dispara às 07:30 UTC, o systemd **pula** o serviço, e nada é enviado ao
bucket. O envio só aconteceu nas raras vezes em que o portão estava aberto e alguém criou um ponto
de recuperação, como no deploy de 23/10 às 01:17 UTC.

O comando de envio (`vm.sh enviar-backups`) **não precisa** do portão. Ele não lê segredos nem
inicia nada: usa o token da conta da VM e só **cria** objetos no bucket. A condição foi herdada do
serviço da pilha, onde faz sentido, e é excessiva aqui.

O mesmo defeito existe na **homologação** (`infra/homolog/gcp/startup.sh`). Hoje, o backup diário
da homologação só subiu ao bucket junto com o ponto de recuperação do R-1.

## 2. Evidências

| #   | Pergunta                     | Evidência                                                                                                                                                                                                                                                            | Resultado                                            |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Rotina de backup na VM       | `backup_list`: 28 pastas locais, uma por dia às ~16:41 UTC, com o contêiner `backup`. A mais recente, de 13/11, conferiu o SHA-256                                                                                                                                   | **Funciona**                                         |
| 2   | Agendamento                  | O timer `cenario-backup-upload.timer` (07:30 UTC, `Persistent=true`) existe e dispara todo dia                                                                                                                                                                       | **Funciona**; o serviço que ele aciona é pulado      |
| 3   | Logs das execuções           | Journal de 07/11 a 13/11 (7 dias, o máximo disponível): 7 linhas, todas `skipped because of an unmet condition check (ConditionPathExists=/etc/cenario/publicacao-autorizada)`. Nenhuma execução, nenhum erro HTTP                                                   | **Causa confirmada**                                 |
| 4   | Permissões da conta          | A VM usa `cenario-prod-vm@…`, com escopo `cloud-platform`. A chave `cenario-bucket` existe nos metadados. O envio de 23/10 funcionou (6 objetos), então a criação de objetos estava permitida. A política IAM do bucket **não foi lida** (fora do escopo autorizado) | Sem indício de problema de permissão                 |
| 5   | Backups locais mais recentes | **22 pastas posteriores a 23/10 01:17 UTC** (de 23/10 16:41 a 13/11 16:41), **sem cópia externa**                                                                                                                                                                    | Confirmado                                           |
| 6   | Falhas de envio              | Nenhuma tentativa de envio desde 07/11, porque o serviço não chega a rodar. As 6 pastas locais até 23/10 01:17 batem com os 6 objetos do bucket                                                                                                                      | Não houve falha: não houve tentativa                 |
| 7   | Snapshots                    | 14 snapshots `READY` (até 13/11), com a política `cenario-prod-diario` ligada ao disco. Está coerente com a retenção projetada de 14 dias. A leitura da retenção configurada deu 403 para o operador                                                                 | **Funciona**; confirmar a retenção com o comando 7.3 |

## 3. Risco atual

- **Cópia externa desatualizada há 21 dias.** Se o disco da VM se perder, a recuperação depende dos
  snapshots: o mesmo projeto e região, com 14 dias de profundidade.
- **Prazo de perda de backups.**
  - A rotina local apaga pastas com mais de 30 dias (`BACKUP_RETENTION_DAYS=30`, `find -mtime +30`).
  - A primeira pasta **sem cópia externa** (`20261023T164125Z`) será apagada por volta de **24/11
    às 16:41 UTC**. A partir daí, os backups de 23/10 em diante se perdem um por dia, sem nunca ter
    tido cópia fora da VM.
  - **A recuperação dos envios precisa acontecer antes de 24/11.**
- **Deploy.** O `recovery_point_create` do deploy envia ao bucket todas as pastas pendentes, e o
  ponto **falha** se o envio falhar. Esse passo já serve de verificação. Ainda assim, o envio
  diário precisa voltar a funcionar independentemente dos deploys.

## 4. Plano de correção (aguardando autorização)

### 4.1 Emergencial: enviar agora os 22 backups pendentes

| Opção               | Como                                                                                                                          | Altera                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **A (recomendada)** | Você, por SSH (IAP), no Cloud Shell: `sudo /opt/cenario/infra/prod/gcp/vm.sh enviar-backups`                                  | Só cria objetos no bucket e grava a lista de enviados na VM. Não cria backup, não abre o portão, não reinicia nada |
| B                   | Eu, pelo runner da produção: `gate_open` → `backup_create` (cria **1 backup novo** e envia todos os pendentes) → `gate_close` | Abre o portão por ~1 min e cria um backup novo. Não há indisponibilidade                                           |

Depois de qualquer das duas, valide com o **comando 1 do R-4**. Ele deve listar ~28 objetos, com o
mais recente de hoje, e mostrar `RESULTADO: ÍNTEGRO`.

### 4.2 Definitivo: o envio diário independente do portão

1. **Código** (`infra/prod/gcp/startup.sh` e `infra/homolog/gcp/startup.sh`):
   - tirar `ConditionPathExists=$PORTAO` **só** da unidade `cenario-backup-upload.service`;
   - manter a exigência de que o script exista (`ConditionPathExists=/opt/cenario/…/vm.sh`);
   - manter o portão na unidade da pilha;
   - atualizar o comentário do cabeçalho.

   Antes do primeiro deploy, o envio continua inofensivo: sem volume de backups, ele sai com "nada a
   enviar".

2. **Detecção.** Acrescentar ao `vm.sh saude`, que alimenta o `smoke_test`, a verificação "último
   envio ao bucket há ≤ 36 h". Ela usa um carimbo gravado pelo `enviar_backups` a cada sucesso.
   Assim, uma interrupção como esta aparece no smoke diário, em vez de passar 21 dias despercebida.
3. **Testes.** `infra/prod/gcp/testes/test_provisionar.sh` e os testes de `startup.sh`/`vm.sh`
   precisam provar quatro coisas:
   - a unidade de envio não tem a condição do portão;
   - a pilha continua com ela;
   - o envio com o portão fechado funciona;
   - a verificação nova acusa um envio atrasado.
4. **Aplicação na VM.** O `startup.sh` é idempotente e reescreve só as unidades; ele não reinicia a
   pilha. A sequência é:
   1. você publica o pacote `scripts-<commit>.tar.gz` da versão corrigida no bucket de versões. Só
      um humano pode gravar nesse bucket;
   2. `vm_scripts_diff` (leitura): mostra exatamente o que muda em `/opt/cenario`;
   3. `vm_scripts_update` com a versão corrigida (DESTRUCTIVE: troca os scripts de `/opt/cenario`,
      com cópia de segurança e retorno por `vm_scripts_restore`);
   4. reexecutar `startup.sh` como root, pela sua sessão SSH (`provisionar.sh preparar-vm`), e
      depois `systemctl daemon-reload`.

   Não há indisponibilidade.
   - **Atenção:** `vm_scripts_update` instala **todo** o `infra/prod` da versão escolhida. A partir
     de `696e3e9`, isso inclui a página comercial `/conheca` (`SITE_COMERCIAL=1`).
   - Para não misturar decisões, a correção deve ir sobre os scripts atuais da VM (`c32df97`) ou
     você decide a `/conheca` junto.

5. **Validação.** No dia seguinte, `application_logs unit=cenario-backup-upload` deve mostrar a
   execução das 07:30 com "✔ … enviado", e o comando 1 do R-4 deve listar o objeto do dia.

Repetir o mesmo na homologação, com a mesma correção.

### 4.3 O que não muda

- Nenhuma permissão nova: a conta da VM continua só **criando** objetos.
- Nenhuma mudança no banco, na aplicação ou nos backups existentes.
- A retenção de 90 dias no bucket e de 30 dias na VM fica igual.

## 5. Comandos de leitura complementares (opcionais, no Cloud Shell)

```bash
# 7.3 — retenção configurada da política de snapshots
gcloud compute resource-policies describe cenario-prod-diario --region=southamerica-east1 --project=cenariogestao \
  --format="yaml(snapshotSchedulePolicy.schedule,snapshotSchedulePolicy.retentionPolicy)"
# regras do bucket (retenção de 90 dias e versões apagadas)
gcloud storage buckets describe gs://cenariogestao-prod-backups --format="yaml(lifecycle_config,soft_delete_policy,retention_policy)"
```

## 6. Decisões pedidas

1. Envio emergencial: **opção A** (você, por SSH) ou **opção B** (eu, pelo runner, com o portão
   aberto por ~1 min). O prazo é antes de 24/11.
2. Autorizar a correção definitiva (seção 4.2):
   - código e testes num commit próprio;
   - aplicação na produção e na homologação;
   - escolha entre manter a `/conheca` desligada (correção sobre `c32df97`) ou decidi-la junto.
