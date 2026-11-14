# Fase P (3ª rodada, 14/11) — CONCLUÍDA: N1–N4 ✔, portão fechado

Autorização: o dono, diretamente nesta sessão. Inclui a exceção N3 só para a permissão
0755 → 0644 de `provisionar.sh` e `ssh-agente.sh`.

| # | Operação | Início UTC | Resultado |
|---|---|---|---|
| 1 | `verificar` | 17:08:40 | ✔ canal OK |
| 2 | `version` | 17:08:53 | ✔ etiqueta, pilha, candidata e migrada = `7b4177b…`; scripts `c32df97ebf64` |
| 3 | `gate_status` | 17:08:56 | ✔ fechado |
| 4 | `health` | 17:08:59 | ✔ 5 contêineres; `/api/ready` 200 → **N1 ✔** |
| 5 | `disk_status` | 17:09:05 | 34 GB livres (29%) |
| 6 | `imagens 696e3e9…` | 17:09:11 | ✔ api `sha256:264884b3…cb4f` e web `sha256:cb76d474…ae72` em `cenario-prod` → **N2 ✔** |
| 7 | `vm_scripts_diff version=9ff142e274b1` | 17:09:13 | pacote íntegro (23 arquivos); só mudanças da lista + a exceção aprovada → **N3 ✔ (com exceção)** |
| 8 | `gate_open` | 17:09:59 | ✔ |
| 9 | `prepare_version 696e3e9…` | 17:10:05 | ✔ api e web com os digests aprovados (3815 e 3814 MB); "a imagem nova NÃO migra na partida"; migrations: 37 na imagem, 33 no banco; disco livre 32 GB; nada reiniciado; banco intocado → **N4 (preparo) ✔** |
| 10 | `backup_create` | 17:11:31 | ✔ `cenario-production-20261114T171135Z`; envio: `cenario-production-20261114T164142Z` e `…T171135Z` "enviado a gs://cenariogestao-prod-backups/backups/", sem erro → **N4 (envio) ✔** |
| 11 | `gate_close` | 17:11:40 | ✔ |
| 12 | `gate_status` | 17:11:46 | ✔ **fechado** |
| 13 | `backup_validate folder=cenario-production-20261114T171135Z` | 17:12:04 | ✔ SHA256SUMS conferido |
| 14 | `health` | 17:12:08 | ✔ 5 contêineres; `/api/ready` 200 |
| 15 | `version` | 17:12:11 | etiqueta, pilha e migrada = `7b4177b`; **candidata = `696e3e9`**; scripts `c32df97ebf64` |

## Exceção N3: as 3 condições, conferidas pelo runner

1. **Conteúdo idêntico.** O `vm_scripts_diff` (runner 2.2.0) só imprime `~ permissão` no ramo em que
   os bytes do arquivo da VM e do pacote são iguais (`atual_b == dados`).
2. **Não executados pelos serviços da VM.** No pacote validado pelo `pacote_scripts` do runner
   (sha256 `c8c293b1…028cdc`), os dois nomes só aparecem em comentários: `promover-imagens.sh:4` e
   `startup.sh:3`. As unidades systemd chamam só o `vm.sh`.
3. **`vm.sh` e `startup.sh` continuam executáveis.** O modo no pacote é `0o755` para os dois, e o
   `vm_scripts_update` grava cada arquivo com o modo do pacote.

## Observações

- Bucket: só 2 pastas foram enviadas porque as demais já constavam como enviadas no registro local
  (`enviados`), conforme o envio que o dono informou. Confirmação do bucket: HTTP 200 por objeto,
  registrado na saída do `vm.sh`. A conta do operador não lista o bucket (403).
- Produção em `7b4177b`, servindo normalmente. Nenhum volume, backup ou dado apagado. `/conheca`
  não foi tocada. Os scripts da VM não foram atualizados (o `vm_scripts_update` é da fase J).
- A fase J **não** foi iniciada.
