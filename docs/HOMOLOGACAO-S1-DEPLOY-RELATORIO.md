# S1 — embalagem removida: deploy em homologação

Data: 15/11/2026, das 03:31 às 03:50 UTC. **Só homologação.** Produção não foi acessada. Não
houve migration, limpeza, conversão, merge ou mudança de dados, e a S2 não foi iniciada.
Evidências: `docs/evidencias/homologacao-s1-deploy/`.

**Situação: implantada e funcionando, com uma ressalva de infraestrutura (disco em 90%, seção 7).
A S1 NÃO está aprovada: falta a sua validação funcional (seção 5).**

## 1. Verificações antes do deploy

| #   | Verificação                        | Resultado                                                                                                                                                                                                                              |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Operador e credenciais             | ✔ `claude-operador@cenariogestao`, ambiente `homolog` (tópico `cenario-homolog-comandos`). `verificar`: canal OK. Nenhuma senha foi pedida ou registrada                                                                              |
| 2   | Recursos exclusivos da homologação | ✔ VM `cenario-homolog`, pilha `cenario-homolog` (api, web, postgres, caddy, backup), banco `cenario_homolog`, imagens em `…/cenario-homolog/`                                                                                         |
| 3   | Versão anterior e retorno          | ✔ ativa antes: `0348dcfd8e5f…` (E1). Ponto de recuperação `cenario-staging-20261115T034025Z`: restauração de teste IDÊNTICA, enviado ao bucket                                                                                        |
| 4   | Sem migrations novas               | ✔ a S1 não altera `packages/db`. Imagem e banco têm 37 migrations, **0 pendentes** (`migration_precheck` e `migrate`: "Database schema is up to date!"). Impressão digital idêntica antes e depois do `migrate` (0 linhas diferentes) |
| 5   | Estado dos dados históricos        | ✔ impressão digital completa registrada antes (`02-database_fingerprint-antes.txt`)                                                                                                                                                   |
| 6   | Peças e tarefas na embalagem       | ✔ ver seção 6: **nenhuma**                                                                                                                                                                                                            |
| 7   | Registros antigos                  | ✔ nada foi alterado ou encerrado                                                                                                                                                                                                      |
| —   | Commit                             | ✔ a ponta de `claude/reformulacao-s1` é `9fb6b032c3c2496204043baa15bc2fb55a6b5e01`, a mesma do build e das etiquetas                                                                                                                  |

## 2. Versão implantada

| Item       | Valor                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| URL        | **`https://teste.cenariogestao.com.br`** (senha do proxy + login do sistema)     |
| Commit     | `9fb6b032c3c2496204043baa15bc2fb55a6b5e01`: etiqueta, pilha, candidata e migrada |
| Imagem api | `sha256:723530c305ced018d90106930c0b9b0db441b389e3ec8bc282e0b4f41f717ef0`        |
| Imagem web | `sha256:aec4622f844317e2b69d8844f77ef5f04d32269167104cf6f5b917d54fd90259`        |
| Build      | Cloud Build `09a46bbd…`, SUCCESS (03:32:50–03:37:52 UTC), conta `cenario-build`  |

## 3. Linha do tempo (UTC)

| Hora        | Etapa                                                  | Resultado                                                                               |
| ----------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 03:38–03:40 | `gate_open` → `prepare_version` → `migration_precheck` | digests conferidos na VM; a imagem não migra na partida; 0 pendentes                    |
| 03:40:19    | `maintenance_on`                                       | API e web paradas                                                                       |
| 03:40:23    | `recovery_point_create`                                | `cenario-staging-20261115T034025Z`, IDÊNTICA, no bucket                                 |
| 03:41:33    | `migrate` (só registro)                                | 0 pendentes; impressão digital idêntica                                                 |
| 03:42:37    | `activate_version`                                     | contêineres saudáveis; código 1 só pelo item "disco em 90%" da checagem final (seção 7) |
| 03:43:11    | `gate_close`                                           | portão **fechado**                                                                      |

**Indisponibilidade: até ~2 min 50 s** (03:40:19 → 03:43:09, fim da ativação).

## 4. Testes

**Na homologação, depois da ativação:**

| Verificação              | Resultado                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | etiqueta, pilha, candidata e migrada = `9fb6b03…`                                                                                                     |
| `health`                 | 6/6 ✔ (contêineres saudáveis, `/api/ready` 200)                                                                                                      |
| `smoke_test`             | **19/20 ✔**; o único ✘ é "disco em 90%". HTTPS, proxy com senha, web, API, banco, certificado, backup recente, envio ao bucket e migrations passaram |
| `websocket_test`         | ✔                                                                                                                                                    |
| `run_homologation_tests` | `acesso` 6/6 ✔; `websocket` 2/2 ✔. A `completo` para na suíte `saude` pelo mesmo item de disco                                                      |
| Logs da API e da web     | 0 erros, 0 respostas 5xx                                                                                                                              |
| Dados                    | impressão digital **idêntica** à de antes do deploy (0 linhas diferentes); `module_settings` com 0 linhas                                             |

**Funcionais, no commit exato `9fb6b03`, em bancos locais descartáveis** (relatório
`docs/REFORMULACAO-REMOCAO-S1-RELATORIO.md`):

| Requisito                                      | Evidência                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Produção → qualidade → aprovação → pronta      | `remocao-s1-embalagem.test.ts`, `quality.test.ts` (6, 9, 13), E2E `team-quality` e `zz-fluxo-transversal` |
| Sem etapa e sem tarefa automática de embalagem | contagem 0 de registros, tarefas `EMBALAGEM` e avisos; F5-04/F5-10 (modelos) sem tarefa extra             |
| Sem interruptor                                | API (`/api/company/modules` sem a chave; PUT → 404); E2E `fase0-funcionalidades`                          |
| Sem aba ou botão de embalagem                  | testes web do Grupo B S1; E2E `zz-fase3`                                                                  |
| 6 rotas → 404                                  | `remocao-s1-embalagem.test.ts` e Grupo B S1                                                               |
| Tablet sem tarefa nova de embalagem            | E2E: nenhuma tarefa "Embalar" no tablet do João                                                           |
| OS entregue após a aprovação                   | entrega direta 200 nos testes e no banco com histórico antigo                                             |
| Financeiro                                     | mão de obra "na aprovação" × "na entrega" e cobrança "na entrega" nos momentos certos                     |
| Histórico antigo                               | banco gravado pelo código anterior, lido e operado pelo novo: preservado                                  |
| Estoque simples, mapa da oficina e devoluções  | Grupo A (rotas e telas) + suítes completas: 1059 testes da API                                            |
| Bloqueios legítimos                            | Grupo B (controle) + aprovação recusada com produção pendente + OS com peça não aprovada não é entregue   |

**Limite:** esta sessão não acessa a interface nem a API pública da homologação, porque a rede do
ambiente recusa o domínio (403 no proxy de saída). Também não tenho, nem pedi, as senhas do proxy
e do sistema. Os testes pela tela ficam para a sua validação, na seção 5.

## 5. Validação funcional (você, pela interface)

Use só dados `HML-`.

| #   | Ação                                                            | Esperado                                                                      |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Empresa → Funcionalidades                                       | Só Logística, Pedidos de ajuda e Travas de materiais. **Não há "Embalagem"**  |
| 2   | Novo serviço `HML-S1` com 1 peça; programar e publicar a tarefa | Tarefa no tablet                                                              |
| 3   | Tablet: iniciar e concluir                                      | A inspeção aparece para o inspetor                                            |
| 4   | Tablet do inspetor: "Tudo conforme" → Aprovar                   | Sem texto "embalagem" na inspeção                                             |
| 5   | Tablet do João (apoio)                                          | **Nenhuma** tarefa "Embalar"                                                  |
| 6   | Qualidade (painel)                                              | Título "Qualidade", abas sem "Embalagens"                                     |
| 7   | OS `HML-S1` → Qualidade                                         | Peça "Pronta para entrega", sem código EB-; "Marcar como entregue" disponível |
| 8   | Marcar como entregue                                            | Peça entregue; mão de obra e cobrança "na entrega" seguem a regra             |
| 9   | Painel inicial e Hoje                                           | Sem "na embalagem"                                                            |
| 10  | Bloqueio legítimo                                               | Outra OS com peça ainda não aprovada: "Marcar como entregue" recusado         |
| 11  | Estoque da oficina, Mapa da oficina, Devoluções                 | Funcionam como antes                                                          |
| 12  | OS antigas (E1)                                                 | Abrem e mostram o histórico como antes                                        |

## 6. Registros antigos (diagnóstico somente leitura)

Feito pela operação **somente leitura** `database_fingerprint` do executor, que conta as linhas
de cada tabela. Não usei SQL livre, porque o executor não oferece esse caminho.

| Pergunta                                    | Resposta                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Peças gravadas na etapa antiga de embalagem | **0**. `quality_inspections` = 0: nenhuma peça chegou à aprovação, e a etapa de embalagem só existia depois dela |
| Tarefas antigas de embalagem abertas        | **0**. A tarefa de embalagem exige uma inspeção (`inspection_id`), e não há nenhuma. `packaging_records` = 0     |
| Peças aparecem corretamente na OS           | sem peça antiga em embalagem, não há o que conferir; 3 peças em 3 OS, todas antes da qualidade                   |
| Hoje e Central                              | sem inconsistência possível de embalagem (0 registros)                                                           |
| Bloqueio operacional por esses registros    | nenhum                                                                                                           |

O diagnóstico detalhado da S0 (`scripts/remocao/diagnostico-registros-abertos.sql`) não foi rodado
na homologação, por falta de um caminho de leitura por SQL. Pendência registrada.

## 7. Problemas e ressalvas

1. **Disco da VM em 90%** (3,1 GB livres de 30 GB). A checagem de saúde marca isso como problema,
   o que faz `activate_version`, `smoke_test` e a suíte `completo` saírem com código 1, embora
   tudo funcione. A causa é o acúmulo de imagens antigas. O `images_cleanup_plan` (só leitura)
   lista 12 imagens de versões antigas que podem sair (`3e0d2d0`, `a7f4f93`, `de31aa7`, `341badb`,
   `63674f1`, `696e3e9`), protegendo a ativa (`9fb6b03`) e a de retorno (`0348dcf`). **Não removi
   nada**, porque a regra em vigor proíbe remover imagens. Se você autorizar, `images_cleanup`
   libera o espaço. As imagens continuam no registro e podem ser baixadas de novo.
2. Validação pela interface e pela API pública: só pelo proprietário (seção 4, limite).
3. Diagnóstico SQL da S0 na homologação: pendente (seção 6).

## 8. Retorno, se necessário

Só a aplicação, sem migration, com cerca de 30 s fora do ar, pelo executor da homologação:

1. `gate_open`;
2. `rollback_version version=0348dcfd8e5fdf9eccfb73e244cfa37af2520653`;
3. `gate_close`;
4. `health` e `smoke_test`.

A `0348dcf` já foi ativada antes, conhece as mesmas 37 migrations e está na VM (protegida).
**Efeito:** a embalagem volta a existir. Peças aprovadas na S1 com `packaging_required = false`
continuam "prontas" (a E1 já respeitava esse campo).

Último recurso: o ponto de recuperação `cenario-staging-20261115T034025Z`. Ele descarta o que for
gravado depois de 03:40 UTC.

## 9. Confirmações

- Produção **intocada**: nenhuma operação com `CENARIO_AMBIENTE=prod` e nenhum acesso à conta de
  produção.
- Sem migration, limpeza, conversão ou alteração de registros antigos.
- Sem merge e sem PR. A S2 não foi iniciada.

## 10. Veredito

**GO para a sua validação funcional**, com a ressalva do disco (seção 7, item 1), que não afeta o
funcionamento. A S1 só fica aprovada depois da sua validação.
