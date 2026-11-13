# Correção do envio de backups — homologação: relatório parcial

Situação em 13/11/2026, 21:50 UTC.

- Correção: scripts `89fbe1ba4ea5`, da branch `claude/correcao-envio-backups-homolog`, sobre `5ff1597`.
- Só homologação. A produção não foi tocada e não houve deploy da aplicação.
- Evidências: `docs/evidencias/homologacao-correcao-backup/`.

## Veredito parcial: **GO COM RESSALVAS**

Tudo o que dava para verificar hoje passou. Duas comprovações dependem do relógio, porque só
acontecem nas execuções automáticas das 07:30 UTC (seção 4). A recomendação para a produção só
deve ser fechada depois delas.

## 1. Linha do tempo

| Hora (UTC)  | Quem       | Etapa                                            | Resultado                                                                                                                                                                            |
| ----------- | ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 21:45       | runner     | Pré-verificação, só leitura                      | Scripts `5ff1597c0d1c`; portão fechado; saúde OK; journal com o envio **pulado pelo portão** de 07/11 a 13/11 (7 dias)                                                               |
| 21:45       | runner     | `vm_scripts_diff 89fbe1ba4ea5`                   | Pacote **íntegro** (SHA-256 e commit conferidos). Mudam só `vm.sh`, `startup.sh` e `testes/test_vm_sh.sh`, com +103/−11, igual ao `git diff`. Compose, Caddy e runner sem mudança    |
| 21:46       | runner     | `gate_open` → `vm_scripts_update` → `gate_close` | 3 arquivos atualizados; cópia anterior em `/opt/cenario.anterior-20261113T214626Z-e0534300`; nada reiniciado. A sugestão de `apply_stack_config` **não** foi seguida (desnecessária) |
| 21:48       | você (SSH) | `startup.sh` com o portão fechado                | Unidades regravadas; nada iniciado                                                                                                                                                   |
| 21:48       | você (SSH) | 1º `envio-externo`                               | **✘ "nenhum envio ao bucket registrado", código 1**: o alerta funciona                                                                                                               |
| 21:48:52    | você (SSH) | `systemctl start cenario-backup-upload.service`  | Iniciado e **finalizado com sucesso com o portão fechado**. Antes da correção, seria pulado                                                                                          |
| 21:48       | você (SSH) | 2º `envio-externo`                               | ✔ "último envio há 0 h" e ✔ "nenhum backup local atrasado", código 0                                                                                                               |
| 21:49–21:50 | runner     | Validação final, só leitura                      | seção 2                                                                                                                                                                              |

## 2. Validação final (runner, só leitura)

| #   | Verificação                    | Resultado                                                                                                                                                                                                                    |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `smoke_test` com o alerta novo | **20/20 ✔, "Saúde: OK"**: inclui ✔ "último envio ao bucket há 0 h" e ✔ "nenhum backup local sem cópia externa há mais de 36 h". `run_homologation_tests completo`: **29/29 ✔** (antes 27; as 2 novas são o alerta)       |
| 2   | Portão de publicação           | **fechado**                                                                                                                                                                                                                  |
| 3   | Contêineres                    | 5 saudáveis. Estado e tempo de atividade **idênticos** antes e depois da instalação (api e web "Up 4 hours", postgres e backup "Up 5 weeks", caddy "Up 2 weeks"): **nenhum reinício**. Logs da API: 0 respostas 5xx, 0 erros |
| 4   | Serviço sem portão             | Ver o detalhe abaixo da tabela                                                                                                                                                                                               |
| 4   | Timer às 07:30 UTC             | Ver o detalhe abaixo da tabela                                                                                                                                                                                               |
| 5   | Envio ao bucket                | Ver o detalhe abaixo da tabela                                                                                                                                                                                               |
| —   | Versão dos scripts             | `/opt/cenario` = `89fbe1ba4ea5`; aplicação `696e3e9` sem mudança; nenhuma migration; nenhum dado operacional alterado                                                                                                        |

**Item 4 — serviço sem o portão.** Comprovado pelo **comportamento**:

- antes, 7 linhas no journal: "skipped because of an unmet condition check
  (ConditionPathExists=/etc/cenario/publicacao-autorizada)";
- às 21:48:52, com o portão fechado: "Starting… / Deactivated successfully / Finished".

O runner não tem uma operação que mostre o arquivo da unidade. Seu `systemctl cat … | grep
ConditionPathExists` é a prova direta: se puder, cole a saída.

**Item 4 — timer das 07:30 UTC.** O journal mostra o timer disparando todo dia às 07:30 UTC
(`OnCalendar=*-*-* 07:30:00 UTC`, `Persistent=true`). O `startup.sh` o reinicia sem mudança. O runner
não tem uma operação equivalente a `systemctl list-timers`: a saída que você obteve no passo 3 é a
prova direta. A prova definitiva é a execução de amanhã (seção 4).

**Item 5 — envio ao bucket.**

- Os 2 backups de 13/11 (`cenario-staging-20261113T171406Z` e `…174651Z`) foram enviados às 17:47:09
  pelo ponto de recuperação do R-1. O log registrou "✔ … enviado a
  gs://cenariogestao-homolog-backups/backups/".
- O envio manual das 21:48:52 não tinha nada pendente: terminou sem erro e gravou o carimbo
  (alerta em 0 h).
- **Limitação:** a conta `claude-operador` não pode listar o bucket (403 em `storage.objects.list`).
  Não houve contorno. A confirmação direta é sua, pelo comando abaixo.

```bash
gcloud storage ls -l gs://cenariogestao-homolog-backups/backups/ | sort -k2 | tail -5
```

## 3. Requisitos

| Requisito                      | Situação                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Não reiniciar a aplicação      | ✔ contêineres idênticos                                                                |
| Não executar migrations        | ✔                                                                                      |
| Não alterar dados operacionais | ✔: só objetos no bucket de backups e carimbo e lista de enviados em `/var/lib/cenario` |
| Não ampliar permissões         | ✔                                                                                      |
| `/conheca` no estado atual     | ✔ Compose sem mudança (homologação continua com `SITE_COMERCIAL=1`)                    |
| Produção intocada              | ✔                                                                                      |

## 4. O que depende das execuções automáticas

| Quando               | O que comprova                                                                                      | Como verifico (runner, só leitura)                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **14/11, 07:30 UTC** | O timer dispara e o serviço **roda sozinho**, com "Finished", sem "skipped", e com o portão fechado | `application_logs unit=cenario-backup-upload`; `smoke_test` com "✔ último envio ao bucket há 0 h". Nenhum backup novo será enviado nesse horário: o backup diário da homologação sai às ~17:14 UTC, e os de 13/11 já estão no bucket |
| **15/11, 07:30 UTC** | O envio automático de um **backup novo**: o de 14/11, ~17:14                                        | O journal mostra "✔ cenario-staging-20261114T17…Z enviado"; a sua listagem do bucket mostra o objeto                                                                                                                                 |
| 14/11 a 15/11        | O alerta não dispara em falso                                                                       | O `smoke_test` continua ✔: o backup de 14/11 é enviado com ~14 h, abaixo de 36 h                                                                                                                                                     |

**Retorno da correção, se preciso:** `vm_scripts_restore` e depois `startup.sh` com o portão
fechado. Nada é reiniciado.

## 5. Próximos passos

1. **14/11 após 07:30 UTC:** eu verifico o item da seção 4 (check-in agendado).
2. **15/11 após 07:30 UTC:** eu verifico o envio automático de um backup novo, e você lista o bucket.
3. Com os dois ✔, o veredito da homologação vira **GO**. Aí peço sua autorização para a produção:
   - você publica `scripts-2f078850696c`;
   - eu faço `vm_scripts_diff`, `gate_open`, `vm_scripts_update` e `gate_close` com
     `claude-operador-prod`, o que exige autorização de escrita;
   - você roda o `startup.sh` com o portão fechado.
4. **Até lá, a produção continua sem o envio diário.** Os 22 backups pendentes já foram enviados
   hoje. O próximo backup sem cópia externa é o de 14/11, e o prazo da retenção local, de 30 dias,
   deixa folga ampla. Se a autorização demorar mais de alguns dias, repita o envio emergencial
   (opção A).
