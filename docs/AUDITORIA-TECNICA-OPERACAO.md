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

| Item | O quê                                                                                                                                                                                                                          | Commit    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| C1   | `.prettierignore` passa a ignorar **só** `docs/evidencias/**/geometria.json` (5 arquivos, todos gerados pelo E2E de geometria). Código-fonte e demais documentos continuam verificados (`prettier --file-info`).               | `d40d354` |
| C2   | `WsClient.waitFor` (testes) reage a cada mensagem em vez de consultar em intervalos; prazo 5 s → 15 s. Timeout ou conexão fechada continuam **reprovando**, com as mensagens recebidas na mensagem de erro.                    | `ff9cfc5` |
| C4   | `/api/sync/events`: leitura em lotes de 500, no máximo 5000 eventos examinados por chamada, cursor `nextSince`. Contrato anterior (`events`, `hasMore`) mantido; `nextSince` é aditivo. Sem migration, sem alteração de dados. | `6d37184` |
| C5   | `OPERACAO.md` e `HOMOLOGACAO.md` alinhados ao código (migrations explícitas, imagens do registro, retenção, estado de publicação não verificado) e este relatório.                                                             | `b94ee66` |

Garantias do cursor de C4 (`nextSince`): todo evento com `since < seq ≤ nextSince` foi examinado
e, se visível, está nesta página ou numa anterior. Página cheia → cursor no último evento
**devolvido**; limite de leitura → cursor no último **examinado** (eventos invisíveis não são da
sessão, então nada se perde). A ordem de `seq` segue a ordem de commit (trava em `appendEvent`).

## 4. Arquivos alterados

- `.prettierignore` (C1)
- `apps/api/test/helpers.ts` (C2)
- `apps/api/src/modules/sync/routes.ts`, `apps/api/test/sync-events.test.ts` (novo) (C4)
- `docs/OPERACAO.md`, `docs/HOMOLOGACAO.md`, `docs/AUDITORIA-TECNICA-OPERACAO.md` (novo) (C5)
- `apps/api/src/modules/arrivals/routes.ts` (falha revelada pelo CI nº 88, ver §6.1)

Migrations: **nenhuma**.

## 5. Commits

`d40d354` (C1) → `ff9cfc5` (C2) → `6d37184` (C4) → `b94ee66` (C5) → `87f7103` (corrida na
confirmação de chegada), todos na branch `claude/cenario-gestao-fase-1-zf3bj2`.

## 6. Testes e resultados (executados nesta auditoria)

| Verificação                                                                    | Resultado                 |
| ------------------------------------------------------------------------------ | ------------------------- |
| `pnpm format:check` (após C1)                                                  | ok                        |
| `integrated-evolution.test.ts` isolado (após C2)                               | 9/9                       |
| Todos os 25 arquivos de teste da API que usam WebSocket (após C2)              | 256 aprovados, 1 ignorado |
| `sync-events.test.ts` (novo, C4): 6 cenários                                   | 6/6                       |
| Consumidores existentes de `/api/sync/events` (realtime, finance, permissions) | 41/41                     |
| Lint e typecheck da API (após C4)                                              | ok                        |
| CI (GitHub Actions)                                                            | ver §6.1                  |

Cenários de C4: paginação 200/200/50 sem duplicar nem pular; página com exatamente `limit`
eventos; visíveis entre milhares de invisíveis, inclusive nas fronteiras de lote e do limite de
leitura (cursor avança exatamente 5000); visibilidade por permissão e por usuário (tablet ×
gestor); 30 gravações concorrentes durante a paginação (todas chegam, uma vez, em ordem);
contrato anterior com valores padrão.

### 6.1 CI (GitHub Actions, resultados reais)

| Execução | Commit    | Resultado                                                                                                              |
| -------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| nº 87    | `d40d354` | **verde** — primeira execução completa desde o nº 63 (format, lint, typecheck, migrations, build, testes, backup, E2E) |
| nº 88    | `6d37184` | **vermelho** — 1 teste: `recebimentos-compartilhados` CA3-10 recebeu `[201, 400]` em vez de `[201, 409]`               |
| nº 89    | `b94ee66` | **verde**                                                                                                              |
| nº 90    | `87f7103` | **verde** (pipeline completo, inclusive E2E)                                                                           |

Causa do nº 88 **[FATO]**: corrida na confirmação de peças (`POST /api/v1/arrivals/pickups/:id/confirm`),
não relacionada a C4. A retirada era lida sem trava antes do saldo; se outra confirmação era
gravada entre as duas leituras, o saldo vinha zerado com a versão antiga e a rota respondia 400
("Informe ao menos uma peça") em vez de 409. Reproduzida localmente com atraso injetado só na
segunda requisição (`[201, 400]`), corrigida relendo a versão depois do saldo (`[201, 409]`
com o mesmo atraso) e o atraso removido. Nenhum teste foi alterado ou desativado; não havia
duplicação de dados (as travas em `registerReceipt` impediam) — o erro era só o código de resposta.

Local, após C4: suíte completa da API 432 aprovados, 5 ignorados por desenho (50 arquivos).

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

### C3 — implementado (autorizado em 13/10/2026)

Commits `b64f214` (IP real), `0fb08b6` (limites), `a8044e9` (Caddy/Compose/CI) e o desta
documentação. Nada foi aplicado na VM.

**[FATO] Comportamento verificado por teste:**

- **IP real** (`core/client-ip.ts`): só o proxy de `TRUST_PROXY` é confiável, e só como salto
  imediato. Valores de `X-Forwarded-For` anteriores ao do proxy são ignorados. Uma conexão
  direta de quem não é o proxy tem o cabeçalho ignorado. `TRUST_PROXY=true` é ignorado em
  homologação/produção.
- **IP desconhecido**: loopback (proxy do Next em desenvolvimento) ou proxy sem
  `X-Forwarded-For`. Nunca vira o IP do proxy.
- **Aviso na partida** (`alerta: "ip-do-cliente"`), sem impedir o início: em
  homologação/produção quando o proxy está ausente, configurado com `true` ou com uma faixa
  inteira.
- **Limites** (`core/rate-limit.ts`, por minuto):

  | Camada                 | Contador                            | Limite |
  | ---------------------- | ----------------------------------- | ------ |
  | Antes da autenticação  | por IP real                         | 3000   |
  | Antes da autenticação  | global, IP desconhecido             | 10000  |
  | Depois da autenticação | sessão ou dispositivo **validados** | 600    |
  | Depois da autenticação | anônimo por IP                      | 120    |
  | Depois da autenticação | anônimo global                      | 1200   |

  Cookies inventados não criam contadores.

- **WebSocket**: isento da camada por sessão (reconexões), mas conta no teto por IP. Upgrades
  sem sessão válida, que consultam o banco antes do 401, não ficam ilimitados.
- **Caddy de homologação**: `X-Forwarded-For` explícito = IP da conexão; `X-Real-IP` e
  `Forwarded` do cliente removidos (antes chegavam intactos). A prova roda com o Caddy 2.10.2
  real e o Caddyfile versionado (`test/proxy-caddy.test.ts`, obrigatório no CI).
  - Controle negativo: com o Caddyfile enfraquecido, o teste falha.
  - Defesa em profundidade: mesmo com o Caddy enfraquecido, a API continuou usando só o IP da
    conexão.
- **Compose**: Caddy com IP fixo `172.28.0.250`; `TRUST_PROXY` só nesse endereço, em vez de
  `172.28.0.0/24`.
- **Teste anterior reescrito**: o antigo `test/rate-limit.test.ts` afirmava o próprio defeito
  (cookie inventado ganhava contador novo). A intenção dele agora é verificada com sessões reais.

**Dependem da VM (não verificados; publicação não autorizada):**

1. Na próxima atualização autorizada, recriar o contêiner do Caddy com o IP fixo e conferir:
   - `docker inspect` do Caddy mostra `172.28.0.250`;
   - a API registra **nenhum** aviso `ip-do-cliente` na partida.
2. Conferir na prática que o IP gravado (auditoria, `lastIp` dos dispositivos) é o IP público
   da oficina, e não `172.28.0.250`.
3. Conflito de endereço: se outro contêiner já ocupar `172.28.0.250` (alocação automática do
   Docker), o Caddy **não sobe**. A falha é visível e não abre brecha. Correção: recriar a rede
   com `docker compose down` + `up`; os volumes são preservados.
4. Se houver CDN ou balanceador na frente da VM no futuro, `TRUST_PROXY` e o Caddy precisam ser
   revistos. Hoje não há: a VM recebe as conexões diretamente.

**Riscos restantes:**

- Com IP desconhecido, os contadores globais podem ser esgotados por um abusador, afetando todos.
  Nesse caso a API emite o aviso na partida.
- Os contadores ficam em memória, por instância.
- Não há teto de conexões WebSocket simultâneas por sessão. Uma sessão válida já é exigida, e o
  gestor pode revogá-la.

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

1. Verificar a homologação na própria VM (P2) e, na próxima atualização autorizada, os itens
   de C3 que dependem da VM (acima).
2. Antes disso, nenhuma publicação.
3. Tratar P8 em lote pequeno, com testes.
