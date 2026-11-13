# Produção — relatório de pré-deploy da versão `696e3e9`

Data: 13/11/2026. **Nada foi alterado na produção.** Não houve deploy, migration, reinício,
promoção de imagem, backup, permissão ou credencial alterada.

A leitura da produção foi feita por uma sessão no ambiente "Cenário — Produção", com a conta
`claude-operador-prod`, só com operações de classe `READ_ONLY` do catálogo, das 17:20:36 às
17:23:22 UTC. O relatório factual está em `PRODUCAO-AUDITORIA-LEITURA-696e3e9.md` e as saídas em
`docs/evidencias/producao-auditoria-696e3e9/`. Esta sessão, só com a credencial da homologação,
recebeu 403 da produção e não tentou contornar.

| Versão candidata | Valor                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Commit           | `696e3e9ddc5f1c803a4b9244a075ed498ad81be3`                                |
| API              | `sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f` |
| Web              | `sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72` |

O build intermediário `f007753` não é usado.

## Veredito: **NO-GO por enquanto**, com caminho definido para GO

Não há incompatibilidade de esquema nem problema nos dados ou na infraestrutura. As 4 migrations
são aditivas e de baixo risco, a produção está saudável e há folga de recursos. O NO-GO vem de
**três requisitos críticos ainda sem comprovação**:

1. **Retorno seguro depois das migrations não está pronto.**
   - Depois das 4 migrations, o runner **recusa** voltar para a versão atual `7b4177b`, porque a
     imagem dela não conhece as migrations novas (`rollback_version` → "use
     rollback_to_recovery_point").
   - Sobraria só a restauração do ponto de recuperação, que **apaga** o que for gravado depois. Pela
     sua regra, isso não é retorno aceitável.
   - Há uma versão de retorno que conhece as 37 migrations, a R2 `341badb`. Ela ainda **não foi
     promovida** para o registro da produção, e o retorno para ela **nunca foi ensaiado** com dados.
2. **A homologação manual final não foi executada.** O roteiro
   (`HOMOLOGACAO-MANUAL-FINAL-ROTEIRO.md`) é o seu próprio critério de bloqueio da produção. Faltam:
   - interface real com perfis e permissões;
   - B1–B6 e U1 na instância;
   - financeiro;
   - Safari e tablet físico;
   - memória durante uploads.
3. **A cópia externa dos backups e os snapshots não foram comprovados.**
   - A cópia diária para o bucket não está coberta por nenhuma operação de leitura autorizada.
   - A listagem de snapshots retornou 403 para `claude-operador-prod`.

Também precisam acontecer antes do deploy, sem bloquear a análise:

- promover as imagens da candidata para o registro da produção (hoje **ausentes**);
- rodar o `migration_precheck` real, que só funciona com a imagem na VM.

A seção 3.10 traz o procedimento completo. A seção 3.9 diz o que transforma o NO-GO em GO.

---

## Fase 1 — Auditoria da produção (resumo)

| #   | Item                              | Resultado                                                                                                                                                                                                                                                |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Versão ativa                      | **`7b4177b15a930b85d985a59a9182b579760c5a7b`** (22/10, "Segurança: next 15.5.28"): etiqueta, pilha, candidata e migrada. Imagens em execução: api `9932302…`, web `0ca94f8…`. Na VM também está `9fb1786`, protegida como versão do ponto de recuperação |
| 2   | Saúde                             | ✔ 5 contêineres saudáveis há 3 semanas; `smoke_test` 25/25 ✔; HTTPS, HSTS, 308/301; 6 rotas protegidas com 401; WebSocket 401 sem sessão; **certificado válido até 17/01/2027** (64 dias)                                                              |
| 3   | Capacidade                        | ✔ e2-medium. Memória: 2705 de 3924 MB livres. Swap: 33 MB de 2 GB. Disco: 29% (34 GB livres). Carga: 0,58. CPU dos contêineres < 0,3%                                                                                                                   |
| 4   | Migrations                        | 33 aplicadas, todas concluídas; idênticas byte a byte às 33 primeiras da candidata. **Faltam 4** (seção 3.3)                                                                                                                                             |
| 5   | Esquema                           | ✔ Nenhum objeto das 4 pendentes existe; todos os pré-requisitos existem. O `migration_precheck` não rodou (exige a imagem na VM)                                                                                                                        |
| 6   | Dados                             | Produção com **dados reais**: 7 clientes, 7 pedidos, 7 OS, 21 tarefas, 13 recebíveis, 23 eventos financeiros, 1 custo de OS, 2 compras, 6 usuários. Banco com 17 MB. Impressão digital registrada (`14-database_fingerprint.txt`)                        |
| 7   | Arquivos                          | 3 registros em `stored_files`; 5 volumes (98,9 MB); `/data/backups` com 23 MB. A **presença física** dos 3 arquivos não foi conferida (não há operação de leitura para isso)                                                                             |
| 8   | Backups                           | ✔ 28 pastas diárias (~16:41 UTC, retenção na VM); a mais recente tinha 40 min e o SHA-256 conferiu. **Não verificados:** cópia no bucket e snapshots (403)                                                                                              |
| 9   | Integrações e tarefas automáticas | seção 3.8                                                                                                                                                                                                                                                |
| 10  | Pacote × código auditado          | ✔ Detalhes logo abaixo                                                                                                                                                                                                                                  |

**Detalhe do item 10 (pacote):**

- `7b4177b` é **ancestral** de `696e3e9`: a candidata é a produção atual mais 80 commits, todos
  homologados.
- A sessão de leitura concluiu o contrário por causa de um clone raso. Corrigi no relatório dela.
- A branch padrão `07c9b46` também está contida na candidata.
- Depois de `696e3e9` a branch só tem testes e documentos.
- A correção de segurança `next@15.5.28` está na candidata.

**Logs (7 dias):**

- Proxy: 0 respostas 5xx em 4,8 mil requisições. API: 0 respostas 5xx e 0 erros nas ~20 h cobertas.
- Web: 7 mensagens "Server Reference ID did not match", que são requisições malformadas a Server
  Actions, provavelmente varreduras externas. Nenhuma virou 5xx.
- Postgres: 1 tentativa de cadastrar um dispositivo com nome repetido, em 11/11, recusada pelo
  índice único (comportamento esperado).

---

## Fase 3 — Relatório

### 3.1 Versão real ativa

`7b4177b`, ativada no deploy de 23/10. As 2 migrations dessa data foram aplicadas às 01:18 UTC,
com backup extra 1 minuto antes.

Os scripts administrativos da VM estão em `c32df97`.

### 3.2 Diferenças entre `7b4177b` e `696e3e9`

São 80 commits: as Fases 0 a 4 da Reformulação e as correções da homologação (B1–B6 e U1). No
código, 174 arquivos de `apps`, `packages` e `infra` (+17,1 mil/−0,9 mil linhas). Tudo foi
validado na homologação: API 1017, web 26, E2E 79/79, auditorias de navegação e perfis com
0 problemas, e deploy em homologação sem 5xx.

**Mudanças de comportamento que os usuários reais vão notar:**

| Módulo                | Mudança                                                                                                                             | O que acontece no 1º dia                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Interruptores (novos) | Logística, Pedidos de ajuda, Embalagem obrigatória, Travas de materiais                                                             | A tabela nasce **vazia**: os 4 ficam **ligados**, com o comportamento de hoje. Nada muda sem ação do gestor                     |
| Produção              | Menu de Produção reorganizado (8 itens); Programação semanal unificada; mapa da oficina; modelos de serviço com materiais sugeridos | A equipe precisa de orientação: as telas mudam de lugar                                                                         |
| OS                    | OS com 6 abas e estado no cabeçalho; lista de materiais da OS; entrega direta pela OS, com reversão controlada                      | Endereços antigos redirecionam                                                                                                  |
| Estoque               | Estoque simples da oficina; recebimento mantido como hoje                                                                           | **A conferência obrigatória aprovada não está nesta versão**                                                                    |
| Qualidade             | "Tudo conforme" no tablet; autoaprovação do gestor exige justificativa (auditada)                                                   | Sem inspeções na produção hoje (0 linhas)                                                                                       |
| Entregas              | Entrega direta e reversão; ocorrências logísticas como antes                                                                        | Nenhuma entrega na produção hoje (0 linhas)                                                                                     |
| Financeiro            | Conciliação do custo de material informado × compra formal; nenhum cálculo existente muda                                           | Há 1 custo de OS e 2 compras. Pode surgir aviso de **conciliação pendente**, que é só um aviso. Os valores realizados não mudam |
| Fotos                 | Miniaturas, orientação, remoção de localização (GPS); confirmação antes de remover; 404 para arquivo ausente                        | As 3 fotos antigas ganham miniatura na primeira abertura, gerada a partir da original                                           |
| Permissões            | Menu passa a seguir exatamente as permissões da API (B1, B2, B5, B6)                                                                | Nenhuma permissão criada ou removida. Alguém pode **deixar de ver** um item que antes dava erro                                 |
| Painel                | "Hoje", ações sugeridas, alertas internos                                                                                           | Ver seção 3.8                                                                                                                   |

**Infraestrutura.**

- Entre `c32df97` e a candidata, `infra/prod` só ganhou a página comercial `/conheca`:
  `SITE_COMERCIAL=1` no compose e a exceção de indexação no Caddy.
- **O plano não atualiza os scripts da VM** (`vm_scripts_update` fica fora). Por isso `/conheca`
  continua respondendo 404 e o proxy não muda.
- Publicar a página comercial é uma decisão separada.

### 3.3 Migrations necessárias e riscos

Pela leitura do SQL e das contagens reais:

| #   | Migration                                  | Muda tabelas existentes?                                                                                                                                                              | Risco                                                        |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `20270302000000_modulos_configuraveis`     | Não. Cria `module_settings`, com FK para `users`                                                                                                                                      | Baixo: lock curto em `users` (6 linhas)                      |
| 2   | `20270309000000_materiais_estoque_entrega` | `deliveries`: `origin NOT NULL DEFAULT 'LOGISTICA'`, só metadado no PG 16, tabela vazia. `service_order_costs`: CHECK ampliado (+`MATERIAL_OS`), revalida 1 linha que continua válida | Baixo. Cria 5 tabelas, com a de ajustes imutável por gatilho |
| 3   | `20270316000000_reformulacao_fase_2`       | `stored_files`: 6 colunas anuláveis, índice único e CHECK (3 linhas, todas válidas)                                                                                                   | Baixo                                                        |
| 4   | `20270323000000_reformulacao_fase_3`       | `quality_inspections` (0 linhas): `packaging_required NOT NULL DEFAULT true` e justificativa anulável. `deliveries` (0 linhas): 3 colunas anuláveis e CHECK                           | Baixo; depende da #2, garantida pela ordem dos nomes         |

**Proteções que já existem:**

- Nenhuma migration apaga, converte tipo ou faz preenchimento retroativo.
- As 4 já rodaram na homologação em duas etapas, com dados, e a impressão digital ficou íntegra.
- `vm.sh migrar` exige um ponto de recuperação com no máximo 240 min, com o banco idêntico a ele.
- Uma falha parcial é detectada: a API não sobe e o procedimento manda recuperar pelo ponto.

### 3.4 Dados e arquivos

- Íntegros pelos indicadores lidos: contagens, impressão digital, nenhum bloqueio e nenhuma consulta
  longa.
- **Pendência:** confirmar que os 3 arquivos físicos de `stored_files` existem. Depois da
  ativação, o gestor abre as 3 fotos; com a correção B3, um arquivo ausente aparece como "não
  encontrado", sem erro 500.
- Hoje não há operação de leitura que confira arquivos na produção (na homologação foi o
  `auditar-arquivos.sh`, rodado por você).

### 3.5 Capacidade

| Recurso                 | Situação                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Disco                   | Folga ampla: o par da candidata ocupa ≈ 8 GB e a R2 mais ≈ 8 GB; ficariam ≈ 18 GB livres (o mínimo do preparo é 10 GB) |
| Memória                 | 2,7 GB livres                                                                                                          |
| Limites da API e da web | Maiores que na homologação (1 GiB e 640 MiB)                                                                           |
| VM                      | Não precisa de mudança                                                                                                 |

### 3.6 Backups e recuperação

**Comprovado:**

- backup diário com SHA-256, 28 dias na VM;
- o mais recente íntegro;
- o ponto de recuperação do deploy faz backup, restauração de teste **em banco separado**
  comparada item a item e envio ao bucket.

**Não comprovado:** a chegada das cópias ao bucket `cenariogestao-prod-backups` e os snapshots
diários.

O ponto de recuperação registrado na VM é o do banco **vazio** (`9fb1786`). Um ponto novo, com os
dados reais, só nasce no próprio deploy.

### 3.7 Rollback: viabilidade e limites

| Momento da falha                                             | Retorno                                                                                                                               | Perda de dados                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Antes do `migrate` (preparo, precheck, ponto de recuperação) | `maintenance_off`: volta a `7b4177b`                                                                                                  | Nenhuma                                                                                                 |
| `migrate` falha, mesmo parcialmente                          | `rollback_to_recovery_point` para o ponto criado **com a aplicação parada**                                                           | **Nenhuma**: nada foi gravado depois do ponto                                                           |
| Depois de ativar, ainda dentro da janela, sem uso real       | `rollback_to_recovery_point`                                                                                                          | Nenhuma, se a impressão digital provar que só mudaram tabelas técnicas (notificações, eventos, sessões) |
| Depois de reabrir para a equipe                              | **Retorno da aplicação para a R2 `341badb`** (pré-requisito R-1). Alternativa: F′ `63674f1`, se o problema for só das correções B1–B6 | Nenhuma: banco intocado. **Não** voltar ao backup antigo                                                |
| Direto para `7b4177b`                                        | **Impossível** depois das migrations (o runner recusa)                                                                                | —                                                                                                       |

**Como a R2 se comporta:**

- A R2 é `7b4177b` + Fase 1 + as 37 migrations + a guarda de retorno. Ela **não é idêntica** à
  versão atual: mantém as funções da Fase 1 (lista de materiais, entrega direta, interruptores).
- A guarda **recusa** iniciar se houver peça aprovada sem embalagem e não entregue. A página
  `/api/v1/system/rollback-readiness` mostra isso antes.
- Para ativar a R2 na produção, a sequência é:
  1. `prepare_version`;
  2. `maintenance_on`;
  3. `recovery_point_create`;
  4. `migrate`, que só registra a versão (sem pendências);
  5. `activate_version`.

  É o mesmo caminho só de aplicação usado na homologação em 12/11, com cerca de 3 min fora do ar.

**A versão anterior funciona com o esquema novo?** Funciona no nível do banco: as migrations são
aditivas e o código antigo ignora tabelas e colunas novas. Quem não aceita é o runner, porque a
imagem antiga não conhece a cadeia de migrations. Daí a necessidade da R2. O comportamento da
versão antiga com dados novos foi medido na revisão da Fase 1
(`REFORMULACAO-FASE-1-REVISAO-FINAL.md` §4):

- a logística e as travas voltam a valer;
- entrega direta aparece no roteiro como concluída;
- o custo `MATERIAL_OS` continua nos relatórios.

### 3.8 Integrações e tarefas automáticas

- **Nenhuma integração externa.** A API não chama serviços de fora: sem e-mail, WhatsApp, webhook
  ou pagamento. Os alertas são só o sininho interno.
- **Tarefas automáticas que já rodam hoje:**
  - manutenção a cada 15 min (apaga chaves de idempotência, limites e sessões expiradas);
  - liberação de tarefas programadas;
  - presença e ausência;
  - fila de ajuda e riscos de ocorrência;
  - processamento de eventos;
  - conexão em tempo real.
- **Nova:** os alertas operacionais, a cada 5 min.
  - Logo depois da ativação, eles podem criar avisos para OS reais com prazo em risco, peças
    prontas sem entrega ou material faltante.
  - **Não alteram dados de negócio** e somem sozinhos quando a condição acaba.
  - Avise o gestor de que o sininho vai "acordar".
- Os eventos de domínio e as notificações crescem normalmente com o uso. A impressão digital pós-deploy
  deve mostrar mudança **só** em `notifications`, `domain_events`, `sessions`, `audit_logs` e nas
  tabelas novas.

### 3.9 Pendências, riscos residuais e caminho para GO

**Pré-requisitos (bloqueantes):**

| ID  | Pré-requisito                                                                                                                                                                                                                                                         | Quem                           | Altera produção?                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| R-1 | Ensaiar **na homologação** o retorno para a R2 com o esquema de 37 migrations e dados `HML-`: a guarda bloqueia, a guarda libera, a R2 sobe, os dados ficam preservados e depois volta para `696e3e9`. Precisa da sua autorização (operações MUTATING na homologação) | eu, pelo runner da homologação | Não                                                            |
| R-2 | Promover para o registro da produção as imagens da **candidata** e da **R2**, conferindo os digests, com `infra/prod/gcp/promover-imagens.sh` na sua conta do Cloud Shell (ver abaixo)                                                                                | você                           | Só o registro (cópia por digest; nenhuma etiqueta sobrescrita) |
| R-3 | Executar o roteiro da homologação manual final e ter todas as funcionalidades críticas APROVADAS                                                                                                                                                                      | você e eu                      | Não                                                            |
| R-4 | Comprovar a cópia externa e os snapshots com 2 comandos só de leitura no Cloud Shell (ver abaixo)                                                                                                                                                                     | você                           | Não                                                            |

**Comandos de R-2:**

```bash
infra/prod/gcp/promover-imagens.sh 696e3e9ddc5f1c803a4b9244a075ed498ad81be3 \
  sha256:264884b38b02de22357a07486e2d665008507444a0d84590a24d4aaf8455cb4f \
  sha256:cb76d474f14e79234893497a05c9220152f4f4e1f8bf1c58818519d30e54ae72
infra/prod/gcp/promover-imagens.sh 341badb59624996cd95c1213808c51631bf34b92 \
  sha256:b272404e79719dd1b7151502a9681c75be85614362252d688beab59d1c659df7 \
  sha256:8559184d2e2d5b1a07a8b19782a02cd4836136e306032cca5e3d07099d27f5f8
```

Os digests da R2 são os registrados na homologação. O próprio script recusa se o digest de origem
não bater.

**Comandos de R-4:**

```bash
gcloud storage ls -l gs://cenariogestao-prod-backups/ | tail -5
gcloud compute snapshots list --filter="sourceDisk~cenario-prod" --format="table(name,creationTimestamp,status)" | tail -5
```

**Ressalvas não bloqueantes (com mitigação):**

- Mudança grande de interface para a equipe: avisar antes e fazer uma orientação de 15 min no
  primeiro dia.
- Aviso de conciliação pendente no custo existente: o gestor revisa; os valores não mudam.
- O `migration_precheck` real só roda depois do `prepare_version`: ele é **critério de parada** no
  procedimento.
- Conferir os 3 arquivos físicos depois da ativação.
- Logs da API cobrem só ~20 h pelo teto do catálogo: o proxy cobre os 7 dias e mostra 0 respostas
  5xx.

Com R-1 a R-4 concluídos e sem falha, o resultado esperado é **GO COM RESSALVAS** (as ressalvas
acima).

### 3.10 Procedimento exato de implantação

**Não executar sem sua autorização expressa.**

Todos os comandos rodam numa sessão do ambiente "Cenário — Produção", com
`export CENARIO_AMBIENTE=prod` e `O="python3 infra/homolog/gcp/autonomia/operar.py"`.

**Antes da janela (sem indisponibilidade):**

| #   | Comando                                                                                            | Critério de parada                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `$O verificar`; `$O op version`; `$O op gate_status`; `$O op health`; `$O op database_fingerprint` | Versão diferente de `7b4177b`, contêiner sem saúde ou portão aberto sem motivo → **parar**                                                                     |
| P2  | `$O imagens 696e3e9…` e `$O imagens 341badb…`                                                      | Ausente ou digest diferente → **parar**                                                                                                                        |
| P3  | `$O op gate_open`                                                                                  | —                                                                                                                                                              |
| P4  | `$O op prepare_version version=696e3e9…`                                                           | Digests na VM diferentes dos autorizados ou menos de 10 GB livres → **parar**                                                                                  |
| P5  | `$O op migration_precheck version=696e3e9…`                                                        | Qualquer valor diferente de "pendentes (4): …" com 0 divergentes, desconhecidas ou fora de ordem, ou verificação de dados reprovada → **parar** e `gate_close` |
| P6  | `$O op prepare_version version=341badb…` (deixa a R2 pronta na VM)                                 | Falha → **parar**: sem retorno pronto, sem deploy                                                                                                              |

**Janela de manutenção:** 30 min reservados, com indisponibilidade estimada de **3 a 6 min**.
Avisar a equipe com 24 h de antecedência, escolher um horário sem tablets em uso (por exemplo,
depois do expediente) e informar que as telas mudam.

| #   | Comando                                                                 | Critério de parada / ação                                                                                                                                                             |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | `$O op maintenance_on`                                                  | —                                                                                                                                                                                     |
| J2  | `$O op recovery_point_create`                                           | A restauração de teste precisa sair IDÊNTICA e o envio ao bucket precisa funcionar. Se não → `maintenance_off` e **parar**                                                            |
| J3  | `$O op backup_validate folder=<ponto J2>`; `$O op database_fingerprint` | SHA divergente → `maintenance_off` e **parar**                                                                                                                                        |
| J4  | `$O op migrate version=696e3e9…`                                        | Precisa terminar com "4 aplicadas, 37 no total". **Falha, mesmo parcial → NÃO ativar**: `$O op rollback_to_recovery_point` (sem perda: a aplicação estava parada desde J2) → `health` |
| J5  | `$O op migration_verify version=696e3e9…`; `$O op database_fingerprint` | Diferença fora das tabelas novas e das colunas previstas → `rollback_to_recovery_point`                                                                                               |
| J6  | `$O op activate_version version=696e3e9…`                               | API sem saúde em 2 min → `rollback_to_recovery_point` (ainda sem uso real)                                                                                                            |
| J7  | Smoke da seção 3.11                                                     | Qualquer ✘ crítico → decidir: `rollback_to_recovery_point` se ainda não houve uso; retorno para a R2 se já houve                                                                      |
| J8  | `$O op gate_close`                                                      | —                                                                                                                                                                                     |

**Critérios objetivos de interrupção (qualquer um):**

- versão ou digest divergente;
- precheck com divergência;
- ponto de recuperação sem restauração IDÊNTICA;
- falha na migration;
- API sem saúde;
- qualquer 5xx no smoke;
- impressão digital com mudança fora do previsto;
- memória disponível abaixo de 500 MB;
- rota financeira ou gerencial respondendo sem autenticação.

### 3.11 Verificação depois do deploy

**Automática (J7):**

- `health`;
- `smoke_test`: 25 checagens, incluindo certificado, 308/301, HSTS e 6 rotas com 401;
- `websocket_test`;
- `container_logs service=api`: 0 respostas 5xx e 0 erros de nível ≥ 50;
- `resources`;
- `database_fingerprint`.

**Manual, pelo gestor, em leitura** (sem criar transação; 10 min):

1. Entrar e sair (B4).
2. Início "Hoje".
3. Abrir 2 OS reais: as 6 abas, o estado, as fotos e as 3 fotos antigas (miniatura).
4. Financeiro → Painel e Resultado por OS: os **mesmos totais** da captura feita antes do deploy.
5. Programação semanal, Estoque, Qualidade e Expedição abrem sem erro.
6. Funções e permissões: nada mudou.
7. Um usuário de cada função entra e o menu dele não mostra itens com erro.
8. Tablet: entrar com PIN e ver as tarefas.

### 3.12 Monitoramento depois do deploy

| Quando                             | O quê                                                             | Limite                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 30 min, 2 h e 24 h após a ativação | `resources`, `health`, `container_logs service=api` (5xx e erros) | Memória disponível > 1 GB; API < 700 MiB de 1 GiB; swap < 500 MB; 0 respostas 5xx; nenhum reinício de contêiner |
| 24 h                               | `database_fingerprint`                                            | Comparar com J5: crescimento só de uso normal                                                                   |
| Dia seguinte                       | `backup_list` + `backup_validate`                                 | O backup das 16:41 existe e confere                                                                             |

Durante as primeiras 24 h, a equipe registra qualquer estranheza com a hora. A decisão de retorno
para a R2 é sua, com a página de prontidão consultada antes.

---

## Itens pedidos × onde estão

| Fase 2 — item                                             | Seção                                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Backup consistente, com integridade e cópia externa    | J2–J3; R-4                                                                                                                               |
| 2. Restauração testável em ambiente isolado               | J2: a restauração de teste vai para banco separado na VM, sem tocar o banco da produção. Dados reais não vão para a homologação (sigilo) |
| 3. Rollback preservando financeiro, OS, anexos e estoque  | 3.7; R-1 e R-2                                                                                                                           |
| 4. Critérios de interrupção                               | 3.10                                                                                                                                     |
| 5. Monitoramento                                          | 3.12                                                                                                                                     |
| 6. Janela, indisponibilidade e comunicação                | 3.10                                                                                                                                     |
| 7. Smoke tests                                            | 3.11                                                                                                                                     |
| 8. Validação dos fluxos críticos                          | 3.11; R-3                                                                                                                                |
| 9. Falha parcial de migration                             | J4                                                                                                                                       |
| 10. Compatibilidade da versão anterior com o esquema novo | 3.7                                                                                                                                      |
