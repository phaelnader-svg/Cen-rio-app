# Correções da homologação funcional (B1–B6, U1) — relatório

Base: versão integrada F′ `63674f1` e o relatório `HOMOLOGACAO-FUNCIONAL-F-LINHA-RELATORIO.md`.
Tudo implementado e validado em **ambiente isolado**. Nenhum deploy, migration, alteração de
produção, dado real, permissão nova ou limpeza.

## 1. Análise antes de corrigir

| ID  | Comportamento real verificado                                                   | Regra do backend                                                                                                                                            | Origem                                                                               |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| B1  | Menu mostrava "Novo serviço" com só `pedidos.gerenciar`; a tela recebia 403     | `GET /api/v1/services/new-defaults` e `POST /api/v1/services`: `pedidos.gerenciar` **e** `retiradas.gerenciar`                                              | Preexistente (`3e0d2d0`)                                                             |
| B2  | Página abria para todos; só a lista "aguardando conferência" recebia 403        | Registrar chegada: **qualquer funcionário** (`ANY_EMPLOYEE`, "painel ou tablet"); lista de conferência: `estoque.ver`, `compras.ver` ou `estoque.gerenciar` | Preexistente (Fase 4 original, 08/10)                                                |
| B3  | Arquivo físico ausente → 500 em `/api/files/:id` e `/miniatura`                 | Autenticação e autorização por tipo de registro (`readable()`) antes da leitura                                                                             | Preexistente na foto (`3e0d2d0`); a rota da miniatura é da **Fase 2** (mesmo padrão) |
| B4  | "Sair" terminava em "Sua sessão foi encerrada"                                  | Logout revoga a sessão; o tempo real avisa o encerramento e redirecionava antes                                                                             | Preexistente                                                                         |
| B5  | Dispositivos/Sincronização sem permissão: página vazia, sem aviso               | `dispositivos.ver`/`sessoes.ver`; `sincronizacao.diagnosticar`                                                                                              | Preexistente                                                                         |
| B6  | Menu só com `devolucoes.gerenciar`; API de consulta aceita também `pedidos.ver` | `RETURNS_VIEW`: `devolucoes.gerenciar` ou `pedidos.ver`; registrar/confirmar/cancelar: `devolucoes.gerenciar`                                               | Preexistente                                                                         |
| U1  | "Remover foto" removia no primeiro clique                                       | Exclusão lógica (registro mantido) + arquivo físico apagado                                                                                                 | Preexistente                                                                         |

Nenhum dos sete foi introduzido pelas Fases 2–4, exceto que a miniatura (Fase 2) repetiu o padrão
do B3.

**Decisão sobre o B2 (para sua confirmação):** o pedido era fazer o menu respeitar estoque/compras.
O backend, porém, define o recebimento de materiais como função de **qualquer funcionário**
(`ANY_EMPLOYEE`), e a trava de menu da Rodada 4 já documentava "sem filtro de propósito". Esconder o
item de quem não tem estoque/compras **reduziria** um acesso que a API concede. A correção seguiu a
regra efetiva: o item continua para todos e a parte que exige estoque/compras (lista de
conferência) só é pedida e mostrada para quem tem essas permissões — o 403 desapareceu sem ampliar
nem reduzir permissões. Se preferir esconder o item, é uma linha em `nav.ts` (`anyOf:
['estoque.ver', 'compras.ver', 'estoque.gerenciar']`), sem efeito no backend.

## 2. Correções

| ID       | Arquivo(s)                                                                                                                 | O que mudou                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| B1       | `apps/web/components/admin/nav.ts`                                                                                         | Novo `allOf` no item de menu; "Novo serviço" exige `pedidos.gerenciar` **e** `retiradas.gerenciar`                                          |
| B1/B2/B6 | `nav.ts`, `shell.tsx`                                                                                                      | Função única `visibleNav()` (filtro `anyOf` + `allOf` + funcionalidade ligada + ordenação) usada pela barra lateral e pelos testes          |
| B2       | `apps/web/components/purchasing/material-receiving.tsx`                                                                    | Lista "aguardando conferência" só com `estoque.ver`/`compras.ver`/`estoque.gerenciar`                                                       |
| B3       | `apps/api/src/modules/files/routes.ts`                                                                                     | `ENOENT` → 404 "Arquivo não encontrado." **depois** de `readable()`; miniatura salva ausente com original presente é regenerada da original |
| B4       | `apps/web/components/admin/shell.tsx`                                                                                      | Marca de saída: o aviso de sessão encerrada do tempo real é ignorado durante o "Sair"                                                       |
| B5       | `apps/web/components/admin/devices-page.tsx`, `components/admin/sync-page.tsx` (novo), `app/painel/sincronizacao/page.tsx` | "Acesso negado — você não tem permissão…" sem nenhuma chamada à API; o painel de sincronização do tablet não muda                           |
| B6       | `nav.ts`, `apps/web/components/quality/returns-page.tsx`                                                                   | Menu com as permissões de consulta da API; "Registrar devolução", "Confirmar" e "Cancelar" só com `devolucoes.gerenciar`                    |
| U1       | `apps/web/components/commercial/photo-gallery.tsx`                                                                         | Diálogo "Remover foto?" com prévia, "Manter foto" e "Remover foto"                                                                          |

Contratos de API inalterados (mesmas rotas, mesmos corpos; só o status de erro do B3 passou de 500
para 404). Nenhuma permissão criada; nenhuma migration; nenhuma rotina que grave dados mudou.

## 3. Testes de regressão criados

| ID         | Teste                                                                           | Cenários                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1, B2, B6 | `apps/web/test/rodada4-menu.test.ts` (trava do menu atualizada + 4 casos novos) | B1: só pedidos ✘, só retiradas ✘, as duas ✔; B2: sem permissões ✔ (qualquer funcionário); B6: `pedidos.ver` ✔, `devolucoes.gerenciar` ✔, nenhuma ✘; nenhuma permissão inexistente no menu                                                                                                                                                                                                                                |
| B3         | `apps/api/test/arquivos-inexistentes.test.ts` (4)                               | miniatura ausente → 200 regenerada; original ausente → 404 na foto e na miniatura sem alterar o registro; sem sessão → 401 e sem permissão → 403 **antes** de olhar o arquivo; foto removida → 404                                                                                                                                                                                                                           |
| B1–B6, U1  | `tests/e2e/specs/zz-auditoria-fluxos.spec.ts` (Chromium)                        | "Sair" com a mensagem certa; arquivo inexistente 404; remover pede confirmação, "Manter" preserva, confirmar remove; perfis: sem retiradas (B1 ✘), com as duas (✔, sem 403); sem estoque (B2 no menu, sem 403); com `estoque.ver` (sem 403); Dispositivos e Sincronização sem permissão (aviso, sem 403) e com permissão (conteúdo); `pedidos.ver` (Devoluções sem botão de registrar) e `devolucoes.gerenciar` (com botão) |
| Todos      | `tests/e2e/specs/zz-auditoria-funcional.spec.ts`                                | 57 páginas × 1440/390 do gestor e 5 perfis × 43 páginas: item de menu com 403 volta a falhar o teste                                                                                                                                                                                                                                                                                                                         |

## 4. Resultados

| Verificação                                                      | Resultado                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Typecheck, lint (zero avisos), formatação                        | ✔                                                                        |
| Pacote compartilhado                                             | 151/151                                                                   |
| Web (inclui a trava do menu e os casos B1/B2/B6)                 | **26/26**                                                                 |
| API (inclui `arquivos-inexistentes` e a trava F10-01 atualizada) | **1017 passaram, 0 falharam**, 13 pulados (opcionais de desempenho/proxy) |
| E2E completo em Chromium (build de produção, réplica isolada)    | **79/79**                                                                 |
| Auditoria de navegação do gestor (57 páginas × 1440 e 390 px)    | 114 acessos, **0 problemas**                                              |
| Auditoria por perfil `HML-` (5 perfis × 43 páginas)              | 215 acessos, **0 problemas** (nenhum item de menu com 403)                |
| Fluxos interativos (permitidos e proibidos)                      | **43/43 passos** ✔                                                       |

Antes das correções, os mesmos testes registravam: 3 testes E2E reprovados, 6 acessos por perfil
com 403 em item do menu e 3 passos de fluxo reprovados.

Observação de execução: duas rodadas intermediárias da API acusaram falhas em massa
(`loginAdmin`/`createOrder`, deadlocks) por terem rodado **ao mesmo tempo** sobre o mesmo banco de
teste; a rodada isolada, sozinha, deu 1017/1017. A primeira rodada também acusou a trava F10-01,
que fixava o texto antigo da tela de recebimento; ela foi atualizada para exigir a nova proteção
por permissão (commit `29dc333`). Evidências: `docs/evidencias/homologacao-funcional-correcoes/`.

## 5. Integridade dos dados

As correções só mudam o menu, mensagens de tela, a confirmação antes de uma ação que já existia
e o status de erro de uma leitura de arquivo. Nenhuma rotina que grava dados operacionais ou
financeiros foi alterada (a remoção de foto chama a mesma rota de antes). Os fluxos financeiros e
operacionais da suíte E2E completa (cobrança, recebimento, mão de obra, fechamento com estorno,
conciliação, entrega direta e reversão) foram executados de novo — ver seção 4. A homologação não
foi tocada.

## 6. Nova versão candidata

| Item                          | Valor                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit (código implantável)   | **`696e3e9ddc5f1c803a4b9244a075ed498ad81be3`** (`claude/reformulacao-fase-4`)                                                                    |
| Imagem `api`                  | `us-east1-docker.pkg.dev/cenariogestao/cenario-homolog/api:696e3e9…` · `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f` |
| Imagem `web`                  | `…/web:696e3e9…` · `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72`                                                     |
| Build                         | Cloud Build `1bcb4c3d-…`, `SUCCESS`, conta `cenario-build`                                                                                       |
| Diferença para F′ `63674f1`   | 9 arquivos de aplicação (+161/−34); **nenhuma** mudança em `packages/db` (sem migration)                                                         |
| Commits posteriores na branch | só testes e documentos (`29dc333`, `4c10bbb` e este relatório) — não mudam a imagem                                                              |
| Retorno                       | F′ `63674f1` (ativa hoje) ou R2 `341badb` continuam compatíveis (mesmo esquema)                                                                  |

Também foi construído `f007753` (versão anterior à correção de lint): **não usar** — difere de
`696e3e9` só por uma linha (`let`→`const`), mas não passou no lint.

## 7. Pendências

- Sua decisão sobre o B2 (manter o item para todos, como a API, ou esconder — seção 1).
- Implantação em homologação da candidata: só com sua autorização (sem migration; retorno
  imediato para F′ `63674f1`, que segue ativa, ou para R2).
- Testes manuais (interface da instância, Safari, tablet físico) continuam pendentes.
