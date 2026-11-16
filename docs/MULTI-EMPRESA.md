# Multi-empresa (um único sistema, várias empresas)

Decisão do dono em 2026-11-16: o Cenário Gestão passa a ser **um único sistema com várias
empresas**, cada uma com dados isolados. "Criar conta" cria uma empresa nova e entra direto; nunca
entra na Cenário Estofados, que vira a empresa nº 1 com todos os dados atuais.

Plano aprovado (2026-11-16): https://claude.ai/artifact/Jykp8EMfom3S9WErKwYRkn

## Como o isolamento funciona (alvo)

1. **Coluna `company_id`** em toda tabela de empresa (inclusive filhas), preenchida com a empresa 1
   na migração dos dados atuais.
2. **Trava no banco (Row-Level Security):** cada transação define `app.company_id`; as políticas do
   Postgres só devolvem linhas dessa empresa, inclusive no SQL direto (`$queryRaw`). A API conecta
   com um usuário sem `BYPASSRLS` e as tabelas usam `FORCE ROW LEVEL SECURITY`.
3. **Trava no código:** a requisição carrega a empresa resolvida da sessão; o cliente Prisma da
   requisição só existe com empresa definida.
4. **Teste de vazamento** (`apps/api/test/multi-empresa-vazamento.test.ts`) roda a cada mudança.

## Etapas

| Etapa | O que                                                                                                                 | Estado    |
| ----- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| 1     | Mapa das tabelas + detector de vazamento                                                                              | **feito** |
| 2     | `company_id` em todas as tabelas, empresa 1, unicidades/numerações por empresa, ensaio com cópia do banco de produção | pendente  |
| 3     | Empresa em cada requisição, RLS ligada, SQL direto, arquivos, tempo real, tablets                                     | pendente  |
| 4     | Criar conta (reaproveita 0f96eba/9375a30) criando a empresa e o conteúdo inicial                                      | pendente  |
| 5     | Teste do dono em homologação                                                                                          | pendente  |
| 6     | Produção (com aprovação, ponto de recuperação, backup validado)                                                       | pendente  |

## Etapa 1 — o mapa

Fonte da verdade: `packages/db/src/tenancy.ts`. Teste: `apps/api/test/multi-empresa-mapa.test.ts`
(falha se um model novo não for classificado).

| Classe         | Tabelas | Significado                                                                                                                                                                                                           |
| -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empresa`      | 119     | Dados de uma empresa: recebem `company_id` e RLS                                                                                                                                                                      |
| `acesso`       | 6       | `users`, `sessions`, `devices`, `oauth_codes`, `oauth_grants`, `oauth_access_tokens` (e-mail/credencial/token procurados antes de saber a empresa; recebem `company_id`, a busca é feita pela camada de autenticação) |
| `sistema`      | 3       | `auth_throttle`, `event_consumers`, `oauth_clients`: sem empresa, sem dados de clientes                                                                                                                               |
| `empresa-raiz` | 1       | `company_settings` (hoje id fixo 1) vira a tabela de empresas                                                                                                                                                         |

Pontos que a etapa 2 precisa tratar (marcados no mapa):

- **28 numerações automáticas** (pedido, OS, compra, entrega, tarefa…) passam a recomeçar em 1 por
  empresa (`perCompanyUnique: ['number']`). A sequência `domain_events.seq` continua global.
- **Unicidades que viram por empresa:** `roles.key/name`, `devices.name`, `stock_items.spec_key`,
  `production_plans.week_start`, `weekly_closings.week_start`, `item_locations.key`,
  `company_holidays.date`.
- **Continuam únicas no sistema todo:** `users.email` (um e-mail = uma empresa), hashes de
  credenciais/tokens, `service_order_costs.source_key` (montado com UUIDs).
- **Conteúdo inicial por empresa** (`seededPerCompany`): funções e permissões, módulos, modelos de
  produção, modelos de qualidade, locais da oficina, configurações da empresa.
- **`company_settings.findUnique({ where: { id: 1 } })`** aparece em vários módulos: passa a ler a
  empresa da requisição.
- **SQL direto:** 47 arquivos usam `$queryRaw`/`$executeRaw`; ficam cobertos pela RLS, mas cada um
  será revisado na etapa 3.
- **Arquivos** (`STORAGE_DIR`): prefixo por empresa na `storage_key`.

## Detector de vazamento

Coleta os ids de todas as linhas das tabelas de empresa e percorre todas as rotas GET sem parâmetro
procurando esses ids nas respostas. Na etapa 1 ele prova que enxerga os dados (o gestor vê os
próprios clientes, pedidos e retiradas). Na etapa 3 roda logado na empresa B contra os ids da A e
precisa achar zero; as rotas com `/:id` também passam a ser testadas com ids da outra empresa.

## Decisões do dono (2026-11-16)

- Conta nova entra grátis; cobrança automática fica para um projeto depois.
- Painel simples do dono da plataforma: lista de empresas, bloquear/liberar (etapa 4).
- Todos os clientes usam cenariogestao.com.br, sem subdomínio por empresa.
- Passagem para produção fora do expediente da fábrica (data a combinar na etapa 6).
