# Fase P — NO-GO (N2), parada antes de qualquer escrita

| # | Operação | Início UTC | Resultado |
|---|---|---|---|
| 1 | `verificar` | 22:49:21 | ✔ canal OK; `7b4177b` (etiqueta/candidata/migrada); scripts `c32df97ebf64`; portão fechado |
| 2 | `imagens 696e3e9…` | 22:49:28 | ✘ **api e web ausentes em `cenario-prod`** → **NO-GO N2** |
| 3 | `vm_scripts_diff version=9ff142e274b1` | 22:49:30 | ✘ `gs://cenariogestao-prod-runner-versoes/scripts-9ff142e274b1.tar.gz: HTTP 404` (pacote não publicado) |
| 4 | `gate_status` | após a parada | portão **fechado** |

- Não executados: `gate_open`, `prepare_version`, `backup_create`, `gate_close`. O portão nunca foi
  aberto, então não houve `gate_close`.
- Nada mudou na produção: continua em `7b4177b`, com o banco e os volumes intactos.
- Causa: os dois passos da seção 6.1 do checklist, que o dono executa no Cloud Shell, ainda não
  aparecem:
  - (A) a promoção das imagens por digest;
  - (B) a publicação do pacote de scripts `scripts-9ff142e274b1`.
