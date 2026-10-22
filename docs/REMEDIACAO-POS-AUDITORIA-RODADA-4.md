# Remediação pós-auditoria — Rodada 4 (prova final, robustez e rastreabilidade)

Base funcional da Rodada 3: `c240387`. SHA funcional final desta rodada: **`7b4177b`** (= `ce4b89d`

- o teste do F10-13q + a atualização de segurança do Next; ver §12).
  Produção não foi tocada em nenhum momento.

A rodada não criou funcionalidade nova. O foco foi **provar** o que existe:

- os 33 itens "sem teste suficiente" e os 2 "não comprovados";
- a reversão das seis migrations históricas (F1-05);
- um E2E transversal do Novo serviço até o pagamento;
- concorrência real, matriz de permissões, privacidade e tempo real;
- a recuperação completa (backup → restauração → migrations → aplicação → saúde).

As provas encontraram quatro bugs reais, corrigidos (§3). Nenhuma correção mudou comportamento
financeiro aprovado.

## 1. Arquivos de prova novos

| Arquivo                                                      | O que prova                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/rodada4-transacao-auditoria.test.ts`          | Falha injetada (gatilho temporário) em cada INSERT do Novo serviço: nada parcial em nenhuma tabela, a chave não fica presa e a nova tentativa grava o mesmo. Auditoria na mesma transação das ações novas (F1-06, F2-07, F3-20b) |
| `apps/api/test/rodada4-travas-estruturais.test.ts`           | As 379 rotas e as 55 permissões de `9fb1786` com a mesma regra. Páginas e migrations antigas intactas (SHA-256). Varredura de termos jurídicos e menu (F1-07b, F1-12b, F1-13, F7-16, F10-01)                                     |
| `apps/web/test/rodada4-menu.test.ts`                         | Seis áreas do menu na ordem e itens por perfil (F10-01, F1-13)                                                                                                                                                                   |
| `apps/api/test/rodada4-tempo-compras-ajuda.test.ts`          | Fronteiras reais de horário e fuso (F3-04, F4-07d), problema nas peças (F3-25), compras simultâneas e cancelamento (F6-07c, F6-08), histórico de ajuda paginado (F7-14)                                                          |
| `apps/api/test/rodada4-modelos-negociacao.test.ts`           | Modelos simplificados até a qualidade e a embalagem (F5-04, F5-10), detalhamento em Meus Ganhos (F8-10), justificativa, piso no pago e titularidade (F8-20, F8-27b, F8-27c)                                                      |
| `apps/api/test/rodada4-central-indicadores.test.ts`          | Central (presença, ajuda) e indicadores do Início com caso positivo e valor fixo (F10-13k2, F10-13l, F10-21d/e/g/j/n/o/p/t)                                                                                                      |
| `apps/api/test/rodada4-documento-arquitetura.test.ts`        | Documento da Fase 1 (19 seções + matriz + CA1-01..16) e um único ponto de criação de recebimento, material e estoque, com a Central do Gestor estendendo a existente (F1-01, F1-02b)                                             |
| `apps/api/test/rodada4-concorrencia-idempotencia.test.ts`    | Concorrência real (`Promise.all`) com invariantes finais no banco e retry após resposta perdida, inclusive pela sessão do tablet (§6)                                                                                            |
| `apps/api/test/rodada4-matriz-permissoes-tempo-real.test.ts` | Matriz perfil × superfície e tempo real com clientes WebSocket reais (§7)                                                                                                                                                        |
| `apps/api/test/cobranca.test.ts` (acréscimo)                 | Início conta o registro de pagamento pendente da equipe (F10-21t)                                                                                                                                                                |
| `packages/db/rollback/2027*.down.sql` (6)                    | Reversão condicionada das seis migrations de 2027 (F1-05)                                                                                                                                                                        |
| `scripts/test-evolution-migrations.sh` (etapas 5 e 6)        | Aplicar → reverter → reaplicar das oito migrations posteriores à Evolução, e recusa sem mutação (F1-04, F1-05). Roda no CI (`evolution-migrations`)                                                                              |
| `scripts/test-backup-restore.sh` (final)                     | Backup → restauração → migrations conferidas → **a aplicação sobe** no banco restaurado → saúde, prontidão, login real e leitura de OS                                                                                           |
| `tests/e2e/specs/zz-fluxo-transversal.spec.ts`               | E2E transversal (§4), em job próprio do CI (`e2e-transversal`)                                                                                                                                                                   |
| `docs/ROTEIROS-MANUAIS-RODADA-4.md`                          | Roteiros exatos para Safari/WebKit, tablets e celulares físicos e rede real                                                                                                                                                      |

## 2. F1-05 — as seis migrations históricas

As seis migrations são `20270105`, `20270112`, `20270119`, `20270126`, `20270202` e `20270209`.
Cada uma ganhou `.down.sql` condicionado:

- o script recusa, **sem alterar nada**, quando existe dado que se perderia;
- quando reverte, apaga o próprio registro em `_prisma_migrations`.

A `20270126` (Meus Ganhos) só concede uma permissão a duas funções. A reversão dela é
incondicional e remove exatamente essas duas concessões.

O script prova, sobre o banco legado:

| Passo               | Resultado                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------- |
| OLD → APPLY → NEW   | Dados legados idênticos                                                                  |
| SAFE ROLLBACK → OLD | Esquema (`pg_dump -s`) idêntico ao da Evolução; dados idênticos aos de antes da reversão |
| REAPPLY → NEW       | Esquema e dados idênticos à cadeia completa                                              |
| Recusa              | Com dado novo, cada reversão aborta com mensagem e sem mutação (transação atômica)       |

Nenhum caso exigiu perda de dados. Quando a reversão é recusada, o caminho é o ponto de
recuperação ou o backup, conforme `docs/PLANO-DE-REVERSAO.md`.

## 3. Bugs reais encontrados pelas provas e corrigidos

| ID     | Defeito                                                                                         | Correção                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F3-04  | Aviso de retirada usava o fuso fixo de São Paulo, não o da oficina (`companySettings.timezone`) | `arrivals/routes.ts`: "hoje" e hora atual no fuso configurado, pelo relógio operacional                                       |
| F7-14  | Lista de pedidos de ajuda com `take: 200` sem paginação: o histórico antigo ficava inalcançável | Parâmetro `before` (página seguinte por data de criação) e "Carregar mais antigos" na aba ativa do painel                     |
| F10-14 | Link `?foco=<id>` da ajuda abria sempre a aba Pendentes (um pedido Escalado não era mostrado)   | A página abre na aba do status do pedido em foco, até a pessoa escolher outra                                                 |
| F7-16  | Textos "salário e encargos" / "Salários" da equipe fixa (pressupõem vínculo de emprego)         | Termos neutros ("valores informados pelo gestor", "custos da equipe fixa"); trava que impede termo jurídico novo na interface |

## 4. E2E transversal (`zz-fluxo-transversal.spec.ts`)

O fluxo usa só telas e APIs reais. O banco é só **lido**, para provar o que não foi gravado.
Os dados são exclusivos: profissionais A e B criados no teste e cliente com nome único. A
execução das tarefas ocorre num dia próprio (+105) do relógio de teste.

**Fluxo:** cliente → Novo serviço → pedido → retirada → coleta → recebimento físico → OS
automática → medição → necessidade → compra → recebimento do material → conferência técnica →
material liberado → planejamento → publicação → tablet → início → execução → qualidade →
embalagem → pronto → entrega real → obrigação financeira → Meus Ganhos → confirmação D12/D13 →
pagamento → Central sem as pendências resolvidas.

| Transição exigida                                       | Onde está provada (linha do spec)                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Coleta → recebimento                                 | l. 231: André registra "Saí para a retirada" → "Peças retiradas"; João confirma a chegada no tablet e nasce `OS-xxxxx`                                                  |
| 2. OS automática → medição                              | l. 264: a OS traz titular e mão de obra combinada (vindos do Novo serviço); medição pela tela; necessidade aprovada                                                     |
| 3. Material recebido/conferido → planejamento/liberação | l. 305: compra confirmada; Thiago recebe com "Conferi referência…" (sem preços); prontidão **Completo**; "A planejar" → publicação                                      |
| 4. Tablet → execução das tarefas do modelo simplificado | l. 365: tarefas exatas do modelo (João: Desmontagem e preparação; A: Corte e costura, Montagem e acabamento); cada uma iniciada e concluída no tablet, na ordem da fila |
| 5. Entrega → Meus Ganhos → confirmação → pagamento      | l. 466: entrega pelo André; l. 499: Meus Ganhos com PIN (devido R$ 450,00); l. 559: confirmação D13 com snapshot e hash; l. 590: pagamento no Fechamento                |

**D12/D13:**

- profissional e sessão certos; desbloqueio exigido (sem ele: 403);
- o token de A não abre o Meus Ganhos de B (403);
- PIN ausente da auditoria e só como hash no cadastro;
- confirmação com `hash` de 64 hexa e linhas do snapshot;
- evidência `PIN_D12` sem PIN, token ou assinatura;
- pagamento parcial liberado e feito.

**Invalidação (l. 614):**

- um ajuste de +R$ 50,00 invalida a confirmação antiga;
- o pagamento é recusado com 422;
- A confirma de novo (hash diferente) e o restante é pago;
- o saldo em aberto vai a 0 e a mão de obra fica PAGO.

**Privacidade:**

- B não vê nada de A, e A não vê nada de B;
- B não recebe o `finance.own_changed` de A;
- o `own_changed` de A tem só `{reason}`, sem valores;
- os tablets não recebem evento financeiro gerencial;
- sessão de tablet recebe 403 em rotas do painel (fechamento, mão de obra, Central, funcionários).

**Central (l. 697):** ao fim, nenhum item da OS ou de A; os cartões de confirmação e de
pagamento sumiram.

## 5. Recuperação completa

`scripts/test-backup-restore.sh` (CI, job `verify`) roda a cadeia completa:

1. Backup com checksum (backup adulterado é recusado).
2. Restauração.
3. `prisma migrate status` conferido.
4. Comparação por valor de todas as tabelas e do catálogo (gatilhos, índices, restrições).
5. **A API sobe sobre o banco restaurado**, sem migrar nada na partida.
6. `/api/health` ok e `/api/ready` ready (consulta ao banco).
7. Login real do administrador que só existe nos dados restaurados.
8. Leitura das OS restauradas pela API.

## 6. Concorrência e idempotência

Regra real do plugin de idempotência:

- a chave é por usuário;
- mesma chave e mesmo corpo depois do commit: a mesma resposta (`idempotent-replayed`);
- mesma chave em andamento: 409;
- corpo diferente: 422;
- um erro libera a chave.

| Situação                                                                                  | Invariante final provada                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Recebimento simultâneo 7 + 7 sobre 12                                                     | 201 + 409; recebido = estoque = soma das movimentações = 7; reserva intacta |
| Compra simultânea                                                                         | Rodada 3 (12+12, 7+7) e Rodada 4 (8+6, 5+7, 4×4): alocado ≤ necessidade     |
| Confirmação D13 simultânea (mesmo hash)                                                   | Uma linha, uma auditoria, CONFIRMADA                                        |
| Confirmação × ajuste do gestor                                                            | Nunca "confirmada" com hash diferente do atual; pagamento recusado          |
| Pagamento simultâneo (fechamento / conta)                                                 | Soma paga ≤ devido; versão sobe uma vez                                     |
| Ajuste simultâneo (mesma versão)                                                          | 200 + 409; total = base + um ajuste                                         |
| Resolução simultânea de revisão                                                           | Um evento, uma auditoria                                                    |
| Mesma chave simultânea (recebimento, compra, pagamento, Novo serviço)                     | Exatamente um registro                                                      |
| Saída/reserva simultâneas de estoque                                                      | Disponível nunca negativo                                                   |
| Resposta perdida + retry (recebimento, compra, pagamento, tarefa no tablet, Novo serviço) | Mesma resposta, nenhuma duplicidade                                         |

Residual F2-08 (só documentação, como pedido):

- a resposta idempotente é gravada depois do commit;
- se essa gravação falhar, a chave volta a valer após 2 min;
- um novo envio só é contido pelas travas de negócio (versão, saldo).

Lacuna menor: duas resoluções **iguais** e simultâneas da mesma ocorrência não têm teste
próprio. O que existe hoje é "verificar × cancelar" (`issues.test.ts`).

## 7. Matriz de permissões e tempo real

| Perfil                               | Central                                                | Início          | Meus Ganhos     | Deep links (IDs reais)      |
| ------------------------------------ | ------------------------------------------------------ | --------------- | --------------- | --------------------------- |
| Gestor (painel)                      | Tudo, com valores                                      | Financeiro      | 403 (só tablet) | 200                         |
| Operacional (sem financeiro/compras) | Sem item financeiro, cobrança ou compras; nenhum valor | `finance: null` | —               | 403                         |
| Financeiro sem compras               | Financeiro sim; compras não                            | Financeiro      | 403             | Financeiro 200, compras 403 |
| Compras sem financeiro               | Compras sim; nada financeiro, nenhum valor             | `finance: null` | —               | Compras 200, financeiro 403 |
| Tapeceiro (tablet)                   | 403                                                    | 403             | 200 (com PIN)   | 403                         |
| Ajudante (tablet)                    | 403                                                    | 403             | 403             | 403                         |

- **Tablet × painel:** um tablet com **todas** as permissões recebe 403 em todas as rotas do
  painel (mais de 250, varredura do catálogo). As 4 rotas do Meus Ganhos são as únicas
  exclusivas de tablet e recusam o painel.
- **Tempo real** (clientes WebSocket reais):
  - evento gerencial só para o painel com permissão;
  - `own_changed` só para o dono, com `{reason}`;
  - compras só para quem tem compras;
  - a mesma pessoa no painel recebe, e no tablet não (corte por tipo de sessão);
  - reconexão com replay recortado pela mesma regra, igual a `/api/sync/events`;
  - `sync.signal` (diagnóstico) preservado. F1-09 não foi enfraquecido.

## 8. Matriz final dos itens da rodada (ANTES → DEPOIS)

Legenda: **C** comprovado · **P** parcial · **ST** sem teste suficiente · **NC** não comprovado.

| ID       | Antes | Prova nova                                                                               | Resultado                                                                                                | Depois |
| -------- | ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| F1-01    | ST    | `rodada4-documento-arquitetura` › F1-01 (3); CA1-02 pela homologação (§10)               | 19 seções + §20 + CA1-01..16; versão publicada conferida no fluxo seguro                                 | C      |
| F1-02b   | ST    | `rodada4-documento-arquitetura` › F1-02b (4)                                             | Um ponto de criação por registro; chegada e Central reutilizam                                           | C      |
| F1-04    | ST    | Script de evolução, etapas 5–6, no CI                                                    | Seis migrations de 2027 preservam os dados legados                                                       | C      |
| F1-05    | P     | `.down.sql` × 6 + script (aplicar/reverter/reaplicar/recusar)                            | Todas as reversões históricas condicionadas e provadas                                                   | C      |
| F1-06    | ST    | `rodada4-transacao-auditoria` (falha na auditoria desfaz a ação)                         | Todas as ações citadas auditadas na mesma transação                                                      | C      |
| F1-07b   | ST    | `rodada4-travas-estruturais` › F1-07b                                                    | 379 rotas com a mesma regra; permissões só ampliadas por `estoque.conferir`                              | C      |
| F1-12b   | ST    | `rodada4-travas-estruturais` › F1-12b                                                    | 381 rotas da linha de base presentes; uma nova; nenhuma removida                                         | C      |
| F1-13    | ST    | `rodada4-travas-estruturais` › F1-13; `web/rodada4-menu`                                 | 54 páginas; migrations antigas byte a byte; "Materiais aprovados" de volta ao menu                       | C      |
| F2-07    | ST    | `rodada4-transacao-auditoria` › 22 falhas injetadas + 6 pontos nomeados                  | Nada parcial em nenhuma tabela; mesma chave depois cria uma vez                                          | C      |
| F3-04    | ST    | `rodada4-tempo-compras-ajuda` › antes/depois do horário, virada de dia, fuso             | Bug do fuso fixo corrigido (§3)                                                                          | C      |
| F3-20b   | ST    | `rodada4-transacao-auditoria` › auditoria da chegada lida pela rota                      | Ator, sessão do tablet, resumo e detalhes sem preço nem PIN                                              | C      |
| F3-25    | ST    | `rodada4-tempo-compras-ajuda` › problema nas peças                                       | Recebe, registra divergência, aparece na Central; sem problema não bloqueia                              | C      |
| F4-07d   | ST    | `rodada4-tempo-compras-ajuda` › 23:30/00:30 SP × UTC                                     | Presença, fila, Meus Ganhos e planejamento viram de dia/semana no fuso certo                             | C      |
| F5-04    | ST    | `rodada4-modelos-negociacao` › F5-04; E2E transversal l. 365                             | Reforma: 3 tarefas → inspeção → embalagem → pronta                                                       | C      |
| F5-10    | ST    | `rodada4-modelos-negociacao` › F5-10 (2)                                                 | Cabeceira: executor nunca inspeciona; substituto habilitado; embalagem                                   | C      |
| F6-07c   | ST    | `rodada4-tempo-compras-ajuda` › F6-07c (3); `rodada4-concorrencia`                       | Compras paralelas nunca passam da necessidade                                                            | C      |
| F6-08    | ST    | `rodada4-tempo-compras-ajuda` › F6-08 (2)                                                | Cancelar pedido confirmado devolve a quantidade à fila                                                   | C      |
| F7-14    | ST    | `rodada4-tempo-compras-ajuda` › F7-14 (paginação)                                        | Bug do limite de 200 corrigido (§3); histórico inteiro alcançável                                        | C      |
| F7-16    | ST    | `rodada4-travas-estruturais` › termos jurídicos (com controle positivo)                  | Bug de texto corrigido (§3); trava contra termo novo                                                     | C      |
| F8-10    | ST    | `rodada4-modelos-negociacao` › F8-10                                                     | MO com OS e peça; viagens com EN-/RT-                                                                    | C      |
| F8-20    | ST    | `rodada4-modelos-negociacao` › F8-20                                                     | Pedido e recusa sem justificativa: 400 e nada gravado                                                    | C      |
| F8-27b   | ST    | `rodada4-modelos-negociacao` › F8-27b                                                    | Abaixo do pago: 422 e nada muda; igual ao pago: aprovado                                                 | C      |
| F8-27c   | ST    | `rodada4-modelos-negociacao` › F8-27c                                                    | Aprovar não troca titular nem recebedor                                                                  | C      |
| F10-01   | ST    | `rodada4-travas-estruturais` › F10-01; `web/rodada4-menu`                                | Seis áreas na ordem, cabeçalhos ≠ links homônimos, itens por perfil                                      | C      |
| F10-13k2 | ST    | `rodada4-central-indicadores` › presença (4)                                             | Ausência com impacto, link com foco, permissão `presenca.*`                                              | C      |
| F10-13l  | ST    | `rodada4-central-indicadores` › ajuda (3)                                                | Atrasada/urgente/escalada, link com foco, sai ao resolver                                                | C      |
| F10-21d  | ST    | `rodada4-central-indicadores` › aguardando material                                      | Valor fixo = lista de prontidão (3 → 2)                                                                  | C      |
| F10-21e  | ST    | `rodada4-central-indicadores` › etapas                                                   | Em produção 2 → 1 → 0 pelas etapas reais                                                                 | C      |
| F10-21g  | ST    | idem                                                                                     | Prontas 1 → 0 ao agendar                                                                                 | C      |
| F10-21j  | ST    | `rodada4-central-indicadores` › cobranças                                                | Vencidas no Início = Central = lista                                                                     | C      |
| F10-21n  | ST    | `rodada4-central-indicadores` › etapas                                                   | Retrabalho 1 → 0                                                                                         | C      |
| F10-21o  | ST    | `rodada4-central-indicadores` › cobranças                                                | A receber exato (210000 → 110000)                                                                        | C      |
| F10-21p  | ST    | idem                                                                                     | Vencido exato (130000 → 30000)                                                                           | C      |
| F10-21t  | ST    | `rodada4-central-indicadores` › revisões; `cobranca` › registro da equipe                | Revisões, pedidos (Rodada 3) e registros da equipe com caso positivo                                     | C      |
| F4-21    | NC    | Roteiro manual exato (`ROTEIROS-MANUAIS-RODADA-4.md` §1–§4)                              | WebKit indisponível no ambiente; aparelho físico exige pessoa                                            | NC     |
| F10-13q  | NC    | `negociacao-confirmacao` › F10-13q; E2E transversal l. 697 (decisão do proprietário, §9) | Central por exceção: normal não aparece; pendência aparece; resolvida some; exceção D13 sem item próprio | C      |
| F10-19   | P     | Investigação (§9)                                                                        | Não há ação canônica para "quitada antes da devolução e mantida"                                         | P      |

Nenhum item COMPROVADO regrediu. A suíte completa no SHA final está verde (§10).

## 9. O que continua aberto

- **F10-19 (P).** A peça já quitada antes da devolução, com valor mantido, não tem ação
  canônica de encerramento. Cancelar, ajustar e pagar são recusados; um estorno seguido de
  novo pagamento inventaria movimento financeiro. Não se criou botão, ajuste, cancelamento nem
  LaborReview novo, como instruído.
- **F4-21 (NC).** Categoria **C**: só manual. O roteiro exato está em
  `docs/ROTEIROS-MANUAIS-RODADA-4.md`. A parte de rede automatizável (offline/online, resposta
  perdida, reconexão) já roda nos E2E em Chromium, separada do teste físico.
- **F10-13q — decisão do proprietário: leitura (a), gestão por exceção.** A Central mostra só o
  que exige atenção, decisão, correção ou ação do gestor:
  - operação normal não aparece;
  - pendência excepcional aparece no seu tipo canônico;
  - resolvida, desaparece;
  - a exceção administrativa do D13, já registrada e auditada e sem outra pendência, **não**
    cria item próprio.

  Não houve mudança de código: nada de fonte de estado nova, card de "exceção administrativa"
  nem alteração do D13, do financeiro, do fechamento ou da auditoria. A prova é o teste
  `negociacao-confirmacao.test.ts` › "F10-13q (decisão do proprietário…)", que cobre os 4
  pontos, mais o E2E transversal (l. 697: ao fim do fluxo normal, nenhum item da OS nem do
  profissional). Classificação: **C**.

- **Defesa em profundidade (não é bug):** a justificativa da negociação (F8-20) é exigida pela
  API, mas o banco não tem `CHECK` em `reason`. Não se criou migration nesta rodada.
- **Regra a confirmar (F5-10):** na cabeceira simplificada, o Thiago faz a preparação. Por isso
  nunca inspeciona cabeceiras; a inspeção vai a um substituto habilitado.

## 10. Validação final, CI e homologação

**SHA final (funcional): `ce4b89d`.** Ele inclui `27828a8` mais dois ajustes:

- a formatação de `labor.tsx`;
- a checagem de valores do teste de tempo real. O teste procurava `4321` em qualquer lugar do
  JSON e casou com o fim de um UUID aleatório. Era falso positivo, não vazamento; agora o valor
  só conta como número isolado.

### 10.1 Regressão local (mesmo SHA)

| Etapa                                                           | Resultado                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| format / lint / typecheck                                       | OK                                                                |
| migrations do zero + `migrate status` + diff do schema          | OK (33 migrations, sem divergência)                               |
| build                                                           | OK                                                                |
| testes shared / web / API                                       | 134 / 12 / **933** aprovados (10 ignorados por desenho), 0 falhas |
| backup → restauração → migrations → aplicação → saúde           | OK                                                                |
| E2E completo (inclui transversal e geometria 390/768/1280/1440) | **51/51**                                                         |
| `test-evolution-migrations.sh` (com F1-05)                      | OK                                                                |

### 10.2 CI (`ce4b89d`, execução 192)

| Job                    | Resultado | Duração                         |
| ---------------------- | --------- | ------------------------------- |
| `verify`               | sucesso   | ~25 min (limite 45, inalterado) |
| `e2e`                  | sucesso   | ~28 min                         |
| `e2e-transversal`      | sucesso   | ~3 min                          |
| `evolution-migrations` | sucesso   | ~3 min                          |

### 10.3 Homologação (fluxo seguro `operar.py`, evidência em `hml4` do scratchpad)

| Passo                                                 | Resultado                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| build pelo gatilho + imagens                          | api e web `ce4b89d` publicadas                                                                        |
| impressão digital (antes)                             | registrada                                                                                            |
| `migration_status`                                    | 33 aplicadas, 33 na imagem, **nenhuma pendente**                                                      |
| disco                                                 | 1,1 GB livre (mínimo 3 GB para `prepare_version`)                                                     |
| portão aberto → manutenção                            | API e web paradas (503 "em manutenção")                                                               |
| ponto de recuperação                                  | `cenario-staging-20261022T151441Z` (versão `c240387`); restauração de teste IDÊNTICA; cópia no bucket |
| `backup_validate` / `backup_restore_test`             | íntegro / IDÊNTICA                                                                                    |
| `images_cleanup_plan` → `images_cleanup`              | só as imagens de `9fb1786` (não protegidas); ativa, rollback e nova protegidas                        |
| `prepare_version`                                     | OK (4 GB livres; a imagem nova não migra na partida)                                                  |
| `migration_precheck` / `migrate` / `migration_verify` | OK, 0 pendentes / registrado / 33 de 33                                                               |
| `activate_version`                                    | OK                                                                                                    |
| health / smoke / websocket                            | OK (`/api/ready` 200 pelo proxy; WS 401 sem sessão, como esperado)                                    |
| `run_homologation_tests suite=completo`               | 27 verificações OK, 0 falhas                                                                          |
| versão (CA1-02 de F1-01)                              | etiqueta local, pilha, candidata e migrada = `ce4b89d`                                                |
| logs (api, web, caddy, postgres)                      | sem erro                                                                                              |
| impressão digital (depois)                            | **idêntica** à de antes (2 751 linhas)                                                                |
| portão                                                | **fechado**                                                                                           |

Nenhuma infraestrutura, IAM, DNS, firewall, VM ou Caddy foi alterada. A limpeza de imagens usou
a operação existente e respeitou as versões protegidas.

**Produção não foi tocada.**

## 11. Totais (284 requisitos)

| Classificação                     | Rodada 3 | Rodada 4 |
| --------------------------------- | -------- | -------- |
| IMPLEMENTADO E COMPROVADO         | 238      | **273**  |
| IMPLEMENTADO PARCIALMENTE         | 2        | **1**    |
| IMPLEMENTADO SEM TESTE SUFICIENTE | 33       | **0**    |
| NÃO IMPLEMENTADO                  | 0        | 0        |
| DIVERGENTE                        | 0        | 0        |
| SUBSTITUÍDO POR DECISÃO           | 9        | 9        |
| NÃO COMPROVADO                    | 2        | **1**    |
| **Total**                         | 284      | 284      |

Conta: os 33 ST, o F1-05 e o F10-13q (decisão do proprietário) viraram C (238 + 35 = 273).
Ficam F10-19 (P) e F4-21 (NC).

SHA: o teste do F10-13q entrou em `61c3293`, que difere de `ce4b89d` só nesse arquivo de teste.
O código de aplicação homologado continua sendo o de `ce4b89d`.

## 12. Fechamento da rodada

### 12.1 CI 194 (`61c3293`) e a correção

| Job                    | Resultado                                               |
| ---------------------- | ------------------------------------------------------- |
| `e2e`                  | sucesso                                                 |
| `e2e-transversal`      | sucesso                                                 |
| `evolution-migrations` | sucesso                                                 |
| `verify`               | **falhou** no passo `pnpm audit --audit-level critical` |

A falha era real: o alerta GHSA-2464-fhr4-w9xw (crítico, execução remota de código no Image
Optimization) atinge `next <= 15.5.27`. Ele foi publicado depois do CI 192 verde de `ce4b89d`.
Nenhum teste falhou; os passos seguintes nem rodaram.

Correção mínima em `7b4177b`: `next` e `@next/eslint-plugin-next` para **15.5.28** (patch),
com o lockfile atualizado. Não há outra mudança de código de aplicação. Depois disso, o
`pnpm audit` local não acusa nenhum crítico. Restam 1 baixo, 2 moderados e 1 alto, que o CI
tolera e que já existiam antes.

### 12.2 SHAs

| Papel                                        | SHA                                    |
| -------------------------------------------- | -------------------------------------- |
| Inicial (base da rodada)                     | `a78fb28` (código funcional `c240387`) |
| Funcional final **homologado**               | **`7b4177b`**                          |
| Prova do F10-13q (teste)                     | `61c3293` (contido em `7b4177b`)       |
| Documentação                                 | o commit deste parágrafo (só `docs/`)  |
| Homologado antes do fechamento (substituído) | `ce4b89d`                              |

`git diff ce4b89d 7b4177b` mexe em cinco arquivos:

- `apps/web/package.json` e o `package.json` raiz (versão do Next);
- `pnpm-lock.yaml`;
- um arquivo de teste (`negociacao-confirmacao.test.ts`);
- este documento.

Nenhuma linha de `src/` mudou. As evidências de `ce4b89d` (§10) e as de `7b4177b` (§12.3 e
§12.4) ficam separadas. Como o pacote do Next entra na imagem `web`, a versão foi
**re-homologada** pelo fluxo seguro.

### 12.3 Regressão local e CI de `7b4177b`

Em execução no momento deste commit; o resultado entra no próximo commit de documentação.

### 12.4 Homologação de `7b4177b` (fluxo seguro, evidência em `hml4b` do scratchpad)

| Passo                                                 | Resultado                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| build pelo gatilho + imagens                          | api `sha256:99323024…`, web `sha256:0ca94f88…`, etiqueta `7b4177b`                                    |
| impressão digital (antes)                             | registrada                                                                                            |
| `migration_status`                                    | 33 aplicadas, 33 na imagem, **nenhuma pendente**                                                      |
| disco                                                 | 1,1 GB livre (abaixo do mínimo)                                                                       |
| portão aberto → manutenção                            | API e web paradas                                                                                     |
| ponto de recuperação                                  | `cenario-staging-20261022T200157Z` (versão `ce4b89d`); restauração de teste IDÊNTICA; cópia no bucket |
| `backup_validate` / `backup_restore_test`             | SHA256SUMS conferido / IDÊNTICA                                                                       |
| `images_cleanup_plan` → `images_cleanup`              | só as imagens de `34412d5` (não protegidas); de 1,04 para 4,70 GiB livres                             |
| `prepare_version`                                     | OK (5 GB livres; a imagem nova não migra na partida)                                                  |
| `migration_precheck` / `migrate` / `migration_verify` | OK / nenhuma migration nova (banco idêntico ao ponto de recuperação) / 33 de 33                       |
| `activate_version`                                    | OK                                                                                                    |
| health / smoke / websocket                            | OK (`/api/ready` 200 pelo proxy; WS 401 sem sessão, como esperado)                                    |
| `run_homologation_tests suite=completo`               | 27 verificações OK, 0 falhas                                                                          |
| versão                                                | etiqueta local, pilha, candidata e migrada = `7b4177b15a930b85d985a59a9182b579760c5a7b`               |
| logs (api, web, caddy, postgres, 30 min)              | nenhum error/exception/fatal                                                                          |
| impressão digital (depois)                            | **idêntica** à de antes                                                                               |
| portão                                                | **fechado**                                                                                           |

### 12.5 F4-21 (continua NÃO COMPROVADO)

- **Texto original da auditoria:** "Validação em Safari/WebKit e tablets físicos". Status de
  origem: NÃO FOI POSSÍVEL COMPROVAR. O E2E roda só em Chromium emulado, com geometria
  390/768/1280/1440.
- **Por que segue NC.** O requisito pede navegador e aparelho reais. Este ambiente só tem
  Chromium (`/opt/pw-browsers`) e baixar o WebKit está fora da política. Emular um iPad no
  Chromium não é Safari, e chamar isso de prova seria inventar evidência.
- **O que está automatizado (em Chromium):**
  - geometria sem rolagem horizontal em 390/768/1280/1440;
  - toque e viewport de tablet;
  - queda e volta da rede (`setOffline`) em `tablets`, `team-week` e `team-workshop`;
  - resposta perdida com repetição idempotente em `novo-servico-rede` e `recebimentos-rede`;
  - reconexão e sincronização do tempo real em `tablet-sync`.
- **O que falta:** motor WebKit/Safari real (macOS e iPadOS), tablet físico (toque, teclado
  virtual, rotação, suspensão) e rede real (Wi-Fi da oficina, troca Wi-Fi ↔ 4G).
- **Forma segura de provar agora:** nenhuma de dentro deste ambiente. Só pessoa com aparelho,
  contra a **homologação** (versão `7b4177b`), seguindo `docs/ROTEIROS-MANUAIS-RODADA-4.md`:
  - §1 Safari no MacBook;
  - §2 tablet;
  - §3 iPhone;
  - §4 rede real;
  - registrar em §5.

### 12.6 Tablet físico com erro em PRODUÇÃO (relato do proprietário)

Sintomas relatados:

- `/entrar` abre com CSS quebrado;
- `/tablet` mostra "Application error: a client-side exception has occurred".

Isso acontece em produção, que roda uma versão antiga. Produção não foi lida nem tocada.

**O que a Rodada 4 permite afirmar: nada conclusivo.** Nenhum teste desta rodada rodou em
aparelho físico nem em Safari. Não há prova de que a homologação tem ou não tem o problema, nem
de que `7b4177b` o corrige. **Não está declarado como corrigido.**

Hipóteses a verificar, que **não** são diagnóstico:

1. **Navegador do tablet abaixo da base exigida.** O CSS é gerado com Tailwind 4, que pede
   Safari 16.4+ / Chrome 111+. Um navegador mais velho carrega a página sem estilo. O código
   também usa APIs recentes (por exemplo `crypto.randomUUID`, que exige contexto seguro e
   navegador moderno; está em `apps/web/lib/api.ts`); sem elas, a página do tablet quebra no
   cliente. A versão homologada tem essa mesma base de navegador. Se a causa for essa, a
   homologação teria o **mesmo** sintoma no mesmo aparelho.
2. **Cache antigo de pacotes JavaScript** depois de uma publicação (ChunkLoadError), que gera
   o mesmo "Application error".

Diagnóstico específico necessário, no tablet físico:

- anotar modelo, sistema e versão do navegador (abrir `chrome://version` ou Ajustes → Safari);
- abrir a **homologação** no mesmo tablet (`/entrar` e `/tablet`) e comparar;
- ligar a depuração remota (Chrome `chrome://inspect` com cabo USB ou Safari → Desenvolvedor)
  e copiar a primeira mensagem de erro do console;
- limpar os dados do site e recarregar, para separar a hipótese 2.

### 12.7 F10-19 (continua PARCIAL)

Nada mudou desde §9: falta uma ação canônica de encerramento para "peça quitada antes da
devolução, com valor mantido". Não se criou botão, ajuste, cancelamento nem LaborReview.

**Produção não foi alterada.**
