# Homologação GCP — Auditoria final antes da primeira inicialização

> Escopo: auditoria **local** (Docker, dados fictícios), sem tocar no Google Cloud: nenhum deploy,
> nenhuma migration na VM, portão fechado, nenhuma alteração de infraestrutura. Imagens auditadas:
> as da etiqueta `fd6dc19`, reconstruídas localmente a partir de exatamente o mesmo conteúdo de
> aplicação (ver §5).

## Resultado

**GO condicionado**, depois de três ações no Cloud Shell (§10): `git pull` + `homolog.sh preparar-vm`
(leva à VM o Compose corrigido abaixo), conferência do DNS e da etiqueta `cenario-tag=fd6dc19`.
**Não é preciso gerar novas imagens.**

Um problema encontrado e corrigido no repositório:

| Problema                                                                                                                                                                                               | Correção                                                                                                         | Novas imagens? |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| `prisma migrate deploy` (executado a cada início da API) envia dados anônimos de uso a `checkpoint.prisma.io`; a imagem não define `CHECKPOINT_DISABLE` (e `CI=true` não desativa). Violaria o item 6. | `CHECKPOINT_DISABLE: '1'` no serviço `api` do `docker-compose.homolog.yml` (variável de execução, não de build). | **Não**        |

Evidência (log de depuração do próprio Prisma, com a imagem auditada):

```
sem a variável : runCheckpointClientCheck(): Execution time for "await checkpoint.check(data)" …
com a variável : runCheckpointClientCheck() is disabled by the CHECKPOINT_DISABLE env var.
```

## 1. `pnpm db:migrate` sem `.env` na raiz

Cadeia: `CMD sh -c "pnpm db:migrate && exec node apps/api/dist/server.js"` → `pnpm --filter @cenario/db migrate:deploy` → `dotenv -e ../../.env -- prisma migrate deploy` (dotenv-cli 11.0.0).

| Verificação                                                              | Resultado                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `.env` na imagem                                                         | ausente (`ls: cannot access '.env'`)                                                                         |
| `pnpm db:migrate` com só `DATABASE_URL` do ambiente, PostgreSQL 16 vazio | **rc 0**, `All migrations have been successfully applied.` (12)                                              |
| Banco usado                                                              | `Datasource "db": PostgreSQL database "cenario_homolog", schema "public"`                                    |
| 2ª execução (reinício)                                                   | `No pending migrations to apply.`                                                                            |
| `.env` intruso poderia sobrepor?                                         | não: a raiz `/app` não é gravável pelo usuário `node`, e o dotenv-cli não sobrescreve variáveis já definidas |

## 2. As 12 migrations

Todas aditivas: 98 `CREATE TABLE`, 213 índices, 218 chaves estrangeiras, 44 tipos, 37 `ADD COLUMN`.

- **Nenhum** `DROP`, `TRUNCATE`, `DELETE`, `RENAME` ou `SET NOT NULL` em coluna existente.
- Única alteração de tipo: `domain_events.audience` `VARCHAR(120)` → `VARCHAR(400)` (só amplia; sem perda nem reescrita da tabela).
- `ALTER TYPE … ADD VALUE` (9 valores): só acrescentam valores a enums.
- `INSERT`s: dados de referência (papéis, permissões, modelos de produção, locais, competências derivadas de funcionários existentes) — num banco novo, sem conflito.
- Ordem: carimbos de data crescentes; aplicadas em sequência sem erro; `_prisma_migrations`: 12 concluídas, 0 com erro; 99 tabelas.
- Conteúdo idêntico ao commit: `sha256` das 12 migrations concatenadas na imagem = no Git (`6867a952…`); `schema.prisma` idem (`801f4ca7…`).

## 3. Migrations só em `cenario_homolog`

`DATABASE_URL` vem do Compose, fixo: `postgresql://cenario:${POSTGRES_PASSWORD}@postgres:5432/cenario_homolog` (o mesmo `POSTGRES_DB` do contêiner do banco). Teste com dois bancos de controle (`outro_banco`, `postgres`) no mesmo servidor: **0 tabelas** criadas neles; 99 em `cenario_homolog`. O PostgreSQL da homologação é exclusivo da pilha (rede interna `172.28.0.0/24`); não há como alcançar bancos do VerificaPro.

## 4. Caddy, autenticação, cookie, HTTPS e WebSocket (pilha completa local)

Pilha real (`docker-compose.homolog.yml` + `Caddyfile.homolog`) com as imagens auditadas, domínio `homolog.localhost` (certificado interno do Caddy, para não acionar o Let's Encrypt):

| Teste                                              | Resultado                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `http://` → `https://`                             | 308                                                                                |
| sem credencial (`/painel`, `/api/ready`, `/sw.js`) | 401, sem `Set-Cookie`                                                              |
| senha errada / cookie falso                        | 401 / 401                                                                          |
| senha certa                                        | 200 + `cenario_homolog=…; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax` |
| cabeçalhos                                         | HSTS `max-age=31536000`, `X-Robots-Tag: noindex, nofollow`, sem `Server`           |
| com o cookie                                       | `/entrar` 200, `/api/ready` → `{"status":"ready"}`                                 |
| TLS                                                | TLSv1.3, certificado verificado                                                    |
| login do gestor fictício                           | 200, sessão `__Host-cen_sid` (HttpOnly; Secure; SameSite=Lax)                      |
| WebSocket `/api/realtime`: proxy + sessão          | **101**                                                                            |
| WebSocket só proxy / só sessão / nada              | 401 / 401 / 401                                                                    |
| segredos nos logs (188 linhas)                     | 0 ocorrências de cada um; Caddy registra `Cookie`/`Authorization` como `REDACTED`  |

## 5. Exposição e correspondência das imagens

- Portas publicadas: **só `caddy` 80/443**. PostgreSQL (5432), API (4000) e web (3000) só na rede interna.
- Imagens: o conteúdo de `apps/`, `packages/`, `scripts/`, `Dockerfile` e `pnpm-lock.yaml` usado no build local é idêntico ao de `fd6dc19` (diferenças apenas em documentos e scripts do operador, que não entram na aplicação). Impressões digitais para comparar com a imagem publicada (§10, passo 4):

```
958f3d8966bcf5b8fc59e77fb96da85ee5c5725ab9d6dfdb91f7e2e0ea163e75  apps/api/dist/server.js
801f4ca7dec44d24b407123edd76eda2897667f50ded45a67d0204afcdce9b66  packages/db/prisma/schema.prisma
6867a9522665c736c3ae27c1fb5c4c59074f13977ce07a505253b848a983c23a  migrations (12, concatenadas)
```

## 6. Nada sai para serviços externos no primeiro início

- API: nenhuma chamada de rede de saída no código (sem `fetch`, clientes HTTP, e-mail, WhatsApp, pagamentos ou webhooks; "whatsapp" é só um campo de cadastro). Dependências de produção: Fastify e plugins, Prisma, `pg`, argon2, zod.
- Web: nenhuma URL externa, nem fontes externas; `NEXT_TELEMETRY_DISABLED=1` na imagem.
- Prisma CLI: telemetria **desativada** pela correção acima.
- Saída esperada e necessária: o **Caddy** contata o Let's Encrypt (ACME) para emitir o certificado HTTPS de `teste.cenariogestao.com.br`. As imagens de PostgreSQL/Caddy são baixadas do Docker Hub; as da aplicação, do Artifact Registry.
- Seed e backup: só dados fictícios; o envio ao bucket é do próprio projeto.

## 7. Rollback — falhas simuladas localmente

| Falha                   | Comportamento observado                                                                                                                                                    | Procedimento na VM                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL cai          | API responde `/api/ready` 503 (sem travar); volta sozinha em ~4 s quando o banco retorna; dados preservados                                                                | `vm.sh status`; `docker logs cenario-homolog-postgres-1`; se não voltar: `vm.sh parar` e fechar o portão                                                                                                                                   |
| Migration falha         | `rc 1`: a API **não inicia** (`&&`); a migration falha é desfeita (tabela parcial inexistente); no reinício o Prisma recusa continuar (`P3009`) em vez de aplicar por cima | `vm.sh parar` → `sudo rm /etc/cenario/publicacao-autorizada` → analisar o log. No **primeiro** início o banco só tem dados fictícios: corrigir, gerar nova imagem e recriar o volume `cenario-homolog_pgdata` (apagar exige sua aprovação) |
| API cai                 | Caddy responde 502 (e 401 a quem não tem o cookie); o Docker reinicia a API                                                                                                | `docker logs cenario-homolog-api-1`; `vm.sh parar` + fechar o portão                                                                                                                                                                       |
| Caddy/certificado falha | sem HTTPS válido; a API e o banco não ficam expostos (sem portas próprias)                                                                                                 | conferir DNS e regra 80/443; `docker logs cenario-homolog-caddy-1`; `vm.sh parar` + fechar o portão                                                                                                                                        |
| Pilha inteira recriada  | `down` + `up`: volumes mantidos, `No pending migrations`, mesmos dados                                                                                                     | —                                                                                                                                                                                                                                          |

Despublicar sem perder dados: `sudo systemctl stop cenario-homolog.service && sudo rm -f /etc/cenario/publicacao-autorizada` (e, se quiser, remover a regra 80/443). Backup automático testado: criado logo após a API ficar saudável, `SHA256SUMS` conferido. Memória em repouso: API 80 MiB, web 134 MiB, PostgreSQL 26 MiB, Caddy 14 MiB.

## 8. Testes executados

- `pnpm db:migrate` na imagem: banco vazio (12 aplicadas), reinício (nada pendente), bancos de controle intocados, telemetria com e sem a variável.
- Pilha completa local: 15 verificações de proxy/HTTPS/cookie/WebSocket (§4), logs sem segredos, backup, PostgreSQL parado, API parada, recriação da pilha.
- Migration com falha simulada (13ª, com divisão por zero): API não inicia, reversão da migration, `P3009` no reinício.
- `docker compose config` (portas: só caddy 80/443; `CHECKPOINT_DISABLE=1`), `test_vm_sh.sh` e `test_homolog_sh.sh`: OK.
- Não executado aqui: nada no Google Cloud; a comparação com a imagem publicada e a resolução do DNS (este ambiente não alcança o DNS público) ficam para o Cloud Shell (§10).

## 9. Itens que permanecem com você

- Escopos da VM = `cloud-platform` e `roles/artifactregistry.reader` da conta da VM no repositório.
- `cenario-tag=fd6dc19` nos metadados da VM.
- DNS `teste.cenariogestao.com.br` → `136.108.15.103` e regra 80/443 ativa (o Let's Encrypt valida pela porta 80/443).

## 10. Sequência no Cloud Shell (só depois da sua autorização para publicar)

```bash
# 1. Código e arquivos da VM no commit desta auditoria (portão continua fechado)
cd ~/Cen-rio-app && git pull origin claude/cenario-gestao-fase-1-zf3bj2 && git log --oneline -1
bash infra/homolog/gcp/homolog.sh preparar-vm      # digite: preparar cenario-homolog
bash infra/homolog/gcp/homolog.sh testar-config

# 2. Conferências sem efeito colateral
getent hosts teste.cenariogestao.com.br            # deve mostrar 136.108.15.103
gcloud compute instances describe cenario-homolog --zone=us-east1-b --project=cenariogestao --format=json \
  | jq -r '.metadata.items[] | select(.key == "cenario-tag") | .value'   # deve mostrar fd6dc19

# 3. (opcional) comparar a imagem publicada com as impressões digitais do §5 — só baixa, não inicia
gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap --command='
  I=us-east1-docker.pkg.dev/cenariogestao/cenario-homolog/api:fd6dc19
  sudo gcloud auth configure-docker us-east1-docker.pkg.dev --quiet >/dev/null 2>&1
  sudo docker pull -q $I && sudo docker run --rm --entrypoint sha256sum $I /app/apps/api/dist/server.js /app/packages/db/prisma/schema.prisma'

# 4. PUBLICAR (abre o portão: PostgreSQL, migrations e aplicação) — somente com autorização
gcloud compute ssh cenario-homolog --zone=us-east1-b --project=cenariogestao --tunnel-through-iap \
  --command='sudo touch /etc/cenario/publicacao-autorizada && sudo systemctl start cenario-homolog.service && sudo /opt/cenario/infra/homolog/gcp/vm.sh saude'
# Se a única falha for o certificado, repita o "vm.sh saude" após 1–2 minutos (emissão pelo Let's Encrypt).
```
