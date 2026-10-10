# Cenário Gestão — Correção global de interface, ordens de serviço e logística

> Relatório consolidado das fases A–H. Tudo foi executado **localmente**, em PostgreSQL 16
> descartável com **dados fictícios**. Nada foi publicado, nenhuma migration rodou no Google
> Cloud, a homologação não foi tocada, nenhum pagamento foi feito e o VerificaPro não foi alterado.

## 1. Identificação

| Item                            | Valor                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Branch                          | `claude/cenario-gestao-fase-1-zf3bj2`                                                               |
| Versão publicada na homologação | `4f9b1ae` (não alterada)                                                                            |
| SHA inicial deste trabalho      | `9f29300`                                                                                           |
| SHA final                       | ver §12 (último commit desta branch após o push)                                                    |
| Banco de teste                  | PostgreSQL 16 local (`cenario_test`, `cenario_e2e_test`), recriado a cada suíte                     |
| Navegador testado               | Chromium (Playwright 1.56.1) — **Safari/WebKit e aparelhos físicos NÃO foram testados nesta etapa** |

Commits (em ordem):

| Commit    | Conteúdo                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `5a4f2d1` | Design system único: campos, grids, botões, modais, tabelas; auditoria de geometria automatizada                         |
| `5792c42` | Nova OS em seções: titular e mão de obra por peça na mesma transação, valores comerciais, resumo                         |
| `b161c02` | Logística: agendamento por horário de chegada; roteiro diário com sequência auditada (migration aditiva)                 |
| `65b5773` | E2E: capturas dos fluxos novos só com `E2E_GEOMETRIA`                                                                    |
| `29d190f` | Filtros com `.field`, dados próprios na auditoria de geometria, rollback do roteiro no teste de migrações                |
| (final)   | `.field` encolhe em colunas estreitas, teste de entrega por horário de chegada, evidências selecionadas e este relatório |

## 2. Fase A — Inventário de telas auditadas

A auditoria é **automatizada** (`tests/e2e/specs/zz-geometria.spec.ts`): para cada tela e para cada
largura (390, 768, 1280, 1440 px) ela mede a altura de todo campo (`input`, `select`, `textarea`),
agrupa os campos por linha visual e acusa linhas cujo topo/altura divergem, mede botões, rolagem
horizontal da página e campos que estouram o contêiner. Diálogos são abertos pelo botão que os
dispara e medidos também.

**Telas e diálogos auditados (53 na medição final; 51 na linha de base):**

- Painel: início, ajuda, Central de Atenção, auditoria, conta, empresa, competências, presença,
  prontidão, planejamento, reprogramação.
- Cadastros: clientes (lista, detalhe, diálogo _Novo cliente_), funcionários (lista, _Novo
  funcionário_), funções (_Nova função_), fornecedores (_Novo fornecedor_), dispositivos
  (_Cadastrar dispositivo_).
- Comercial: pedidos (lista, novo, detalhe, editar, diálogo _Solicitar retirada_), retiradas,
  recebimentos (lista, novo), OS (lista, **nova OS**, detalhe), medições (lista, detalhe).
- Produção: quadro, planejamento, modelos.
- Materiais: materiais, estoque (_Novo material_), compras (lista, nova, detalhe), recebimento de
  materiais.
- Qualidade/expedição: qualidade (_Novo checklist_), entregas (lista, detalhe, diálogo _Alterar_
  de entrega provisória), devoluções, **roteiro do dia** (novo).
- Financeiro: visão geral, receitas (_Lançar cobrança_), contas a pagar (_Nova conta a pagar_),
  despesas (_Nova despesa_), custos por OS (_Lançar custo logístico_), produção e equipe
  (_Combinar valor_), fechamento semanal.
- Tablet/celular (fluxos E2E): Meu dia, tarefas, logística (com o roteiro), em 390 px e tablet.

## 3. Problemas encontrados e causa raiz

Linha de base (`docs/evidencias/interface/antes/geometria.json`): **51 telas × 4 larguras = 204
medições; 23 medições com desalinhamento, 35 linhas desalinhadas; alturas de campo no sistema:
38, 43 e 45 px; 15 alturas diferentes de botão.** Nenhuma rolagem horizontal da página.

| #   | Problema                                                                                      | Onde                                                                                                           | Causa raiz                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `select` com 43 px ao lado de `input`/`date` com 45 px (desnível de 2 px em toda linha mista) | Novo cliente, Cadastrar dispositivo, Lançar cobrança, Nova conta a pagar, Nova despesa, Lançar custo logístico | A classe `.input` não fixava altura: cada controle nativo usava a própria altura (padding + line-height + seta nativa do `select`). |
| P2  | Campos 20 px abaixo dos vizinhos                                                              | Empresa (horários de funcionamento), Central de Atenção (filtros, 1280/1440)                                   | Rótulos longos quebravam em duas linhas e empurravam só aquele controle; não havia linha de rótulo comum.                           |
| P3  | Botão de remover/ação fora do eixo dos campos                                                 | Nova OS, pedido, detalhe da OS                                                                                 | Grids com `items-end` + texto de ajuda sob alguns campos: o botão alinhava pela base do _bloco_, não do controle.                   |
| P4  | Campos compactos de 38 px misturados com 45 px                                                | Planejamento de produção, modelos, quantidade na retirada, galeria de fotos                                    | Classes ad-hoc (`py-1`, `text-sm`) em vez de uma variante definida.                                                                 |
| P5  | 15 alturas de botão                                                                           | Sistema todo                                                                                                   | Tamanhos de botão por `padding`, sem altura fixa.                                                                                   |
| P6  | Tabelas com cabeçalho, alinhamento numérico e espaçamento diferentes por tela                 | 12 arquivos                                                                                                    | Cada tela estilizava sua `<table>`; valores não usavam algarismos tabulares nem alinhamento à direita.                              |
| P7  | Diálogo longo ultrapassando a altura do celular; rodapé espremido                             | Diálogos de formulário em 390 px                                                                               | `max-h` fixo sem `dvh`, corpo sem rolagem própria, rodapé em linha mesmo no celular.                                                |
| P8  | Retirada/entrega pedia **janela início–fim**; operação real combina **um horário de chegada** | Retiradas, entregas, pedido, tablet                                                                            | Modelo herdado de "janela de atendimento"; não havia roteiro por dia nem sequência.                                                 |
| P9  | Nova OS sem titular nem mão de obra: exigia voltar à OS e lançar peça a peça                  | Nova OS                                                                                                        | A criação tratava só as peças; titular (Fase 3) e mão de obra (Fase 5) eram passos posteriores separados.                           |

## 4. Fases B/C — Componentes padronizados e aplicação

Fonte única: `apps/web/app/globals.css` (camada `@layer components`) + `apps/web/components/ui/*`.

| Token / componente                    | Regra                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.input`, `.select`, `.textarea`      | Altura de controle **44 px** (`h-11`), mesma borda, raio, foco e fonte; `select` com `appearance-none` e seta SVG própria (mesma altura do `input` em qualquer navegador).                                                                                                                                                                             |
| `.input-sm`                           | Variante compacta **36 px** para tabelas de edição (planejamento, modelos, quantidades).                                                                                                                                                                                                                                                               |
| `.input-lg` / `.label-lg`             | Variante de tablet **56 px** (toque).                                                                                                                                                                                                                                                                                                                  |
| `.field` (subgrid)                    | Dentro de um `.grid`, cada campo ocupa 3 linhas do grid pai (**rótulo / controle / mensagem**) via `grid-template-rows: subgrid`: rótulos de uma ou duas linhas não desalinham mais os controles (P2) e ajuda/erro não empurra vizinhos (P3).                                                                                                          |
| `.field-action`                       | Coloca um botão (remover, adicionar) exatamente na linha do controle.                                                                                                                                                                                                                                                                                  |
| `Field` (`components/ui/field.tsx`)   | Sempre renderiza rótulo + controle + mensagem (hint/erro), com `htmlFor`/`aria-describedby`/`aria-invalid`.                                                                                                                                                                                                                                            |
| `components/ui/form.tsx` (novo)       | `FormGrid` (12 colunas a partir de `sm`, 1 coluna no celular), `FormSection` (etapa, título, descrição, ações), `FormActions` (opção fixa no rodapé), `TextField`, `NumberField`, `DateField`, `TimeField`, `SelectField`, `TextAreaField`, `MoneyField` (larguras proporcionais via `cols`), `FieldAction`, `SummaryRow`, `ModalLayout` (= `Dialog`). |
| `Button`                              | `md` 44 px e `sm` 36 px fixos.                                                                                                                                                                                                                                                                                                                         |
| `Dialog`                              | Tamanhos sm…xl; `max-h: min(88vh, 100dvh − 1.5rem)`; corpo com rolagem própria; rodapé empilhado no celular (ação principal em cima).                                                                                                                                                                                                                  |
| `.data-table` / `.data-table-compact` | Cabeçalho, linhas, `tfoot`, `.num`/`.money` (à direita, algarismos tabulares), `.actions`, `.table-wrap` (rolagem horizontal só dentro da tabela).                                                                                                                                                                                                     |
| `MoneyInput`                          | Algarismos tabulares, alinhamento consistente.                                                                                                                                                                                                                                                                                                         |

Aplicação: 41 arquivos de `apps/web` alterados — todas as tabelas migradas para `.data-table`
(12 arquivos), campos compactos para `.input-sm`, campos de tablet para `.input-lg`, filtros de
listas (equipe, entregas, ocorrências, quadro, modelos, planejamento de medições) com rótulo
`.field`, botões de remover em `.field-action`, `items-end` removido dos grids de formulário.
Nenhuma funcionalidade foi removida; rótulos acessíveis foram mantidos (os testes E2E localizam
os campos pelo rótulo).

## 5. Fase D — Nova OS

Tela `apps/web/components/commercial/new-service-order-page.tsx`, em seis seções numeradas:

1. **Informações gerais** — pedido, cliente, prazo, observações.
2. **Peças** — peças recebidas disponíveis, quantidade, tipo de serviço, tecido escolhido.
3. **Responsável** — **titular por peça** (tapeceiros elegíveis: tapeceiro, ou corte e costura com
   `producao.executar`, mesma regra da Fase 3).
4. **Valores comerciais** — valor contratado do pedido e participação desta OS (proporcional às
   peças; divisão manual continua em _Financeiro → ajustes_, regra existente). Só aparece com
   `pedidos.valores`.
5. **Mão de obra** — valor combinado por peça para o titular, serviço e elegibilidade (padrão
   _qualidade aprovada_). Só aparece com `financeiro.ver` + `financeiro.gerenciar`.
6. **Resumo** — contratado, receita projetada da OS, mão de obra total e **saldo estimado**, com o
   aviso "Não é lucro" (custos de material, logística e despesas não entram).

API (`POST /api/v1/service-orders`, contrato compatível — campos novos opcionais por peça:
`upholstererUserId`, `labor`):

- **Atômica**: OS, peças, titular (`setUpholsterer`) e mão de obra (`createLabor`) são gravados na
  **mesma transação**; falha em qualquer parte desfaz tudo (teste A2).
- **Sem duplicação financeira**: a mão de obra usa o mesmo serviço da Fase 5 (uma por peça,
  status `PREVISTO`); a receita continua sendo a do pedido — não existe valor comercial por peça
  no domínio, e a tela não o inventa.
- **Sem pagamento automático**: nada é liberado nem pago; a obrigação segue o ciclo de
  elegibilidade/fechamento das Fases 5–7.
- **Permissões**: titular exige `producao.planejar`; mão de obra exige `financeiro.ver` +
  `financeiro.gerenciar`; valores comerciais ocultos sem `pedidos.valores` (teste A3).
- **Idempotência**: mesma `idempotency-key` devolve a mesma OS, sem segunda mão de obra (teste A1).
- **Auditoria**: os registros de auditoria de titular e mão de obra são os mesmos das Fases 3/5.

## 6. Fase E — Agendamento por horário de chegada

- Retirada e entrega têm **data + um único horário de chegada ao cliente** (gravado em
  `window_start`), equipe, responsável pela execução, recebedor financeiro e participantes
  (custo da viagem — Fase 6), valor total, endereço, peças, instruções e observações.
- **Não há horário de fim.** `window_end` existe só para registros antigos: é exibido como
  "janela 09:00–12:00" e **nunca é convertido** automaticamente (teste B2).
- **Solicitação sem horário é permitida** (retirada aguardando agendamento; entrega provisória).
  **Compromisso confirmado exige data + chegada**: retirada com data sem chegada → 400; entrega
  confirmada sem chegada → 400; confirmar entrega provisória sem chegada → 422 (testes B1, B3).
- A retirada agora aceita o **responsável já na solicitação** (`logisticsUserId`), validado como
  pessoa da logística (422 caso contrário) e notificado.
- Valor total da viagem configurável por viagem; **André como recebedor único** pelo padrão da
  Fase 6; Izaías participa sem virar credor. O recebedor só é gravado quando a obrigação vence
  (regra existente) — no agendamento o custo fica `PREVISTO`.
- Reagendar (mudar a data) zera a sequência do roteiro daquela parada.

## 7. Fase F — Roteiro diário

- Painel **Roteiro do dia** (`/painel/roteiro`, item de menu novo) e, no tablet/celular, o bloco
  **Roteiro** de hoje e amanhã em _Logística_, mais "Outros dias e pendências".
- Cada parada mostra: posição, tipo (retirada/entrega), código, cliente e endereço (só para quem
  pode ver), OS/peças, **horário de chegada**, situação e instruções. O celular da equipe **não**
  mostra valores.
- Ordem padrão: pelo horário de chegada; o gestor pode **reordenar** (↑/↓ com rótulo acessível
  "Mover X para cima/baixo"), informar motivo e salvar. A sequência é **independente do horário
  contratado**: reordenar não altera horário, data nem versão do compromisso (teste C2).
- Histórico: cada alteração gera `audit_logs` (`logistics_route`, data) com ordem anterior/nova e
  motivo; evento em tempo real `logistics.route_changed` atualiza painel e celulares.
- Concorrência: trava consultiva por data; sequência enviada sobre um conjunto desatualizado → 409.
- Alertas sem estimativa inventada de deslocamento: parada confirmada sem horário, mesmo horário
  para a mesma pessoa, e sequência que contradiz os horários ("confira o deslocamento").
- Visibilidade: o gestor vê tudo; André e Izaías veem só as paradas em que são responsáveis ou
  participantes; quem executa não reordena (403).
- Regras financeiras das Fases 6/7 intactas (custo, rateio, recebedor, fechamento).

## 8. Alterações de banco

Uma migration **aditiva**: `packages/db/prisma/migrations/20261122000000_roteiro_logistica`.

```sql
ALTER TABLE "pickup_requests" ADD COLUMN "route_sequence" INTEGER;  -- CHECK (route_sequence >= 1)
ALTER TABLE "deliveries"      ADD COLUMN "route_sequence" INTEGER;  -- CHECK (route_sequence >= 1)
```

- Colunas anuláveis, sem default, sem reescrita de tabela, sem índice novo: bloqueio desprezível.
- Nenhum dado existente é alterado. `window_start`/`window_end` permanecem como estão.
- Rollback: `packages/db/rollback/20261122000000_roteiro_logistica.down.sql` (remove as duas
  colunas; perde apenas sequências manuais do roteiro).
- O teste de evolução (`scripts/test-evolution-migrations.sh`) inclui a nova migration: aplica,
  reverte na ordem e restaura backup (ver §10).
- **Não executada no Google Cloud.**

## 9. Evidências visuais

- `docs/evidencias/interface/antes/` e `docs/evidencias/interface/depois/`: `geometria.json`
  completo (todas as telas × 4 larguras) e capturas selecionadas das telas-chave em 390 e 1440 px.
- `docs/evidencias/interface/fluxos/`: nova OS completa, retirada com horário de chegada, roteiro
  do gestor e celular do André (390 px).

### Resultado da auditoria de geometria (antes × depois)

| Medida                        | Antes (`9f29300`) | Depois (final)                                                                                |
| ----------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Telas/diálogos medidos        | 51                | **55** (+ roteiro, roteiro por data, diálogo _Solicitar retirada_, diálogo _Alterar_ entrega) |
| Medições (telas × 4 larguras) | 204               | **220**                                                                                       |
| Medições com desalinhamento   | 23                | **0**                                                                                         |
| Linhas de campos desalinhadas | 35                | **0**                                                                                         |
| Alturas de campo no sistema   | 38, 43, 45 px     | **36 (compacto) e 44 px**                                                                     |
| Rolagem horizontal da página  | 0                 | **0**                                                                                         |
| Campos estourando o contêiner | 0                 | **0**                                                                                         |

O teste roda em modo estrito (`E2E_GEOMETRIA_ESTRITO=1`) e **falha** se qualquer medição tiver
linha desalinhada, rolagem horizontal > 2 px ou campo estourado — virou proteção contra regressão.
Uma iteração intermediária pegou um caso real: o filtro _Data_ da Central de Atenção estourava a
coluna em 1280 px (o controle nativo de data não encolhia dentro do `.field` em subgrid);
corrigido com `grid-template-columns: minmax(0, 1fr)` no `.field`/`.field-action`.

Alturas de **botão**: o componente `Button` agora tem só 36 (`sm`) e 44 px (`md`). As demais
alturas medidas vêm de elementos clicáveis que **não são botões de formulário** e variam de
propósito: chips de dia da semana (empresa), amostras de cor (funcionário), links de texto,
abas e cartões clicáveis de retiradas/reprogramação/atenção (66–130 px, conteúdo de várias linhas).

Capturas selecionadas (390 e 1440 px; as demais larguras estão medidas no `geometria.json`):
nova OS, novo pedido, _Novo cliente_, empresa, Central de Atenção, _Nova conta a pagar_, _Lançar
custo logístico_, _Cadastrar dispositivo_, entregas, retiradas, planejamento de produção e, no
depois, roteiro, _Solicitar retirada_ e _Alterar_ entrega.

## 10. Matriz de critérios de aceite

Legenda: **API** = `apps/api/test/correcao-global.test.ts` (A1–A3, B1–B3, C1–C3); **E2E** =
`tests/e2e/specs/*`; **GEO** = auditoria de geometria `zz-geometria.spec.ts` em modo estrito.

| CA    | Critério                                | Evidência                                                                                                                                                                               | Resultado                                     |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| CA-01 | Todos os formulários auditados          | GEO: todas as telas do painel + diálogos, 4 larguras (§2, §9)                                                                                                                           | ✅                                            |
| CA-02 | Alturas padronizadas                    | GEO: alturas de campo no sistema **36 (compacto) e 44 px**; antes 38/43/45                                                                                                              | ✅                                            |
| CA-03 | Grids e espaçamentos consistentes       | GEO: **0 linhas desalinhadas** (antes 35); `FormGrid`/`.field` subgrid                                                                                                                  | ✅                                            |
| CA-04 | Modais responsivos                      | GEO mede 11 diálogos em 390–1440 sem estouro; `Dialog` com `dvh`, corpo rolável, rodapé empilhado                                                                                       | ✅                                            |
| CA-05 | Tabelas consistentes                    | `.data-table` em todas as tabelas (12 arquivos); números com algarismos tabulares à direita                                                                                             | ✅ (inspeção + capturas)                      |
| CA-06 | Sem overflow horizontal indevido        | GEO: rolagem horizontal 0 e **0 campos estourados**; E2E do celular do André (390 px)                                                                                                   | ✅                                            |
| CA-07 | Teclado e acessibilidade                | Rótulos `label/htmlFor`, `aria-describedby`, `aria-invalid` no `Field`; botões do roteiro com `aria-label`; todos os E2E localizam campos por rótulo e papel (`getByLabel`/`getByRole`) | ✅ (automatizado; leitor de tela não testado) |
| CA-08 | OS com valor comercial correto          | API A1, A3; E2E `team-route-os` (contratado R$ 3.000,00, saldo R$ 1.750,00)                                                                                                             | ✅                                            |
| CA-09 | OS com titular e mão de obra por peça   | API A1; E2E `team-route-os`                                                                                                                                                             | ✅                                            |
| CA-10 | Múltiplas peças e tapeceiros diferentes | API A1 (2 peças, 2 tapeceiros); E2E (Ricardo R$ 800, Márcio R$ 450)                                                                                                                     | ✅                                            |
| CA-11 | Nenhuma duplicação financeira           | API A1 (repetição idempotente sem 2ª obrigação), A2 (falha desfaz tudo)                                                                                                                 | ✅                                            |
| CA-12 | Edição e revisão financeira seguras     | Fluxos da Fase 5 inalterados: E2E `team-labor` (substituição com revisão) e suíte API completa                                                                                          | ✅                                            |
| CA-13 | Retirada com horário único de chegada   | API B1; E2E `team-route-os` (sem campo de fim)                                                                                                                                          | ✅                                            |
| CA-14 | Entrega com horário único de chegada    | API B3 (confirmada exige chegada; provisória sem horário; confirmar exige chegada); E2E `team-quality`                                                                                  | ✅                                            |
| CA-15 | Valor total da equipe configurável      | API B1 (R$ 100,00 na solicitação); E2E `team-route-os`, `team-logistics`                                                                                                                | ✅                                            |
| CA-16 | André como recebedor único              | API B1, C1 (Izaías participa sem ser credor); E2E "André (100%)"                                                                                                                        | ✅                                            |
| CA-17 | Roteiro diário ordenado                 | API C1 (ordem por chegada, posições 1..n); E2E painel e celular                                                                                                                         | ✅                                            |
| CA-18 | Sequência sem mudar compromisso         | API C2 (horário, data e versão intactos); E2E (chegada 16:00 mantida)                                                                                                                   | ✅                                            |
| CA-19 | Compatibilidade com registros antigos   | API B2 (janela 09:00–12:00 preservada, sem conversão); teste de migração (dados legados idênticos)                                                                                      | ✅                                            |
| CA-20 | Cancelamentos e reagendamentos          | API C2 (remarcar zera a sequência e tira a parada do dia antigo; cancelada sai do roteiro); suíte de logística da Fase 6                                                                | ✅                                            |
| CA-21 | Integração com fechamento semanal       | Mão de obra criada na OS entra como `PREVISTO` no mesmo serviço; E2E `team-closing`; API `closing*`                                                                                     | ✅                                            |
| CA-22 | Privacidade e permissões                | API A3 (permissão por parte), C1 (equipe vê só as próprias paradas, sem valores; 403 ao reordenar); E2E celular sem "R$"                                                                | ✅                                            |
| CA-23 | Tempo real e reconexão                  | Evento `logistics.route_changed` + invalidação `['logistics-route']`; E2E `tablet-sync`, `team-week`, `team-workshop` (reconexão)                                                       | ✅                                            |
| CA-24 | Concorrência e idempotência             | API A1 (idempotência), C2 (409 com sequência desatualizada; trava por data)                                                                                                             | ✅                                            |
| CA-25 | Backup, migration e restauração         | `scripts/test-evolution-migrations.sh`: aplica, rollback na ordem (schema idêntico), recusas atômicas, backup/restauração de 111 tabelas                                                | ✅                                            |
| CA-26 | Regressão completa                      | API 386 ✓ / 5 ignorados (desempenho, por variável de ambiente); E2E 29/29; lint e typecheck limpos                                                                                      | ✅                                            |

## 11. Resultados de testes

Tudo em PostgreSQL 16 local descartável, dados fictícios, Chromium.

| Suíte                            | Comando                                                        | Resultado                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint                             | `pnpm lint` (`--max-warnings=0`)                               | ✅ limpo                                                                                                                                                          |
| Tipos                            | `pnpm typecheck` (shared, db, api, web, e2e)                   | ✅ limpo                                                                                                                                                          |
| Formatação                       | `prettier --check` nos arquivos alterados                      | ✅                                                                                                                                                                |
| API completa                     | `pnpm --filter api test`                                       | ✅ **386 passaram**, 5 arquivos ignorados (desempenho/migração, ativados por variável de ambiente)                                                                |
| API — correção global            | `vitest run test/correcao-global.test.ts`                      | ✅ **9/9** (A1–A3, B1–B3, C1–C3)                                                                                                                                  |
| E2E completo + geometria estrita | `E2E_GEOMETRIA=depois E2E_GEOMETRIA_ESTRITO=1 playwright test` | ✅ **29/29** (15,8 min), incluindo `team-route-os` (OS completa → retirada com chegada → roteiro reordenado → celular do André em 390 px)                         |
| Migrações                        | `PG_BASE=… scripts/test-evolution-migrations.sh`               | ✅ legado → Fases 2–7 + roteiro; dados legados idênticos (98 tabelas); rollback em ordem com schema idêntico; recusas atômicas; backup/restauração de 111 tabelas |

Ajustes em testes existentes (sem enfraquecer nada): `logistics-costs.test.ts` passou a informar
`windowStart` onde agenda compromisso confirmado (regra nova); E2E de comercial, qualidade,
logística e fechamento passaram a usar os rótulos novos ("Data do compromisso", "Horário de
chegada ao cliente").

## 12. Pendências e GO/NO-GO técnico

### Pendências (não bloqueiam o GO técnico local)

1. **Safari/WebKit e aparelhos físicos NÃO testados nesta etapa.** O CSS evita dependências
   frágeis (seta própria no `select`, altura fixa nos controles, `@supports` para subgrid com
   fallback em coluna, `dvh` no diálogo, suportado desde o Safari 15.4), mas a aprovação em iPhone/iPad e no tablet
   real só pode ser declarada depois do roteiro de testes físicos.
2. **Valor comercial por peça não existe no domínio.** A OS mostra a participação dela no valor do
   pedido (proporcional ou divisão manual existente); criar valor por peça seria mudança de
   modelo financeiro — fora do escopo e não feito.
3. Leitor de tela (VoiceOver/TalkBack) não foi exercitado; a acessibilidade foi verificada por
   rótulos/papéis nos testes automatizados.
4. Registros antigos com janela início–fim continuam exibidos como "janela"; não há conversão
   automática (decisão proposital — o gestor ajusta ao reagendar).
5. A publicação exige aplicar **uma** migration aditiva (`20261122000000_roteiro_logistica`) pelo
   runbook já existente (backup antes, migração explícita). **Não executada no Google Cloud.**

### GO / NO-GO técnico

| Item                                                         | Situação                      |
| ------------------------------------------------------------ | ----------------------------- |
| Interface padronizada (geometria estrita em 220 medições)    | ✅                            |
| Nova OS completa, atômica, sem duplicação nem pagamento      | ✅                            |
| Agendamento por horário de chegada + roteiro diário auditado | ✅                            |
| Permissões e privacidade preservadas                         | ✅                            |
| Regressão completa (API 386, E2E 29/29)                      | ✅                            |
| Migration aditiva com rollback e backup/restauração testados | ✅                            |
| Safari/WebKit e aparelhos físicos                            | ⚠️ não testados (pendência 1) |

**Decisão: GO técnico para publicar na homologação**, condicionado a: backup antes da migration
e o roteiro de testes físicos (Safari/iPhone, tablet real) logo depois. **Nada foi publicado.** A
publicação depende de **autorização explícita**.

SHA inicial: `9f29300` · SHA final: o commit que contém este relatório (último da branch
`claude/cenario-gestao-fase-1-zf3bj2` após o push).
