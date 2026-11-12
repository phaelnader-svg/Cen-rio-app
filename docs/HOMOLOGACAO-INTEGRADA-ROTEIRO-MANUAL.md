# Homologação integrada (Fases 0 a 4) — roteiro de testes manuais

Versão a homologar: **`7e047d5`** (`claude/reformulacao-fase-4`). Executar **só depois** do deploy
autorizado (ver `HOMOLOGACAO-INTEGRADA-PREPARACAO.md`). Este roteiro é para o gestor e a equipe; cada
passo diz o que fazer e o que deve acontecer. Marque ✔ (passou), ✘ (falhou: anote tela, hora e o que
apareceu) ou — (não se aplica).

## 0. Regras

- **Somente dados sintéticos.** Clientes, OS, valores e fotos inventados, com o prefixo **`HML-`** no
  nome (ex.: "HML-Cliente Sofá Azul"). Fotos: de objetos ou estofados de teste, nunca de pessoas,
  documentos ou endereços reais.
- **Preservar os dados reais** já existentes na homologação: não editar, cancelar, pagar ou entregar
  nada que não comece com `HML-`.
- Valores pequenos e redondos (R$ 100,00, R$ 250,00), para conferir contas de cabeça.
- Anotar a hora de cada ✘: os registros do servidor são consultados por janela de tempo.
- Ao final, os registros `HML-` ficam como histórico da homologação (não apagar).

## 1. Perfis e dispositivos

| Perfil               | Quem testa                | Permissões principais                                                          |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Gestor               | gestor                    | tudo                                                                           |
| Planejamento (sem $) | conta de teste `HML-plan` | `producao.planejar`, `producao.ver`, `os.ver` — **sem** nenhuma `financeiro.*` |
| Entregas             | conta de teste `HML-entr` | `entregas.ver`, `entregas.gerenciar` — sem `financeiro.gerenciar`              |
| Tapeceiro (tablet)   | funcionário de teste      | `producao.executar` (PIN)                                                      |
| Qualidade (tablet)   | funcionário de teste      | `qualidade.gerenciar` (PIN)                                                    |

Dispositivos: **computador** (Chrome, 1440 px), **celular** (Chrome Android ou iPhone, tela ~390 px),
**Safari** (iPhone/iPad ou Mac) e **tablet físico** da oficina. Os testes marcados 📱 repetem no
celular; 🧭 no Safari; 🖥 só no computador; 📟 no tablet físico.

## 2. Roteiro

### 2.1 Acesso, menu e Início (Fase 0 / Fase 3 / Fase 4) 🖥📱🧭

1. Entrar como gestor. → Início abre com a saudação e a seção **"Hoje"** (Em execução, Na oficina,
   Prontas aguardando entrega, Pendências).
2. Menu "Produção" com **8 itens** (Medições, Programação semanal, Quadro de produção, Mapa da oficina,
   Pedidos de ajuda, …). "Planejamento de sexta" e "Competências" não aparecem no menu, mas abrem
   pelos links (Medições → Planejamento de sexta; Programação → Competências).
3. Celular: menu abre e fecha; nenhuma tela com rolagem lateral.
4. Sair e entrar de novo; sessão expira normalmente.

### 2.2 Clientes e OS (Fases 0–2) 🖥📱

1. Cadastrar cliente `HML-Cliente 1` (telefone fictício).
2. **Novo serviço** → OS com 2 peças (sofá e 2 poltronas), prazo prometido daqui a 10 dias.
3. Abrir a OS: **6 abas** (Resumo, Peças, Materiais, Produção, Qualidade, Histórico) e o **selo de
   estado** no cabeçalho. Endereço antigo `/painel/os/<id>?tab=pecas` abre a aba certa.
4. A lista de OS mostra o mesmo estado do cabeçalho.
5. Celular: abas roláveis, conteúdo legível, sem rolagem lateral.

### 2.3 Modelos de serviço (Fase 2) 🖥

1. Produção → Modelos: criar `HML-Reforma sofá 3 lugares` com 2 materiais padrão (espuma, tecido).
2. Na OS `HML-`, usar o modelo numa peça: os materiais padrão aparecem como **sugestão**; aceitar um,
   recusar o outro. Nada é lançado sozinho.
3. Editar o modelo: a OS já criada não muda.

### 2.4 Materiais, compras, estoque e conciliação (Fase 1) 🖥

1. Aba Materiais da OS: lançar `HML-Espuma D33` (não comprado) e `HML-Tecido` (comprado, custo
   R$ 100,00, disponível).
2. Marcar a espuma como comprada e depois "na oficina"; a marcação fica após recarregar.
3. Estoque da oficina: entrada de `HML-Grampo` (10 un.), saída de 2 para a OS; saldo 8.
4. Compra formal do mesmo tecido (fluxo de compras) com custo R$ 100,00 → a OS mostra **pendência de
   conciliação**; vincular ("é o mesmo") → o custo conta **uma vez** (R$ 100,00, não 200,00).
5. Interruptor "Travas de materiais na produção" (Empresa → Funcionalidades): ligado → produção
   bloqueada por material faltante; desligado → não bloqueia, só avisa. **Religar** ao final.

### 2.5 Fotos e anexos (Fase 2) 🖥📱🧭📟

1. Pelo celular, tirar foto **na vertical** de uma peça de teste e anexar à OS. → aparece **em pé**,
   com miniatura, e abre no visualizador (ampliar, próxima/anterior).
2. Baixar a foto e conferir as propriedades no computador: **sem localização (GPS)** e sem dados da
   câmera.
3. Anexar um PDF pequeno à OS; abre e baixa.
4. Safari (iPhone): tirar foto e anexar; mesma orientação correta.
5. Foto grande (> 5 MB, se o celular gerar) é reduzida antes do envio; o envio não falha.
6. 📟 Tablet: anexar foto na tarefa; aparece na OS.

### 2.6 Recebimento de peças (Fase 2) 🖥📟

1. Registrar a chegada das peças da OS `HML-` (recebimento simplificado), com foto.
2. A peça muda para "na oficina" e aparece no mapa (2.8).

### 2.7 Tablets e produção (Fases 0–2) 📟

1. Entrar no tablet com o PIN do tapeceiro de teste.
2. Ver a tarefa publicada (2.9) → **iniciar**, **pausar com impedimento** ("faltou material"),
   **retomar**, **concluir** com observação.
3. Pedido de ajuda pelo tablet → aparece em "Pedidos de ajuda" no painel; atender e encerrar.
4. Presença: registrar chegada; aparece em "Na oficina" no Início.
5. Desconectar o Wi-Fi do tablet por 1 minuto durante uma tarefa e reconectar: a ação sincroniza sem
   duplicar.

### 2.8 Mapa da oficina (Fase 2) 🖥📱📟

1. Mapa: peças `HML-` no local certo; peça sem local registrado aparece em "sem localização".
2. Mover uma peça para outro local (tablet e painel); histórico registra quem moveu.

### 2.9 Programação semanal (Fase 3) 🖥📱

1. Programação semanal → aba **Serviços**: escolher tapeceiro e data de início da OS `HML-`.
2. Aba **Semana detalhada**: ajustar responsável/dia; **publicar** pelo diálogo único (prévia +
   observação). O tablet recebe a tarefa.
3. Endereços antigos (`/painel/producao/a-planejar`, `/painel/producao/planejamento`) abrem a aba
   correspondente.
4. Celular: as duas abas usáveis (a tabela da Semana detalhada rola dentro do cartão — conhecido).

### 2.10 Qualidade e embalagem opcional (Fase 3) 🖥📟

1. Peça concluída → inspeção aberta. No tablet de qualidade, **"Tudo conforme — aprovar"** → aprovada.
2. Gestor que **executou** a peça tenta aprovar: exige justificativa de **10+ caracteres**; aprovar
   com justificativa → Auditoria mostra a exceção destacada.
3. Gestor reprova a própria peça **sem** justificativa → permitido e auditado.
4. Item não conforme → "Tudo conforme" recusa; reprovar gera correção.
5. Embalagem **ligada** (padrão): aprovada → "aguardando embalagem" → embalar → pronta para entrega.
6. Desligar "Embalagem obrigatória" → nova peça aprovada vai direto a **pronta para entrega**, sem
   registro de embalagem. **Religar** ao final; a peça já aprovada continua pronta (a regra fica
   gravada na aprovação).

### 2.11 Entrega direta e reversão (Fases 1 e 3) 🖥

Preparar: OS `HML-` com mão de obra "na entrega" (R$ 100,00), mão de obra "na aprovação"
(R$ 100,00) e cobrança "na entrega" (R$ 250,00).

1. OS → Qualidade → **Marcar como entregue** → entrega registrada como "confirmação direta pela OS";
   mão de obra "na entrega" passa a liberada; cobrança passa a vencer.
2. **Desfazer** (perfil com `entregas.gerenciar` + `financeiro.gerenciar`): a prévia lista peças,
   mão de obra e cobranças afetadas; justificativa curta é recusada; com 10+ caracteres desfaz.
   → peças voltam a "pronta para entrega"; mão de obra "na entrega" volta a prevista; a da aprovação
   **não muda**; cobrança volta a "aguardando entrega"; a entrega original fica no histórico marcada
   "desfeita"; auditoria destacada.
3. Perfil `HML-entr` (sem financeiro): **não** vê o botão Desfazer.
4. Bloqueios (cada um numa OS `HML-` separada) — o Desfazer deve ser **recusado** com o motivo:
   a) mão de obra da entrega paga (mesmo parcial); b) semana do fechamento **conferida**;
   c) cobrança da entrega recebida depois da entrega; d) entrega mais nova na mesma OS;
   e) mais de 7 dias (não testável em tempo real — coberto por teste automático).
5. Clicar Desfazer duas vezes rápido → uma única reversão.

### 2.12 Financeiro e mão de obra (Fases 0–3) 🖥

1. Financeiro → Painel e Resultado por OS da OS `HML-`: receita, custos (material conciliado uma
   vez), mão de obra e margem coerentes com os valores lançados.
2. Pagar parcialmente uma mão de obra `HML-` (R$ 50,00): status "pago parcial"; estornar o pagamento.
3. Receber parte de uma cobrança `HML-`; estornar o recebimento (o estorno é um novo lançamento; o
   original não é apagado).
4. Fechamento semanal de um profissional de teste: conferir e reabrir (reabrir exige motivo).
5. Aba Produtividade do Financeiro: números iguais à aba Produtividade da Programação (2.13).

### 2.13 Painel diário, alertas e produtividade (Fase 4) 🖥📱🧭

1. Início → "Hoje": a tarefa em execução do tablet aparece em "Em execução"; quem registrou chegada
   em "Na oficina"; peça pronta em "Prontas aguardando entrega" com os dias.
2. **Ações sugeridas hoje**: cada uma tem título, porquê e link; clicar só abre a tela — nada muda.
3. Alertas (recalculados a cada 5 min; esperar até 5 min):
   a) OS `HML-` com prazo prometido **ontem** → sininho "Prazo em risco"; mudar o prazo para daqui a
   30 dias → o aviso some sozinho em até 5 min;
   b) material faltante numa OS `HML-` com tarefa programada para amanhã → "Material faltante";
   marcar disponível → some;
   c) peça pronta há 2+ dias (se houver) → "Peça pronta sem entrega".
   Nenhum e-mail ou WhatsApp é enviado.
4. Perfil `HML-plan`: Programação semanal → aba **Produtividade** abre, **sem nenhum valor em R$**;
   Financeiro **não** abre (acesso negado).
5. Celular e Safari: "Hoje" legível, sem rolagem lateral.

### 2.14 Permissões e auditoria 🖥

1. `HML-entr` não vê Financeiro; `HML-plan` não vê valores em nenhuma tela que abre.
2. Tablet de tapeceiro não aprova inspeção nem muda interruptores da empresa.
3. Auditoria: filtro "Exceções destacadas" mostra a autoaprovação (2.10) e a reversão (2.11).
4. Cada ação dos passos acima aparece na auditoria com quem, quando e o quê.

### 2.15 Compatibilidade de dispositivos

| Teste                                  | Computador | Celular | Safari | Tablet físico |
| -------------------------------------- | :--------: | :-----: | :----: | :-----------: |
| Entrar / sair                          |            |         |        |               |
| Início "Hoje"                          |            |         |        |       —       |
| OS: abas e estado                      |            |         |        |       —       |
| Foto vertical sem GPS                  |            |         |        |               |
| Tarefa: iniciar/pausar/concluir        |     —      |    —    |   —    |               |
| Programação semanal                    |            |         |        |       —       |
| Qualidade "Tudo conforme"              |     —      |    —    |   —    |               |
| Mapa da oficina                        |            |         |        |               |
| Entrega direta e desfazer              |            |    —    |   —    |       —       |
| Produtividade (perfil de planejamento) |            |         |        |       —       |

## 3. Critérios de aceite

- **GO:** nenhum ✘ nos itens 2.4.4 (conciliação), 2.10, 2.11, 2.12, 2.13.4 e 2.14 (dinheiro,
  permissões, auditoria), e no máximo ✘ cosméticos nos demais, registrados.
- **NO-GO:** qualquer valor contado duas vezes, reversão que mexa em lançamento independente, valor
  visível para quem não deveria ver, perda de foto ou de dado, ou ação executada sem decisão humana.
- Ao terminar: devolver os interruptores ao padrão (embalagem e travas ligadas) e registrar o
  resultado no relatório da homologação.
