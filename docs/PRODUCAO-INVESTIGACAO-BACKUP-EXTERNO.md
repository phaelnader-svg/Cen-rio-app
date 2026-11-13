# Produção — investigação somente leitura: envio dos backups ao bucket parou depois de 23/10

- Data: 2026-11-13, leituras entre **18:24:41Z e 18:25:56Z** (UTC). Conta `claude-operador-prod`.
- Pedido: a sessão de origem, com base na verificação do dono no Cloud Shell. O bucket
  `cenariogestao-prod-backups` tem 6 backups, o mais recente de 23/10; há 14 snapshots READY, o mais
  recente de 13/11, com a política `cenario-prod-diario`.
- Regras: só operações READ_ONLY. Nada criado, enviado, reiniciado ou alterado; nenhuma correção
  proposta ou executada.
- Evidências: `docs/evidencias/producao-investigacao-backup/`.

## Conclusão factual

**Hipótese CONFIRMADA** na janela observável (7 dias, o máximo do catálogo):

- O timer `cenario-backup-upload.timer` disparou todo dia às **07:30:18 UTC**, de 07/11 a 13/11.
- Nas 7 vezes, o systemd **pulou** o serviço com a mensagem `was skipped because of an unmet condition
check (ConditionPathExists=/etc/cenario/publicacao-autorizada)`.
- O portão de publicação está **fechado**.
- Na janela não há nenhuma execução de `vm.sh enviar-backups`, nenhum erro HTTP e nenhum "NÃO enviado".

## 1. Logs do serviço de envio

`application_logs unit=cenario-backup-upload lines=5000 since_minutes=10080`: 18:24:41Z, job
`2eebe863-e01c-46dd-9c46-5e741bbebf24`. Arquivo `01-upload.txt`.

| Data (UTC)          | Evento                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| 2026-11-07 07:30:18 | skipped — unmet `ConditionPathExists=/etc/cenario/publicacao-autorizada` |
| 2026-11-08 07:30:18 | idem                                                                     |
| 2026-11-09 07:30:18 | idem                                                                     |
| 2026-11-10 07:30:18 | idem                                                                     |
| 2026-11-11 07:30:18 | idem                                                                     |
| 2026-11-12 07:30:18 | idem                                                                     |
| 2026-11-13 07:30:18 | idem                                                                     |

O log tem 7 linhas, todas "skipped". Não aparecem "✔ … enviado", "✘ … NÃO enviado (HTTP …)" nem
"sem token da conta de serviço".

## 2. Log do runner (contexto; só contagens)

`application_logs unit=cenario-runner lines=500 since_minutes=10080`: 18:24:47Z, job `2e47ad01…`.
Arquivo `02-runner-contagens.txt`.

- 80 linhas, de 2026-11-11 (6) e 2026-11-13 (74). As 500 linhas cobrem só esses dois dias.
- Todas as 54 citações de classe são `READ_ONLY`: as auditorias desta sessão e uma leitura de 11/11.
- 0 linhas com `gate_open`, `gate_close`, `recovery_point_create`, `backup_create` ou `enviar-backups`.
- 14 linhas citam backup ou portão: `backup_list`, `backup_validate` e `gate_status`, todas leituras.

## 3. Estado na VM

| Operação      | Hora UTC | Resultado                                                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `gate_status` | 18:24:53 | portão **fechado** (`/etc/cenario/publicacao-autorizada` ausente)                                             |
| `backup_list` | 18:24:59 | 28 pastas locais. As posteriores a 23/10 01:17Z vão de `20261023T164125Z` a `20261113T164142Z`: **22 pastas** |
| `disk_status` | 18:25:05 | `/data/backups` = 23 MB; `/` em 29%                                                                           |
| `status`      | 18:25:11 | contêineres up/healthy. **Não mostra o estado dos timers**                                                    |

Pastas locais até 23/10 01:17Z, inclusive: `20261019T164122Z`, `20261019T164342Z`, `20261020T164122Z`,
`20261021T164123Z`, `20261022T164124Z` e `20261023T011727Z`. São **6**, o mesmo número de objetos que
o dono viu no bucket, e a última é de 23/10. A coincidência é compatível com um único envio em
23/10 ~01:17Z, que levou todas as pastas existentes naquele momento. **Não pude conferir os nomes no
bucket** (403, §5).

## 4. Código: `infra/prod/gcp/startup.sh` e `vm.sh`

Os arquivos da VM (`/opt/cenario` = `c32df97ebf64`) e os do HEAD desta branch não diferem nesses dois
arquivos (`git diff c32df97 HEAD`).

- `startup.sh` cria `cenario-backup-upload.service` com `ConditionPathExists=$PORTAO`
  (`PORTAO=/etc/cenario/publicacao-autorizada`) e `ExecStart=vm.sh enviar-backups`.
- O `.timer` usa `OnCalendar=*-*-* 07:30:00 UTC` com `Persistent=true`, e é habilitado e iniciado sem
  condição. Comentário no código: "o serviço que ele aciona respeita o portão".
  → Com o portão fechado, o timer dispara e o serviço é pulado. É exatamente o que o journal mostra.
- `vm.sh enviar_backups` **não** exige o portão. Ele:
  - lê o volume `cenario-prod_backups`;
  - pula as pastas já listadas em `/var/lib/cenario/enviados`;
  - confere o `SHA256SUMS` de cada pasta;
  - obtém o token pelo servidor de metadados (`cabecalho_token`, que grava em arquivo 600);
  - envia com `gcs_criar`: `POST uploadType=media&ifGenerationMatch=0`, e só registra a pasta como
    enviada com HTTP 200 ou 412.
- Quem chama `enviar_backups`:
  1. o serviço do timer (bloqueado pelo portão);
  2. `vm.sh backup` (operação `backup_create`, MUTATING);
  3. `vm.sh ponto-recuperacao` (operação `recovery_point_create`, MUTATING), quando há bucket configurado.
     Esse caminho falha o ponto se o envio falhar.
- O backup diário das ~16:41Z é feito pelo contêiner `backup`, que **não** envia nada ao bucket.

Consequência de `Persistent=true` (leitura do código e da documentação do systemd, não observada):
o timer dispara de novo só no próximo 07:30. Execuções puladas não ficam pendentes.

## 5. Leituras do Google Cloud (somente GET)

| Leitura                                                                                                      | Hora UTC | Resultado                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compute instances describe` (conta e escopos)                                                               | 18:25:48 | ✔ `cenario-prod-vm@cenariogestao.iam.gserviceaccount.com`, escopo `cloud-platform`                                                                                                                                                       |
| `compute instances describe` (só os nomes das chaves de metadados)                                           | 18:25:51 | ✔ inclui `cenario-bucket` (valor não lido), além de `block-project-ssh-keys`, `enable-oslogin`, `cenario-project`, `cenario-region`, `cenario-repo`, `cenario-domain`, `cenario-domain-www`, `cenario-admin-email`, `cenario-admin-name` |
| `storage buckets describe gs://cenariogestao-prod-backups` (lifecycle, retenção, soft delete, versionamento) | 18:25:52 | **403** (`storage.buckets.get`). Não contornado                                                                                                                                                                                           |
| `compute resource-policies describe cenario-prod-diario`                                                     | 18:25:55 | **403** (`compute.resourcePolicies.get`). Não contornado                                                                                                                                                                                  |
| `storage ls -l gs://cenariogestao-prod-backups/backups/`                                                     | 18:25:56 | **403** (`storage.objects.get`). Não contornado                                                                                                                                                                                           |
| `storage buckets get-iam-policy gs://cenariogestao-prod-backups`                                             | —        | **Não executado**: a tarefa original proíbe "IAM e segredos"                                                                                                                                                                              |

Como `cenario-bucket` existe nos metadados, `enviar_backups` não sai pelo ramo "Sem bucket
configurado". A conta e o escopo da VM permitiriam obter o token. Que a conta tenha
`storage.objects.create` no bucket **não foi verificado** (IAM não lido). Os 6 objetos que o dono viu
indicam que o envio funcionou ao menos em 23/10.

## 6. Correção a uma afirmação do relatório anterior

`docs/PRODUCAO-AUDITORIA-LEITURA-696e3e9.md` dizia, nos §8 e §11, que o ponto de recuperação protegido
(`9fb1786`) era "o do banco vazio, do primeiro deploy". Isso foi **inferência**, e não se sustenta:
`ponto-recuperacao` grava `ETIQUETA=$(etiqueta_ativa)`, e `9fb1786` ainda era a versão ativa em 23/10
01:17Z, 1 minuto antes das 2 migrations de `7b4177b`. O ponto pode, portanto, ser o backup
`20261023T011727Z`. O arquivo do ponto não foi lido; os dois parágrafos foram corrigidos.

## 7. Limitações

1. Os journals cobrem só 7 dias (máximo do catálogo): não alcançam 23/10. O envio daquela data é
   inferido pela contagem (6 = 6), não observado.
2. 403 em bucket describe, bucket ls e resource policy dos snapshots. Não contornados.
3. A política IAM do bucket não foi lida (proibição da tarefa original).
4. `status` não mostra os timers. Nenhuma operação do catálogo mostra `systemctl list-timers`;
   o disparo diário aparece só no journal.
5. `/var/lib/cenario/enviados` não foi lido: nenhuma operação READ_ONLY o expõe.
