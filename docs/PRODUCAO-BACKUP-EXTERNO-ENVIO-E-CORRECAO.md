# Backup externo — envio emergencial (opção A) e correção definitiva

Decisões do dono:

- envio emergencial pela **opção A**, executada por ele por SSH;
- correção definitiva **preparada e testada, mas não aplicada**;
- `/conheca` **sem mudança** em nenhum ambiente.

Nada foi executado na produção ou na homologação nesta etapa.

---

## 1. Envio emergencial (opção A)

### 1.1 Confirmação do comando, na versão instalada na produção

A VM de produção usa os scripts do commit `c32df97ebf64` (`/opt/cenario`, conforme a operação
`version`). Nesse commit, `infra/prod/gcp/vm.sh` (sha256 `9f27fd75…15bb7`):

- tem o subcomando `enviar-backups)`, que só chama `enviar_backups`;
- tem a função `enviar_backups` idêntica à do repositório atual, conferida por diff.

| Pergunta                   | Resposta, pelo código de `c32df97`                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O comando existe?          | **Sim**: `vm.sh enviar-backups`                                                                                                                                          |
| Abre o portão?             | **Não**. O comando não lê nem cria `/etc/cenario/publicacao-autorizada`: `enviar_backups` não chama `need_portao`                                                        |
| Reinicia serviços?         | **Não**. Não usa `docker compose`, `systemctl` nem `restart`. O único comando Docker é `docker volume inspect`, que só lê o caminho do volume                            |
| Executa migrations?        | **Não**. Não acessa o PostgreSQL nem a aplicação                                                                                                                         |
| Altera dados operacionais? | **Não**. Lê as pastas de backup (confere o `SHA256SUMS` e empacota em `/tmp`, um arquivo temporário apagado no fim)                                                      |
| O que ele grava?           | Os objetos novos no bucket, só com criação (`ifGenerationMatch=0`, nunca sobrescreve), e o nome de cada pasta enviada em `/var/lib/cenario/enviados`                     |
| Credencial                 | O token da conta da VM, obtido pelo servidor de metadados e gravado em arquivo temporário 600. Nunca é exibido                                                           |
| Se falhar                  | A pasta não é registrada e o comando termina com erro. Pode ser repetido: o que já foi enviado é pulado, e o que já existe no bucket (412) é registrado sem sobrescrever |

### 1.2 Comandos, no Cloud Shell

**Passo 1 — entrar na VM pelo IAP.** É a mesma forma de acesso usada no provisionamento.

```bash
gcloud config set project cenariogestao
eval "$(ssh-agent -s)"; ssh-add -t 1h ~/.ssh/google_compute_engine
gcloud compute ssh cenario-prod --zone=southamerica-east1-b --tunnel-through-iap
```

**Passo 2 — antes de enviar (na VM; só leitura).**

```bash
sha256sum /opt/cenario/infra/prod/gcp/vm.sh
#   esperado: 9f27fd7589a019fed3d9ab58386df4286a332c2d045b989c1b5d0d7f40215bb7  (scripts c32df97)
test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO — PARE e me avise" || echo "portão fechado (ok)"
sudo docker ps --format '{{.Names}}  {{.Status}}'      # anote: deve continuar igual depois
echo "já enviados: $(sudo wc -l < /var/lib/cenario/enviados)"; sudo tail -1 /var/lib/cenario/enviados
```

Se o `sha256sum` for diferente do esperado, **pare e me envie o valor**: a VM teria scripts diferentes
dos auditados.

**Passo 3 — envio.**

```bash
sudo /opt/cenario/infra/prod/gcp/vm.sh enviar-backups; echo "código de saída: $?"
```

Esperado:

- uma linha `✔ cenario-production-<data> enviado a gs://cenariogestao-prod-backups/backups/` para
  cada um dos backups pendentes: **22 até o backup de 13/11**, mais um por dia a partir de então, de `20261023T164125Z` até o mais recente;
- **`código de saída: 0`**.

Leva poucos minutos: os backups somam cerca de 23 MB.

**Pare e me envie a saída** se aparecer qualquer uma destas linhas:

- `✘ … NÃO enviado (HTTP 403)`: permissão da conta da VM no bucket. **Não ajuste permissões.**
- `✘ … com checksum inválido`: backup local corrompido. Ele não é enviado.
- `sem token da conta de serviço`.

**Passo 4 — depois do envio (na VM; só leitura).**

```bash
test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO" || echo "portão continua fechado (ok)"
sudo docker ps --format '{{.Names}}  {{.Status}}'      # mesmos 5 contêineres, mesmo "Up …"
echo "enviados agora: $(sudo wc -l < /var/lib/cenario/enviados)"   # anterior + o número de linhas ✔ do Passo 3
exit
```

### 1.3 Verificação do resultado, no Cloud Shell (só leitura)

1. **Comando 1 do R-4** (`PRODUCAO-R4-VERIFICACAO-BACKUPS-SNAPSHOTS.md`). Esperado:
   - os **6 antigos + os enviados no Passo 3** no bucket;
   - o mais recente de **hoje**;
   - `RESULTADO: ÍNTEGRO`.
2. **Opcional, para conferir todos os backups do bucket**, e não só o mais recente. O bloco lê em
   fluxo e não grava nada:

```bash
B=gs://cenariogestao-prod-backups/backups
for o in $(gcloud storage ls "$B/" | grep -E 'cenario-production-[0-9]{8}T[0-9]{6}Z\.tar$' | sort); do
  printf '%s  ' "$(basename "$o")"
  gcloud storage cat "$o" | python3 -c '
import sys, tarfile, hashlib
t = tarfile.open(fileobj=sys.stdin.buffer, mode="r|"); calc, esp = {}, {}
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
print("ÍNTEGRO" if esp and all(calc.get(n) == d for n, d in esp.items()) else "FALHOU")'
done
```

Esperado: uma linha por backup, todas `ÍNTEGRO`.

**Até a correção definitiva ser aplicada**, o envio diário continua sendo pulado. Se ela não for
aplicada em alguns dias, repita o Passo 3 com folga **antes do prazo de 30 dias da retenção local**.

---

## 2. Correção definitiva: preparada e testada, NÃO aplicada

### 2.1 O que muda

| Arquivo                                                                               | Mudança                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/prod/gcp/startup.sh` e `infra/homolog/gcp/startup.sh`                          | A unidade `cenario-backup-upload.service` **deixa de exigir o portão**. A condição passa a ser só a existência do `vm.sh`. A unidade da pilha **continua com o portão**. O timer das 07:30 UTC não muda. O cabeçalho agora avisa que **rodar o script com o portão aberto reinicia a pilha** |
| `infra/prod/gcp/vm.sh` e `infra/homolog/gcp/vm.sh`                                    | Ver lista abaixo                                                                                                                                                                                                                                                                             |
| `infra/prod/gcp/testes/test_vm_sh_prod.sh` e `infra/homolog/gcp/testes/test_vm_sh.sh` | Cenários novos (seção 2.3)                                                                                                                                                                                                                                                                   |

Mudanças no `vm.sh`:

1. `enviar_backups` grava `/var/lib/cenario/ultimo-envio` só quando o envio termina **sem erro**.
2. Subcomando novo, só de leitura: **`vm.sh envio-externo`**. Ele dá `✘` e sai com 1 em dois casos:
   - o último envio sem erro foi há **mais de 36 h** (ou não há registro);
   - existe backup local com **mais de 36 h**, pela data no nome, que **nunca foi enviado**.

   O limite é ajustável por `CENARIO_ENVIO_MAX_H`.

3. Essa mesma verificação entra no `vm.sh saude`:
   - no **smoke** (`smoke_test`), atraso conta como problema;
   - em `ativar`, `aplicar-config` e `recuperar`, aparece só como **aviso**. Um envio atrasado nunca
     reprova uma troca de versão ou um retorno.

**Fica igual:**

- permissões: a conta da VM continua só **criando** objetos;
- Compose e Caddyfile;
- a aplicação e o banco;
- retenções: 30 dias na VM, 90 no bucket, 14 nos snapshots;
- a `/conheca`, em todos os ambientes.

### 2.2 Commits e pacotes

As correções foram montadas **sobre os scripts que já estão em cada VM**. Assim, a instalação muda
só o necessário.

| Ambiente         | Base (scripts da VM hoje) | Branch                                  | Commit                                     | Pacote reprodutível (sha256 de referência)       |
| ---------------- | ------------------------- | --------------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Produção         | `c32df97ebf64`            | `claude/correcao-envio-backups`         | `2f078850696c73854483b9f5f9ba1e88a6c4ea0d` | `scripts-2f078850696c.tar.gz` · `5e8fc900…ddb98` |
| Homologação      | `5ff1597c0d1c`            | `claude/correcao-envio-backups-homolog` | `89fbe1ba4ea56b5a02989b245eb915f5a9a516c7` | `scripts-89fbe1ba4ea5.tar.gz` · `67203a10…af24`  |
| Branch principal | —                         | `claude/reformulacao-fase-4`            | `91f1552` (cherry-pick)                    | para as próximas versões                         |

**Diferença instalada:**

- **produção:** 3 arquivos de `infra/prod` (`vm.sh`, `startup.sh` e o teste), +123/−11. **Nenhuma**
  mudança no Compose, no Caddyfile nem na `/conheca`, que continua sem `SITE_COMERCIAL`;
- **homologação:** 3 arquivos de `infra/homolog`, +103/−11. Mantém o `SITE_COMERCIAL=1` que ela já
  tem.

### 2.3 Evidências dos testes (locais, sem nuvem)

| Suíte                                             | `c32df97` + correção | `5ff1597` + correção | `reformulacao-fase-4` + correção |
| ------------------------------------------------- | -------------------- | -------------------- | -------------------------------- |
| `infra/prod/gcp/testes/test_vm_sh_prod.sh`        | **90 ✔, 0 ✘**       | —                    | todos OK                         |
| `infra/homolog/gcp/testes/test_vm_sh.sh`          | **87 ✔, 0 ✘**       | **87 ✔, 0 ✘**       | todos OK                         |
| `infra/prod/gcp/testes/test_provisionar.sh`       | 48 ✔, 0 ✘           | —                    | OK                               |
| `infra/homolog/gcp/testes/test_homolog_sh.sh`     | 194 ✔, 0 ✘          | todos OK             | todos OK                         |
| `test_runner_prod.py` / `test_runner.py` (runner) | 14 OK / OK           | —                    | —                                |

**Cenários novos:**

- envio com o **portão fechado**;
- carimbo gravado no sucesso e **não** atualizado quando o envio falha (403 simulado);
- `envio-externo`:
  - em dia → 0;
  - último envio há 40 h ou 37 h → ✘;
  - backup de 3 dias (ou 2) nunca enviado → ✘, e o de 1 h (ou 30 h) não conta;
  - sem registro → ✘;
  - sem bucket → desativado;
  - limite ajustável;
  - depois de enviar os pendentes → em dia;
- o comando `envio-externo` não chama Docker nem gcloud;
- as 3 chamadas internas da saúde usam o modo aviso, e nenhuma usa o modo estrito;
- unidade de envio **sem** a condição do portão e **com** a do `vm.sh`; pilha **com** o portão;
  timer das 07:30 iniciado.

**Prova de que os testes pegam o defeito:** os testes novos, rodados contra o código anterior
(`c32df97`, sem a correção), dão **17 falhas** na produção e **13** na homologação. Entre elas:
"contém (não deveria): `ConditionPathExists=/etc/cenario/publicacao-autorizada`" e "sem carimbo do
último envio".

### 2.4 Procedimento de instalação (aguarda sua autorização)

Produção primeiro **ou** homologação primeiro: recomendo **homologação primeiro**, para comprovar o
envio do dia seguinte antes de tocar na produção.

**Homologação:**

1. **Publicar o pacote**: você, no Cloud Shell, gravando no bucket de versões, que só aceita humano.

   ```bash
   git fetch origin claude/correcao-envio-backups-homolog && git checkout 89fbe1ba4ea56b5a02989b245eb915f5a9a516c7
   SVER=$(git rev-parse HEAD | cut -c1-12); T=$(mktemp -d)
   git archive --format=tar HEAD infra/homolog scripts/backup.sh scripts/restore.sh | gzip -n -9 > "$T/scripts-$SVER.tar.gz"
   sha256sum "$T/scripts-$SVER.tar.gz" | cut -d' ' -f1 | tee "$T/scripts-$SVER.sha256"
   gcloud storage cp "$T/scripts-$SVER.tar.gz" "$T/scripts-$SVER.sha256" gs://cenariogestao-homolog-runner-versoes/ \
     --project=cenariogestao --if-generation-match=0
   ```

   São os mesmos comandos de `bootstrap.sh publicar-runner`, mas só para os scripts: não publicam
   runner nem mexem em IAM.

2. **Eu, pelo runner:**
   1. `vm_scripts_diff version=89fbe1b…`, só leitura. Esperado: só `vm.sh`, `startup.sh` e o teste;
   2. `gate_open`;
   3. `vm_scripts_update version=89fbe1b…`. Guarda a cópia anterior e não reinicia nada;
   4. `gate_close`.
3. **Você, por SSH na VM, com o portão FECHADO** (se estiver aberto, o script reinicia a pilha):

   ```bash
   gcloud compute ssh cenario-homolog --zone=us-east1-b --tunnel-through-iap
   test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO — PARE" || sudo bash /opt/cenario/infra/homolog/gcp/startup.sh
   systemctl cat cenario-backup-upload.service | grep ConditionPathExists   # só a do vm.sh
   sudo systemctl start cenario-backup-upload.service; sudo journalctl -u cenario-backup-upload.service -n 20 --no-pager
   sudo /opt/cenario/infra/homolog/gcp/vm.sh envio-externo; echo "código: $?"   # esperado 0
   ```

   O `start` manual testa o envio na hora. Ele não reinicia a pilha.

4. **Validação no dia seguinte (eu):**
   - `application_logs unit=cenario-backup-upload` com a execução das 07:30 e "✔ … enviado";
   - `smoke_test` com "✔ último envio ao bucket há N h".

**Produção:** o mesmo, com estes valores:

| Item                | Valor                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Commit              | `2f078850696c73854483b9f5f9ba1e88a6c4ea0d` (branch `claude/correcao-envio-backups`)            |
| Conteúdo do pacote  | `git archive … infra/prod scripts/backup.sh scripts/restore.sh`                                |
| Bucket de versões   | `gs://cenariogestao-prod-runner-versoes/`                                                      |
| Operações do runner | `CENARIO_AMBIENTE=prod`                                                                        |
| SSH                 | `cenario-prod --zone=southamerica-east1-b`, com `startup.sh` em `/opt/cenario/infra/prod/gcp/` |

- Para a produção, a operação pelo runner exige a sua autorização para operações de escrita com
  `claude-operador-prod`: `gate_open`, `vm_scripts_update` e `gate_close`. A autorização atual é só
  de leitura.
- **Não use `provisionar.sh preparar-vm`.** Ele foi feito para a VM antes do 1º deploy: troca
  `/opt/cenario` inteiro e termina com `verificar-preparo`, que reprova uma VM com a pilha rodando.

**Retorno da correção**, se preciso: `vm_scripts_restore`, que volta à cópia guardada, e depois
`startup.sh` com o portão fechado, que regrava a unidade anterior. Nada é reiniciado.
