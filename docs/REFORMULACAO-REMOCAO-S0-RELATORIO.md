# Reformulação por remoção real — Etapa S0 (rede de segurança)

Base: plano `docs/REFORMULACAO-REMOCAO-REAL-AUDITORIA-E-PLANO.md` (9e09c81) e as decisões D1–D9
aprovadas. Esta etapa **não muda nenhum comportamento operacional**: só acrescenta testes, scripts
de leitura e este documento. Nenhum deploy, migration, alteração de banco real, conversão ou limpeza.

## 1. Preparação técnica

| Item                  | Valor                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch                | `claude/reformulacao-s0`                                                                                                                                           |
| Base (SHA inicial)    | `0348dcfd8e5fdf9eccfb73e244cfa37af2520653` (ponta da E1, a mesma implantada em homologação)                                                                        |
| Correção isolada (D9) | `29dc333` aplicada como `88382a0` (somente `apps/api/test/rodada4-travas-estruturais.test.ts`, +6/−1)                                                              |
| Estratégia            | Uma etapa por commit, sem migration em S1–S8; cada etapa registra-se em `tests/remocao/etapas-concluidas.json`, o que torna obrigatórios os seus testes do Grupo B |

**F10-01:** com a `29dc333`, a trava estrutural aceita a lista de conferência protegida pela
permissão (`estoque.ver`, `compras.ver` ou `estoque.gerenciar`) da B2. Resultado: 22/22 na suíte
`rodada4-travas-estruturais`. Nada além dessa correção foi trazido de fora da E1.

## 2. Arquivos criados (nenhum arquivo existente foi modificado na S0)

| Arquivo                                             | Função                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tests/remocao/etapas-concluidas.json`              | Lista de etapas concluídas (vazia hoje)                                           |
| `apps/api/test/remocao/catalogo.ts`                 | Catálogo da API: rotas removidas e mantidas, permissões e interruptores por etapa |
| `apps/api/test/remocao-grupo-a.test.ts`             | Grupo A da API (obrigatório)                                                      |
| `apps/api/test/remocao-grupo-b.test.ts`             | Grupo B da API (futuro, `it.fails` até a etapa)                                   |
| `apps/web/test/remocao-catalogo.ts`                 | Catálogo da web: páginas, componentes e trechos de código por etapa               |
| `apps/web/test/remocao-grupo-a.test.ts`             | Grupo A da web (obrigatório)                                                      |
| `apps/web/test/remocao-grupo-b.test.ts`             | Grupo B da web (futuro)                                                           |
| `scripts/remocao/retrato-historico.sql` + `.sh`     | Retrato histórico reproduzível, somente leitura                                   |
| `scripts/remocao/retrato-comparar.py`               | Comparação de retratos antes e depois                                             |
| `scripts/remocao/diagnostico-registros-abertos.sql` | Diagnóstico de registros abertos, somente leitura, com prévia de tratamento       |
| `docs/REFORMULACAO-REMOCAO-S0-RELATORIO.md`         | Este relatório                                                                    |

## 3. Inventário de testes

### Grupo A — regressão obrigatória (passa agora e deve passar em todas as etapas)

| Suíte                            | Testes                              | O que garante                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API `remocao-grupo-a`            | 33 rotas + 1                        | Rotas que ficam continuam existindo (sem sessão respondem 401/403, nunca 404). Abrange clientes, Novo serviço, OS, medidas técnicas da peça (D8), lista simples de materiais, entrega direta e desfazer, estoque simples (D2), mapa da oficina (D7), devoluções (D4), produção no tablet, qualidade, financeiro, fechamento, produtividade, linha do tempo e auditoria. Inclui também as 13 permissões mantidas no catálogo |
| API `remocao-grupo-b` (controle) | 1                                   | Bloqueios legítimos continuam: DEPENDENCIAS, SEM_RESPONSAVEL, NAO_PUBLICADA, BLOQUEIO                                                                                                                                                                                                                                                                                                                                       |
| Web `remocao-grupo-a`            | 10 páginas + 6 componentes + 1 menu | Páginas, componentes e itens de menu mantidos existem                                                                                                                                                                                                                                                                                                                                                                       |
| Suítes existentes                | todas                               | Comportamento detalhado (entrega direta, devoluções, estoque simples, financeiro, produção…)                                                                                                                                                                                                                                                                                                                                |

### Grupo B — requisitos futuros (`it.fails` até a etapa ser registrada)

| Etapa                                                   | API                                                                                                                   | Web                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| S1 Embalagem                                            | rotas `packaging` e `rollback-readiness` → 404; interruptor `embalagem` fora; `READINESS_CHECKS` sem EMBALAGEM        | trechos `PackagingPanel`, `usePackaging` e `/api/v1/packaging` ausentes     |
| S2 Travas de materiais                                  | rotas de prontidão e vínculo de materiais → 404; interruptor `materiais` fora; sem bloqueio MATERIAIS                 | `/painel/prontidao` fora; `readiness-page` ausente; `materialsGate` ausente |
| S3 Medições                                             | rotas de medições, previsões e planejamento → 404; `medicoes.*` e `materiais.*` fora                                  | 3 páginas, 2 componentes e trechos ausentes                                 |
| S4 Compras, fornecedores, recebimento formal e reservas | rotas → 404; `compras.*`, `estoque.conferir` e `estoque.autorizar` fora                                               | 4 páginas, 4 componentes e trechos ausentes                                 |
| S5 OS no fechamento (D1)                                | rotas de recebimentos → 404; `recebimentos.registrar` fora; sem PECA_NAO_RECEBIDA; **Novo serviço cria a OS na hora** | `/painel/recebimentos` e 3 componentes ausentes                             |
| S6 Logística                                            | rotas → 404; `retiradas.*` e `logistica.executar` fora; interruptor `logistica` fora                                  | 3 páginas, 5 componentes e trechos ausentes                                 |
| S7 Interruptores e pedidos de ajuda (D3)                | `/api/v1/modules`, `/api/company/modules` e `help-requests` → 404; `ajuda.solicitar` fora; interruptor `ajuda` fora   | `/painel/ajuda`, componentes de ajuda, `useModules` ausentes                |

Total do Grupo B: 20 testes na API e 19 na web.

## 4. Resultados da regressão

| Verificação                                                                   | Resultado                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| API: Grupos A e B                                                             | 35 aprovados, 20 falhas esperadas                                                                                                           |
| Web: `vitest --dir test` (6 arquivos)                                         | 43 aprovados, 19 falhas esperadas                                                                                                           |
| Prova do Grupo B (todas as etapas marcadas como concluídas, depois revertido) | API: 20 de 20 falham pelos motivos certos (70 rotas ainda respondem 401; a OS não nasce no fechamento: 0 OS após 201). Web: 19 de 19 falham |
| Suíte completa (shared, web, API)                                             | **verde**, ver §4.1                                                                                                                         |
| `pnpm lint`                                                                   | ok                                                                                                                                          |
| `pnpm typecheck`                                                              | ok                                                                                                                                          |
| `pnpm format:check`                                                           | Único aviso em `docs/E1-MATERIAIS-RELATORIO.md`, que já vem da base E1 (0348dcf) e não é tocado pela S0                                     |

### 4.1 Suíte completa

| Pacote            | Arquivos                | Testes                                                    |
| ----------------- | ----------------------- | --------------------------------------------------------- |
| `packages/shared` | 22 aprovados            | 151 aprovados                                             |
| `apps/web`        | 6 aprovados             | 43 aprovados, 19 falhas esperadas (Grupo B)               |
| `apps/api`        | 93 aprovados, 7 pulados | 1062 aprovados, 20 falhas esperadas (Grupo B), 13 pulados |

Os 7 arquivos pulados são opcionais e independentes da S0: desempenho (`*-perf`) e proxy Caddy
(`proxy-caddy*`). A API levou 2118 s. Nenhuma suíte existente quebrou.

## 5. Mecanismo de comparação do histórico

1. `DATABASE_URL=… bash scripts/remocao/retrato-historico.sh antes.txt` roda dentro de
   `BEGIN TRANSACTION READ ONLY … ROLLBACK`, sem tabelas temporárias e sem dados pessoais. Grava:
   - linhas por tabela;
   - soma de toda coluna `*_cents`;
   - contagem por situação (`status`, `kind`, `origin`, `category`, `due_trigger` e
     `fulfillment_stage`);
   - órfãos de toda FK de coluna única;
   - número de migrations aplicadas.
2. Depois de cada etapa, o mesmo comando grava `depois.txt`.
3. `python3 -I scripts/remocao/retrato-comparar.py antes.txt depois.txt` aponta **violação** (código
   de saída 1) em quatro casos:
   - tabela sumiu ou perdeu linhas;
   - soma em dinheiro diminuiu;
   - soma em dinheiro mudou em uma das tabelas de histórico fixo: custos logísticos, alocações e
     ajustes, itens de pedido de compra, linhas de recebimento, movimentos de estoque, fechamentos e
     partes de pagamento;
   - contagem por situação diminuiu, ou surgiu um órfão.

   Crescimento conta como aviso. `--permitir t1,t2` documenta uma exceção aprovada.

Validação feita em bancos isolados:

- **Reprodutível:** dois retratos seguidos do mesmo banco dão "HISTÓRICO PRESERVADO".
- **Sensível:** numa cópia descartável (`cenario_s0_viol`), apagar uma linha de `role_permissions`
  deu "VIOLAÇÕES: role_permissions 81 → 80", com código 1. A cópia foi apagada em seguida.
- **Abrangência:** 469 medidas, 126 tabelas e 304 FKs verificadas.

## 6. Diagnóstico de registros abertos

`scripts/remocao/diagnostico-registros-abertos.sql` é somente leitura. Para cada grupo (retiradas,
entregas de logística, ocorrências, custos logísticos previstos, contas a pagar de logística,
cobranças com gatilho RETIRADA/ENTREGA, pedidos de compra, chegadas, reservas, medições,
solicitações e necessidades de material, embalagem, tarefas bloqueadas por MATERIAIS ou
PECA_NAO_RECEBIDA, pedidos sem OS, pedidos de ajuda e interruptores gravados), ele mostra a
quantidade aberta e a **prévia do tratamento** proposto para a S9. Ele **não altera nada**.

- **Executado** no banco isolado `cenario_s0` (migrado e com a semente): 0 em todos os grupos.
- **Não executado em dados reais.** A S0 não trouxe autorização específica de leitura da
  homologação, e o executor da homologação não tem operação de SQL de leitura livre (só
  `database_counts` e `database_fingerprint`).
- Para rodá-lo na homologação, há dois caminhos, ambos só com sua autorização:
  - você roda `psql -X -v ON_ERROR_STOP=1 -f scripts/remocao/diagnostico-registros-abertos.sql`
    com um usuário de leitura;
  - uma operação somente leitura nova é incluída no executor numa etapa autorizada.
- **D5:** as cobranças RETIRADA/ENTREGA abertas só são **contadas**. Nenhuma data de vencimento foi
  inventada nem convertida.
- **D6:** a rotina de tratamento só é proposta e não foi executada.

## 7. Matriz de rastreabilidade S1–S10

| Etapa                                        | Comportamento atual                                                                                                      | Comportamento esperado                                                                                                                    | Arquivos principais                                                                                                                                                      | Testes (B → obrigatório)                                                                              | Dependências                          | Riscos                                                                                                             | Critério de conclusão                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **S1 Embalagem**                             | Estágios AGUARDANDO_EMBALAGEM/EM_EMBALAGEM, tarefa EMBALAGEM, interruptor `embalagem`, `rollback-readiness`              | Aprovação vai direto a "pronta para entrega"                                                                                              | `modules/quality/routes.ts` (packaging), `modules/management/rollback-readiness.ts`, `packages/shared` (READINESS_CHECKS), aba e tablet na web                           | API S1 (rotas, interruptor, READINESS_CHECKS); web S1 (trechos)                                       | —                                     | Peças paradas em embalagem (S9); mão de obra de embalagem antiga                                                   | Grupo B S1 verde; Grupo A verde; retrato sem violação |
| **S2 Travas de materiais**                   | Bloqueio MATERIAIS, prontidão, caixa "exige materiais", interruptor `materiais` (E1)                                     | Tarefa inicia sem compra, medição ou recebimento; lista simples continua                                                                  | `modules/production` (liberação), `modules/purchasing/leftovers.ts` (prontidão), `modules/os-materials` (vínculo), `/painel/prontidao`                                   | API S2 (rotas, interruptor, sem MATERIAIS); web S2                                                    | S1 (interruptores convivem até S7)    | Remover junto a lista simples (protegida pelo Grupo A)                                                             | idem                                                  |
| **S3 Medições**                              | Módulo de medições, solicitações, aprovações, previsões, planejamento de sexta                                           | **Medidas técnicas opcionais na peça ficam (D8)**; módulo formal sai                                                                      | `modules/measurements`, `modules/materials`, `modules/purchasing/forecasts.ts`, páginas medições/planejamento/materiais                                                  | API S3; web S3; Grupo A protege `PUT …/items/:itemId/measurements`                                    | S2                                    | Histórico de medição na linha do tempo (retrato)                                                                   | idem                                                  |
| **S4 Compras e afins (D2)**                  | Compras, aprovações, pedidos, fornecedores, recebimento formal, estoque formal, reservas, sobras                         | **Estoque simples fica**: cadastro, saldo, entradas e saídas, histórico, vínculo opcional à OS; nunca impede a OS                         | `modules/purchasing` (pedidos, fornecedores, recebimentos, estoque formal, reservas, sobras); `modules/inventory` FICA; páginas compras/fornecedores/recebimento/estoque | API S4; web S4; Grupo A protege `inventory/*`, `estoque.ver` e `estoque.gerenciar`                    | S2, S3                                | Custos de compra antigos e movimentos de estoque (histórico fixo no retrato); possível extensão do estoque simples | idem + resultado por OS igual                         |
| **S5 OS no fechamento (D1)**                 | OS nasce só na chegada da peça; PECA_NAO_RECEBIDA bloqueia; recebimentos formais e correção de recebimento               | Fechou o serviço → OS na hora; chegada opcional e não bloqueante; módulo de recebimentos eliminado; **devoluções pós-entrega ficam (D4)** | `modules/services`, `modules/receipts`, `modules/arrivals`, `modules/production` (liberação), tablet de chegadas                                                         | API S5 (rotas, permissão, sem PECA_NAO_RECEBIDA, OS no fechamento); web S5; Grupo A protege `returns` | S2                                    | Pedidos antigos sem OS (S9); limite "pelo recebido"                                                                | idem + fluxo do §8.5 do plano                         |
| **S6 Logística**                             | Retiradas, entregas agendadas, roteiro, ocorrências, equipe própria, custos de viagem, gatilho RETIRADA                  | Só "marcar como entregue" na OS (entrega direta) e desfazer                                                                               | `modules/pickups`, `modules/quality` (route, shipping: entregas, roteiro, custos de viagem), `modules/orders` (custos de viagem), páginas e tablet de logística          | API S6; web S6; Grupo A protege `direct-delivery`, `deliver` e `revert`                               | S5                                    | Custos logísticos e contas a pagar antigas (histórico fixo); cobranças RETIRADA (D5)                               | idem + fechamento confere sem viagem                  |
| **S7 Interruptores e pedidos de ajuda (D3)** | Sistema de módulos, tela Funcionalidades, pedidos de ajuda (botões, telas, notificações, interruptor, rotas e permissão) | Sem interruptores; ajuda removida por completo; histórico de ajuda preservado                                                             | `modules/company` (interruptores), `modules/help`, `packages/shared` (MODULE_KEYS, permissões), seed, `components/help`, tablet de ajuda                                 | API S7 (módulos, ajuda, `ajuda.solicitar`, interruptor `ajuda`); web S7                               | S1–S6 (o último interruptor sai aqui) | Usuários com permissões antigas gravadas precisam entrar normalmente                                               | idem + login com permissões antigas                   |
| **S8 Central de atenção, Hoje e avisos**     | Itens e avisos apontando para processos removidos                                                                        | Nenhum aviso ou link para processo removido                                                                                               | `modules/management`, `modules/deadlines`, `modules/notifications`, painel "Hoje" na web                                                                                 | Novos testes a escrever no início da S8 (o catálogo S8 ainda está vazio)                              | S1–S7                                 | Avisos úteis removidos por engano                                                                                  | Auditoria de links + Grupo A                          |
| **S9 Dados abertos (D5/D6)**                 | Registros abertos de processos removidos                                                                                 | Rotina única, auditada e idempotente: muda situação, nunca apaga; D5 só com a regra aprovada                                              | `scripts/remocao/diagnostico-registros-abertos.sql` (prévia); rotina a escrever                                                                                          | Retrato antes e depois sem violação (exceto as permitidas e aprovadas)                                | S1–S8; **autorização específica**     | Dados reais; datas de vencimento (não inventar)                                                                    | Contagens antes e depois aprovadas                    |
| **S10 Regressão e homologação**              | —                                                                                                                        | Suítes completas, E2E, navegação por perfil, deploy em homologação                                                                        | todos                                                                                                                                                                    | Grupos A e B 100% obrigatórios; `etapas-concluidas.json` com S1–S8                                    | S1–S9; **autorização de deploy**      | Retorno religa processos (H9)                                                                                      | Critérios do §8 do plano                              |

## 8. Riscos

1. **Testes de rota por "sem sessão".** O 401 prova que a rota existe, mas não o comportamento. O
   comportamento é coberto pelas suítes existentes, que precisam continuar verdes em cada etapa.
2. **Trechos proibidos são buscados por texto.** Uma chamada montada dinamicamente poderia escapar.
   A auditoria de navegação da S10 complementa.
3. **O retrato só foi validado em banco com a semente**, sem histórico real. A primeira leitura
   da homologação (com autorização) é a linha de base de verdade.
4. **Diagnóstico de dados reais pendente** (§6).
5. **Retorno de versão religa processos** (risco H9 do plano). Isso continua valendo em todas as
   etapas.

## 9. Confirmações

- Homologação e produção **não foram acessadas** nesta etapa: nenhuma operação do executor,
  nenhum deploy e nenhuma consulta.
- Sem migrations, sem alteração de bancos existentes, sem conversões, sem encerramento de registros
  e sem limpeza. Escritas só nos bancos locais isolados `cenario_test`, `cenario_s0` e
  `cenario_s0_viol` (descartável, já apagado).
- Nenhuma funcionalidade foi alterada para fazer testes futuros passarem.
- Sem merge e sem PR; a branch padrão não foi alterada.

## 10. GO/NO-GO para S1

**GO técnico para S1**, sujeito à sua aprovação:

- a rede de segurança está ativa: o Grupo A protege o que fica, e o Grupo B da S1 tem 3 testes na
  API e 1 na web, todos falhando hoje pelos motivos certos;
- a regressão completa está verde;
- o retrato e o comparador estão validados.

**Ressalva:** a linha de base do retrato com dados reais, e o diagnóstico na homologação, dependem
de autorização de leitura. Não bloqueiam a S1, que não mexe em dados, mas devem existir antes da S9.
