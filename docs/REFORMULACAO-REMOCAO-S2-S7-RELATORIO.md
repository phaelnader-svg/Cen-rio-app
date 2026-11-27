# Reformulação por remoção real — Etapas S2, S3, S4, S5 e S7

Pedido do dono (2026-11-16): excluir **Recebimentos, Medições, Pedidos de ajuda, Compras e
Recebimento de materiais**, com tudo o que pertence a eles. Plano aprovado com a opção
"Aprovar; Retiradas ficam":

- a etapa **S6 não foi feita**: Retiradas, Roteiro do dia e Expedição continuam;
- os **dados ficam no banco**, sem telas (nada é apagado, sem migration);
- saem também Fornecedores, Estoque formal, Prontidão de materiais, Materiais aprovados e o
  Planejamento de sexta;
- ficam o **Estoque da oficina** (D2), a **lista simples de materiais da OS** e as **medidas das
  peças na OS** (D8);
- **D1:** a OS nasce no **fechamento do serviço** ("Novo serviço"); a chegada das peças vira uma
  marca opcional.

Branch: `claude/project-thread-dr7pqa` (base `5873917`, com merge da linha de produção em `7898dab`, de Orçamentos em `b4d08d4` e da landing de produção `180d120` via `a91fc42`). Sem migration, sem deploy, sem PR e sem
alteração de dados reais. Testes só em bancos locais descartáveis.
`tests/remocao/etapas-concluidas.json` = `["S1","S2","S3","S4","S5","S7"]`.

## 1. O que foi removido

| Etapa | Área                                   | Removido                                                                                                                                                                                                                                                                           |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2    | Prontidão e bloqueios por material     | Rotas `material-readiness`, materiais formais da OS e da tarefa; o bloqueio `MATERIAIS` na liberação das tarefas; o interruptor "materiais"; a tela **Prontidão de materiais**                                                                                                     |
| S3    | Medições, solicitações e previsões     | Módulos `measurements` e `materials` (consolidado, CSV, planejamento), previsões e necessidades de material; telas **Medições**, **Materiais aprovados** e **Planejamento de sexta**; o fluxo de medição no tablet                                                                 |
| S4    | Compras, fornecedores e estoque formal | Módulos `purchasing` e `arrivals` (pedidos de compra, fornecedores, faltas, recebimento de materiais, chegadas físicas, itens de estoque, movimentos, reservas, sobras); telas **Compras**, **Fornecedores**, **Recebimento de materiais** e **Estoque**; a área "Compras" do menu |
| S5    | Recebimentos (D1)                      | Módulo `receipts` (registro, pendentes, correções, confirmação de chegada da retirada); telas **Recebimentos** e **Novo recebimento**; a central "Aguardando chegada" do tablet                                                                                                    |
| S7    | Pedidos de ajuda (D3)                  | Rotas `help-requests` (pedir, atribuir, cancelar, fila, apoio prolongado); tela **Pedidos de ajuda**; o botão de ajuda no tablet; o interruptor "ajuda"; os avisos `AJUDA_*` deixam de aparecer                                                                                    |

São 81 rotas de 9fb1786 a menos (a trava estrutural F1-12b lista cada uma, por etapa) e 14 telas
do painel. **Permissões retiradas do catálogo:** `medicoes.gerenciar`, `medicoes.extraordinarias`,
`materiais.ver`, `materiais.aprovar`, `compras.ver`, `compras.gerenciar`, `compras.aprovar`,
`estoque.conferir`, `estoque.autorizar`, `recebimentos.registrar` e `ajuda.solicitar`. Linhas
antigas dessas permissões em `role_permissions` ficam no banco e são ignoradas
(`resolvePermissions` só aceita permissões do catálogo; a tela de funções as filtra).

No pacote compartilhado, `measurements-domain` e `purchasing-domain` deram lugar a
`materials-domain` (só unidades, `formatCents`, `q3` e os códigos antigos `MD-…`/`CP-…`, que
continuam legíveis no histórico); os esquemas e tipos de medições e compras saíram.

## 2. O que muda no uso

- **OS no fechamento (D1).** Ao fechar o "Novo serviço", a OS nasce com todas as peças, sem esperar
  a chegada. A tela de conclusão mostra a OS criada, com link para abri-la.
- **Chegada das peças é opcional.** Com retirada, "Recebida na oficina" passa a ser a última
  transição da própria retirada (depois de "Realizada" ou de uma ocorrência) e marca as peças
  como recebidas. Sem retirada, o pedido ganhou a ação **"Peças na oficina"**
  (`POST /api/v1/orders/:id/arrived`, com versão, idempotente e auditada como
  `order.pieces_arrived`), que marca o restante de uma vez. Nenhuma das duas cria outra OS.
- **Produção não espera a chegada nem o material.** A fila "A planejar" mostra a OS logo depois do
  fechamento, e nenhuma tarefa fica bloqueada por material. O motivo de risco "Materiais pendentes"
  do prazo passa a vir da lista simples da OS (item ainda não disponível).
- **Prazo do pedido.** "Peças ainda não recebidas" continua aparecendo na Central enquanto a
  chegada não é marcada.
- **Cancelar o pedido** cancela também as OS abertas dele (antes não havia OS antes da chegada).
- **Ocorrências de material** no tablet registram só descrição, quantidade e unidade (sem vínculo
  com necessidade ou item de estoque formal).
- **Menu:** Início, Serviços, Produção, Financeiro e Administração. "Estoque da oficina" foi para
  Produção.
- **Landing page:** os textos que citavam medição, compras e recebimento foram trocados por "ficha
  da peça", "lista de materiais" e "estoque simples".

**Mantido de propósito:** a conciliação da lista simples com o custo formal (também vale para
lançamentos do financeiro); Reprogramação e Competências (antes junto da ajuda, agora em
`components/production/reschedule-pages.tsx`); transferência e alternativas no tablet
(`components/tablet/task-support.tsx`); "Minhas viagens" no tablet (`components/tablet/my-trips.tsx`).
Tabelas, enums, eventos e avisos antigos continuam no banco só para leitura do histórico.

## 3. Testes

Os testes que provavam os módulos removidos saíram (16 arquivos da API, um helper e os casos isolados em
outros arquivos). Os que dependiam deles foram convertidos à regra nova, entre eles:

- `novo-servico` (seção C reescrita: OS no fechamento, marca opcional pela retirada e por "Peças na
  oficina", repetição idempotente);
- `prazos`, `saneamento`, `pre-planejamento`, `cobranca`, `logistics-costs`, `quality` (20),
  `fase1-materiais-estoque-entrega`, `rodada4-transacao-auditoria`, `presenca-apoio`;
- `rodada4-travas-estruturais`: rotas, telas e permissões removidas são aceitas **só** pela etapa
  registrada como concluída, e a trava confere que não voltaram; as rotas que ficam continuam com
  a mesma regra de acesso (sem as permissões removidas);
- web: `rodada4-menu` (menu sem a área Compras) e `remocao-grupo-b`;
- pacote compartilhado: `commercial`, `deadline`, `modules`, `production`, `rodada3` e o novo
  `materials`.

### 3.1 Resultado dos testes (bancos locais descartáveis)

| Verificação                                           | Resultado                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                     | 21 arquivos, 130 aprovados                                                                                                                                                                                                                            |
| `apps/web`                                            | 5 arquivos, 54 aprovados, 3 falhas esperadas (Grupo B das etapas S6 e S8, ainda não feitas)                                                                                                                                                           |
| `apps/api` (suíte completa, versão combinada 4dda3a4) | 79 arquivos aprovados (7 pulados, opcionais), 799 testes aprovados, 3 falhas esperadas (Grupo B de S6 e S8), 13 pulados. O merge seguinte (landing `a91fc42`) só mexe na web e na infraestrutura: web 57 aprovados e 3 falhas esperadas, typecheck ok |
| Grupo B S2, S3, S4, S5 e S7                           | **obrigatórios e aprovados** (`etapas-concluidas.json`)                                                                                                                                                                                               |
| Typecheck (api, web, shared) e lint                   | ok                                                                                                                                                                                                                                                    |

## 4. Riscos e pendências

1. **Homologação não foi feita.** Ela precisa do ambiente "Cenário — Homologação" e da contagem
   da S9 (registros antigos abertos: compras, medições, recebimentos, pedidos de ajuda).
2. **Pedidos antigos sem OS** (fechados antes desta versão e ainda sem chegada) não ganham OS
   automática: a OS deles continua sendo criada à mão. A S9 pode gerar as que faltarem.
3. **Registros antigos em aberto** (pedidos de compra, medições, pedidos de ajuda) ficam parados
   no banco, sem tela. Nada os altera.
4. **Retorno de versão:** voltar para uma versão anterior religa os módulos com os dados intactos.
   OS criadas no fechamento por esta versão continuam válidas na versão anterior.

## 5. Confirmações

- Nenhum ambiente real (homologação ou produção) foi acessado ou alterado.
- Sem migration, sem alteração de dados, sem merge e sem PR.
- Retiradas, Roteiro do dia, Expedição e entregas, Estoque da oficina, lista simples de materiais e
  medidas das peças na OS continuam funcionando.
