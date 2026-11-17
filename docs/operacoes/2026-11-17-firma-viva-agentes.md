# 2026-11-17 — Firma Viva: agentes do escritório com WhatsApp (PR #9 + visual #10)

- **O quê:** publicação no firmaviva.com.br dos agentes do escritório (Compras com fornecedores e pedido pelo
  WhatsApp, Financeiro, Orçamentos, WhatsApp/Atendimento, personalizados), marcação de material
  comprado/chegou na OS, meta no primeiro acesso e atualização por aviso de mudança (`/api/sync/events?wait=25`).
  Sem migration no jogo. Depende do Cenário de produção 6d8e445 (no ar desde 07:36 UTC), que traz as rotas novas.
- **Quando:** 2026-11-17, ~08:40 UTC (05:40 em Brasília).
- **Como:** o dono rodou no Cloud Shell `bash infra/firma-viva/teste/firma-teste.sh atualizar` na branch
  `claude/project-thread-gtnq4w-fv-publicar` (e170084 = PR #9 + `claude/project-thread-6ob1t1` 738febb).
- **Versão:** antes acd5444 (visual com ícones); depois e170084.
- **Verificações (de fora, ~08:45 UTC):**
  - `/api/health` → 200 `{"ok":true}`.
  - `/jogo` → 200; o pacote contém "Aprovar e abrir WhatsApp", `game/suppliers`, "Marcar comprado" e o
    `&wait=25` da consulta longa.
  - `/api/sync/events?wait=1` e `/api/v1/game/suppliers` pelo jogo → 401 sem sessão (rotas existem; antes seria 404).
  - `/api/entrar/cenario` → 302 para `cenariogestao.com.br/autorizar` (entrada direta continua ligada à produção).
  - Não conferido: o fluxo logado dos agentes (exige a conta do dono).
- **Indisponibilidade:** troca dos contêineres do jogo (segundos).
- **Para voltar:** o mesmo comando na branch `claude/project-thread-6ob1t1`.
- **Próxima:** `claude/project-thread-qgvf18` já contém esta versão (conferido), então publicar por cima não tira os agentes.
