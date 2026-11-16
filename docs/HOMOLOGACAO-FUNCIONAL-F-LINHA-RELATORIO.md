# Homologação funcional da versão F′ (`63674f1`) — relatório

12/11/2026. Autorização: testes controlados em homologação, somente dados `HML-`, sem deploy de
correções, sem alterações de produção e sem limpeza.

## 0. Onde os testes rodaram (leia primeiro)

| Ambiente                                                                             | O que foi feito                                                                                                                                                     | Por quê                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instância de homologação** (`cenario-homolog`)                                     | Só leitura: saúde, versão, logs da API (3 h), recursos e impressão digital do banco                                                                                 | A interface da homologação **não é acessível deste ambiente**: o domínio é bloqueado pela política de rede do ambiente isolado, e o painel exige a senha do proxy e a de um usuário do sistema, que **não peço em mensagem**. Nenhum teste de interface foi executado na instância. |
| **Réplica isolada da F′** (mesmo código `63674f1`; aplicação inalterada desde então) | **Todos os testes de interface**: Chromium real, build de produção do web (`next build`), API e PostgreSQL 16 locais descartáveis, só dados `HML-` e do próprio E2E | Única forma de acionar de fato botões, formulários e fluxos sem credenciais reais                                                                                                                                                                                                   |

Diferenças da réplica para a homologação: a API roda do código-fonte (`tsx`, sem o limite de 512 MB do
contêiner), `APP_ENV=test`, sem o proxy Caddy, banco recriado a cada execução. Os resultados de
**interface** valem para o código F′; os de **desempenho** da réplica não substituem a medição na VM.

**Classificação usada:** EXECUTADO (acionado de verdade no navegador ou na API), SIMULADO (validado
por código/contrato, sem acionar) e NÃO EXECUTADO (com motivo).

## 1. Inventário

- **58 páginas** web (`inventario-paginas.txt`): 4 públicas (`/`, `/conheca`, `/entrar`, `/tablet`),
  43 estáticas do painel e 11 dinâmicas (`[id]`).
- **426 rotas de API** (`inventario-rotas-api.txt`): 191 POST, 174 GET, 48 PUT, 8 DELETE, 5 PATCH —
  financeiro 80, qualidade/entregas 61, produção 42, compras 40, ajuda 19, estoque 18, medições
  17, presença 16, OS 12, ocorrências 12, funcionários 11, clientes 11, demais ≤ 8.
- **Menu**: 34 itens filtrados por permissão e por funcionalidade ligada/desligada; 56
  permissões; 5 funções padrão (Gestor + 4 de tablet sem acesso ao painel).
- **Fluxos de interface**: 50 arquivos de E2E pré-existentes (68 testes) + 2 novos de auditoria
  (`zz-auditoria-funcional`: navegação completa e perfis; `zz-auditoria-fluxos`: acesso, clientes,
  conta, funções e fotos).

## 2. Matriz por módulo (EXECUTADO na réplica, salvo indicação)

| #   | Módulo               | Testes de interface (arquivos E2E)                                                                                                                                                                                                                                                                                                                                             | Situação                                                                          |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | Acesso e navegação   | `admin` (rotas exigem login, credencial inválida sem revelar e-mail, cadastro de funcionário, validação da empresa); `zz-auditoria-fluxos` (envio vazio, senha errada, entrar, **sair**, painel e API após sair, perfil sem painel); `zz-auditoria-funcional` (57 páginas × 1440 e 390 px); `zz-geometria`, `zz-visual-audit` (todas as telas e diálogos em 390/768/1280/1440) | APROVADO, exceto **B4**                                                           |
| 2   | Clientes e OS        | `zz-auditoria-fluxos` (cadastrar com validação, buscar, abrir, editar); `novo-servico` (4), `commercial-flow` (2), `fase2-os-estado-fotos`, `fase2-modelos-servico`, `modelos-simplificados`, `novo-servico-rede`, `prazos`, `zz-fluxo-transversal`                                                                                                                            | APROVADO, exceto **B1** (perfil)                                                  |
| 3   | Estoque e materiais  | `aa-fase1-materiais-estoque-entrega` (lista da OS, estoque da oficina com ajuste/histórico/arquivamento), `compras-sem-duplicidade` (reservar, estoque livre), `compras-etapa2/3`, `purchasing`, `recebimentos`, `fase1-conciliacao`                                                                                                                                           | APROVADO, exceto **B2** (menu)                                                    |
| 4   | Produção             | `production`, `pre-planejamento`, `team-queue`, `team-week`, `team-workshop` (início simultâneo, prioridade, queda de conexão), `tablets`, `team-distribution`, `team-help`, `team-issues`, `fase2-mapa-oficina`                                                                                                                                                               | APROVADO                                                                          |
| 5   | Qualidade            | `team-quality` (reprovação → correção → aprovação → embalagem), `zz-fase3-qualidade-programacao` (autoaprovação justificada, "Tudo conforme", embalagem desligada)                                                                                                                                                                                                             | APROVADO                                                                          |
| 6   | Entregas             | `team-quality` (agenda → entrega), `team-route-os`, `team-logistics`, `aa-fase1…` (entrega direta, logística desligada), `zz-fase3…` (desfazer entrega com prévia e histórico)                                                                                                                                                                                                 | APROVADO                                                                          |
| 7   | Financeiro           | `cobranca`, `team-finance`, `team-labor`, `team-closing` (conferir, Pix, reabrir, estornar), `team-negociacao`, `team-logistics`, `rodada2-central`, `fase1-conciliacao` — **só lançamentos internos**; nenhuma transação externa existe no sistema                                                                                                                            | APROVADO                                                                          |
| 8   | Planejamento semanal | `pre-planejamento`, `zz-fase3…` (tela única, endereços antigos, publicação), `team-week`, `team-queue`, `measurements` (rotina de sexta)                                                                                                                                                                                                                                       | APROVADO                                                                          |
| 9   | Painel Hoje          | `zz-fase4-hoje` (seções, sugestões só com link, produtividade sem valores, 1440/390), `gestao` (Início, Central) — alertas: testes de API (9)                                                                                                                                                                                                                                  | APROVADO; alertas em tempo real na interface: SIMULADO (cálculo testado pela API) |
| 10  | Permissões           | `zz-auditoria-funcional` (5 perfis `HML-` × 43 páginas = 215 acessos diretos + menu; 4 perfis de tablet recusados), `team-closing` (sem acesso para tablets), `zz-auditoria-fluxos` (mensagem ao perfil sem painel)                                                                                                                                                            | APROVADO com **B1, B2, B5, B6**                                                   |
| 11  | Fotos e arquivos     | `fase2-os-estado-fotos` (sem EXIF/GPS, miniatura, visualizador), `zz-auditoria-fluxos` (enviar, ampliar, **arquivo inexistente**, remover, URL após remover → 404), `recebimentos` (fotos no tablet)                                                                                                                                                                           | APROVADO, exceto **B3**; fotos antigas na VM: NÃO EXECUTADO                       |
| 12  | Dispositivos         | Desktop 1440 e celular 390 em todas as páginas (Chromium); `tablet-sync` (vinculação, PIN, revogação), `tablets`                                                                                                                                                                                                                                                               | Chromium: APROVADO. **Safari e tablet físico: NÃO EXECUTADO** (sem acesso)        |

## 3. Quantitativos (execução consolidada final)

Execução consolidada única (19:00–19:27 UTC), réplica F′, `e2e-resultados.tsv`:

| Nível                                                     | Total  | Aprovados                                                       | Reprovados                      | Bloqueados                     | Não executados                                        |
| --------------------------------------------------------- | ------ | --------------------------------------------------------------- | ------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Testes de interface (arquivos de teste)                   | **78** | **75**                                                          | **3** (registram B1/B2, B3, B4) | 0                              | 0                                                     |
| Acessos do gestor (57 páginas × 1440 e 390 px)            | 114    | **114** (0 erro de página, 0 console, 0 5xx, 0 rolagem lateral) | 0                               | 0                              | 2 (`/painel/entregas/ocorrencias/[id]`: sem registro) |
| Acessos diretos por perfil `HML-` (5 perfis × 43 páginas) | 215    | 209                                                             | 6 (5 × B2, 1 × B1)              | 0                              | 0                                                     |
| Perfis de tablet tentando o painel                        | 4      | 4 (recusados, mensagem clara)                                   | 0                               | 0                              | 0                                                     |
| Passos de fluxo interativo (`fluxos.jsonl`)               | 30     | 27                                                              | 3 (B4, B3 × 2)                  | 0                              | 0                                                     |
| Interface da instância de homologação                     | —      | —                                                               | —                               | **todos** (rede + credenciais) | —                                                     |
| Safari / tablet físico                                    | —      | —                                                               | —                               | —                              | **todos** (sem acesso)                                |

Os 3 testes reprovados são exatamente os que registram os defeitos da seção 4; nenhum teste
pré-existente (68) falhou.

## 4. Defeitos encontrados

Nenhum crítico ou alto. **Todos preexistentes** (o mesmo código está na versão `3e0d2d0`, anterior às
Fases 2–4), salvo onde indicado.

| ID     | Gravidade         | Defeito                                                   | Rota / ação                                                                                                  | Esperado                                                                  | Observado                                                                                                                                                                                                                               |
| ------ | ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | Média             | Menu mostra "Novo serviço" a quem não pode usá-lo         | Perfil com `pedidos.gerenciar` sem `retiradas.gerenciar` → menu → `/painel/servicos/novo`                    | Item só aparece com as duas permissões (o botão do Início já exige ambas) | Item aparece; `GET /api/v1/services/new-defaults` → **403**; página sem os dados padrão                                                                                                                                                 |
| **B2** | Média             | "Recebimento de materiais" no menu de **todos** os perfis | Qualquer perfil sem `estoque.ver`/`compras.ver`/`estoque.gerenciar` → menu → `/painel/recebimento-materiais` | Item filtrado pela mesma permissão da API                                 | Item aparece (sem filtro desde a Fase 4 original, 08/10); `GET /api/v1/material-arrivals` → **403**                                                                                                                                     |
| **B3** | Baixa             | Arquivo inexistente responde 500                          | `GET /api/files/:id` e `/api/files/:id/miniatura` de foto cujo arquivo físico sumiu (não excluída)           | 404                                                                       | **HTTP 500** nos dois; a página da OS continua utilizável (galeria com imagem quebrada). Na F′ a galeria também pede a miniatura                                                                                                        |
| **B4** | Baixa             | "Sair" mostra "Sua sessão foi encerrada"                  | Botão **Sair**                                                                                               | `/entrar?motivo=saiu` e "Você saiu do painel com segurança."              | `/entrar?motivo=sessao-encerrada` — o tempo real recebe o encerramento da sessão e redireciona antes; a saída em si funciona (painel e API pedem login de novo, API 401)                                                                |
| **B5** | Baixa (cosmético) | Página vazia sem aviso                                    | Perfil sem permissão abre `/painel/dispositivos` ou `/painel/sincronizacao` direto pela URL                  | Aviso de permissão                                                        | Dispositivos: só o cabeçalho, sem chamada à API. Sincronização: painel aparece, mas sua ação de teste (`POST /api/sync/signal`, `sincronizacao.diagnosticar`) responderia 403 — não acionada. **Nenhum dado exposto** na carga das duas |
| **B6** | Baixa             | Menu e API divergem em Devoluções                         | Perfil com `pedidos.ver` sem `devolucoes.gerenciar`                                                          | Mesma regra no menu e na API                                              | API permite ler (`pedidos.ver`), menu não mostra — acesso só pela URL (intencional na API)                                                                                                                                              |
| **U1** | Melhoria          | Remover foto sem confirmação                              | Galeria → "Remover foto"                                                                                     | Confirmação antes de remover                                              | Remove no primeiro clique (exclusão lógica; recuperável só por suporte)                                                                                                                                                                 |

Não reproduzidos como defeito (verificados): mensagens de validação de login, cliente (inclusive
endereço obrigatório ou "Cadastrar depois") e troca de senha; perfis de tablet recusados no painel
com "Seu usuário não tem acesso ao painel administrativo."; 0 erro de página, 0 erro de console, 0
resposta 5xx e 0 rolagem lateral nas 57 páginas do gestor em 1440 e 390 px.

## 5. Integridade dos dados

- **Homologação (instância real):** impressão digital (contagem + md5 de todas as colunas, 126
  tabelas) **idêntica** à da verificação pós-deploy; nenhum teste escreveu nela. Logs da API nas
  últimas 3 h: 164 requisições, **0 respostas 5xx, 0 erros**. F′ ativa e saudável.
- **Réplica:** fluxos financeiros e operacionais conferidos pelos próprios E2E (valores de
  cobrança, recebimento parcial, mão de obra, fechamento com estorno, conciliação sem dupla
  contagem, entrega direta e reversão com efeitos só da entrega) — todos aprovados.

## 6. Desempenho e recursos

- **Tempo de carga na interface (réplica, build de produção):** mediana 1,15 s (1440 px) e 1,10 s
  (390 px); p90 1,44 s / 1,33 s; máximo 2,7 s (`/painel` e `/painel/financeiro`, com mais dados).
- **Recursos na réplica (amostras a cada 10 s, 26 min):** web média 118 MB, máx. 278 MB; API média
  269 MB, máx. 772 MB. A API da réplica roda do código-fonte (`tsx`) e **sem** o limite do contêiner;
  o pico ocorre nos testes de foto (`sharp`). Referência válida para a VM continua sendo a medição
  com a imagem real: até 430 MB de 512 MB com 4 fotos grandes simultâneas → **monitorar na VM**.
- **Homologação (instância real, ociosa):** API 143 MB/512, web 149 MB/448, postgres 87 MB/448,
  CPU ~0%; 0 erro e 0 5xx em 3 h.

## 7. Correções recomendadas antes da produção

1. **B1** — alinhar o item "Novo serviço" do menu às duas permissões da rota (`nav.ts`).
2. **B2** — filtrar "Recebimento de materiais" por `estoque.ver`/`compras.ver`/`estoque.gerenciar`.
3. **B3** — responder 404 quando o arquivo físico não existe (`files/routes.ts`), evitando 500
   e alarmes falsos de "5xx repetido".
4. Opcionais: **B4** (ignorar o aviso de sessão encerrada durante a saída), **B5** (aviso de
   permissão), **B6** (alinhar menu e API), **U1** (confirmação ao remover foto).

Nenhuma correção foi aplicada nem implantada (fora do escopo autorizado). Todas exigem nova
versão, testes e autorização.

## 8. Testes que dependem de intervenção manual

1. **Interface da instância de homologação** com as credenciais reais (roteiro
   `HOMOLOGACAO-INTEGRADA-ROTEIRO-MANUAL.md`) — nenhum teste de interface foi feito nela.
2. **Safari** (iPhone/iPad/Mac) e **tablet físico** da oficina.
3. Fotos reais de celular (orientação, GPS removido) e **memória/CPU da API na VM** durante envios.
4. **Passo 17**: foto real no backup da homologação (`backup_create` → `backup_restore_test`).
5. Detalhe de ocorrência de logística (`/painel/entregas/ocorrencias/[id]`): sem registro na
   réplica para abrir — NÃO EXECUTADO.
6. Prontidão de retorno pela tela do gestor (`/api/v1/system/rollback-readiness`).

## 9. Veredito

**GO COM RESSALVAS** — para continuar a homologação rumo à produção, **não** para implantar em
produção agora.

- Nenhum defeito crítico ou alto; nenhum risco a dados financeiros ou de arquivos; todos os 7
  achados são **preexistentes** às Fases 2–4 (a F′ não introduziu regressão detectada).
- Antes da produção: corrigir **B1, B2 e B3** (nova versão, testes e autorização) e executar os
  testes manuais da seção 8 — em especial a **interface da própria instância de homologação**,
  **Safari** e **tablet físico**, que não foram testados aqui e não estão aprovados.
