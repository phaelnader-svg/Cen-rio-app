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

| Etapa | O que                                                                                                                 | Estado                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | Mapa das tabelas + detector de vazamento                                                                              | **feito**                                      |
| 2     | `company_id` em todas as tabelas, empresa 1, unicidades/numerações por empresa, ensaio com cópia do banco de produção | **feito** (falta ensaio com cópia de produção) |
| 3     | Empresa em cada requisição, RLS ligada, SQL direto, arquivos, tempo real, tablets                                     | **feito**                                      |
| 4     | Criar conta (reaproveita 0f96eba/9375a30) criando a empresa e o conteúdo inicial                                      | **feito**                                      |
| 5     | Teste do dono em homologação                                                                                          | pendente                                       |
| 6     | Produção (com aprovação, ponto de recuperação, backup validado)                                                       | pendente                                       |

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

## Etapa 2 — banco com empresa

Migration `20270420000000_multi_empresa_etapa2` (reversão em
`packages/db/rollback/20270420000000_multi_empresa_etapa2.down.sql`). Só acrescenta.

- `company_settings` vira a tabela de empresas: sai a trava `company_settings_singleton`
  (id = 1), o id passa a vir de `company_settings_id_seq`. A migration garante a empresa 1
  ("Cenário Estofados") antes das chaves estrangeiras.
- `app_company_id()`: empresa da transação (`set_config('app.company_id', …, true)`); sem
  definição, devolve 1. **Etapa 3 troca o 1 de reserva por erro.**
- 126 tabelas (empresa + acesso + `company_counters`) com `company_id INTEGER NOT NULL DEFAULT
app_company_id()` e FK para `company_settings`. O `DEFAULT 1` constante usado no `ADD COLUMN`
  não reescreve as tabelas.
- 28 numerações: sem sequência global; gatilho `assign_company_number` preenche `number` a partir
  de `company_counters` (uma linha por empresa e tabela). A empresa 1 continua do maior número já
  usado (ou do ponto da sequência antiga, o que for maior). No Prisma: `@default(dbgenerated())`.
- Unicidades por empresa: as 8 de `perCompanyUnique` + `customers.document` (CPF/CNPJ),
  `inventory_categories lower(name)`, `fabric_rolls lower(code)` (índices criados em SQL).
- Código: buscas por chave que deixou de ser única (`weekStart`, `key`, `date`) usam `findFirst`;
  na etapa 3 a trava do banco garante que só a empresa da requisição aparece. O seed cria a
  empresa 1 primeiro e usa `companyId_key`.
- Testes: `apps/api/test/multi-empresa-banco.test.ts` confere no Postgres o `company_id`
  obrigatório/FK em todas as tabelas, que nenhuma unicidade vale no sistema todo sem motivo, e que
  a numeração e os nomes recomeçam numa segunda empresa.

Pendências anotadas para a etapa 3: travas consultivas (`pg_advisory_xact_lock`) por semana
precisam incluir a empresa na chave; `companySettings.findUnique({ where: { id: 1 } })` passa a
usar a empresa da requisição.

### Ensaio local (2026-11-16)

Banco com todas as migrations até `20270406000000` e os dados do fluxo completo
(`full-flow.test.ts`): 57 tabelas com dados, 756 linhas.

| Verificação                                   | Resultado                                                           |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Tempo da migration                            | 0,25 s                                                              |
| Contagem por tabela antes × depois            | idêntica (só surgiu `company_counters`)                             |
| Linhas com `company_id` diferente de 1        | 0                                                                   |
| Contadores da empresa 1                       | iguais ao maior número de cada tabela (ex.: 17 tarefas de produção) |
| Reversão: contagens                           | idênticas às de antes                                               |
| Reversão: estrutura (`pg_dump --schema-only`) | idêntica à de antes                                                 |

Segundo ensaio (2026-11-16, sobre `e43bc99`, já com Orçamentos): migration em 0,33 s,
contagens idênticas, `company_id` = 1 em tudo, contador de orçamentos da empresa 1 em 10199
(o próximo é o 10200, como antes), reversão com contagens e estrutura idênticas.

Orçamentos: `quote_settings` passa a ter uma linha por empresa (id automático + UNIQUE
`company_id`); `quote_catalog_items` é conteúdo inicial por empresa; `quotes.number` entra na
numeração por empresa (o seed grava o ponto de partida 10199 da empresa 1).

Falta o ensaio com uma cópia do banco de produção, no ambiente de homologação.

## Etapa 3 — isolamento ligado

Migration `20270427000000_multi_empresa_etapa3` (reversão em
`packages/db/rollback/20270427000000_multi_empresa_etapa3.down.sql`). Não mexe em dados.

- **Papel `cenario_app`** (NOLOGIN, sem superusuário, sem BYPASSRLS). A API continua conectando
  com o usuário de sempre, mas toda consulta roda numa transação curta que começa com
  `set_config('role','cenario_app',true)`, `app.company_id` e `app.bypass_rls`
  (`packages/db/src/scoped.ts`). Assim a RLS vale mesmo quando a conexão é de superusuário, como em
  homologação e produção.
- `ensureAppDbRole` roda na inicialização da API: cria o papel se faltar e refaz os GRANTs
  (os backups usam `--no-privileges`; depois de uma restauração a API se conserta sozinha).
- `app_company_id()` não tem mais reserva: sem empresa definida devolve vazio, nenhuma linha
  aparece e nenhuma gravação passa (company_id obrigatório).
- **RLS** com `ENABLE` + `FORCE` em `company_settings` e nas 129 tabelas de empresa/acesso. Política
  única: `company_id = app_company_id() OR app_rls_bypass()`.
- **Código** (`apps/api/src/core/tenant.ts`): cada requisição roda num `AsyncLocalStorage`; a
  autenticação (sessão, tablet, token de aplicativo, login) preenche a empresa do usuário.
  `ctx.prisma` é o cliente da empresa; `ctx.system` (com bypass) só para achar sessão/usuário/token
  antes de saber a empresa, a fila de eventos, o tempo real e a manutenção.
- **Tarefas automáticas** (alertas, liberação da fila, faltas, turnos, riscos de chamados) rodam
  uma vez por empresa (`forEachCompany`). Eventos são processados como a empresa do evento.
- **Tempo real:** cada conexão só recebe eventos da própria empresa (inclusive no replay).
- `companySettings` e `quoteSettings` leem a empresa da requisição (não mais `id: 1`).

Testes: `multi-empresa-banco.test.ts` (sem empresa nada aparece; empresa 2 não vê, não altera, não
apaga e não grava na empresa 1, nem por SQL direto; a API usa `cenario_app`; privilégios refeitos
na inicialização) e `multi-empresa-vazamento.test.ts` (logado na empresa B, as rotas de lista e as
rotas `/:id` não mostram nenhum id da empresa A; controle positivo: a empresa A acha os próprios
dados pelas mesmas rotas).

Riscos conhecidos, sem efeito no isolamento:

- Travas consultivas por semana (`pg_advisory_xact_lock`) ainda usam chaves globais: duas empresas
  fechando a mesma semana ao mesmo tempo esperam uma pela outra (lentidão, não mistura).
- Arquivos em `STORAGE_DIR` não têm prefixo por empresa; o acesso passa sempre pelo registro no
  banco, que está isolado.
- Cada operação virou uma transação curta (mais ~3 comandos por consulta). Medir em homologação.

## Etapa 4 — Criar conta e painel do dono

Migration `20270504000000_multi_empresa_etapa4` (reversão em
`packages/db/rollback/20270504000000_multi_empresa_etapa4.down.sql`, que recusa se houver mais de
uma empresa). Só acrescenta.

- **Criar conta** (`POST /api/auth/signup`, tela `/entrar`): e-mail, senha (mínimo 8) e
  confirmação. Cria uma **empresa nova** ("Minha empresa", o nome se troca em Empresa), o
  conteúdo inicial dela (`packages/db/src/company-content.ts`: funções e permissões, modelos de
  produção gerais e simplificados, checklists de qualidade, locais da oficina) e o usuário como
  **gestor** dessa empresa, e já entra (cookie de sessão na resposta). Tudo numa transação que,
  depois de criar a empresa, passa a valer como ela com a trava do banco ligada.
  - A base de preços do orçamento **não** é copiada da Cenário Estofados; módulos e
    configurações começam nos valores padrão.
  - E-mail já usado: recusado (409), nada é criado. Limite: 5 contas por hora por IP e 40 por
    hora no total.
- **Bloqueio de empresa** (`company_settings.blocked_at`): login recusado, sessões, tablets e
  tokens de aplicativo da empresa deixam de valer na hora (o tablet continua vinculado e volta
  quando liberar); o tempo real encerra as conexões na revalidação periódica.
- **Painel do dono** (`/painel/empresas`, rotas `/api/v1/platform/companies`): só para quem tem
  `empresa.configurar` **na empresa nº 1**; para as outras empresas as rotas respondem 404 e o
  item não aparece no menu. Mostra nome, e-mail do gestor, usuários, criação, último acesso e
  situação; bloquear/liberar fica na auditoria da Cenário Estofados. A empresa 1 não pode ser
  bloqueada.
- `module_settings` passou a ter chave `(company_id, key)` (antes só `key`: a segunda empresa
  não conseguiria ligar/desligar um módulo que a primeira já tivesse mexido). O teste de
  unicidades agora também confere as chaves primárias.
- `lockRow('company_settings', 1)` trocado pela empresa da requisição (módulos, configurações,
  serviços).
- O teste de vazamento cria a empresa B pelo "Criar conta" de verdade.

Testes: `apps/api/test/criar-conta.test.ts`.
