# Prazos e serviços em risco — relatório

Data: 2026-10-15. Ramo `claude/cenario-gestao-fase-1-zf3bj2`. Produção fora do escopo e não tocada.

**Classificação: GO WITH CAVEATS.**

## Versões

| Item                        | Valor                                         |
| --------------------------- | --------------------------------------------- |
| SHA inicial                 | `bfd52ab` (aplicação = `c239e84`, homologada) |
| Código da fase              | `03ab53b`                                     |
| CI                          | nº 125, verde                                 |
| Versão ativa em homologação | **`03ab53b`**                                 |

## Modelo final de estados (regra única)

A regra fica em `packages/shared/src/deadline-domain.ts` e é pura. A API coleta os fatos gravados em lote
(`apps/api/src/modules/deadlines/service.ts`). Lista e detalhe da OS, Central e Início usam a mesma função; a
tela não recalcula nada.

| Estado    | Condição                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ENCERRADA | OS cancelada, ou nenhuma peça ativa (fora DEVOLVIDA/CANCELADA) por entregar                                                                                                          |
| SEM_PRAZO | Sem prazo prometido. Dados antigos continuam válidos e nunca viram atrasados; sem backfill                                                                                           |
| ATRASADO  | Prazo < hoje da empresa e peça ativa não entregue. **Crítico**, com ou sem motivo; os motivos e a causa conhecida aparecem como contexto (ex.: "Cliente indisponível para entrega.") |
| EM_RISCO  | Prazo entre hoje e o 5º dia útil, inclusive, e ao menos um motivo objetivo                                                                                                           |
| PROXIMO   | Mesma janela, sem motivo. Rótulo discreto na OS; fora da Central; sem notificação                                                                                                    |
| NO_PRAZO  | Além da janela                                                                                                                                                                       |

Motivos de risco:

| Motivo                  | Quando conta                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| NAO_PLANEJADA           | Peça em produção sem item de planejamento nem tarefa                                                                            |
| PRODUCAO_NAO_INICIADA   | Planejada, mas nenhuma tarefa iniciada                                                                                          |
| BLOQUEADA               | Bloqueio MATERIAIS, OCORRÊNCIA, BLOQUEIO ou SEM_RESPONSÁVEL; pausa por impedimento; peça em bloqueio de expedição               |
| MATERIAIS               | Situação gravada dos materiais: aguardando compra, aguardando recebimento, parcial ou com divergência — só com peça em produção |
| EM_CORRECAO             | Peça em correção                                                                                                                |
| PRONTA_SEM_ENTREGA      | Peça pronta, sem entrega agendada                                                                                               |
| ENTREGA_DEPOIS_DO_PRAZO | Entrega agendada para depois do prazo                                                                                           |
| ENTREGA_FRUSTRADA       | Entrega frustrada ainda não reagendada                                                                                          |

Não há duração estimada nem previsão matemática.

## Regra dos 5 dias úteis

- Janela fixa: de hoje até o 5º dia útil seguinte, inclusive.
- Dias úteis = os dias de trabalho já configurados na empresa (`company_settings.working_days`).
- "Hoje" no fuso da empresa (relógio operacional).
- Sem configuração nova e sem segundo calendário.

## Central de atenção

A arquitetura continua derivada: nada é gravado e não há Central paralela.

**PRAZO_OS** (chave `PRAZO_OS:<os>`)

- No máximo um item por OS, só para ATRASADO (crítico) ou EM_RISCO (ação); os motivos ficam dentro do item.
- Convive com os itens de QUALIDADE e LOGÍSTICA. Para correção, peça pronta e entrega frustrada, a ação não
  se repete no item de prazo: ela fica no item específico.

**PRAZO_PEDIDO** (chave `PRAZO_PEDIDO:<pedido>`)

- Atenção antes da OS: um item por pedido, agregando as peças que ainda deveriam chegar.
- Nomenclatura "PRAZO PRÓXIMO" ou "PRAZO VENCIDO · peça ainda não recebida". Nunca vira "OS atrasada".
- Some quando as peças chegam. A retirada não é reorganizada.

O antigo tipo "Prazo em risco" (prazo interno da tarefa) passa a se chamar "Prazo interno da tarefa", para não
confundir com o prazo da OS.

## Prazo do pedido (opção 3)

**Rota.** `PUT /api/v1/orders/:id/promised-date`

- Exige `pedidos.gerenciar`, motivo obrigatório (3–300), versão (409 se desatualizada) e chave de idempotência.
- Pedido cancelado: recusado.

**Histórico.** Registrado na auditoria existente, sem migration: prazo anterior, novo, autor
(`actor_user_id`), data (`created_at`), motivo e OS às quais o prazo foi aplicado. Aparece no detalhe do
pedido.

**Aplicar às OS.** A interface sempre pergunta "Aplicar este novo prazo também às OS abertas deste pedido?"
e só salva com resposta explícita.

- **SIM** (exige também `os.gerenciar`): atualiza só as OS abertas com peça ativa por entregar. Cada uma passa
  pela regra central de alteração de prazo da OS (`changeServiceOrderPromisedDate`), com revisão, auditoria,
  evento e aviso. Sem fila, prioridade, D9 ou planejamento.
- **NÃO**: o pedido assume o novo prazo e as OS existentes mantêm os seus.

As OS que nascem depois copiam o prazo vigente do pedido, nunca o de uma OS irmã.

**Novo serviço.** O prazo prometido passa a ser obrigatório (tela e API).

## Permissões

Nenhuma permissão nova.

| Onde                                        | Quem                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| Estado do prazo na lista e no detalhe da OS | Quem já vê OS (`os.ver`). Não é informação financeira       |
| Central                                     | Mantém `ocorrencias.ver` ou `ocorrencias.gerenciar`         |
| Cartão do Início                            | Só com `ocorrencias.gerenciar` (acesso gerencial à Central) |
| Alterar o prazo do pedido                   | `pedidos.gerenciar`                                         |
| Aplicar às OS                               | Também `os.gerenciar`                                       |

## Início

- Cartão "Prazos — N atrasado(s) · N em risco", mais "N pedido(s) com peça ainda não recebida" quando houver.
- Contagens = `GET /api/v1/attention?type=PRAZO_OS` (CRÍTICO = atrasados, AÇÃO = em risco). É a mesma rota
  e a mesma regra da Central.
- Clicar abre a Central filtrada (`?type=PRAZO_OS`).

## Tempo real

- Eventos `service_order.*`, `order.*`, `receipt.*` e `production.plan_*` invalidam a Central, o Início e as
  telas de OS.
- O intervalo de 60 s continua só como reserva.
- Os eventos chegam a quem está na audiência do evento.

## D9 e saneamento

Prazo **não** reorganiza a fila: a regra só lê. Os testes provam que, com cálculo, consulta e alteração do
prazo (inclusive o SIM), continuam iguais:

- tarefas (prioridade, posição, estado, plano, versão, responsável);
- prioridade da OS;
- item do planejamento;
- auditoria.

## Testes

**Unidade** — `packages/shared/test/deadline.test.ts` (17):

- fronteiras: ontem, hoje, 5º e 6º dias úteis, fim de semana, sábado útil;
- sem prazo; cancelada, entregue e devolvida; entrega parcial;
- cada motivo e vários motivos agregados; contexto do cliente;
- regra do pedido.

**API** — `apps/api/test/prazos.test.ts` (11):

- Central, lista e detalhe consistentes; ATRASADO sem motivo entra; PROXIMO, SEM_PRAZO e encerradas não;
- item único por OS; coexistência com LOGÍSTICA; cada motivo pelo carregador; entrega frustrada com contexto;
- várias OS do mesmo pedido; fuso da empresa;
- atenção pré-OS e a chegada fazendo o alerta sumir; Novo serviço exige prazo;
- edição do prazo: motivo, versão, permissões (pedido e OS), NÃO preserva as OS, OS nova herda;
- SIM com revisão, auditoria e histórico; idempotência; eventos;
- D9, prioridade e ordem manual intactas; leitura sem gravação;
- permissões e contagens do Início iguais às da Central.

**E2E** — `tests/e2e/specs/prazos.spec.ts`:

- Início → Central filtrada → OS → pedido;
- alterar o prazo com SIM, histórico, OS sai da Central, contagem cai.

O Novo serviço e os E2E existentes foram ajustados para o prazo obrigatório.

**Suítes locais**

- API: 531 aprovados, 10 ignorados, 1 falha. A falha foi um tempo esgotado de WebSocket em
  `integrated-evolution` nº 7, sob carga da suíte completa. Código não tocado nesta fase; passou 3/3 isolado
  e no CI.
- shared 104, web 6, E2E 39/39.
- lint, typecheck, format e build OK.

## Homologação (autonomia, runner 2.1.1)

1. Estado inicial, somente leitura: ativa `c239e84`; 25 migrations; contêineres saudáveis; impressão
   `db2f06fd…`.
2. Build pelo gatilho `dd3fad79` (SUCCESS):
   - api `sha256:2f2e549e…`
   - web `sha256:0c0280b0…`
3. `gate_open`.
4. `prepare_version`.
5. **`migration_precheck`: OK** (imagem 25, banco 25, **0 pendentes** — nenhuma migration nova).
6. Só depois do CI nº 125 verde:
   1. `maintenance_on`;
   2. `recovery_point_create` `cenario-staging-20261015T221631Z`, restauração de teste idêntica;
   3. `backup_validate` OK.
7. `migrate`: "Database schema is up to date!" → **0 aplicadas**.
8. `activate_version` (Saúde OK) → `gate_close`.

**Depois da ativação**

- Versão (drop-in, pilha, candidata, migrada) = **`03ab53b`**; contêineres com exatamente os digests do build.
- `migration_verify` 25/25.
- smoke e saúde OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔.
- **Impressão digital idêntica** antes e depois (`db2f06fd…`): nada foi gravado.
- Logs: API 27 linhas `info`; web e postgres sem erros; Caddy sem 5xx.
- `images_cleanup`: removidas 406fde7 e eb3fe2a, 4,00 GiB recuperados (disco 84% → 62%). A versão ativa e a
  do ponto (`c239e84`) ficaram protegidas.

## Ressalvas

- Os fluxos funcionais não puderam ser clicados direto na homologação: o runner não tem login da aplicação,
  por desenho, e nada foi criado para contornar isso. A validação funcional vem do CI nº 125 (API + E2E)
  sobre o mesmo commit, cujas imagens são as ativas.
- Quem vê a Central mas não está na audiência dos eventos de OS ou pedido recebe a atualização pelo
  intervalo de 60 s.
- Pendências anteriores fora do escopo continuam registradas no relatório do saneamento, entre elas a
  edição da OS que apaga o prazo se o campo não for enviado (a tela sempre envia).
