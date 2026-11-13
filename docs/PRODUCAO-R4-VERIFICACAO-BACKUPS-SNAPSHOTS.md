# R-4 — Verificação dos backups externos e dos snapshots da produção (somente leitura)

Execute **no Cloud Shell**, com a sua conta, no projeto `cenariogestao`. São dois blocos de
comandos. Nenhum deles cria, altera ou apaga nada, e nenhum muda permissão.

## Comando 1 — backups externos: existência e integridade

- **Origem:** o bucket `cenariogestao-prod-backups`. Cada backup diário é enviado pela VM como
  `backups/cenario-production-<AAAAMMDDTHHMMSSZ>.tar`, com a pasta do backup e o seu `SHA256SUMS`.
- **Leitura:** o bloco lista os backups e lê o **mais recente** em fluxo
  (`gcloud storage cat … | python3`).
- **Conferência:** calcula o SHA-256 de cada arquivo dentro do `.tar` e compara com o
  `SHA256SUMS` gravado no backup.
- **Sigilo:** **nada é gravado em disco**. A saída mostra só nomes de arquivo, tamanhos, datas e
  OK/FALHA, sem nenhum conteúdo.

```bash
B=gs://cenariogestao-prod-backups/backups
echo "== Backups no bucket (mais recentes por último):"
gcloud storage ls -l "$B/" | grep -E 'cenario-production-[0-9]{8}T[0-9]{6}Z\.tar$' | sort -k2 | tail -8
echo "== Total de backups no bucket: $(gcloud storage ls "$B/" | grep -cE 'cenario-production-[0-9]{8}T[0-9]{6}Z\.tar$')"
ULT=$(gcloud storage ls "$B/" | grep -E 'cenario-production-[0-9]{8}T[0-9]{6}Z\.tar$' | sort | tail -1)
echo "== Mais recente: $ULT"
gcloud storage objects describe "$ULT" --format="table(size,crc32c_hash,update_time)"
echo "== Conferência SHA-256 do conteúdo (em fluxo, sem gravar nada em disco):"
gcloud storage cat "$ULT" | python3 -c '
import sys, tarfile, hashlib
t = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
calc, esp = {}, {}
for m in t:
    if not m.isfile(): continue
    f = t.extractfile(m); n = m.name.split("/", 1)[-1]
    if n == "SHA256SUMS":
        for l in f.read().decode().splitlines():
            d, a = l.split(None, 1); esp[a.lstrip("*").removeprefix("./")] = d
    else:
        h = hashlib.sha256()
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
        calc[n] = h.hexdigest()
for n in sorted(esp): print("OK   " if calc.get(n) == esp[n] else "FALHA", n)
print("RESULTADO:", "ÍNTEGRO" if esp and all(calc.get(n) == d for n, d in esp.items()) else "FALHOU")'
```

**Resultado esperado:**

- uma lista com os backups recentes, um por dia, com o mais recente de **hoje ou ontem**
  (o envio roda às 07:30 UTC e envia os backups ainda não enviados);
- o total de backups no bucket;
- linhas `OK` para cada arquivo;
- **`RESULTADO: ÍNTEGRO`**.

**Bloqueia:** bucket vazio, backup mais recente com mais de 2 dias, qualquer `FALHA`, ou
`RESULTADO: FALHOU`.

## Comando 2 — snapshots do disco da VM de produção

```bash
echo "== Snapshots do disco da produção (mais recentes primeiro):"
gcloud compute snapshots list --project=cenariogestao \
  --filter="sourceDisk~/disks/cenario-prod$" --sort-by=~creationTimestamp --limit=20 \
  --format="table(name,id,sourceDisk.basename(),creationTimestamp.date('%Y-%m-%d %H:%M UTC'),status,diskSizeGb,storageBytes,autoCreated)"
echo "== Política de snapshot ligada ao disco:"
gcloud compute disks describe cenario-prod --zone=southamerica-east1-b --project=cenariogestao \
  --format="value(resourcePolicies.basename())"
gcloud compute resource-policies list --project=cenariogestao --filter="name~cenario-prod" \
  --format="table(name,region.basename(),snapshotSchedulePolicy.schedule.dailySchedule.startTime,snapshotSchedulePolicy.retentionPolicy.maxRetentionDays)"
```

**Resultado esperado:**

- até 14 snapshots `READY`, um por dia, com o mais recente de hoje ou ontem, cada um com nome e
  identificador;
- o disco `cenario-prod` com a política diária ligada, com retenção de 14 dias.

**Bloqueia:**

- nenhum snapshot;
- snapshot mais recente com mais de 2 dias;
- status diferente de `READY`;
- disco sem política ligada.

Se o nome do disco não for `cenario-prod` e a lista sair vazia, troque o filtro por
`--filter="sourceDisk~cenario-prod"` e repita. O comando continua só de leitura.

## O que me enviar

Cole a saída dos dois blocos. Ela não contém segredos nem dados pessoais. Se aparecer
`PERMISSION_DENIED`, envie só a linha do erro: não ajuste permissões para isso.
