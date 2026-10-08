# Fase 3 — Medições e solicitações de materiais: relatório de entrega

Data: 08/10/2026

## 1. Branch e SHAs

|                                |                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Branch                         | `claude/cenario-gestao-fase-1-zf3bj2` (branch designada para o desenvolvimento)      |
| SHA inicial (fim da Fase 2)    | `6382b5e`                                                                            |
| Commits da Fase 3              | `7fa3d73` (API, banco e testes de integração) · `29b7d1a` (telas, E2E, documentação) |
| SHA final do código verificado | `29b7d1a` — este relatório é o commit seguinte                                       |

## 2. Inspeção inicial e inventário reaproveitado

Inspeção antes de qualquer alteração: repositório limpo em `6382b5e`, migrations em dia,
`pnpm check` aprovado (97 testes de API, 13 do pacote compartilhado, 3 da web). Nada da Fase 3
existia; o que já havia foi **reaproveitado, não recriado**:

| Já existia (Fases 1–2)                                                                       | Uso na Fase 3                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sessões, permissões por rota (`config.access`), CSRF, idempotência, `version` + `FOR UPDATE` | Todas as rotas novas                                                         |
| Auditoria imutável, outbox `domain_events`, hub WebSocket com reenvio após reconexão         | Eventos `measurement.*` e `material_request.*`                               |
| OS técnica com itens individuais, `measurements` (JSON) por peça e histórico técnico         | O envio da medição grava as medidas na peça e uma revisão `MEDICAO` da OS    |
| `material_requirements` (materiais previstos por OS, tecido sempre exclusivo)                | Ampliada: recebe as necessidades **aprovadas** (`SOLICITACAO_APROVADA`)      |
| Permissão `medicoes.extraordinarias`, dia de medição na configuração da empresa (sexta)      | Rótulo "Executar medições atribuídas"; regra da rotina usa o dia configurado |
| Fotos (`attachments`) com política por registro                                              | Executor da medição vê as fotos da OS **da sua** medição                     |
| Componentes de UI (Dialog, Field, Tabs, Badge, Section), PhotoGallery, tablet com PIN        | Telas do painel e área do tablet                                             |

## 3. Funcionalidades implementadas

- **Medição de rotina (sexta):** o gestor gera a medição de uma peça ou da OS inteira, para si,
  com prazo no dia de medição configurado; mede pelo painel no mesmo editor do tablet.
- **Medição extraordinária delegável:** exige motivo; atribuída pelo gestor a quem tem
  "Executar medições atribuídas" (ex.: Ricardo, Márcio); responsável, data da solicitação,
  prazo, motivo, quantidades, horário de conclusão e histórico registrados. Reatribuição e
  cancelamento com motivo.
- **Ninguém altera a medição de outra pessoa** — nem o gestor (ele reatribui, cancela ou ajusta
  as quantidades pela revisão auditada depois do envio).
- **Medidas por peça** (rótulos livres em cm, decimais com vírgula) com totais por peça e
  **total consolidado da OS**.
- **Materiais estruturados, sem preço nem fornecedor:**
  - Tecido: nome/referência, cor, referência do fornecedor, metros, peça/OS, observação —
    sempre **compra exclusiva da OS** (nunca aproveitado de outra OS).
  - Espuma: tipo/densidade e espessura obrigatórias, comprimento/largura, placas/peças/m².
  - Outros (MDF, ferragens, cola, grampos): m, m², placas, peças, unidades, embalagens.
  - Unidade × tipo validada; inteiro fora de m/m²; até 3 casas decimais (cliente, API e banco).
- **Solicitação de materiais:** Rascunho → Enviada → Em revisão → Aprovada para compra /
  Devolvida → (corrigida e reenviada) / Cancelada. Rascunho editável livremente; após o envio,
  só pelo fluxo de revisão. **Aprovar = quantidades conferidas** (não comprado, não recebido;
  não libera produção). Reabrir uma aprovação exige motivo e retira as necessidades aprovadas.
- **Histórico imutável** de cada medição com cópia dos itens a cada envio, revisão (antes/
  depois), aprovação, devolução e reabertura.
- **Planejamento de sexta** com período selecionável e checklist; distingue solicitado ×
  aprovado; "comprado" e "recebido" aparecem como **Fase 4** (nenhum estado fictício).
- **Lista consolidada de materiais aprovados:** tecidos por OS; materiais comuns somados entre OS
  com a origem de cada quantidade (OS, peça, medição); tela, **copiar** e **CSV** (`;`,
  vírgula decimal, BOM UTF-8).
- **Tablet — Medições atribuídas:** contador na tela inicial, lista (devolvidas em destaque),
  dados técnicos da OS e fotos, editor em etapas com botões grandes, salvar rascunho, enviar,
  ver o motivo da devolução, corrigir e reenviar. Sem valores ou dados comerciais.

## 4. Tabelas e migrations

Migration `20261008200000_medicoes_materiais` — **aditiva** (aplicada sobre o banco de
desenvolvimento com dados das Fases 1–2, sem apagar nada):

- Novas tabelas: `measurements`, `measurement_pieces`, `material_requests`,
  `material_request_items`, `measurement_revisions`; enums `measurement_status`,
  `material_request_status`, `material_unit`, `material_requirement_origin`.
- `material_requirements` ganhou colunas opcionais: `origin`, `material_request_item_id`
  (único), `unit_code`, `color`, `reference`, `foam_density`, `thickness_cm`, `length_cm`,
  `width_cm`, `approved_at`.
- `domain_events.audience` ampliada de 120 para 400 caracteres (ver defeito 1).
- Restrições: quantidade `NUMERIC(12,3)` > 0; unidade compatível com o tipo; inteiro fora de
  m/m²; tecido somente `EXCLUSIVO_OS`; dimensões positivas; motivo obrigatório na
  extraordinária; coerência de cancelamento e conclusão; versões positivas; necessidade aprovada
  sempre vinculada ao item da solicitação. **Índice único parcial** impede duas medições ativas
  para a mesma peça/OS. Trigger de imutabilidade em `measurement_revisions`. Concessão das novas
  permissões à função Gestor. Índices por responsável/situação, OS e situação/prazo.
- Nenhuma tabela de compras, estoque, programação ou produção foi criada.

## 5. APIs (`/api/v1`)

| Rota                                                                                                                                                    | Acesso                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /measurements` (situação, solicitação, tipo, responsável, OS, cliente, texto, período)                                                             | painel: `medicoes.gerenciar`, `materiais.ver` ou `materiais.aprovar` |
| `GET /measurements/awaiting` (peças aguardando medição)                                                                                                 | idem                                                                 |
| `GET /measurements/assignees` (quem pode receber)                                                                                                       | `medicoes.gerenciar`                                                 |
| `GET /measurements/mine`                                                                                                                                | painel ou tablet: `medicoes.extraordinarias` ou `medicoes.gerenciar` |
| `GET /measurements/:id` (executor só a sua)                                                                                                             | qualquer das permissões acima                                        |
| `POST /measurements` (idempotente), `POST /:id/assign`, `POST /:id/cancel`                                                                              | `medicoes.gerenciar` (painel)                                        |
| `POST /:id/start`, `PUT /:id/draft`, `POST /:id/submit` (idempotente)                                                                                   | somente o responsável (tablet ou painel)                             |
| `POST /:id/request/review`, `PUT /:id/request/items`, `POST /:id/request/approve` (idempotente), `POST /:id/request/return`, `POST /:id/request/reopen` | `materiais.aprovar` (painel)                                         |
| `GET /materials/consolidated`, `GET /materials/consolidated.csv`, `GET /materials/planning`                                                             | painel: `materiais.ver`, `materiais.aprovar` ou `medicoes.gerenciar` |

Todas com validação zod, mensagens em português, auditoria, evento persistente, `version`
(409 em conflito; decisões da solicitação usam a versão da solicitação) e bloqueio de linha.
Ajuste em rota existente: `PUT /service-orders/:id/items/:itemId/measurements` passou a exigir
sessão do painel com `os.gerenciar` (ver seção 12); remover necessidade **aprovada** da OS é
recusado (422).

## 6. Telas administrativas

- **Medições** (`/painel/medicoes`): abas _Aguardando medição_ (por OS, com "Solicitar
  medição" por peça ou "Medir OS inteira"), _Medições_ (filtros por texto/OS/cliente, situação,
  tipo, responsável e período do prazo) e _Aguardando revisão_. Cada linha mostra tipo,
  responsável, prazo (atraso em vermelho), situação e situação dos materiais.
- **Detalhe da medição** (`/painel/medicoes/[id]`): materiais por peça e total da OS, medidas,
  dados (responsável, quem pediu, datas, motivo, link para a OS), histórico; ações conforme
  permissão e estado: medir/continuar, reatribuir, cancelar, iniciar revisão, ajustar
  quantidades (com motivo), aprovar, devolver, reabrir.
- **Solicitar medição** (diálogo, também na OS): rotina × extraordinária, peça ou OS inteira,
  responsável elegível, prazo (sugere o dia de medição), motivo.
- **Planejamento de sexta** (`/painel/planejamento`): período, checklist de 6 itens, tabela
  Solicitado / Aprovado / Comprado (Fase 4) / Recebido (Fase 4), listas do período.
- **Materiais aprovados** (`/painel/materiais`): tecidos, espumas e outros; destino (exclusivo
  da OS × estoque comum) e origens; copiar lista; exportar CSV; filtro por data de aprovação.
- **OS**: botão "Solicitar medição"; aba Materiais com as medições da OS e o selo "Aprovado
  para compra" × "Previsão manual".
- Navegação: Medições, Planejamento de sexta e Materiais aprovados; o item futuro passou a
  "Compras e estoque". Telas conferidas em desktop (1440 px) e celular (390 px, sem rolagem
  horizontal).

## 7. Telas do tablet

Tela inicial com o bloco **Medições atribuídas** e contador em tempo real → lista (devolvidas
primeiro, com "Devolvida — corrigir e reenviar"; enviadas recentes com a situação) → detalhe
(motivo, peças com serviço, tecido, espumas, medidas atuais, observações técnicas e fotos da peça
e da OS) → editor em 5 etapas: **Medidas**, **Tecidos**, **Espumas**, **Outros**, **Revisar e
enviar**, com campos e botões ampliados (h-14/h-16), poucos campos por etapa, rascunho e envio
fixos no rodapé. Otimizado para 1280×800 (10–11"). Nenhum valor financeiro ou dado comercial.

## 8. Permissões

| Permissão                                                     | Uso                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `medicoes.extraordinarias` — Executar medições atribuídas     | Receber e executar medições delegadas (tablet ou painel) |
| `medicoes.gerenciar` — Gerenciar e delegar medições (crítica) | Criar/atribuir/reatribuir/cancelar; rotina de sexta      |
| `materiais.ver` — Ver solicitações e lista de materiais       | Leitura de medições, planejamento e lista consolidada    |
| `materiais.aprovar` — Revisar e aprovar materiais (crítica)   | Revisão, ajuste, aprovação, devolução e reabertura       |

O Gestor tem todas (migração + garantia em tempo de execução). Tapeceiros não recebem nada por
padrão: o gestor concede "Executar medições atribuídas" individualmente.

## 9. Eventos em tempo real

`measurement.assigned`, `measurement.started`, `measurement.updated` (rascunho),
`measurement.completed`, `measurement.cancelled`, `material_request.submitted`,
`material_request.in_review`, `material_request.revised`, `material_request.approved`,
`material_request.returned`, `material_request.reopened`. Audiência: gestão (qualquer das três
permissões) **e** o responsável (`user:<id>`); reatribuição avisa o antigo e o novo responsável.
Payload só com identificadores, códigos e situações. Recuperação após reconexão pelo mecanismo
existente (reenvio por `seq` ou `resync`), testada.

## 10. Testes executados e resultados (08/10/2026, PostgreSQL 16 real)

| Suíte                                                         | Resultado                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| API — integração (Vitest, 14 arquivos)                        | **114/114** (97 das Fases 1–2 + 17 da Fase 3)                            |
| Pacote compartilhado — unitários                              | **19/19** (13 + 6 novos)                                                 |
| Web — unitários                                               | **6/6** (3 + 3 novos)                                                    |
| E2E Playwright (build de produção, painel e tablet separados) | **11/11** (9 das Fases 1–2 + 2 novos), em 2 execuções finais             |
| Backup + restauração (agora com dados da Fase 3)              | **aprovado** (contagens idênticas, decimais e imutabilidade preservados) |
| Prettier, ESLint, typecheck dos 5 pacotes, build de produção  | **sem erros**                                                            |

| Cenário exigido                                                       | Onde                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Rotina de sexta pelo gestor (mede por peça, envia, grava na OS)       | `measurements.test.ts` (rotina), `measurements.spec.ts` (rotina pelo painel)           |
| Rotina não delegável a tapeceiro                                      | `measurements.test.ts`                                                                 |
| Extraordinária delegada a Ricardo / a Márcio                          | `measurements.test.ts`, `measurements.spec.ts`                                         |
| Funcionário não autorizado; autorização retirada                      | `measurements.test.ts`                                                                 |
| Ninguém altera a medição de outro (Márcio e o próprio gestor)         | `measurements.test.ts`                                                                 |
| Tablet sem dados comerciais                                           | `measurements.test.ts`, `measurements.spec.ts`                                         |
| OS inexistente, peça de outra OS, medição duplicada                   | `measurements.test.ts` (Integridade)                                                   |
| Unidades, decimais, tecido por OS, espuma com densidade               | `measurements.test.ts`, `shared/measurements.test.ts`, `web/measurements.test.ts`, E2E |
| Revisão com antes/depois, aprovação sem compra nem produção           | `measurements.test.ts`                                                                 |
| Devolução, correção e reenvio com histórico das duas versões          | `measurements.test.ts`, `measurements.spec.ts`                                         |
| Concorrência: aprovar × devolver simultâneos; rascunho obsoleto       | `measurements.test.ts`                                                                 |
| Consolidação (tecido por OS, comuns agrupados com origem) e CSV       | `shared/measurements.test.ts`, `measurements.test.ts`, `measurements.spec.ts`          |
| Planejamento: solicitado × aprovado, sem compra/recebimento           | `measurements.test.ts`, `measurements.spec.ts`                                         |
| Tempo real: tablet recebe atribuição; painel recebe envio; isolamento | `measurements-realtime.test.ts`, `measurements.spec.ts` (sem recarregar)               |
| Reconexão                                                             | `measurements-realtime.test.ts` (devolução feita com o tablet offline é recuperada)    |
| Fotos da OS para o executor (só da sua medição)                       | `measurements-realtime.test.ts`                                                        |
| Migrations                                                            | `migrations.test.ts` (banco do zero + tabelas da Fase 3); teste de backup              |
| Regressão das Fases 1 e 2                                             | todas as suítes anteriores executadas e aprovadas                                      |

## 11. Defeitos encontrados e corrigidos

1. **Erro 500 ao criar medição:** a audiência combinada do evento (três permissões + usuário)
   excedia `domain_events.audience VARCHAR(120)` → coluna ampliada para 400 na própria migration.
2. **Peça aparecia como "aguardando medição"** depois de uma medição enviada só com materiais →
   a regra passou a considerar medições pendentes, em andamento ou concluídas.
3. **Gestor podia sobrescrever o rascunho de uma medição delegada** (violava "ninguém altera a
   medição de outra pessoa") → execução restrita ao responsável; teste adicionado.
4. **Linhas-modelo vazias bloqueavam o envio** ("Altura" sem valor numa peça não medida gerava
   erro) — encontrado pelo E2E da rotina → linhas sem valor são ignoradas.
5. Layout: tabela do planejamento cortada numa coluna estreita e linhas da lista de medições
   espremidas no celular → corrigidos após revisão das capturas.
6. Commit intermediário com erros de tipo nos testes (indexação com `noUncheckedIndexedAccess`)
   → corrigido antes de qualquer envio; `typecheck` agora faz parte da verificação final.

## 12. Pendências, riscos e decisões

- **Mudança deliberada de regra da Fase 2:** o registro direto de medidas na OS deixou de
  aceitar tapeceiros (`medicoes.extraordinarias`); agora é só do painel com `os.gerenciar`. O
  teste da Fase 2 foi atualizado com essa justificativa. Tapeceiros medem pela área do tablet.
- **CI do GitHub** não executado neste ambiente; nenhum deploy.
- Medição atribuída a quem perde a permissão fica bloqueada até ser reatribuída (testado); não
  há reatribuição automática.
- A lista consolidada considera OS abertas; OS canceladas saem da lista (as necessidades
  ficam no histórico).
- Comprado/recebido, estoque e alocação de materiais são da Fase 4 — não existem estados
  fictícios. `canStartProduction` continua `false`.
- E2E somente em Chromium; números `MD-` podem ter lacunas (sequência do banco).

## 13. Evidências

E2E `measurements.spec.ts` (servidores reais, painel e tablet em navegadores separados): o
gestor concede a Ricardo "Executar medições atribuídas", vincula o tablet, solicita uma
medição extraordinária com motivo; o contador do tablet muda de 0 para 1 **sem recarregar**;
Ricardo vê o motivo e os dados técnicos (sem valores), mede a peça (205,5 cm), adiciona tecido
(11,5 m), salva rascunho, tenta espuma sem densidade (erro), corrige e envia; o painel recebe o
envio; o gestor inicia a revisão e devolve com motivo; o tablet mostra "Devolvida — corrigir e
reenviar" com o motivo; Ricardo altera para 12 m e reenvia; o gestor aprova; o histórico mostra
devolução e reenvio; o tablet vê "Aprovada para compra"; a lista consolidada mostra "Linho
Bege — Exclusivo OS — 12 metros" e o CSV contém a linha; o planejamento mostra compra/
recebimento como Fase 4; a OS mostra o material como "Aprovado para compra". Segundo E2E: rotina
de sexta pelo painel (responsável e prazo sugeridos, grampos em embalagens recusam 1,5).

Capturas (dados fictícios) em [`docs/evidencias/fase-3/`](evidencias/fase-3/): aguardando
medição, solicitar medição, revisão, aprovada, tablet (início com contador, lista, detalhe,
etapa de tecido, revisar e enviar, aprovada), planejamento, materiais aprovados e lista no
celular.

## 14. Próximos passos (Fase 4 — aguardando autorização)

1. Compras a partir das necessidades aprovadas (`material_requirements` com origem
   `SOLICITACAO_APROVADA`): tecido por OS, comuns pelo estoque; preço e fornecedor entram aqui.
2. Estoque de materiais comuns e conferência de chegada (qualquer funcionário autenticado),
   preenchendo as colunas "Comprado" e "Recebido" do planejamento.
3. Prontidão de materiais da OS calculada a partir da chegada — sem antecipar a programação.
4. Executar o CI no GitHub e definir hospedagem.
