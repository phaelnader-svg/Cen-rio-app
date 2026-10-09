# Segurança — Cenário Gestão

## Autenticação

| Superfície | Credencial                                             | Detalhes                                                                             |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Painel     | E-mail + senha                                         | Senha ≥ 10 caracteres com letras e números; hash **argon2id** (19 MiB, 2 iterações). |
| Tablet     | Dispositivo vinculado + funcionário + PIN de 6 dígitos | PIN sem sequências/repetições; hash argon2id. Só funciona em tablet vinculado.       |

- Usuário inexistente e senha errada recebem a mesma mensagem, com custo de tempo equivalente
  (verificação "fictícia" de hash).
- **Força bruta:** bloqueio progressivo persistido no banco — 5 falhas por conta/PIN em 15 min
  bloqueiam (1–2 min, dobrando até 1 h); limite por IP quando o IP real é conhecido;
  vinculação de dispositivos limitada; limite geral de 600 req/min por IP.

## Sessões e dispositivos

- Token opaco de 256 bits em cookie `httpOnly`, `SameSite=Lax`, `Secure` e prefixo `__Host-`
  em HTTPS. No banco fica apenas o **HMAC-SHA256** do token (`TOKEN_HASH_SECRET`).
- Painel: expira após 12 h sem uso e no máximo em 30 dias (configurável).
- Tablet: sessão permanente renovada a cada uso (expira só após 30 dias sem uso) e **vinculada
  ao dispositivo**: o cookie de sessão sozinho não vale sem a credencial do tablet.
- Vinculação: o gestor cadastra o tablet e recebe um código de uso único (15 min, 8 caracteres
  sem ambiguidades, guardado como hash). O tablet recebe uma credencial própria (cookie
  `httpOnly`, 400 dias, renovada).
- **Revogação remota** (efeito imediato, inclusive no WebSocket): encerrar sessão, revogar
  dispositivo, desativar funcionário, trocar PIN/senha.

## Autorização

- Catálogo de permissões em código; funções editáveis; concessões individuais.
- **Toda rota** `/api` declara regra de acesso; sem ela a API não inicia. O servidor verifica
  sessão, tipo de sessão (painel × tablet), permissão de ambiente (`painel.acessar` /
  `producao.acessar`) e permissões específicas — a cada requisição, lendo do banco (mudanças
  valem na hora).
- Sem escalonamento: ninguém concede permissão que não possui.
- Função Gestor protegida (sempre com todas as permissões); o sistema nunca fica sem um gestor
  ativo com acesso ao painel; ninguém desativa a si mesmo.

### Dados pessoais e comerciais (Fase 2)

| Dado                                                                      | Quem vê                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cadastro completo do cliente (CPF/CNPJ, contatos, endereços, observações) | `clientes.ver`                                                                                                                   |
| Resumo do cliente (nome, tipo) para selecionar em pedidos                 | `clientes.ver` ou `pedidos.gerenciar`                                                                                            |
| Endereços do cliente                                                      | `clientes.ver`, `pedidos.gerenciar` ou `retiradas.gerenciar`                                                                     |
| Valor negociado e condições comerciais                                    | `pedidos.valores` (ocultos na resposta; quem não tem a permissão também não consegue alterá-los)                                 |
| Telefone/WhatsApp na retirada                                             | `retiradas.ver` (necessário para a operação)                                                                                     |
| Pendências de recebimento                                                 | `recebimentos.registrar` — sem valores, documentos ou contatos                                                                   |
| OS                                                                        | `os.ver` — cliente apenas pelo nome                                                                                              |
| Fotografias                                                               | Permissão de leitura do registro de origem (pedido, retirada, recebimento, OS); envio exige a permissão de gestão correspondente |

- Auditoria de clientes não copia o CPF/CNPJ (registra apenas que mudou).
- Eventos de tempo real não carregam dados pessoais nem valores.
- Somente quem tem as permissões específicas cria pedidos (`pedidos.gerenciar`), altera
  valores (`pedidos.valores`), cancela pedidos (`pedidos.cancelar`), agenda retiradas
  (`retiradas.gerenciar`) e cria/altera OS (`os.gerenciar`). A função Gestor sempre tem o
  catálogo completo (garantido em tempo de execução, além da migração de dados).

### Medições e materiais (Fase 3)

| Ação                                                             | Quem pode                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Criar, reatribuir e cancelar medições; rotina de sexta           | `medicoes.gerenciar` (crítica) — painel                                                         |
| Executar medição (rascunho, envio, correção e reenvio)           | **somente o responsável atribuído**, com `medicoes.extraordinarias` ou `medicoes.gerenciar`     |
| Ver todas as medições, planejamento e lista consolidada          | `medicoes.gerenciar`, `materiais.ver` ou `materiais.aprovar` — painel                           |
| Iniciar revisão, ajustar quantidades, aprovar, devolver, reabrir | `materiais.aprovar` (crítica) — painel                                                          |
| Registro direto de medidas na OS (fora do fluxo de medição)      | `os.gerenciar` em sessão do painel (antes da Fase 3 também aceitava `medicoes.extraordinarias`) |

- Um executor só lê as medições atribuídas a ele (403 nas demais) e as fotos da OS dessas
  medições; o tablet não recebe valores, condições comerciais, documentos nem contatos do
  cliente (testado).
- Nem o gestor altera a medição de outra pessoa: depois do envio, qualquer ajuste é feito pela
  revisão, com motivo obrigatório e cópia "antes/depois" no histórico imutável
  (`measurement_revisions`, protegido por trigger).
- Solicitação aprovada não muda em silêncio: só por **reabertura** com motivo, que também
  retira as necessidades aprovadas da OS.
- Criação e aprovação exigem `Idempotency-Key`; todas as mudanças usam `version` e bloqueio de
  linha (decisões simultâneas: só uma vence, as outras recebem 409).

### Compras, estoque e recebimento (Fase 4)

| Ação                                                              | Quem pode                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Ver central de compras, pedidos, **preços** e fornecedores        | `compras.ver` (também `compras.gerenciar`/`compras.aprovar` acessam a lista) |
| Cadastrar fornecedores, montar pedidos (rascunho) e preços        | `compras.gerenciar` (crítica)                                                |
| Confirmar/cancelar pedidos, autorizar recebimento acima do pedido | `compras.aprovar` (crítica) — padrão: só o Gestor                            |
| Registrar recebimento de materiais                                | **qualquer funcionário autenticado** (painel ou tablet), sem acesso a preços |
| Ver estoque, movimentações, reservas, sobras e prontidão          | `estoque.ver` (prontidão também com `os.ver`/`compras.ver`)                  |
| Catálogo, ajustes, saídas, reservas e registro de sobras          | `estoque.gerenciar` (crítica)                                                |
| Estornar recebimentos e transferir sobras entre OS                | `estoque.autorizar` (crítica) — padrão: só o Gestor                          |

- A lista de pedidos a receber (`/material-receipts/pending`) e o recebimento devolvem só
  especificação e quantidades — nunca preços, totais ou condições (testado).
- Preços nos DTOs só aparecem com `compras.ver`; eventos de tempo real não carregam valores.
- Recebimentos, estornos, movimentações, transferências e histórico de compras são imutáveis
  (triggers); correções somente por lançamento compensatório.
- Operações de recebimento, reserva, estorno, ajuste, transferência, criação e confirmação de
  pedido são idempotentes e usam bloqueio de linha; o banco impede estoque negativo.

### Produção (Fase 5)

| Ação                                                                                                                    | Quem pode                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Ver planejamentos, quadro de produção, modelos e tarefas de todos                                                       | `producao.ver` (ou `producao.planejar`)                                                     |
| Criar/publicar planejamento; alterar responsável, horário, prioridade, dependências; bloquear, cancelar; editar modelos | `producao.planejar` (crítica) — padrão: só o Gestor                                         |
| Ver as próprias tarefas e iniciar, registrar andamento, pausar, retomar e concluir                                      | `producao.executar` (tapeceiro, cabeceiras/qualidade, ajudante) — **somente o responsável** |

- Toda ação de execução confere no servidor que a tarefa é do usuário autenticado (403 caso
  contrário); ninguém altera a tarefa de outra pessoa, nem o gestor executa pelo funcionário.
- O detalhe da tarefa no tablet não traz valores, condições de pagamento nem preços (testado).
- O responsável por uma tarefa publicada pode ver as fotos da OS correspondente.
- Início e conclusão são idempotentes (`Idempotency-Key`) e usam bloqueio de linha; histórico de
  tarefas e revisões de planejamento são imutáveis (triggers).

### Tablets e avisos (Fase 6)

- Avisos são do usuário autenticado: listar, marcar como lido e "todos lidos" agem só nos próprios
  (aviso de outra pessoa responde 404, sem revelar que existe); eventos `notification.*` vão só para
  `user:<id>` e não carregam texto do aviso.
- Fotos da tarefa (`PRODUCTION_TASK`): enviadas pelo responsável enquanto executa (em execução ou
  pausada) e vistas por ele e pela gestão; quem não é responsável recebe 403. Fotos citadas num
  andamento ou conclusão precisam pertencer à própria tarefa.
- O detalhe do tablet mostra o histórico técnico da OS apenas com os **nomes** dos campos alterados
  (lista permitida de campos técnicos), sem valores antigos/novos; nenhum preço, valor, condição de
  pagamento ou dado bancário (testado).
- Vincular materiais à tarefa exige `producao.planejar`, aceita só materiais aprovados da mesma OS e
  nunca libera uma tarefa sem os materiais vinculados cobertos (verificado também no `iniciar`).
- Sem conexão, o tablet desativa as ações em vez de simular gravações.

### Presença operacional (Fase 7)

| Ação                                                                            | Quem pode                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Confirmar a própria chegada e encerrar o próprio expediente                     | `presenca.registrar` (tapeceiro, cabeceiras, ajudante) |
| Ver presença da equipe, alertas, impactos e histórico                           | `presenca.ver` (ou `presenca.gerenciar`)               |
| Confirmar ausência, registrar situações especiais, corrigir, encaminhar alertas | `presenca.gerenciar` (crítica) — padrão: só o Gestor   |

- As rotas do funcionário não recebem identificador de pessoa: valem sempre para o usuário da
  sessão (o tablet vinculado), com horário do servidor e dispositivo registrados. Ninguém registra
  presença de outro.
- Toda correção exige justificativa; o histórico (`attendance_corrections`) é imutável no banco.
- Atestado é só o fato informado: não há campo para CID, diagnóstico ou outro dado médico.
- Não há GPS, reconhecimento facial nem câmeras; a presença operacional não é prova de jornada.
- Confirmações repetidas ou simultâneas não duplicam (bloqueio por funcionário/dia + chave única +
  idempotência).

## Proteções de requisição

- **CSRF / WebSocket entre sites:** métodos que alteram estado e o upgrade do WebSocket exigem
  `Origin` presente em `ALLOWED_ORIGINS`.
- **Validação** de todas as entradas com zod (esquemas compartilhados com a interface).
- Cabeçalhos de segurança (helmet na API; CSP, `X-Frame-Options`, `nosniff`,
  `Permissions-Policy` no Next.js). Respostas da API com `Cache-Control: no-store`.
- Limite de corpo JSON 256 KB; upload limitado por `MAX_UPLOAD_MB`.
- Erros: mensagens genéricas para falhas internas, com `requestId` para rastreio no log.

## Arquivos

- Armazenamento privado fora de diretórios públicos (`STORAGE_DIR`, permissões 700/600), nomes
  gerados (UUID), caminho validado contra _path traversal_.
- Tipo real verificado pelos bytes (JPEG/PNG/WebP), não pelo nome.
- Leitura só pela rota autenticada `/api/files/:id`, com política por finalidade (negação por
  padrão), `nosniff`, CSP `sandbox` e cache privado.

## Logs e auditoria

- Logs estruturados (pino/JSON) com `requestId`; cookies, autorização, senhas, PINs, códigos e
  hashes são **removidos** (redaction). Nenhum segredo é registrado.
- Auditoria imutável no banco para ações críticas (login/logout, cadastros, credenciais,
  funções, dispositivos, sessões, configurações), com diferenças antes/depois sem dados
  sensíveis, IP e autor.

## Ajuda e reprogramação (Fase 8)

- Pedir ajuda exige `ajuda.solicitar` (tapeceiros e cabeceiras) e só vale na **própria** tarefa
  liberada ou em andamento (nunca numa tarefa de apoio); cancelar, só o próprio solicitante (antes
  de o apoio começar) ou o gestor. Ajudante e solicitante veem o pedido; no tablet, a avaliação
  dos colegas não é exposta.
- Fila, propostas, histórico e competências são do painel (`producao.ver`/`producao.planejar`);
  decidir propostas, reavaliar a fila e alterar competências exigem `producao.planejar`.
- Nenhuma mudança crítica é aplicada sem aprovação; decisões usam versão (409) e bloqueio da
  proposta; repetir com a mesma chave de idempotência não duplica.
- Relógio de teste: só existe com `ENABLE_TEST_CLOCK=true` **e** `APP_ENV=test`; em qualquer outro
  ambiente a API recusa iniciar com a variável e as rotas nem são registradas. Mesmo em teste,
  só o gestor (`presenca.gerenciar`, sessão do painel) o controla.

## Ocorrências e central de atenção (Fase 9)

- `ocorrencias.registrar` (oficina): abrir ocorrência só nas **próprias** tarefas; acompanhar as
  próprias; cancelar só a própria e ainda aberta (engano). Fotos: quem registrou ou quem resolve
  (arquivos privados, mesma rota de anexos).
- `ocorrencias.ver` / `ocorrencias.gerenciar` (gestor, sessão do painel): central, lista, impactos;
  delegar, verificar/confirmar, reabrir e cancelar (motivo obrigatório). Quem resolve registra
  ações e a solução, mas **não** confirma a resolução. Ninguém encerra ocorrência de terceiros
  sem a permissão.
- Ocorrências não podem ser excluídas (trigger) e o histórico é imutável; decisões usam versão
  (409) e bloqueio de linha; abertura idempotente e sem duplicar a mesma ocorrência aberta.
- Escolha manual do ajudante exige `producao.planejar`; atribuições impossíveis são recusadas e o
  conflito precisa de aprovação explícita registrada.

## Qualidade, entregas e logística (Fase 10)

- `qualidade.inspecionar` (Thiago; concessão individual para substitutos): ver só as inspeções
  designadas a si, conferir, fotografar, aprovar e reprovar. Quem executou o serviço **não**
  aprova sem autorização explícita do gestor (auditada); outros funcionários recebem 403.
- `qualidade.gerenciar` (gestor, painel): todas as inspeções, aprovação direta, designação de
  substituto, checklists, inspetor principal, localizações e distribuição da embalagem (tapeceiro
  só com autorização explícita).
- `entregas.ver` / `entregas.gerenciar`: consultar / agendar, confirmar, reagendar e cancelar
  entregas e tratar ocorrências logísticas — **exclusivo do gestor**.
- `logistica.executar` (André e Izaías, função própria sem acesso ao painel nem à produção): vê só
  as retiradas e entregas atribuídas a si, numa visão restrita (endereço, contato operacional,
  peças, data, horário, instruções, situação) — sem valores, margens ou dados comerciais; registra
  saída, chegada, peças, instalação, tentativa frustrada e ocorrências apenas do que é seu.
- `devolucoes.gerenciar` (gestor): devoluções e correção de recebimento (com justificativa).
- Imutabilidade no banco: inspeções decididas, checklist decidido, eventos de qualidade,
  localização, entrega e ocorrência, correções de recebimento; inspeções, embalagens, entregas,
  ocorrências e devoluções não podem ser excluídas (triggers). Concorrência por versão (409) e
  bloqueio de linha; ações repetíveis com chave de idempotência.
- Fotos (inspeção, embalagem, entrega, ocorrência logística) seguem a política de anexos privados:
  inspetor designado, quem embala e o responsável pela entrega, além do gestor.

## Financeiro operacional (Fase 11)

- `financeiro.ver` (gestor, **somente sessão do painel**): receitas, recebimentos, contas a pagar,
  custos por OS, margens, despesas, painel, indicadores e relatórios. Tablets recebem 403 mesmo se
  a permissão for concedida.
- `financeiro.gerenciar` (gestor, painel): cobranças, recebimentos, contas a pagar, pagamentos,
  despesas, custos logísticos, custo mensal da equipe e valores de produção. Tudo é registro: o
  sistema não acessa banco, não paga, não cobra e não emite nota fiscal.
- `financeiro.ajustes` (gestor, painel): descontos/acréscimos/ajustes do valor da OS, ajuste do
  valor de produção, custo manual e alíquota estimada — sempre com justificativa, auditoria e
  histórico imutável.
- `financeiro.producao_propria` (concessão individual a Ricardo/Márcio, qualquer sessão): só os
  **próprios** valores de produção e pagamentos (`GET /finance/my-production`, filtrado pelo
  usuário da sessão). Nunca valores de clientes, de outras pessoas, margens ou custos.
- Eventos financeiros (`finance.*`) vão só para quem tem `financeiro.ver` e **não levam valores**
  (id, tipo, situação); tablets não os recebem nem na reconciliação.
- Banco: CHECKs (valores positivos, recebido/pago ≤ valor, situações válidas), triggers de
  imutabilidade (ajustes, recebimentos, pagamentos, custos da OS, rateios, histórico financeiro) e
  de não exclusão (contas a receber/pagar, valores de produção, custos logísticos, despesas);
  índices únicos parciais contra duplicidade; versão (409) e `FOR UPDATE` nas ações; chave de
  idempotência nas criações e pagamentos.
- CSV exportado com proteção contra injeção de fórmulas (texto começando com `=`, `+`, `@`, `-`).
- Comprovantes (anexo `FINANCE_PAYABLE`): ver com `financeiro.ver`, enviar com
  `financeiro.gerenciar`.

## Auditoria final (Fase 12)

Verificações automatizadas que passam a rodar em todo `pnpm test` (e no CI):

- `apps/api/test/security-audit.test.ts` percorre **todas as rotas registradas** (catálogo
  `app.routeCatalog`, ~300): sem sessão → 401; com `Origin` estranho → 403; com o tablet do
  Ricardo, o celular do André e um usuário de painel só com `pedidos.ver` → 403 onde a regra
  declarada da rota nega. Rotas públicas são exatamente: `health`, `ready`, `tablet/status`,
  `auth/login` e `tablet/pair`. Toda rota nova sem `config.access` impede a API de iniciar.
- Isolamento André × Izaías (um não vê nem movimenta a retirada do outro), anexos privados
  (comprovante financeiro → 403 no tablet; caminhos com `..` → 400/404), textos de injeção
  gravados como texto, corpo acima do limite → 413, cabeçalhos de segurança, e sessão revogada
  derrubando o WebSocket na hora.
- `pnpm audit --audit-level critical` no CI. Dependências atualizadas na Fase 12 (vitest 4.1,
  postcss 8.5, overrides de `esbuild`, `deepmerge-ts`). Resta 1 alerta **alto** sem versão
  corrigida publicada: `braces` (via `@next/eslint-plugin-next`, só ferramenta de lint em
  desenvolvimento; não vai para a API nem para o navegador).
- Homologação: `infra/homolog/` sem segredos versionados (`.env.homolog` ignorado no Git e no
  contexto do Docker), banco sem porta pública, API como usuário sem privilégios, `noindex`.

## Segredos e ambientes

- Segredos apenas por variáveis de ambiente; `.env` não é versionado.
- Em homologação/produção a API recusa iniciar sem HTTPS nas origens, `COOKIE_SECURE=true` e
  `NODE_ENV=production`.
- Bancos separados por ambiente; os testes recusam rodar em banco cujo nome não contenha
  `test` ou que seja igual ao `DATABASE_URL`.

## Riscos conhecidos e decisões aceitas

| Item                                 | Situação                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP real atrás de proxy               | O Next.js (dev) não informa o IP do cliente. Sem `TRUST_PROXY`, o limite por IP é ignorado para não bloquear todos os tablets juntos (limites por conta/PIN continuam). Em produção use proxy reverso com `TRUST_PROXY` (veja `infra/Caddyfile.example`). |
| Limite geral de requisições          | Em memória, por instância. Com várias instâncias, usar armazenamento compartilhado (ex.: Redis) — não necessário agora.                                                                                                                                   |
| Resposta idempotente guardada        | A resposta do cadastro de dispositivo (que contém o código de vinculação) fica até 24 h na tabela de idempotência. O código expira em 15 min e é de uso único; quem lê o banco já tem acesso total.                                                       |
| CSP com `'unsafe-inline'` em scripts | Exigido pelo Next.js sem _nonce_. Nenhuma origem externa é permitida. Evolução: CSP com nonce.                                                                                                                                                            |
| PIN de 6 dígitos                     | Adequado somado ao vínculo do dispositivo e ao bloqueio progressivo; não substitui senha no painel.                                                                                                                                                       |
| Dependência `braces` (alerta alto)   | Só no lint (`@next/eslint-plugin-next`), sem versão corrigida publicada; não é executada pela API nem pelo navegador. Reavaliar a cada atualização do Next.js.                                                                                            |
