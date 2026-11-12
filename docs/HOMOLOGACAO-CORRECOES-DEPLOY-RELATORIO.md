# Deploy da versão corrigida `696e3e9` em homologação — relatório

Autorização: "DECISÃO B2 E AUTORIZAÇÃO DE DEPLOY EM HOMOLOGAÇÃO" (deploy **somente** em homologação).
Produção não foi tocada. Nenhuma migration de esquema foi aplicada, nenhum volume foi limpo e
nenhum backup ou imagem foi apagado. Nada foi alterado em permissões, usuários ou IAM.
Evidências brutas: `docs/evidencias/homologacao-correcoes-deploy/`, com valores sensíveis
mascarados pelo próprio runner.

## 1. Decisão B2 registrada

O item de menu "Recebimento de materiais" **continua disponível para todos os funcionários do
painel**, como a API já permite (`ANY_EMPLOYEE`). A lista "aguardando conferência" só é pedida e
mostrada a quem tem `estoque.ver`, `compras.ver` ou `estoque.gerenciar`. As alterações diretas de
saldo continuam exigindo `estoque.gerenciar`: ajuste, saída, reserva, consumo, liberação e edição
de item. O código implantado já seguia isso, então nada foi alterado após a decisão.

**Ponto para sua atenção, sem mudança de código:** a decisão pede que a chegada fique separada da
movimentação de estoque. Hoje isso é verdade só em parte:

| Situação                                                     | O que acontece                                                                                                | Permissão                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Material **técnico** ou com conferência física               | A chegada fica **pendente de conferência**. O estoque só entra na conferência.                                | Conferir: `estoque.conferir` |
| Material **não técnico** recebido contra um pedido de compra | Ao registrar a chegada, o sistema já lança a **entrada de estoque** (`ENTRADA_COMPRA`) da quantidade recebida | Qualquer funcionário         |

O segundo caso é o desenho original. Ele se comporta igual na F′ `63674f1` e na `696e3e9`.
Ninguém altera saldo livremente: o lançamento só registra a quantidade recebida do pedido, com
autor e histórico. Mesmo assim, para materiais não técnicos, chegada e entrada no estoque
acontecem num passo só. A lista de pendências de quem não tem estoque/compras não mostra preços nem
custos. **Se quiser que toda chegada passe por conferência antes de entrar no estoque, isso é uma
mudança de regra de negócio** e precisa da sua autorização. Ela não fez parte deste deploy.

## 2. Versão implantada

| Item            | Valor                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit          | `696e3e9ddc5f1c803a4b9244a075ed498ad81be3` (`claude/reformulacao-fase-4`)                                                                                                                             |
| Imagem `api`    | `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f`                                                                                                                             |
| Imagem `web`    | `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72`                                                                                                                             |
| Conferência     | Artifact Registry antes de começar ✔. Digests baixados na VM (`prepare_version`) iguais aos autorizados ✔. Os contêineres em execução usam exatamente esses dois IDs de imagem ✔ (`21-images.txt`) |
| Versão anterior | F′ `63674f1d116ed86a92dbcc421f2fd702e41b169d`                                                                                                                                                         |

## 3. Horários (UTC, 12/11/2026)

| Etapa                                                   | Hora                                                 |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Início (conferência do estado anterior)                 | 22:42:39                                             |
| Portão aberto / preparo da versão                       | 22:43:38 / 22:43:40                                  |
| Manutenção ligada (API e web paradas)                   | 22:45:55                                             |
| Ponto de recuperação `cenario-staging-20261112T224601Z` | 22:46:01 → restauração de teste IDÊNTICA às 22:46:42 |
| Registro da versão (`migrate`, sem pendências)          | ~22:47                                               |
| Ativação concluída (sistema de volta)                   | 22:48:23                                             |
| Verificações pós-deploy                                 | 22:49:29 – 22:50:21                                  |
| Portão fechado                                          | 22:50:48                                             |
| Monitoramento final                                     | até ~22:51                                           |

**Duração total:** cerca de 9 minutos. **Indisponibilidade da aplicação:** cerca de 2 min 30 s
(22:45:55 → 22:48:23).

## 4. Condições da autorização

| #   | Condição                                                  | Resultado                                                                                                                                                                     |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Digests no Artifact Registry antes da implantação         | ✔ iguais aos autorizados                                                                                                                                                     |
| 2   | Saúde e estado anterior registrados                       | ✔ F′ ativa e saudável; 37 migrations; disco com 9,8 GB livres; portão fechado (`00-*.txt`)                                                                                   |
| 3   | Nenhuma migration pendente ou mudança de esquema          | ✔ `migration_precheck`: "pendentes (0): nenhuma". Diferença para a F′ sem nenhum arquivo em `packages/db`                                                                    |
| 4   | Ponto de recuperação antes de trocar os contêineres       | ✔ `cenario-staging-20261112T224601Z` (banco + arquivos + SHA-256), restauração de teste IDÊNTICA, cópia no bucket de backups, `backup_validate` OK                           |
| 5   | Somente as imagens autorizadas                            | ✔ ver seção 2                                                                                                                                                                |
| 6   | Sem alterar dados reais, permissões, usuários ou produção | ✔ nenhuma operação de escrita em dados. Impressão digital do banco idêntica (seção 6)                                                                                        |
| 7   | Sem migrations, limpeza de volumes ou exclusão de backups | ✔ O `migrate` do runner só **registrou** a versão: "pendentes (0)", "Database schema is up to date!". Banco idêntico antes e depois. Nenhuma limpeza; 19 backups preservados |
| 8   | F′ preservada como retorno                                | ✔ imagens da F′ (e da R2) **protegidas** na VM (seção 7)                                                                                                                     |
| 9   | API, Web, PostgreSQL, proxy e endpoints                   | ✔ seção 5                                                                                                                                                                    |
| 10  | Smoke, testes funcionais afetados e permissões            | ✔ na instância: smoke, WebSocket e suíte completa. Testes funcionais e de permissão: em réplica isolada da mesma versão (seção 5)                                            |
| 11  | Dados financeiros e operacionais íntegros                 | ✔ seção 6                                                                                                                                                                    |
| 12  | 5xx, memória e saúde dos contêineres                      | ✔ 0 respostas 5xx, 0 erros no log, memória estável (seção 8)                                                                                                                 |

Nenhuma divergência de versão, falha de integridade, erro crítico ou regressão. Não foi
necessário retornar.

## 5. Testes

**Na instância de homologação, após a ativação:**

| Verificação                             | Resultado                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                | 6/6 ✔: postgres, api e web `healthy`; caddy e backup `running`; `/api/ready` pelo proxy 200                                                                                                                                                    |
| `smoke_test`                            | 18/18 ✔: proxy exige senha (401), HTTPS + API + banco `ready`, tela de entrada 200, JavaScript 200, sem HTTP/3, certificado válido por mais 55 dias, último backup há 0 h, 37 migrations sem pendência, disco em 74%, memória disponível ~1 GB |
| `websocket_test`                        | ✔ `/api/realtime` pelo proxy: 401 sem sessão (esperado)                                                                                                                                                                                        |
| `run_homologation_tests suite=completo` | 27/27 ✔ (suítes saúde, acesso e websocket), 0 falhas                                                                                                                                                                                           |
| Logs da API e da web                    | 0 respostas 5xx, 0 registros de erro (nível ≥ 50)                                                                                                                                                                                               |

**Testes funcionais e de permissão.** Foram executados na réplica isolada da mesma versão
`696e3e9`, com build de produção e banco PostgreSQL 16. A sandbox não acessa o domínio da
homologação. Ver `HOMOLOGACAO-FUNCIONAL-CORRECOES-RELATORIO.md`:

- API: 1017/1017
- web: 26/26
- pacote compartilhado: 151/151
- E2E Chromium: 79/79
- navegação do gestor: 114 acessos, 0 problemas
- 5 perfis `HML-`: 215 acessos, 0 problemas, nenhum item de menu com 403
- fluxos permitidos e proibidos de B1–B6 e U1: 43/43 passos

A repetição desses testes **dentro da instância de homologação**, pela interface, fica para os
testes finais que você conduzirá.

## 6. Integridade dos dados

A `database_fingerprint` cobre 4383 linhas de verificação: contagens e somas por tabela,
incluindo as tabelas financeiras e operacionais. O resultado ficou **idêntico, sem nenhuma linha
diferente**, nos três momentos:

- antes do deploy, com a F′ ativa (`00-database_fingerprint.txt`);
- depois do registro da versão (`07b-fp.txt`);
- depois da ativação e de todos os testes (`16-database_fingerprint.txt`).

O ponto de recuperação teve restauração de teste IDÊNTICA ao banco (conteúdo, vínculos, catálogo e
valores). A versão nova não gravou nada no banco.

## 7. Estado dos contêineres e possibilidade de retorno

**Contêineres:**

| Contêiner       | Estado           | Memória (uso / limite) |
| --------------- | ---------------- | ---------------------- |
| api (`696e3e9`) | running, healthy | 117,7 MiB / 512 MiB    |
| web (`696e3e9`) | running, healthy | 137,6 MiB / 448 MiB    |
| postgres 16     | running, healthy | 93,5 MiB / 448 MiB     |
| caddy (proxy)   | running          | 36,8 MiB / 192 MiB     |
| backup          | running          | 14,2 MiB / 256 MiB     |

**Retorno, todos sem migration:**

1. **F′ `63674f1`, o caminho preferencial:** `rollback_version version=63674f1…`. É uma versão já
   ativada antes, com o mesmo esquema (37 migrations), e as imagens estão protegidas na VM. Os dados
   ficam como estão.
2. **R2 `341badb`:** mesmo esquema; imagens protegidas na VM.
3. **Ponto de recuperação `cenario-staging-20261112T224601Z`** (`rollback_to_recovery_point`): só
   se for preciso voltar também os dados ao estado das 22:46:01. Descarta o que for gravado depois
   disso.

## 8. Monitoramento

Duas medições, logo após a ativação e após o fechamento do portão. Resultados:

- respostas 5xx: 0;
- erros no log da API: 0;
- memória disponível estável entre 1022 MB e 1052 MB;
- swap usado: 150 MB de 2 GB;
- carga: 0,46;
- disco: 74%, 7,6 GB livres;
- portão: fechado.

## 9. Pendências

- **Sua decisão sobre o recebimento de material não técnico (seção 1).** Hoje a chegada já lança a
  entrada de estoque.
- **Testes finais pela interface, diretamente na homologação:** perfis e permissões,
  B1–B6 e U1, além de Safari e tablet físico. Aguardam suas instruções.
- Produção: não autorizada e não tocada.

## 10. Veredito

**Deploy de `696e3e9` em homologação concluído com sucesso.** A versão e os digests conferem. Não
houve migration. Os dados estão íntegros, com impressão digital idêntica. Todos os testes da
instância passaram. Não houve 5xx nem erros, e os recursos estão estáveis. A F′ `63674f1` segue
disponível para retorno imediato. A homologação aguarda os testes finais.
