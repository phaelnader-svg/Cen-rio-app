# Homologação — eliminação das ressalvas P1, P2 e P3

Data: 2026-10-15 (UTC). Ambiente: homologação `cenario-homolog` (projeto `cenariogestao`). Produção fora do escopo e
não tocada. Aplicação inalterada: `406fde70d88396e874cc6194960523d0dee02fd5` (nenhum arquivo de `apps/`, `packages/`
ou dos scripts de backup mudou). Executado pela autonomia (claude-operador, operações nomeadas do runner); a única
ação humana foi a publicação no bucket de versões (`bootstrap.sh publicar-runner`), feita duas vezes (ver §12).

## 1. Commits

| Commit    | Conteúdo                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------- |
| `347068e` | P3 — pré-verificação da cadeia de migrations (vm.sh, SQL fixo, verificador, testes com PG real) |
| `96eb243` | P1 + P2 — runner 2.1.0 (limpeza de imagens; scripts da VM só de pacote publicado), bootstrap    |
| `5c3f6ad` | runner 2.1.1 — validação dos scripts fora do `/tmp` privado do serviço (falha encontrada na VM) |

## 2. Versão do runner

`2.0.0` → `2.1.0` (pacote SHA-256 `97bc8d4f…`) → **`2.1.1`** (pacote SHA-256 `788a6d97…`), instaladas por
`update_runner` a partir do bucket de versões (gravação só humana).

## 3. Arquivos alterados

- Runner/autonomia: `autonomia/runner/cenario_runner.py`, `runner/VERSAO`, `autonomia/bootstrap.sh`,
  `autonomia/testes/test_runner.py`, `autonomia/testes/test_bootstrap.sh`.
- Scripts da VM: `gcp/vm.sh` (preflight e migrar), `gcp/preflight_migracoes.py` (novo),
  `gcp/sql/preflight-{estado,catalogo,migracoes}.sql` (novos), `gcp/testes/test_preflight.py` (novo).
- Documentação: `docs/HOMOLOGACAO-AUTONOMIA-OPERACOES.md`, este relatório.

## 4. Implementação do P1

Operações `images_cleanup_plan` (READ_ONLY: inventário e decisão, nada removido) e `images_cleanup` (MUTATING).

- Considera só imagens do repositório da aplicação (`…/cenario-homolog/api|web`) com etiqueta SHA.
- Protege:
  - a versão ativa e a do ambiente da pilha;
  - a candidata e a migrada;
  - a versão do ponto de recuperação;
  - a ativada antes da atual (histórico do runner);
  - a versão mais recente além da ativa, por ID distinto (apelidos da ativa não contam);
  - toda versão com qualquer imagem usada por contêiner, mesmo parado;
  - qualquer etiqueta com o mesmo ID de imagem protegida.
- Remove com `docker image rm <repo>:<sha>` **sem `--force`**. Nunca usa `prune`, nunca toca em volumes, contêineres,
  banco, backups, nem em imagens de terceiros (postgres, caddy).
- Se a versão ativa for desconhecida, nada é removido.
- Informa espaço antes e depois e cada etiqueta e ID removidos. É idempotente.
- Os candidatos vêm do estado da VM (nenhum SHA fixo no código).
- Os testes encontraram um defeito antes da publicação: um apelido da ativa era tomado como "versão anterior" e
  deixava a anterior real desprotegida. Corrigido e coberto por teste.

## 5. Imagens removidas

| Imagem        | ID                                                                        |
| ------------- | ------------------------------------------------------------------------- |
| `web:4f9b1ae` | `sha256:b7146ee849a8d53889ca3035870adbdbdecfafe13c4c15ce15f96b2983253b0b` |
| `api:4f9b1ae` | `sha256:a9650761f0e5dbe72df0489824424d1f1802d5f72b6185a6a7ea8b39ca6785fb` |
| `web:fd6dc19` | `sha256:ef746771e219d714e47c4d2deee636fae43634b72eeae578cc5ecc0efa6d30b9` |
| `api:fd6dc19` | `sha256:37dea1370d122258b80663192eddada5ffd3563f8feef66a158eb12083e394ba` |

Mantidas:

- `406fde7` (ativa);
- `eb3fe2a` (ponto de recuperação e rollback);
- `postgres:16`, `postgres:16-alpine` e `caddy:2.10-alpine`.

O digest de registro não aparece no `docker image ls` sem `--digests`; a identificação é pelo ID. Uma segunda execução
reportou "nada a remover".

## 6. Espaço antes/depois

| Medida                              | Antes         | Depois      |
| ----------------------------------- | ------------- | ----------- |
| Livre em `/` (runner)               | 3,59 GiB      | 7,29 GiB    |
| Uso do disco `/`                    | 81 %          | 61 %        |
| Imagens Docker (`docker system df`) | 11 · 11,04 GB | 7 · 7,07 GB |

O ganho foi de **3,70 GiB**. A margem agora comporta a próxima versão (~2,2 GB) acima do mínimo de 3 GB do
`preparar-versao`.

## 7. Diff e atualização do P2

`vm_scripts_diff` (lido na VM, `/opt/cenario` `9f2930028b2b` → pacote) foi idêntico nas duas publicações nos
arquivos de execução.

- **Caddy** (`Caddyfile.homolog`): `header_up X-Forwarded-For {remote_host}`, remove `X-Real-IP` e `Forwarded`
  recebidos do cliente (C3, `a8044e9`).
- **Compose:**
  - `TRUST_PROXY: 172.28.0.0/24` → `172.28.0.250`;
  - Caddy com `ipv4_address: 172.28.0.250` na rede `interna` (C3).
- **vm.sh:** só o P3 (`preflight [etiqueta]` e `migrar` usando-o; o despacho passa a etiqueta).
- **Auxiliares:**
  - `auditoria-pre-deploy.sh`, `homolog.sh` e `operador.sh` (Cloud Shell; SSH sem passphrase);
  - novos `ssh-agente.sh`, `preflight_migracoes.py` e `sql/preflight-*.sql`;
  - `conferencia-restauracao.sh` e `vm-inspecao.sh` passam de 0755 para 0644 (o primeiro é carregado por `source`; o
    segundo é enviado por `bash -s` do Cloud Shell; sem efeito).
- **Autonomia, testes e documentação:** arquivos novos que não são executados a partir de `/opt/cenario`.
- **Só na VM:** nenhum arquivo. Nenhuma mudança funcional inesperada.

**Primeira tentativa** (pacote `96eb24397338`, runner 2.1.0): parou **na validação, antes de trocar qualquer
arquivo**.

- O serviço do runner usa `PrivateTmp=true`, e o daemon do Docker não enxergava o Caddyfile montado a partir do
  `/tmp` privado.
- `/opt/cenario` continuou em `9f2930028b2b`.
- Corrigido no runner 2.1.1: validação no diretório de estado do runner. Coberto por teste.

**Aplicação** (pacote `5c3f6adbcdf3`, runner 2.1.1):

1. `vm_scripts_update`: SHA-256 e commit conferidos; `bash -n` no vm.sh, `compose config -q` e `caddy validate`
   (sem rede) OK. Cópia anterior guardada; 46 arquivos gravados (conteúdo ou permissão); nenhum arquivo local
   apagado; nada reiniciado.
2. `gate_open`.
3. `apply_stack_config`: `vm.sh aplicar-config` recriou só o Caddy, com Saúde OK. `vm.sh ativar 406fde7` recriou só a
   API, com Saúde OK. Web, postgres e backup ficaram intactos.
4. `gate_close`.

Reversão disponível: `vm_scripts_restore` + `apply_stack_config`.

## 8. Resultado do TRUST_PROXY

- Compose aplicado com `TRUST_PROXY: 172.28.0.250` e o Caddy nesse IP fixo; API recriada com a variável nova.
- O aviso `TRUST_PROXY confia numa FAIXA inteira (172.28.0.0/24)` aparecia na partida anterior da API. Depois da
  recriação, os logs da API **não têm nenhuma** linha `warn` ou `error` (27 linhas, todas `info`).
- A API resolve o IP do cliente pelo cabeçalho do Caddy confiável: requisições pelo proxy aparecem com o IP de
  origem da conexão do Caddy (`172.28.0.1`, o host), e as checagens internas com `127.0.0.1`.

## 9. Implementação do P3

`vm.sh preflight <etiqueta>` (operação `migration_precheck version=…`; sem versão, usa a candidata). Lê as
migrations **da imagem** (`docker run --entrypoint tar`, sem iniciar a aplicação). Do banco, só:

- o estado de `_prisma_migrations`;
- o catálogo do esquema;
- verificações de dados.

Todas são consultas fixas em `sql/preflight-*.sql`, em transações somente leitura.

O `preflight_migracoes.py` compara, sem executar SQL, e bloqueia quando encontra:

- migration incompleta, ou registrada duas vezes como concluída;
- migration desconhecida (no banco e ausente da imagem);
- conteúdo divergente (checksum do Prisma = SHA-256 do `migration.sql`, conferido nas 25);
- ordem divergente;
- esquema incompatível: DDL das pendentes simulado em ordem sobre o catálogo (objeto que já existe; tabela, coluna,
  índice ou restrição ausente; tabela referenciada ausente; rótulo de enum);
- dados que fariam migrations conhecidas falharem (Evolução e Simplificação), só para as pendentes.

`vm.sh migrar` passa a exigir essa pré-verificação.

**Na VM:** `migration_precheck version=406fde7` → `imagem 406fde7: 25 migrations · banco: 25 aplicadas (25
registros) · pendentes (0)` → **PREFLIGHT: OK**. Os checksums das 25 migrations aplicadas no banco real conferem com
a imagem.

## 10. Testes

| Suíte                                                                  | Resultado                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gcp/testes/test_preflight.py` (PostgreSQL 16 real)                    | 17 OK: cadeia 0→25 sem falso positivo até `20261230000000_modelos_simplificados`, estado 18+7, banco do Prisma real, 12 bloqueios                                                                                       |
| `autonomia/testes/test_runner.py`                                      | 55 OK (inclui P1: protegidas, apelido da ativa, contêiner parado, idempotência, recusas; P2: pacote real do git, SHA, outro commit, caminhos/links, Caddyfile inválido, restauração, pasta de validação fora do `/tmp`) |
| `autonomia/testes/test_bootstrap.sh`                                   | todos OK (publicação do runner e dos scripts, idempotente; árvore suja recusada)                                                                                                                                        |
| `gcp/testes/test_vm_sh.sh`, `test_homolog_sh.sh`, `test_ssh_agente.sh` | todos OK                                                                                                                                                                                                                |
| `prettier --check .`, `conferir-contexto.sh`                           | OK                                                                                                                                                                                                                      |

## 11. Análise de segurança

- Nenhum parâmetro novo aceita texto livre. Só `version` (SHA 7–40) ou nenhum. Não há shell, SQL nem caminho vindo
  do cliente; a análise estática garante a ausência de `prune`, `--force`, `rmi` e `volume`.
- **Scripts da VM** (código que roda como root):
  - só são instalados a partir do bucket de versões, que o claude-operador **não grava**;
  - conferência de SHA-256, de que o pacote é o `git archive` do commit pedido (comentário pax) e de caminhos por
    allowlist (`infra/homolog/…`, `scripts/{backup,restore}.sh`), sem `.`/`..`, sem caminho absoluto, sem links ou
    arquivos especiais, com tamanho limitado e arquivos obrigatórios presentes;
  - validação antes de trocar qualquer arquivo; cópia anterior guardada.
- O Caddyfile é validado sem rede. Os segredos vão ao contêiner por nome de variável e nunca aparecem nos
  argumentos (teste confere).
- **Limpeza de imagens:** as referências vêm do próprio Docker, filtradas pelo repositório da aplicação e pela
  etiqueta SHA. Falha fechada (versão ativa desconhecida, inspeção sem resultado). O Docker recusa remover imagem em
  uso (sem `--force`).
- **Pré-verificação:** só leitura (`BEGIN TRANSACTION READ ONLY`); consultas dinâmicas apenas com textos constantes
  em `query_to_xml`, protegidas por existência.
- **P4 inalterado:** o claude-operador continua sem acesso ao bucket de backups.

## 12. Ação humana ainda necessária

Nenhuma. A publicação foi repetida uma vez (de `96eb243` para `5c3f6ad`) por causa da falha do §7. Nas próximas
versões do runner ou dos scripts, o único passo humano continua sendo `bootstrap.sh publicar-runner` no commit
desejado.

## 13. Estado final da homologação

- **Versões:**
  - aplicação **`406fde7`** (drop-in, ambiente da pilha, candidata e migrada);
  - runner `2.1.1`;
  - `/opt/cenario` `5c3f6adbcdf3`.
- **Banco:** migrations **25/25** (`migration_verify`: nenhuma pendente, desconhecida ou incompleta).
  `migration_precheck`: OK.
- **Contêineres:** api e web `healthy`; postgres `healthy`; caddy e backup em execução. Recriados só Caddy e API.
- **Verificações:**
  - `health`, `smoke_test`, `network_status` OK;
  - `websocket_test` 401 (esperado, sem sessão);
  - `run_homologation_tests suite=completo`: saude ✔, acesso ✔, websocket ✔.
- **Logs (15–60 min):**
  - API só `info`;
  - Caddy 200/307/401, sem 5xx e sem erros;
  - web sem erros;
  - Docker sem OOM nem crash;
  - runner sem falhas. Um `version` (leitura) pedido durante o reinício do runner ficou "interrompido" e não foi
    reexecutado, como previsto.
- **Recursos:** disco 7,3 GB livres (61 %); memória disponível 1074 MB; swap 88 MB.
- **Portão:** fechado.

## 14. Classificação das ressalvas

| Ressalva | Classificação                                    | Evidência                                                                             |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| P1       | **RESOLVIDA**                                    | 3,70 GiB recuperados; 7,29 GiB livres; ativa e rollback preservadas; idempotente      |
| P2       | **RESOLVIDA**                                    | `/opt/cenario` em `5c3f6adbcdf3`; `TRUST_PROXY=172.28.0.250`; aviso ausente; saúde OK |
| P3       | **RESOLVIDA**                                    | pré-verificação da cadeia atual instalada; PREFLIGHT OK com 25/25 na VM               |
| P4       | inalterada (separação de privilégio intencional) |
