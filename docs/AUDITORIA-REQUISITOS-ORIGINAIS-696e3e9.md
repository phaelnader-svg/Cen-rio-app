# Auditoria de conformidade — requisitos originais do proprietário × `7b4177b` × `696e3e9`

14/11/2026. Somente leitura: nenhuma alteração, migration ou deploy. **Nenhuma correção será
implementada sem aprovação.**

## Base e método

- **Referência:** `docs/REQUISITOS-ORIGINAIS-PROPRIETARIO.md`. É uma reconstrução do proprietário, não
  uma transcrição.
  - Seção **1.A** = requisitos da reformulação: 77 itens, R1.1–R8.7.
  - Seção **1.B** = histórico: R9–R12.
  - Seção **2** = recomendações do assistente, **não** são requisitos.
  - Os textos dos requisitos abaixo são **resumos** dessa reconstrução, não citações do proprietário.
  - Inventário numerado: `docs/REQUISITOS-ORIGINAIS-INVENTARIO.md`.
- **Versões:** ANTES = `7b4177b` (produção até 14/11); DEPOIS = `696e3e9` (produção atual). A
  produção roda com todos os interruptores no **padrão = ligado** (`module_settings` vazio), e é esse
  o estado avaliado.
- **Evidência no código:** regra do servidor, campos obrigatórios, bloqueios, telas, menu e o padrão
  dos interruptores, nas duas versões. As tabelas completas, com `caminho:linha @sha`, estão em
  `docs/evidencias/auditoria-requisitos-originais/area{1,2,3,4}-*.md`.
- **Evidência funcional:** E2E (Playwright) que percorre o fluxo. A suíte completa rodou **79/79** no
  código de `696e3e9`, numa réplica isolada (`docs/HOMOLOGACAO-FUNCIONAL-CORRECOES-RELATORIO.md`).
  Isso prova os fluxos dos specs, **não** o uso real em produção. Componente, rota, migration ou teste
  de API sozinhos **não** contam como "atendido".
- **Regra aplicada:** um comportamento simples que só aparece depois de **desligar um interruptor**
  conta **contra** o requisito.

## Conclusão

**A reformulação não entregou a simplificação pedida no fluxo normal.** O que se pediu para deixar de
existir continua obrigatório em produção, por três motivos:

1. **Regras do servidor que nunca mudaram:**
   - a OS só nasce depois do recebimento físico (`service-orders/service.ts:54-58`, idêntico nas duas
     versões);
   - o planejamento só aceita OS com peças recebidas (`pre-planning.ts:176-177, 425-426`);
   - a medição exige recebimento (`measurements/routes.ts:101-103`).
2. **Simplificações feitas como interruptores com padrão ligado:**
   - **materiais:** a produção continua travada pelo fluxo formal (medição → solicitação → aprovação
     → compra com fornecedor → recebimento, ou reserva). Os modelos padrão marcam corte, costura,
     montagem e revestimento como "exige materiais" (`modules.ts:49-54`,
     `production/common.ts:349-367`, `20261230000000_modelos_simplificados/migration.sql:36-48`);
   - **embalagem:** obrigatória (`modules.ts:42-47`);
   - **logística:** é o caminho padrão; "Novo serviço" já vem com retirada marcada
     (`new-service-page.tsx:150`).
3. **Telas novas somadas às antigas, sem retirar nada:**
   - lista simples **e** fluxo formal na mesma aba;
   - "Estoque" **e** "Estoque da oficina";
   - menu de 35 → 34 itens;
   - planejamento continua com 8 ações para publicar uma semana.

O que melhorou de fato:

- lista simples de materiais na OS;
- estoque da oficina;
- entrega direta pela OS;
- aprovação de qualidade em 1 toque;
- gestor pode aprovar a própria execução;
- OS em 6 abas com estado;
- painel "Hoje";
- programação unificada.

Parte disso, porém, fica escondida ou travada pelos padrões acima.

### Contagem (seção 1.A, 77 requisitos)

| Grupo | ATENDIDO | PARCIAL | NÃO ATENDIDO | NÃO VERIFICADO |
|---|---|---|---|---|
| 1. Clientes e OS (12) | 5 | 3 | **2** | 2 |
| 2. Materiais e compras (15) | 8 | 0 | **7** | 0 |
| 3. Estoque (8) | 6 | 1 | 0 | 1 |
| 4. Logística e entrega (9) | 4 | 3 | 0 | 2 |
| 5. Produção e tablets (11) | 9 | 2 | 0 | 0 |
| 6. Qualidade (7) | 3 | 3 | **1** | 0 |
| 7. Planejamento semanal (8) | 6 | 2 | 0 | 0 |
| 8. Painel gerencial (7) | 6 | 1 | 0 | 0 |
| **Total** | **47** | **15** | **10** | **5** |

Dos 47 "atendidos", **cerca de 20 já eram atendidos em `7b4177b`** e não mudaram (por exemplo: cadastro
de clientes, campos técnicos opcionais, início/pausa/retomada, responsável principal, meus ganhos,
distribuição, painel com financeiro).

## 2. Matriz de conformidade (seção 1.A)

Os detalhes ANTES/DEPOIS e as linhas de código de cada requisito estão nos anexos `area*.md`.

| ID | Requisito (resumo) | Situação atual (`696e3e9`, padrão) | Evidência no código | Evidência funcional (E2E) | Interruptor? | Classificação | Correção necessária |
|---|---|---|---|---|---|---|---|
| R1.1 | Cadastro completo do cliente | igual a antes | `customer-detail.tsx:153-175` | `commercial-flow.spec.ts:7-33` | não | ATENDIDO | — |
| R1.2 | Histórico de serviços do cliente | aba existe | `customer-detail.tsx:219-253` | nenhum confere o conteúdo | não | NÃO VERIFICADO | E2E do histórico |
| R1.3 | OS criada no fechamento | **não**: no fechamento nasce só o pedido | `service.ts:54-58` (igual em `7b4177b`) | **contrária**: `novo-servico.spec.ts:252-254` (0 OS após fechar) | não | **NÃO ATENDIDO** | criar a OS no "Novo serviço" |
| R1.4 | Sem recebimento físico obrigatório para a OS | exige recebimento | `service.ts:54-75`; `new-service-order-page.tsx:96` | `commercial-flow.spec.ts:54-57`; todo E2E passa por recebimento (`os-helpers.ts:16-57`) | não | **NÃO ATENDIDO** | tirar a exigência |
| R1.5 | Editar dados técnicos | sim, com motivo e revisão | `service-orders/routes.ts:501-560` | `commercial-flow.spec.ts:101-114` | não | ATENDIDO | — |
| R1.6 | Campos técnicos opcionais | sim | `schemas/commercial.ts:340-356` | `commercial-flow.spec.ts:94-99` | não | ATENDIDO | — |
| R1.7 | Cadastrar tipos de móveis e serviços | listas fixas no código, com "Outro" | `shared/domain.ts:13-23,158-166` | nenhuma | não | PARCIAL | lista editável pelo gestor |
| R1.8 | Modelos de OS | modelos trazem etapas, checklist e materiais; **não** preenchem os dados técnicos da OS | `shared/service-models.ts:6-23` | `fase2-modelos-servico.spec.ts` (só materiais) | não | PARCIAL | modelo aplicar textos técnicos padrão |
| R1.9 | Fotos de referência | sim, com tratamento seguro | `attachments/routes.ts:75` | `fase2-os-estado-fotos.spec.ts:59-91` | não | ATENDIDO | — |
| R1.10 | Observações e legendas nas fotos | legenda só no envio, uma por lote, não editável | `attachments/routes.ts:34` (sem PUT) | nenhuma | não | PARCIAL | legenda por foto e editável |
| R1.11 | Referências nos tablets | fotos da peça visíveis; fotos da OS em "Mais detalhes" (recolhido) | `tablet/tasks.tsx:744-760, 819-870` | nenhuma | não | NÃO VERIFICADO | E2E (e decisão sobre o recolhido) |
| R1.12 | Histórico da OS | aba Histórico | `service-orders/routes.ts:458-482` | `commercial-flow.spec.ts:112-114`; `gestao.spec.ts:102-104` | não | ATENDIDO | — |
| R2.1 | Materiais direto na OS | lista "Materiais necessários" | `os-materials/routes.ts:232-275` | `aa-fase1-materiais-estoque-entrega.spec.ts:21-65` | não | ATENDIDO | — (a aba ainda tem o bloco formal) |
| R2.2 | Tecidos, espumas, madeiras etc. | descrição livre + categoria | `simple-materials.ts:62-66` | idem | não | ATENDIDO | — |
| R2.3 | Quantidades e unidades | sim | `simple-materials.ts:35-43` | idem | não | ATENDIDO | — |
| R2.4 | Marcar "comprado" | sim | `simple-materials.ts:70` | idem | não | ATENDIDO | — |
| R2.5 | Marcar "na oficina" | sim, **só informativo** | `simple-materials.ts:71` | idem | não | ATENDIDO | — (ver R2.14) |
| R2.6 | Marcações independentes | sim | `simple-materials.ts:7-8` | idem | não | ATENDIDO | — |
| R2.7 | Sem pedido formal de compra | produção só libera com compra recebida ou reserva | `production/common.ts:349-367`; `modules.ts:49-54` | teste de API prova o bloqueio no padrão (`fase1-…test.ts:426-428`); sem E2E | **sim** | **NÃO ATENDIDO** | produção independente do fluxo formal no padrão |
| R2.8 | Sem fornecedor obrigatório | confirmar compra exige fornecedor; o tecido só cobre com compra | `purchase-orders.ts:816-817` | nenhuma | sim | **NÃO ATENDIDO** | idem R2.7 |
| R2.9 | Sem aprovação de compra | só necessidades aprovadas contam para a prontidão | `purchase-orders.ts:803-806` | nenhuma | sim | **NÃO ATENDIDO** | idem |
| R2.10 | Sem recebimento formal de mercadorias | material exclusivo só cobre quando recebido | `purchasing-domain.ts:264-273` | nenhuma | sim | **NÃO ATENDIDO** | idem |
| R2.11 | Sem reserva de estoque | material comum só cobre com reserva | `purchasing/stock.ts:310-501` | nenhuma | sim | **NÃO ATENDIDO** | idem |
| R2.12 | Custo quando conhecido | sim (quem vê o financeiro) | `simple-materials.ts:54-60` | `aa-fase1…spec.ts:34` | não | ATENDIDO | — |
| R2.13 | Custo em branco | sim (nulo ≠ zero) | `simple-materials.ts:53-60` | `aa-fase1…spec.ts:52-57` | não | ATENDIDO | — |
| R2.14 | Não bloquear a produção por compras | **bloqueia** (motivo MATERIAIS) | `production-domain.ts:356`; `tasks.ts:1031` | sem E2E | sim | **NÃO ATENDIDO** | idem R2.7 + E2E |
| R2.15 | Iniciar OS sem materiais | OS sem levantamento = `SEM_LEVANTAMENTO` → corte e montagem bloqueados | `purchasing-domain.ts:265`; migrations dos modelos | sem E2E | sim | **NÃO ATENDIDO** | idem + E2E |
| R3.1 | Estoque simples e separado | "Estoque da oficina" | `inventory/routes.ts:177-700` | `aa-fase1…spec.ts:67-103` | não | ATENDIDO | — (convive com o estoque formal) |
| R3.2 | Cadastro manual | sim | `inventory/routes.ts:~318` | idem | não | ATENDIDO | — |
| R3.3 | Rolos e metragens | existe | `inventory/routes.ts:507-680` | só teste de API | não | NÃO VERIFICADO | E2E de rolo |
| R3.4 | Categorias próprias | sim | `inventory/routes.ts:177-290` | `aa-fase1…spec.ts:74-77` | não | ATENDIDO | — |
| R3.5 | Ajuste manual | com motivo e histórico | `inventory/routes.ts:~407` | `aa-fase1…spec.ts:88-95` | não | ATENDIDO | — |
| R3.6 | Estoque opcional para a produção | o simples é opcional; no padrão, a produção ainda depende de reserva formal ou compra | `production/common.ts:349-367` | nenhuma | sim | PARCIAL | idem R2.7 |
| R3.7 | Arquivar materiais | sim | `inventory/routes.ts:~446-500` | `aa-fase1…spec.ts:97-102` | não | ATENDIDO | — |
| R3.8 | Sem vínculo obrigatório com o estoque | sim, na lista simples | `simple-materials.ts:65` | `aa-fase1…spec.ts:31-36` | não | ATENDIDO | — |
| R4.1 | Tirar a logística obrigatória do fluxo | o servidor não exige mais; **no padrão, a logística é o caminho normal**: Central e "Peças prontas" só oferecem "Agendar entrega" | `modules.ts:27-33`; `attention.ts:157-164`; `delivery-pages.tsx:247-282` | `aa-fase1…spec.ts:110-115` (vem ligada) | **sim** | PARCIAL | caminho padrão sem logística |
| R4.2 | Sem planejamento de rotas | entrega direta sem roteiro | `direct-delivery.ts:266-283` | `zz-fase3-qualidade-programacao.spec.ts:190-260` (com a embalagem desligada) | não | ATENDIDO | — |
| R4.3 | Sem programação de veículos | não existe veículo | — | idem | não | ATENDIDO | — |
| R4.4 | Sem retirada e transporte para toda OS | transporte opcional; "Novo serviço" **já vem com retirada**; o recebimento continua obrigatório | `new-service-page.tsx:150` | `novo-servico.spec.ts:38-176` | sim | PARCIAL | opção inicial sem retirada + R1.4 |
| R4.5 | Endereços disponíveis ao gestor | no cadastro do cliente | `customer-detail.tsx:153-175` | nenhum confere a exibição | não | NÃO VERIFICADO | E2E |
| R4.6 | Histórico de entregas e transportes | preservado | `nav.ts:260-266` | `zz-fase3…spec.ts:278-282` | não | ATENDIDO | — |
| R4.7 | Finalizar a entrega pela OS | sim, também com a logística ligada | `os-direct-delivery.tsx:100-110` | `zz-fase3…spec.ts:255-260` | não | ATENDIDO | — |
| R4.8 | "Marcar como entregue" simples | existe; **no padrão, exige embalagem concluída**, e os atalhos não levam a ela | `quality-domain.ts:340-341` | só com a embalagem desligada (`zz-fase3…spec.ts:207`) | **sim** | PARCIAL | embalagem fora das condições (R6.6) + atalhos |
| R4.9 | Consequências financeiras da entrega | mesmos leitores da logística | `direct-delivery.ts:147-233` | nenhum E2E confere o financeiro | não | NÃO VERIFICADO | E2E do financeiro após a entrega direta |
| R5.1 | Início, pausa, retomada, conclusão | igual | `tasks.ts:997-1266` | `tablets.spec.ts:44` | não | ATENDIDO | — (as travas de início estão na lista 3) |
| R5.2 | Informações técnicas no tablet | sim | `tablet/tasks.tsx:716-765` | `tablets.spec.ts:155-166` | não | ATENDIDO | — |
| R5.3 | Fotos e orientações para a execução | orientações sim; fotos da OS foram para "Mais detalhes" | `tablet/tasks.tsx:821-871` | sem E2E de foto no tablet | não | PARCIAL | E2E + decisão sobre onde exibir |
| R5.4 | Responsável principal | titular por peça | `distribution.ts:297-308` | `team-distribution.spec.ts:40` | não | ATENDIDO | — |
| R5.5 | Distribuir atividades | sim | `distribution.ts:758-860` | idem | não | ATENDIDO | — |
| R5.6 | Não obrigar a iniciar tarefa planejada | nada inicia sozinho | `tasks.ts:1003`; `queue.ts:8-10` | `tablets.spec.ts:150-151` | não | ATENDIDO | — |
| R5.7 | Produção por etapas | sim | `tasks.ts:152-186` | `tablets.spec.ts:140-162` | não | ATENDIDO | — |
| R5.8 | Tempo e produtividade | preservados + aba nova | `productivity.ts:15` | `zz-fase4-hoje.spec.ts:49-52` | não | ATENDIDO | — |
| R5.9 | Consultar os próprios ganhos | "Meus valores" com PIN | `my-earnings.ts:39-42` | `zz-fluxo-transversal.spec.ts:500-511` | não | ATENDIDO | — |
| R5.10 | Sem financeiro de cliente no tablet | tarefas sem valores; **o tablet de logística mostra o valor a cobrar do cliente** | `tablet/logistics.tsx:41-59` | `team-finance.spec.ts:156-162` (só tarefas) | sim (logística) | PARCIAL | **decisão do proprietário** |
| R5.11 | Não ver ganhos de outros | isolado | `my-earnings.ts:46-47` | `zz-fluxo-transversal.spec.ts:513-551` | não | ATENDIDO | — |
| R6.1 | Aprovação simplificada | "Tudo conforme"; mas "Iniciar inspeção", checklist item a item e embalagem continuam no caminho visível | `inspections.ts:526-545` | `zz-fase3…spec.ts:45-150` (com a embalagem desligada) | sim | PARCIAL | ver R6.6 |
| R6.2 | Poucos cliques | abrir + 1 toque | `tablet/quality.tsx:429-442` | `zz-fase3…spec.ts:113-123` | não | ATENDIDO | — |
| R6.3 | Registrar correções | reprovação → correção → nova inspeção | `inspections.ts:630-720` | `team-quality.spec.ts:75` | não | ATENDIDO | — |
| R6.4 | Sem etapas administrativas inúteis | embalagem obrigatória (proteção e local); justificativa obrigatória na autoaprovação | `inspections.ts:561,612,516-524` | `team-quality.spec.ts:228-240` | sim | PARCIAL | R6.6 + justificativa (decisão) |
| R6.5 | Gestor aprova mesmo tendo executado | permitido, **com justificativa obrigatória (≥ 10 caracteres)**: veio da recomendação, não do pedido | `inspections.ts:516-524` | `zz-fase3…spec.ts:113-134` | não | PARCIAL | justificativa opcional (decisão) |
| R6.6 | Embalagem não obrigatória para todos | **obrigatória para todas** (padrão ligado) | `modules.ts:42-47` | `team-quality.spec.ts:228-240` (obrigatória no padrão) | **sim** | **NÃO ATENDIDO** | padrão desligado |
| R6.7 | Fotos de conclusão opcionais | sim (padrão NENHUM) | `tasks.ts:1168-1172` | `tablets.spec.ts:206-209` | não | ATENDIDO | — |
| R7.1 | Trabalho por semana | Programação semanal | `weekly-schedule-page.tsx:23-78` | `pre-planejamento.spec.ts` | não | ATENDIDO | — |
| R7.2 | Preparar com antecedência | **só OS com peças recebidas** | `pre-planning.ts:176-177, 425-426` | nenhum E2E antes da chegada | não | PARCIAL | aceitar OS aguardando chegada |
| R7.3 | Distribuir serviços | igual | `pre-planning.ts:440-481` | `team-distribution.spec.ts` | não | ATENDIDO | — |
| R7.4 | Tarefas e responsáveis | igual | `pre-planning.ts:292-371` | `pre-planejamento.spec.ts` | não | ATENDIDO | — |
| R7.5 | Sugestões sem tirar o controle | igual + sugestões no "Hoje" | `today.ts:350-400` | `zz-fase4-hoje.spec.ts:40-46` | não | ATENDIDO | — |
| R7.6 | Ajustes manuais | igual (motivo exigido após publicar) | `planning-page.tsx:186-193` | `team-week.spec.ts` | não | ATENDIDO | — |
| R7.7 | Considerar prazos | exibe e alerta; **não avisa no planejamento** | `service-priority.ts:21` | só a Central (`prazos.spec.ts`) | não | PARCIAL | aviso de prazo ao planejar |
| R7.8 | Liberdade de não iniciar | igual | `queue.ts:8-10` | `team-queue.spec.ts` | não | ATENDIDO | — |
| R8.1 | Serviços em andamento | painel "Hoje" + mapa | `today-panel.tsx:120-201` | `zz-fase4-hoje.spec.ts:36-37` | não | ATENDIDO | — |
| R8.2 | Atrasados e próximos do vencimento | cartão + alertas | `today.ts:149-157` | `prazos.spec.ts` | não | ATENDIDO | — |
| R8.3 | Produtividade | Financeiro e Programação | `productivity-tab.tsx` | `zz-fase4-hoje.spec.ts:49-52` | não | ATENDIDO | — |
| R8.4 | Situação de cada OS | selo de estado + próximo passo | lista de OS | `fase2-os-estado-fotos.spec.ts` | não | ATENDIDO | — |
| R8.5 | Financeiro e operação sem muitas telas | Início com seções | `dashboard.tsx:238,292,325` | `team-finance.spec.ts` | não | ATENDIDO | — |
| R8.6 | Simplificar a navegação | **34 itens, todos visíveis no padrão**, com estruturas paralelas | `nav.ts:98-295` | `zz-fase3…spec.ts:172-179` | sim | PARCIAL | tirar do menu padrão o fluxo formal |
| R8.7 | Histórico completo | igual | `customers/routes.ts:179-209` | `zz-auditoria-fluxos.spec.ts:140` | não | ATENDIDO | — |

**Pedidos de ajuda e medições** não constam da seção 1.A. Não são pendências de remoção.

- **Pedidos de ajuda:** aparecem por padrão (interruptor ligado) e **não** impõem passo ao fluxo da OS.
- **Medições:** não mudaram, não têm interruptor e exigem recebimento físico. Por causa da trava de
  materiais ligada, **na prática** voltam a ser obrigatórias antes da produção (cadeia medição →
  solicitação → aprovação). Isso conflita com R2.7–R2.15, não com um pedido sobre medições.
- **Reprogramação automática por ausência confirmada:** executa sozinha as "mudanças simples"
  (`help/reschedule.ts:500-508`). Fica registrado, sem classificar.

**Seção 1.B (histórico):**

- Atendidos, em geral.
- Não atendidos: **R9.1** (vínculo CLT/CNPJ), **R9.4** (documentos do profissional) e **R9.10**
  (jornada por profissional).
- Parciais: R9.2, R9.6, R9.8, R10.9 (semana passada sem aviso), R10.10, R11.4.
- Não verificado: R10.8.
- **R12** (VerificaPro): fora deste repositório.
- Detalhes em `area4-*.md` (c). Não entram no plano abaixo sem decisão sua.

## 3. Telas e processos antigos que continuam interferindo

1. **Recebimento físico como porta de entrada.** A OS só nasce com recebimento; o planejamento e a
   medição também o exigem; a tarefa não inicia sem ele (`PECA_NAO_RECEBIDA`, `production-domain.ts:352`).
2. **Cadeia formal de materiais como condição da produção:** medição → solicitação → aprovação →
   compra (fornecedor e `compras.aprovar`) → recebimento, ou reserva. Trava ligada por padrão; modelos
   padrão marcam as etapas principais.
3. **"Prontidão para produção → Materiais: Pendente"** no Resumo da OS, calculada só pelo fluxo formal,
   e os blocos formais abaixo da lista simples na aba Materiais (`service-order-detail.tsx:299-323, 439-446`).
4. **Avisos de bloqueio por material** na publicação do plano e na pré-programação
   (`plans.ts:274-288`, `pre-planning.ts:333-345`).
5. **Menu padrão com o fluxo formal inteiro**, sem interruptor:
   - Compras, Fornecedores;
   - Recebimento de materiais (visível a qualquer funcionário);
   - Estoque formal (junto com o da oficina);
   - Prontidão de materiais, Materiais aprovados;
   - Medições, Reprogramação;
   - Expedição e entregas, Devoluções;
   - e, com a logística ligada, Retiradas e Roteiro do dia.
6. **"Novo serviço" com retirada marcada**, e o pedido nasce "Aguardando retirada".
7. **Central de atenção e "Peças prontas"** oferecem "Agendar entrega" e não "Marcar como entregue".
8. **Embalagem obrigatória** após toda aprovação (tarefa própria, com proteção e local obrigatórios), e
   como condição da entrega direta.
9. **Qualidade:** "Iniciar inspeção" e checklist item a item ainda em destaque. Justificativa
   obrigatória na autoaprovação.
10. **Planejamento:** ciclo rascunho → revisar → publicar com 8 ações; a tarefa só chega ao tablet
    depois de publicar (`NAO_PUBLICADA`). Rotas antigas de planejamento continuam abrindo.

## 4. Funcionalidades já corretas

- **Clientes e OS:** cadastro e histórico de clientes; edição técnica da OS com revisão; campos
  técnicos opcionais; fotos seguras com visualizador; histórico da OS.
- **Materiais e estoque:** lista simples de materiais na OS (quantidade, unidade, comprado e na oficina
  independentes, custo opcional ou em branco); estoque da oficina (categorias, cadastro, ajuste com
  histórico, arquivamento, sem vínculo obrigatório).
- **Entrega:** entrega direta pela OS, sem roteiro nem veículo.
- **Produção e tablets:** início, pausa, retomada e conclusão; responsável principal; distribuição;
  liberdade de não iniciar; etapas; registros de tempo; meus ganhos isolados; fotos de conclusão
  opcionais.
- **Qualidade:** aprovação em 1 toque ("Tudo conforme"); correções.
- **Planejamento e painel:** programação semanal numa tela; painel "Hoje"; prazos e alertas;
  produtividade; selo de estado da OS.

## 5. Correções necessárias, por prioridade

Só o que os requisitos pedem. Nada é apagado: os dados e o histórico antigos continuam consultáveis.

**Prioridade 1 — bloqueios do fluxo normal (NÃO ATENDIDOS):**

- **C1.** A produção deixa de depender do fluxo formal de materiais no padrão: a trava de materiais
  passa a vir **desligada** (R2.7–R2.11, R2.14, R2.15, R3.6). Em produção vale na hora, porque
  `module_settings` está vazio.
- **C2.** OS criada no fechamento do serviço, sem recebimento físico (R1.3, R1.4, R4.4). O
  planejamento aceita OS que ainda aguarda chegada (R7.2).
- **C3.** Embalagem **não** obrigatória por padrão, e fora das condições da entrega direta quando
  dispensada (R6.6, R4.8, R6.1, R6.4).

**Prioridade 2 — caminho normal ainda formal (PARCIAIS):**

- **C4.** Logística fora do caminho padrão: "Novo serviço" sem retirada pré-marcada; Central e "Peças
  prontas" oferecem "Marcar como entregue" (R4.1, R4.4, R4.8).
- **C5.** Menu e telas: tirar do menu padrão o fluxo formal de compras e o estoque formal, e esconder
  os blocos formais da aba Materiais e a "Prontidão" formal quando a trava estiver desligada. Páginas e
  histórico continuam acessíveis (R8.6, R2.x).

**Prioridade 3 — parciais menores:**

- **C6.** Aviso de prazo ao planejar (R7.7).
- **C7.** Legenda por foto e editável (R1.10).
- **C8.** Modelos aplicam os textos técnicos padrão na OS (R1.8).
- **C9.** Tipos de peça e serviço editáveis (R1.7).

**Prioridade 4 — provar o que não foi verificado:**

- **C10.** E2E para R1.2, R1.11/R5.3, R4.5, R4.9 e R3.3.

**Decisões suas antes da implementação:**

| # | Decisão | Afeta |
|---|---|---|
| D1 | A tarefa pode começar sem registro de chegada da peça (`PECA_NAO_RECEBIDA`), ou basta marcar "chegou" na OS? | C2 |
| D2 | A logística (retirada e entrega agendada) ainda é usada? Se não, padrão desligado; se sim, só deixa de ser o caminho inicial | C4 |
| D3 | A justificativa da autoaprovação do gestor (recomendação do assistente) fica obrigatória, opcional ou sai? | R6.4, R6.5 |
| D4 | O valor a cobrar do cliente pode aparecer no tablet do motorista? | R5.10 |
| D5 | As fotos da OS voltam para a área visível da tarefa no tablet? | R1.11, R5.3 |
| D6 | O fluxo formal de compras e o estoque formal saem do menu padrão (ficando acessíveis por endereço e histórico) ou ficam atrás da trava de materiais? | C5 |
| D7 | Os itens da 1.B não atendidos (R9.1, R9.4, R9.10) entram neste ciclo? | fora do plano |

## 6. Execução em etapas pequenas e verificáveis

Cada etapa:

- é um branch e um commit próprios;
- passa pela suíte local completa (API, web, E2E);
- é implantada em **homologação** e validada por você antes da próxima etapa;
- só vai para produção ao final, com autorização.

Sem migrations destrutivas. Se alguma etapa precisar de migration, será aditiva e anunciada antes.

| Etapa | Escopo | Critérios objetivos de aceite |
|---|---|---|
| **E1** — materiais não travam a produção (C1) | padrão da trava de materiais = desligado; Resumo da OS sem "Materiais: Pendente" como impedimento quando desligada | 1) E2E novo: OS **sem nenhum material** → tarefa de corte LIBERADA → iniciada no tablet. 2) E2E: OS com material na lista simples **não comprado** → tarefa inicia; a OS mostra só o aviso. 3) Com a trava **ligada** manualmente, o comportamento antigo volta (teste existente `fase1-…test.ts:426-428`). 4) Nenhum E2E existente quebra |
| **E2** — embalagem opcional (C3) | padrão embalagem = desligado; entrega direta sem condição de embalagem quando desligada | 1) E2E: aprovar com "Tudo conforme" → peça "Pronta para entrega" sem tarefa de embalagem. 2) E2E: "Marcar como entregue" no padrão, sem desligar nada. 3) Ligando a embalagem, o fluxo antigo volta |
| **E3** — OS no fechamento (C2; depende de D1) | "Novo serviço" cria a OS; o recebimento vira registro opcional da chegada; o planejamento aceita OS aguardando chegada | 1) E2E: fechar o serviço → a OS existe em seguida (inverte `novo-servico.spec.ts:252-254`). 2) E2E: planejar essa OS antes da chegada. 3) Comportamento conforme D1 no início da tarefa. 4) Pedido, cobrança e histórico do cliente sem duplicidade |
| **E4** — logística fora do caminho padrão (C4; depende de D2) | opção inicial "Cliente entrega"; atalhos "Marcar como entregue" na Central e em "Peças prontas" | 1) E2E: Novo serviço → OS → produção → qualidade → entregue, **sem nenhuma tela de logística e sem desligar nada**. 2) E2E: financeiro após a entrega direta (cobrança "na entrega" vencida, mão de obra liberada) (R4.9) |
| **E5** — menu e telas (C5; depende de D6) | fluxo formal fora do menu padrão; blocos formais da aba Materiais escondidos com a trava desligada | 1) Contagem do menu no padrão documentada antes/depois. 2) Páginas antigas e histórico acessíveis por endereço. 3) Teste de menu × permissões atualizado |
| **E6** — parciais menores (C6–C9) e provas (C10) | aviso de prazo, legendas, textos nos modelos, tipos editáveis, E2E pendentes | um E2E por requisito, cobrindo o fluxo pela tela |
| **E7** — aceite operacional real | roteiro manual em homologação, conduzido por você, com dados fictícios | o fluxo inteiro sem configurar nada: **fechar serviço → OS → materiais na OS (comprado/na oficina) → planejar → tablet inicia sem compra → concluir → qualidade em 1 toque → marcar como entregue → financeiro correto**. Só então a reformulação é considerada concluída |

**Aguardo a sua aprovação e as decisões D1–D7.** Nada será implementado antes disso.
