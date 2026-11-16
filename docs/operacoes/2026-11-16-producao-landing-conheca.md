# 16/11/2026 — Produção: ligar a página comercial /conheca

- **Pedido e aprovação:** dono ("publique a landing page em produção"), 16/11/2026 17:44 UTC.
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **O que mudou:** só a configuração da VM (`/opt/cenario`), pacote `scripts-830c83b3555c`
  publicado pelo dono no bucket de versões. Commit `830c83b` = `9ff142e` (scripts que estavam na VM)
  - `SITE_COMERCIAL: '1'` no serviço web + `X-Robots-Tag noindex` em tudo exceto `/conheca` e `/site/*`.
    Mesmo conteúdo de `16d17f4`, mas sobre `9ff142e` para manter o volume `pgdata_2026_11`.
- **Por que não a branch da linha de produção:** `claude/autorizacao-apps-9fb6b03` não contém `9ff142e`;
  o compose dela aponta o Postgres para o volume antigo `pgdata` (dados até 13/11). Um pacote gerado dela
  subiria a produção no banco errado.
- **Versão da aplicação:** `0a2546f33f9b568e89899b69f39080d655c2084d` antes e depois (mesmas imagens).
- **Scripts da VM:** `9ff142e274b1` → `830c83b3555c` (2 arquivos; `vm_scripts_diff` conferido antes).
- **Banco:** nenhuma migration; nada alterado.
- **Ponto de recuperação:** `cenario-production-20261116T175604Z` (versão `0a2546f`, impressão
  `2b9d6d624d76a61f9b42b6c4bef0b468`): restauração de teste IDÊNTICA, enviado ao bucket, SHA256SUMS
  conferido. Retorno da configuração: `vm_scripts_restore` + `apply_stack_config`.

| Hora (UTC) | Operação                       | Resultado                                                                |
| ---------- | ------------------------------ | ------------------------------------------------------------------------ |
| 17:45      | gate_status, version           | portão fechado; ativa `0a2546f`; `/opt/cenario` em `9ff142e274b1`        |
| 17:55:32   | vm_scripts_diff 830c83b3555c   | pacote íntegro; só Compose e Caddyfile mudam                             |
| 17:55:53   | gate_open                      | aberto                                                                   |
| 17:55:56   | maintenance_on                 | API e web paradas                                                        |
| 17:56:04   | recovery_point_create          | `cenario-production-20261116T175604Z`, IDÊNTICA, no bucket               |
| 17:56:38   | backup_validate                | SHA256SUMS conferido                                                     |
| 17:56:41   | vm_scripts_update 830c83b3555c | validado (bash -n, compose config, caddy validate); 2 arquivos trocados  |
| 17:56:55   | apply_stack_config             | proxy recriado; parou na saúde (API/web ainda em manutenção), sem ativar |
| 17:57:20   | maintenance_off                | API e web recriadas com a configuração nova; Saúde OK                    |
| 17:57:50   | gate_close, health, smoke_test | fechado; OK                                                              |

- **Indisponibilidade:** ≈1 min 41 s (17:55:56 → 17:57:37).
- **Ocorrência:** `apply_stack_config` roda a saúde ao fim do `aplicar-config`; com a pilha em manutenção
  ela falha e a reativação não acontece. Na próxima vez: `apply_stack_config` antes de `maintenance_on`,
  ou terminar com `maintenance_off` (que é o `vm.sh ativar` da versão ativa), como foi feito.
- **Conferido de fora:** `/conheca` 200, sem `X-Robots-Tag`, `<meta robots index, follow>`, preço
  R$ 399,00 / anual R$ 339,15 por mês (R$ 4.069,80), WhatsApp 5512996520615, as 4 imagens `/site/*.webp`
  200 (desktop 1440 e celular 390, 0 erros no console). `/entrar`, `/painel` e `/` continuam com
  `noindex, nofollow`.
