# Produção — deploy de `696e3e9` com banco limpo: relatório final

Data: **14/11/2026**. As operações foram executadas pela sessão do ambiente "Cenário — Produção"
(conta `claude-operador-prod`), fase a fase, com autorização do dono dada diretamente naquela
sessão. Evidências: `docs/evidencias/producao-deploy-696e3e9/{fase0,faseP3,faseJ,faseV}/`, na branch
`claude/auditoria-prod-696e3e9` (commits `bad13cd`, `b151274` e `f124ebb`).

## Resultado: **implantado**

N1–N10 ✔. Nenhum retorno foi necessário.

**Pendências antes do GO final:**

- o primeiro login do dono;
- a confirmação, pelo nome, do volume antigo;
- a reexecução do `startup.sh` para o envio diário de backups (seção 5).

## 1. Versão implantada

| Item            | Valor                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| Aplicação       | `696e3e9ddc5f1c803a4b9244a075ed498ad81be3`: etiqueta, pilha, candidata e migrada           |
| Imagem `api`    | `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f`                  |
| Imagem `web`    | `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72`                  |
| Scripts da VM   | `9ff142e274b1`, que inclui a correção do envio de backups. A `/conheca` continua desligada |
| Banco           | **novo**, no volume `pgdata_2026_11`: 37/37 migrations                                     |
| Banco anterior  | volume `pgdata`, **preservado e sem uso** (75,6 MB)                                        |
| Versão anterior | `7b4177b`, disponível para o retorno                                                       |

## 2. Linha do tempo (UTC)

| Fase | Hora        | Resultado                                                                                                                                      |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| P    | 17:08–17:12 | N1–N4 ✔                                                                                                                                       |
| P    |             | Imagens promovidas pelo Cloud Shell (`crane copy`) e conferidas                                                                                |
| P    |             | `vm_scripts_diff` só com o previsto, mais a exceção N3 aprovada: permissão `0755 → 0644` em `provisionar.sh` e `ssh-agente.sh`                 |
| P    |             | `prepare_version` OK, com 32 GB livres                                                                                                         |
| P    |             | Backup final do banco antigo `cenario-production-20261114T171135Z`: SHA OK, enviado ao bucket e conferido pelo dono como ÍNTEGRO (1.116.160 B) |
| P    |             | Portão fechado                                                                                                                                 |
| J    | 17:21–17:24 | Manutenção ligada às 17:21:33                                                                                                                  |
| J    |             | Scripts instalados; a cópia anterior está em `/opt/cenario.anterior-20261114T172138Z-9885b50a`                                                 |
| J    |             | "banco NOVO (nenhuma tabela)"                                                                                                                  |
| J    |             | Ponto de recuperação `cenario-production-20261114T172215Z`: restauração idêntica, enviado ao bucket                                            |
| J    |             | Precheck: 37 pendentes; `migrate` em 14 s                                                                                                      |
| J    |             | Ativação: "Saúde: OK"                                                                                                                          |
| J    |             | Seed: **1 gestor, 0 clientes, 0 OS, 0 dispositivos**                                                                                           |
| J    |             | Portão fechado                                                                                                                                 |
| V    | 17:28–17:29 | N10 ✔ (seção 3)                                                                                                                               |

**Indisponibilidade: ~2 min 10 s** (17:21:33 → 17:23:43). A estimativa era de 5 a 8 min.

## 3. Testes de saúde (fase V, só leitura)

| Verificação                       | Resultado                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke_test`                      | **"Saúde: OK", 27 ✔, 0 ✘**: HTTPS, redirecionamentos, HSTS, rotas protegidas com 401, certificado, backup, migrations, disco, memória e o alerta do backup externo |
| `websocket_test`                  | 401 sem sessão (esperado)                                                                                                                                           |
| `run_homologation_tests completo` | saúde ✔, acesso ✔, WebSocket ✔                                                                                                                                   |
| `migration_status`                | 37/37; nada pendente ou incompleto                                                                                                                                  |
| `database_counts`                 | 1 usuário, 1 funcionário (o gestor), 0 clientes, 0 OS                                                                                                               |
| Logs da API desde a ativação      | 139 linhas: **0 respostas 5xx, 0 erros**                                                                                                                            |
| Disco                             | 34%; 6 volumes, 5 em uso. O inativo é o `pgdata` antigo                                                                                                             |

## 4. Backups

| Item                                | Situação                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backups locais                      | 31 pastas preservadas; nenhum apagado                                                                                                                    |
| Bucket `cenariogestao-prod-backups` | Os 6 antigos, os 22 enviados em 13/11, o diário de 14/11, o **backup final do banco antigo** (ÍNTEGRO) e o **ponto de recuperação do banco novo**        |
| Envio diário automático             | A correção está **instalada** (scripts `9ff142e274b1`). **Ativa só depois** de reexecutar o `startup.sh` (seção 5.1), que regrava a unidade sem o portão |
| Snapshots                           | Política diária `cenario-prod-diario` ativa (14 snapshots READY em 13/11)                                                                                |

**Atenção — imagens:** o plano de limpeza (`images_cleanup_plan`, só o plano) lista `9fb1786` como
removível. **Não execute `images_cleanup`** sem revisão: o retorno depende das imagens de `7b4177b`,
que continuam na VM.

## 5. Primeiro acesso: o que falta (você)

### 5.1 SSH na VM

O SSH ativa o envio diário e confirma o volume antigo pelo nome. Rode com o portão fechado:

```bash
gcloud compute ssh cenario-prod --zone=southamerica-east1-b --tunnel-through-iap
test -e /etc/cenario/publicacao-autorizada && echo "PORTÃO ABERTO — PARE" || sudo bash /opt/cenario/infra/prod/gcp/startup.sh
sudo systemctl start cenario-backup-upload.service && sudo /opt/cenario/infra/prod/gcp/vm.sh envio-externo; echo "código: $?"
sudo docker volume ls --format '{{.Name}}' | grep pgdata
exit
```

O que esperar:

- `startup.sh` termina com "publicação NÃO autorizada (…): nada foi iniciado";
- `envio-externo` termina com ✔ e código 0;
- os volumes `cenario-prod_pgdata` (antigo, preservado) e `cenario-prod_pgdata_2026_11` (em uso).

### 5.2 Primeiro login

1. Acesse `https://cenariogestao.com.br/entrar`.
2. Entre com:
   - o **e-mail do gestor** dos metadados da VM, o seu;
   - a **senha inicial** do segredo `prod-admin-password`. Abra-a só no seu terminal, com
     `gcloud secrets versions access latest --secret=prod-admin-password --project=cenariogestao`.
3. **Troque a senha** pelo sistema, no menu do usuário.
4. Refaça os cadastros:
   - **Funções e permissões** e **Funcionários**: a equipe e os PINs;
   - **Dispositivos e sessões**: "Cadastrar e gerar código" para cada tablet, e no tablet,
     `https://cenariogestao.com.br/tablet`;
   - **Empresa**: os dados e os interruptores. Os 4 já estão ligados, que é o padrão.

## 6. Retorno, se necessário

Testado no ensaio E4. Não apaga dados.

1. `gate_open` → `maintenance_on`;
2. `vm_scripts_restore`;
3. `stack_bootstrap version=7b4177b…`;
4. `rollback_version version=7b4177b…`;
5. `gate_close`.

O banco antigo volta como estava às 17:21 de 14/11. O banco novo fica preservado no volume
`pgdata_2026_11`.
