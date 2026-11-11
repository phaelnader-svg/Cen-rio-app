# Reformulação — Fase 2: relatório final (F2.0 a F2.6)

Tudo foi feito **somente no ambiente de desenvolvimento isolado**: PostgreSQL 16 local e
descartável, armazenamento local e navegador local. Nenhum deploy, merge, migration em ambiente
compartilhado, alteração de homologação (ativa `3e0d2d0`, candidata `de31aa7`), da `main` ou de
produção. A Fase 3 **não** foi iniciada.

- Branch: `claude/reformulacao-fase-2` (derivada de `3e0d2d0`).
- Commit final: ver a seção 11.
- Legenda: **[TESTADO]** coberto por teste automatizado que passou · **[MEDIDO]** observado em
  execução real isolada · **[INSPECIONADO]** verificado por leitura de código ou captura ·
  **[NÃO TESTADO]**.

## 1. Funcionalidades concluídas

| #   | Escopo autorizado                   | Entrega                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OS de 10 para ~6 abas               | **6 abas**: Resumo (com mão de obra), Peças e fotos, Materiais, Produção, Qualidade e entrega, Histórico. Links antigos (`?tab=fotos`, `linha-do-tempo`, `entrega`, `mao-de-obra`) continuam abrindo a aba certa. Nada removido: cada conteúdo antigo está numa das 6 abas                                                                                  |
| 2   | Estado geral da OS no cabeçalho     | Selo da situação operacional (13 estados da Fase 0), contadores e **próximo passo** com atalho para a aba que trata dele. O atalho **só navega** (seção 6.4)                                                                                                                                                                                                |
| 3   | P1, P2, P3 da Fase 1                | P1: formulário de material quebra linha em vez de espremer. P2: abas roláveis com setas e a aba ativa sempre visível. P3: contador de Materiais soma a lista simples e a formal                                                                                                                                                                             |
| 4   | Modelos de serviço unificados       | "Modelos de serviço" (mesmo endereço do antigo "Modelos de produção"): por tipo de peça × serviço, etapas + checklist + materiais padrão, pelas **mesmas regras** do planejamento e da inspeção. Etapas e checklists continuam editados pelos editores existentes (agora também como abas), sem duplicar dados                                              |
| 5   | Sugestão de materiais pelos modelos | Materiais padrão (tabela nova) por tipo de peça e, opcional, serviço; quantidade por peça. Na OS, "Sugerir do modelo" mostra a prévia e cria linhas da lista simples **sem custo, não compradas e não disponíveis**, revisáveis pelo gestor. Nunca cria compra, despesa, custo realizado, reserva ou movimento de estoque (seção 6.7)                       |
| 6   | Tratamento seguro de fotos novas    | No servidor: orientação aplicada, **todos os metadados removidos (EXIF/GPS/XMP/IPTC)**, lado maior até 2560 px (funcionário: 1024 px), miniatura WebP 480 px; o original com GPS **não é guardado**. No navegador, redução prévia (otimização). Fotos antigas: sem reprocessamento em massa; saem sem metadados pela rota comum, original intacto (seção 7) |
| 7   | Miniaturas e visualizador           | Galerias carregam miniaturas; visualizador em tela cheia com teclado, gesto, anterior/próxima e "Abrir em nova aba"                                                                                                                                                                                                                                         |
| 8   | Tablet: tarefa e recebimentos       | Tarefa: o essencial à vista (situação, ações, o que fazer, peças, **um** bloco de materiais); dependências, etapas da OS, fotos e históricos em "Mais detalhes". "Recebimento de materiais" reunido em "Aguardando chegada" (avisos de chegada + conferência lado a lado, mesmas telas, regras e permissões)                                                |
| 9   | Mapa interno da oficina             | "Mapa da oficina": áreas = localizações já cadastradas; peças das OS abertas em cada área; "Sem localização registrada" com o texto do recebimento; busca que diz onde a peça está; movimentação pela rota existente (mesmas permissões, histórico imutável). A OS mostra a localização registrada, mantendo o texto do recebimento. Sem mapa geográfico    |
| —   | Lacuna da Fase 1                    | E2E da tela de conciliação do custo de material (vincular, desfazer, "é outro material", conferindo o realizado)                                                                                                                                                                                                                                            |

Decisões D4–D9 ficam para as fases seguintes, como autorizado. D5 (desfazer entrega direta) terá
a regra detalhada apresentada **antes** da implementação na Fase 3.

## 2. Arquivos e migrations

**Uma migration aditiva**: `20270316000000_reformulacao_fase_2` (sha256 `187744c6…`), com
reversão manual `packages/db/rollback/20270316000000_reformulacao_fase_2.down.sql` (sha256
`d2953e65…`). A migration da Fase 1 (aplicada em homologação) **não mudou**.

| Mudança no banco                                                                                                                          | Tipo                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `stored_files`: `processed_at`, `width`, `height`, `thumb_key` (único), `thumb_size_bytes`, `original_size_bytes` + CHECK de consistência | colunas novas, todas anuláveis |
| `service_model_materials` (materiais padrão)                                                                                              | tabela nova                    |
| `service_order_materials.source_model_material_id` (+ índice, FK `RESTRICT`)                                                              | coluna nova anulável           |

Nenhuma linha existente é alterada, nenhuma coluna ou tabela é removida. A trava estrutural
(`rodada4-travas-estruturais`) registra as 5 cláusulas `ON UPDATE CASCADE` das chaves novas como
exceção justificada (não são comandos de alteração de dados).

Código (65 arquivos em relação a `3e0d2d0`; principais):

- API: `core/storage/image.ts` (tratamento), `modules/files` (leitura segura e miniatura),
  `modules/attachments` e `modules/employees` (envio tratado), `modules/service-models` (novo),
  `modules/workshop-map` (novo), `modules/service-orders` (localização atual na OS),
  `tools/fotos-legadas.ts` (diagnóstico **somente leitura** das fotos antigas).
- Web: `service-order-detail.tsx` (6 abas), `os-state.tsx` (cabeçalho), `ui/tabs.tsx` (P2),
  `os-material-list.tsx` (P1 e sugestão), `photo-gallery.tsx` + `lib/photos.ts` (visualizador e
  envio), `service-models/*`, `workshop-map/*`, `tablet/tasks.tsx` e `tablet/home.tsx`, menu.
- Shared: `service-models.ts`, `workshop-map.ts`, `operational-state.ts` (próximo passo), DTOs.
- Dependência nova da API: `sharp 0.35.5` — a **mesma versão** que o Next já usava; o lockfile
  só ganha a entrada da API (nenhuma resolução existente mudou).

## 3. Testes executados

| Suíte                                                          | Resultado                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| shared                                                         | **150 passaram**, 0 falharam                                                                                |
| web (unitários, inclui a trava do menu)                        | **21 passaram**, 0 falharam                                                                                 |
| API, suíte completa                                            | **986 passaram, 0 falharam, 13 pulados** (999; os 13 são os opcionais pré-existentes de desempenho e proxy) |
| E2E de navegador, suíte completa                               | ver seção 11                                                                                                |
| Lint (`eslint . --max-warnings=0`)                             | **sem erros nem avisos**                                                                                    |
| Typecheck (todos os pacotes, incluindo E2E)                    | **sem erros**                                                                                               |
| Formatação (`prettier --check`)                                | **ok**                                                                                                      |
| Build de produção do web (Next)                                | **ok**                                                                                                      |
| Cadeia completa de migrations (`test-evolution-migrations.sh`) | **passou** (seção 4)                                                                                        |
| Compatibilidade `3e0d2d0` no schema novo                       | **971 passaram, 1 falha estática esperada, 13 pulados** (seção 5)                                           |
| Verificação cruzada de versões com dados da Fase 2             | **3 de 3 etapas** (seção 5)                                                                                 |
| Reversão da Fase 2 por tipo de dado                            | **4 de 4 casos** (seção 4)                                                                                  |

Testes novos da Fase 2: API `fase2-fotos` (6), `fase2-modelos-servico` (5), `fase2-mapa-oficina`
(3); E2E `fase1-conciliacao`, `fase2-modelos-servico`, `fase2-mapa-oficina` (2),
`fase2-os-estado-fotos` (2), `zz-fase2-capturas`; e a etapa de escrita da Fase 2 no
`evolution-migration.check`.

## 4. Migrations e rollback

### 4.1 Cadeia completa [MEDIDO]

`scripts/test-evolution-migrations.sh` (banco legado `839770a` → todas as 36 migrations):

- aplica sobre o legado com **dados legados idênticos** (95 tabelas) e índices preservados;
- reverte as posteriores à Evolução, **começando pela da Fase 2**, voltando ao schema exato da
  Evolução com dados idênticos; reaplica e o schema e os dados ficam idênticos;
- com dados novos de todas as fases, **cada reversão é recusada** de forma atômica (schema,
  migrations e dados inalterados). Fase 2: _"Reversão bloqueada: 2 registro(s) da Fase 2 (fotos
  tratadas, materiais padrão ou sugestões aplicadas)"_;
- backup e restauração verificados; a aplicação sobe sobre o banco restaurado.

### 4.2 Recusa da reversão quando há dados da Fase 2 [MEDIDO]

O `.down.sql` soma fotos tratadas + materiais padrão (ativos **ou arquivados**) + linhas da OS
vindas de sugestão; se a soma for maior que zero, aborta **antes** de qualquer alteração.
Medido num banco descartável:

| Caso                                  | Resultado                                              |
| ------------------------------------- | ------------------------------------------------------ |
| só uma foto tratada                   | recusado; migration continua registrada; nada alterado |
| só um material padrão (sem uso em OS) | recusado; idem                                         |
| material padrão + sugestão aplicada   | recusado (cadeia completa, 4.1)                        |
| nenhum dado da Fase 2                 | reverte por completo; `migrate deploy` reaplica        |

Por que recusar mesmo com um único material padrão: a reversão apagaria a tabela, e com ela a
configuração do gestor e a origem das linhas sugeridas. Linha sugerida sempre aponta para um
material padrão (FK `RESTRICT`), e material padrão só é **arquivado**, nunca apagado — então a
contagem nunca perde uma sugestão aplicada.

### 4.3 Estratégia de recuperação sem perda de dados

Como nas Fases 0 e 1, **o banco não volta**; volta só a aplicação:

1. **Retorno da aplicação** para a versão de retorno da Fase 2 = código `3e0d2d0` + a pasta
   `20270316000000_reformulacao_fase_2` byte a byte idêntica (o executor recusa banco com
   migration desconhecida pela imagem). O schema novo é só aditivo, e a seção 5 prova que essa
   versão funciona sobre ele com dados da Fase 2.
2. O `.down.sql` é só para banco **sem** dados da Fase 2 (ex.: falha logo após a migration);
   com dados ele se recusa sozinho.
3. Último recurso: o ponto de recuperação feito imediatamente antes da migration (procedimento
   de homologação já usado na Fase 1), com perda do que foi gravado depois — só com autorização.

A versão de retorno **não foi construída** (sem build no Cloud Build, sem branch publicada): isso
faz parte da preparação da homologação final e depende de autorização.

## 5. Compatibilidade com `3e0d2d0` [MEDIDO]

| Verificação                                                                                | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Suíte completa da API de `3e0d2d0` (+ pasta da migration) sobre o schema da Fase 2         | **971 passaram, 1 falhou, 13 pulados** (985). A falha é a trava **estática** antiga `rodada4-travas-estruturais`: a lista de exceções dela não conhece as 5 cláusulas `ON UPDATE CASCADE` da migration nova. É leitura de arquivo, não execução — o mesmo caso da Fase 1                                                                                                                                                                                     |
| Nova grava dados da Fase 2 → antiga lê e escreve → nova relê (mesmo banco e armazenamento) | **3 de 3.** A antiga abre a OS; vê a linha sugerida como linha comum e a edita (quantidade, comprado); cria outra linha; **nenhum lançamento** no livro de custos; serve a foto tratada sem EXIF; a rota do mapa responde 404 (sem erro). A nova relê tudo: a linha continua reconhecida como sugerida (não sugere de novo), o mapa e a localização na OS estão corretos, e **a foto gravada pela antiga sai sem EXIF/GPS** pela rota comum e pela miniatura |

Ressalvas do período em que a versão antiga estiver ativa (só em caso de retorno):

- fotos enviadas nesse período são gravadas **sem tratamento** (com GPS no arquivo). Quando a
  Fase 2 voltar, elas são servidas sem metadados pela rota comum, mas o arquivo original guarda o
  GPS até a migração em lotes (seção 7);
- materiais padrão, sugestão e mapa ficam indisponíveis (os dados continuam no banco);
- excluir uma foto tratada pela versão antiga não apaga a miniatura (arquivo órfão no
  armazenamento, sem referência e sem acesso).

## 6. Pontos de atenção pedidos

### 6.1 Rollback com materiais padrão

Seções 4.2 e 4.3: a reversão do banco é recusada com qualquer material padrão cadastrado
(inclusive arquivado), sem alterar nada; a recuperação é pela aplicação.

### 6.2 Alteração em `purchasing.spec` — justificativa e cobertura

- **O que mudou:** a verificação `getByRole('button', { name: /produção/i })` com contagem 0
  passou a valer **dentro do painel da aba ativa (Materiais)**, e não na página inteira.
- **Por quê:** o cabeçalho da OS (F2.2) tem o atalho "Planejar a produção da OS", que fica fora
  das abas e só troca de aba. A verificação original existe para provar que **a área de
  materiais não oferece nenhum botão que inicie produção** quando o material fica completo. Essa
  garantia continua igual: no painel de Materiais segue não havendo nenhum botão com "produção".
- **Cobertura compensatória** (não houve enfraquecimento): o novo E2E `fase2-os-estado-fotos`
  clica no atalho e prova que ele só leva à aba Produção — a lista de produção da OS e o estado
  operacional são **idênticos** antes e depois. A mesma `purchasing.spec` continua provando, logo
  em seguida, que a aba Produção mostra "Nenhuma tarefa programada".
- Os demais E2E ajustados (`commercial-flow`, `gestao`, `novo-servico`, `modelos-simplificados`,
  `zz-geometria`, `zz-visual-audit`, `zz-fluxo-transversal`, `tablets`) mudaram **só a navegação**
  (nome da aba, endereço `?tab=`, tile do tablet). Nenhuma asserção foi removida ou afrouxada; em
  `tablets` foram **acrescentadas** asserções de "Mais detalhes".

### 6.3 Mapa com peças sem localização registrada [TESTADO]

Peça sem movimentação registrada aparece em "Sem localização registrada" (agora a primeira área
do mapa) com cliente, etapa e o texto do recebimento ("No recebimento: …"). Movê-la pela tela a
leva para a área escolhida, com "Movida por … em …". OS cancelada e peça entregue/devolvida saem
do mapa; área desativada com peça continua visível (ninguém perde a peça de vista); área
desativada vazia some.

### 6.4 "Planejar a produção da OS" só navega [TESTADO + INSPECIONADO]

O botão do cabeçalho chama apenas `onGo(area)`, que troca a aba (`setTab`); não há chamada à
API. O E2E `fase2-os-estado-fotos` compara a produção da OS e o estado operacional antes e depois
do clique: idênticos (`NAO_PLANEJADA`). O mesmo vale para os outros textos de próximo passo
("Iniciar a produção", "Inspecionar a qualidade" etc.): todos usam o mesmo `onGo`.

### 6.5 Segurança das permissões de movimentação [TESTADO]

- A rota de movimentação **não mudou**: `POST /api/v1/pieces/:id/move` exige
  `producao.executar`, `qualidade.gerenciar` ou `entregas.gerenciar` (como antes), grava o
  histórico imutável `item_location_events` e o evento de tempo real.
- O mapa é **somente leitura** (`os.ver`, `producao.ver/planejar`, `qualidade.gerenciar`,
  `entregas.ver/gerenciar`, sessão do painel). O seletor "Mover para…" só aparece com permissão
  de mover; sem ela, a API responde 403 (testado com usuário só `os.ver`). Sem nenhuma dessas
  permissões o mapa responde 403.
- Observação (regra existente, não alterada): qualquer funcionário com `producao.executar` pode
  mover qualquer peça, inclusive pelo tablet.

### 6.6 Preservação de produção, compras, recebimentos e financeiro [TESTADO]

A suíte completa da API (986) e a E2E completa cobrem esses fluxos sem alteração de regra. Em
particular, continuam passando: matriz de permissões e tempo real, transação e auditoria,
concorrência e idempotência, revisão financeira da Fase 1, compras sem duplicidade, recebimentos
compartilhados, distribuição, fila semanal, fechamento semanal.

### 6.7 Integridade financeira e auditoria dos modelos [TESTADO]

- A aplicação da sugestão é provada sem efeito em: livro de custos, pedidos e itens de compra,
  necessidades formais, ajustes e quantidades do estoque simples, movimentos de estoque, contas
  a pagar (fotografia antes/depois idêntica).
- Linhas sugeridas nascem `purchased=false`, `available=false`, `costCents=null`; repetir não
  duplica; linha removida pode ser sugerida de novo; material escolhido que não serve para a OS
  é recusado sem gravar nada; OS cancelada recusa; sem `financeiro.ver` a resposta não traz custo.
- Auditoria: `service_model.material_added/updated/archived` e
  `service_order.material_list_added` com a origem ("sugerido pelo modelo de serviço", peças de
  origem e id do material padrão).
- A versão antiga editando a linha sugerida também não lança nada indevido (seção 5).

### 6.8 Conciliação de materiais da Fase 1 [TESTADO]

API `fase1-revisao-financeira` e `fase1-materiais-estoque-entrega` completas passando; E2E
`fase1-conciliacao` (vincular → R$ 540,00; desfazer → R$ 1.080,00; "é outro material" → R$
1.080,00 sem aviso) passando.

### 6.9 Fotos novas sem GPS [TESTADO]

- API: foto de celular 4000×3000 com orientação 6 e GPS é gravada 1920×2560, **sem EXIF**, com
  miniatura 360×480 WebP; PNG e WebP mantêm o formato; arquivo corrompido 415 e resolução
  excessiva 413 sem gravar nada; foto do funcionário 768×1024.
- E2E pelo navegador: foto com GPS e orientação enviada pela galeria da OS → registro 1200×1600
  (orientada) e **nem a foto nem a miniatura** baixadas contêm bloco EXIF, a etiqueta GPS
  (0x8825) ou o fabricante do aparelho.
- Única leitura do armazenamento: as duas rotas de arquivo; foto antiga sem tratamento sai
  sanitizada nas duas (testado também na verificação cruzada).

## 7. Fotos antigas (D2)

Sem reprocessamento em massa, sem sobrescrever originais. O que foi feito:

- **Exposição nos acessos comuns:** fotos anteriores à Fase 2 (`processed_at` nulo) são servidas
  pela rota comum e pela miniatura **reprocessadas em memória, sem metadados**; o arquivo
  original fica intacto no armazenamento.
- **Diagnóstico somente leitura:** `apps/api/src/tools/fotos-legadas.ts` conta fotos antigas,
  com EXIF, com GPS, a girar, ilegíveis e ausentes, por finalidade, sem gravar nada. Não foi
  executado em ambiente compartilhado.
- **Plano da migração em lotes** (depende de autorização específica): (1) backup do banco e do
  diretório de armazenamento, com conferência de hash; (2) diagnóstico para dimensionar;
  (3) processamento em lotes pequenos, gravando a versão tratada e a miniatura em chaves **novas**
  e atualizando o registro numa transação, só depois de conferir o arquivo novo; (4) o original
  só é removido em etapa separada, depois de uma janela de verificação e com aprovação;
  (5) relatório por lote com contagens e falhas; reexecução idempotente.

## 8. Capturas e avaliação visual

Capturas em `docs/evidencias/reformulacao-fase-2/1440/` e `.../390/` (18 telas em cada largura):
OS nas 6 abas, visualizador de fotos, sugestão de materiais, Modelos de serviço (por serviço com
detalhe, etapas, checklists, materiais padrão), Mapa da oficina, e no tablet: início, Aguardando
chegada, Conferir materiais, tarefa e tarefa com "Mais detalhes". O E2E das capturas verifica, em
cada tela e largura, ausência de rolagem horizontal e de erro de página.

Problemas encontrados na inspeção e **corrigidos**:

| Tela                                  | Problema                                                                                    | Correção                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Modelos de serviço › Por serviço, 390 | tabela de 4 colunas espremida; "1 material(is)" cortado na borda                            | em telas estreitas, um cartão por serviço; tabela a partir de 768 px |
| Modelos › detalhe, 1440               | botão "Abrir checklist" quebrava para baixo do título (inconsistente com os outros cartões) | rótulos curtos (Abrir/Criar/Editar) com nome acessível completo      |
| Mapa da oficina, 1440                 | áreas vazias esticavam até a altura da área mais cheia da linha                             | grade alinhada ao topo                                               |
| Mapa da oficina, 390                  | peças sem localização ficavam no fim, depois de 8 áreas vazias                              | "Sem localização registrada" primeiro                                |
| Tablet › tarefa, 390                  | "Mais detalhes" quebrava em duas linhas ao lado da descrição                                | título e descrição empilhados em telas estreitas                     |
| Visualizador de fotos                 | fundo 90% deixava o texto da página aparecer por trás da barra superior                     | fundo sólido                                                         |

Sem outros cortes, sobreposições ou problemas de navegação nas 36 capturas. Observação de
conteúdo (não de layout): as localizações de fábrica incluem "Em transporte" e "Entregue"; no
mapa, "Entregue" fica sempre vazia porque peças entregues saem da oficina. O cadastro de áreas é
do gestor (Qualidade › Inspetor e localizações); nada foi alterado nele.

## 9. Problemas encontrados durante a fase

- Typecheck mascarado por `| head` num commit intermediário (corrigido no commit seguinte;
  checagens não são mais encadeadas a filtros).
- `sharp 0.34.4` alterava a resolução do Next: trocado por 0.35.5 (a mesma do Next).
- Chave de miniatura rejeitada pelo padrão de chaves do armazenamento: usada
  `attachment-thumb/<uuid>` sem afrouxar o padrão.
- `purchasing.spec` quebrado pela F2.2 (seção 6.2), descoberto ao rodar a suíte maior.
- E2E da F2.6 usava `__dirname` (não existe em ESM): corrigido antes da rodada completa.
- Rota existente de localizações responde 200 (o E2E do mapa esperava 201): o teste foi
  corrigido, a rota não mudou.

## 10. Riscos remanescentes

1. **Fotos antigas** continuam com GPS no arquivo até a migração em lotes; o acesso comum já não
   expõe. Risco residual: backup do armazenamento e acesso direto ao disco da VM.
2. **CPU na VM**: o tratamento de imagem roda no servidor (`sharp`, uma imagem por vez, sem
   cache). Foto de celular é reduzida no navegador antes do envio, mas um envio grande sem redução
   ainda custa alguns décimos de segundo de CPU. [NÃO TESTADO na VM]
3. **Retorno para a versão antiga** volta a gravar fotos sem tratamento (seção 5).
4. Mover peças continua permitido a todo `producao.executar` (regra existente).
5. Pendências da Fase 1 (D9) seguem registradas para reavaliação antes da homologação final.
6. Nada foi validado em homologação: a validação funcional integrada fica para a homologação
   final, após as Fases 3 e 4, como decidido.

## 11. Resultado final

Ver o resumo no fim da F2.6 (preenchido após a rodada completa de E2E).
