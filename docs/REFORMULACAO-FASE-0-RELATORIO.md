# Reformulação — Fase 0: fundação, pedidos de ajuda desligáveis e privacidade dos tablets

Estado: **implementada e testada em ambiente isolado. NÃO aplicada em homologação nem produção.**
Base: `07c9b46` (branch padrão). Branch de trabalho: `claude/beautiful-curie-k2kvce`.

## 1. Escopo

| Item                                                                                 | Entregue                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Interruptores de funcionalidade (logística, pedidos de ajuda, embalagem obrigatória) | sim; padrão = tudo ligado                                                   |
| Desativação operacional dos pedidos de ajuda (servidor e telas)                      | sim; reversível                                                             |
| Logística e embalagem desligáveis                                                    | **não** (fora da fase): as chaves existem, mas o servidor recusa alterá-las |
| Estado operacional centralizado da OS                                                | núcleo técnico (função pura + rota de leitura), sem tela                    |
| Privacidade dos tablets                                                              | sim (filtro global, qualidade, avisos)                                      |

Nada do financeiro, de materiais, de entrega, de logística ou de qualidade mudou de regra.

## 2. Interruptores de funcionalidade

- **Catálogo único:** `packages/shared/src/modules.ts` (`MODULES`, `resolveModules`).
  - Sem registro = padrão (ligado). Chave desconhecida é ignorada.
  - Chave ainda não configurável (logística, embalagem) fica sempre no padrão, mesmo com registro gravado.
- **Banco:** tabela nova `module_settings` (migration `20270302000000_modulos_configuraveis`), só aditiva e vazia.
  - Uma linha por funcionalidade alterada: estado, versão, quem e quando.
  - CHECKs de formato da chave e de versão.
- **Leitura central no servidor:** `apps/api/src/core/modules.ts` (`moduleState`, `assertModuleEnabled`).
  - Sem cache: vale na hora para todas as instâncias.
- **Rotas:**
  - `GET /api/v1/modules`: qualquer sessão válida; só booleanos.
  - `GET /api/company/modules`: painel, `empresa.ver`.
  - `PUT /api/company/modules/:key`: painel, `empresa.configurar`.
    - Versão conferida sob o bloqueio da linha da empresa.
    - Auditoria `company.module_updated` e evento `company.module_updated` (só chave e estado).
    - Repetir o mesmo estado não grava nada.
    - Chave não configurável responde 422; chave inexistente, 404.
- **Interface:** Empresa → "Funcionalidades" (`apps/web/components/admin/company-page.tsx`).
  - Só "Pedidos de ajuda" é alterável.
  - Mostra quem alterou e quando.

**Isolamento entre empresas:** o sistema é de **empresa única por instalação**. Não há `tenantId` ou `companyId` no schema, e `company_settings` tem um único registro, garantido por CHECK. O isolamento é por instalação: produção e homologação usam bancos separados. A configuração vive no banco de cada instalação, então uma instalação não altera a outra. Não foi criado multi-tenancy, porque estaria fora do escopo e da arquitetura atual.

## 3. Pedidos de ajuda desligados

**Servidor (fonte da regra):**

- Recusa com `409 MODULE_DISABLED`:
  - `POST /help-requests`
  - `POST /help-requests/prolonged`
  - `POST /help-requests/:id/assign`
  - `POST /help-requests/process`
- A fila automática (timer e gatilhos de presença, produção e ocorrências) não atribui, não escala e não avisa (`help/queue.ts`).
- A Central não lista pedidos de ajuda nem propostas nascidas deles.
- A caixa de avisos esconde os avisos `AJUDA_*`, na lista e no contador.

**Continua igual:**

- iniciar, pausar, retomar e concluir;
- qualidade, ocorrências, transferência de tarefa e tarefas alternativas;
- competências e candidatos, usados por qualidade e ocorrências.

**Histórico e reversão:**

- Nada é apagado: os pedidos antigos ficam como estão.
- O gestor consulta e pode cancelar os pedidos antigos em `/painel/ajuda`, que mostra o aviso "desativados".
- **Religar:** os avisos voltam, os pedidos pendentes voltam à fila e novos pedidos são aceitos.

**Telas:**

- O tablet esconde "pedir ajuda" e "meus pedidos".
- O menu esconde "Pedidos de ajuda".
- O aviso do Planejamento e do Quadro mostra só as reprogramações.

## 4. Estado operacional da OS (núcleo técnico)

- **Função:** `packages/shared/src/operational-state.ts`.
  - É derivada da etapa gravada da peça (`fulfillmentStage`, a fonte canônica) e, enquanto a peça está em produção, das tarefas obrigatórias, pelo mesmo recorte de `requiredTaskWhere`.
  - **Estados:** NAO_PLANEJADA, AGUARDANDO_MATERIAIS, PRODUCAO_IMPEDIDA, PRONTA_PARA_PRODUCAO, EM_PRODUCAO, CORRECAO_NECESSARIA, AGUARDANDO_QUALIDADE, EMBALAGEM, PRONTA_PARA_ENTREGA, EM_ENTREGA, ENTREGUE, DEVOLVIDA, CANCELADA.
  - A OS assume o estado da peça ativa menos avançada, com a contagem por estado.
- **Rota:** `GET /api/v1/service-orders/:id/operational-state`, só painel com `os.ver`. Somente leitura: o teste prova que nada é gravado.
- **Limitações explícitas:**
  - "Aguardando materiais" vem do bloqueio MATERIAIS das tarefas (marcação por material é Fase 1).
  - "Entregue" só existe com entrega concluída (Fase 1).
  - EMBALAGEM existe enquanto a embalagem for obrigatória.
  - Peça sem tarefa publicada é NAO_PLANEJADA, nunca presumida pronta.

## 5. Privacidade dos tablets

**Achados por varredura de todas as rotas GET acessíveis a tablet** (catálogo de rotas da própria API):

- Tablet do inspetor recebia o nome completo do cliente em `/quality/inspections` e `/quality/inspections/:id`. O DTO usa o campo `customer`, e o filtro antigo só tratava `customerName` em cinco módulos.
- O aviso `INSPECAO_ATRIBUIDA` levava o nome completo no texto.
- Nenhum endereço, telefone, e-mail, documento ou valor chegava a tablets de produção.
- "Minhas viagens" já é filtrada no servidor às paradas da própria pessoa (necessidade operacional), ao contrário do que a auditoria supôs.

**Correções:**

- O filtro passou a ser **global e restritivo por padrão** (`apps/api/src/core/device-privacy.ts`, registrado na raiz).
  - Em toda resposta a sessão de tablet, `customerName` e `customer` (texto, ou objeto com `name`) viram "Nome I.".
  - **Única exceção:** quem tem `logistica.executar` numa rota de logística (o motorista precisa do contato de quem recebe).
  - Os registros por módulo foram removidos, para não duplicar a regra.
- **Avisos:** na leitura por tablet, o nome do cliente da OS vinculada vira a forma reduzida. O texto gravado e o painel continuam completos.

**Situações preservadas:**

- O painel continua com os dados completos.
- "Meus ganhos": só o próprio funcionário, com PIN e 5 minutos; já coberto por `meus-ganhos.test.ts` (casos 25 a 35), sem alteração.
- Tempo real: os eventos dos tablets não carregam dados pessoais (comprovado na varredura).

**Fotos (EXIF):** os uploads guardam os bytes originais (`core/storage/upload.ts` só detecta o tipo). Fotos de celular podem carregar a localização GPS.

- **Não corrigido nesta fase.** Remover EXIF sem tratar a orientação deixaria fotos tortas no tablet. A solução correta exige reprocessar a imagem (girar pela orientação e regravar sem metadados) com uma biblioteca de imagem, junto das miniaturas.
- Fica proposto para a Fase 2, já prevista no plano.
- As fotos só são servidas por rota autenticada (`/api/files/:id`), sem URL pública.

## 6. Migration e compatibilidade

- `20270302000000_modulos_configuraveis`: cria uma tabela vazia.
  - **Compatibilidade:** a versão anterior da aplicação ignora a tabela. A versão nova, sem linhas, se comporta como a anterior.
  - **Reversão:** `packages/db/rollback/20270302000000_modulos_configuraveis.down.sql`. **Recusa** se alguma funcionalidade estiver desligada (a versão anterior a trataria como ligada sem aviso); com tudo ligado, nada se perde.
- O ensaio `scripts/test-evolution-migrations.sh` inclui a migration:
  - reverte e reaplica sem dados;
  - recusa a reversão com a ajuda desligada.
- **Trava estrutural** (`rodada4-travas-estruturais.test.ts`): uma exceção justificada. O `ON UPDATE CASCADE` da chave estrangeira não é comando destrutivo.

## 6.1 Testes executados (ambiente isolado: PostgreSQL 16 local descartável, sem rede externa)

| Suíte                                                                                    | Resultado                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Linha de base da API no commit original `07c9b46` (antes de qualquer mudança)            | 934 aprovados, 0 falhas, 13 ignorados (condicionais: binário do Caddy)          |
| API completa nesta branch                                                                | **941 aprovados, 0 falhas**, 13 ignorados (= linha de base + 7 novos)           |
| `packages/shared`                                                                        | 149 aprovados (15 novos)                                                        |
| `apps/web`                                                                               | 21 aprovados                                                                    |
| `scripts/test-evolution-migrations.sh` (cadeia desde o legado, reversão, recusa, backup) | aprovado; a migration nova reverte, reaplica e é recusada com a ajuda desligada |
| E2E (Playwright, Chromium): `fase0-funcionalidades`, `tablets`, `team-help`, `gestao`    | 5 aprovados                                                                     |
| Formatação, lint e tipos                                                                 | limpos                                                                          |

**Não executados:**

- O restante dos E2E (cerca de 35 specs), a cargo do CI.
- Os testes de proxy com Caddy real, por falta do binário local.
- Tablet físico e Safari/WebKit.

## 7. Plano de homologação (não executado; depende de autorização)

1. **Pré-verificações:**
   - CI verde no commit;
   - `operar.py verificar` em homologação;
   - portão fechado;
   - backup recente.
2. **Imagens** do commit pelo gatilho de build da homologação.
3. **Sequência de operações:**
   - `prepare_version`, `recovery_point_create`;
   - `migration_precheck` (1 pendente);
   - `migrate` (34/34);
   - `activate_version`.
4. **Smoke tests:** `smoke_test`, `run_homologation_tests suite=completo`, `migration_verify`.
   - `GET /api/v1/modules` deve dar tudo ligado.
   - Os tablets devem funcionar como antes.
5. **Teste funcional:**
   - desligar "Pedidos de ajuda" em Empresa;
   - no tablet físico: sem botão de ajuda; iniciar, pausar, retomar e concluir;
   - inspetor vê "Nome I.";
   - Central sem itens de ajuda;
   - religar e conferir o retorno.
6. Validar em **tablet físico (Safari/WebKit)**, que nunca foi comprovado (F4-21).

## 8. Rollback

- **Funcional, sem deploy:** religar "Pedidos de ajuda" em Empresa.
- **Aplicação:** `rollback_version` para a versão anterior. O banco continua compatível, porque a tabela nova é ignorada.
- **Banco** (só se necessário, com a aplicação parada):
  - religar tudo;
  - aplicar o `.down.sql`, que recusa se houver algo desligado;
  - ou `rollback_to_recovery_point`.

## 9. Riscos remanescentes

- **Filtro global:** um DTO futuro que use outro nome de campo para o cliente (ex.: `clientName`) não seria reduzido. A varredura automática nos testes detecta esse caso, desde que o cenário alcance a rota.
- **Avisos sem OS vinculada:** por exemplo, os de entrega para o motorista mantêm o nome no texto. Isso é aceito porque o motorista já recebe o contato completo nas rotas de logística.
- **Propostas de reprogramação nascidas de ajuda**, ainda pendentes ao desligar, continuam visíveis na tela de Reprogramação (não na Central) até o gestor decidir.
- **Tablet físico e Safari** não testados nesta fase.
