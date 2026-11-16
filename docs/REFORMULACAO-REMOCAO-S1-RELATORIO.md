# Reformulação por remoção real — Etapa S1 (embalagem)

Base: `claude/reformulacao-s0` em `882fd93`. Branch: `claude/reformulacao-s1`. Sem migration, sem
deploy, sem alteração de dados reais. Testes só em bancos locais descartáveis.

## 1. O que foi removido

| Item                  | Antes                                                                                                                         | Depois                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Etapa obrigatória     | Aprovada na qualidade, a peça ia para "Aguardando embalagem" → "Em embalagem" → "Pronta"                                      | Aprovada, a peça fica **"Pronta para entrega"** direto                                                                |
| Condição de prontidão | `READINESS_CHECKS` com `EMBALAGEM` (5 condições)                                                                              | 4 condições: tarefas, inspeção, correções e sem bloqueio de expedição                                                 |
| Registro e tarefa     | A aprovação criava `packaging_records` e uma tarefa `EMBALAGEM` (distribuída a João/Thiago)                                   | Nenhum registro nem tarefa de embalagem nasce; `packaging_required` é gravado como falso                              |
| Interruptor           | `embalagem` em Empresa → Funcionalidades                                                                                      | Não existe (`MODULE_KEYS` sem a chave; `PUT /api/company/modules/embalagem` → 404); a linha antiga gravada é ignorada |
| Rotas                 | `GET /api/v1/packaging`, `GET /:id`, `POST /:id/assign`, `POST /:id/complete`, `GET /api/v1/system/rollback-readiness`        | **404** (código apagado: `quality/packaging.ts`, `management/rollback-readiness.ts`)                                  |
| Validações de backend | "Conclua a embalagem pela tela de embalagem"; a aprovação invalidada invalidava a embalagem; a devolução cancelava embalagens | Removidas (o código não escreve mais em `packaging_records`)                                                          |
| Central de atenção    | "Embalagem sem responsável"                                                                                                   | Removido                                                                                                              |
| Painel                | "N na embalagem" no cartão da qualidade                                                                                       | Removido (etapas antigas contam como "prontas")                                                                       |
| Estado operacional    | Estado visível "Embalagem"                                                                                                    | Removido; etapa antiga gravada é lida como "Pronta para entrega"                                                      |
| Tablet                | `PackagingPanel` (proteção, local, concluir), aviso "Embalagem liberada", "Embalagem dispensada"                              | Removidos                                                                                                             |
| Tela Qualidade        | Aba "Embalagens", diálogo "Designar quem embala", título "Qualidade e embalagem"                                              | Removidos; título "Qualidade"                                                                                         |
| OS                    | Código `EB-…` na lista de peças; seção "Peças na qualidade, embalagem e entrega"                                              | Removidos                                                                                                             |
| Fotos                 | Envio de fotos na embalagem                                                                                                   | Só consulta das antigas (ninguém envia nem remove)                                                                    |
| Textos                | Permissão "Gerenciar qualidade e embalagem", área "Qualidade e embalagem", descrição da expedição, página inicial             | Sem embalagem                                                                                                         |

**Permissões:** não havia permissão exclusiva de embalagem. As rotas usavam `producao.executar` e
`qualidade.gerenciar`, que são compartilhadas com a produção e a qualidade. Só o rótulo e a
descrição de `qualidade.gerenciar` mudaram.

**Modelos padrão:** os modelos de serviço nunca puderam ter etapa de embalagem
(`PLANNABLE_ACTIVITIES` não a inclui, e a tarefa avulsa `EMBALAGEM` dá 400). Com a S1, a
aprovação também deixa de criá-la. Os testes F5-04 e F5-10 confirmam: o modelo inteiro roda sem
nenhuma tarefa extra.

**Mantido de propósito (compartilhado ou histórico):**

- Os valores `AGUARDANDO_EMBALAGEM`, `EM_EMBALAGEM` e a atividade `EMBALAGEM` continuam nos enums
  do banco e do domínio, com rótulos, só para ler o histórico. Remover exigiria migration.
- As tabelas `packaging_records`, a coluna `packaging_required`, os eventos `packaging.*`, as
  notificações `EMBALAGEM_LIBERADA` antigas e os eventos de qualidade da embalagem (linha do tempo)
  ficam intactos.
- A localização "Embalagem" do mapa da oficina (D7) é um lugar físico, que o gestor pode renomear
  ou desativar. Não é processo.
- A unidade de material "embalagens" (pacote) não tem relação com o processo.

## 2. Compatibilidade com OS antigas

- **Peça antiga gravada em etapa de embalagem:** a leitura da peça (`/api/v1/pieces`) mostra a etapa
  calculada agora ("Pronta para entrega"), sem gravar nada. O estado operacional e o painel a contam
  como pronta. A etapa gravada muda no próximo evento operacional da peça, como a entrega; a rotina
  da S9 também pode recalculá-la.
- **Tarefa `EMBALAGEM` antiga em aberto:** conclui como qualquer tarefa no tablet, sem tela de
  embalagem. Encerrá-la não dispara nada, e o registro antigo não é tocado.
- **Registro de embalagem antigo pendente:** não bloqueia a entrega nem aparece na Central. Fica
  como está, e a S9 decide se muda de situação.
- **Linha `embalagem` em `module_settings`:** ignorada como chave desconhecida, e não é apagada.

## 3. Evidências de que a embalagem não é exigida

`apps/api/test/remocao-s1-embalagem.test.ts`:

1. Produção → qualidade → aprovação → "Pronta para entrega" → entrega da OS. Nenhum registro,
   tarefa ou aviso de embalagem nasce. A mão de obra "na aprovação" é liberada na aprovação, a "na
   entrega" só na entrega, e a cobrança "na entrega" só vence na entrega. A OS com peça ainda não
   aprovada continua bloqueada.
2. Sem interruptor, sem condição de prontidão e com as 5 rotas respondendo 404. As fotos de
   embalagem ficam só para consulta.
3. Histórico antigo simulado (interruptor gravado, tarefa e registro pendentes, peça "aguardando
   embalagem"):
   - a OS abre, e a peça aparece pronta sem que a leitura grave nada;
   - a tarefa antiga conclui normalmente;
   - a OS é entregue, e o registro antigo fica idêntico.

Também convertidos ao comportamento novo: `quality.test.ts` (6, 9, 10, 11, 13, 21, 23, 24),
`qualidade-entrega`, `rodada2-resolucao`, `rodada3-central` (F10-13g), `rodada4-modelos-negociacao`
(F5-04 e F5-10), `full-flow`, `logistics-costs`, `fase0-modulos-ajuda`, `fase1`, `e1` e `fase3`.
Os testes E2E `team-quality`, `zz-fluxo-transversal`, `zz-fase3` e `fase0-funcionalidades` agora
verificam que não há tarefa "Embalar" nem interruptor. Removidos: `retorno-prontidao.test.ts`
(testava a rota removida) e o teste "embalagem pelo gestor".

**Trava estrutural (F1-07b/F1-12b):** as 4 rotas de embalagem de 9fb1786 deixam de ser exigidas
**só** porque a S1 está registrada em `tests/remocao/etapas-concluidas.json`. Qualquer outra rota
que sumir continua quebrando a trava, que também confere que as removidas não voltaram.

## 3.1 Resultado dos testes

| Verificação                                                          | Resultado                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                                    | 22 arquivos, 151 aprovados                                                                                                |
| `apps/web`                                                           | 6 arquivos, 44 aprovados, 18 falhas esperadas (Grupo B das etapas S2–S7)                                                  |
| `apps/api` (suíte completa, 2108 s)                                  | 93 arquivos aprovados (7 pulados, opcionais), 1059 aprovados, 17 falhas esperadas (S2–S7), 13 pulados                     |
| Grupo A (API e web)                                                  | todos aprovados                                                                                                           |
| Grupo B S1 (API: rotas, interruptor, READINESS_CHECKS; web: trechos) | **obrigatório e aprovado** (`etapas-concluidas.json` = `["S1"]`)                                                          |
| Grupo B S2–S7                                                        | continuam `it.fails` (pendentes), sem nenhum passando antes da hora                                                       |
| E2E (Playwright, web compilada da S1)                                | `fase0-funcionalidades`, `team-quality`, `zz-fase3-qualidade-programacao` (3) e `zz-fluxo-transversal`: **6/6 aprovados** |
| `pnpm lint` / `pnpm typecheck`                                       | ok                                                                                                                        |
| `pnpm format:check`                                                  | só o aviso antigo em `docs/E1-MATERIAIS-RELATORIO.md` (vem da E1, não tocado)                                             |

## 4. Integridade histórica

Teste feito com o código **antigo** (882fd93) gravando um banco descartável e o código **novo**
lendo e operando esse mesmo banco. No banco havia:

- uma peça embalada (registro concluído);
- uma peça aguardando embalagem (registro pendente e tarefa `EMBALAGEM` aberta);
- a linha `embalagem` em `module_settings`.

| Fase                                                                                                                             | Resultado                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leitura com o código novo (OS, linha do tempo com 8 menções à embalagem, peças, inspeções, financeiro, cobranças, elegibilidade) | `HISTÓRICO PRESERVADO` (0 violações; só sessão e auditoria do login)                                                                                                                                                                                                      |
| `/api/v1/packaging`                                                                                                              | 404; interruptores listados: logística, ajuda e materiais                                                                                                                                                                                                                 |
| Operação: entrega direta da OS antiga                                                                                            | 200, 2 peças entregues; peça antes "aguardando embalagem" → entregue                                                                                                                                                                                                      |
| Depois da operação                                                                                                               | Registros de embalagem (1 concluído, 1 pendente), tarefas `EMBALAGEM` e linha do interruptor **inalterados**; nenhuma soma em dinheiro mudou. O comparador aponta só a mudança esperada de etapa das 2 peças (saída de "aguardando embalagem" e "pronta" para "entregue") |

## 5. Riscos e regressões

1. **Etapa gravada antiga:** na homologação, peças antigas ainda gravadas em etapa de embalagem
   ficam fora das listas que filtram pela etapa gravada, como a Central ("pronta sem entrega") e o
   painel Hoje, até o próximo evento da peça. A entrega direta pela OS funciona. Como tratar: rotina
   da S9, que já está no diagnóstico da S0.
2. **Tarefas e registros antigos abertos** continuam no banco. A tarefa pode ser concluída no tablet,
   e a limpeza fica para a S9.
3. **Retorno de versão (H9):** voltar para uma versão anterior à S1 religa a embalagem. Peças
   aprovadas com `packaging_required = false` ficariam sem embalagem nela, o mesmo risco já
   documentado na Fase 3. A rota que mostrava isso (`rollback-readiness`) foi removida nesta etapa,
   conforme o catálogo aprovado na S0.
4. **Ferramenta antiga de ensaio de retorno** (`apps/api/test/retorno-integrado.check.ts`, fora da
   suíte padrão) ainda lê o interruptor `embalagem`. É de um ensaio passado e não foi alterada.
5. **Instabilidade conhecida:** `integrated-evolution` cenário 7 (tempo real) falha de forma
   intermitente em execuções longas, na base e no código novo. Isolado, falha igual nos dois. O
   arquivo inteiro passa nos dois (9/9). Não tem relação com a S1.

## 6. Confirmações

- Nenhum ambiente real (homologação ou produção) foi acessado ou alterado.
- Sem migration, sem alteração de dados históricos, sem merge e sem PR.
- Logística, estoque simples, compras e fornecedores, nascimento da OS e pedidos de ajuda
  **não foram alterados**. Os testes do Grupo B dessas etapas continuam pendentes (`it.fails`).
