# Saneamento funcional — 4 correções pontuais

Data: 2026-10-15. Referência homologada: `406fde7` (aplicação). SHA inicial do ramo: `057c892` (só infra/docs
depois de `406fde7`). Código da rodada: `c239e84`. Produção fora do escopo e não tocada.

Esta rodada não é fase nova: nada de cobrança, compras, capacidade, orçamento, menus, infraestrutura ou
runner. **Nenhuma migration.**

## 1. Tipo de serviço por peça (Novo serviço)

**Causa raiz.** A API já aceitava e gravava `serviceType` por item (`newServiceItemSchema`, `createOrder`,
OS automática na chegada). A tela tinha um único seletor "Tipo de serviço" e mandava o mesmo valor em todas as
peças. A escolha do modelo de produção (`selectProductionTemplate`) usa o tipo da peça, então peças de tipos
diferentes recebiam o modelo errado.

**Correção (só tela).** `apps/web/components/commercial/new-service-page.tsx`:

- seletor "Tipo de serviço" em cada peça (`ns-piece-service-<n>`);
- a peça nova herda o tipo da anterior;
- o resumo lista "quantidade × peça — tipo";
- a descrição padrão do serviço junta os tipos distintos ("Reforma completa + Troca de tecido").

Registros antigos, atomicidade e idempotência não mudam (mesma rota).

**"Novo pedido" (legado).** O pedido cria a OS manualmente, e o tipo é escolhido por item da OS. Sem
corrupção, nada alterado.

## 2. `analyzeAbsence` (ausência)

**Causa raiz.** Na fila semanal as tarefas não têm horário (`scheduledAt = null`). A consulta incluía
`scheduledAt: null` sem outro filtro: a fila inteira da pessoa, de todas as semanas. Na ausência confirmada,
isso:

- reatribuía automaticamente todo apoio simples;
- montava a proposta "Reprogramar" (ADIAR) para todas as tarefas, dando horário a tarefas de fila.

**Correção** (`apps/api/src/modules/help/reschedule.ts`). Entra só o que dependia da pessoa no dia:

- tarefas com horário até o fim do dia (agenda, correção, embalagem, apoio de ajuda): regra inalterada;
- na fila, a tarefa em destaque (atual ou próxima executável — a mesma que o tablet mostra);
- tarefas sem horário com prazo interno até hoje.

O resto da fila continua na ordem, com a pessoa.

## 3. Prioridade e prazo (OS × planejamento)

**Fontes da verdade:**

| Dado                   | Fonte                                             |
| ---------------------- | ------------------------------------------------- |
| Prazo prometido        | só a OS (lido ao vivo), sem cópia no planejamento |
| Prioridade operacional | **OS**                                            |
| Posição na fila        | `queuePosition`, D9 + ordem manual                |
| Data inicial           | item do planejamento                              |

**Causa raiz.** A prioridade existia na OS, no item do planejamento e na tarefa, com três caminhos de escrita
independentes: mudava num lugar e o outro ficava diferente sem aviso.

**Correção.** Uma regra (`production/service-priority.ts`) aplicada em todas as entradas:

- edição da OS;
- planejar (`plan-services`);
- incluir OS na semana;
- reprogramar (mesma semana / outra semana);
- item do planejamento.

A mudança vale na OS, nos itens e nas tarefas **não iniciadas**. No modo fila só a própria OS é reposicionada
(D9). A ordem manual das outras é preservada. O prazo prometido não reordena nada.

Programação publicada exige motivo e gera revisão. Dados antigos divergentes só se alinham numa mudança
explícita (nada é reescrito sozinho). Os campos da tela dizem que a prioridade é do serviço.

## 4. Confirmar viagem sem custo

**Causa raiz.** A rota `POST /api/v1/finance/trip-costs/free` existia, com permissão, idempotência e
auditoria, mas sem tela. A pendência "custo não informado" bloqueava a conferência da semana.

**Correção:**

- botão "Confirmar viagem sem custo" na própria pendência, só para quem tem `financeiro.gerenciar`;
- diálogo "Confirma que esta viagem não teve custo? Ela será registrada com valor de R$ 0.", com motivo
  obrigatório;
- a tela se atualiza.

Repetição devolve 409 "Esta viagem já foi confirmada como sem custo." A corrida simultânea segue barrada pelo
índice único (409). Quem pode ver valores não mudou.

## Testes

- `apps/api/test/saneamento.test.ts`: 19 testes, nas seções A–D, incluindo regressão D9 explícita.
  Contraprova: com o código anterior, 10 deles falham. A seção A passa nos dois, porque a API já estava correta.
- E2E:
  - `novo-servico.spec.ts`: tipos diferentes por peça, até a OS;
  - `team-closing.spec.ts`: botão, confirmação, atualização da tela, repetição 409.

## CI

**CI nº 122** (run 38786937417) sobre `c239e84`: **verde**. Passaram:

- `pnpm audit`, format, lint, typecheck;
- migrations do zero, com `migrate diff` sem divergência;
- build;
- `pnpm test` (API, shared e web, inclusive o proxy Caddy real);
- `pnpm test:backup`;
- E2E Playwright.

Local:

- API: 521 aprovados, 10 ignorados, 0 falhas;
- shared: 87; web: 6;
- E2E: 38/38 após corrigir o próprio teste (botão desabilitado sem motivo).

## Homologação (`cenario-homolog`, autonomia do runner 2.1.1)

Tudo pelo `claude-operador` com operações nomeadas: sem SSH, sem Cloud Shell, sem infraestrutura nova.

**Build** pelo gatilho (Pub/Sub → `cenario-homolog-build-autonomo`, conta `cenario-build`):

| Item        | Valor                                                                      |
| ----------- | -------------------------------------------------------------------------- |
| Build       | `15f61be9-645f-4e1b-83e4-faa6a794e35a` — SUCCESS (18:36:18 → 18:41:09 UTC) |
| api:c239e84 | `sha256:4ebdada740100a23c9bce113884db262cabe85a1d5ba1c96e6da3389e77f47c8`  |
| web:c239e84 | `sha256:684203f8dd25738bfbe6caa5e01bafc4a30a0c50daa7b5af0850b5344ca826cd`  |

**Sequência:**

1. Estado inicial, somente leitura: ativa/candidata/migrada `406fde7`; 25 migrations; 5 contêineres
   saudáveis; disco 61% (7,3 GB livres); portão fechado; impressão `f82f4c4f…`.
2. `gate_open`.
3. `prepare_version c239e84`: imagens com os digests acima; a imagem não migra na partida.
4. **`migration_precheck version=c239e84`: OK.** Imagem 25 · banco 25 · **0 pendentes**. Nenhuma migration
   nova nesta rodada.
5. Somente depois do CI nº 122 verde:
   1. `maintenance_on` (19:03:40);
   2. `recovery_point_create`: `cenario-staging-20261015T190346Z`; restauração de teste **idêntica**; cópia
      fora da VM; impressão `f82f4c4f…`, igual à inicial;
   3. `backup_validate`: SHA256SUMS conferido.
6. `migrate c239e84`: banco idêntico ao ponto, preflight OK, "Database schema is up to date!" →
   **0 migrations aplicadas**.
7. `activate_version c239e84`: api e web recriadas, `healthy`.
8. `gate_close`: portão fechado.

**Validação depois da ativação:**

- `version`: drop-in, pilha, candidata e migrada = **`c239e84`**.
- Os contêineres usam exatamente as imagens `4ebdada7…` (api) e `684203f8…` (web) do build acima.
- `406fde7` fica guardada como versão do ponto de recuperação.
- Contêineres: api, web e postgres `healthy`; caddy e backup em execução.
- `migration_verify`: **25/25**, 0 pendentes.
- `health`, `smoke_test`: Saúde OK.
  - `/api/ready` 200; proxy 401 + Basic; `/entrar` 200; JS 200;
  - sem HTTP/3; certificado com 83 dias;
  - disco 73%; memória 1 GB.
- `websocket_test`: 401 sem sessão (encaminhamento até a API OK).
- `run_homologation_tests suite=completo`: saude ✔, acesso ✔, websocket ✔.
- Logs dos últimos 20 min:
  - API: 26 linhas, todas `info`;
  - web e postgres: sem erros;
  - Caddy: 200/307/401/101, **nenhum 5xx**.
- Impressão digital depois: **esquema idêntico**. Só mudou o conteúdo de 3 tabelas operacionais:
  - `devices` e `sessions`: mesma quantidade de linhas;
  - `domain_events`: 442 → 443;
  - causa: sessão real de tablet encerrada na manutenção (Caddy `101`) e nova partida da API.
  - Nenhuma tabela de negócio ou financeira mudou.
- Nenhum dado sintético foi criado.

**Ressalva (caveat).** Os quatro fluxos funcionais não puderam ser clicados direto na homologação:

- Novo serviço com tipos por peça;
- ausência;
- prioridade/D9;
- viagem sem custo.

O runner não tem login da aplicação, por desenho; nenhuma credencial, infraestrutura ou desvio foi criado para
contornar isso. A validação funcional vem do CI nº 122 (API + E2E) executado sobre o **mesmo commit**
`c239e84`, cujas imagens são as ativas.

**Classificação: GO WITH CAVEATS.**

## Pendências reais (não implementadas)

- Ausência presumida (9h30) no modo fila: `detectImpacts` não conta a tarefa liberada em destaque e mostra
  "nenhuma tarefa afetada". Inconsistência anterior, sem efeito em massa.
- Pedido editado com peça nova de OS automática: item sem tipo → OS com `OUTRO` (modelo geral). Corrigível na
  OS (o tipo do item da OS é editável).
- OS de chegadas parciais posteriores copiam o prazo do pedido, não o da OS editada. Decisão de negócio.
- Reprogramação também muda a prioridade de tarefas de correção da OS. Comportamento anterior mantido.
- Sobreposição por tarefa (prioridade de uma tarefa na tela da semana) continua existindo.
- `tripCostInclude.allocations` sem `orderBy`: a ordem do rateio exibida pode variar. Teste
  `logistics-costs` nº 8 falhou 1× em execução local combinada; passou isolado e na suíte completa.
