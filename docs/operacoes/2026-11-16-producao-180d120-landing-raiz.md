# 16/11/2026 — Produção: deploy de `180d120` (botão Entrar na landing e raiz "/" com a landing)

- **Pedido e aprovação:** dono ("pode publicar", 18:27 UTC).
- **Executado por:** Claude, ambiente "Cenário — Produção" (operador `claude-operador-prod`).
- **Homologação:** `docs/operacoes/2026-11-16-homologacao-180d120.md` (branch da linha de produção, 5873917);
  build `788bba20-ccad-4f7f-b857-be5a8e6d5e44`.
- **Imagens:** promovidas pelo dono no Cloud Shell. `promover-imagens.sh` (gcloud add-tag) caiu duas vezes
  com `SSLError UNEXPECTED_EOF` no envio da api; a cópia foi feita com `crane copy` por digest e
  conferida pelo próprio `promover-imagens.sh`. Em `cenario-prod`: api
  `sha256:83cfef30ce59f5d11da6c48e9b9478f907442d02e3149be55bc4659304791c28`, web
  `sha256:67159f66a912a00b65297bb93a9d14a240d886ae06be0e0c091f3ee330bfa44a` (iguais às homologadas).
- **Versão:** `0a2546f33f9b568e89899b69f39080d655c2084d` → `180d12064ba1e1eb37f87a7efec07e8e85767977`.
- **Scripts da VM:** `830c83b3555c` → `180d12064ba1` (Caddyfile: "/" fora do noindex; provisionar.sh e
  autonomia da promoção, que não rodam na VM). Volume do banco continua `pgdata_2026_11`.
- **Banco:** nenhuma migration (38/38).
- **Ponto de recuperação:** `cenario-production-20261116T200603Z` (versão `0a2546f`, impressão
  `bc569e0279d1fcbb9a2a5d13c405587a`): restauração de teste IDÊNTICA, no bucket, SHA256SUMS conferido.

| Hora (UTC) | Operação                                    | Resultado                                                  |
| ---------- | ------------------------------------------- | ---------------------------------------------------------- |
| 20:02      | vm_scripts_diff 180d12064ba1                | pacote íntegro                                             |
| 20:03      | version, gate_open, prepare_version         | digests conferidos na VM; não migra na partida             |
| 20:05      | migration_precheck                          | 0 pendentes; OK                                            |
| 20:05:52   | maintenance_on                              | API e web paradas                                          |
| 20:06:03   | recovery_point_create, backup_validate      | IDÊNTICA; SHA256SUMS conferido                             |
| 20:06:53   | vm_scripts_update 180d12064ba1              | 6 arquivos; cópia anterior guardada                        |
| 20:06:57   | activate_version                            | recusado: exige `migrate` da versão (mesmo sem pendentes)  |
| 20:07:13   | migrate, migration_verify                   | nada aplicado (banco idêntico ao ponto); registra a versão |
| 20:07:37   | activate_version                            | contêineres saudáveis; Saúde OK                            |
| 20:08:14   | apply_stack_config                          | proxy com o Caddyfile novo; Saúde OK                       |
| 20:08:34   | gate_close, smoke, websocket, testes acesso | fechado; todos OK; logs sem erros                          |

- **Indisponibilidade:** ≈2 min (20:05:52 → ~20:08:00).
- **Conferido de fora:** `/` 200, sem `X-Robots-Tag`, `<meta robots index, follow>`, landing com o
  botão Entrar (clicado no desktop e no celular → `/entrar`); `/conheca` e `/site/*` 200 indexáveis;
  `/entrar` e `/painel` com `noindex, nofollow`.
- **Lições:** o runbook precisa de `migrate` antes de `activate_version` mesmo sem migrations; a promoção
  pelo Cloud Shell pode falhar por rede: usar `crane copy` por digest e repetir `promover-imagens.sh`.
