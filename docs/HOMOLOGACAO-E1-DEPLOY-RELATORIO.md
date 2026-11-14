# E1 — material não bloqueia a produção: deploy em homologação

Data: 14/11/2026, das 23:05 às 23:52 UTC. **Só homologação.** Produção não foi acessada. Não houve
migration, merge ou mudança de configuração persistida, e a E2 não foi iniciada.
Evidências: `docs/evidencias/homologacao-e1-deploy/`.

**Situação: implantada e saudável. A E1 NÃO está concluída: falta a sua validação funcional
(seção 5).**

## 1. Verificações antes do deploy

| #   | Verificação               | Resultado                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Operador e permissões     | ✔ `claude-operador@cenariogestao` (homologação), a credencial desta sessão. O runner da homologação aceita os jobs assinados (`verificar` OK). O acesso à produção é recusado (403 em `signJwt` para `claude-operador-prod`, já registrado)                                                                                 |
| 2   | Recursos de homologação   | ✔ VM `cenario-homolog` (us-east1-b); pilha `cenario-homolog` (api, web, postgres, caddy, backup); banco `cenario_homolog`; imagens em `…/cenario-homolog/`; bucket `cenariogestao-homolog-backups`                                                                                                                          |
| 3   | Versão anterior e retorno | ✔ ativa antes: `696e3e9`, já ativada, com as mesmas 37 migrations. O retorno é `rollback_version` (seção 6). Ponto de recuperação `cenario-staging-20261114T234953Z`                                                                                                                                                        |
| 4–5 | Configuração `materiais`  | ✔ `module_settings` com **0 linhas**: não há `materiais` gravado. Vale o padrão da versão, que na E1 é **desligado**. Nada foi gravado nem alterado                                                                                                                                                                         |
| 6   | Sem migrations            | ✔ A imagem e o banco têm as mesmas 37 migrations, com **0 pendentes** (preflight OK). O `migrate` do runner é obrigatório para registrar a versão: respondeu "Database schema is up to date!" e a impressão digital do banco ficou **idêntica** antes e depois (0 linhas diferentes). Nenhum arquivo de `packages/db` mudou |
| 7   | Commit autorizado         | ✔ A ponta de `claude/reformulacao-e1-materiais` é exatamente `0348dcfd8e5fdf9eccfb73e244cfa37af2520653`. O build foi feito a partir desse commit e as etiquetas são o SHA completo                                                                                                                                          |

## 2. Versão implantada

| Item          | Valor                                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| URL           | **`https://teste.cenariogestao.com.br`** (senha do proxy + login do sistema)     |
| Commit        | `0348dcfd8e5fdf9eccfb73e244cfa37af2520653`: etiqueta, pilha, candidata e migrada |
| Imagem api    | `sha256:40153af367c0bdae03077f5719b7697a33cd498f32e0dfdce25387373c09e263`        |
| Imagem web    | `sha256:443f9e44695f72084d37b1a727d3ee072dbc32da88e83a53ff31a6a5229edc9c`        |
| Build         | Cloud Build `394d263e…`, SUCCESS (23:10–23:15 UTC), conta `cenario-build`        |
| Scripts da VM | `89fbe1ba4ea5` (inalterados)                                                     |

## 3. Linha do tempo (UTC)

| Hora        | Etapa                                                                 | Resultado                                                                         |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 23:16–23:18 | `gate_open` → `prepare_version` → `migration_precheck` → `gate_close` | digests conferidos na VM; a imagem não migra na partida; 6 GB livres; 0 pendentes |
| 23:49:50    | `maintenance_on`                                                      | API e web paradas                                                                 |
| 23:50:14    | `recovery_point_create`                                               | `cenario-staging-20261114T234953Z`, restauração IDÊNTICA, enviado ao bucket       |
| 23:50:48    | `migrate` (registro)                                                  | 0 pendentes; impressão digital idêntica                                           |
| 23:51:15    | `activate_version`                                                    | ✔                                                                                |
| 23:51:31    | `gate_close`                                                          | portão **fechado**                                                                |

**Indisponibilidade: ~1 min 25 s** (23:49:50 → 23:51:15).

## 4. Testes

**Na instância de homologação, após a ativação:**

| Verificação                       | Resultado                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                          | 6/6 ✔                                                                                                                                                                                                |
| `smoke_test`                      | 20/20 ✔, "Saúde: OK" (inclui "último envio ao bucket há 0 h")                                                                                                                                        |
| `websocket_test`                  | ✔ (401 sem sessão)                                                                                                                                                                                   |
| `run_homologation_tests completo` | 29/29 ✔                                                                                                                                                                                              |
| Logs da API e da web              | 0 respostas 5xx, 0 erros                                                                                                                                                                              |
| Dados                             | Impressão digital idêntica 1 minuto depois da ativação. O ciclo de 30 s não encontrou tarefa bloqueada por material para liberar. 10 tarefas, 3 OS, 7 funcionários, 2 dispositivos, todos preservados |
| Configuração                      | `module_settings` continua com 0 linhas: o padrão funciona sem intervenção manual                                                                                                                     |

**Automatizados, no commit exato `0348dcf`, em banco local de teste:**

| Suíte                                                           | Resultado                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e1-materiais-sem-trava.test.ts` (cenários A–H do relatório E1) | **10/10** ✔                                                                                                                                                                                                                                                                                               |
| Pacote compartilhado                                            | 151/151 ✔                                                                                                                                                                                                                                                                                                 |
| API completa                                                    | **1026 passaram, 1 falhou**, 13 ignorados. A falha é `rodada4-travas-estruturais › F10-01`, a mesma registrada no relatório E1: já existia na `696e3e9`, o teste conferia o texto antigo da tela de recebimento, e a correção (`29dc333`, só no teste) está fora desta base. Não tem relação com materiais |

O E2E (80/80) é o do relatório da E1. Não foi repetido aqui.

**Limite:** esta sessão não acessa a interface da homologação, porque o proxy de saída recusa o
domínio. Os testes pela tela são os da seção 5.

## 5. Validação funcional (você, pela interface)

Use só dados `HML-`.

| #   | Ação                                                                                                                                                | Esperado                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empresa → Funcionalidades                                                                                                                           | "Travas de materiais na produção" **desligada** (padrão, sem ter sido mexida)                                                    |
| 2   | Novo serviço `HML-E1` com 1 peça; programar e publicar a tarefa para um tapeceiro de teste; **nenhuma** compra, medição ou levantamento de material | A tarefa aparece no tablet                                                                                                       |
| 3   | Tablet: iniciar, pausar, retomar e concluir                                                                                                         | Tudo funciona. O cartão pode mostrar "Falta material" como **aviso**, sem impedir                                                |
| 4   | OS `HML-E1` → Resumo                                                                                                                                | Materiais e Medições aparecem como "Não impede o início"                                                                         |
| 5   | Material `HML-Tecido` na OS, não comprado                                                                                                           | A tarefa continua iniciável, e o aviso continua                                                                                  |
| 6   | Bloqueios legítimos                                                                                                                                 | Etapa com dependência não concluída, tarefa de outro responsável, plano não publicado e tarefa concluída **continuam recusados** |
| 7   | Permissões                                                                                                                                          | Um perfil sem `producao.executar` não inicia tarefa                                                                              |
| 8   | Histórico                                                                                                                                           | OS e tarefas anteriores continuam iguais e visíveis                                                                              |
| 9   | (Opcional) ligar a trava em Funcionalidades                                                                                                         | A etapa volta a exigir material. **Isso grava configuração**: só faça se quiser testar, e desligue ao final                      |

## 6. Retorno, se necessário

O retorno é só da aplicação, sem migration, com cerca de 20 s fora do ar, pelo runner da homologação:

1. `gate_open`;
2. `rollback_version version=696e3e9ddc5f1c803a4b9244a075ed498ad81be3`;
3. `gate_close`;
4. `smoke_test`.

A `696e3e9` já foi ativada antes e conhece as mesmas 37 migrations. **Efeito:** sem configuração
gravada, a trava de materiais volta a valer, porque o padrão da `696e3e9` é ligado. Tarefas sem
material voltam a ficar "Aguardando materiais".

Último recurso: o ponto de recuperação `cenario-staging-20261114T234953Z`. Ele descarta o que for
gravado depois de 23:49.

## 7. Pendências

- **A sua validação funcional (seção 5)**, para considerar a E1 concluída.
- A falha F10-01 da suíte da API é um teste desatualizado. Ela pode ser corrigida trazendo `29dc333`
  para a branch da E1, se você quiser. Não foi feito.
- Produção: intocada (`696e3e9`). E2: não iniciada.
