# Auditoria técnica e operação — Cenário Gestão (12/10/2026)

Legenda usada em todo o documento:

- **[FATO]** — comprovado nesta auditoria por comando, teste ou leitura de código (evidência citada);
- **[INFERÊNCIA]** — conclusão provável a partir de fatos, não verificada diretamente;
- **[NÃO VERIFICADO]** — não foi possível conferir daqui; exige acesso que a auditoria não teve.

Escopo autorizado: C1, C2, C4 e C5 implementados; C3 só investigado e desenhado (§9). Nenhum
deploy, Cloud Build, migration em ambiente real, reset de banco ou mudança de infraestrutura.

## 1. Estado inicial

- **[FATO]** Branch única `claude/cenario-gestao-fase-1-zf3bj2` (sem `main`, sem pull requests);
  HEAD local = remoto = `a337ea6` (fim da Simplificação Fase 4), árvore limpa.
- **[FATO]** CI (`.github/workflows/ci.yml`) vermelho em 23 execuções seguidas (nº 64–86),
  todas paradas em `pnpm format:check`; última verde: nº 63 (`9f29300`). Desde então o CI não
  executava lint, typecheck, migrations, build, testes nem E2E.
- **[FATO]** Local: lint e typecheck sem erros; 21 migrations sem divergência de schema;
  `pnpm audit --prod` sem vulnerabilidades; E2E 32/32; API 425 aprovados, 1 falha intermitente,
  5 ignorados por desenho.
- **[FATO]** Esta auditoria não tem credenciais do Google Cloud (`gcloud` sem conta) e o proxy de
  rede bloqueia `teste.cenariogestao.com.br` (403).

## 2. Problemas encontrados (com evidência)

| #   | Problema                                                                                                   | Classe                               | Evidência                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | CI quebrado em `format:check`                                                                              | [FATO]                               | Execuções 64–86; arquivos `docs/evidencias/**/geometria.json` gerados por `tests/e2e/specs/zz-geometria.spec.ts` com `JSON.stringify`                        |
| P2  | Versão publicada na homologação desconhecida; documentos divergem (`fd6dc19` "não confirmada" × `eb3fe2a`) | [NÃO VERIFICADO]                     | Sem acesso ao projeto `cenariogestao` nem ao domínio                                                                                                         |
| P3  | Limite global de requisições contornável com cookie aleatório                                              | [FATO] (código)                      | `apps/api/src/app.ts`: `keyGenerator` usa o hash do cookie **sem validá-lo**; cada valor novo ganha um balde novo de 600/min                                 |
| P4  | `GET /api/sync/events` lia toda a tabela de eventos após `since` e filtrava a visibilidade em memória      | [FATO] (código)                      | `apps/api/src/modules/sync/routes.ts` antes de `6d37184`                                                                                                     |
| P5  | Teste WebSocket intermitente sob carga                                                                     | [FATO]                               | `integrated-evolution` "7. reordenar" estourou 5 s com o E2E em paralelo; 9/9 isolado (3×)                                                                   |
| P6  | `braces` (alta) em dependência só de desenvolvimento, sem correção publicada                               | [FATO]                               | via `@next/eslint-plugin-next`; `pnpm audit --prod` limpo                                                                                                    |
| P7  | Documentação operacional desatualizada                                                                     | [FATO]                               | `OPERACAO.md` "nenhum deploy foi feito"; `HOMOLOGACAO.md` §1–2 "migrations na partida" e `up -d --build`, contra `MIGRATE_ON_START=0`; retenção 14 × 30 dias |
| P8  | Pontos menores de segurança (ver §9, "Pendências")                                                         | [FATO] código / [INFERÊNCIA] impacto | Login, bloqueio de PIN, afirmações de `SEGURANCA.md`, registro de erros                                                                                      |

Pontos positivos confirmados **[FATO]**: senhas e PIN com argon2id; token opaco armazenado como
HMAC; conferência de `Origin` em todo método não-GET; rotas de teste só com `APP_ENV=test`;
nenhum segredo versionado.

## 3. Correções executadas

| Item | O quê                                                                                                                                                                                                                          | Commit      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| C1   | `.prettierignore` passa a ignorar **só** `docs/evidencias/**/geometria.json` (5 arquivos, todos gerados pelo E2E de geometria). Código-fonte e demais documentos continuam verificados (`prettier --file-info`).               | `d40d354`   |
| C2   | `WsClient.waitFor` (testes) reage a cada mensagem em vez de consultar em intervalos; prazo 5 s → 15 s. Timeout ou conexão fechada continuam **reprovando**, com as mensagens recebidas na mensagem de erro.                    | `ff9cfc5`   |
| C4   | `/api/sync/events`: leitura em lotes de 500, no máximo 5000 eventos examinados por chamada, cursor `nextSince`. Contrato anterior (`events`, `hasMore`) mantido; `nextSince` é aditivo. Sem migration, sem alteração de dados. | `6d37184`   |
| C5   | `OPERACAO.md` e `HOMOLOGACAO.md` alinhados ao código (migrations explícitas, imagens do registro, retenção, estado de publicação não verificado) e este relatório.                                                             | este commit |

Garantias do cursor de C4 (`nextSince`): todo evento com `since < seq ≤ nextSince` foi examinado
e, se visível, está nesta página ou numa anterior. Página cheia → cursor no último evento
**devolvido**; limite de leitura → cursor no último **examinado** (eventos invisíveis não são da
sessão, então nada se perde). A ordem de `seq` segue a ordem de commit (trava em `appendEvent`).

## 4. Arquivos alterados

- `.prettierignore` (C1)
- `apps/api/test/helpers.ts` (C2)
- `apps/api/src/modules/sync/routes.ts`, `apps/api/test/sync-events.test.ts` (novo) (C4)
- `docs/OPERACAO.md`, `docs/HOMOLOGACAO.md`, `docs/AUDITORIA-TECNICA-OPERACAO.md` (novo) (C5)

Migrations: **nenhuma**.

## 5. Commits

`d40d354` (C1) → `ff9cfc5` (C2) → `6d37184` (C4) → commit de C5 (documentação), todos na branch
`claude/cenario-gestao-fase-1-zf3bj2`.

## 6. Testes e resultados (executados nesta auditoria)

| Verificação                                                                    | Resultado                 |
| ------------------------------------------------------------------------------ | ------------------------- |
| `pnpm format:check` (após C1)                                                  | ok                        |
| `integrated-evolution.test.ts` isolado (após C2)                               | 9/9                       |
| Todos os 25 arquivos de teste da API que usam WebSocket (após C2)              | 256 aprovados, 1 ignorado |
| `sync-events.test.ts` (novo, C4): 6 cenários                                   | 6/6                       |
| Consumidores existentes de `/api/sync/events` (realtime, finance, permissions) | 41/41                     |
| Lint e typecheck da API (após C4)                                              | ok                        |
| CI nº 87 (`d40d354`, primeira execução completa desde o nº 63)                 | ver §6.1                  |

Cenários de C4: paginação 200/200/50 sem duplicar nem pular; página com exatamente `limit`
eventos; visíveis entre milhares de invisíveis, inclusive nas fronteiras de lote e do limite de
leitura (cursor avança exatamente 5000); visibilidade por permissão e por usuário (tablet ×
gestor); 30 gravações concorrentes durante a paginação (todas chegam, uma vez, em ordem);
contrato anterior com valores padrão.

### 6.1 CI

Preenchido em §6.1 do relatório de entrega (a execução estava em andamento ao escrever).

## 7. Estado de produção e homologação

- **Produção: não publicada** — não há evidência de ambiente de produção **[FATO, pelos documentos e
  scripts; nenhum recurso de produção foi encontrado]**.
- **Homologação** (projeto GCP `cenariogestao`, us-east1-b, VM `cenario-homolog`,
  `teste.cenariogestao.com.br`, Postgres em contêiner na VM): existência e versão **[NÃO
  VERIFICADO]**. Os documentos citam `fd6dc19` como publicada mas "não confirmada no ambiente
  real", com a atualização em NO-GO. Nada deste trabalho foi publicado.

## 8. Backup e rollback

- **[FATO]** `scripts/backup.sh`: banco (`pg_dump` custom, verificado) + arquivos + SHA-256;
  retenção `BACKUP_RETENTION_DAYS` (padrão 30). `pnpm test:backup` verde no CI nº 87.
- **[FATO]** Homologação: contêiner `backup` diário com 14 dias no volume; bucket com expiração em
  30 dias; atualização só pela sequência `preparar-versao → manutencao → ponto-recuperacao →
migrar → ativar` (`recuperar --sim` em falha).
- **[NÃO VERIFICADO]** Existência e integridade de backups reais na VM e no bucket.
- Rollback destas correções: `git revert` de cada commit; nenhuma depende de migration.

## 9. Pendências, riscos e decisões

### C3 — desenho proposto (não implementado; aguarda aprovação)

**Situação atual [FATO]:**

- `keyGenerator` usa `sha256(cookie)` sem validar o cookie → cookie aleatório por requisição
  anula o limite global de 600/min.
- Na homologação o Caddy envia `/api/*` direto à API (`Caddyfile.homolog`);
  `TRUST_PROXY=172.28.0.0/24` confia em **toda** a rede interna do Compose, inclusive no
  contêiner `web`.
- Em desenvolvimento e no E2E, `/api` passa pelo rewrite do Next (IP visto = loopback).
  `core/throttle.ts` já trata esse caso: com IP de loopback não confiável, não usa chave por IP.

**[INFERÊNCIA]** O Caddy 2 sem `trusted_proxies` descarta o `X-Forwarded-For` recebido do cliente
e grava o IP da conexão; o `request.ip` da API seria, então, o IP real. Isso precisa ser provado
por teste (abaixo).

**Desenho:**

1. **Identificação do IP.**
   - Fixar o IP do Caddy na rede interna (`ipv4_address`) e reduzir `TRUST_PROXY` a esse único
     endereço, em vez da sub-rede inteira.
   - No Caddyfile, explicitar `header_up X-Forwarded-For {remote_host}`, para não depender de
     padrão de versão.
   - A API usa `request.ip` (proxy-addr do Fastify percorre o XFF só até o primeiro salto não
     confiável).
2. **Dois limites.**
   - **Teto por IP**, sempre aplicado. Chave `ip:<request.ip>`, por exemplo 3000/min: a oficina
     inteira (cerca de 8 tablets e celulares) sai pelo mesmo IP de NAT.
   - **Limite por sessão** (600/min) só para sessão **validada**. Para isso, o rate limit passa a
     rodar no gancho `preHandler`, depois do plugin de autenticação, e usa `request.auth.sessionId`.
   - Cookie ausente, inválido ou expirado: só o balde por IP, com limite anônimo menor (por exemplo
     120/min).
   - Cookie aleatório deixa de criar balde novo.
   - O WebSocket `/api/realtime` continua isento (tem controle próprio).
3. **IP não confiável** (loopback ou proxy não declarado, caso do rewrite do Next):
   - requisições anônimas caem num balde global `ip:desconhecido` com teto alto, só para conter
     abuso;
   - sessões válidas mantêm o limite por sessão.
   - Em `APP_ENV=staging|production` com `TRUST_PROXY=false`, a API registra um aviso na partida.
     Recusar a partida é a opção mais rígida, a decidir.
4. **Testes de regressão** (com `inject({ remoteAddress })` e app com limites baixos):
   - N+1 requisições com cookies aleatórios distintos → 429;
   - duas sessões válidas no mesmo IP → baldes separados até o teto por IP;
   - `X-Forwarded-For` forjado vindo de endereço não confiável → ignorado;
   - vindo do proxy confiável → IP do cliente usado;
   - loopback sem `TRUST_PROXY` → balde `desconhecido` sem bloquear sessões válidas;
   - `/api/realtime` isento;
   - `throttle.ts` (login/PIN/pareamento) continua com o mesmo IP;
   - verificação do Caddyfile com `caddy validate` e, opcionalmente, teste com a pilha em
     contêineres enviando XFF forjado.

### Outras pendências

- **P2 [NÃO VERIFICADO]:** conferir na VM, com `vm.sh status` e `vm.sh saude`, qual etiqueta
  roda. Exige acesso do responsável ao Cloud Shell.
- **P6:** acompanhar a correção de `braces`; o risco é restrito ao ambiente de desenvolvimento.
- **P8 (a priorizar):**
  - o login revela que a senha está certa quando o usuário não tem `painel.acessar`;
  - o bloqueio de PIN por funcionário pode ser usado para bloquear um colega (negação de serviço
    dirigida);
  - `SEGURANCA.md` afirma que eventos financeiros não chegam aos tablets, mas o código não impõe
    isso de forma genérica: depende da audiência de cada evento;
  - o registro de erros inclui o objeto `err` inteiro. **[INFERÊNCIA]** Pode conter dados de
    requisição; conferir.
- `hasMore` de `/api/sync/events` é conservador: pode indicar `true` quando a próxima chamada
  vem vazia, mas nunca indica `false` com eventos pendentes.

## 10. Próxima ação recomendada

1. Aprovar ou ajustar o desenho de C3 para implementação.
2. Verificar a homologação na própria VM (P2) antes de qualquer nova publicação.
3. Tratar P8 em lote pequeno, com testes.
