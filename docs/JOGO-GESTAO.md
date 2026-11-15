# Jogo de gestão — empresa virtual da Cenário Estofados

Entrada própria em **`/jogo`** dentro do Cenário Gestão: mesma empresa, mesmos usuários, sessão e
permissões. O mapa isométrico (identidade visual própria da Cenário: piso de madeira clara, paredes
em verde petróleo, detalhes em bronze) é a interface principal; painéis sobre o mapa mostram detalhes
e executam ações **pelas rotas oficiais**. O Cenário Gestão continua sendo a fonte oficial dos dados.

> Estado: primeira versão integrada, validada em **desenvolvimento com dados sintéticos**. Não foi
> publicada em homologação nem em produção.

## Como abrir e testar (desenvolvimento)

```bash
pnpm install
cp .env.example .env            # DATABASE_URL, TEST_DATABASE_URL, TOKEN_HASH_SECRET, SEED_ADMIN_*
pnpm db:migrate && pnpm db:seed
pnpm dev                        # API :4000 e web :3000
# em outro terminal, com a API no ar (dados FICTÍCIOS; recusa APP_ENV=production):
JOGO_EMAIL=<SEED_ADMIN_EMAIL> JOGO_PASSWORD=<SEED_ADMIN_PASSWORD> node scripts/jogo-dados-sinteticos.mjs
```

1. Entre em <http://localhost:3000/entrar> com o gestor e clique em **Empresa virtual** no menu
   (ou abra <http://localhost:3000/jogo>).
2. Tablets: abra <http://localhost:3000/tablet> em outra janela/dispositivo, digite o **código de
   vinculação** impresso pelo script e entre com o PIN do funcionário (também impresso).
3. O script cria 4 OS fictícias: **Ana** (sofá retrátil, falta material — vermelho), **Bruno**
   (poltronas + cabeceira, material reservado — verde), **Carla** (sofá de canto, sem levantamento —
   "A conferir") e **Diego** (sofá 2 lugares, planejado e com o desmanche já iniciado pelo João no
   tablet). Também endereça materiais nas estantes e cria contas da semana para o Gerente.

### Controles

| Ação               | Como                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| Andar              | clique no chão (o avatar desvia dos móveis)                                       |
| Abrir algo         | clique no sofá, pessoa, estante/prateleira, mesa, agente ou porta                 |
| Câmera             | arraste o fundo; roda do mouse ou +/− para zoom; botão 🗺 para visão geral; setas |
| Trocar de ambiente | abas no topo ou clique numa porta com placa "→"                                   |
| Pesquisar          | caixa no topo: OS, cliente, material, pessoa ou agente (vai até o objeto no mapa) |
| Construção         | arrastar, **R** gira, **D** duplica, **Delete** remove, **Ctrl+Z / Ctrl+Y**       |

## Arquitetura encontrada e como o jogo se encaixa

- Monólito modular: API Fastify (`apps/api`), Next.js (`apps/web`, painel e tablets), Prisma +
  PostgreSQL, catálogo de permissões e esquemas em `packages/shared`. Toda rota declara
  `config.access`; alterações gravam auditoria e evento de domínio (outbox) na mesma transação; o
  tempo real é WebSocket com retomada (`resume`/`replay`) e reconciliação.
- **Reutilizado diretamente** (o jogo chama as mesmas rotas do painel e do tablet):
  - planejamento: `POST /api/v1/production/plan-services` (titular por peça + data) e
    `POST /api/v1/production-plans/:id/publish` (vai para a fila dos tablets);
  - troca de responsável: `PUT /api/v1/production-tasks/:id` (versão + motivo após publicar);
  - início/conclusão: **somente no tablet do funcionário** (`/production-tasks/:id/start`, que
    exige ser o responsável e mantém uma tarefa em execução por pessoa — `assertSingleActive`);
  - fila oficial (`loadQueue`), prontidão de materiais (`readinessOf`), prazos (`serviceDeadlines`),
    faltas (`requirementsWithProgress`), qualidade/embalagem/expedição (`fulfillment_stage`);
  - estoque: `POST /stock-items/:id/adjust` (entrada/saída com motivo) e `POST /stock-reservations`;
  - compras: o fluxo oficial `/painel/compras/novo?req=<necessidade>` (rascunho; confirmar é do gestor);
  - fotos: `GET /api/v1/attachments`; posição física confirmada: `item_location_events`.
- **Estendido** (migration `20270302000000_jogo_gestao`, só tabelas novas):
  - `game_spaces` (+ `game_layout_revisions`, imutável): ambientes com medidas, paredes, portas e
    decoração, versão e histórico;
  - `game_areas`, `game_stations` (+ `game_station_assignees`), `game_storage_units`,
    `game_storage_slots` (+ `game_slot_materials`): ids estáveis — mover/renomear preserva vínculos;
    remover desativa (não apaga) e exige escolher destino dos vínculos (`409` com `impacts`);
  - endereçamento físico do estoque integrado ao cadastro: ao salvar, `stock_items.location`
    recebe o endereço do mapa (ex.: `▦ Tapeçaria → Estoque → Estante A → Prateleira 2`), com
    auditoria e versão do material;
  - `ai_agents`, `ai_agent_messages` (imutável), `ai_agent_proposals`.
- Permissões novas: `jogo.acessar`, `jogo.construir`, `agentes.usar`, `agentes.gerenciar` (o gestor
  recebe todas pelo seed; nenhuma função padrão ganhou acesso). Tablets não entram no jogo.
- Eventos novos (só ids): `game.layout_saved`, `game.agent_changed`, `game.proposal_changed`.
- Código: `apps/api/src/modules/game/*`, `apps/web/components/game/*`, regras puras em
  `packages/shared/src/game-domain.ts` (geometria, caminho A\*, passagem, posição da peça) e
  `game-builder.ts` (Mestre de Obras).

### Como o sofá anda pelo mapa

A posição **representada** sai só dos registros (`placePiece`): tarefa em execução → estação de
quem iniciou (vínculo da estação + etapa; senão estação compartilhada da etapa); próxima tarefa
liberada/programada → fila ao lado da estação do responsável; produção concluída → qualidade;
aprovada → embalagem; embalada/pronta/agendada → expedição; sem planejamento → recebimento. A
posição **física confirmada** (alfinete azul com horário) vem de `item_location_events` e aparece
separada quando difere. Mudanças nos tablets chegam pelo tempo real; o selo "Sincronizado" mostra
falhas e, na reconexão, o jogo recarrega o estado do servidor.

## Validação executada

- `packages/shared/test/game.test.ts` (19 testes): planta de 180 m², posição da peça em cada etapa,
  A\*, passagem de sofá, os 5 pedidos ao Mestre de Obras, impacto de remoção.
- `apps/api/test/jogo.test.ts` (6 testes, banco de teste): expandir a empresa (escritório maior,
  mesa nova, agente novo, bancada movida, reabrir com vínculos, conflito de versão); remoção com
  transferência; estoque no mapa integrado ao cadastro; **sofá do recebimento à expedição**
  (fila do João → início no tablet → bancada do João → compra/recebimento do tecido → mesa de corte
  → máquina de costura → qualidade → embalagem → expedição, com o gestor recebendo 403 ao tentar
  iniciar); Gerente/Compras com referências e propostas; tablet sem acesso.
- Demonstração no navegador (Playwright, tablets reais em `/tablet`) das três jornadas pedidas,
  sem erros de console: capturas e roteiro em `docs/evidencias/jogo/`.
- Travas existentes atualizadas com justificativa: menu do painel (`rodada4-menu`) e linha de base
  de permissões/migrations (`rodada4-travas-estruturais`). `prisma migrate diff --exit-code` sem
  diferença; reversão manual em `packages/db/rollback/20270302000000_jogo_gestao.down.sql` testada.

## Dados da oficina real para acertar a planta

A planta inicial (15 × 12 m ≈ 180 m²; escritório 8 × 6 m) é **ilustrativa**. No modo Construção,
desmarque "Medidas ilustrativas" quando tiver preenchido:

1. Medidas internas da oficina (largura × profundidade), pé-direito se quiser e pilares/paredes internas.
2. Posição e largura de cada porta/portão (recebimento, expedição, passagem para o escritório).
3. Medidas e posição de cada bancada, mesa de corte, máquina de costura, bancada de marcenaria,
   mesa de inspeção e de embalagem — e quem usa cada uma e em quais etapas.
4. Áreas reais (recebimento, espera, desmanche, corte, costura, marcenaria, montagem, acabamento,
   qualidade, embalagem, expedição, estoque) com medidas.
5. Estantes/prateleiras/gaveteiros: quantos, níveis, e quais materiais do catálogo ficam em cada posição.
6. Escritório: medidas, mesas existentes e quem senta em cada uma.
7. Quais localizações físicas (`Qualidade → Localizações`) correspondem a quais áreas.

## Quadro de Metas (caixa no escritório)

Objeto **Quadro de Metas** no Escritório (posicionável no modo Construção; clique abre o resumo) e
versão compacta na Tapeçaria (barra + "faltam R$ …"). A barra 3D avança ou recua quando o
financeiro confirma um movimento; conquista de meta e entrega concluída têm comemoração breve; ao
fechar a semana a barra anima da abertura ao fechamento.

- **Ponto de partida**: saldo informado por conta, com data e hora (aba Contas e saldo). Só entram
  os movimentos posteriores. Corrigir = informar de novo (o anterior fica no histórico).
- **Fontes, sem contar o mesmo dinheiro duas vezes**: conta "por registros" usa os recebimentos de
  clientes, pagamentos de contas e de mão de obra por produção do financeiro (com estornos); conta
  "por extrato" (vira automaticamente ao importar o extrato) usa só as linhas do extrato, ligadas
  pela conciliação ao registro oficial — registros sem conciliação aparecem "a conciliar" e não
  somam. Lançamento manual (aporte, retirada, transferência, despesa sem conta) some quando a linha
  do extrato o representa; casamento automático por valor e data evita duplicidade. Cartão: com o
  relatório da maquininha, entra o líquido quando cai (bruto, taxa e previsão visíveis).
- **Transferências** entre contas incluídas não mudam o total; **aportes e retiradas** são
  separados para mostrar a variação da operação.
- **Semana** de segunda a domingo (São Paulo): abertura, fechamento, entrou/saiu, variação em R$ e
  % sobre abertura positiva ("não se aplica" se ≤ 0), maiores entradas/saídas, gráfico e
  correções feitas depois do fechamento (lançamento e efeito).
- **Metas**: R$ 100/200/300 mil iniciais e metas próprias (valor, prazo, contas). "% da meta" =
  saldo ÷ meta; "evolução desde o início" tem rótulo próprio. Conquista fica no histórico; se o
  saldo cair, mostra o saldo verdadeiro e quanto falta para recuperar; prazo vencido mostra o
  resultado na data prevista.
- **A receber / a pagar / projeção**: vencido, com data, depende de entrega/retirada, cartão a cair,
  contas, mão de obra liberada e prevista — com as premissas.
- **Cada número abre os lançamentos** (data, conta, valor, categoria, origem e vínculo com OS,
  pedido, conta a pagar ou mão de obra).
- **Chat e Gerente**: "Quanto falta pra bater os 100 mil?", "Quanto eu cresci essa semana?", "Por
  que o caixa caiu desde segunda?", "Com o que tenho pra receber e pagar, bato a meta até o prazo?".

Demonstração: `scripts/jogo-quadro-metas-demo.mjs` (depois de `jogo-dados-sinteticos.mjs` e da
produção da Ana até a expedição com `ONLY2=1 node docs/evidencias/jogo/demonstracao-playwright.cjs`).
Evidências em `docs/evidencias/jogo/quadro-metas`; testes em `apps/api/test/quadro-metas.test.ts`.
Migration `20270323000000_jogo_quadro_metas` (com rollback).

## Leitura operacional (correções das capturas)

- **Situação da peça separada** (`packages/shared/src/game-workflow.ts`): estado geral, etapa(s) em
  execução (só depois do "Iniciar" no tablet), próxima etapa com motivo do bloqueio e nomes,
  materiais, estação da etapa e última posição física confirmada. "Aguardando planejamento" →
  "Planejada (rascunho)" → "Na fila" → "Em execução" → "Qualidade/Embalagem" → "Pronta para entrega".
- **Dependências**: seguem o modelo oficial de produção. No modelo "Reforma de sofá", corte não
  depende do desmanche (etapas paralelas); a montagem espera preparação e costura. A API recusa o
  início com o motivo e o tablet mostra o mesmo "Por que espera".
- **Horários** do jogo no fuso de São Paulo (igual ao tablet).
- **Ficha do sofá**: resumo no topo (situação, etapa atual, próxima, responsável, prazo, bloqueio,
  próxima ação), abas Materiais / Atribuição / Serviço / Histórico, título inteiro, origem do tecido
  quando o campo da OS está vazio. Materiais mostram necessária, reservada, livre para reservar e
  restante a comprar; "Reservar" usa a reserva oficial e "Comprar" abre a compra oficial, que já
  desconta estoque livre e compras de estoque em aberto.
- **Filtros rápidos**: Sem material, Parados, Em execução e Prontos para entrega (esmaecem o resto
  do mapa e listam o que pede decisão).
- **Estante**: destino das reservas encerradas (consumida/liberada); ficha e estante atualizam em
  tempo real após reserva, entrada e recebimento.
- **Gerente**: propostas que os dados já resolveram viram **OBSOLETA** com o motivo (migration
  `20270316000000_jogo_propostas_obsoletas`); aprovar uma proposta antiga é recusado. Caixa sem
  saldo inicial é apresentado como diferença; separa vencidos, com data e condicionados à entrega;
  inclui produção devida do fechamento semanal; cada número tem a conta/recebível ao lado.
- **Mapa sem conexão**: "Mapa pendente de atualização" e atualização ao reconectar.
- **Central**: status real (modo de teste, por importação, conectada sem emissão real) e, em cada
  cartão, o que foi testado de ponta a ponta e o que depende de conta real.

Evidências: `docs/evidencias/jogo/operacao` (roteiro `validacao-operacao-playwright.cjs` com
navegador e tablet). Testes: `apps/api/test/jogo-operacao.test.ts`.

## Central de Conexões, caixa de entrada e agentes nos canais

No **Escritório**, o chip **🔌 Central de Conexões** mostra cada conta (sessão do Cenário Gestão,
WhatsApp Business, Instagram profissional, Página do Facebook/Messenger, Meta Business e Anúncios,
Assinatura digital, Emissão fiscal, Cobranças, Banco PJ, Maquininha, Contabilidade, Agenda e
entregas; Google Ads, Perfil da Empresa e E-mail aparecem como planejadas). Cada cartão diz a conta
autorizada, o estado, a última sincronização, o que falta no servidor (variável a variável) e o que
falta fora do sistema. Conectar usa o **OAuth oficial da Meta** (Embedded Signup com coexistência
para o WhatsApp); os tokens ficam **cifrados no servidor** (AES-256-GCM) e nunca vão ao navegador.

Fora de produção, **"Usar conta de teste"** conecta uma conta simulada: a mensagem de cliente
simulada é assinada (`X-Hub-Signature-256`) e entra pelo **mesmo webhook** `/api/webhooks/meta`
que a Meta usaria; envios e publicações ficam marcados como teste.

- **📥 Caixa de entrada** (WhatsApp, Instagram Direct, Messenger): resumo do pedido do cliente
  (fotos e medidas que faltam), rascunho do agente de Atendimento, revisão e envio, regra de cada
  canal (texto livre só na janela de 24 h; fora dela, modelo aprovado no WhatsApp e bloqueio no
  Instagram/Messenger), "Assumir conversa" (o agente para), vínculo com cliente/OS e encerramento.
  Reenvios do webhook não duplicam mensagens.
- **Agentes**: Atendimento, Marketing, Tráfego e Documentos (além de Gerente e Compras). Cada um
  tem permissão por canal (consultar, preparar rascunho, executar regras liberadas) e casos de envio
  automático escolhidos pelo gestor ("pedir fotos e medidas", "confirmar recebimento de fotos").
  Marketing prepara posts com fotos das OS (publicar exige `marketing.publicar`). Tráfego lê
  campanhas, gastos e resultados e **propõe** mudança de orçamento com campanha, valor atual → novo e
  a mudança exata; só executa depois da aprovação (`anuncios.gerenciar`). O Gerente responde
  "quem está esperando orçamento no WhatsApp?" com links que abrem as conversas.
- **Histórico** de cada agente: canal, conta, horário, conteúdo, situação e quem aprovou (tabela
  somente-inserção).

## Escritório financeiro (ficha do sofá e painel 💼)

Clique no sofá → **💼 Ficha**: orçamento aprovado, contrato, entrada, saldo, nota, materiais,
retirada e entrega, **cada um com seu próprio estado** vindo do registro oficial.

1. **Contrato** — o agente Documentos preenche o modelo versionado da Cenário (cliente, CPF,
   endereço, itens, tecido, valor, parcelas, prazo, retirada/entrega) e lista o que falta. O gestor
   revisa texto e signatários; **"Revisar e enviar…" mostra provedor e signatários antes de
   confirmar**. O retorno da Clicksign (webhook com HMAC) marca assinado/recusado e arquiva o PDF
   assinado. Revisões anteriores ficam no histórico (substituídas, nunca apagadas).
2. **Cobrança** — plano sobre o saldo a lançar (ex.: R$ 3.000 em 50/50 → 2 × R$ 1.500; cartão =
   uma cobrança parcelada). Aprovar cria as **contas a receber oficiais** e emite a cobrança
   (Pix copia-e-cola/boleto/link). Vencimento ajustável, cancelamento, mensagem pronta para o
   WhatsApp (vira rascunho na conversa do cliente). **A baixa só acontece pela confirmação do
   provedor e uma única vez** (evento único por id + `payment_id` único na cobrança + bloqueio da
   linha): reenviar a mesma confirmação, ou receber "confirmado" depois de "recebido", não gera nova
   baixa. Estorno do provedor usa o estorno oficial.
3. **Nota** — perfis fiscais configuráveis (reforma = NFS-e; fabricação = a definir com a
   contabilidade). A nota é preparada, revisada e autorizada; sem perfil validado, códigos, alíquota,
   CPF/CNPJ, endereço ou conexão, a tela diz exatamente o que falta. Número, status e arquivos
   ficam guardados e entram no fechamento do mês.
4. **Materiais** — necessidade da OS, cotações e "Escolher e abrir pedido" no fluxo oficial de compras.

O painel **💼 Financeiro** (chip no escritório) tem: previsão de 7/30 dias (a receber, a pagar,
vencidos, maquininha), **Pagar** (preparar com favorecido, valor, vencimento e conta de origem →
confirmar → "autorize no app do banco"; só vira pago pela conciliação do extrato ou confirmação do
provedor), **Banco** (importar OFX/CSV sem duplicar, conciliar com sugestões), **Fechamento**
(documentos do mês por tipo, pendências e pacote .zip para a contabilidade), **Fiscal** (perfis) e
**Entregas** (paradas do dia com saldo a cobrar, fotos e nota). Na expedição, o painel do sofá
mostra o saldo a receber.

"Falar com a Cenário" entende: "Prepare o contrato da Ana", "Gere a entrada por Pix da OS 142"
(só prévia), "Quais entregas de amanhã têm saldo?", "Quais contas vencem até sexta?", "Preparar o
pagamento do fornecedor de espuma", "Separe as notas e comprovantes do mês".

## O que configurar para sair do modo de teste

| Conexão                | Variáveis no servidor                                                                                                   | Fora do sistema                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Meta (todas)           | `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` (…/api/v1/connections/meta/callback), `META_WEBHOOK_VERIFY_TOKEN` | App no Meta for Developers, webhook apontando para `/api/webhooks/meta`, empresa verificada, Revisão do App das permissões         |
| WhatsApp Business      | + `META_WA_CONFIG_ID` (Embedded Signup com coexistência)                                                                | Número elegível à coexistência (app WhatsApp Business atualizado); testar antes com número de teste; modelos aprovados para > 24 h |
| Instagram / Messenger  | —                                                                                                                       | Conta profissional ligada à Página; `instagram_manage_messages`, `instagram_content_publish`, `pages_messaging` aprovadas          |
| Meta Ads               | —                                                                                                                       | Conta de anúncios no Gerenciador de Negócios; `ads_read`/`ads_management`                                                          |
| Publicação de fotos    | `PUBLIC_MEDIA_BASE_URL`                                                                                                 | A Meta exige a imagem em endereço público HTTPS                                                                                    |
| Assinatura (Clicksign) | `CLICKSIGN_ACCESS_TOKEN`, `CLICKSIGN_BASE_URL`, `CLICKSIGN_WEBHOOK_SECRET`                                              | Plano com API; webhook para `/api/webhooks/clicksign`; homologar no sandbox (adaptador feito pela documentação v3)                 |
| Cobranças (Asaas)      | `ASAAS_API_KEY`, `ASAAS_BASE_URL`, `ASAAS_WEBHOOK_TOKEN`                                                                | Conta Asaas com chave Pix; webhook de cobranças para `/api/webhooks/asaas`                                                         |
| Emissão fiscal         | `FISCAL_PROVIDER`, `FISCAL_API_TOKEN`                                                                                   | Cadastro no Emissor Nacional (SJC desde 01/10/2026), certificado A1, perfis validados pela contabilidade; integração real pendente |
| Banco PJ / Maquininha  | —                                                                                                                       | Informar banco e adquirente para avaliar API; hoje: importação de extrato e relatório                                              |
| Segredos               | `INTEGRATIONS_SECRET_KEY` (cifra os tokens; sem ela usa `TOKEN_HASH_SECRET`)                                            | —                                                                                                                                  |
| Interpretação por IA   | `GAME_AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `GAME_AI_MODEL` (opcional)                                           | Opcional: sem ela, regras e sugestões clicáveis                                                                                    |

Evidências: `docs/evidencias/jogo/conexoes` (WhatsApp de ponta a ponta, Instagram, Messenger,
post de teste, campanhas e aprovação de orçamento) e `docs/evidencias/jogo/financeiro` (primeira
demonstração: contrato → assinatura → entrada → baixa única → ficha). Testes:
`apps/api/test/conexoes.test.ts` e `apps/api/test/escritorio-financeiro.test.ts`.

## Lacunas encontradas (pontos exatos a completar)

1. **Posição física nas etapas de produção**: o sistema só registra posição física
   (`POST /api/v1/pieces/:id/move`, `item_location_events`) na embalagem, expedição e entrega. Para
   confirmar posição em desmanche/corte/costura, é preciso cadastrar essas localizações e oferecer
   "Confirmar posição" no tablet (o mapa já desenha o alfinete quando o evento existir).
2. **Histórico de reservas**: reserva não é movimentação de estoque; a ficha mostra movimentações e
   reservas ativas, mas não reservas já consumidas/liberadas (precisaria de um endpoint de histórico
   de `stock_reservations`).
3. **Agentes**: Gerente, Compras, Atendimento, Marketing, Tráfego e Documentos usam regras
   explícitas sobre os dados e citam os registros (a IA, quando configurada, só interpreta frases
   do chat). A mão de obra por produção ainda não entra na previsão de caixa. Emissão fiscal real,
   API de pagamentos do banco e da maquininha dependem do provedor escolhido (hoje: teste local,
   importação de extrato e relatório).
4. **Compra a partir da proposta**: aprovar abre o pedido oficial já preenchido em rascunho; o
   agente não cria nem confirma pedido.
5. **Módulos/peças**: o cadastro distingue peças por item da OS (`OS-00012/1`, `/2`); não há
   submódulos de um mesmo item (ex.: módulos de um sofá de canto). Todas as peças da OS aparecem
   ligadas na ficha.
6. **Modelos 3D** são procedurais por categoria (sofá, retrátil, canto, poltrona, cadeira,
   cabeceira, pufe, banco, colchão); fotos reais aparecem na ficha da OS.
7. **Presença de outros usuários no mapa** (multijogador) não foi implementada: cada gestor vê o
   próprio avatar; funcionários e agentes aparecem pelos registros.

## Reversão

Ver `packages/db/rollback/20270309000000_conexoes_escritorio.down.sql` (conexões, caixa de entrada e
escritório financeiro) e `packages/db/rollback/20270302000000_jogo_gestao.down.sql` (remove só as tabelas e permissões
do jogo; dados operacionais intactos). O código do jogo fica isolado em `modules/game` e
`components/game`.
