# Fase 10 — Controle de qualidade, correções, embalagem, expedição e logística: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)      |
| SHA inicial (fim da Fase 9)    | `62ed998` (relatório) — último código da Fase 9: `85ff353`                           |
| Commits da Fase 10             | `eceaac3` (banco, domínio, API, testes de API), `d0c6308` (telas, E2E, documentação) |
| SHA final do código verificado | `d0c6308` — este relatório é o commit seguinte (só o relatório)                      |

## 2. Estado inicial

- Branch correta, árvore limpa, `HEAD` = `origin` = `62ed998`. PostgreSQL 16 do contêiner ativo.
- Relatórios das Fases 1–9 lidos; schema, migrations, motor de liberação, tarefas e tablets,
  presença, ajuda/reprogramação, ocorrências/central de atenção, anexos, retiradas, recebimentos,
  OS e revisões técnicas, permissões e eventos inspecionados.
- **Linha de base antes de qualquer alteração**: `pnpm check` aprovado — API **215/215**,
  compartilhado **38/38**, web **6/6**. E2E completo: **15 aprovados, 1 falhou, 1 não executou**
  (`tablet-sync.spec.ts` › "sinais de sincronização e reconciliação": o tablet já estava na
  sequência 148 e o painel lera 141 — corrida do próprio teste entre duas leituras; ver §11).
- **Divergências registradas:**
  1. Entidade sugerida `QualityCorrection`: a correção é uma **tarefa de produção** `CORRECAO`
     ligada à inspeção (`production_tasks.inspection_id`) — reusa Meu dia, Iniciar/Concluir,
     observação obrigatória, histórico, revisão da programação e disponibilidade. Idem para a
     embalagem (tarefa `EMBALAGEM` + `packaging_records`).
  2. `ItemLocationHistory` foi implementada como `item_location_events` (imutável) + localização
     atual na peça; `DeliverySchedule` como `deliveries` + `delivery_items`.
  3. Recebimentos físicos são imutáveis desde a Fase 2 (trigger): a correção é uma tabela própria
     (`receipt_corrections`) que ajusta a quantidade recebida do item do pedido; o original nunca
     muda.
  4. `PickupTeam` (Fase 2) foi reutilizado nas entregas; a logística terceirizada ganhou função
     própria (`logistica_terceirizada`) — não existia acesso para André e Izaías.
  5. O E2E do painel verificava "Qualidade" como módulo indisponível; com a entrega, passou a
     verificar "Financeiro" (fase futura) como indisponível e Qualidade/Expedição como links.

## 3. Estruturas reutilizadas

- Motor de liberação e tarefas (Fase 5/6): correção e embalagem são tarefas (isentas de
  "programação publicada", como apoio e resolução); conclusão com observação; histórico.
- Revisão da programação publicada `reviseIfPublishedBy` e `planning_actions` (Fases 5/8).
- Motor de distribuição da Fase 8 (`evaluateCandidates`/`pickCandidate`) para a embalagem.
- Presença do dia (Fase 7) para ausência do inspetor e disponibilidade de quem embala.
- Revisões técnicas da OS (Fase 2) e medições (Fase 3) como gatilho da invalidação da aprovação.
- Retiradas (`PickupTeam`, `pickup_events`) e recebimentos (Fase 2); `refreshOrderStatus`,
  `itemAllocations`; proteção de OS cancelada (`protectCancelledServiceOrder`, Fase 5).
- Central de atenção (Fase 9) — novos tipos `QUALIDADE` e `LOGISTICA`.
- Anexos privados, avisos persistentes com deduplicação, eventos/WebSocket com reenvio,
  auditoria, idempotência e versão.

## 4. Funcionalidades

Fluxo garantido: **produção concluída → inspeção → aprovação ou correção → embalagem → pronto
para entrega → agendamento → entrega**. Nenhuma peça é liberada sem aprovação e embalagem.

- **Inspeção automática**: quando todas as tarefas obrigatórias da peça (da peça e da OS inteira;
  sem apoio, resolução, correção ou embalagem) estão concluídas, nasce a inspeção (IQ-…) para o
  Thiago (inspetor principal configurável; sem configuração, quem tem a competência de inspeção).
- **Responsabilidade**: Thiago ausente (folga/férias/ausência) → inspeção sem inspetor, gestor
  avisado ("inspeção pendente") para designar substituto autorizado (permissão "Inspecionar
  peças") ou aprovar diretamente. Thiago executou o serviço → idem; ele só decide com autorização
  explícita e justificada do gestor (auditada). Quem não é o inspetor designado não decide.
- **Checklists configuráveis**: Sofás (Estrutura, Fixações, Espumas, Conforto, Costuras,
  Revestimento, Acabamento, Limpeza, Conformidade com a OS), Cabeceiras (Medidas, Estrutura,
  Espuma, Revestimento, Acabamento, Fixações, Preparação para instalação), Cadeiras e poltronas
  (Estrutura, Estabilidade, Espumas, Costuras, Acabamento, Limpeza) e Outras peças; cada item pode
  valer só para alguns tipos de serviço (ex.: troca de tecido não pede estrutura nem espumas). A
  inspeção guarda a própria cópia.
- **Inspeção no tablet** (Thiago): OS, peça, tipo de serviço, prazo, prioridade, fotos, checklist
  e histórico de produção; iniciar, marcar itens, registrar defeitos, fotos, aprovar e reprovar
  (motivo obrigatório). A aprovação registra inspetor, data, hora, dispositivo, versão técnica da
  peça e revisão da OS.
- **Reprovação**: defeitos preservados; tarefa de correção (responsável = principal da peça ou
  escolhido; prioridade alta; prazo), embalagem bloqueada, aviso "serviço reprovado" e "correção
  atribuída", revisão da programação e entrada provisória rebaixada. Reprovações nunca são
  apagadas nem alteradas. Correção concluída → **nova inspeção obrigatória** (nada é aprovado
  automaticamente).
- **Alteração técnica após aprovação** (regra explícita): mudança nas especificações da peça ou
  novas medidas invalidam a aprovação (histórico preservado como "invalidada"), invalidam a
  embalagem e criam a reverificação; uma aprovação antiga nunca libera peça alterada.
- **Embalagem**: depois da aprovação, tarefa para o João quando disponível, depois o Thiago; o
  tapeceiro só com autorização do gestor; respeita competência, presença e agenda. Registra
  responsável, início, conclusão, fotos opcionais, proteção, local e observações; não conclui sem
  a aprovação vigente.
- **Localizações** configuráveis (Recebimento, Aguardando produção, Mesa de produção, Área de
  testes, Embalagem, Expedição, Em transporte, Entregue); movimentação opcional; etiqueta/QR em
  texto (`CENARIO:PECA:OS-…/n`) com leitura pela API, sem hardware.
- **Pronto para entrega**: as cinco condições (tarefas, inspeção aprovada, correções encerradas,
  embalagem concluída, sem bloqueio de expedição); aviso único ao gestor; nunca agenda sozinho.
- **Agenda** (só o gestor): cliente, endereço, peças, data, janela, equipe/responsável,
  instalação, instruções, observações e situação; agrupada por data e região (cidade/bairro), sem
  rota nem horário inventados. Definitiva só com peças liberadas; pré-agendamento **provisório**
  (sem confirmação ao cliente) para peças ainda não liberadas, confirmado depois.
- **Logística terceirizada** (André e Izaías, função própria, PIN + dispositivo vinculado): veem só
  as próprias retiradas e entregas (endereço, contato operacional, peças, data, horário,
  instruções, situação) — sem valores ou dados comerciais.
- **Entrega e instalação**: saída, transportador, chegada, peça a peça (entregue / divergência /
  não entregue), instalação (completa ou incompleta), fotos, observações e confirmação da
  conclusão; nunca "entregue" só porque saiu. Tentativa frustrada (tentativas, ocorrência, peça
  volta à expedição) e reagendamento pelo gestor.
- **Ocorrências logísticas** (cliente indisponível, peça danificada, endereço incorreto, atraso,
  instalação incompleta, divergência, outro) com responsável, situação e histórico; peça danificada
  e divergência bloqueiam a expedição; integradas à central de atenção.
- **Devolução e cancelamento**: devolução ao cliente com motivo, responsável, data e confirmação;
  confirmação encerra tarefas, inspeções, embalagens e entregas da peça; OS sem peças restantes é
  cancelada com a proteção existente (tarefas e reservas). OS cancelada limpa inspeções,
  embalagens e entregas abertas. Correção auditável do recebimento (sem apagar o original),
  recusada quando deixaria peças em OS ou devolvidas sem cobertura.

## 5. Banco e migrations

Migration aditiva `20261015000000_qualidade_logistica` (nenhuma migration antiga alterada,
nenhum dado apagado):

- Tabelas: `quality_templates`, `quality_template_items`, `quality_inspections`,
  `quality_inspection_items`, `quality_events`, `packaging_records`, `item_locations`,
  `item_location_events`, `deliveries`, `delivery_items`, `delivery_events`,
  `logistics_occurrences`, `logistics_occurrence_events`, `piece_returns`, `piece_return_lines`,
  `receipt_corrections`.
- Colunas novas: `service_order_items.fulfillment_stage` e `current_location_id`,
  `production_tasks.inspection_id`, `commercial_order_items.returned_quantity`,
  `pickup_requests.logistics_user_id`, `company_settings.quality_inspector_user_id`.
- Enums: `inspection_status`, `packaging_status`, `delivery_status`; `production_activity` +
  `CORRECAO`, `EMBALAGEM`; `attachment_entity` + `QUALITY_INSPECTION`, `PACKAGING`, `DELIVERY`,
  `LOGISTICS_OCCURRENCE`.
- Restrições: CHECKs de motivo, decisão (aprovada com revisão da OS; reprovada com motivo),
  invalidação, resultado do checklist ("não se aplica" só em item opcional), proteção, embalagem
  concluída com proteção e local, etapa, janela, entrega concluída/cancelada, situação de peça da
  entrega, tipos e situações de ocorrência, alvo da ocorrência, devolução confirmada, quantidade
  devolvida ≤ recebida, correção ≠ anterior, vínculo de inspeção só em correção/embalagem.
- Índices únicos parciais: uma inspeção aberta por peça, uma embalagem aberta por peça, uma
  entrega ativa por peça; índices por situação, data, responsável e peça.
- Triggers: imutáveis (`quality_events`, `item_location_events`, `delivery_events`,
  `logistics_occurrence_events`, `receipt_corrections`); sem exclusão (`quality_inspections`,
  `packaging_records`, `deliveries`, `logistics_occurrences`, `piece_returns`); inspeção decidida
  não muda (aprovada só pode virar "invalidada"); checklist de inspeção decidida bloqueado.
- Dados: 8 localizações, função `logistica_terceirizada` (`producao.acessar`,
  `logistica.executar`), permissões novas para o gestor e `qualidade.inspecionar` para
  "Cabeceiras, reparos e qualidade". Seed: checklists iniciais, localizações e André/Izaías sem PIN.
- Concorrência: coluna `version` (409) e `SELECT … FOR UPDATE` em inspeções, embalagens, entregas,
  ocorrências, devoluções e peças.

## 6. APIs (`/api/v1`)

| Área            | Rotas                                                                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspeções       | `GET /quality/inspections` (`scope=open\|all\|mine`), `GET /quality/inspections/:id`, `POST …/:id/start`, `PUT …/:id/items/:itemId`, `POST …/:id/approve`, `POST …/:id/reject`, `POST …/:id/assign` (gestor), `GET /quality/inspectors` |
| Configuração    | `GET/PUT /quality/settings` (inspetor principal), `GET/POST /quality/templates`, `PUT /quality/templates/:id`                                                                                                                           |
| Embalagem       | `GET /packaging`, `GET /packaging/:id`, `POST /packaging/:id/assign` (gestor), `POST /packaging/:id/complete`                                                                                                                           |
| Peças e locais  | `GET /pieces`, `GET /pieces/:id` (prontidão + histórico), `GET /pieces/by-label?code=`, `POST /pieces/:id/move`, `GET/POST /locations`, `PUT /locations/:id`                                                                            |
| Entregas        | `GET/POST /deliveries`, `GET/PUT /deliveries/:id`, `POST …/:id/confirm`, `…/cancel`, `…/depart`, `…/arrive`, `…/items`, `…/install`, `…/complete`, `…/frustrate`                                                                        |
| Logística       | `GET /logistics/jobs` (visão restrita), `GET /logistics/people`, `PUT /pickups/:id/logistics`, `POST /logistics/pickups/:id/step`                                                                                                       |
| Ocorrências     | `GET/POST /logistics-occurrences`, `GET …/:id`, `POST …/:id/assign`, `…/resolve`, `…/cancel`                                                                                                                                            |
| Devoluções      | `GET/POST /returns`, `GET /returns/:id`, `POST …/:id/confirm`, `…/cancel`                                                                                                                                                               |
| Recebimentos    | `POST /receipt-lines/:id/corrections`, `GET /receipts/:id/corrections` (linhas do recebimento ganharam `id` e `correctedQuantity`)                                                                                                      |
| Central/tarefas | `GET /attention` com itens `QUALIDADE`/`LOGISTICA`; tarefas ganham `qualityFor` (defeitos da correção, embalagem)                                                                                                                       |

Todas com autenticação, permissão no servidor, validação zod (400), regras de negócio (422),
versão (409 `VERSION_CONFLICT`), conflito (409) e chave de idempotência nas ações repetíveis.

## 7. Telas

- **Tablet**: bloco **Inspeções** (Thiago) com contador, lista por prioridade/prazo e detalhe com
  checklist em botões grandes, defeito obrigatório no "não conforme", foto, histórico de produção,
  aprovar/reprovar; nas tarefas, faixa da correção com os defeitos e **Concluir embalagem**
  (proteção, local, observações, foto); André/Izaías: **Minhas entregas e retiradas** (saída,
  chegada, peças, instalação, tentativa frustrada, ocorrência). Nada de valores.
- **Painel**: `/painel/qualidade` (inspeções abertas, histórico, embalagens com designação,
  checklists, inspetor principal e localizações), `/painel/qualidade/inspecoes/[id]` (designar
  substituto/autorizar executor, decidir, fotos), `/painel/entregas` (agenda por data e região,
  prontas para entrega com agendamento definitivo/provisório, expedição com localização,
  pré-agendamento e ocorrência), `/painel/entregas/[id]` (confirmar, reagendar, cancelar,
  histórico, fotos), `/painel/entregas/ocorrencias/[id]` (responsável, resolver, cancelar),
  `/painel/devolucoes` (registrar, confirmar, cancelar) e "Corrigir" em Recebimentos.

## 8. Permissões

| Permissão               | Quem                   | O que permite                                                                        |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `qualidade.inspecionar` | Thiago (e substitutos) | Inspeções designadas: conferir, fotografar, aprovar/reprovar (sem autoaprovação)     |
| `qualidade.gerenciar`   | Gestor                 | Todas as inspeções, decisão direta, substitutos, checklists, localizações, embalagem |
| `entregas.ver`          | Gestor (ou consulta)   | Peças prontas, agenda e ocorrências logísticas                                       |
| `entregas.gerenciar`    | Gestor                 | Agendar/confirmar/reagendar/cancelar entregas e tratar ocorrências                   |
| `logistica.executar`    | André, Izaías          | Só as próprias retiradas e entregas, visão restrita                                  |
| `devolucoes.gerenciar`  | Gestor                 | Devoluções e correção de recebimento                                                 |

## 9. Eventos

- Domínio (WebSocket com reenvio após reconexão): `quality.inspection_created`,
  `quality.inspection_updated`, `quality.inspection_approved`, `quality.inspection_rejected`,
  `quality.inspection_invalidated`, `quality.template_changed`, `packaging.updated`,
  `item.stage_changed`, `item.location_changed`, `delivery.updated`,
  `logistics.occurrence_updated`, `return.updated`, `receipt.corrected`; audiências por permissão
  e por usuário (inspetor, quem embala, responsável pela entrega).
- Avisos persistentes, deduplicados por fato: inspeção pendente, inspeção atribuída, serviço
  reprovado, correção atribuída, correção concluída, nova inspeção, aprovação invalidada,
  embalagem liberada, serviço pronto para entrega, entrega agendada, entrega/retirada atribuída,
  entrega concluída e ocorrência logística.

## 10. Testes e resultados (08/10/2026, PostgreSQL 16 real)

> **Nota (acrescentada na Fase 11, 09/10/2026):** este relatório foi entregue com esta seção e a
> seguinte ainda como marcadores de texto. Os números abaixo foram **medidos no início da Fase 11
> sobre o mesmo código** (`b928db3`, que só acrescentou este relatório a `d0c6308`), em PostgreSQL
> 16 real:

- `pnpm check` (formatação, lint, tipos e testes): **aprovado** — API **242/242** (inclui os 27
  testes de `quality.test.ts`), compartilhado **45/45**, web **6/6**.
- E2E completo (painel + tablets do Ricardo, Thiago e João + celular do André): **18/18**
  aprovados.

## 11. Defeitos corrigidos

> **Nota (Fase 11):** a lista de defeitos corrigidos durante a Fase 10 não foi registrada na
> entrega e não pode ser reconstruída com segurança a partir do repositório; por isso não é
> listada aqui. Os commits `eceaac3` e `d0c6308` contêm todas as alterações da fase.

## 12. Pendências

- Devolução de peças recebidas **fora de OS** está na API (linhas com quantidade sem peças de
  OS), mas a tela registra devoluções escolhendo peças de OS; a devolução parcial de uma peça de
  OS com quantidade > 1 é feita inteira (a peça da OS é a unidade).
- A situação do pedido comercial continua derivada só do recebimento (não ganhou um estado
  "devolvido"); a devolução fica visível na lista de devoluções e na quantidade devolvida.
- Reservas de material de uma OS parcialmente devolvida continuam ativas (a OS segue com outras
  peças); só a devolução total cancela a OS e libera as reservas.
- Não há integração paga nem leitor de QR dedicado: a etiqueta é texto (pode ser impresso como
  QR em qualquer gerador); não há roteirização automática.
- O tablet ainda exibe o bloco informativo "Ocorrências — disponível na próxima fase" das Fases
  anteriores (verificado pelo E2E da Fase 1); a funcionalidade existe dentro das tarefas desde a
  Fase 9 — ajuste de texto sugerido para a próxima fase.

## 13. Evidências

Capturas geradas pelo E2E da Fase 10 com `E2E_EVIDENCE=1` em `docs/evidencias/fase-10/`:
tablet do Thiago (inspeções, checklist com defeito, aprovação), tablet do Ricardo (correção),
tablet do João (embalagem), painel (prontas para entrega, agenda, entrega concluída, histórico da
qualidade) e celular do André (entrega atribuída e concluída).

## 14. Próximos passos (aguardando autorização)

A Fase 10 está concluída e documentada. **Nada da Fase 11 foi iniciado**; aguardo autorização.
Sugestões para avaliação: financeiro (fora do escopo desta fase), texto do bloco informativo do
tablet, relatórios de qualidade (taxa de reprovação por tipo de defeito) e devolução parcial por
quantidade na tela.
