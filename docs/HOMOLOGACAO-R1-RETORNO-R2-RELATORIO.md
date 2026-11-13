# R-1 — Ensaio do retorno `696e3e9` → R2 `341badb` → `696e3e9` (homologação)

Autorização: "AUTORIZAÇÃO R-1 E PREPARAÇÃO R-4", válida **só na homologação**. Execução em
13/11/2026, das **17:44:48 às 17:56:36 UTC**.

Não foram feitos:

- nenhuma ação na produção;
- nenhuma promoção de imagem (o R-2 não está autorizado);
- nenhuma limpeza de imagens, volumes ou backups;
- nenhuma alteração de código.

Nenhum registro de negócio foi criado ou alterado. As únicas gravações foram as previstas pelo
procedimento: ponto de recuperação, registro de versão, encerramento e reabertura automáticos dos
avisos internos, e auditoria.

Evidências brutas (com o mascaramento do runner, sem segredos):
`docs/evidencias/homologacao-r1-retorno-r2/`.

## Resultado: **APROVADO**

- O retorno para a R2 e a volta para `696e3e9` funcionaram pelo procedimento protegido.
- Todas as verificações passaram nas duas versões.
- **Não houve nenhuma perda nem divergência** nos dados financeiros, operacionais ou de arquivos.
- 124 das 126 tabelas terminaram idênticas ao estado inicial, incluindo o conteúdo pelo hash. As 2
  restantes só ganharam registros técnicos previstos (seção 5).

## 1. Versões e imagens

| Papel                    | Commit                                     | api                                                                       | web                                                                       |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Ativa no início e no fim | `696e3e9ddc5f1c803a4b9244a075ed498ad81be3` | `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f` | `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72` |
| Retorno ensaiado (R2)    | `341badb59624996cd95c1213808c51631bf34b92` | `sha256:b272404e79719dd1b7151502a9681c75be85614362252d688beab59d1c659df7` | `sha256:8559184d2e2d5b1a07a8b19782a02cd4836136e306032cca5e3d07099d27f5f8` |

O `prepare_version` conferiu, na VM, os digests do Artifact Registry da R2: eram iguais aos da
tabela. Os contêineres de `696e3e9` voltaram a usar os IDs autorizados.

## 2. Linha do tempo (UTC)

| Hora              | Etapa                                                                                                                                                                                                              | Resultado                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 17:44:48          | Estado inicial, só leitura: `version`, `health`, `gate_status`, `migration_status`, `database_counts`, `database_fingerprint`, `resources`, `disk_status`, `backup_list`, `images_cleanup_plan` (só o plano), logs | `696e3e9` ativa e saudável; 37 migrations; portão fechado; 0 respostas 5xx; 19 backups                      |
| 17:46:07          | `gate_open`                                                                                                                                                                                                        | ✔                                                                                                          |
| 17:46:22          | `prepare_version 341badb…`                                                                                                                                                                                         | ✔ digests conferidos, 8 GB livres; a imagem não migra na partida                                           |
| 17:46:29          | `migration_precheck 341badb…`                                                                                                                                                                                      | ✔ **PREFLIGHT OK**: 0 pendentes; nada incompleto, desconhecido, divergente ou fora de ordem                |
| 17:46:35          | `migration_precheck 696e3e9…`                                                                                                                                                                                      | ✔ **PREFLIGHT OK**, idem                                                                                   |
| 17:46:49          | `maintenance_on`                                                                                                                                                                                                   | ✔ API e web paradas                                                                                        |
| 17:47:13          | `recovery_point_create` → **`cenario-staging-20261113T174651Z`**                                                                                                                                                   | ✔ restauração de teste **IDÊNTICA**; cópia em `gs://cenariogestao-homolog-backups/backups/`                |
| 17:47:17          | `backup_validate`                                                                                                                                                                                                  | ✔ SHA-256                                                                                                  |
| 17:47:21          | `database_fingerprint` (A)                                                                                                                                                                                         | registrada                                                                                                  |
| 17:47:45          | `migrate 341badb…` (só registro + guarda do retorno)                                                                                                                                                               | ✔ "banco idêntico ao ponto de recuperação"; 0 pendentes; "Database schema is up to date!"                  |
| 17:47:49          | `database_fingerprint` (B)                                                                                                                                                                                         | mudanças **só** em `notifications` (avisos da Fase 4 encerrados pela guarda) e `audit_logs` (+1)            |
| 17:48:22          | `activate_version 341badb…`                                                                                                                                                                                        | ✔ R2 ativa: 19 checagens ✔. A guarda registrou: "nenhuma peça aprovada sem embalagem pendente de entrega" |
| 17:48:26–17:49:08 | Com a R2: `version`, `health` 6/6, `smoke_test` 18/18, `websocket_test`, `run_homologation_tests completo` 27/27, `resources`, impressão digital, logs                                                             | ✔ 0 respostas 5xx, 0 erros                                                                                 |
| 17:50:08          | `database_fingerprint` (C), com a R2 em uso por ~2 min e as rotinas periódicas rodando                                                                                                                             | **idêntica a B**                                                                                            |
| 17:50:31          | **`rollback_version 696e3e9…`** (só aplicação)                                                                                                                                                                     | ✔ 19 checagens ✔                                                                                          |
| 17:50:47–17:51:42 | Com `696e3e9`: `version`, `health` 6/6, `smoke_test` 18/18, `websocket_test`, `completo` 27/27, `migration_status` (37), `resources`, `images_cleanup_plan`, logs                                                  | ✔ 0 respostas 5xx, 0 erros                                                                                 |
| 17:56:14          | `database_fingerprint` (D), depois de um ciclo completo dos alertas (5 min)                                                                                                                                        | ver seção 5                                                                                                 |
| 17:56:17–17:56:30 | Logs, `health`, `resources`, `backup_list`                                                                                                                                                                         | ✔ 0 respostas 5xx; 20 backups (19 + o ponto novo; nenhum apagado)                                          |
| 17:56:34          | `gate_close`                                                                                                                                                                                                       | ✔ portão fechado                                                                                           |

**Indisponibilidade da aplicação:**

| Trecho               | Horário                            | Duração      |
| -------------------- | ---------------------------------- | ------------ |
| Retorno para a R2    | 17:46:49 → 17:48:22                | ≈ 1 min 33 s |
| Volta para `696e3e9` | troca de contêineres, até 17:50:31 | ≈ 20 s       |

## 3. Compatibilidade das 37 migrations

- O preflight do runner aprovou as **duas** versões contra o banco real da homologação: cadeia,
  esquema e dados.
- As duas imagens têm as mesmas 37 pastas de migration, idênticas byte a byte.

## 4. Fluxos verificados

**Nas duas versões, pela instância de homologação:**

- saúde dos 5 contêineres e `/api/ready`;
- proxy com senha (401 sem credencial);
- tela de entrada e JavaScript;
- certificado;
- rotas protegidas;
- WebSocket;
- backup recente;
- migrations;
- disco e memória;
- suíte completa: 27/27.

**Limitação.** Esta sessão não alcança a interface da homologação: o proxy de saída recusa o
domínio. Por isso, login e telas de negócio com a R2 **não** foram percorridos aqui. Eles estão
cobertos assim:

1. **Integridade dos dados.** As tabelas financeiras e operacionais ficaram idênticas, pelo hash do
   conteúdo, durante e depois do retorno (seção 5).
2. **Teste ponta a ponta anterior da R2**, com um banco representativo das Fases 2 a 4
   (`HOMOLOGACAO-INTEGRADA-PRONTIDAO.md` §2.3):
   - a guarda **bloqueia** quando há peça aprovada sem embalagem;
   - a guarda **libera** depois da entrega;
   - todas as rotas respondem 200;
   - dinheiro e tabelas ficam idênticos depois de 180 s de rotinas.

Se quiser, a navegação com a R2 pode entrar no R-3. Seria preciso repetir este ensaio com você
logado durante a janela.

**Não ensaiado aqui:** o caso "guarda bloqueia". A homologação não tem peças aprovadas sem
embalagem, e criar uma exigiria registros de negócio pela interface. Esse caso está coberto pelo
teste anterior citado.

## 5. Integridade dos dados

| Comparação                                           | Tabelas diferentes | Detalhe                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (antes do retorno) × B (depois do `migrate` da R2) | 2                  | `notifications`: mesma contagem (184), conteúdo mudou (avisos da Fase 4 encerrados); `audit_logs`: 300 → 301 (`system.rollback_prepared`)                                                                   |
| B × C (R2 em uso)                                    | **0**              | nada mudou com a R2 ativa                                                                                                                                                                                   |
| **Inicial × D (final, `696e3e9`)**                   | **2 de 126**       | `audit_logs`: +1, a auditoria do retorno; `domain_events`: 1071 → 1074, eventos internos dos alertas. **`notifications` voltou idêntica ao estado inicial** (os avisos foram reabertos pela própria rotina) |

Tabelas conferidas uma a uma entre o estado inicial e o final, todas **idênticas** em contagem e
hash:

| Grupo               | Tabelas (linhas)                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cadastro e operação | `customers` (2), `service_orders` (3), `service_order_items` (3)                                                                   |
| Compras             | `purchase_orders` (5), `material_receipts` (2)                                                                                     |
| Financeiro          | `financial_events` (10), `production_payables` (1), `service_order_costs` (4), `customer_receivables` (0), `customer_payments` (0) |
| Arquivos            | `stored_files` (1), `attachments` (1)                                                                                              |
| Estoque e entregas  | `inventory_items` (0), `inventory_adjustments` (0), `deliveries` (0)                                                               |
| Avisos              | `notifications` (184)                                                                                                              |

**Conclusão: nenhuma perda e nenhuma alteração de dado de negócio.**

## 6. Constatações para o plano da produção

1. **O caminho de retorno funciona e é curto.** A sequência é:
   1. `prepare_version R2` (antes da janela);
   2. `maintenance_on`;
   3. `recovery_point_create`;
   4. `migrate R2`, que só registra a versão e roda a guarda;
   5. `activate_version R2`.

   A volta é `rollback_version 696e3e9`. Com dados preservados, isso dá cerca de 1,5 min fora do
   ar na ida e 20 s na volta.

2. **Estado "migrada" e "candidata" depois da volta.**
   - Depois do `rollback_version`, o runner continua registrando `candidata` e `migrada` = `341badb`,
     enquanto a versão ativa é `696e3e9`. Isso é coerente com o desenho: o `rollback_version` só
     troca a aplicação.
   - Não afeta a operação. O próximo deploy roda `prepare_version` e `migrate`, que atualizam os dois
     registros.
   - Na produção, isso só aconteceria se o retorno fosse usado e desfeito.
3. **Proteção das imagens da F′ na homologação.**
   - O ponto de recuperação novo é da versão `696e3e9`. Com isso, as imagens da F′ `63674f1`
     deixaram de ser "versão do ponto de recuperação" e aparecem como removíveis no **plano** de
     limpeza.
   - **Nada foi removido**: a limpeza não foi executada e as imagens continuam no disco da VM. As
     etiquetas no Artifact Registry são imutáveis, então a F′ pode ser baixada de novo a qualquer
     momento.
   - Para manter a F′ como retorno, **não execute `images_cleanup`** na homologação sem rever esse
     plano. As protegidas hoje são `696e3e9` (ativa) e `341badb` (candidata).
4. **Avisos da Fase 4.** A R2 encerra os avisos abertos, com auditoria. Ao voltar para `696e3e9`, a
   rotina de 5 min os reabre. Na homologação o resultado foi idêntico ao inicial.

## 7. Estado final da homologação

| Item               | Situação                                                           |
| ------------------ | ------------------------------------------------------------------ |
| Versão ativa       | `696e3e9`                                                          |
| Contêineres        | saudáveis                                                          |
| Migrations         | 37                                                                 |
| Portão             | **fechado**                                                        |
| Erros              | 0 respostas 5xx e 0 erros no log da API                            |
| Memória disponível | 1086 MB                                                            |
| Disco              | 7,5 GiB livres                                                     |
| Backups            | 20, nenhum apagado. Novo ponto: `cenario-staging-20261113T174651Z` |
| Imagens na VM      | 696e3e9, R2, F′ e as anteriores, todas presentes (nada removido)   |
