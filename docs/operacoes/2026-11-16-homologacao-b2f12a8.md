# 16/11/2026 — Homologação de `b2f12a8` (agenda de Retiradas, PR #5)

Pedido do dono. Somente homologação (`teste.cenariogestao.com.br`, operador `claude-operador`).
Produção não tocada.

- Commit: `b2f12a84a0550491299861e4a3198e23bdd47887` (branch `claude/project-thread-p3v2jt`), sobre `5873917` (linha de produção, contém `0a2546f`).
- Versão antes: `180d12064ba1e1eb37f87a7efec07e8e85767977` · depois: `b2f12a84a0550491299861e4a3198e23bdd47887` (etiqueta, pilha e migrada).
- Build `41d965d8-74a6-4d70-8b9a-92ff0b9074db`: SUCCESS (20:06:03 → 20:11:32 UTC).
- Digests (conferidos na VM pelo `prepare_version`):
  - api `sha256:e4290400884c0f68790729758efbfa6af6f16f025888a1b441809b170c5c5e86`
  - web `sha256:50a77f0f4b042fe5c9ec2a1c65d1750d1b69a6aa2d39496bae9bf687856fc44a`
- Migration: `20270406000000_retirada_mostruario_maquininha`, aditiva (3 colunas novas em `pickup_requests`, com padrão). Reversão: `packages/db/rollback/20270406000000_retirada_mostruario_maquininha.down.sql`.
- Ponto de recuperação: `cenario-staging-20261116T201331Z` (versão `180d120`, impressão `d9b187c862dea30e3ba681a798b2151d`). Restauração de teste IDÊNTICA, cópia enviada ao bucket; `backup_validate`: SHA256SUMS conferido.

| Hora (UTC) | Operação | Resultado |
| --- | --- | --- |
| 20:05 | verificar, version, health, gate_status, disk_status | canal OK; ativa `180d120`; saudável; portão fechado; disco 59% |
| 20:05–20:11 | imagens (ausentes) → build-iniciar / build-acompanhar | SUCCESS |
| 20:11:45 | gate_open | aberto |
| 20:11:49 | prepare_version | OK; digests acima; imagem: 39 migrations, banco: 38 |
| 20:13:05 | migration_precheck | exatamente 1 pendente: `20270406000000_retirada_mostruario_maquininha`; esquema compatível |
| 20:13 | database_fingerprint (antes) | registrada |
| 20:13:22 | maintenance_on | API e web paradas (20:13:25) |
| 20:13:28 | recovery_point_create | `cenario-staging-20261116T201331Z` |
| 20:14:38 | backup_validate | SHA256SUMS conferido |
| 20:14:44 | migrate | 1 aplicada em 12 s |
| 20:15:07 | migration_verify | 39/39, nenhuma pendente |
| 20:15:14 | activate_version | Saúde OK (disco 67%, memória 1069 MB) |
| 20:16:29 | gate_close | fechado |
| 20:16+ | version, smoke_test, websocket_test, run_homologation_tests `completo`, database_fingerprint, logs | todos OK; WebSocket 401 sem sessão (esperado); suítes saude, acesso e websocket ✔; api e web com 0 respostas 5xx e 0 erros |

Impressão digital antes/depois: só `pickup_requests` ganhou as 3 colunas (`bring_samples`,
`samples_description`, `bring_card_machine`) e os 2 padrões `false`, com as mesmas 3 linhas.
Fora isso, apenas o registro de migrations passou de 38 para 39. Nenhuma outra tabela mudou.

Indisponibilidade: cerca de 3 min (20:13:25 → 20:16:25).

Não verificado por mim: as telas de `/painel/retiradas` com login, que ficam para o teste do dono.

Retorno, se necessário: `rollback_to_recovery_point` (volta banco e versão para `180d120`).
