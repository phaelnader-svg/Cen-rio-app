# Produção — plano simplificado: `696e3e9` com banco limpo

Situação: **plano. Nada executado, nada apagado.** O deploy, a troca de banco e qualquer escrita na
produção dependem da sua autorização específica.

Premissa sua: os dados operacionais atuais **não precisam ser preservados**, mas **nada deve ser
apagado**.

## 1. Conclusão

**Sim, dá para começar com um banco limpo, e é mais simples e mais seguro do que migrar.** A forma
recomendada **não apaga nada**: o PostgreSQL da produção passa a usar um **volume novo e vazio**,
`pgdata_2026_11`. O volume atual, `pgdata`, com todos os dados de hoje, fica **intacto e desligado**
na VM.

A aplicação nova cria o esquema completo (37 migrations sobre um banco vazio) e o mínimo
estrutural: funções padrão, configuração da empresa e o gestor.

O que isso elimina:

- **Migrations sobre dados reais:** não há.
- **Versão de retorno R2:** não é necessária.
- **Comparação de dados:** não há o que conferir entre antes e depois.

**Retorno: sem perda dos dados antigos.** Volta o volume antigo com a versão antiga `7b4177b`, que o
conhece (33 migrations), só pelo runner.

## 2. O que fica e o que recomeça

| Preservado (sem ação)                                                                 | Recomeça do zero (refazer pela interface)                               |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Domínio, DNS, HTTPS e **certificado** (volume `caddy_data` mantido: sem nova emissão) | Funcionários e usuários (hoje 6), com seus **PINs**                     |
| Segredos do Secret Manager (senha do banco, chave de tokens, senha inicial do gestor) | **Vínculo dos tablets** (hoje 6 dispositivos): novo código para cada um |
| Metadados da VM (bucket, e-mail e nome do gestor, região)                             | Dados da empresa (o seed grava só o nome "Cenário Estofados")           |
| Volume de **backups**: os 28 antigos continuam, mais os novos                         | Fornecedores, itens de estoque, modelos de serviço personalizados       |
| Volume de **arquivos**: as fotos antigas ficam guardadas, sem uso                     | Clientes, pedidos, OS, financeiro: **começam vazios**                   |
| **Banco antigo inteiro** (volume `pgdata`) e suas cópias no bucket                    | Interruptores da empresa: todos ligados (o padrão)                      |
| Funções padrão e checklists                                                           | —                                                                       |

**Acesso administrativo:** o `seed_bootstrap` cria **um** gestor, com:

- o e-mail e o nome dos metadados da VM;
- a senha do segredo `prod-admin-password`.

A partir dele, o gestor recria a equipe.

## 3. Riscos reais

| #   | Risco                                                                                                                                                  | Impacto                                                              | Mitigação                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Senha do gestor diferente da que você usa hoje.** O gestor novo usa a senha **inicial** do Secret Manager, e não a que foi trocada depois no sistema | Não conseguir entrar logo após o deploy                              | Antes da janela, confirme que tem a senha do segredo: `gcloud secrets versions access latest --secret=prod-admin-password --project=cenariogestao`. Ela só aparece no seu terminal. Troque-a pelo sistema no primeiro acesso                 |
| 2   | **Equipe e tablets parados até o recadastro**                                                                                                          | A oficina não usa os tablets até haver funcionários, PINs e vínculos | Janela fora do expediente. Lista pronta das 6 pessoas e dos 6 tablets. Leva ~30 a 45 min pela interface                                                                                                                                      |
| 3   | **Histórico antigo fica fora do sistema** (clientes, OS, recebíveis)                                                                                   | Consultas antigas só pelo backup                                     | É a sua premissa. Os dados ficam no volume antigo e em 28 backups (6 + 22 no bucket, íntegros). Uma consulta pontual é possível restaurando um backup em banco separado                                                                      |
| 4   | **Erro na troca de volume** (Compose)                                                                                                                  | O PostgreSQL não sobe ou sobe no volume errado                       | A mudança tem 1 linha no Compose, conferida por `vm_scripts_diff`, `docker compose config` e teste local. O `iniciar-banco` informa "banco NOVO (nenhuma tabela)", e o procedimento **para** se não informar. O retorno vem pronto (seção 6) |
| 5   | **Trocar o volume antes da hora.** Se o Compose novo for instalado cedo, um reinício qualquer subiria o banco vazio                                    | Aplicação sem esquema                                                | O pacote com a troca **só é instalado dentro da janela**, depois do `maintenance_on`. Fora da janela a VM fica com os scripts atuais                                                                                                         |
| 6   | **Envio diário dos backups** ainda pulado na produção                                                                                                  | Cópia externa do banco novo atrasada                                 | **Pré-requisito:** a correção do envio (`2f07885`) instalada e validada na produção **antes** do deploy. O pacote do deploy é montado sobre ela                                                                                              |
| 7   | Rotinas automáticas no banco vazio                                                                                                                     | Nenhum: sem OS, não há alertas                                       | —                                                                                                                                                                                                                                            |

Não há risco de esquema ou de migration sobre dados reais. O banco começa vazio, e as 37 migrations
sobre banco vazio são o mesmo caminho de toda a suíte de testes (API 1017, E2E 79/79) e do primeiro
deploy da produção em 19/10.

## 4. Etapas eliminadas do procedimento anterior

| Etapa do plano anterior                                                     | No banco limpo                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R-1/R-2: retorno pela R2 `341badb` e sua promoção                           | **Eliminado.** O retorno é o banco antigo com `7b4177b`                       |
| `migration_precheck` sobre dados reais; riscos de lock e validação de CHECK | **Eliminado.** O precheck só confirma "37 pendentes" no banco vazio           |
| Impressão digital antes e depois; comparação de totais financeiros          | **Eliminado**                                                                 |
| Página de prontidão para retorno (peças sem embalagem)                      | **Eliminado**                                                                 |
| Conferência das 3 fotos antigas e dos dados existentes após a ativação      | **Eliminado**                                                                 |
| Homologação manual completa (R-3, 13 blocos)                                | **Reduzida** ao roteiro mínimo da seção 5                                     |
| Ponto de recuperação com dados reais                                        | Substituído por um `backup_create` final do banco antigo, por segurança extra |

## 5. Testes essenciais (e só esses)

1. **Na homologação** (você, ~45 min, o essencial do R-3):
   - **acesso:** entrar e sair (B4); 2 perfis (um sem financeiro, um sem estoque) sem itens de
     menu com erro;
   - **fluxo de ponta a ponta:** criar uma OS `HML-` → programar → tablet: iniciar e concluir →
     qualidade "Tudo conforme" → entrega direta → financeiro (o valor aparece uma vez);
   - **fotos:** foto pelo celular (em pé, sem GPS) e remoção com confirmação (U1).
2. **Locais (eu, antes de pedir a janela):**
   - `docker compose config` do Compose novo: volume `pgdata_2026_11` no PostgreSQL; `backups`,
     `storage` e `caddy_data` inalterados;
   - testes de `vm.sh` e do provisionamento;
   - ensaio local do fluxo "banco novo → migrate 37 → seed": `infra/prod/gcp/testes/ensaio-primeiro-deploy.sh`.
3. **Na produção, logo após a ativação** (eu, só leitura):
   - `smoke_test` (inclui HTTPS, rotas protegidas, certificado e o alerta do backup externo),
     `websocket_test`, `run_homologation_tests completo`;
   - `migration_status` = 37;
   - `database_counts`: 1 usuário, 0 clientes;
   - logs sem 5xx.
4. **Na produção** (você, 10 min): entrar como gestor, trocar a senha, abrir as telas principais e
   cadastrar 1 funcionário e 1 tablet.

## 6. Procedimento

**Intervenções manuais suas: 3**, além das autorizações:

1. **Antes:** promover as imagens de `696e3e9` para a produção (1 comando no Cloud Shell; seção 7).
2. **Antes:** publicar o pacote de scripts do deploy (1 bloco no Cloud Shell, como o da correção de
   backup).
3. **Depois:** entrar como gestor e refazer equipe, PINs e tablets.

Todo o resto é pelo runner da produção (`CENARIO_AMBIENTE=prod`), que **exige sua autorização de
escrita** para `claude-operador-prod`.

**Pré-requisitos:**

- correção do envio de backups validada na homologação (14 e 15/11) e instalada na produção;
- roteiro mínimo da seção 5 aprovado;
- senha do gestor confirmada (risco 1).

**Antes da janela, sem indisponibilidade:**

| #   | Operação                                                                        | Para se…                                                 |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P1  | `version`, `gate_status`, `health`, `backup_list`, `envio-externo` (pelo smoke) | Versão ≠ `7b4177b`, portão aberto ou contêiner sem saúde |
| P2  | `imagens 696e3e9…`                                                              | Imagens ausentes ou com digest diferente do autorizado   |
| P3  | `vm_scripts_diff <pacote do deploy>`                                            | Mudança além da linha do volume no Compose               |
| P4  | `gate_open` → `prepare_version 696e3e9…` → `gate_close`                         | Digest diferente ou disco < 10 GB                        |

**Janela** (30 min reservados; **cerca de 10 min fora do ar**):

| #   | Operação                                                                                   | Para se… / ação                                                 |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| J1  | `gate_open`                                                                                | —                                                               |
| J2  | `backup_create`: backup final do banco antigo, enviado ao bucket                           | Erro de envio → `gate_close` e parar                            |
| J3  | `maintenance_on`: API e web paradas                                                        | —                                                               |
| J4  | `vm_scripts_update <pacote do deploy>`                                                     | Validação reprovada → `maintenance_off` e parar                 |
| J5  | `stack_bootstrap version=696e3e9…`: gera o ambiente e sobe o PostgreSQL **no volume novo** | Precisa aparecer "banco NOVO (nenhuma tabela)". Senão → retorno |
| J6  | `recovery_point_create` (banco vazio)                                                      | Restauração de teste diferente de IDÊNTICA → retorno            |
| J7  | `migration_precheck` → `migrate version=696e3e9…`                                          | Diferente de 37 aplicadas → retorno                             |
| J8  | `activate_version version=696e3e9…` → `seed_bootstrap`                                     | API sem saúde, ou o seed diferente de "só o gestor" → retorno   |
| J9  | `gate_close` + testes da seção 5, item 3                                                   | Qualquer ✘ crítico → retorno                                    |

**Retorno, a qualquer momento.** Sem perda dos dados antigos e sem SSH:

1. `gate_open` → `maintenance_on`;
2. `vm_scripts_restore`: o Compose volta ao volume antigo;
3. `stack_bootstrap version=7b4177b…`: o PostgreSQL sobe no volume antigo;
4. `rollback_version 7b4177b…`: a versão já ativada antes, que conhece as 33 migrations;
5. `gate_close`.

O que tiver sido gravado no banco novo fica guardado no volume novo.

## 7. O que precisa ser preparado (só com sua autorização)

1. **Pacote de scripts do deploy**, montado sobre `2f07885` (correção do backup, sem `/conheca`):
   - **uma** mudança no `infra/prod/docker-compose.prod.yml`: o PostgreSQL passa a montar
     `pgdata_2026_11:/var/lib/postgresql/data`;
   - o volume `pgdata` continua declarado, nunca removido;
   - um teste que garante que só essa linha muda.
2. **Comandos seus no Cloud Shell:**
   - promoção (já documentada): `infra/prod/gcp/promover-imagens.sh 696e3e9… sha256:264884b3… sha256:cb76d474…`;
   - publicação do pacote: o mesmo bloco da correção de backup, com o commit novo.
3. **Ensaio local** do fluxo completo (seção 5, item 2) e relatório.

**Nada é apagado em nenhuma etapa:**

- o volume `pgdata` antigo, os backups e as fotos antigas ficam;
- apagá-los no futuro (para liberar disco) é uma decisão separada, sua;
- hoje não há necessidade: o disco está em 29%.
