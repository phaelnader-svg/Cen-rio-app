# Fase J — CONCLUÍDA (14/11/2026): N5–N9 ✔, portão fechado, produção em 696e3e9

Pré-requisitos:

- Portão fechado (17:17:07Z) ✔.
- Backup final `cenario-production-20261114T171135Z` no bucket: comprovado **pelo dono no Cloud
  Shell** (1.116.160 bytes, 17:11:36Z, SHA256SUMS OK). A conta do operador recebe 403 na leitura do
  bucket.

| # | Operação | Início UTC | Resultado | Critério |
|---|---|---|---|---|
| 1 | `gate_open` | 17:21:26 | ✔ | — |
| 2 | `maintenance_on` | 17:21:30 | ✔ API e web paradas às 17:21:33Z; o proxy responde 503 "em manutenção" | — |
| 3 | `vm_scripts_update version=9ff142e274b1` | 17:21:36 | ✔ Caddyfile válido; cópia anterior em `/opt/cenario.anterior-20261114T172138Z-9885b50a`; 21 arquivos atualizados; nada reiniciado | — |
| 4 | `stack_bootstrap version=696e3e9…` | 17:21:48 | ✔ "banco NOVO (nenhuma tabela): PostgreSQL e backup em execução; API e web paradas" | **N5 ✔** |
| 5 | `recovery_point_create` | 17:22:13 | ✔ ponto `cenario-production-20261114T172215Z` (versão 696e3e9, impressão `35f222cc…`); restauração de teste **IDÊNTICA**; enviado ao bucket | **N6 ✔** |
| 6 | `migration_precheck version=696e3e9…` | 17:22:28 | ✔ 37 pendentes, 37 "esquema compatível"; "PREFLIGHT: OK" (nenhuma incompleta, desconhecida, divergente ou fora de ordem) | **N7 ✔** |
| 7 | `migrate version=696e3e9…` | 17:22:42 | ✔ "All migrations have been successfully applied" em 14 s | — |
| 8 | `migration_status` (leitura) | 17:23:17 | ✔ 37 aplicadas, 0 incompletas ou revertidas | **N7 ✔** |
| 9 | `activate_version version=696e3e9…` | 17:23:26 | ✔ "Saúde: OK", com 26 checagens ✔ (APP_ENV=production, HTTPS, 401 sem sessão, WebSocket, certificado até 17/01/2027, último backup e envio há 0 h, 37 migrations, disco 34%, memória 2770 MB) | **N8 ✔** |
| 10 | `seed_bootstrap` | 17:23:52 | ✔ funcionários 1, usuários 1, clientes 0, pedidos 0, OS 0, dispositivos 0, funções 5, modelos 5, checklists 4; "bootstrap mínimo: só o gestor" | **N9 ✔** |
| 11 | `gate_close` | 17:24:10 | ✔ | — |
| 12 | `gate_status` | 17:24:14 | ✔ **fechado** | — |
| 13 | `version` (leitura) | 17:24:17 | scripts `9ff142e274b1`; etiqueta, pilha, candidata e migrada = `696e3e9…` | — |
| 14 | `health` (leitura) | 17:24:21 | ✔ 5 contêineres; `/api/ready` 200 | — |
| 15 | `disk_status` (leitura) | 17:24:24 | `/` 34% (32 GB livres); **6 volumes locais, 5 em uso** (antes: 5/5). O inativo, de 75,64 MB, corresponde ao `pgdata` antigo preservado | — |

## Indisponibilidade

De 17:21:33Z (API e web paradas) até ~17:23:43Z (`activate_version` concluído): **cerca de 2 min 10 s**,
dentro da janela estimada de 5 a 8 min.

## Preservação

- Nenhum volume apagado. O total passou de 5 para 6: o `pgdata_2026_11` é o novo, e o `pgdata`
  antigo está inativo e preservado.
- Nenhum backup apagado. Backups novos desta fase: `cenario-production-20261114T172215Z` (ponto de
  recuperação), enviado ao bucket.
- Scripts anteriores guardados em `/opt/cenario.anterior-20261114T172138Z-9885b50a`, para o retorno.
- Só imagens e scripts aprovados. `/conheca` não foi tocada; o Caddy validou a configuração e
  `Caddy: 0 mudança(s)` no diff.
- Nenhum retorno foi necessário.

## Ressalva para a fase V (N10)

O `disk_status` deste runner mostra só o resumo do `docker system df` (contagem de volumes), não os
nomes. O critério N10 ("`disk_status` lista `cenario-prod_pgdata`") não é comprovável por nome com
essa operação. Evidência indireta: 6 volumes, 1 inativo, com 75,64 MB recuperáveis.
