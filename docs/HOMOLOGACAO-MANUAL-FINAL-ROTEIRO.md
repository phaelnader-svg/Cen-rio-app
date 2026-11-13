# Homologação manual final — versão `696e3e9`

Roteiro para testar o sistema de verdade, pelo navegador do computador, pelo Safari do celular e
pelo tablet físico da oficina, na homologação já implantada. **Nenhum deploy, migration ou mudança
de código faz parte deste roteiro.** Produção não é usada em nenhum passo.

Versão em teste: `696e3e9ddc5f1c803a4b9244a075ed498ad81be3`, implantada em 12/11/2026 às 22:48 UTC.
O registro do deploy está em `HOMOLOGACAO-CORRECOES-DEPLOY-RELATORIO.md`.

**Legenda**

| Símbolo | Significado                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------- |
| 👤      | Você executa sozinho, só com o navegador ou o tablet                                           |
| 🔧      | Exige preparação técnica: peça antes, que eu faço pelo runner da homologação, sem alterar nada |
| 🖥      | Computador (Chrome ou Edge, janela larga)                                                      |
| 📱      | Safari do iPhone                                                                               |
| 📟      | Tablet físico da oficina                                                                       |
| ☐       | Marque ✔ (passou), ✘ (falhou: preencha a ficha da seção 3) ou — (não se aplica)               |

---

## 0. Acesso

### 0.1 Endereço

**`https://teste.cenariogestao.com.br`**: é o único endereço da homologação. O endereço de produção
não deve ser aberto durante este roteiro.

| Tela                          | Endereço                                    |
| ----------------------------- | ------------------------------------------- |
| Painel (computador e celular) | `https://teste.cenariogestao.com.br/entrar` |
| Tablet                        | `https://teste.cenariogestao.com.br/tablet` |

### 0.2 Duas senhas diferentes, nesta ordem

1. **Senha do proxy da homologação.** O navegador mostra uma janela própria pedindo usuário e senha.
   - Usuário: `homologacao`, em minúsculas e sem acento.
   - Senha: a do proxy, que você já tem. Ela não está neste documento e não deve ser enviada por
     mensagem.
   - Depois de aceita, o navegador guarda um cookie e não pergunta de novo por algum tempo.
2. **Login do sistema** na tela "Entrar no painel": o e-mail e a senha de cada perfil (seção 1.3).

Se aparecer **página de "acesso restrito" ou em branco**, a senha do proxy foi recusada ou
cancelada. Recarregue a página e digite de novo `homologacao` e a senha do proxy. O e-mail do gestor
**não** serve nessa janela.

### 0.3 Safari do iPhone

- Use uma **aba normal**, não privada: a aba privada perde o cookie do proxy a cada vez.
- Se o Safari repetir o pedido de senha sem parar, apague os dados do site em Ajustes → Safari →
  Avançado → Dados dos Sites → `cenariogestao.com.br` e tente de novo.
- Opcional: Compartilhar → "Adicionar à Tela de Início" para testar como aplicativo.

### 0.4 Tablet físico

1. Abra `https://teste.cenariogestao.com.br/tablet` e passe pela senha do proxy.
2. A tela **"Vincular este tablet"** pede um código `XXXX-XXXX`.
3. No computador, como gestor, abra **Dispositivos e sessões** e use **"Cadastrar e gerar código"**.
   Dê ao tablet o nome `HML-Tablet Oficina`.
4. Digite o código no tablet. Ele é de uso único e expira; se expirar, gere outro.
5. Depois de vinculado, o tablet pede o **PIN de 6 dígitos** de cada funcionário (seção 1.3).

> Os 2 dispositivos que já existem na homologação **não devem ser revinculados nem revogados**.

---

## 1. Preparação

### 1.1 Regras de dados

- **Tudo o que você criar começa com `HML-`**: clientes, funções, funcionários, modelos, materiais,
  fornecedores, tablet e legendas de foto.
- **Registros que já existiam não devem ser alterados.** No último levantamento, antes da sua
  rodada, eram:
  - 2 clientes;
  - 3 OS;
  - 7 usuários;
  - 5 funções;
  - 2 dispositivos.

  Abrir e olhar é permitido. Editar, cancelar, pagar, entregar ou mover não é.

- **Valores pequenos e redondos**, como R$ 100,00 e R$ 250,00, para conferir de cabeça.
- **Telefones fictícios**, como (11) 90000-0001, e **e-mails fictícios** terminados em
  `@hml.teste.local`. O sistema não envia e-mail nem WhatsApp. Mesmo assim, nunca use um contato
  real.
- **Fotos** só de objetos e estofados de teste. Nunca use fotos de pessoas, documentos, placas de
  carro ou fachadas.
- Ao final, os registros `HML-` **ficam** como histórico. Não apague nada.
- **Interruptores da empresa** (Empresa → Funcionalidades): todos devem estar **ligados** no começo
  e voltar a ficar ligados no fim. São eles:
  - Logística;
  - Pedidos de ajuda;
  - Embalagem obrigatória;
  - Travas de materiais.

### 1.2 Antes de começar (🔧 — me avise)

Antes da sua rodada eu executo, só em leitura:

- saúde;
- smoke;
- versão ativa;
- impressão digital do banco;
- memória.

Assim a "foto" do estado inicial fica registrada. Nada é alterado.

### 1.3 Perfis a criar (👤, gestor, 🖥)

Em **Funções e permissões** → nova função, crie cada função abaixo com exatamente essas permissões.
Depois, em **Funcionários** → novo funcionário, crie uma pessoa para cada função:

- nome igual ao da função;
- e-mail `<nome>@hml.teste.local`, sem acento e em minúsculas;
- senha definida por você e guardada fora deste documento;
- PIN só nos perfis de tablet.

| Função                            | Permissões                                                                                                                                                                   | Usada em                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Gestor** (conta que já existe)  | todas                                                                                                                                                                        | quase tudo; **não edite** essa conta                                     |
| `HML-Comercial-A`                 | `painel.acessar`, `clientes.ver`, `clientes.gerenciar`, `pedidos.ver`, `pedidos.gerenciar`, `os.ver`                                                                         | B1 (sem "Novo serviço"), B6 (devoluções só consulta)                     |
| `HML-Comercial-B`                 | as de `HML-Comercial-A` + `retiradas.ver`, `retiradas.gerenciar`, `devolucoes.gerenciar`                                                                                     | B1 ("Novo serviço" funciona), B6 (registrar, confirmar e cancelar)       |
| `HML-Leitura`                     | `painel.acessar`, `os.ver`                                                                                                                                                   | B2 sem estoque, B5 sem permissão, bloqueios de valores, prontidão negada |
| `HML-Estoque`                     | `painel.acessar`, `estoque.ver`, `estoque.gerenciar`, `estoque.conferir`, `compras.ver`                                                                                      | B2 com a lista, conferência, movimentos de estoque                       |
| `HML-Planejamento`                | `painel.acessar`, `producao.ver`, `producao.planejar`, `os.ver`                                                                                                              | programação, produtividade **sem R$**                                    |
| `HML-Entregas`                    | `painel.acessar`, `os.ver`, `entregas.ver`, `entregas.gerenciar`                                                                                                             | entrega direta **sem** "Desfazer", ocorrências logísticas                |
| `HML-Financeiro`                  | `painel.acessar`, `financeiro.ver`, `financeiro.gerenciar`                                                                                                                   | financeiro sem entregas                                                  |
| `HML-Suporte`                     | `painel.acessar`, `dispositivos.ver`, `sessoes.ver`, `sincronizacao.diagnosticar`                                                                                            | B5 com permissão                                                         |
| `HML-Tapeceiro` (tablet, com PIN) | o **modelo "Tapeceiro"** da tela de funções, se aparecer. Se não, `producao.acessar`, `producao.executar`, `presenca.registrar`, `ajuda.solicitar`, `recebimentos.registrar` | tarefas, presença, ajuda, fotos e recebimentos no tablet                 |
| `HML-Qualidade` (tablet, com PIN) | `producao.acessar`, `qualidade.inspecionar`, `qualidade.gerenciar`                                                                                                           | "Tudo conforme" no tablet                                                |

Resultado esperado em cada cadastro: função e funcionário aparecem nas listas, e a Auditoria registra
quem criou.

### 1.4 Dados sintéticos a criar (👤, gestor)

Crie na ordem. Cada teste diz qual registro usa.

| Código | O quê                                                                                              | Como                                                               |
| ------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| D1     | Cliente `HML-Cliente Sofá Azul`, telefone (11) 90000-0001, endereço de teste                       | Clientes → novo; "Cadastrar depois" para o que não for obrigatório |
| D2     | Cliente `HML-Cliente Poltronas`                                                                    | idem                                                               |
| D3     | Modelo `HML-Reforma sofá 3 lugares`, com 2 materiais padrão: `HML-Espuma D33` e `HML-Tecido Linho` | Produção → Modelos de serviço                                      |
| D4     | Fornecedor `HML-Fornecedor Tecidos`                                                                | Compras → Fornecedores                                             |
| D5     | Item de estoque `HML-Grampo 106/8`, contável em **unidades**                                       | Estoque da oficina                                                 |
| D6     | Item de estoque `HML-Tecido Rolo`, em **metros**                                                   | Estoque                                                            |
| D7     | OS **A** de D1: 1 sofá, com o modelo D3, prazo daqui a 10 dias                                     | Novo serviço                                                       |
| D8     | OS **B** de D2: 2 poltronas, prazo daqui a 10 dias                                                 | Novo serviço                                                       |
| D9     | OS **C** de D1: 1 almofada, só para entrega direta e reversão                                      | Novo serviço                                                       |
| D10    | OS **D** de D2: 1 banqueta, só para os bloqueios da reversão                                       | Novo serviço                                                       |
| D11    | OS **E** de D1: 1 cadeira, só para a prontidão de retorno (seção 2.11)                             | Novo serviço                                                       |

---

## 2. Ordem dos testes

A ordem vai do mais crítico ao menos crítico. Um ✘ em um bloco **crítico** (seção 5.1) já basta
para bloquear a produção, então esses blocos vêm primeiro.

| Ordem | Bloco                                       | Quem    | Dispositivos | Tempo aproximado |
| ----- | ------------------------------------------- | ------- | ------------ | ---------------- |
| 1     | 2.1 Acesso, sessão e saída (B4)             | 👤      | 🖥📱📟       | 15 min           |
| 2     | 2.2 Permissões e correções B1–B6            | 👤      | 🖥📱         | 40 min           |
| 3     | 2.3 Produção completa (OS A e B)            | 👤      | 🖥📟         | 60 min           |
| 4     | 2.4 Compras, recebimento e estoque          | 👤      | 🖥📟         | 45 min           |
| 5     | 2.5 Qualidade e embalagem                   | 👤      | 🖥📟         | 30 min           |
| 6     | 2.6 Entregas: direta, reversão e bloqueios  | 👤      | 🖥           | 45 min           |
| 7     | 2.7 Ocorrências logísticas                  | 👤      | 🖥📱         | 25 min           |
| 8     | 2.8 Financeiro                              | 👤      | 🖥           | 45 min           |
| 9     | 2.9 Fotos e U1, com memória                 | 👤 + 🔧 | 🖥📱📟       | 30 min           |
| 10    | 2.10 Painel "Hoje", alertas e produtividade | 👤      | 🖥📱         | 25 min           |
| 11    | 2.11 Prontidão para retorno de versão       | 👤 + 🔧 | 🖥           | 20 min           |
| 12    | 2.12 Compatibilidade e tablet sem rede      | 👤      | 📱📟         | 20 min           |
| 13    | 2.13 Auditoria e encerramento               | 👤 + 🔧 | 🖥           | 15 min           |

Cada teste traz quatro informações:

- **Perfil**: com quem entrar.
- **Ação**: o que fazer, exatamente.
- **Esperado**: o que deve acontecer.
- **☐**: o resultado que você marca.

Anote a **hora** de qualquer ✘.

### 2.1 Acesso, sessão e saída (B4) 👤

| ID   | Perfil e dispositivo | Ação                                                                                 | Esperado                                                                                                        | ☐   |
| ---- | -------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --- |
| A-01 | sem login 🖥         | Abrir `https://teste.cenariogestao.com.br` e **cancelar** a janela de senha do proxy | Página explicativa de acesso restrito, nunca em branco                                                          | ☐   |
| A-02 | sem login 🖥         | Recarregar e digitar `homologacao` + senha do proxy                                  | Abre "Entrar no painel"                                                                                         | ☐   |
| A-03 | Gestor 🖥            | Entrar com e-mail e senha                                                            | Abre o Início com a seção "Hoje"                                                                                | ☐   |
| A-04 | Gestor 🖥            | **Sair** pelo menu do usuário                                                        | Volta a "Entrar no painel" **sem** a mensagem "Sua sessão foi encerrada" (correção **B4**)                      | ☐   |
| A-05 | Gestor 🖥            | Entrar de novo; em outra aba, Dispositivos e sessões → encerrar a **própria** sessão | A primeira aba vai para a entrada **com** "Sua sessão foi encerrada". Essa mensagem só deve aparecer neste caso | ☐   |
| A-06 | Gestor 📱            | Repetir A-02 a A-04 no Safari                                                        | Igual ao computador; nenhuma rolagem lateral                                                                    | ☐   |
| A-07 | `HML-Leitura` 🖥     | Entrar                                                                               | Menu reduzido; sem Financeiro, Estoque, Empresa ou Auditoria                                                    | ☐   |
| A-08 | 📟                   | Vincular o tablet (0.4) e entrar com o PIN do `HML-Tapeceiro`                        | Início do tablet com as tarefas do funcionário                                                                  | ☐   |
| A-09 | 📟                   | Digitar o PIN errado 3 vezes                                                         | Recusa com mensagem clara; não entra                                                                            | ☐   |

### 2.2 Permissões e correções B1–B6 👤 🖥

O sintoma comum dos defeitos antigos era **item de menu que abre uma tela com "acesso negado",
erro ou lista vazia sem explicação**. Em cada linha, confira também que **nenhuma mensagem de erro
vermelha** aparece.

| ID       | Perfil             | Ação                                                                                                | Esperado                                                                                                                                     | ☐   |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **B1**-1 | `HML-Comercial-A`  | Procurar "Novo serviço" no menu                                                                     | **Não aparece**                                                                                                                              | ☐   |
| B1-2     | `HML-Comercial-A`  | Digitar o endereço `…/painel/servicos/novo`                                                         | Acesso negado ou erro de permissão claro; nada é criado                                                                                      | ☐   |
| B1-3     | `HML-Comercial-B`  | Menu → **Novo serviço** → preencher cliente D2, 1 peça `HML-Peça B1` → salvar                       | A tela abre sem erro, a OS é criada e aparece em Ordens de serviço                                                                           | ☐   |
| **B2**-1 | `HML-Leitura`      | Menu → **Recebimento de materiais**                                                                 | O item **aparece** (decisão aprovada) e a tela abre **sem erro**. A lista "aguardando conferência" **não aparece**. Não há preços nem custos | ☐   |
| B2-2     | `HML-Leitura`      | Digitar `…/painel/estoque` e `…/painel/estoque-oficina`                                             | Acesso negado; nenhum saldo visível                                                                                                          | ☐   |
| B2-3     | `HML-Estoque`      | Recebimento de materiais                                                                            | A lista "aguardando conferência" **aparece**, sem erro                                                                                       | ☐   |
| B2-4     | `HML-Leitura` 📱   | Recebimento de materiais no Safari                                                                  | Mesmo resultado de B2-1                                                                                                                      | ☐   |
| **B3**-1 | Gestor             | Depois de U1-3 (seção 2.9), colar na barra o endereço antigo da foto removida e o da miniatura dela | Página de "não encontrado" (404), **nunca** "erro interno" (500); a galeria da OS continua funcionando                                       | ☐   |
| B3-2     | `HML-Leitura`      | Abrir o link direto de uma foto de OS (copie o endereço da foto como gestor)                        | Acesso negado (403), sem revelar se o arquivo existe                                                                                         | ☐   |
| **B5**-1 | `HML-Leitura`      | Digitar `…/painel/dispositivos`                                                                     | Aviso **"Acesso negado — você não tem permissão…"**, nunca página vazia                                                                      | ☐   |
| B5-2     | `HML-Leitura`      | Digitar `…/painel/sincronizacao`                                                                    | Mesmo aviso de B5-1                                                                                                                          | ☐   |
| B5-3     | `HML-Suporte`      | Menu → Dispositivos e sessões; menu → Sincronização                                                 | As duas telas mostram conteúdo, sem aviso de acesso negado                                                                                   | ☐   |
| **B6**-1 | `HML-Comercial-A`  | Menu → **Devoluções**                                                                               | Item aparece e lista abre. **Sem** os botões "Registrar devolução", "Confirmar" e "Cancelar"                                                 | ☐   |
| B6-2     | `HML-Comercial-B`  | Devoluções → **Registrar devolução** de uma peça `HML-` entregue (da seção 2.6) → confirmar         | Registra; botões visíveis; auditoria registra                                                                                                | ☐   |
| B6-3     | `HML-Leitura`      | Procurar "Devoluções"                                                                               | Não aparece                                                                                                                                  | ☐   |
| P-01     | `HML-Planejamento` | Percorrer **todos** os itens do menu                                                                | Nenhuma tela com erro; **nenhum valor em R$** em nenhuma tela                                                                                | ☐   |
| P-02     | `HML-Entregas`     | Digitar `…/painel/financeiro`                                                                       | Acesso negado                                                                                                                                | ☐   |
| P-03     | `HML-Financeiro`   | Percorrer o menu                                                                                    | Vê o Financeiro; não vê Expedição e entregas                                                                                                 | ☐   |
| P-04     | cada perfil `HML-` | Clicar em **cada** item do próprio menu                                                             | Nenhum item leva a "acesso negado" ou erro: o item só aparece se o perfil pode usá-lo                                                        | ☐   |

A U1 (confirmação ao remover foto) está na seção 2.9.

### 2.3 Produção completa 👤 🖥📟

| ID    | Perfil             | Ação                                                                                                                                                   | Esperado                                                                                                               | ☐   |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --- |
| PR-01 | Gestor 🖥          | Abrir a OS A (D7)                                                                                                                                      | 6 abas: Resumo, Peças, Materiais, Produção, Qualidade, Histórico. Selo de estado no cabeçalho, igual ao da lista de OS | ☐   |
| PR-02 | Gestor             | Aba Materiais                                                                                                                                          | Os materiais do modelo D3 aparecem como **sugestão**. Aceitar a espuma, recusar o tecido. Nada é lançado sozinho       | ☐   |
| PR-03 | Gestor             | Medições → registrar a medição da OS A (valores fictícios)                                                                                             | Registrada; aparece no histórico da OS                                                                                 | ☐   |
| PR-04 | Gestor             | Recebimento de peças da OS B: registrar a chegada das 2 poltronas, com foto                                                                            | As peças passam a "na oficina" e aparecem no **Mapa da oficina**                                                       | ☐   |
| PR-05 | Gestor             | Mapa da oficina → mover uma poltrona para outro local                                                                                                  | Local muda; o histórico mostra quem moveu e quando                                                                     | ☐   |
| PR-06 | `HML-Planejamento` | Programação semanal → aba **Serviços**: atribuir a OS A ao `HML-Tapeceiro` com início hoje → **Semana detalhada** → **Publicar** (prévia + observação) | Publicação concluída com a prévia certa                                                                                | ☐   |
| PR-07 | `HML-Tapeceiro` 📟 | Atualizar o tablet                                                                                                                                     | A tarefa da OS A aparece                                                                                               | ☐   |
| PR-08 | 📟                 | **Iniciar** a tarefa                                                                                                                                   | Estado "em execução"; aparece em "Em execução" no Início do gestor (atualiza sozinho)                                  | ☐   |
| PR-09 | 📟                 | **Pausar** com impedimento "faltou material"                                                                                                           | Pausada com motivo; o gestor vê o impedimento                                                                          | ☐   |
| PR-10 | 📟                 | **Retomar** e **Concluir** com observação                                                                                                              | Concluída; abre a inspeção de qualidade da peça                                                                        | ☐   |
| PR-11 | 📟                 | **Pedido de ajuda** → "ajudante"                                                                                                                       | Aparece em Produção → Pedidos de ajuda no painel; o gestor atende e encerra                                            | ☐   |
| PR-12 | 📟                 | **Presença**: registrar chegada                                                                                                                        | O funcionário aparece em "Na oficina" no Início                                                                        | ☐   |
| PR-13 | Gestor             | Quadro de produção                                                                                                                                     | A peça da OS A aparece com o estado correto                                                                            | ☐   |
| PR-14 | Gestor             | Empresa → Funcionalidades → **desligar** "Travas de materiais", deixar material faltante na OS B e programar/iniciar a tarefa → **religar**            | Desligado: inicia, só com aviso. Ligado: bloqueia com a explicação. **Termine com ele ligado**                         | ☐   |

### 2.4 Compras, recebimento e estoque 👤 🖥📟

A regra atual do recebimento foi mantida por decisão. Os testes **verificam** essa regra:

- **Material técnico** (medido em metros ou m², ou comprado exclusivamente para uma OS): a chegada
  fica pendente e o estoque só entra na conferência.
- **Material contável comprado para estoque**: a chegada já lança a entrada no estoque, e qualquer
  funcionário pode registrá-la.

A proposta de mudança está em `PROPOSTA-RECEBIMENTO-CONFERENCIA-OBRIGATORIA.md`.

| ID     | Perfil             | Ação                                                                                                                                        | Esperado                                                                                                                                                     | ☐   |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| ES-01  | `HML-Estoque`      | Estoque da oficina → entrada manual de 10 un. de D5 (`HML-Grampo`) com motivo                                                               | Saldo 10; movimento com autor e motivo                                                                                                                       | ☐   |
| ES-02  | `HML-Estoque`      | Saída de 2 un. de D5 para a OS A                                                                                                            | Saldo 8; a OS A mostra o consumo                                                                                                                             | ☐   |
| ES-03  | Gestor             | Compras → pedido de compra para D4 com 2 itens: 20 un. de D5 (para estoque) e 5 m de D6 (`HML-Tecido Rolo`, R$ 100,00) → confirmar o pedido | Pedido "confirmado", aguardando recebimento                                                                                                                  | ☐   |
| ES-04  | `HML-Leitura`      | Recebimento de materiais → registrar a chegada **só dos 20 grampos**                                                                        | Aceita. O saldo de D5 passa de 8 para **28** (regra atual: entrada imediata). A tela não mostra preço                                                        | ☐   |
| ES-05  | `HML-Leitura`      | Na mesma tela, tentar receber o tecido (5 m)                                                                                                | O item aparece **travado**, com o aviso de que exige conferência técnica e que só a chegada física deve ser registrada. Nada entra no estoque                | ☐   |
| ES-05b | `HML-Tapeceiro` 📟 | Tablet → Recebimentos → pedido do tecido → informar **1 rolo** → confirmar                                                                  | Chegada física registrada (código `CH-…`). O saldo de D6 **não muda**                                                                                        | ☐   |
| ES-06  | `HML-Estoque`      | Painel → Recebimento de materiais → lista "aguardando conferência" → **Conferir** a chegada com a medida real de 5 m                        | Agora entra no estoque (D6 = 5 m) e o pedido fica "recebido". `HML-Leitura` não vê essa lista, e o botão "Conferir" fica desabilitado sem `estoque.conferir` | ☐   |
| ES-07  | `HML-Leitura`      | Tentar receber de novo o mesmo pedido, ou mais do que o pedido                                                                              | Recusado com "acima do pedido" ou "não está aguardando recebimento". O saldo não muda                                                                        | ☐   |
| ES-08  | `HML-Tapeceiro` 📟 | Recebimentos no tablet: confirmar a chegada rápida de um terceiro pedido `HML-`                                                             | Confirma. Dois tablets ou duas abas confirmando a mesma chegada: o segundo é recusado ("já foi atualizado")                                                  | ☐   |
| ES-09  | Gestor             | Compra formal do tecido já lançado como "comprado" na OS A → abrir a OS A                                                                   | **Pendência de conciliação**. Ao vincular ("é o mesmo"), o custo conta **uma vez só**                                                                        | ☐   |
| ES-10  | Gestor             | Prontidão de materiais (menu Compras)                                                                                                       | A OS A aparece com a situação de materiais coerente                                                                                                          | ☐   |

### 2.5 Qualidade e embalagem 👤 🖥📟

| ID    | Perfil             | Ação                                                                                     | Esperado                                                                                                                      | ☐   |
| ----- | ------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --- |
| QA-01 | `HML-Qualidade` 📟 | Inspeção da peça da OS A → **"Tudo conforme — aprovar"**                                 | Aprovada; com Embalagem ligada, vai para "aguardando embalagem"                                                               | ☐   |
| QA-02 | Gestor             | Embalagem da peça → concluir                                                             | Vai para "pronta para entrega"                                                                                                | ☐   |
| QA-03 | `HML-Qualidade` 📟 | Na poltrona 1 da OS B, marcar um item **não conforme** e tentar "Tudo conforme"          | Recusado. Reprovar gera uma **correção**                                                                                      | ☐   |
| QA-04 | Gestor             | O gestor executa a correção e tenta **aprovar a própria peça**                           | Exige justificativa de 10 ou mais caracteres. Com justificativa, aprova, e a Auditoria destaca a exceção                      | ☐   |
| QA-05 | Gestor             | Reprovar a própria peça (poltrona 2) **sem** justificativa                               | Permitido e auditado                                                                                                          | ☐   |
| QA-06 | Gestor             | Desligar "Embalagem obrigatória" → aprovar a poltrona 2 depois da correção → **religar** | Desligada: a peça vai direto para "pronta para entrega". A peça continua pronta depois de religar. **Termine com ela ligada** | ☐   |

### 2.6 Entregas: direta, reversão e bloqueios 👤 🖥

**Preparo na OS C (D9)**, com a peça aprovada e pronta:

- mão de obra "na entrega" de R$ 100,00;
- mão de obra "na aprovação" de R$ 100,00;
- cobrança ao cliente "na entrega" de R$ 250,00.

| ID    | Perfil         | Ação                                                                                           | Esperado                                                                                                                                                                                                                                                                                                                                  | ☐   |
| ----- | -------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| EN-01 | `HML-Entregas` | OS C → Qualidade → **Marcar como entregue** (com observação)                                   | Entrega registrada como "confirmação direta pela OS". A mão de obra "na entrega" passa a liberada e a cobrança passa a vencer. **Não** aparece "Desfazer"                                                                                                                                                                                 | ☐   |
| EN-02 | Gestor         | OS C → **Desfazer**, primeiro com justificativa curta e depois com 10 ou mais caracteres       | A prévia lista peças, mão de obra e cobrança afetadas. A justificativa curta é recusada. Ao desfazer: peça volta a "pronta para entrega", mão de obra da entrega volta a prevista, a da **aprovação não muda**, a cobrança volta a "aguardando entrega" e a entrega original fica "desfeita" no histórico. A auditoria destaca a reversão | ☐   |
| EN-03 | Gestor         | Entregar de novo e clicar **Desfazer** duas vezes rápido                                       | Uma única reversão                                                                                                                                                                                                                                                                                                                        | ☐   |
| EN-04 | Gestor         | OS D (D10): entregar e **pagar parcialmente** (R$ 50,00) a mão de obra da entrega → Desfazer   | **Recusado**, com o motivo                                                                                                                                                                                                                                                                                                                | ☐   |
| EN-05 | Gestor         | OS D: estornar o pagamento; receber parte da cobrança **depois** da entrega → Desfazer         | **Recusado** (cobrança recebida depois da entrega)                                                                                                                                                                                                                                                                                        | ☐   |
| EN-06 | Gestor         | Em outra OS `HML-`: entregar, **conferir** a semana do fechamento → Desfazer                   | **Recusado** (semana conferida). Reabra a semana com motivo ao final                                                                                                                                                                                                                                                                      | ☐   |
| EN-07 | Gestor         | Expedição e entregas → **Agenda**: agendar a entrega da OS A (data, endereço de teste, equipe) | Aparece na agenda pela data e região                                                                                                                                                                                                                                                                                                      | ☐   |
| EN-08 | Gestor         | Confirmar a entrega agendada                                                                   | Peça "entregue". Mão de obra e cobrança "na entrega" seguem a regra (conferir na seção 2.8)                                                                                                                                                                                                                                               | ☐   |

O bloqueio por "mais de 7 dias" não é testável em tempo real; ele é coberto por teste automático.

### 2.7 Página de ocorrências logísticas 👤 🖥📱

A Logística deve estar **ligada**. A página fica em Expedição e entregas → aba **"Ocorrências
logísticas"** (`…/painel/entregas?tab=occurrences`).

| ID    | Perfil         | Ação                                                                                                                    | Esperado                                                                                                     | ☐   |
| ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --- |
| OC-01 | `HML-Entregas` | Aba **Expedição** → peça da OS B → **Ocorrência** → tipo "Peça danificada", descrição `HML- risco no braço` → Registrar | "Ocorrência registrada." A aba mostra um contador e o selo **"Bloqueia expedição"**                          | ☐   |
| OC-02 | `HML-Entregas` | Aba **Prontas para entrega** e a OS B → Marcar como entregue                                                            | A peça bloqueada **não** está pronta: falta "Sem bloqueio crítico de expedição"; a entrega direta é recusada | ☐   |
| OC-03 | `HML-Entregas` | Registrar uma segunda ocorrência "Cliente indisponível" na entrega agendada da OS A                                     | Registrada **sem** o selo de bloqueio                                                                        | ☐   |
| OC-04 | `HML-Entregas` | Filtro "Situação": Todas / Aberta / Em tratamento / Resolvida / Cancelada                                               | A lista filtra corretamente                                                                                  | ☐   |
| OC-05 | `HML-Entregas` | **Abrir** OC-01 → **Definir responsável**                                                                               | Responsável aparece no cabeçalho; o histórico registra o evento                                              | ☐   |
| OC-06 | `HML-Entregas` | Na ocorrência, adicionar uma foto `HML-`                                                                                | Foto aparece, em pé, com miniatura                                                                           | ☐   |
| OC-07 | `HML-Entregas` | **Resolver**, primeiro com solução vazia e depois com `HML- peça reparada`                                              | Vazio é recusado. Resolvida: o selo de bloqueio some e a peça volta a poder ser expedida                     | ☐   |
| OC-08 | `HML-Entregas` | Abrir OC-03 → **Cancelar** com motivo                                                                                   | Cancelada; continua no histórico                                                                             | ☐   |
| OC-09 | `HML-Leitura`  | Digitar `…/painel/entregas?tab=occurrences` e o endereço direto de uma ocorrência                                       | Acesso negado; nenhuma ocorrência visível                                                                    | ☐   |
| OC-10 | Gestor 📱      | Abrir a aba e uma ocorrência no Safari                                                                                  | Legível, sem rolagem lateral, botões utilizáveis                                                             | ☐   |
| OC-11 | Gestor         | Detalhe da entrega da OS A                                                                                              | Seção "Ocorrências" lista OC-03 com link                                                                     | ☐   |

### 2.8 Financeiro 👤 🖥

Os valores esperados saem das seções 2.4 a 2.6. Confira de cabeça.

| ID    | Perfil                                            | Ação                                                                                              | Esperado                                                                                               | ☐   |
| ----- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --- |
| FI-01 | Gestor                                            | Financeiro → Resultado por OS → OS A                                                              | Receita, custo de material (o tecido conciliado **uma vez**), mão de obra e margem coerentes           | ☐   |
| FI-02 | Gestor                                            | Resultado da OS C (entregue → desfeita → entregue de novo)                                        | Um único efeito líquido da entrega; nada contado duas vezes                                            | ☐   |
| FI-03 | Gestor                                            | Pagar parcialmente uma mão de obra `HML-` (R$ 50,00) e depois **estornar**                        | "Pago parcial" e depois "estornado". O estorno é um novo lançamento: o original **não** é apagado      | ☐   |
| FI-04 | Gestor                                            | Receber R$ 100,00 de uma cobrança `HML-` e estornar                                               | Mesma regra de FI-03                                                                                   | ☐   |
| FI-05 | Gestor                                            | Fechamento semanal do `HML-Tapeceiro` → **conferir** → **reabrir** sem motivo e depois com motivo | Sem motivo é recusado; com motivo reabre, com auditoria                                                | ☐   |
| FI-06 | Gestor                                            | Produtividade no Financeiro × produtividade na Programação                                        | Os números de produção são iguais                                                                      | ☐   |
| FI-07 | `HML-Financeiro`                                  | Mesmas consultas de FI-01                                                                         | Os mesmos valores do gestor                                                                            | ☐   |
| FI-08 | `HML-Planejamento`, `HML-Entregas`, `HML-Leitura` | Procurar **qualquer** valor em R$ nas telas que abrem: OS, programação, tablet, entregas          | Nenhum valor aparece                                                                                   | ☐   |
| FI-09 | `HML-Tapeceiro` 📟                                | "Meus ganhos" com o PIN                                                                           | Só os próprios valores; nunca de outro funcionário ou da empresa                                       | ☐   |
| FI-10 | Gestor                                            | Painel financeiro geral                                                                           | Os registros que já existiam **não mudaram**: compare os totais com uma captura feita antes de começar | ☐   |

### 2.9 Fotos, U1 e consumo de memória 👤 + 🔧

**Preparação técnica (🔧):** me avise o horário em que vai começar. Eu registro a memória da VM e de
cada contêiner antes, durante (várias medições seguidas) e depois. Também confiro se a API
reiniciou.

| ID       | Perfil e dispositivo | Ação                                                                        | Esperado                                                                                               | ☐   |
| -------- | -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --- |
| FO-01    | Gestor 📱            | OS A → Peças/Fotos → **Adicionar fotos** → câmera, foto **na vertical**     | Aparece **em pé**, com miniatura; abre no visualizador (ampliar, anterior e próxima, deslizar)         | ☐   |
| FO-02    | Gestor 🖥            | Baixar essa foto ("Abrir em nova aba" → salvar) e ver as propriedades       | **Sem localização (GPS)** e sem dados da câmera                                                        | ☐   |
| FO-03    | Gestor 📱            | Selecionar **10 fotos de uma vez** da galeria (as maiores que tiver)        | Todas sobem. O celular não trava e a aba do Safari não recarrega sozinha                               | ☐   |
| FO-04    | `HML-Tapeceiro` 📟   | Foto na tarefa pela câmera do tablet                                        | Aparece na OS, em pé                                                                                   | ☐   |
| FO-05    | Gestor 🖥📱📟        | **Ao mesmo tempo**: 5 fotos pelo celular, 5 pelo tablet e 5 pelo computador | Todas sobem, nenhuma falha ou duplica                                                                  | ☐   |
| FO-06    | Gestor               | Anexar um PDF pequeno `HML-`                                                | Abre e baixa                                                                                           | ☐   |
| **U1**-1 | Gestor 🖥            | Na galeria, clicar na **lixeira** de uma foto                               | Abre "Remover foto?" com a prévia da foto. Nada é removido ainda                                       | ☐   |
| U1-2     | Gestor               | Clicar **"Manter foto"**                                                    | O diálogo fecha e a foto continua                                                                      | ☐   |
| U1-3     | Gestor               | Lixeira → **"Remover foto"**                                                | A foto sai da galeria; o link antigo dela passa a dar "não encontrado"; o histórico registra a remoção | ☐   |
| U1-4     | Gestor 📱            | U1-1 a U1-3 no Safari                                                       | Igual ao computador                                                                                    | ☐   |
| U1-5     | `HML-Leitura`        | Abrir a galeria de uma OS                                                   | Sem lixeira e sem "Adicionar fotos"                                                                    | ☐   |

**Critérios de memória (🔧, eu verifico e informo):**

| Critério                                            | Aceitável                              | Bloqueia         |
| --------------------------------------------------- | -------------------------------------- | ---------------- |
| Pico de memória da API durante FO-03 e FO-05        | < 400 MiB (limite: 512 MiB)            | atingir o limite |
| API reiniciou ou foi encerrada por falta de memória | não                                    | sim              |
| Memória disponível na VM durante os envios          | > 300 MB                               | < 150 MB         |
| Uso do swap                                         | < 600 MB                               | > 1,5 GB         |
| Memória da API 5 min depois dos envios              | volta perto do nível inicial (±50 MiB) | cresce sem parar |
| Respostas 5xx no período                            | 0                                      | qualquer uma     |

### 2.10 Painel "Hoje", alertas e produtividade 👤 🖥📱

Os alertas são recalculados **a cada 5 minutos**. Espere até 5 min antes de marcar ✘.

| ID    | Perfil             | Ação                                                  | Esperado                                                                                                            | ☐   |
| ----- | ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --- |
| HO-01 | Gestor             | Início → "Hoje", com uma tarefa em execução no tablet | Aparece em "Em execução"; o funcionário com presença aparece em "Na oficina"; as peças prontas aparecem com os dias | ☐   |
| HO-02 | Gestor             | **Ações sugeridas hoje** → clicar em uma              | Só abre a tela indicada; nada muda sozinho                                                                          | ☐   |
| HO-03 | Gestor             | Mudar o prazo da OS B para **ontem**                  | Em até 5 min, o sininho mostra "Prazo em risco"                                                                     | ☐   |
| HO-04 | Gestor             | Mudar o prazo da OS B para daqui a 30 dias            | Em até 5 min o aviso **some sozinho**                                                                               | ☐   |
| HO-05 | Gestor             | Material faltante numa OS `HML-` com tarefa amanhã    | Alerta "Material faltante"; ao marcar o material como disponível, some                                              | ☐   |
| HO-06 | Gestor             | Verificar o envio externo de mensagens                | Nenhum e-mail ou WhatsApp foi enviado                                                                               | ☐   |
| HO-07 | `HML-Planejamento` | Programação semanal → aba **Produtividade**           | Abre **sem nenhum R$**                                                                                              | ☐   |
| HO-08 | Gestor 📱          | "Hoje" no Safari                                      | Legível, sem rolagem lateral                                                                                        | ☐   |

### 2.11 Prontidão para retorno de versão 👤 + 🔧 🖥

**Não existe uma tela no menu.** É uma página de consulta (somente leitura) que você abre no mesmo
navegador em que está logado como gestor:

**`https://teste.cenariogestao.com.br/api/v1/system/rollback-readiness`**

Ela responde em texto estruturado (JSON) e diz se o retorno para a versão de retorno **R2
`341badb`**, que não conhece a embalagem opcional, está liberado:

- **`"ready"`**: `true` quando o retorno está liberado e `false` quando está bloqueado.
- **`"incompatiblePieces"`**: as peças que bloqueiam o retorno, com código, cliente e etapa.
- **`"openPhase4Alerts"`**: quantos avisos internos o retorno vai encerrar.
- **`"instructions"`**: o que fazer.

O retorno para a F′ `63674f1`, o retorno preferencial, **não** depende desta página: a F′ já tem
embalagem opcional.

> Não confundir com **"Prontidão de materiais"** (menu Compras), que é outra coisa.

| ID    | Perfil        | Ação                                                                                                                                        | Esperado                                                                                                                                                               | ☐   |
| ----- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| RB-01 | Gestor        | Abrir o endereço acima antes de RB-02                                                                                                       | `"ready": true` e `"incompatiblePieces": []`. Se a seção 2.5 deixou alguma peça aprovada sem embalagem e não entregue, `false` com essa peça listada, o que é coerente | ☐   |
| RB-02 | Gestor        | Levar a peça da OS E (D11) até a qualidade, como em PR-06 a PR-10 → desligar "Embalagem obrigatória" → aprovar a peça → recarregar a página | `"ready": false`, listando a peça da OS E, com instrução de entregar antes                                                                                             | ☐   |
| RB-03 | Gestor        | Religar a Embalagem → **entregar** a peça da OS E → recarregar                                                                              | `"ready": true` de novo                                                                                                                                                | ☐   |
| RB-04 | `HML-Leitura` | Abrir o mesmo endereço                                                                                                                      | Recusado (403, sem permissão)                                                                                                                                          | ☐   |
| RB-05 | sem login     | Abrir em aba anônima, depois da senha do proxy                                                                                              | Recusado (401, não autenticado)                                                                                                                                        | ☐   |
| RB-06 | 🔧            | Eu confiro na VM que as imagens de retorno (F′ e R2) e o ponto de recuperação continuam protegidos                                          | Confirmado no seu relatório final                                                                                                                                      | ☐   |

**Nenhum retorno de versão é executado neste roteiro.** A página só informa.

### 2.12 Compatibilidade e tablet sem rede 👤

| ID    | Dispositivo | Ação                                                                         | Esperado                                                                      | ☐   |
| ----- | ----------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --- |
| CO-01 | 📟          | Durante uma tarefa, desligar o Wi-Fi por 1 min → iniciar ou pausar → religar | A ação sincroniza ao voltar, **sem duplicar**                                 | ☐   |
| CO-02 | 📟          | Girar o tablet (retrato e paisagem)                                          | Layout se ajusta; botões grandes                                              | ☐   |
| CO-03 | 📱          | Menu abre e fecha; abas da OS roláveis                                       | Sem rolagem lateral da página                                                 | ☐   |
| CO-04 | 📱          | Programação semanal no celular                                               | Usável. A tabela da semana rola dentro do cartão (comportamento já conhecido) | ☐   |
| CO-05 | 🖥          | Recarregar com Ctrl+Shift+R em 3 telas                                       | Nenhuma tela quebra                                                           | ☐   |

Matriz de compatibilidade, para marcar no fim:

| Teste                              | 🖥  | 📱 Safari | 📟 Tablet |
| ---------------------------------- | :-: | :-------: | :-------: |
| Entrar e sair (B4)                 |  ☐  |     ☐     |     ☐     |
| Início "Hoje"                      |  ☐  |     ☐     |     —     |
| OS: abas e estado                  |  ☐  |     ☐     |     —     |
| Foto em pé, sem GPS                |  ☐  |     ☐     |     ☐     |
| Remover foto com confirmação (U1)  |  ☐  |     ☐     |     —     |
| Tarefa: iniciar, pausar e concluir |  —  |     —     |     ☐     |
| Qualidade "Tudo conforme"          |  —  |     —     |     ☐     |
| Recebimentos                       |  ☐  |     ☐     |     ☐     |
| Mapa da oficina                    |  ☐  |     ☐     |     ☐     |
| Ocorrências logísticas             |  ☐  |     ☐     |     —     |
| Entrega direta e desfazer          |  ☐  |     —     |     —     |

### 2.13 Auditoria e encerramento 👤 + 🔧

| ID    | Perfil | Ação                                                                                                                                                                               | Esperado                                                     | ☐   |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --- |
| AU-01 | Gestor | Auditoria → filtro "Exceções destacadas"                                                                                                                                           | Mostra a autoaprovação (QA-04) e as reversões (EN-02, EN-03) | ☐   |
| AU-02 | Gestor | Auditoria → buscar 5 ações quaisquer deste roteiro                                                                                                                                 | Cada uma mostra quem, quando e o quê                         | ☐   |
| AU-03 | Gestor | Empresa → Funcionalidades                                                                                                                                                          | **Os 4 interruptores ligados**                               | ☐   |
| AU-04 | Gestor | Abrir os 2 clientes e as 3 OS que já existiam                                                                                                                                      | Nada mudou: compare com a captura inicial                    | ☐   |
| AU-05 | 🔧     | Eu repito saúde, smoke, logs (5xx e erros no período), memória e impressão digital. Comparo com o início: as mudanças devem estar só em registros `HML-`, notificações e auditoria | Relatório final da rodada                                    | ☐   |

---

## 3. Evidências e falhas

### 3.1 Evidências

- **Pasta:** crie `Homologacao-final-696e3e9/`, com subpastas `computador/`, `safari/` e
  `tablet/`.
- **Nome de cada arquivo:** `AAAAMMDD-HHMM_<ID>_<dispositivo>.png`, por exemplo
  `20261113-1032_OC-01_computador.png`.
- **Capturas obrigatórias, mesmo quando passa:**
  - B1–B6 e U1, uma por ID;
  - EN-02 (prévia e resultado);
  - FI-01 e FI-02;
  - RB-01 a RB-03;
  - OC-01 e OC-07.
- **Quando falhar:** captura da tela inteira, com a barra de endereço visível, e, se possível, um
  vídeo curto da tela do celular ou do tablet.
- **Capturas iniciais (antes do primeiro teste)** de:
  - painel financeiro geral;
  - lista de clientes;
  - lista de OS;
  - Empresa → Funcionalidades.

  Elas servem para comparar no fim (FI-10, AU-03, AU-04).

- **Sem senhas e PINs:** nenhuma captura deve mostrar senha ou PIN digitado. Se a janela do proxy
  aparecer, capture só depois de fechá-la.

### 3.2 Ficha de falha (copie uma por ✘)

```text
ID do teste:            (ex.: OC-07)
Data e hora exata:      (ex.: 13/11 10:32, horário de Brasília)
Perfil:                 (ex.: HML-Entregas)
Dispositivo/navegador:  (computador Chrome | iPhone Safari | tablet)
Endereço da tela:       (copie da barra de endereço, sem dados pessoais)
O que fiz:              (passos exatos)
O que esperava:         (copie o "Esperado" do roteiro)
O que aconteceu:        (mensagem exata, se houver)
Registro afetado:       (código HML-… da OS, peça, ocorrência)
Repetiu?                (sim/não; quantas vezes)
Gravidade:              S1 | S2 | S3 | S4 (abaixo)
Evidência:              (nome do arquivo)
```

| Gravidade           | Definição                                                                        | Exemplos                                                                                         |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **S1 — bloqueante** | Perde, duplica ou corrompe dado; dinheiro errado; acesso indevido; o sistema cai | valor contado duas vezes; perfil sem financeiro vê R$; foto some sem confirmação; a API reinicia |
| **S2 — grave**      | Fluxo principal não conclui e não há alternativa                                 | não consegue publicar a programação; o tablet não inicia a tarefa                                |
| **S3 — menor**      | Funciona com contorno ou mensagem ruim                                           | texto confuso; precisa recarregar                                                                |
| **S4 — cosmético**  | Aparência                                                                        | alinhamento, quebra de linha                                                                     |

Envie as fichas para mim com a hora. Eu consulto os logs da homologação daquela janela, em leitura,
e devolvo a causa. **Não corrija nada direto no banco nem repita a ação** que causou um S1 antes da
análise.

---

## 4. Lista de aprovação por funcionalidade

Marque **APROVADO** só se todos os testes da linha passaram, ou falharam apenas com S4 registrado.

| #   | Funcionalidade                               | Testes                      | Crítica? | Resultado              |
| --- | -------------------------------------------- | --------------------------- | :------: | ---------------------- |
| 1   | Acesso, sessão e saída                       | A-01 a A-09                 |    ✔    | ☐ APROVADO ☐ REPROVADO |
| 2   | Permissões por perfil e menu                 | B1, B2, B5, B6, P-01 a P-04 |    ✔    | ☐ ☐                    |
| 3   | Arquivo inexistente e foto alheia (B3)       | B3-1, B3-2                  |    ✔    | ☐ ☐                    |
| 4   | OS, medições e recebimento de peças          | PR-01 a PR-05               |    ✔    | ☐ ☐                    |
| 5   | Programação e tablet de produção             | PR-06 a PR-14, CO-01        |    ✔    | ☐ ☐                    |
| 6   | Compras, recebimento e estoque               | ES-01 a ES-10 (com ES-05b)  |    ✔    | ☐ ☐                    |
| 7   | Qualidade e embalagem                        | QA-01 a QA-06               |    ✔    | ☐ ☐                    |
| 8   | Entrega direta, reversão e bloqueios         | EN-01 a EN-06               |    ✔    | ☐ ☐                    |
| 9   | Entregas agendadas                           | EN-07, EN-08                |          | ☐ ☐                    |
| 10  | Ocorrências logísticas                       | OC-01 a OC-11               |    ✔    | ☐ ☐                    |
| 11  | Financeiro e sigilo de valores               | FI-01 a FI-10               |    ✔    | ☐ ☐                    |
| 12  | Fotos e remoção com confirmação (U1)         | FO-01 a FO-06, U1-1 a U1-5  |    ✔    | ☐ ☐                    |
| 13  | Memória durante uploads                      | critérios da seção 2.9      |    ✔    | ☐ ☐                    |
| 14  | Painel "Hoje", alertas e produtividade       | HO-01 a HO-08               |          | ☐ ☐                    |
| 15  | Prontidão para retorno                       | RB-01 a RB-06               |    ✔    | ☐ ☐                    |
| 16  | Compatibilidade (Safari e tablet)            | CO-02 a CO-05 e a matriz    |          | ☐ ☐                    |
| 17  | Auditoria e preservação dos dados existentes | AU-01 a AU-05               |    ✔    | ☐ ☐                    |

---

## 5. Critérios de bloqueio da produção

### 5.1 Produção **BLOQUEADA** se acontecer qualquer um destes

1. Qualquer falha **S1**, em qualquer teste.
2. Qualquer falha **S2** em uma funcionalidade marcada como crítica na seção 4.
3. **Dinheiro:**
   - valor contado duas vezes (material, mão de obra ou cobrança);
   - reversão que mexe em lançamento independente (a mão de obra "na aprovação");
   - estorno que apaga o original;
   - Desfazer aceito em um caso de bloqueio (EN-04 a EN-06).
4. **Sigilo:**
   - qualquer valor em R$ visível para `HML-Planejamento`, `HML-Entregas`, `HML-Leitura` ou um
     tablet de outro funcionário;
   - dados de estoque visíveis para `HML-Leitura`;
   - página de prontidão aberta sem permissão.
5. **Dados:**
   - foto ou anexo perdido sem confirmação;
   - registro preexistente alterado;
   - ação duplicada pelo tablet depois de voltar a rede.
6. **Estabilidade:**
   - API reiniciada, encerrada por falta de memória ou com qualquer 5xx durante a rodada;
   - memória fora dos critérios da seção 2.9.
7. **Correções:** reaparecimento de qualquer defeito B1–B6 ou U1.
8. **Retorno:** a página de prontidão sem bloquear quando deveria (RB-02), ou as imagens de retorno
   e o ponto de recuperação indisponíveis (RB-06).
9. **Ação automática:** qualquer ação executada sem decisão humana (agendamento, entrega, pagamento
   ou envio externo).

### 5.2 Produção **LIBERÁVEL para decisão** se

- todas as funcionalidades críticas forem APROVADAS;
- as falhas restantes forem só S3 ou S4, registradas, com plano de correção;
- os 4 interruptores estiverem ligados e os dados existentes preservados (AU-03, AU-04);
- o relatório técnico final (AU-05) não tiver 5xx, reinício ou divergência fora de registros `HML-`.

Mesmo liberável, **o deploy em produção continua dependendo da sua autorização expressa**, com plano
próprio de backup e de retorno. Este roteiro não autoriza nada em produção.

---

## 6. Resumo: sozinho × preparação técnica

| Você executa sozinho 👤                                                      | Exige preparação técnica 🔧                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Criar perfis e dados `HML-` (1.3, 1.4)                                       | Registro do estado inicial e final: saúde, smoke, impressão digital, memória (1.2, AU-05)                                                                                                                                                                                               |
| Acesso e saída, permissões, B1, B2, B5, B6 (2.1, 2.2)                        | B3 com o **arquivo físico** ausente (registro existe, arquivo não): exigiria apagar um arquivo na VM, que o runner não faz e eu não faço sem autorização. Esse caso está coberto pelos 4 testes automáticos de `arquivos-inexistentes`; o roteiro testa o 404 pela foto removida (B3-1) |
| Produção, estoque, qualidade, entregas, ocorrências e financeiro (2.3 a 2.8) | **Memória durante uploads**: medições contínuas da VM e dos contêineres durante FO-03 e FO-05 (2.9)                                                                                                                                                                                     |
| Fotos e U1 (FO-01 a FO-06, U1)                                               | **RB-06**: confirmação das imagens de retorno e do ponto de recuperação                                                                                                                                                                                                                 |
| Prontidão de retorno RB-01 a RB-05 (2.11)                                    | Análise das fichas de falha pelos logs da janela de tempo (3.2)                                                                                                                                                                                                                         |
| Alertas, "Hoje", compatibilidade, auditoria (2.10, 2.12, 2.13)               | Logs de 5xx e erros do período inteiro (AU-05)                                                                                                                                                                                                                                          |

O que eu **não** faço em nenhum caso, sem nova autorização:

- deploy;
- migration;
- retorno de versão;
- limpeza de imagens, volumes ou backups;
- alteração de usuários reais;
- qualquer ação em produção.
