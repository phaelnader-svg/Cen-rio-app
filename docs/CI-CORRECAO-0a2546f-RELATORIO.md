# Correção isolada do CI sobre `0a2546f` (ponta `87d626c`)

Branch `claude/correcao-ci-0a2546f`. Só duas correções, sem mudança de comportamento, sem migration,
sem deploy e sem tocar em ambiente real (produção foi apenas lida).

## 1. Formatação de `docs/E1-MATERIAIS-RELATORIO.md`

`pnpm format:check` acusava só este arquivo. Foi aplicado o `prettier` do repositório: muda apenas o
alinhamento das tabelas Markdown, não o texto.

## 2. Divergência de índices em `service_order_materials`

| Verificação                     | Resultado                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origem                          | `20270309000000_materiais_estoque_entrega/migration.sql:125-126` cria `service_order_materials_linked_purchase_item_id_idx` e `service_order_materials_linked_cost_id_idx` (btree, uma coluna)                                          |
| `schema.prisma`                 | os dois `@@index` **nunca foram declarados** (ausentes em `696e3e9`, `9fb6b03`, `0a2546f`); a divergência existe desde a Fase 1 da reformulação                                                                                         |
| Banco real (produção `696e3e9`) | `database_fingerprint` (somente leitura, 16/11/2026): os dois índices existem, `btree`, não únicos, não parciais, `valid=true`, com exatamente a definição das migrations. Homologação: não acessível por esta sessão                   |
| Correção                        | declarar `@@index([linkedPurchaseItemId])` e `@@index([linkedCostId])` no modelo `ServiceOrderMaterial`. Os nomes padrão do Prisma coincidem com os do banco                                                                            |
| Efeito no banco                 | **nenhum**. `prisma migrate diff --from-migrations … --to-schema-datamodel …` gera migration **vazia**; nenhum índice é criado ou removido. Os índices continuam úteis para a leitura histórica da conciliação (S4 preserva as colunas) |

## 3. Validação (PostgreSQL 16 local descartável, mesmos passos do CI)

| Passo                                                       | Resultado                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`          | ✔                                                                                                          |
| Migrations do zero (38) + `prisma migrate diff --exit-code` | ✔ "No difference detected"                                                                                 |
| `pnpm build`                                                | ✔                                                                                                          |
| `pnpm test`                                                 | ✔ shared 151 · web 44 (+18 falha esperada) · API 1065 (+17 falha esperada, 13 pulados: desempenho e Caddy) |
| E2E Playwright completo                                     | ✔ 80/80                                                                                                    |

Não executado: `test:backup` (precisa da pilha Docker) e o teste do proxy Caddy (binário ausente
nesta máquina; ambos rodam no CI).
