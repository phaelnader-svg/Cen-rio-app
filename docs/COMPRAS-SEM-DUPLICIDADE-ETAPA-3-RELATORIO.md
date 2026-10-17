# Compras e materiais sem duplicidade: Etapa 3 — Compra antes da chegada

**Classificação: GO WITH CAVEATS.**

Data: 2026-10-17. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Base homologada `0c9262c` (26/26).
Candidato `020a820` (CI nº 133 verde), ativo na homologação com 27/27 migrations. Produção fora do
escopo e não tocada.

## O que muda

O gestor pode **prever o material de uma peça do pedido antes de ela chegar** e comprar com
antecedência, sem OS fictícia e sem duplicar compra ou custo quando a peça chega.

- Nova origem `PREVISAO_COMPRA` na mesma `MaterialRequirement` (sem modelo paralelo). Destino antes da
  chegada: a peça do pedido (`order_item_id`); `service_order_id` passa a ser opcional só para ela.
- `PREVISAO_MANUAL` (anotação da OS) **intacta**: sem migração, sem reinterpretação, nunca entra em
  compras (AB-1).
- Permissão `materiais.aprovar` para criar, alterar, cancelar e vincular (AB-2). Tablet sem acesso.

## Migration (27ª, aditiva)

`20270112000000_compra_antes_da_chegada` (20 comandos):

- enum `material_requirement_origin` + `PREVISAO_COMPRA`;
- `material_requirements`: `service_order_id` opcional; `order_item_id` (FK RESTRICT) e índice
  `(order_item_id, status)`; CHECKs `destination_chk` (OS ou peça do pedido), `preos_forecast_chk`
  (sem OS só a previsão de compra), `forecast_fields_chk` (previsão exige peça, unidade e quantidade),
  `item_requires_os_chk` (peça de OS só com OS);
- `purchase_allocations.service_order_id` opcional;
- `purchase_order_items_sourcing`: exclusivo sem exigir OS (estoque inalterado);
- `material_leftovers`: `service_order_id` opcional, `order_item_id` + `source_requirement_id` (FKs
  RESTRICT) e `origin_chk`; `material_leftover_transfers.from_service_order_id` opcional.

**Backfill:** nenhum. Ensaio em cópia do banco E2E: aplicada, `migrate diff` vazio, dados idênticos,
CHECKs verificados.

## Decisões AB-1..AB-9

| Decisão | Implementação                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AB-3    | Chegada (`createServiceOrder`): vínculo automático só sem ambiguidade (quantidade 1, ou a linha inteira numa única peça de OS). Parcial → "Chegada parcial: vincular à OS" e vínculo manual pelo gestor (`POST /material-forecasts/:id/link`). Nada é dividido. Sem expansão de esquema. |
| AB-4    | Previsão na OS conta em `pending.forecasts`: prontidão nunca COMPLETO só com previsão; a medição real a substitui (cadeia da Etapa 2). Sem EM_RISCO antes da OS.                                                                                                                         |
| AB-5    | Sem reserva antes da OS. Na chegada, reserva automática só inequívoca e limitada ao destinado; reserva de outra OS nunca é saldo livre. Caso contrário, "Reservar" manual.                                                                                                               |
| AB-6    | Custo só depois do vínculo, pela linha de recebimento (`receipt_line:<id>`), com a data real do recebimento; uma vez por linha. Relatório de custos por período: sem perda nem duplicidade.                                                                                              |
| AB-7    | Remover a peça do pedido apaga a previsão virgem (auditado); com qualquer vínculo, recusa com mensagem clara.                                                                                                                                                                            |
| AB-8    | Sobra pré-OS (`source_requirement_id`, sem OS) com preço, recebimento, quantidade e especificação de origem; depois segue a transferência humana.                                                                                                                                        |
| AB-9    | Previsão virgem: edição no lugar (antes/depois auditado). Com vínculo (até rascunho): nova previsão ATIVA substitui a anterior; fornecedor nunca cancelado; rascunho antigo → 409 na confirmação.                                                                                        |

**Cancelamento:** endpoint da Etapa 2 reutilizado; cancelar o pedido cancela as previsões ATIVAS na
mesma transação (compras ficam "sem destino"); retirada cancelada/reagendada não cancela.

**Concorrência:** ordem única `pedido → peça → necessidades → OS → itens de compra → estoque`; testes
reais com `Promise.all` sem deadlock.

## Telas

- Pedido → **Previsão de material**: "Prever tecido/espuma/outro material" (formulário estruturado da
  medição), "Previsão — não medido", Alterar, Cancelar, Vincular, Registrar sobra.
- Compras → A comprar: linha **Pré-chegada** com pedido, peça e prazo prometido (contexto).
- Revisão da medição: "Substitui previsão: …" e "Previsto 12 m / Medido 10 m / Substitui previsão".
- Aba Materiais da OS: rótulo da previsão e o mesmo texto Previsto/Medido.

## Contraprova de custo (critério de GO)

Todos os 8 pontos provados em `compras-etapa3.test.ts`: zero custo antes da OS; mesmas
necessidade/alocação vinculadas; data original; uma linha por linha de recebimento; sync repetido,
repetição da chegada e chegada × recebimento em paralelo sem duplicar; duas linhas de recebimento →
duas linhas de custo.

## Testes

- API nova: 24 testes (`compras-etapa3.test.ts`). API completa: **606 aprovados, 10 ignorados, 0
  falhas** (Etapa 1 e 2 verdes).
- Shared 112, web 6. E2E completo local **42/42** (inclui `compras-etapa3.spec.ts`).
- Lint, typecheck, format e build OK. CI nº 133 verde em `020a820`.

## Homologação

1. Antes: `0c9262c`, 3.827 linhas; desde a Etapa 2 só mudaram dispositivos, sessões, usuários,
   auditoria e eventos (uso do tablet), nada de compras.
2. Build `020a820` SUCCESS (api `sha256:a6d4e9b96a08…`, web `sha256:cb7240d77ea8…`). `gate_open`,
   `prepare_version` OK.
3. `migration_precheck`: imagem 27, banco 26, **1 pendente** compatível (20 comandos).
4. `maintenance_on`; ponto de recuperação **`cenario-staging-20261017T181404Z`** (restauração de teste
   idêntica, enviado ao bucket); `backup_validate` OK.
5. `migrate`: **1 aplicada** em 15 s. `activate_version 020a820`, `gate_close`.
6. `migration_verify` 27/27; health, smoke e WebSocket (401 sem sessão) OK; suítes acesso e websocket
   ✔; logs sem erro (só os 503 esperados de um navegador aberto durante a manutenção).
7. Depois (3.850 linhas): só `_prisma_migrations` 26 → 27 e o esquema da migration;
   `material_requirements` com as mesmas 4 linhas (hash muda só pela coluna nova nula). Nenhuma outra
   tabela mudou.
8. Imagens `56192c1` removidas; `020a820` (ativa) e `0c9262c` (ponto de recuperação) protegidas.

## Ressalvas

1. Fluxos não clicados na homologação (sem login de aplicação no runner); validação funcional pelo CI
   nº 133 e E2E 42/42 sobre o mesmo commit.
2. Chegada parcial exige ação do gestor (Vincular) — por desenho (AB-3).
3. A reserva automática na chegada só ocorre no caso inequívoco; nos demais, "Reservar" manual (AB-5).
4. A previsão de compra só nasce em peça que ainda não está em OS; depois disso, vale a medição real.
