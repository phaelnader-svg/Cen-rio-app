# Homologação integrada (F0–F4) — auditoria final de prontidão

12/11/2026, 17:16–17:25 UTC. **Somente leitura** na homologação (operações `READ_ONLY` do runner e
consultas ao registro/Compute); testes isolados apenas no ambiente local descartável. Nenhum deploy,
migration, reinício, restauração na VM, dado sintético ou alteração de produção.

## 1. Checklist

| #   | Item                                                | Situação                                                                                                                                      |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Branches e commits                                  | **APROVADO**                                                                                                                                  |
| 1.2 | Imagens e digests no Artifact Registry              | **APROVADO**                                                                                                                                  |
| 1.3 | Compatibilidade entre as fases (migrations F′ × R2) | **APROVADO**                                                                                                                                  |
| 2.1 | Migrations pendentes / estado do banco              | **APROVADO**                                                                                                                                  |
| 2.2 | Backup consistente                                  | **APROVADO**                                                                                                                                  |
| 2.3 | Teste de restauração                                | **APROVADO** (identidade exata é critério automático no ponto de recuperação)                                                                 |
| 2.4 | Integridade dos dados                               | **APROVADO**                                                                                                                                  |
| 3   | Arquivos e fotos (divergência do anexo)             | **APROVADO COM RESSALVA** (ver 2.8): mecanismo provado; registro órfão preexistente documentado; prova na VM real **PENDENTE de autorização** |
| 4   | Retorno sem perda de dados                          | **APROVADO** (com pré-condição automática)                                                                                                    |
| 5   | Infraestrutura (disco, saúde, memória, capacidade)  | **APROVADO**                                                                                                                                  |
| 6   | Segurança e isolamento                              | **APROVADO**                                                                                                                                  |
| 7.1 | Testes automatizados                                | **APROVADO**                                                                                                                                  |
| 7.2 | Testes manuais                                      | **PENDENTE** (após o deploy, por definição)                                                                                                   |

## 2. Evidências

### 2.1 Código, versões e imagens

| Papel            | Branch                                    | Commit                                     | `api`                                                                     | `web`                                                                     |
| ---------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Integrada **F′** | `claude/reformulacao-fase-4`              | `63674f1d116ed86a92dbcc421f2fd702e41b169d` | `sha256:940f77087545784a0e0f2adcfd69026ddbc157e7b46095cf565ce95329342e5b` | `sha256:b9b0d32af8e2717fbcbe0865f3abdd920f94d57b2fee020a2fe5033b34d7ebe0` |
| Retorno **R2**   | `claude/retorno-3e0d2d0-integrada-guarda` | `341badb59624996cd95c1213808c51631bf34b92` | `sha256:b272404e79719dd1b7151502a9681c75be85614362252d688beab59d1c659df7` | `sha256:8559184d2e2d5b1a07a8b19782a02cd4836136e306032cca5e3d07099d27f5f8` |

- Os 4 digests, consultados de novo no registro hoje, coincidem com os do Cloud Build (builds
  `a9205a72…` e `5ad29d31…`, `SUCCESS`).
- Ponta remota de `claude/reformulacao-fase-4`: `15ebba8` (+ este relatório). Entre `63674f1` e a
  ponta **nenhuma mudança** em `apps/`, `packages/`, `pnpm-lock.yaml`, `Dockerfile` ou
  `api-iniciar.sh` (`git diff --stat` vazio): só scripts de operação e documentos.
- Branch padrão `claude/cenario-gestao-fase-1-zf3bj2` em `07c9b46` (inalterado). Branches de retorno
  anteriores (`claude/retorno-5ff1597-fase0`, `claude/retorno-a7f4f93-fase1`, `…-integrada` =
  `145825d`) intocados.
- F′ e R2 têm as mesmas 37 migrations; `…fase_2` sha256 `187744c6841c…` e `…fase_3` `bfc067865f01…`
  idênticas nos dois.

### 2.2 Banco de dados

- `migration_status`: 35 aplicadas, nenhuma pendente ou com falha; última
  `20270309000000_materiais_estoque_entrega`. F′ aplicará só `20270316…fase_2` e `20270323…fase_3`
  (validado com a própria imagem num banco no mesmo estado).
- `database_status`: PostgreSQL 16.15, 18 MB, 10 conexões, nenhum bloqueio, nenhuma consulta longa.
- `backup_validate cenario-staging-20261112T171404Z` (backup diário de hoje): **SHA256SUMS conferido**.
  17 pastas de backup na VM (11 MB) + cópia no bucket.
- Restauração (11/11, mesma rotina): concluída — 125 tabelas, 35 migrations, 654 restrições, 403
  índices, 67 gatilhos. Diferenças só nos dados gravados depois do backup (presença, auditoria,
  eventos, avisos) e chaves de idempotência já expiradas; **nenhuma** tabela financeira ou de
  negócio diferente. Não foi repetida hoje: cria bancos temporários na VM (fora do escopo desta
  auditoria). No deploy, o `recovery_point_create` faz a restauração com a aplicação parada e
  **recusa** registrar o ponto se a impressão não for idêntica.
- Mecanismo de backup + restauração com arquivo real: `scripts/test-backup-restore.sh` local —
  **✔** (banco + arquivo com SHA-256 conferido + aplicação subindo sobre o restaurado).

### 2.3 Arquivos e fotos — investigação

Fatos medidos:

1. `database_counts`: `attachments = 1`, `stored_files = 1`.
2. Na restauração de 11/11, `attachments` e `stored_files` **não** aparecem entre as tabelas
   divergentes → o registro já existia no backup.
3. O mesmo backup restaurou **0 arquivos**. O backup compacta o volume `storage` montado (somente
   leitura) no contêiner de backup, com `set -e`; o volume existe desde a criação da pilha (commit
   `c8410f6`, 09/10) e é o mesmo usado pela API (`STORAGE_DIR=/data/storage`).
4. Nenhuma suíte automática da homologação envia arquivos (saúde/acesso/websocket); o anexo veio de
   uso manual.
5. O mecanismo funciona com arquivo real (2.2, último item).

Conclusão provável: **o arquivo está ausente na ORIGEM** (volume), e por isso ausente no backup e na
restauração — não é falha do backup nem do teste. **Não aprovado sem evidência direta**: o runner não
tem operação que liste o volume ou o conteúdo do `storage.tar.gz`, e o operador não tem SSH.

#### 2.3.1 Evidência direta (somente leitura, no Cloud Shell)

```bash
cd ~/Cen-rio-app && git pull --ff-only origin claude/reformulacao-fase-4
eval "$(ssh-agent -s)"; ssh-add -t 1h ~/.ssh/google_compute_engine
bash infra/homolog/gcp/auditar-arquivos.sh
```

`infra/homolog/gcp/auditar-arquivos.sh` confere o id da VM e, só com leituras (SELECT, `find`/`stat`/
`sha256sum` dentro do contêiner da API, `tar -t` do backup mais recente), mostra para cada
`stored_files`: chave interna, finalidade, tamanho, data, nº de anexos, presença/tamanho/hash na
**origem** e presença/tamanho no **backup**, a miniatura derivada e arquivos órfãos — com o veredito
"ausente na origem", "ausente no backup" ou "íntegro". Não mostra nomes originais nem dados pessoais.
Testado localmente (banco + volume + backup reais do ambiente isolado): íntegro → ✔; ausente na
origem e no backup → identificado; órfão real → identificado; miniaturas não viram falsos órfãos.

Decisão após a leitura:

- **ausente na origem** (esperado): é um registro de homologação sem arquivo, anterior a este
  trabalho; nenhum dado real; o backup está correto. Item 3 passa a **APROVADO com ressalva**, e o
  passo 17 do deploy prova foto real no backup.
- **presente na origem e ausente no backup**: falha de backup → **NO-GO** até corrigir.

### 2.4 Retorno

- R2 = `3e0d2d0` + migrations F2/F3 + guarda. Testes isolados (`retorno-guarda-teste.txt`):
  com peça aprovada sem embalagem não entregue, **`db:migrate` bloqueia (código 3) e a API não
  inicia (78)**, 22 tabelas idênticas; após entregar pela F′, o retorno passa, encerra os avisos da
  Fase 4 com auditoria (idempotente), R2 lê tudo (rotas 200) e **22 tabelas operacionais e
  financeiras ficam idênticas** com as rotinas periódicas ligadas (3 min; R sem guarda: 16 min).
- Entregas desfeitas, inspeções sem embalagem, autoaprovação e fotos tratadas: lidas por R2 sem
  erro; nenhuma reversão financeira.
- Pré-checagem antes de qualquer retorno: `GET /api/v1/system/rollback-readiness` em F′.

### 2.5 Infraestrutura

- VM `cenario-homolog` RUNNING (34 dias), e2-small. Disco **30 GB, 14 GB usados, 15 GB livres**.
- Contêineres: postgres/api/web **healthy**, caddy/backup running; `/api/ready` 200.
- Memória 1,9 GB (1,05 GB disponível), swap 198 MB/2 GB; carga 0,24. API 141 MB/512 MB, web
  144/448, postgres 88/448.
- Imagens: 9,7 GB (versões protegidas `3e0d2d0`, `de31aa7`, `a7f4f93`). F′ + R2 ≈ 4,5–5 GB → sobra
  ~10 GB; `prepare_version` exige ≥ 3 GB. **Nenhuma limpeza necessária.**
- Portão de publicação **fechado**. Snapshot `cenario-homolog-antes-30gb-202611121709` disponível.

### 2.6 Segurança e isolamento

- Homologação e produção no mesmo projeto, mas em recursos distintos: VM/zona (`us-east1-b` ×
  `southamerica-east1-b`), disco, VPC `cenario-homolog-vpc`, repositório `cenario-homolog`, bucket
  de backups e segredos `homolog-*`, contas `claude-operador`/`cenario-homolog-vm` (a de produção
  nunca usada). Todas as operações desta auditoria têm o alvo `cenario-homolog`.
- A API **não faz nenhuma chamada de rede de saída** (sem `fetch`, `http(s).request` ou cliente HTTP
  no código da API); não há envio de e-mail, SMS, WhatsApp, push, convite nem gateway de pagamento.
  "WhatsApp" existe só como campo de contato do cliente e link `wa.me` (clique humano) na página
  pública. Alertas da Fase 4: só avisos internos. Pagamentos são lançamentos manuais.
- Única saída da VM: envio de backup ao bucket da homologação. Acesso: proxy com autenticação básica
  e token de portão; páginas `noindex`. Administrador semeado com e-mail fictício
  (`gestor@teste.cenariogestao.com.br`).

### 2.7 Testes

| Conjunto                                                                               | Resultado                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| API (F′ `63674f1`)                                                                     | **1013 passaram, 0 falharam, 13 pulados**     |
| Shared / Web                                                                           | 151/151 · 22/22                               |
| E2E completo (`7e047d5`; F′ não muda tela)                                             | **68/68**                                     |
| Cadeia de migrations (aplica, reverte, reaplica, recusa com dados, backup/restauração) | ✔                                            |
| Compatibilidade `3e0d2d0` × esquema novo                                               | 971 ✔, 1 falha estática esperada, 13 pulados |
| Imagens isoladas (F/F′/R/R2): migration pela imagem, API, web HTTPS, fotos, retorno    | ✔                                            |
| Backup + restauração com arquivo real (local)                                          | ✔                                            |

Manuais obrigatórios (roteiro `HOMOLOGACAO-INTEGRADA-ROTEIRO-MANUAL.md`, após o deploy): fotos em
celular/Safari/tablet físico (orientação, sem GPS), tablets e produção, programação semanal,
qualidade com embalagem ligada/desligada, entrega direta e desfazer (incl. bloqueios), conciliação
e financeiro, painel "Hoje"/alertas/produtividade sem valores, permissões e auditoria, e a prova de
foto real no backup (passo 17).

### 2.8 Validação de segurança dos arquivos (12/11, 17:20–17:30 UTC)

**Resultado da leitura na homologação** (`auditar-arquivos.sh`, executado por você): 1 registro em
`stored_files` — `attachment/2d0e835e-3895-4120-af0d-d91674a17cfc`, 24.118 bytes —
**ausente na origem** (volume) **e ausente no backup**; 0 arquivos no volume e no backup.

**Registro preexistente, documentado sem alteração.** Nada foi excluído ou modificado (nem o
registro, nem o anexo, nem o volume). Ele existe desde antes deste trabalho (estava no backup de
11/11) e permanece como está.

**Causas possíveis, pelo código e pela configuração:**

1. **Exclusão pelo usuário (mais provável).** Na versão ativa (`3e0d2d0`) e na F′, "remover foto"
   (`DELETE /api/v1/attachments/:id`) é **exclusão lógica** do registro (`attachments.deleted_at` e
   `stored_files.deleted_at` preenchidos, mantidos para histórico e auditoria
   `attachment.removed`) **e remoção física do arquivo**. É exatamente o quadro "registro sem
   arquivo". Todas as leituras ignoram registros excluídos (listagem filtra `deletedAt: null`; a rota
   `/api/files/:id` responde 404), então não há efeito visível.
2. **Arquivo perdido sem exclusão (improvável).** Gravação é atômica (arquivo temporário +
   `rename`) e acontece **antes** da transação do banco; se o banco falha, o arquivo é apagado — não
   sobra registro sem arquivo por esse caminho. O volume `storage` existe desde a criação da pilha
   (09/10) e nenhum script da VM remove volumes ou arquivos (`vm.sh`/runner sem `down -v`, `volume
rm` ou `prune`). Restaurações (`recuperar`) só acrescentam arquivos.

**Para fechar a causa** (somente leitura): o `auditar-arquivos.sh` foi atualizado e agora mostra
`deleted_at` do arquivo e do anexo e a trilha `attachment.added/removed` (só ação, data e tipo).
Repita `bash infra/homolog/gcp/auditar-arquivos.sh`: "EXCLUÍDO pelo usuário … — consistente"
confirma a causa 1; "ausente NA ORIGEM sem exclusão registrada" indica a causa 2 (registro órfão
real, que o deploy não altera — ver adiante).

**Teste isolado de backup e restauração com arquivo temporário — APROVADO**
(`scripts/test-backup-arquivos-isolado.sh`, evidência abaixo): mesma imagem do serviço de backup
(`postgres:16`), mesmos `scripts/backup.sh`/`restore.sh` (idênticos aos da VM, `git diff` vazio
desde `5ff1597`), mesmas montagens (`/data/storage` somente leitura, `/data/backups`), arquivo de
**24.118 bytes** e miniatura gravados como a API grava (dono 1000, modo 0600):

| Etapa                                                          | Resultado                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Backup (`bash /scripts/backup.sh /data/backups`)               | `storage.tar.gz` com os 2 arquivos (24.118 e 2.048 bytes, 1000/1000, 0600); SHA256SUMS ✔ |
| Restauração como `vm.sh restaurar-teste` (`--storage /tmp/rs`) | 2 arquivos; SHA-256 **idênticos**                                                         |
| Restauração como `vm.sh recuperar` (volume gravável)           | arquivo, miniatura e registro **idênticos**; dono 1000, modo 600 (legível pela API)       |
| Origem                                                         | inalterada (montada somente leitura)                                                      |

Também o teste do repositório `scripts/test-backup-restore.sh` (banco + arquivo + aplicação subindo
sobre o restaurado): ✔.

**Prova na infraestrutura real — preparada, PENDENTE da sua autorização:**
`infra/homolog/gcp/testar-backup-arquivos-vm.sh` (frase `TESTAR BACKUP DE ARQUIVOS NA
cenario-homolog`). Cria **um contêiner temporário** do próprio serviço `backup` da pilha
(`docker compose run --rm --no-deps`, removido no fim), gera o arquivo de teste em `/tmp` desse
contêiner, roda o `backup.sh` real com destino `/tmp` (o `pg_dump` do banco real só lê), extrai e
compara SHA-256, e confere que o volume de arquivos, a pasta de backups e os contêineres da pilha
(mesmos ids) não mudaram. Testado contra uma réplica do serviço (imagem `postgres:16`, mesmas
montagens) com `sudo docker compose` simulado: ✔ em todas as etapas.
Alternativa já prevista: passo 17 do deploy (foto sintética + `backup_create` + `backup_restore_test`).

**O deploy não agrava a inconsistência:**

- Migrations: a da Fase 2 só **acrescenta colunas anuláveis** em `stored_files` (tratamento de
  imagem) com uma regra satisfeita pelos registros atuais (todas nulas); a da Fase 3 não toca
  arquivos. Nenhuma migration apaga, move ou altera registros de arquivo.
- F′ não percorre nem regrava arquivos existentes na partida ou em rotinas. A ferramenta de fotos
  antigas (`tools/fotos-legadas.ts`) **não** faz parte do deploy, ignora registros excluídos e só
  conta arquivos ausentes.
- Backup/restauração só acrescentam arquivos; nenhum script remove arquivos.
- Ponto de atenção (preexistente, igual em `3e0d2d0`): se o registro **não** estiver excluído e
  alguém abrir a OS dele, a leitura do arquivo ausente responde **500** (na F′ também pela
  miniatura da galeria). Isso pode disparar o critério "5xx repetido" do passo 10 sem ser regressão.
  Mitigação: identificar a OS pela leitura acima e não usá-la no roteiro; correção opcional futura:
  responder 404 quando o arquivo não existe (exige nova imagem — não feito sem autorização).

## 3. Riscos e mitigação

| Risco                                                                | Mitigação                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registro de arquivo sem arquivo físico (preexistente)                | Documentado e preservado (2.8); confirmar causa com a nova leitura; não usar a OS dele no roteiro; prova real do backup por `testar-backup-arquivos-vm.sh` (autorização) ou passo 17 |
| Leitura de arquivo ausente responde 500 (preexistente)               | Não confundir com regressão no passo 10; correção opcional (404) em versão futura                                                                                                    |
| Peças aprovadas sem embalagem impedem o retorno                      | Guarda automática em R2 + prontidão em F′                                                                                                                                            |
| Migration falhar no meio                                             | Ponto de recuperação obrigatório; `rollback_to_recovery_point`                                                                                                                       |
| Memória da API com muitas fotos simultâneas (430/512 MB local)       | Medir no passo 15 e no roteiro de fotos; critério de interrupção > 90%                                                                                                               |
| Imagem validada localmente ≠ registro                                | `prepare_version` confere digests do registro na VM (passo 2)                                                                                                                        |
| Ressalvas abertas (fotos antigas com GPS, CPU na VM, Safari, tablet) | Roteiro manual; migração de fotos antigas fora deste deploy                                                                                                                          |

## 4. Sequência exata do deploy (NÃO executar sem autorização)

Todas pelo runner (`python3 infra/homolog/gcp/autonomia/operar.py op <operação> …`). F′ =
`63674f1d116ed86a92dbcc421f2fd702e41b169d`; R2 = `341badb59624996cd95c1213808c51631bf34b92`.

| #   | Operação                                                                                                        | Para se                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 0   | `verificar`, `version`, `health`, `migration_status`, `disk_status`, `gate_status`, `imagens F′`, `imagens R2`  | ativa ≠ `3e0d2d0`, migration pendente, saúde ≠ OK, digest ≠ 2.1, < 10 GB livres |
| 1   | `gate_open`                                                                                                     | —                                                                               |
| 2   | `prepare_version version=F′` (sem parar nada)                                                                   | digest ≠ 2.1, < 3 GB livres                                                     |
| 3   | `maintenance_on`                                                                                                | API/web não param                                                               |
| 4   | `recovery_point_create`                                                                                         | backup/SHA/restauração não idênticos, cópia no bucket falhou                    |
| 5   | `backup_validate folder=<pasta do passo 4>`                                                                     | SHA inválido                                                                    |
| 6   | `migration_precheck version=F′`                                                                                 | qualquer bloqueio; pendentes ≠ `…fase_2`, `…fase_3`                             |
| 7   | `migrate version=F′`                                                                                            | qualquer erro → `rollback_to_recovery_point`                                    |
| 8   | `migration_verify version=F′`, `database_counts`                                                                | ≠ 37 aplicadas; contagem existente ≠ passo 0                                    |
| 9   | `activate_version version=F′`                                                                                   | API não saudável em 5 min                                                       |
| 10  | `health`, `smoke_test`, `websocket_test`, `run_homologation_tests suite=completo`, `container_logs service=api` | qualquer falha, 5xx repetido                                                    |
| 11  | prontidão de retorno (gestor): `/api/v1/system/rollback-readiness`                                              | `ready ≠ true`                                                                  |
| 12  | `prepare_version version=R2`                                                                                    | < 3 GB livres                                                                   |
| 13  | `gate_close`                                                                                                    | —                                                                               |
| 14  | `version`, `disk_status`, `resources`, `images_cleanup_plan` (só leitura)                                       | ativa ≠ F′                                                                      |
| 15  | `resources` durante o roteiro de fotos                                                                          | API > 90% por 5 min                                                             |
| 16  | roteiro manual                                                                                                  | critérios NO-GO do roteiro                                                      |
| 17  | após fotos de teste (com autorização de dados sintéticos): `backup_create` → `backup_restore_test`              | "arquivos restaurados" = 0                                                      |

Indisponibilidade estimada (3–9): 5–10 min.

## 5. Sequência exata do retorno

| Situação                                           | Operações                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Falha antes do passo 7                             | `maintenance_off` → `gate_close` (volta `3e0d2d0`, nada mudou no banco)                                                                                                                                                                                                                                                                                                                                                             |
| Falha no passo 7 ou logo após ativar, sem uso real | `rollback_to_recovery_point` → `health`, `smoke_test`, `migration_status` (35) → `gate_close`                                                                                                                                                                                                                                                                                                                                       |
| Problema depois de uso real (sem perda de dados)   | prontidão `ready: true` (senão: entregar as peças listadas) → `gate_open` → `maintenance_on` → `recovery_point_create` → `migrate version=R2` (guarda: bloqueia sem alterar nada, ou encerra os avisos da Fase 4 com auditoria; nenhuma migration pendente) → `activate_version version=R2` → `health`, `smoke_test`, `run_homologation_tests suite=completo`, `migration_verify version=R2` (37), `database_counts` → `gate_close` |
| Guarda bloqueou no `migrate` de R2                 | nada foi alterado → `maintenance_off` (volta F′) → entregar as peças listadas → repetir                                                                                                                                                                                                                                                                                                                                             |

## 6. Veredito

**GO COM RESSALVAS** para o deploy integrado.

- O registro sem arquivo é **preexistente**, está documentado e preservado, e o deploy não o
  altera nem o agrava (2.8).
- O backup e a restauração de arquivos estão **comprovados em ambiente isolado** com a mesma
  imagem, os mesmos scripts e as mesmas montagens da homologação, com SHA-256 idênticos.
- O backup de arquivos **ainda não está plenamente aprovado na infraestrutura real**: falta a prova
  na VM. Recomendação: autorizar `testar-backup-arquivos-vm.sh` (não altera volumes, banco,
  backups nem contêineres) **antes** do deploy; se preferir não executar nada na VM agora, a prova
  fica no passo 17, e o deploy segue apoiado no ponto de recuperação do passo 4.

Ressalvas: causa do registro a confirmar pela nova leitura; 500 preexistente ao abrir arquivo
ausente; memória da API com fotos; testes manuais pendentes. Nada foi implantado; aguardo sua
autorização explícita.
