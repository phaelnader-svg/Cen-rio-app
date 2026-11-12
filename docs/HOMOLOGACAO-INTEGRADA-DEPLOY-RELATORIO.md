# Homologação integrada (F0–F4) — relatório do deploy

Autorização formal recebida em 12/11/2026. Executado **somente em homologação** (VM
`cenario-homolog`, projeto `cenariogestao`, zona `us-east1-b`), pelo roteiro auditado em
`HOMOLOGACAO-INTEGRADA-AUDITORIA-FINAL.md`. Produção, branches de produção, permissões e usuários
reais não foram tocados; nenhuma limpeza de imagens, volumes ou backups; nenhuma migration além das
duas auditadas.

## 1. Versões implantadas

| Papel                      | Commit                                     | `api` (digest)                                                            | `web` (digest)                                                            |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Ativa — F′**             | `63674f1d116ed86a92dbcc421f2fd702e41b169d` | `sha256:940f77087545784a0e0f2adcfd69026ddbc157e7b46095cf565ce95329342e5b` | `sha256:b9b0d32af8e2717fbcbe0865f3abdd920f94d57b2fee020a2fe5033b34d7ebe0` |
| **Retorno preparado — R2** | `341badb59624996cd95c1213808c51631bf34b92` | `sha256:b272404e79719dd1b7151502a9681c75be85614362252d688beab59d1c659df7` | `sha256:8559184d2e2d5b1a07a8b19782a02cd4836136e306032cca5e3d07099d27f5f8` |

Os digests foram conferidos três vezes, idênticos aos auditados: no Artifact Registry (passo 0),
na VM ao baixar F′ (passo 2) e na VM ao baixar R2 (passo 12).

## 2. Horários (UTC)

| Marco                                          | Hora                         |
| ---------------------------------------------- | ---------------------------- |
| Início (passo 0)                               | 17:34:55                     |
| Portão aberto / preparo de F′ (sem parar nada) | 17:36:05 / 17:36:08–17:37:38 |
| **Manutenção (API e web paradas)**             | **17:37:38**                 |
| Ponto de recuperação                           | 17:37:45–17:38:11            |
| Migrations                                     | 17:38:56–17:39:07 (11 s)     |
| **Ativação de F′ concluída (saúde OK)**        | **17:40:16**                 |
| Testes, preparo de R2, portão fechado          | 17:40–17:45:34               |
| Verificação pós-rotinas                        | 17:46:12                     |

**Indisponibilidade observada: ~2 min 38 s** (17:37:38 → 17:40:16).

## 3. Backup e ponto de recuperação

- **Ponto de recuperação `cenario-staging-20261112T173748Z`**, versão `3e0d2d0`, impressão
  `0687aa4cf44e46f9002890e1cb997f41` (4.318 itens), criado com a aplicação parada: backup do banco
  - arquivos, SHA256SUMS ✔, restauração de teste em banco separado **IDÊNTICA** ao banco (conteúdo,
    vínculos, catálogo e valores financeiros), cópia no bucket `gs://cenariogestao-homolog-backups`
    (junto com os backups de 11/11 e 12/11). `backup_validate` do ponto: ✔.
- Arquivos restaurados no teste: 0 — coerente com a auditoria (o único registro de arquivo é um anexo
  excluído pelo usuário, sem arquivo por desenho).
- Snapshot do disco anterior à ampliação continua disponível: `cenario-homolog-antes-30gb-202611121709`.

## 4. Migrations executadas

Pré-verificação (passo 6): pendentes **exatamente** `20270316000000_reformulacao_fase_2` (17
comandos) e `20270323000000_reformulacao_fase_3` (8 comandos); nada incompleto, desconhecido,
divergente ou fora de ordem; banco idêntico ao ponto antes de aplicar. Aplicadas em 11 s pela
própria imagem F′ (log na VM: `/var/lib/cenario/migracao-63674f1…-20261112T173856Z.log`).
`migration_verify` F′: 37 aplicadas, nenhuma pendente. `migration_verify` R2: nenhuma pendente
(R2 compatível com o esquema atual).

## 5. Contêineres e endpoints

- postgres, api, web **healthy**; caddy e backup em execução; `/api/ready` 200 pelo proxy.
- Acesso pelo proxy: 401 sem credencial, senha do proxy aceita, `/entrar` 200, JavaScript 200,
  certificado válido até 07/01/2027, sem HTTP/3.
- WebSocket `/api/realtime`: 401 sem sessão (esperado).
- Logs da API desde a ativação até 17:46: **0 respostas 5xx, 0 erros, 0 avisos**; "API Cenário
  Gestão pronta" em `staging`. Web: nenhum erro.
- Recursos: disco 30 GB, 19 GB usados, **9,8 GB livres**; memória disponível ~1 GB; API 121/512 MB,
  web 163/448 MB, postgres 90/448 MB.

## 6. Testes automatizados e smoke tests

| Teste                                                                | Resultado                         |
| -------------------------------------------------------------------- | --------------------------------- |
| `smoke_test` (vm.sh saude)                                           | **18 ✔, 0 ✘**                    |
| `run_homologation_tests suite=completo` (saúde + acesso + websocket) | **27 ✔, 0 ✘**                    |
| `websocket_test`                                                     | ✔                                |
| Regressão anterior de F′ (ambiente isolado)                          | API 1013 ✔ (0 falhas), E2E 68/68 |

## 7. Integridade dos dados e arquivos

Impressão por tabela (contagem + md5 de todas as colunas), antes (passo 0) e depois (passo 8):

- 125 tabelas antes → 126 depois: única nova `service_model_materials` (vazia, Fase 2).
- Diferenças em tabelas existentes **somente**: `_prisma_migrations` 35 → 37; `stored_files` 1 → 1
  (mesmo registro; o md5 mudou porque a Fase 2 acrescentou colunas vazias à linha).
- **Todas as demais 123 tabelas idênticas**, inclusive todas as financeiras (cobranças,
  recebimentos, mão de obra, pagamentos, fechamentos, contas, despesas, custos) e entregas.
- Após 6 min com as rotinas de F′ ligadas (alertas, manutenção, presença): só `notifications`
  176 → 179 e `domain_events` 1044 → 1047 (avisos internos; nada externo); **25 tabelas
  financeiras, de arquivos e operacionais-chave idênticas**.
- Arquivos: inalterados (1 registro, excluído pelo usuário antes deste trabalho).

## 8. Estado do retorno

- **R2 preparada na VM** (candidata, protegida contra limpeza), digests auditados, 37 migrations
  iguais às do banco, `migration_verify` ✔.
- Ponto de recuperação `cenario-staging-20261112T173748Z` (versão `3e0d2d0`) registrado e
  verificado.
- Prontidão de retorno: `quality_inspections = 0` → nenhuma peça aprovada sem embalagem → retorno a
  R2 **liberado** pela regra da guarda (confirmação visual: `/api/v1/system/rollback-readiness`
  com o gestor).
- Procedimento (seção 5 da auditoria): sem uso real, `rollback_to_recovery_point`; com uso real,
  R2 pela guarda (sem perda de dados).
- Plano de limpeza (somente leitura) lista `a7f4f93` e `de31aa7` como removíveis — **não
  executado** (não autorizado); 9,8 GB livres bastam.

## 9. Pendências e testes manuais

1. Roteiro manual completo (`HOMOLOGACAO-INTEGRADA-ROTEIRO-MANUAL.md`) com dados `HML-`:
   computador, celular, **Safari** e **tablet físico**.
2. Passo 15: medir memória/CPU da API (`resources`) durante o envio de fotos (critério > 90%).
3. Passo 17: depois de anexar fotos de teste, `backup_create` → `backup_restore_test` com
   "arquivos restaurados" > 0 (exige autorização para criar o backup extra e os bancos temporários
   da restauração de teste).
4. Confirmar a prontidão de retorno pela tela do gestor.
5. Ressalvas mantidas: fotos antigas com GPS (migração não executada), CPU na VM, correção
   opcional do 500 ao ler arquivo ausente (não afeta o registro atual, que está excluído).

## 10. Veredito

**GO COM RESSALVAS.** O deploy integrado F′ foi concluído em homologação sem nenhum critério de
interrupção acionado: versões e digests auditados, ponto de recuperação idêntico e copiado,
somente as duas migrations previstas, contêineres saudáveis, 45 verificações automáticas ✔, zero
erros e zero 5xx, dados financeiros e arquivos intactos, e retorno R2 pronto e compatível.
Ressalvas: testes manuais (incluindo Safari e tablet físico) e a prova de foto real no backup
(passo 17) ainda pendentes.
