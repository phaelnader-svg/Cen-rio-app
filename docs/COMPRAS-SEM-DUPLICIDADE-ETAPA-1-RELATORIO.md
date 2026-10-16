# Compras e materiais sem duplicidade: Etapa 1

Data: 2026-10-16. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Produção fora do escopo e não tocada.

**Classificação: GO WITH CAVEATS.**

## Versões e CI

| Item                     | Valor                                                                     |
| ------------------------ | ------------------------------------------------------------------------- |
| SHA inicial (base)       | `b4d709c` (aplicação `03ab53b`, homologada)                               |
| Implementação            | `eb8a094`. CI nº 127 **vermelho**, só por tipagem no teste E2E novo       |
| Candidato final          | `56192c1`. CI nº 128 **verde**                                            |
| Versão ativa homologação | **`56192c1`**                                                             |
| Imagens                  | api `sha256:be194021a9b6…`, web `sha256:03d25bc234a0…` (build `bc6a60f0`) |

**Histórico**

- `eb8a094`: implementação original da Etapa 1. A suíte completa da API passou localmente (553 aprovados,
  10 ignorados, 0 falhas). O CI nº 127 falhou no typecheck do pacote e2e por causa de um
  `Object is possibly 'undefined'` no spec novo.
- `56192c1`: as mesmas mudanças de aplicação, mais exclusivamente duas correções do teste:
  1. a data da medição no E2E passou a cair na sexta-feira configurada, como exige a regra existente;
  2. a tipagem não nula no spec foi corrigida.
- Nenhuma correção de código de produção foi feita por causa dessas falhas.

## Migrations

**Zero migrations novas.** A imagem tem 25, o banco tem 25 aplicadas e há 0 pendentes. A última continua
sendo `20261230000000_modelos_simplificados`.

As decisões de recusa (V4) ficam no histórico existente do pedido de compra (`purchase_order_history`,
tipos `RECUSA_REPOR` e `RECUSA_NAO_REPOR`).

## Regra final (fonte única)

A regra fica em `packages/shared` (`requirementCoverage`). A API calcula com `requirementsWithProgress`,
e lista, consolidado, prontidão, aba da OS, Central e Prazos usam o mesmo cálculo.

**Fórmulas por necessidade**

```
coberto     = exclusivo ? recebido + sobra transferida
                        : reservado + entregue + sobra transferida    (até a necessidade)
aguardando  = confirmado (menos encerrado/não reposto) − recebido     (até a necessidade − coberto)
rascunho    = rascunho                                                 (até o que resta)
falta       = necessidade − coberto − aguardando − rascunho
```

**Regras de contagem**

- Recebido e saldo esperado de um item são repartidos entre as OS na ordem em que foram incluídos (FIFO).
- A quantidade do item limita também o rascunho.
- Recebido de estoque que virou reserva conta como reservado e nunca também como "em compra".
- Recebido de estoque ainda não reservado é estoque livre: não cobre a OS.

**Sugestão de compra (estoque)**

```
sugestão = Σ falta − estoque livre − compra de estoque pendente sem destino
```

- Estoque livre = saldo − reservas ativas de todas as OS.
- Para exclusivo, a sugestão é igual à falta.

## E1–E4

| Defeito                     | Correção                                                                  | Contraprova                             |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| E1 estoque livre ignorado   | Livre e compra de estoque pendente descontam a sugestão; nada é reservado | Exemplo 15/8/4: sugestão 3 (antes 11)   |
| E2 `max(pipeline, reserva)` | Soma sem dupla contagem; o servidor recusa comprar acima da falta líquida | Reserva 8 + compra 2: falta 0 (antes 2) |
| E3 reserva sem vínculo      | Atribuída pela especificação do catálogo às necessidades da mesma OS      | Falta 2 (antes 10)                      |
| E4 sem consolidação         | "A comprar" agrupa por especificação, com cada OS abaixo                  | Duas OS numa só linha                   |

## "Não precisa comprar" ≠ "reservado"

Quando o estoque livre zera a sugestão de compra, o material **não é reservado**.

- A linha da OS continua com falta.
- A interface diz "O estoque livre ainda não está reservado para nenhuma OS" e mostra **Reservar**.
- A prontidão e o bloqueio de MATERIAIS da produção usam a cobertura real (reservado). Por isso a produção
  não é liberada só porque a sugestão zerou.

## Outras regras

- **Sobra (V2):** aparece como "Sobra disponível — conferir compatibilidade" e não desconta nada. A
  transferência continua sendo a ação existente, com autorização.
- **Recusa (V4):** não há escolha pré-marcada.
  - REPOR mantém o saldo aguardando.
  - NÃO REPOR encerra só a quantidade recusada (até o pendente), que volta para "A comprar". O que já foi
    recebido é preservado.
  - Só quem tem `compras.aprovar` decide.
- **OS cancelada (V8):** a compra fica marcada como "sem destino". Nada é cancelado nem redistribuído.
- **Reserva esquecida (V5):** uma reserva ativa em OS entregue gera aviso em Estoque → Reservas, na aba
  Materiais da OS e no Resultado por OS. Nada é consumido automaticamente; o aviso some ao entregar à OS
  ou ao liberar a reserva.
- **Sem preço:** o lançamento aparece como "sem preço", e não como R$ 0.
- **CSV de custos:** sincroniza a razão antes de agregar.
- **Prontidão:** `refreshReadiness` reavalia tarefas e ocorrências de material mesmo quando a situação
  geral da OS não muda. O motivo MATERIAIS sai do risco de prazo quando a cobertura é resolvida.
- **Telas:**
  - "A comprar" (`/painel/compras`) tem filtros Falta comprar, Aguardando chegada e Bloqueia produção.
  - `/materiais` saiu do menu e virou lista bruta para CSV.
  - "Prever material" explica que não gera compra.

## Testes

- **API nova** (`compras-sem-duplicidade.test.ts`): 21 testes, cobrindo os 27 itens e as contraprovas de
  E1–E4.
- **API completa:** 553 aprovados, 10 ignorados, 0 falhas.
- **Unidade (shared):** 109 testes.
- **E2E completo local:** 40/40, incluindo `compras-sem-duplicidade.spec.ts`. O spec cobre o consolidado
  com estoque livre, o Reservar explícito e o "Não repor".
- **Qualidade:** lint, typecheck e format OK. CI nº 128 verde.

## Homologação (autonomia, runner 2.1.1)

1. **Estado inicial:**
   - versão `03ab53b`, portão fechado, cinco contêineres saudáveis, disco 62%;
   - impressão digital com 3.805 linhas, sha256 `21f0d5721a530035…`.
2. **Build pelo gatilho** (tag `56192c1`): SUCCESS.
3. **Preparação e pré-checagem:**
   1. `gate_open`;
   2. `prepare_version`;
   3. `migration_precheck`: OK, com 25/25 e 0 pendentes.
4. **Proteção do banco:**
   1. `maintenance_on`;
   2. `recovery_point_create` `cenario-staging-20261016T024400Z`: restauração de teste idêntica, envio ao
      bucket feito;
   3. `backup_validate`: OK.
5. **Migração:** `migrate` respondeu "Database schema is up to date!", ou seja, **0 aplicadas**.
6. **Ativação:** `activate_version 56192c1` (Saúde OK), depois `gate_close`.

**Depois da ativação**

- **Versão:** drop-in, pilha, candidata e migrada em `56192c1`; os contêineres usam os digests do build.
- **Checagens:**
  - `migration_verify` 25/25;
  - health OK;
  - smoke (`vm.sh saude`) OK;
  - WebSocket 401 sem sessão (esperado);
  - suítes acesso e websocket ✔.
- **Logs:**
  - API com 25 linhas `info` e nenhum erro;
  - web sem erros;
  - Postgres só com checkpoints do ponto de recuperação;
  - Caddy sem 5xx.
- **Impressão digital idêntica** antes e depois (3.805 linhas, `21f0d5721a530035…`): nada foi gravado.
- **Limpeza:**
  - `images_cleanup` removeu `c239e84` e recuperou 2,11 GiB (disco 74% → 63%);
  - `56192c1` e `03ab53b` ficaram protegidas.

## Ressalvas

1. **Fluxos funcionais não clicados na homologação:** o runner não tem login da aplicação, por desenho, e
   nada foi criado para contornar isso. A validação funcional vem do CI nº 128 e do E2E 40/40 sobre o
   mesmo commit, cujas imagens são as ativas.
2. **Rótulo da prontidão com estoque livre:** quando o estoque livre cobre a falta mas ainda não foi
   reservado, a prontidão mostra "Aguardando compra" (cobertura real = 0). A "A comprar" mostra sugestão 0
   e a ação Reservar. Isso é coerente com a cobertura, mas o rótulo não diz "aguardando reserva".
3. **Decisão de recusa sem campo próprio:** a decisão fica no histórico do pedido, para não exigir
   migration.
4. **Fora desta etapa, como decidido:**
   - Etapa 2 (nova medição substitui; devolução cancela a necessidade);
   - compra antecipada (Etapa 3);
   - Cobrança.
     D9, prazos e D11 não foram alterados.
