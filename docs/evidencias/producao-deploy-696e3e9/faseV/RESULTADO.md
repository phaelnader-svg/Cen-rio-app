# Fase V — validação (somente leitura), 14/11/2026: N10 ✔

| # | Operação | Início UTC | Resultado |
|---|---|---|---|
| 1 | `gate_status` | 17:28:02 | fechado ✔ |
| 2 | `version` | 17:28:06 | etiqueta, pilha, candidata e migrada = `696e3e9…`; scripts `9ff142e274b1` ✔ |
| 3 | `smoke_test` | 17:28:09 | **Saúde: OK**, 27 ✔ e 0 ✘ (HTTPS, APP_ENV=production, redirecionamentos, HSTS, 401 sem sessão, WebSocket, certificado até 17/01/2027, backup e envio externo em dia, 37 migrations, disco, memória) |
| 4 | `websocket_test` | 17:28:16 | ✔ 401 sem sessão (esperado) |
| 5 | `run_homologation_tests suite=completo` | 17:28:19 | ✔ suíte saude, ✔ suíte acesso ("Acesso: OK"), ✔ suíte websocket; 0 ✘ |
| 6 | `migration_status version=696e3e9…` | 17:28:28 | 37 aplicadas, 37 na imagem; nenhuma pendente, desconhecida ou incompleta ✔ |
| 7 | `database_counts` | 17:28:34 | `_prisma_migrations` 37, `users` 1, `employees` 1, `roles` 5, `role_permissions` 81, `customers` 0, `service_orders` 0 ✔ |
| 8 | `disk_status` | 17:28:37 | `/` 34% (32 GB livres); **6 volumes, 5 em uso, 75,64 MB recuperáveis** (o inativo = `pgdata` antigo); `/data/backups` 25 MB |
| 9 | `health` | 17:28:43 | ✔ 5 contêineres; `/api/ready` 200 |
| 10 | `containers_status` | 17:28:47 | ✔ todos em execução |
| 11 | `resources` | 17:28:50 | memória disponível 2798 MB; swap 34 MB; carga 0,16 |
| 12 | `backup_list` | 17:28:56 | 31 pastas locais (todas preservadas); a mais recente é o ponto de recuperação `…20261114T172215Z` |
| 13 | `images_cleanup_plan` (só o plano) | 17:28:59 | protegidas: `696e3e9` (ativa) e `7b4177b` (retorno). O plano marca `9fb1786` como candidata: **nada removido**, e a limpeza não foi executada |
| 14 | `container_logs service=api` (60 min) | 17:29:05 | 139 linhas desde a ativação (17:23:37 → 17:28:44): **0 respostas 5xx, 0 entradas de nível ≥ 50**; 2xx 19, 4xx 64 (os 401 esperados dos testes sem sessão) |

## N10

Nenhum ✘ no smoke nem na suíte completa, 0 respostas 5xx → ✔.

O volume antigo **não pode ser confirmado pelo nome**: nenhuma operação do catálogo lista nomes de
volumes Docker. O `disk_status` traz só o resumo do `docker system df`. Evidência indireta, aceita
provisoriamente pelo dono: 6 volumes, 1 inativo (75,64 MB). Confirmação por nome no Cloud Shell
(SSH, só leitura): `sudo docker volume ls --filter name=pgdata`.

## Conta do administrador

Ver `../conta-gestor/RESULTADO.md`.

- O gestor criado pelo `seed_bootstrap` usa o e-mail informado pelo dono (comparação sem exibir o valor).
- Papel **Gestor**, com o catálogo completo de permissões.
- `sessions` 0: o primeiro acesso ainda não aconteceu.

## Situação

Fases P, J e V concluídas sem nenhum critério de parada. Portão fechado.

Para o **GO final** do checklist ("o gestor entra e o volume antigo está listado"), faltam duas
confirmações do dono:

1. o primeiro login;
2. o nome do volume antigo (opcional; a evidência indireta foi aceita).
