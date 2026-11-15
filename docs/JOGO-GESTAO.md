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
- Demonstração no navegador (Playwright, tablets reais em `/tablet`) das três jornadas pedidas.
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

## Integrações externas (status no painel 🔌 do escritório)

| Integração                   | Situação           | O que falta                                                                            |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| Cenário Gestão               | Conectada          | —                                                                                      |
| WhatsApp Business            | Precisa configurar | conta autorizada na API oficial e número da empresa (`WHATSAPP_API_TOKEN`)             |
| Instagram (Meta Graph API)   | Precisa configurar | conta profissional ligada a página e token de publicação (`INSTAGRAM_ACCESS_TOKEN`)    |
| Emissor fiscal               | Precisa configurar | provedor, certificado e regime (`FISCAL_API_TOKEN`)                                    |
| Modelo de orçamento/contrato | Precisa configurar | texto padrão, condições e cláusulas da Cenário                                         |
| Modelo de linguagem          | Opcional           | `ANTHROPIC_API_KEY` para respostas livres (hoje os agentes usam regras sobre os dados) |

Com variável presente, a integração aparece como "modo de teste": aprovações ficam registradas como
execução de teste. Nenhum envio, publicação, compra, pagamento ou nota acontece sem aprovação.

## Lacunas encontradas (pontos exatos a completar)

1. **Posição física nas etapas de produção**: o sistema só registra posição física
   (`POST /api/v1/pieces/:id/move`, `item_location_events`) na embalagem, expedição e entrega. Para
   confirmar posição em desmanche/corte/costura, é preciso cadastrar essas localizações e oferecer
   "Confirmar posição" no tablet (o mapa já desenha o alfinete quando o evento existir).
2. **Histórico de reservas**: reserva não é movimentação de estoque; a ficha mostra movimentações e
   reservas ativas, mas não reservas já consumidas/liberadas (precisaria de um endpoint de histórico
   de `stock_reservations`).
3. **Agentes**: Gerente e Compras usam regras explícitas sobre os dados (prazos, filas, faltas,
   saldo livre, contas e recebimentos) e citam os registros; perguntas livres caem nessas análises.
   WhatsApp, Orçamentos, Financeiro/fiscal e Instagram ficam configuráveis, mas sem motor até as
   integrações acima. O caixa do Gerente considera contas a pagar e recebimentos; a mão de obra por
   produção ainda não entra na conta.
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

Ver `packages/db/rollback/20270302000000_jogo_gestao.down.sql` (remove só as tabelas e permissões
do jogo; dados operacionais intactos). O código do jogo fica isolado em `modules/game` e
`components/game`.
