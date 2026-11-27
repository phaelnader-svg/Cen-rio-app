# Homologação integrada (Fases 0 a 4) — preparação técnica e plano de implantação

Autorização recebida: **somente a preparação técnica**. Nada foi implantado. Nenhuma migration foi
executada em homologação ou produção; a versão ativa, as imagens e os backups da VM não foram
alterados; produção e branch padrão intocados. Operações usadas na homologação: **somente leitura**
(`version`, `health`, `gate_status`, `disk_status`, `resources`, `backup_list`, `migration_status`,
`database_status`, `database_counts`, `images_cleanup_plan`) e `imagens`. Os builds foram feitos pelo
gatilho próprio (Cloud Build → Artifact Registry), sem tocar a VM.

## 1. Estado atual da homologação (12/11/2026, 14:50 UTC) [MEDIDO]

| Item                       | Valor                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| VM                         | `cenario-homolog`, e2-small (2 vCPU compartilhadas, 2 GB + 2 GB swap), ligada há 34 dias              |
| Runner / scripts da VM     | 2.2.0 / `5ff1597c0d1c`                                                                                |
| Versão ativa               | `3e0d2d0` (Fase 1) · migrada: `3e0d2d0` · candidata: `de31aa7` (retorno da Fase 1)                    |
| Portão de publicação       | **fechado**                                                                                           |
| Saúde                      | postgres, api, web saudáveis; caddy e backup em execução; `/api/ready` 200                            |
| Migrations no banco        | 35, última `20270309000000_materiais_estoque_entrega`, nenhuma pendente/falha                         |
| Banco                      | PostgreSQL 16.15, 18 MB; 3 OS, 0 entregas, 1 anexo, 0 inspeções                                       |
| Disco                      | 20 GB, **14 GB usados, 4,7 GB livres (76%)**; imagens 9,7 GB; volumes 104 MB; backups 11 MB           |
| Memória                    | 1,9 GB; 1,1 GB disponível; swap 196 MB em uso                                                         |
| Backups na VM              | diários (17:14 UTC) de 28/10 a 11/11 + 3 extras de 11/11 (deploy da Fase 1); cópia no bucket          |
| Imagens na VM (protegidas) | `3e0d2d0` (ativa), `de31aa7` (candidata), `a7f4f93` (versão do ponto de recuperação); postgres, caddy |

## 2. Imagens construídas [MEDIDO]

| Papel             | Commit (branch)                                                                 | Imagem `api` (digest)                                                     | Imagem `web` (digest)                                                     |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **F** — integrada | `7e047d5d4e7e4f0960891307d20e9f9f32025a7f` (`claude/reformulacao-fase-4`)       | `sha256:49727ccb5b272344c3592528659d7654c006332292a81bd22068668a7ead871b` | `sha256:672222f95c3fd50f0f950c1b310260ecca02e901a464d8227e0a883f68aab2ba` |
| **R** — retorno   | `145825d9d7f9946ebb6d6715b13dab853d897bd9` (`claude/retorno-3e0d2d0-integrada`) | `sha256:bbc944c085abb909e22946e64283b9e9503c8170a9969e266d582092c20180ec` | `sha256:03b6efb724b4ad2aa5e1c8dd5deea8acc007a855fa8204ed86c629fa30bbe513` |

- Registro: `us-east1-docker.pkg.dev/cenariogestao/cenario-homolog/{api,web}:<commit>`; builds
  `f627569d-…` (F, 4 min 46 s) e `5d6254ee-…` (R, 3 min 44 s), ambos `SUCCESS`, conta `cenario-build`.
- **R** = `3e0d2d0` + SOMENTE `20270316000000_reformulacao_fase_2/migration.sql` (sha256
  `187744c6…6d5d`) e `20270323000000_reformulacao_fase_3/migration.sql` (sha256 `bfc06786…3067`),
  byte a byte iguais às de `7e047d5`; sem `.down.sql`; nenhuma outra mudança (`git diff --stat`: 2
  arquivos, 92 linhas).
- **Versões de retorno anteriores preservadas**: branches `claude/retorno-5ff1597-fase0` (`0b75a47`)
  e `claude/retorno-a7f4f93-fase1` (`de31aa7`) intocadas; imagens `5ff1597`, `0b75a47`, `a7f4f93`,
  `de31aa7` e `3e0d2d0` **existem no Artifact Registry** (conferido).
- Os scripts da VM (`5ff1597c0d1c`) **não precisam mudar**: entre eles e `7e047d5` a única diferença
  em `infra/homolog` é a mesma que já existe com a versão ativa (`SITE_COMERCIAL` no Compose). Sem
  variável de ambiente nova. Dependência nova na API: `sharp` (tratamento de imagem).

## 3. Validação das imagens em ambiente isolado [MEDIDO]

O registro não é acessível a partir do ambiente isolado (proxy recusa `us-east1-docker.pkg.dev`), então
as imagens foram **reconstruídas localmente com o mesmo Dockerfile a partir do `git archive` dos
mesmos commits** (a mesma fonte enviada ao Cloud Build). Diferença conhecida: a imagem-base
`node:22.23.3-bookworm` veio do espelho público do Google (Docker Hub limitou as requisições) e
recebeu, só localmente, o certificado e as variáveis do proxy do ambiente isolado para o
`pnpm install`; em execução, as variáveis de proxy foram zeradas. As camadas da aplicação são as
mesmas instruções sobre a mesma fonte. Banco: PostgreSQL 16 local descartável; proxy: Caddy 2.10 com
certificado interno (HTTPS como na VM); configuração de homologação (`APP_ENV=staging`,
`NODE_ENV=production`, `MIGRATE_ON_START=0`, cookie seguro, limites de memória de 512 MB/448 MB).

| Verificação                                                                                                                       | F (`7e047d5`)                                                          | R (`145825d`)                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Migration exatamente como `vm.sh migrar` (`pnpm db:migrate && pnpm db:status`) num banco no estado da homologação (35 migrations) | aplicou **só** `…fase_2` e `…fase_3`, nessa ordem; "schema up to date" | `db:status`: "up to date" (inicia com `MIGRATE_ON_START=0`)                                          |
| API inicia e fica pronta (`/api/ready`)                                                                                           | 200                                                                    | 200                                                                                                  |
| Login + 19 rotas de leitura (OS, peças, entregas, financeiro, painel, avisos, anexos)                                             | todas 200                                                              | todas 200 (`/management/today` 404: não existe em R, esperado)                                       |
| Web pelo proxy HTTPS (login, Início, OS, aba Qualidade; 1440 e 390 px)                                                            | OK, sem erro de página, sem rolagem lateral                            | OK (login, Início sem "Hoje", OS com "Pronta para entrega"); sem erro de página, sem rolagem lateral |
| Foto 4000×3000 (4,6 MB, com GPS e câmera no EXIF)                                                                                 | 201 em ~1,8 s; gravada 2560×1920 + miniatura; **sem EXIF/GPS**         | (R não trata fotos — comportamento anterior)                                                         |
| 4 fotos simultâneas                                                                                                               | todas 201 (~2 s); API com 430 MB de 512 MB; sem OOM                    | —                                                                                                    |

## 4. Compatibilidade do retorno com dados das Fases 2, 3 e 4 [MEDIDO]

Banco representativo criado **pela API da versão integrada** (`apps/api/test/retorno-integrado.check.ts`):
embalagem **desligada**; sofá e poltronas aprovados **sem embalagem**; mão de obra "na entrega"
(R$ 400) e "na aprovação" (R$ 300, **paga parcialmente** R$ 100 — lançamento independente); cobrança
"na entrega" (R$ 1.000); entrega direta **feita e desfeita**; foto tratada; material na lista simples;
aviso interno `PRAZO_EM_RISCO` (Fase 4). Impressão digital (contagem + md5 de todas as colunas) de 22
tabelas antes de subir R; R rodou 16 min 15 s (15:01:31 → 15:17:46 UTC) com as rotinas periódicas ligadas (inclusive a manutenção
de 15 min), com leituras de todas as telas principais.

### 4.1 Peças aprovadas sem embalagem e ainda não entregues

- R mostra as duas peças como **"Pronta para entrega"** (a etapa gravada), mas a entrega direta de R
  **bloqueia** cada uma com "embalagem concluída" pendente: R exige embalagem e não existe registro de
  embalagem para elas. **Em R essas peças ficam presas** (não há como embalar uma peça já aprovada
  sem registro de embalagem).
- **Pré-condição obrigatória de retorno**: zero peças nessa situação. Consulta:
  `SELECT count(*) FROM quality_inspections qi JOIN service_order_items i ON i.id = qi.service_order_item_id WHERE qi.status = 'APROVADA' AND NOT qi.packaging_required AND i.fulfillment_stage NOT IN ('ENTREGUE','DEVOLVIDA','CANCELADA')`.
  Se > 0: entregar essas peças **antes** do retorno (na versão integrada). Religar a embalagem não
  resolve as já aprovadas (a regra fica gravada na aprovação).

### 4.2 Histórico de entregas desfeitas

- R lê a entrega desfeita sem erro: status `CONCLUIDA`, origem `DIRETA`, itens `NAO_ENTREGUE`, e a
  observação de cada item "Entrega direta desfeita: <justificativa>" aparece (é texto gravado no item).
  R não mostra o selo "desfeita" (campo novo), mas as peças continuam "prontas" e a entrega não conta
  em "entregues hoje" (painel: `deliveredToday = 0`).
- O `.down.sql` da Fase 3 recusa reverter o esquema com entregas desfeitas: o retorno é só de
  aplicação, como planejado.

### 4.3 Nenhuma reversão financeira indevida durante o retorno

- Impressão digital das **22 tabelas** (OS, peças, inspeções, embalagens, entregas, itens e eventos de
  entrega, cobranças, recebimentos, custos, mão de obra, pagamentos, fechamentos, contas, despesas,
  custos de logística, anexos, materiais, interruptores) **idêntica** antes e depois de R rodar 16 min
  com todas as rotinas periódicas (liberação de tarefas, ausências, fila de ajuda, manutenção de 15
  min) e com as leituras de todas as telas (arquivos: `docs/evidencias/homologacao-integrada/
retorno-impressao-{antes,depois}.txt`).
- Pela API de R: mão de obra "na entrega" continua **prevista** (R$ 0 pago, sem competência); a "na
  aprovação" continua **paga parcialmente** (R$ 100) e liberada; cobrança "na entrega" continua
  **aberta, aguardando entrega** (sem vencimento). Nenhum valor voltou, foi liberado ou estornado.
- R gravou apenas avisos operacionais da sua própria rotina de presença ("ausência presumida"), como
  já faz hoje — nada financeiro.

### 4.4 Avisos da Fase 4 no código anterior

- O título do aviso é gravado na criação ("Prazo em risco"), então R o mostra normalmente; R não o
  recalcula nem o resolve sozinho. Por isso o retorno resolve esses avisos antes (seção 6.3).

## 5. Espaço em disco e plano de limpeza (NADA executado) [MEDIDO + ESTIMADO]

- Cada versão nova ocupa ~2,0–2,3 GB próprios na VM (dependências 1,22 GB + build 0,34 GB + fonte
  0,19 GB + camada do web), porque F mudou o `pnpm-lock.yaml` (`sharp`) e R mudou as migrations
  (camadas não reaproveitáveis). Base Node e Postgres/Caddy já estão na VM.
- `preparar-versao` exige **≥ 3 GB livres depois do download**. Hoje: 4,7 GB → depois de F, ~2,4–2,7
  GB → **o preparo de F falharia** ("nada foi alterado", mas o download ocuparia o disco).
- As versões que podem sair do disco da VM estão protegidas pelo próprio runner até deixarem de ser
  "ponto de recuperação" (`a7f4f93`) e "candidata" (`de31aa7`). Elas **continuam no Artifact
  Registry** (conferido) e podem ser baixadas de novo.

**Plano de limpeza proposto (precisa da sua autorização, dentro do deploy):**

1. Depois de criar o novo ponto de recuperação (versão `3e0d2d0`), `a7f4f93` deixa de ser protegida →
   `images_cleanup_plan` → `images_cleanup` (só imagens sem contêiner e fora das protegidas; sem
   `--force`, sem `prune`) libera ~2,3 GB.
2. Depois de `prepare_version F` (candidata = F), `de31aa7` deixa de ser protegida (o retorno da Fase 1
   não serve mais após as migrations das Fases 2 e 3) → nova limpeza libera ~2,3 GB.
3. Resultado esperado: ativa F, anterior `3e0d2d0`, retorno R preparado, ~4–5 GB livres.
4. Backups: 11 MB na VM e cópia no bucket; **nenhuma remoção proposta**.

Alternativa sem remover nada da VM: aumentar o disco de 20 para 30 GB (mudança de infraestrutura;
precisa de outra autorização).

## 6. Plano de implantação (NÃO executar sem autorização específica)

> **Substituído** pelo plano definitivo em `HOMOLOGACAO-INTEGRADA-PRONTIDAO.md` (disco ampliado para
> 30 GB em vez de limpeza; imagens F′ `63674f1` e R2 `341badb` com a guarda do retorno).

Todas as etapas pelo runner (`operar.py op …`), cada uma com descrição; parar no primeiro critério de
interrupção (6.2). Identificadores imutáveis: commits e digests da seção 2.

### 6.1 Roteiro

| #   | Etapa                                                                                                               | Operação                                                                                                         | Esperado                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 0   | Conferência inicial                                                                                                 | `verificar`, `version`, `health`, `migration_status`, `disk_status`, `gate_status`, `imagens <F>`, `imagens <R>` | ativa `3e0d2d0`; 35 migrations; saudável; imagens F e R existem                   |
| 1   | Abrir o portão                                                                                                      | `gate_open`                                                                                                      | aberto                                                                            |
| 2   | Manutenção (API e web param; proxy responde 503)                                                                    | `maintenance_on`                                                                                                 | API/web paradas                                                                   |
| 3   | **Backup + ponto de recuperação** (banco + fotos, SHA-256, restauração de teste em banco separado, cópia no bucket) | `recovery_point_create`                                                                                          | "PONTO DE RECUPERAÇÃO: cenario-… (versão 3e0d2d0)"                                |
| 4   | Integridade do backup                                                                                               | `backup_validate folder=<pasta>`                                                                                 | SHA256SUMS OK                                                                     |
| 5   | Restauração de teste (já feita no passo 3; repetir para registro)                                                   | `backup_restore_test folder=<pasta>`                                                                             | impressão restaurada = original; arquivos restaurados > 0                         |
| 6   | Limpeza 1 (`a7f4f93`)                                                                                               | `images_cleanup_plan` → `images_cleanup`                                                                         | só `a7f4f93` removida; ≥ 6 GB livres                                              |
| 7   | Preparar F                                                                                                          | `prepare_version version=7e047d5d…`                                                                              | digests = seção 2; "NÃO migra na partida"; 37 migrations na imagem; ≥ 3 GB livres |
| 8   | Limpeza 2 (`de31aa7`)                                                                                               | `images_cleanup_plan` → `images_cleanup`                                                                         | só `de31aa7` removida                                                             |
| 9   | Pré-verificação da cadeia                                                                                           | `migration_precheck version=7e047d5d…`                                                                           | pendentes: só `…fase_2` e `…fase_3`; nada desconhecido/divergente                 |
| 10  | **Migrations** (ordem: `20270316000000_reformulacao_fase_2` → `20270323000000_reformulacao_fase_3`)                 | `migrate version=7e047d5d…`                                                                                      | "migrations aplicadas"; banco idêntico ao ponto antes de aplicar                  |
| 11  | Conferência do banco                                                                                                | `migration_verify version=7e047d5d…`, `database_counts`, `database_fingerprint`                                  | 37 aplicadas; contagens iguais às do passo 0 (+ tabelas novas vazias)             |
| 12  | Ativar F                                                                                                            | `activate_version version=7e047d5d…`                                                                             | API saudável                                                                      |
| 13  | Saúde                                                                                                               | `health`, `smoke_test`, `websocket_test`, `run_homologation_tests suite=completo`, `container_logs service=api`  | tudo ✔; sem erro 5xx nos logs                                                    |
| 14  | Preparar R (retorno pronto no disco)                                                                                | `prepare_version version=145825d9…`                                                                              | imagens R presentes; ≥ 3 GB livres                                                |
| 15  | Fechar o portão                                                                                                     | `gate_close`                                                                                                     | fechado                                                                           |
| 16  | Conferência final e relatório                                                                                       | `version`, `disk_status`, `resources`                                                                            | ativa F; anterior `3e0d2d0`; candidata R                                          |

Tempo estimado de indisponibilidade (passos 2–12): 15–25 min, dominado pelo download de F (passo 7).

### 6.2 Critérios objetivos de interrupção

Parar imediatamente (e decidir o retorno pela 6.3) se:

1. passo 0: versão ativa ≠ `3e0d2d0`, migration pendente/falha, ou saúde não OK;
2. passo 3–5: backup sem `database.dump`, SHA-256 inválido, restauração com impressão diferente ou
   cópia no bucket falhou (o runner não registra o ponto);
3. passo 6/8: a limpeza listaria qualquer imagem além da prevista;
4. passo 7: digest diferente da seção 2, ou < 3 GB livres;
5. passo 9: qualquer bloqueio da pré-verificação;
6. passo 10: falha da migration (banco possivelmente parcial → `rollback_to_recovery_point`);
7. passo 12–13: API não saudável em 5 min, qualquer teste da VM falhando, erro 5xx repetido, ou
   memória da API > 90% do limite por mais de 5 min;
8. qualquer contagem de tabela existente diferente do passo 0 (exceto as tabelas novas).

### 6.3 Procedimento de retorno

| Situação                                                      | Retorno                                                                                                                                                                                                                                                                                    | Perda de dados                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Falha **antes** do passo 10 (nada migrado)                    | `maintenance_off` (volta `3e0d2d0`)                                                                                                                                                                                                                                                        | nenhuma                         |
| Falha **no** passo 10 (migration parcial)                     | `rollback_to_recovery_point` (banco + fotos do ponto; versão `3e0d2d0`)                                                                                                                                                                                                                    | nenhuma (nada novo foi gravado) |
| Falha **depois** de ativar F, sem uso real ainda              | `rollback_to_recovery_point`                                                                                                                                                                                                                                                               | o que foi gravado após o ponto  |
| Problema depois de uso real (dados das Fases 2–4 já gravados) | **Versão de retorno R**: (a) resolver os avisos da Fase 4 e garantir **zero peças aprovadas sem embalagem não entregues** (seção 4.1); (b) `maintenance_on` → `recovery_point_create` → `migrate version=145825d9…` (não há pendentes: só registra) → `activate_version version=145825d9…` | nenhuma                         |
| Problema só da Fase 4 (sem migration)                         | Mesmo caminho do anterior com a versão `781e3b8` (precisa de build; não construída)                                                                                                                                                                                                        | nenhuma                         |

Avisos da Fase 4 (antes de R): `UPDATE notifications SET resolved_at = now() WHERE resolved_at IS NULL
AND kind IN ('PRAZO_EM_RISCO','PECA_PRONTA_SEM_ENTREGA','MATERIAL_FALTANTE')` — não há operação do
runner para isso: precisa de autorização e de execução humana (ou de uma operação nova).

### 6.4 Verificação de integridade após o retorno

1. `health`, `smoke_test`, `run_homologation_tests suite=completo`;
2. `migration_verify version=<versão de retorno>` (37 aplicadas, nenhuma desconhecida);
3. `database_counts` igual ao momento anterior ao retorno (R não grava nada sozinho além de sessão e
   auditoria de acesso — medido na seção 4.3);
4. fotos: abrir 3 anexos antigos e 3 novos pelo painel; `backup_restore_test` da pasta mais recente;
5. financeiro: Resultado por OS e pagamentos das OS de teste iguais aos anotados antes do retorno.

## 7. Riscos que permanecem

1. **Peças aprovadas sem embalagem ficam presas em R** (4.1) — mitigação: pré-condição do retorno.
2. **Disco**: sem a limpeza (seção 5) o preparo de F falha. A limpeza remove do disco da VM (não do
   registro) as imagens `a7f4f93` e `de31aa7`.
3. **Memória da API com fotos**: 4 fotos grandes simultâneas levaram a API a 430 MB de 512 MB no teste
   local; a VM tem CPU mais lenta. Ressalva da Fase 2 (CPU na VM) continua aberta; medir no passo 13
   e na homologação manual (seção 2.5 do roteiro).
4. As imagens validadas localmente foram reconstruídas da mesma fonte, não baixadas do registro
   (seção 3); o passo 7 confere os digests do registro na VM.
5. Ressalvas abertas das fases: fotos antigas com GPS (migração não executada), validação funcional,
   tablet físico e Safari (cobertos pelo roteiro manual), alertas com até 5 min de atraso.
6. Resolver os avisos da Fase 4 antes de um retorno exige SQL manual (sem operação no runner).

## 8. Veredito

**GO COM RESSALVAS** para executar o deploy em homologação, pelo roteiro da seção 6, desde que você
autorize junto:

1. a **limpeza de disco** da seção 5 (remover do disco da VM as imagens `a7f4f93` e `de31aa7`, que
   continuam no registro) — sem ela o passo 7 falha; ou, alternativamente, o aumento do disco;
2. a **pré-condição de retorno** da seção 4.1 (nenhuma peça aprovada sem embalagem e não entregue
   antes de voltar para R) e a resolução manual dos avisos da Fase 4 nesse caso;
3. o acompanhamento de **memória e CPU da API** no passo 13 e nas fotos da homologação manual.

Evidências: imagens F e R construídas no registro com digests fixos; as duas executadas em ambiente
isolado em configuração de homologação; migrations aplicadas pela própria imagem F sobre um banco no
estado da homologação (só as duas esperadas); R rodou 16 min sobre dados das Fases 2–4 sem alterar
nenhuma das 22 tabelas operacionais e financeiras; regressão completa da Fase 4 (API 1009, E2E 68/68)
já registrada. Nenhum bloqueio crítico encontrado.
