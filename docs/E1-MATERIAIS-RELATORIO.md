# Etapa E1 — material não bloqueia a produção · Relatório

Base: `696e3e9` (versão hoje em produção). Escopo autorizado: **somente a E1**. Nada foi implantado.

## 1. Branch e commits

Branch `claude/reformulacao-e1-materiais` (separada; sem PR, sem merge):

| Commit | Conteúdo |
|---|---|
| `9b45868` | E1: produção sem trava de materiais por padrão (regra, API, Resumo da OS, testes) |
| `41183cb` | E1: aviso de material no cartão do tablet; specs que exercitam o controle formal ligam a trava explicitamente; evidências |
| (este) | Relatório |

## 2. Arquivos modificados

Aplicação (8 arquivos, +97/−19), **sem migration, sem mudança de esquema**:

- `packages/shared/src/modules.ts` — `materiais.defaultEnabled: false`.
- `packages/shared/src/types-commercial.ts` — estado `INFORMATIVO`; prontidão traz `materialsGate` e `simpleMaterialsPending`.
- `packages/shared/src/types-production.ts` — `osMaterialsMissing?` (opcional) na tarefa do tablet.
- `apps/api/src/modules/production/common.ts` — ciclo periódico (`releaseDueTasks`) reavalia tarefas gravadas como bloqueadas por `MATERIAIS` quando a trava está desligada.
- `apps/api/src/modules/service-orders/routes.ts` — Resumo da OS: materiais e medições viram `INFORMATIVO` com a trava desligada.
- `apps/api/src/modules/production/tasks.ts` — `/production-tasks/mine` marca `osMaterialsMissing` (uma consulta só).
- `apps/web/components/tablet/tasks.tsx` — cartão mostra "Falta material" (aviso) em vez de "Materiais disponíveis" falso.
- `apps/web/components/commercial/service-order-detail.tsx` — rótulo "Não impede o início" e texto do rodapé.

Testes (25 arquivos): novo `apps/api/test/e1-materiais-sem-trava.test.ts`, novo `tests/e2e/specs/zz-e1-materiais-sem-trava.spec.ts`, helper `resetDatabaseWithMaterialsGate()` / `setMaterialsGate()`, e os testes antigos do controle formal passaram a **ligar a trava explicitamente** (nenhuma asserção foi afrouxada). Evidências: `docs/evidencias/e1-materiais/00…03.png`.

## 3. Regras antigas removidas ou alteradas

| Regra | Antes | Agora |
|---|---|---|
| Padrão do interruptor "Travas de materiais" | Ligado | **Desligado** (empresa nova e empresa sem configuração gravada) |
| Etapa com "exige materiais" sem prontidão formal | Bloqueio `MATERIAIS` | Liberada (o bloqueio só existe se a trava for ligada) |
| Resumo da OS — Materiais / Medições | "Pendente" (impedimento) | "Não impede o início" + aviso de itens que não estão na oficina |
| Tarefas já gravadas como bloqueadas por `MATERIAIS` | Ficavam bloqueadas | O ciclo periódico (30 s) as reavalia e libera, se nada mais as prende |

Não removido: o controle formal inteiro (solicitação, aprovação, compra, recebimento, reserva, medição) continua existindo e volta a bloquear se o gestor ligar a trava. Os modelos padrão continuam marcando etapas como "exige materiais" — com a trava desligada isso **não** gera bloqueio indireto (verificado no teste A e no E2E: `requiresMaterials: true` e `LIBERADA`).

## 4. Comportamento anterior × novo

- **Antes:** OS sem levantamento, sem compra ou com tecido não recebido → Corte, Costura, Montagem e Revestimento ficavam "Aguardando materiais"; o funcionário não conseguia iniciar; o Resumo da OS mostrava "Materiais: Pendente".
- **Agora (padrão):** essas etapas são liberadas pela programação, pelo responsável e pelas dependências; o tablet inicia com um toque; a falta de material aparece só como aviso ("Falta material" no cartão, aviso no Resumo da OS). A API realmente libera o início (não é só a mensagem escondida).

## 5. Evidências dos oito cenários

| Cenário | Teste automatizado | Pela tela |
|---|---|---|
| A — OS sem materiais: iniciar/pausar/retomar/concluir | API `A — OS sem materiais…` | E2E: iniciar, pausar, retomar, concluir (`03-tablet-em-execucao.png`) |
| B — tecido não comprado | API `B — tecido cadastrado na OS e NÃO comprado…` | E2E (tecido `purchased:false`) |
| C — material indisponível, aviso mantido | API `C — material indisponível…` (OS e `/mine`) | `01-os-resumo-prontidao.png`, `02-tablet-cartao-liberado-com-aviso.png` |
| D — sem compra formal | API `D — sem pedido de compra, fornecedor…` | E2E: prontidão formal ≠ `COMPLETO` e a etapa concluída |
| E — sem medição | API `E — sem medição formal…` | E2E: "Medições · Não impede o início" |
| F — segurança | API `F — segurança: dependências, responsável, plano não publicado, tarefa concluída e execução simultânea continuam valendo` | — |
| G — padrão de empresa nova | API `G — empresa nova…` | `00-empresa-funcionalidades-padrao.png` (interruptor desligado) |
| H — compatibilidade | API: 3 testes `H — …` (históricos íntegros; ligar a trava restaura o bloqueio; tarefas antigas liberadas pelo ciclo) | specs antigas do controle formal passam com a trava ligada |

## 6. Testes executados e resultados (rodada final completa)

| Suíte | Resultado |
|---|---|
| API (vitest) | **1026 passaram**, 1 falhou, 13 ignorados |
| shared | 151/151 |
| web | 26/26 |
| E2E Playwright (build de produção do web) | **80/80** (27,5 min) |
| typecheck / lint / prettier | OK |

A única falha da API é `rodada4-travas-estruturais › F10-01`, **pré-existente na 696e3e9** (falha igual na linha de base antes da E1; corrigida em `29dc333`, fora desta versão). Não tem relação com materiais.

## 7. Riscos e possíveis regressões

1. **Homologação com configuração gravada:** se a homologação tiver uma linha `module_settings` com `materiais=true`, a trava continua ligada lá (vale o que foi gravado). Precisa ser conferido na implantação — eu não consultei a homologação.
2. **Rollback para código antigo** religa a trava silenciosamente (o padrão antigo era ligado) e as tarefas voltam a ser avaliadas com bloqueio.
3. **Tarefas antigas bloqueadas** são liberadas em até ~30 s pelo ciclo periódico, não instantaneamente. Produção está com banco vazio; afeta só ambientes com dados.
4. O rótulo vermelho "Falta material" no tablet é **apenas aviso**; pode ser lido como impedimento — vale observar na validação funcional.
5. `central-volume` (teste de volume/tempo) falhou uma vez numa rodada intermediária e passou isolado duas vezes e na rodada final: intermitente, não ligado à E1.
6. O risco de prazo "MATERIAIS" na Central continua existindo, mas é informativo e só aparece para compras formais já em andamento.

## 8. Produção e homologação

Confirmo: **nenhum acesso** à produção ou à homologação nesta etapa — sem deploy, sem migration, sem alteração de banco, sem dados sintéticos, sem merge. Todo o trabalho foi feito em bancos PostgreSQL locais do contêiner (`cenario_test`, `cenario_e2e_test`).

## 9. Veredito para homologação

**GO técnico** para implantar a branch `claude/reformulacao-e1-materiais` em homologação, com uma condição: na implantação, conferir se há `module_settings.materiais` gravado (risco 1).

A E1 **não está concluída**: falta a validação funcional na homologação (OS real sem material iniciando no tablet). Aguardo sua autorização para implantar em homologação. A E2 não foi iniciada.
