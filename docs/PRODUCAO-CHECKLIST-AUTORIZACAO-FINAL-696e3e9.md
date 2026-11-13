# Produção `696e3e9` com banco limpo — checklist para a autorização final

Situação: **preparação concluída. Nada foi executado na produção:** portão fechado, nenhuma
promoção, nenhuma publicação, nenhum deploy.

Os comandos abaixo estão **prontos, mas não foram executados**. Este documento é a base da
**solicitação única** de autorização (seção 8).

| #   | Item                                            | Situação                                                                |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Backups automáticos de 14 e 15/11 (homologação) | ⏳ **pendente**: verificações agendadas para 14/11 e 15/11 às 07:45 UTC |
| 2   | Acesso à senha inicial do gestor                | ⏳ **você confirma** com o comando 2.1 (sem exibir o valor)             |
| 3   | Digests das imagens                             | ✔                                                                      |
| 4   | Banco antigo intacto                            | ✔ comprovado em teste e no ensaio; conferido de novo no deploy         |
| 5   | Retorno testado                                 | ✔ ensaio local E4                                                      |
| 6   | Comandos finais                                 | ✔ prontos (seção 6)                                                    |
| 7   | Critérios de GO/NO-GO                           | ✔ (seção 7)                                                            |

## 1. Backups automáticos de 14 e 15/11 (homologação)

| Execução         | O que precisa aparecer                                                                                                   | Resultado |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| 14/11, 07:30 UTC | Serviço `cenario-backup-upload` **executado** ("Finished"), sem "skipped"; smoke ✔ "último envio ao bucket há 0 h"      | ⏳        |
| 15/11, 07:30 UTC | "✔ cenario-staging-20261114T…Z enviado" (backup novo enviado sozinho); smoke ✔ "nenhum backup local sem cópia externa" | ⏳        |
| Você (opcional)  | `gcloud storage ls -l gs://cenariogestao-homolog-backups/backups/ \| sort -k2 \| tail -3` mostra o backup de 14/11       | ⏳        |

## 2. Senha inicial do gestor (sem expor o valor)

O gestor do banco novo é criado pelo `seed_bootstrap` com:

- o e-mail e o nome dos metadados da VM;
- a senha do segredo `prod-admin-password`.

Não é a senha que você usa hoje.

### 2.1 Confirmação, no Cloud Shell

O comando abaixo não imprime a senha:

```bash
gcloud secrets versions access latest --secret=prod-admin-password --project=cenariogestao \
  | awk '{ print (length($0) >= 12 ? "✔ acesso ao segredo OK (" length($0) " caracteres)" : "✘ valor curto") }'
gcloud compute instances describe cenario-prod --zone=southamerica-east1-b --project=cenariogestao --format=json \
  | python3 -c 'import json,sys; m={i["key"]:i.get("value","") for i in json.load(sys.stdin)["metadata"]["items"]}; print("e-mail do gestor:", m.get("cenario-admin-email","(ausente)"))'
```

Para usar a senha no dia, abra-a só no seu terminal: `gcloud secrets versions access latest
--secret=prod-admin-password --project=cenariogestao`. Ou guarde-a no seu gerenciador de senhas.
Troque-a no primeiro acesso. **Não a envie por mensagem.**

## 3. Imagens que serão implantadas

| Serviço                 | Imagem                                                      | Digest                                                                    |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| api                     | `cenario-prod/api:696e3e9ddc5f1c803a4b9244a075ed498ad81be3` | `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f` |
| web                     | `cenario-prod/web:696e3e9ddc5f1c803a4b9244a075ed498ad81be3` | `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72` |
| postgres, caddy, backup | `postgres:16-alpine`, `caddy:2.10-alpine`, `postgres:16`    | **sem mudança**: as mesmas da VM hoje                                     |

**Origem:** são as mesmas imagens ativas e homologadas em `cenario-homolog` desde 12/11. A promoção
copia por digest e recusa se a origem tiver outro digest. Também nunca sobrescreve uma etiqueta
existente. O `prepare_version` confere os digests de novo na VM, antes da janela.

**Pacote de scripts:** `scripts-9ff142e274b1.tar.gz`, do commit
`9ff142e274b1cc04953bbfb5161a7940962530d5`. O sha256 de referência é `c8c293b1…028cdc`. O runner
confere o pacote pelo próprio commit.

## 4. Banco antigo intacto

| Garantia                       | Evidência                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Nada apaga o volume `pgdata`   | O Compose mantém `pgdata` declarado. O `vm.sh` não tem `volume rm`, `down -v` nem `--volumes`. O teste reprova se a declaração sumir   |
| O deploy não toca no conteúdo  | Ensaio E2/E4: hash do conteúdo do volume antigo **idêntico** antes e depois do deploy                                                  |
| Dados recuperáveis por retorno | Ensaio E4: 112 tabelas de negócio idênticas, os marcadores presentes, login OK                                                         |
| Cópias extras                  | Backup final do banco antigo (`backup_create`) enviado ao bucket **antes** da janela. Mais os 28 backups existentes (6 + 22, íntegros) |
| Conferência no dia             | Depois do deploy, `disk_status` lista o volume `cenario-prod_pgdata`. Se não listar, é NO-GO                                           |

## 5. Retorno (testado no ensaio E4: 29 s local; ~3 a 5 min estimados na produção)

1. `gate_open` → `maintenance_on`;
2. `vm_scripts_restore`: o Compose volta ao volume antigo;
3. `stack_bootstrap version=7b4177b15a930b85d985a59a9182b579760c5a7b`: o PostgreSQL volta ao volume antigo;
4. `rollback_version version=7b4177b15a930b85d985a59a9182b579760c5a7b`;
5. `gate_close`;
6. `smoke_test`.

O banco novo fica preservado no volume `pgdata_2026_11`.

## 6. Comandos finais

### 6.1 Você, no Cloud Shell, antes da janela

São 2 comandos. Não precisam de janela nem causam indisponibilidade.

```bash
cd <seu clone>
git fetch origin claude/deploy-banco-limpo && git checkout 9ff142e274b1cc04953bbfb5161a7940962530d5

# (A) promoção das imagens, por digest
bash infra/prod/gcp/promover-imagens.sh 696e3e9ddc5f1c803a4b9244a075ed498ad81be3 \
  sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f \
  sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72

# (B) publicação do pacote de scripts (só cria objetos no bucket de versões)
SVER=$(git rev-parse HEAD | cut -c1-12); T=$(mktemp -d)
git archive --format=tar HEAD infra/prod scripts/backup.sh scripts/restore.sh | gzip -n -9 > "$T/scripts-$SVER.tar.gz"
sha256sum "$T/scripts-$SVER.tar.gz" | cut -d' ' -f1 | tee "$T/scripts-$SVER.sha256"
gcloud storage cp "$T/scripts-$SVER.tar.gz" "$T/scripts-$SVER.sha256" gs://cenariogestao-prod-runner-versoes/ \
  --project=cenariogestao --if-generation-match=0
```

### 6.2 Eu, pelo runner da produção (`CENARIO_AMBIENTE=prod`, conta `claude-operador-prod`)

| Fase                                   | Operações                                                                                                                                                                                                                                                                             | Para se…                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **P** (preparo, sem indisponibilidade) | `verificar` · `imagens 696e3e9…` · `vm_scripts_diff version=9ff142e274b1` · `gate_open` · `prepare_version 696e3e9…` · `backup_create` · `gate_close`                                                                                                                                 | Ver critérios N1–N4                               |
| **J** (janela, ~5 a 8 min fora do ar)  | `gate_open` · `maintenance_on` · `vm_scripts_update version=9ff142e274b1` · `stack_bootstrap version=696e3e9…` · `recovery_point_create` · `migration_precheck version=696e3e9…` · `migrate version=696e3e9…` · `activate_version version=696e3e9…` · `seed_bootstrap` · `gate_close` | Ver critérios N5–N9, e então o retorno da seção 5 |
| **V** (validação, só leitura)          | `smoke_test` · `websocket_test` · `run_homologation_tests suite=completo` · `migration_status` · `database_counts` · `disk_status` · `container_logs service=api`                                                                                                                     | Ver critério N10                                  |

### 6.3 Você, depois da janela

1. **SSH**: aplica a unidade corrigida do envio de backups, com o portão fechado.

   ```bash
   gcloud compute ssh cenario-prod --zone=southamerica-east1-b --tunnel-through-iap
   test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO — PARE" || sudo bash /opt/cenario/infra/prod/gcp/startup.sh
   sudo systemctl start cenario-backup-upload.service && sudo /opt/cenario/infra/prod/gcp/vm.sh envio-externo; exit
   ```

2. **Interface:**
   - entrar como gestor;
   - trocar a senha;
   - cadastrar a equipe e os PINs;
   - vincular os tablets;
   - preencher os dados da empresa.

## 7. Critérios de GO/NO-GO

**GO para iniciar a fase P:** itens 1 e 2 ✔, e sua autorização final.

**NO-GO, com parada imediata e sem passar à etapa seguinte:**

| #   | Momento | Condição                                                                                                                              |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | P       | Produção não está em `7b4177b`, portão aberto sem motivo, ou contêiner sem saúde                                                      |
| N2  | P       | Imagem ausente em `cenario-prod` ou com digest diferente da seção 3                                                                   |
| N3  | P       | `vm_scripts_diff` mostra mudança fora de: a linha do volume no Compose, o `vm.sh` e o `startup.sh` da correção de backup, e os testes |
| N4  | P       | `prepare_version` com digest diferente ou disco < 10 GB; ou `backup_create` com erro de envio                                         |
| N5  | J       | O `stack_bootstrap` não informa "banco NOVO (nenhuma tabela)"                                                                         |
| N6  | J       | Ponto de recuperação sem restauração IDÊNTICA                                                                                         |
| N7  | J       | Preflight diferente de "37 pendentes" sem divergência, ou `migrate` diferente de 37 aplicadas                                         |
| N8  | J       | API sem saúde depois do `activate_version`                                                                                            |
| N9  | J       | Seed diferente de "1 usuário (gestor), 0 clientes, 0 OS"                                                                              |
| N10 | V       | Algum ✘ no smoke ou na suíte completa; resposta 5xx; ou `disk_status` sem o volume `cenario-prod_pgdata`                              |

Fora da janela (fase P), um NO-GO só encerra: `gate_close`, e nada muda. Dentro da janela (J e V),
um NO-GO leva ao **retorno da seção 5**.

**GO final:** a fase V sem nenhum ✘, o gestor entra e o volume antigo está listado.

## 8. Solicitação única de autorização (a ser respondida depois do item 1)

> **Autorizo:**
>
> - (a) executar eu mesmo os comandos A e B da seção 6.1;
> - (b) o uso de `claude-operador-prod` para as operações de escrita **listadas na seção 6.2 e no
>   retorno da seção 5**, e somente elas;
> - (c) o deploy de `696e3e9` com banco limpo na janela `<data e hora>`, seguindo os critérios da
>   seção 7.
>
> Fica proibido:
>
> - apagar volumes ou backups;
> - alterar permissões;
> - mexer na `/conheca`;
> - qualquer operação fora dessas listas.
