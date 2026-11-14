# Fase P (reinício, 14/11) — NO-GO N3, parada antes de qualquer escrita

| # | Operação | Início UTC | Resultado | Critério |
|---|---|---|---|---|
| 1 | `verificar` | 11:48:03 | ✔ canal OK | N1 |
| 2 | `version` | 11:48:16 | ✔ etiqueta, pilha, candidata e migrada = `7b4177b…`; scripts `c32df97ebf64` | N1 |
| 3 | `gate_status` | 11:48:22 | ✔ fechado | N1 |
| 4 | `health` | 11:48:28 | ✔ 5 contêineres; `/api/ready` 200 | N1 ✔ |
| 5 | `imagens 696e3e9…` | 11:48:34 | ✔ api `sha256:264884b3…cb4f` e web `sha256:cb76d474…ae72` presentes em `cenario-prod` | N2 ✔ |
| 6 | `vm_scripts_diff version=9ff142e274b1` | 11:48:35 | pacote íntegro (commit `9ff142e…`, 23 arquivos). Mudanças: Compose (volume `pgdata_2026_11`; `pgdata` preservado) ✔, `vm.sh` (correção/alerta do envio) ✔, `startup.sh` (envio sem portão) ✔, testes ✔, Caddy 0 ✔. **Mais 2 fora da lista: `infra/prod/gcp/provisionar.sh` e `infra/prod/gcp/ssh-agente.sh`, permissão 0o755 → 0o644** | **N3 ✘** |
| 7 | `gate_status` | 11:49:11 | fechado | — |

## Análise da divergência de N3 (fatos)

- O conteúdo dos dois arquivos é idêntico em `c32df97` e em `9ff142e`: mesmos blobs
  (`909b078c…` e `fdcfb086…`).
- O modo dos dois no git é `100644` nos dois commits. Os 0755 em `/opt/cenario` são um desvio local
  da VM, não uma mudança do commit do deploy.
- Nenhum chamador em `vm.sh` ou no runner executa esses arquivos na VM. O `provisionar.sh` roda no
  Cloud Shell.
- Mesmo assim, o critério N3 manda parar em qualquer mudança fora da lista, e a autorização diz
  "sem improvisar". Não executei `gate_open`, `prepare_version`, `backup_create` nem `gate_close`.

**Decisão necessária do dono:** aceitar explicitamente essa mudança de permissão como exceção a N3, e
então a fase P recomeça do início; ou corrigir o pacote ou a VM antes.

A produção está inalterada: `7b4177b`, portão fechado, banco e volumes intactos.
