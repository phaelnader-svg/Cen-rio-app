# Fase 6 — Interface operacional dos tablets: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento) |
| SHA inicial (fim da Fase 5)    | `437615b` (relatório) — último código da Fase 5: `2a9f235`                      |
| Commits da Fase 6              | `b9bb760`, `5c20ae8`, `6570d87` (banco, API, telas, testes, documentação)       |
| SHA final do código verificado | `6570d87` — este relatório é o commit seguinte (só docs e capturas)             |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `437615b`.
- Relatórios das Fases 1–5 lidos; telas do tablet (`components/tablet/*`), APIs de tarefas,
  permissões, hub de tempo real, política de anexos e prontidão de materiais inspecionados.
- **Suíte E2E completa antes de qualquer alteração** (a última mudança visual da Fase 5 só tinha
  passado pelo E2E de produção): **13/13 aprovados**. `pnpm test`: API **142/142**, compartilhado
  **29/29**, web **6/6**. (O `pnpm check` inicial foi disparado depois de criar os primeiros arquivos
  novos, ainda não ligados ao app, e acusou só esses arquivos no typecheck; os testes foram então
  executados diretamente, todos aprovados.)
- **Já existia e foi reaproveitado** (sem duplicar): PIN, sessão persistente de dispositivo e
  revogação remota (Fase 1); "Minhas tarefas" com Iniciar/Andamento/Pausar/Retomar/Concluir
  (Fase 5); motor de liberação, eventos `production.*` e reenvio na reconexão.
- **Riscos e divergências registrados antes de implementar:**
  1. Materiais verificados pela OS inteira (limitação da Fase 5) — tratado na seção 4.
  2. Andamento exigia texto; sem fotos, etapa atual ou próximo passo.
  3. Nenhum aviso persistente: o tablet só via mudanças enquanto conectado e na tela certa.
  4. Sem aviso de queda de conexão nas telas de tarefa; botões podiam ser tocados sem rede (o
     servidor recusava, mas sem explicação clara).
  5. O detalhe trazia o nome do cliente (aceito desde a Fase 3) e nenhum valor comercial — mantido.

## 3. Estruturas reutilizadas

| Já existia                                                    | Uso na Fase 6                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Sessões de dispositivo, PIN, revogação (Fase 1)               | Login persistente dos quatro tablets; revogação testada de novo           |
| Tarefas, motor de liberação, idempotência e bloqueio (Fase 5) | Ações do tablet; regras de liberação estendidas para materiais por tarefa |
| Outbox + hub WebSocket com audiência `user:<id>` e reenvio    | Avisos em tempo real só para o destinatário, recuperados na reconexão     |
| Anexos privados e `/api/files/:id` (Fase 2)                   | Fotos da tarefa (`PRODUCTION_TASK`) com política própria                  |
| Prontidão de materiais por linha (Fase 4)                     | Materiais por tarefa (cobertura de cada linha vinculada)                  |
| Histórico técnico da OS (`service_order_revisions`, Fase 2)   | Histórico técnico no tablet, só com nomes de campos                       |

## 4. Telas implementadas

**Tablet / celular (`/tablet`)**

- **Meu dia** (tela inicial): nome, data, hora e situação da conexão no cabeçalho; botão **Avisos**
  com a contagem de não lidos; blocos **Em execução** e **Próxima tarefa liberada**; **Tarefas de
  hoje** em ordem de prioridade; **Próximos dias**; **Concluídas hoje**; demais atividades
  (medições, recebimento de materiais, teste de sincronização) e os módulos futuros apenas
  informativos.
- **Cartão de tarefa**: OS, peça, etapa, prioridade, prazo interno, status, responsável, indicador
  de materiais ("Materiais disponíveis"/"Falta material") e o motivo da espera em linguagem simples
  (ex.: "aguardando Preparação — OS-00001/1 (João)"). Toque abre; ação rápida no próprio cartão.
- **Detalhe**: o que fazer (instruções da tarefa e da OS), peças com tecido, espuma, medidas,
  observações e fotos; materiais da tarefa com situação; dependências e o que libera; etapas da OS;
  fotos da tarefa e da OS; histórico técnico da OS; histórico da tarefa (com andamentos).
- **Painéis** de andamento (observação, etapa atual, próximo passo, % opcional, fotos), pausa (quatro
  motivos e "É um impedimento") e conclusão (só pede observação/foto quando a etapa exige).
- **Avisos**: lista persistente, não lidos destacados, toque abre a tarefa e marca como lido;
  "Marcar todos como lidos".
- **Sem conexão**: faixa vermelha fixa; dados permanecem visíveis; botões de ação desativados.
- Layout testado em tablet (1280×800) e celular (390×844).

**Painel**

- Detalhe da tarefa: "Materiais desta tarefa" (vincular materiais aprovados) e "Para concluir,
  exigir" (nenhum/observação/foto) no editor; marcação dos materiais vinculados.
- Modelos de produção: coluna "Para concluir" por etapa.

## 5. Fluxos operacionais

1. **Começo do expediente**: o tablet já está logado (sessão persistente); o "Meu dia" mostra a
   próxima tarefa liberada com o botão **Iniciar** — um toque.
2. **Durante a tarefa**: "Registrar andamento" com o que for útil (nada é obrigatório
   individualmente); fotos opcionais pela câmera.
3. **Pausa**: um toque no motivo; "É um impedimento" marca o caso para a futura central de atenção.
4. **Conclusão**: no cartão, "Concluir" → "Toque de novo para confirmar" (sem formulário). Se a etapa
   exigir registro, abre só o campo necessário (observação ou foto).
5. **Dependências**: quando João conclui a preparação, o celular/tablet do Márcio mostra a tarefa
   liberada e um aviso, sem recarregar.
6. **Reprogramação pelo gestor**: o funcionário recebe "Tarefa reprogramada"/"Prioridade alterada" e
   vê a mudança na hora.
7. **Queda de rede**: aviso visível, nada é fingido como salvo; ao voltar, eventos perdidos são
   reenviados e as telas recarregadas do servidor.

## 6. APIs novas ou alteradas (`/api/v1`)

| Rota                                             | Permissão              | Observações                                                                         |
| ------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------- |
| `GET /notifications?unread=&limit=`              | autenticado (próprios) | `{ items, unread }`                                                                 |
| `POST /notifications/:id/read`                   | autenticado (próprio)  | Aviso de outra pessoa → 404                                                         |
| `POST /notifications/read-all`                   | autenticado            | Concorrência segura (uma única marcação)                                            |
| `PUT /production-tasks/:id/materials`            | `producao.planejar`    | Materiais aprovados da mesma OS; motivo após publicar; reavalia a tarefa            |
| `POST /production-tasks/:id/progress` (alterada) | responsável            | `note`, `percent`, `step`, `nextStep`, `attachmentIds` (ao menos um)                |
| `POST /production-tasks/:id/pause` (alterada)    | responsável            | `impediment` opcional → `production.task_impediment`                                |
| `POST /production-tasks/:id/complete` (alterada) | responsável            | `note`/`attachmentIds` só quando a etapa exige                                      |
| `PUT /production-tasks/:id` (alterada)           | `producao.planejar`    | `completionRequirement`; avisos de reprogramação, prioridade e troca de responsável |
| `GET /production-tasks/:id` (alterada)           | gestão ou responsável  | `materialIds`, `taskMaterials`, `technicalHistory`, andamentos estruturados         |
| `POST /attachments` (alterada)                   | gestão ou responsável  | Tipo `PRODUCTION_TASK`: o responsável envia durante a execução                      |
| Modelos (alterada)                               | `producao.planejar`    | `completionRequirement` por etapa                                                   |

## 7. Banco e migrations

Migration nova e aditiva `20261011000000_tablets_notificacoes` (migrations antigas intactas):

| Objeto                        | Conteúdo / garantias                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `notifications`               | Avisos por usuário; `UNIQUE (user_id, dedupe_key)`; índice por usuário/lido/data; CHECKs de texto e leitura              |
| `production_task_materials`   | Vínculo tarefa ↔ material aprovado (chave composta; cascata se a necessidade for removida)                              |
| `production_tasks` (+colunas) | `progress_step`, `progress_next`, `pause_impediment` (CHECK: só em pausada), `completion_requirement`, `completion_note` |
| `production_template_steps`   | `completion_requirement` (padrão `NENHUM`)                                                                               |
| `attachment_entity`           | Novo valor `PRODUCTION_TASK`                                                                                             |

Testado: aplicação do zero (testes e E2E), banco de desenvolvimento migrado e restauração do backup
com aviso persistente e unicidade preservada.

## 8. Permissões

Nenhuma permissão nova. `producao.executar` continua restrita às **próprias** tarefas (403 em
qualquer ação, detalhe, foto ou vínculo de materiais de outra pessoa); avisos são sempre do usuário
autenticado; vincular materiais e definir o registro exigido na conclusão são de
`producao.planejar`. Preservados: sessão vinculada ao dispositivo, CSRF por origem, idempotência
(`iniciar`/`concluir`), bloqueio de linha, auditoria e erros padronizados.

## 9. Eventos e notificações

| Aviso (tipo)             | Quando                                                                                                                     | Para quem                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Nova tarefa atribuída    | Publicação e OS incluída em semana publicada (**um resumo por pessoa**); etapa avulsa ou troca de responsável (por tarefa) | Novo responsável              |
| Tarefa liberada          | Motor de liberação (inclusive na publicação — um único aviso por tarefa)                                                   | Responsável (mesmo se causou) |
| Tarefa reprogramada      | Mudança de dia/hora/prazo                                                                                                  | Responsável                   |
| Prioridade alterada      | Mudança de prioridade                                                                                                      | Responsável                   |
| Tarefa passada a outro   | Troca de responsável (inclusive troca do principal)                                                                        | Responsável anterior          |
| Tarefa bloqueada         | Bloqueio manual pelo gestor                                                                                                | Responsável                   |
| Tarefa cancelada         | Cancelamento da tarefa ou da OS                                                                                            | Responsável                   |
| Etapa anterior concluída | Conclusão de uma dependência que ainda não libera a tarefa                                                                 | Responsável da dependente     |
| OS atualizada            | Alteração técnica da OS (dados, peça, medidas, materiais)                                                                  | Quem tem tarefa aberta na OS  |

Eventos: `notification.created`/`notification.read` (só `user:<id>`), `production.task_impediment`.
Sem duplicidade: chave por fato e versão da tarefa; conclusão repetida não cria aviso novo.

## 10. Testes e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                          | Resultado                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| API — integração (Vitest, 20 arquivos)                         | **152/152** (142 das Fases 1–5 + 10 novos em `tablets.test.ts`)          |
| Pacote compartilhado — unitários                               | **33/33** (29 + 4 novos)                                                 |
| Web — unitários                                                | **6/6**                                                                  |
| E2E Playwright (build de produção; painel + 2 tablets/celular) | **14/14** (13 das Fases 1–5 + 1 novo: tablet 1280×800 e celular 390×844) |
| Backup + restauração (agora com aviso persistente da Fase 6)   | **aprovado**                                                             |
| Prettier, ESLint, typecheck dos 5 pacotes, build de produção   | **sem erros** (`pnpm check` com saída 0, no código `6570d87`)            |

O E2E completo e o `pnpm check` finais foram executados no mesmo código (`6570d87`); o teste de
backup foi executado depois da última mudança de banco/script da fase.

| Cenário exigido                          | Onde                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. Login persistente                     | `tablets.test.ts` (sessão válida no dia seguinte; revogação → 401), `devices.test.ts`          |
| 2. Tela Meu dia                          | `tablets.spec.ts` (tablet e celular)                                                           |
| 3. Ordenação por prioridade              | `tablets.test.ts` (em execução → liberada urgente → programada → bloqueada), `shared`          |
| 4. Tarefa em execução                    | `tablets.test.ts`, `tablets.spec.ts` (bloco "Em execução")                                     |
| 5. Tarefa bloqueada                      | `tablets.test.ts`, `production.spec.ts` ("Ainda não liberada — por quê")                       |
| 6. Detalhes técnicos                     | `tablets.test.ts` (tecido, espuma, histórico técnico), `tablets.spec.ts`                       |
| 7. Proteção de dados financeiros         | `tablets.test.ts` (sem preço/valor/banco; histórico sem valores), `tablets.spec.ts` (sem "R$") |
| 8–11. Início, pausa, retomada, conclusão | `tablets.test.ts`, `tablets.spec.ts`, `production.spec.ts`                                     |
| 12. Registro de andamento                | `tablets.test.ts` (etapa, próximo passo, foto; percentual opcional), `tablets.spec.ts`         |
| 13. Notificações persistentes            | `tablets.test.ts` (todos os tipos), backup/restauração                                         |
| 14. Leitura de notificações              | `tablets.test.ts` (uma, todas, de outra pessoa → 404), `tablets.spec.ts`                       |
| 15. Atualização em tempo real            | `tablets.test.ts` (WebSocket), `tablets.spec.ts` (liberação e aviso no celular sem recarregar) |
| 16. Reconexão                            | `tablets.test.ts` (aviso recuperado), `tablets.spec.ts` (queda de rede e reconciliação)        |
| 17. Reprogramação pelo gestor            | `tablets.test.ts`, `tablets.spec.ts` (pelo painel → aviso no celular)                          |
| 18. Permissões                           | `tablets.test.ts` (ações, detalhe, fotos, materiais de outro → 403), `tablets.spec.ts`         |
| 19. Concorrência                         | `tablets.test.ts` ("todas lidas" simultâneas, dois "iniciar"), testes da Fase 5                |
| 20. Regressão das Fases 1 a 5            | todas as suítes anteriores executadas e aprovadas                                              |

## 11. Defeitos encontrados e corrigidos

1. **Avisos em excesso** (encontrado nas capturas): a publicação gerava um "Nova tarefa atribuída" por
   tarefa (9 para o Márcio), escondendo os avisos úteis. Agora publicação e inclusão de OS numa
   semana publicada geram um **resumo por pessoa** ("Programação … publicada: N tarefa(s) para você,
   M liberada(s)"), e "Tarefa liberada" continua individual para o que já pode começar. Testado.
2. **Liberação causada pelo próprio funcionário não avisava**: a regra "quem fez a ação não é
   avisado" impedia o João de receber "Tarefa liberada" da própria próxima tarefa. A liberação passou
   a avisar sempre o responsável.
3. **Título próprio escondido no cartão** (E2E completo): o ajuste que evitava repetir "Preparação —
   OS-…/1" escondia também títulos dados pelo gestor ("Revestimento do encosto"). Agora títulos
   gerados mostram etapa e peça; títulos próprios viram o destaque.
4. **Código do motivo no histórico**: a pausa sem observação gravava `AGUARDANDO_ORIENTACAO` como
   nota; passa a gravar o texto em português, e o histórico traduz registros antigos.
5. **Versão desatualizada no E2E**: cancelar a desmontagem reavalia a preparação (nova versão); o
   teste passou a reler a tarefa antes de alterá-la (comportamento correto do sistema).
6. **Typecheck do `pnpm check` inicial**: os primeiros arquivos novos (ainda não ligados) foram criados
   antes de rodar a verificação de partida; registrado na seção 2, testes executados à parte.
7. Asserções da Fase 5 ajustadas à nova tela inicial (sem bloco "Minhas tarefas"; cartões duplicados
   em "Próxima tarefa liberada" e na lista; último andamento estruturado).

## 12. Pendências

- **Presença ("Cheguei"/encerrar expediente)**, central de atenção completa, ajuda e ocorrências:
  não implementadas (Fase 7+). A pausa por impedimento já gera `production.task_impediment` para
  essa integração.
- **Materiais por tarefa** depende de o gestor vincular os materiais; sem vínculo, a regra continua
  conservadora (OS inteira). Uma sugestão automática por tipo de material/etapa fica como evolução.
- Avisos não expiram nem são agrupados; volume baixo esperado (quatro funcionários). Retenção a
  definir com o uso.
- Pendências anteriores continuam registradas: estorno de recebimento de peças (Fase 2) e saldo de
  pedido de compra que não será entregue (Fase 4).
- Nenhum deploy foi feito.

## 13. Evidências visuais

Capturas (dados fictícios) em [`docs/evidencias/fase-6/`](evidencias/fase-6/): Meu dia no tablet do
João, detalhe com a tarefa pausada por impedimento, aviso de sem conexão, Meu dia e avisos no
celular do Márcio e a tarefa em execução no celular.

## 14. Próximos passos (aguardando autorização)

1. Fase 7 — presença operacional e central de atenção (somente após autorização), aproveitando
   `production.task_impediment` e a caixa de avisos.
2. Sugestão automática de materiais por etapa a partir dos modelos.
3. Executar o CI no GitHub e definir hospedagem (nenhum deploy realizado).
