# 2026-11-17 — Dados de exemplo na Cenário Estofados (produção)

- **O quê:** a pedido do dono, foram criados dados de exemplo na empresa 1 (Cenário Estofados) do Cenário de produção, para ele ver o ambiente interativo (Firma Viva) com a oficina cheia. O dono escolheu gravar na conta real, sabendo que o exemplo fica junto dos dados reais.
- **Quando:** 2026-11-17, 04:06 UTC (01:06 em Brasília).
- **Como:** o dono rodou `bash infra/firma-viva/teste/firma-teste.sh exemplo` no Cloud Shell (branch `claude/project-thread-p5lymm-firma-viva`, 12371ef), que executa `infra/prod/dados-exemplo.cjs criar` no contêiner `api` da VM `cenario-prod`. Tudo foi feito numa transação, com o papel `cenario_app` e a trava por empresa.
- **Versão:** a do Cenário não mudou (aa1554b). Não houve migration nem troca de imagem.
- **Cópia de segurança antes:** `pg_dump -Fc` em `/var/tmp/cenario-antes-exemplo-20261117T040650Z.dump` (928K), na VM `cenario-prod`.
- **Criado, tudo com "[Exemplo]" no nome:**
  - 4 funcionários: Carla e Bruno (tapeceiros), Renata (cabeceiras e qualidade) e Joaquim (ajudante).
  - 6 clientes, cada um com endereço, pedido e OS aberta.
  - 12 tarefas de produção, entre concluídas, em execução, pausadas, liberadas e programadas.
  - Nenhum lançamento financeiro, porque o banco proíbe apagá-los.
- **Dados reais:** nenhum foi alterado.
- **Verificações:**
  - Antes, num banco com as migrations de aa1554b: o exemplo aparece no retrato do jogo (`/api/v1/game/snapshot`) e no painel (OS e clientes), e `remover` tira tudo.
  - Em produção, a saída do comando confirmou a empresa e as quantidades.
- **Indisponibilidade:** nenhuma.
- **Para desfazer:** `bash infra/firma-viva/teste/firma-teste.sh remover-exemplo`, que apaga só o que leva "[Exemplo]". Se o jogo tiver gravado registros permanentes numa OS de exemplo, a remoção recusa e nada é apagado.
