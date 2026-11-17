# 2026-11-17 — Firma Viva: novo visual e jogabilidade no firmaviva.com.br

- **O quê:** publicação no firmaviva.com.br da aparência e jogabilidade novas do mapa (itens 45 a 69, PR #10). Só o front do jogo mudou: nenhuma migration, nenhuma mudança no Cenário Gestão de produção.
- **Quando:** 2026-11-17, por volta de 06:20 UTC (03:20 em Brasília).
- **Como:** o dono rodou no Cloud Shell `bash infra/firma-viva/teste/firma-teste.sh atualizar` na branch `claude/project-thread-6ob1t1` (740b9bd). A VM `firma-teste` reconstruiu as imagens e manteve o `.env` (ligação ao Cenário de produção).
- **Versão:** antes, a da branch `claude/project-thread-p5lymm-firma-viva` (12371ef/81d7b50, só documentação entre os dois); depois, 740b9bd. O código anterior ficou em `/opt/firma-teste/src.antigo`.
- **Verificações (de fora, 06:25 UTC):**
  - `https://firmaviva.com.br/api/health` → 200 `{"ok":true}`.
  - `/jogo` serve o pacote novo (contém o painel "Missões do dia" e o tutorial).
  - `/api/entrar/cenario` → 302 para `cenariogestao.com.br/autorizar` com `prompt=none` e os escopos `jogo operacao escritorio` (entrada direta pelo botão continua ligada à produção).
- **Aviso no fim do script:** o contêiner `api` (Cenário de TESTE dentro da VM, empresa fictícia) ficou reiniciando, então a etapa final `registrar_app` não rodou. Esse Cenário de teste não é usado enquanto o jogo está ligado à produção; fica como pendência investigar pelos logs (`docker compose ... logs api`).
- **Indisponibilidade:** a troca dos contêineres do jogo (alguns segundos).
- **Para voltar:** o mesmo comando com a branch `claude/project-thread-p5lymm-firma-viva`.
