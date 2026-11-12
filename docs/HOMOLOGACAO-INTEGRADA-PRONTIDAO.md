# Homologação integrada — relatório de prontidão

Situação em 12/11/2026, 16:15 UTC. **Deploy integrado e migrations em homologação NÃO autorizados e
NÃO executados.** Este relatório substitui o roteiro da seção 6 de
`HOMOLOGACAO-INTEGRADA-PREPARACAO.md` (que continua valendo para o diagnóstico).

Resumo: as proteções de retorno estão prontas e testadas, e as imagens novas foram construídas com
digests conferidos. **Falta só a ampliação do disco**, que eu **não consigo executar**: a conta do
operador não tem permissão para redimensionar discos nem acesso SSH à VM, e não mudo permissões
(regra fixa). Ela fica com você, por um script pronto e testado (seção 1).

## 1. Ampliação do disco (Opção B) — pronta, aguardando execução humana

### 1.1 Identificação [MEDIDO, somente leitura]

| Item              | Homologação (alvo)                                                                                                            | Produção (NÃO tocada)                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| VM                | `cenario-homolog`, id `5606039017119619228`, `us-east1-b`, e2-small, RUNNING                                                  | `cenario-prod`, `southamerica-east1-b`, RUNNING    |
| Disco             | `cenario-homolog`, id `4754767015764629660`, `pd-balanced`, **20 GB**, boot, anexado só a `cenario-homolog`, imagem Debian 12 | `cenario-prod` (50 GB), snapshots diários próprios |
| Snapshots do alvo | nenhum (sem política)                                                                                                         | —                                                  |

### 1.2 Reinício, indisponibilidade e risco

- **Sem reinício e sem indisponibilidade**: o Google Cloud aumenta disco com a VM ligada; a partição
  (`growpart`) e o sistema de arquivos ext4 (`resize2fs`) crescem com o disco montado. Nenhum
  contêiner é parado.
- **Irreversível**: disco não pode ser reduzido depois (custo permanente enquanto a VM existir).
- **Risco de perda de dados: muito baixo** (operação só de crescimento). Mitigações: snapshot do
  disco antes (padrão do script) + backup diário da aplicação já validado (seção 5).
- Nada no procedimento exige parada; se algo inesperado aparecer, o script para antes do passo
  seguinte.

### 1.3 Custo adicional estimado (preço de tabela do Google Cloud, us-east1)

| Item                                    | Cálculo                            | Por mês                                                 |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| +10 GB em `pd-balanced`                 | 10 GB × US$ 0,10/GB·mês            | **≈ US$ 1,00**                                          |
| Snapshot prévio (opcional, recomendado) | ~13–14 GB usados × US$ 0,05/GB·mês | ≈ US$ 0,70 enquanto existir (apagar após a homologação) |

O orçamento do projeto de homologação (`LIMITE_USD=20.00` em `homolog.sh`) comporta. Valores
aproximados; o faturamento real pode variar com impostos e câmbio.

### 1.4 Procedimento (Cloud Shell, na raiz do repositório, branch `claude/reformulacao-fase-4`)

```bash
git fetch origin && git checkout <SHA final deste relatório>
eval "$(ssh-agent -s)"; ssh-add -t 1h ~/.ssh/google_compute_engine
bash infra/homolog/gcp/ampliar-disco.sh conferir     # só leitura
bash infra/homolog/gcp/ampliar-disco.sh executar     # pede: AMPLIAR cenario-homolog PARA 30 GB
```

O script (`infra/homolog/gcp/ampliar-disco.sh`):

1. confere conta, projeto, **ids** da VM e do disco, tipo, anexação exclusiva, zona ≠ produção,
   raiz `/dev/sda1` ext4 como última partição, `growpart`/`resize2fs` presentes;
2. grava o **inventário** (imagens, volumes, contêineres, pastas de backup) em
   `~/cenario-homolog-relatorios/`;
3. pede a frase de confirmação;
4. snapshot do disco (`--sem-snapshot` para pular) e espera READY;
5. `gcloud compute disks resize … --size=30`, confere 30 GB;
6. `growpart /dev/sda 1` + `resize2fs /dev/sda1` por SSH (IAP), confere o tamanho;
7. refaz o inventário: **mesmas imagens, volumes e contêineres; nenhuma pasta de backup a menos**;
8. para no primeiro resultado inesperado (cada caso testado — seção 1.5).

Depois, eu confiro pelo runner (somente leitura): `disk_status`, `health`, `version`,
`images_cleanup_plan`, `backup_list`, `database_counts`.

### 1.5 Teste do script [MEDIDO com `gcloud` simulado]

Sem permissão para rodar contra a VM real, o script foi testado com um `gcloud` simulado: conferência
OK; frase errada → nada alterado; id de disco diferente, raiz não-ext4 e `sda1` não-última → para
antes de alterar; `growpart` com erro → para depois do resize sem mais nada; imagem que some depois
→ para e acusa; execução completa → snapshot, resize, ampliação, inventário igual. Os únicos comandos
que alteram algo apontam para `cenario-homolog` em `us-east1-b`; nenhum menciona produção.

## 2. Proteções do retorno [TESTADO]

### 2.1 Verificação automática + bloqueio (sem mudar nenhuma regra de negócio)

Regra única (mesma consulta nos dois lados): peça cuja **última** inspeção está aprovada **sem
embalagem** e que não está entregue/devolvida/cancelada.

- **Na versão integrada (F′ = `63674f1`)**: `GET /api/v1/system/rollback-readiness`
  (`empresa.configurar`, somente leitura) → `ready`, **quantidade e identificadores** (código,
  descrição, cliente, OS, etapa, id) e os avisos da Fase 4 abertos. Para consultar antes de
  qualquer retorno. 4 testes de API (bloqueia/libera/rodada nova/permissão; não altera dados).
- **Na imagem de retorno (R2 = `341badb`)**: `infra/homolog/retorno-guarda.mjs`
  (sha256 `249455264d71f55c…`), sem dependência nova:
  - `pnpm db:migrate` (o passo que `vm.sh migrar` executa **antes de ativar**) roda `preparar`:
    com peça incompatível sai com código 3, lista as peças e **não altera nada**;
  - `api-iniciar.sh` roda `verificar` antes de iniciar: com peça incompatível a API **não inicia**
    (código 78) — protege também um `rollback_version` direto.

R2 = `3e0d2d0` + as duas migrations (byte a byte, sha256 `187744c6…`/`bfc06786…`) + a guarda
(3 arquivos, nada mais). R (`145825d`, sem guarda) fica no registro, **não deve ser usado**.

### 2.2 Avisos da Fase 4 — procedimento seguro, sem SQL improvisado

O próprio `preparar` da guarda, **só quando não há peça incompatível**, encerra numa transação os
avisos `PRAZO_EM_RISCO`, `PECA_PRONTA_SEM_ENTREGA` e `MATERIAL_FALTANTE` abertos e grava auditoria
`system.rollback_prepared` (quantos, por tipo, ids). Idempotente. Roda depois do ponto de
recuperação (exigido por `vm.sh migrar`).

### 2.3 Teste de retorno ponta a ponta [MEDIDO] (`docs/evidencias/homologacao-integrada/retorno-guarda-teste.{sh,txt}`)

Imagens F′ e R2 reconstruídas localmente da mesma fonte; banco representativo das Fases 2–4
(embalagem desligada, 2 peças aprovadas sem embalagem, entrega desfeita, mão de obra paga
parcialmente, cobrança na entrega, foto, aviso da Fase 4).

| Caso                     | Passo                                                            | Resultado                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Peças incompatíveis   | `pnpm db:migrate && pnpm db:status` com R2 (como `vm.sh migrar`) | **bloqueado** (código 3), lista `OS-00001/1` e `OS-00001/2` com ids                                                                                               |
|                          | API R2 iniciando                                                 | **não iniciou** (código 78), mesma lista                                                                                                                          |
|                          | Dados                                                            | **22 tabelas idênticas**; avisos 9 → 9; Fase 4 abertos 1 → 1                                                                                                      |
| 2. Peças entregues antes | Prontidão em F′                                                  | `ready:false` (2 peças) → entrega direta pela API → `ready:true`                                                                                                  |
|                          | `db:migrate` com R2                                              | passou; 1 aviso da Fase 4 encerrado + 1 auditoria; "No pending migrations"                                                                                        |
|                          | De novo                                                          | 0 encerrados, auditoria continua 1 (idempotente)                                                                                                                  |
|                          | API R2                                                           | pronta; todas as rotas 200 (`/today` 404, não existe em R)                                                                                                        |
|                          | Dinheiro                                                         | mão de obra "na entrega" liberada (efeito da entrega feita em F′), "na aprovação" paga parcial R$ 100, cobrança com vencimento — iguais antes e depois do retorno |
|                          | 180 s com rotinas periódicas                                     | **22 tabelas operacionais e financeiras idênticas** ao estado antes do retorno                                                                                    |

Teste anterior (R sem guarda, 16 min com a manutenção de 15 min): também sem nenhuma alteração.

## 3. Imagens e digests confirmados no Artifact Registry [MEDIDO]

| Papel                     | Commit                                     | `api`                                                                     | `web`                                                                     |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **F′ — integrada (usar)** | `63674f1d116ed86a92dbcc421f2fd702e41b169d` | `sha256:940f77087545784a0e0f2adcfd69026ddbc157e7b46095cf565ce95329342e5b` | `sha256:b9b0d32af8e2717fbcbe0865f3abdd920f94d57b2fee020a2fe5033b34d7ebe0` |
| **R2 — retorno (usar)**   | `341badb59624996cd95c1213808c51631bf34b92` | `sha256:b272404e79719dd1b7151502a9681c75be85614362252d688beab59d1c659df7` | `sha256:8559184d2e2d5b1a07a8b19782a02cd4836136e306032cca5e3d07099d27f5f8` |
| F — integrada anterior    | `7e047d5…`                                 | `sha256:49727ccb…871b`                                                    | `sha256:672222f9…a2ba`                                                    |
| R — retorno sem guarda    | `145825d…`                                 | `sha256:bbc944c0…80ec`                                                    | `sha256:03b6efb7…e513`                                                    |

Os 8 digests do registro coincidem com os relatados pelo Cloud Build. F′ = F + somente a rota de
prontidão e seu teste. Imagens antigas (`5ff1597`, `0b75a47`, `a7f4f93`, `de31aa7`, `3e0d2d0`)
intocadas no registro e na VM.

## 4. Estado da homologação [MEDIDO, somente leitura]

- Versão ativa `3e0d2d0`; migrada `3e0d2d0`; candidata `de31aa7`; **portão de publicação fechado**;
  saúde OK; 35 migrations, nenhuma pendente.
- Disco: **20 GB, 4,7 GB livres** (antes da ampliação). Depois: aguardando a execução da seção 1.
- Produção: nenhuma operação a envolveu (só apareceu na listagem de VMs do projeto).

## 5. Backup e restauração [MEDIDO]

- `backup_validate` do backup mais recente (`cenario-staging-20261111T171403Z`): **SHA256SUMS OK**.
- `backup_restore_test` (bancos separados; original só lido): restauração **concluída** — 125
  tabelas, 35 migrations, 654 restrições, 403 índices, 67 gatilhos, 38 colunas financeiras. A
  comparação com o banco vivo acusa só o que foi gravado nas ~22 h depois do backup (presença,
  auditoria, eventos, avisos, propostas) e 3 chaves de idempotência já expiradas — nenhuma tabela
  financeira diferente. Por isso o deploy cria um ponto de recuperação **com a aplicação parada**,
  em que a comparação precisa ser idêntica.
- **Achado**: o backup restaurou **0 arquivos**, mas o banco tem **1 anexo** registrado. O volume de
  arquivos da homologação está vazio (o mecanismo de backup de arquivos está correto: o volume é
  montado e compactado). O anexo existente aponta para um arquivo ausente (origem anterior aos
  últimos 7 dias de log). Não bloqueia, mas a cópia das fotos **ainda não foi provada com arquivo
  real em homologação** → acrescentado ao plano (passo 17).

## 6. Plano definitivo de implantação (NÃO executar sem autorização)

Pré-requisito: disco ampliado e conferido (seção 1). Identificadores: F′ e R2 da seção 3.

| #   | Etapa                                                                                           | Operação                                                                                                                            | Esperado                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0   | Conferência                                                                                     | `verificar`, `version`, `health`, `migration_status`, `disk_status` (≥ 14 GB livres), `gate_status`, `imagens <F′>`, `imagens <R2>` | ativa `3e0d2d0`, 35 migrations, digests da seção 3                                     |
| 1   | Portão                                                                                          | `gate_open`                                                                                                                         | aberto                                                                                 |
| 2   | Preparar F′ (sem parar nada)                                                                    | `prepare_version version=63674f1d…`                                                                                                 | digests da seção 3; "NÃO migra na partida"; 37 migrations na imagem; ≥ 3 GB livres     |
| 3   | Manutenção                                                                                      | `maintenance_on`                                                                                                                    | API e web paradas                                                                      |
| 4   | Ponto de recuperação                                                                            | `recovery_point_create`                                                                                                             | backup + SHA-256 + restauração **idêntica** + cópia no bucket                          |
| 5   | Integridade                                                                                     | `backup_validate folder=<pasta do passo 4>`                                                                                         | OK                                                                                     |
| 6   | Pré-verificação                                                                                 | `migration_precheck version=63674f1d…`                                                                                              | pendentes: só `…fase_2`, `…fase_3`                                                     |
| 7   | Migrations (ordem: `20270316000000_reformulacao_fase_2` → `20270323000000_reformulacao_fase_3`) | `migrate version=63674f1d…`                                                                                                         | aplicadas; log sem erro                                                                |
| 8   | Conferência                                                                                     | `migration_verify version=63674f1d…`, `database_counts`                                                                             | 37 aplicadas; contagens existentes = passo 0                                           |
| 9   | Ativar                                                                                          | `activate_version version=63674f1d…`                                                                                                | API saudável                                                                           |
| 10  | Saúde                                                                                           | `health`, `smoke_test`, `websocket_test`, `run_homologation_tests suite=completo`, `container_logs service=api`                     | tudo ✔, sem 5xx                                                                       |
| 11  | Prontidão de retorno                                                                            | gestor abre `/api/v1/system/rollback-readiness`                                                                                     | `ready: true`                                                                          |
| 12  | Preparar R2 (retorno pronto no disco)                                                           | `prepare_version version=341badb5…`                                                                                                 | digests da seção 3; ≥ 3 GB livres; R2 vira a candidata e fica protegida contra limpeza |
| 13  | Portão                                                                                          | `gate_close`                                                                                                                        | fechado                                                                                |
| 14  | Conferência final                                                                               | `version`, `disk_status`, `resources`, `images_cleanup_plan` (só leitura)                                                           | ativa F′; imagens antigas todas presentes                                              |
| 15  | Memória/CPU                                                                                     | `resources` durante o roteiro manual de fotos                                                                                       | API < 90% do limite                                                                    |
| 16  | Roteiro manual                                                                                  | `HOMOLOGACAO-INTEGRADA-ROTEIRO-MANUAL.md`                                                                                           | critérios de aceite                                                                    |
| 17  | Fotos no backup                                                                                 | depois de anexar fotos de teste: `backup_create` → `backup_restore_test`                                                            | "arquivos restaurados" > 0                                                             |

Nenhuma limpeza de imagens e nenhuma remoção de backup no plano. Indisponibilidade estimada (3–9):
5–10 min (a imagem já foi baixada no passo 2).

### 6.1 Retorno

| Situação                             | Retorno                                                                                                                                                                                                                                                                                                       | Perda                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Falha antes do passo 7               | `maintenance_off` (volta `3e0d2d0`)                                                                                                                                                                                                                                                                           | nenhuma                |
| Falha no passo 7 (migration parcial) | `rollback_to_recovery_point`                                                                                                                                                                                                                                                                                  | nenhuma                |
| Falha depois de ativar, sem uso real | `rollback_to_recovery_point`                                                                                                                                                                                                                                                                                  | o gravado após o ponto |
| Problema após uso real               | (a) prontidão `ready: true` (senão: entregar as peças listadas); (b) `gate_open` → `maintenance_on` → `recovery_point_create` → `migrate version=341badb5…` (guarda: bloqueia ou encerra os avisos da Fase 4 com auditoria; nenhuma migration pendente) → `activate_version version=341badb5…` → `gate_close` | nenhuma                |

Se a guarda bloquear no `migrate` de R2: nada foi alterado → `maintenance_off` volta F′; entregar as
peças listadas e repetir.

### 6.2 Integridade após o retorno

`health`, `smoke_test`, `run_homologation_tests suite=completo`; `migration_verify version=341badb5…`
(37); `database_counts` igual ao anterior ao retorno (exceto avisos e auditoria); logs da API com a
linha "guarda do retorno"; abrir 3 anexos e o Resultado por OS das OS de teste.

## 7. Critérios de GO / NO-GO para o deploy

**GO** somente se todos:

1. disco ampliado para 30 GB, sistema de arquivos ≥ 29 GB, inventário preservado (seção 1);
2. passo 0 com versão ativa `3e0d2d0`, 35 migrations, saúde OK e digests F′/R2 iguais à seção 3;
3. ponto de recuperação do passo 4 registrado (restauração idêntica + cópia no bucket);
4. sua autorização específica para o deploy e as migrations.

**NO-GO / interromper** se qualquer um:

1. digest diferente, disco livre < 3 GB após preparar, ou inventário alterado;
2. backup/restauração do ponto não idêntico ou cópia no bucket falhou;
3. pré-verificação com qualquer bloqueio; migration com erro;
4. API não saudável em 5 min, teste da VM falhando, 5xx repetido, memória da API > 90% por 5 min;
5. contagem de tabela existente diferente do passo 0;
6. prontidão de retorno (passo 11) diferente de `ready: true` com dados de teste ainda não criados.

## 8. Riscos remanescentes

1. Ampliação do disco depende de execução humana (sem permissão do operador; IAM não alterado).
2. Fotos: cópia em backup não provada com arquivo real na homologação (anexo órfão existente).
3. Memória da API com várias fotos grandes simultâneas (430/512 MB no teste local).
4. As imagens testadas localmente foram reconstruídas da mesma fonte (registro inacessível do
   ambiente isolado); os digests do registro são conferidos no passo 2.
5. Ressalvas abertas: fotos antigas com GPS, CPU na VM, Safari e tablet físico (roteiro manual).

## 9. Veredito de prontidão

**GO COM RESSALVAS** para seguir ao deploy **depois** da ampliação do disco (seção 1) e da sua
autorização específica. Nenhuma regra de embalagem, entrega ou financeiro foi alterada; o retorno
está bloqueado automaticamente quando seria inseguro e testado sem alteração financeira.
