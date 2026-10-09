# Homologação — Cenário Gestão

Ambiente de **testes** em nuvem, separado da produção, para validar o sistema com o gestor, os
quatro tablets da oficina (Ricardo, Márcio, João, Thiago) e os celulares da logística (André e
Izaías) **antes** de qualquer uso real.

> **Nada foi publicado nem contratado na Fase 12.** Este documento e os arquivos de
> `infra/homolog/` são a preparação; a pilha completa foi verificada **localmente** (contêineres,
> HTTPS do Caddy com certificado local, login, tempo real, backup e restauração — detalhes em
> `FASE-12-RELATORIO.md` §17). Subir o ambiente depende da sua autorização, de uma VM e de
> um domínio de teste. Use **somente dados fictícios**.

> **Google Cloud:** a configuração escolhida (VM e2-small em us-east1, autenticação adicional no
> proxy, segredos no Secret Manager, scripts `infra/homolog/gcp/`) está em
> [`HOMOLOGACAO-GCP-PREPARACAO.md`](HOMOLOGACAO-GCP-PREPARACAO.md), que prevalece sobre os
> comandos genéricos abaixo.

## 1. O que compõe o ambiente

| Peça            | Como                                                       | Arquivo                                    |
| --------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Frontend (web)  | Next.js em contêiner (`target web`)                        | `infra/homolog/Dockerfile`                 |
| API + WebSocket | Fastify em contêiner (`target api`), migrations na partida | `infra/homolog/Dockerfile`                 |
| PostgreSQL 16   | Contêiner com volume próprio, **sem porta exposta**        | `infra/homolog/docker-compose.homolog.yml` |
| Armazenamento   | Volume `storage` (fotos e anexos privados)                 | idem                                       |
| HTTPS           | Caddy 2 com certificado automático; `noindex`              | `infra/homolog/Caddyfile.homolog`          |
| Backups         | Contêiner `backup` (`postgres:16`): diário, 14 dias        | idem (usa `scripts/backup.sh`)             |
| Variáveis       | Modelo sem segredos                                        | `infra/homolog/env.homolog.example`        |
| Dados de teste  | Script pela API (clientes, pedidos, recebimentos e OS)     | `scripts/homolog-dados-sinteticos.mjs`     |

A API recusa iniciar em `APP_ENV=staging` sem `COOKIE_SECURE=true`, sem `NODE_ENV=production`
ou com origem que não seja `https://`. O relógio de teste (`ENABLE_TEST_CLOCK`) é recusado fora
de `APP_ENV=test`.

### Requisitos (sem custo obrigatório)

- Uma VM Linux com Docker e Docker Compose (2 vCPU / 4 GB bastam para a equipe da oficina).
  Pode ser uma máquina já disponível; nenhum serviço pago é exigido por estes arquivos.
- Um nome de domínio **de teste** (ex.: `homolog.seu-dominio.com.br`) apontado para a VM e as
  portas 80/443 liberadas (o Caddy obtém o certificado sozinho).

## 2. Subir o ambiente (quando autorizado)

```bash
git clone … && cd Cen-rio-app
cp infra/homolog/env.homolog.example infra/homolog/.env.homolog
#   preencha: HOMOLOG_DOMAIN, POSTGRES_PASSWORD (openssl rand -base64 24),
#   TOKEN_HASH_SECRET (openssl rand -base64 48), SEED_ADMIN_* (e-mail de teste)
docker compose -f infra/homolog/docker-compose.homolog.yml \
  --env-file infra/homolog/.env.homolog up -d --build
docker compose -f infra/homolog/docker-compose.homolog.yml \
  --env-file infra/homolog/.env.homolog exec api pnpm db:seed
#   funções padrão, checklists, gestor de teste e a equipe (sem PIN)
```

Verificação: `https://<domínio>/api/health` → `{"status":"ok"}`, `https://<domínio>/api/ready`
→ banco pronto, e `https://<domínio>/painel` abre a tela de entrada.

O arquivo `.env.homolog` **não** é versionado (`.gitignore`/`.dockerignore`). Os segredos de
homologação nunca são reutilizados em produção.

## 3. Contas de teste

| Quem              | Acesso                     | Como criar                                                   |
| ----------------- | -------------------------- | ------------------------------------------------------------ |
| Gestor (teste)    | Painel, e-mail + senha     | `SEED_ADMIN_*` no seed; trocar a senha no primeiro acesso    |
| Ricardo, Márcio   | Tablet, PIN de 6 dígitos   | Criados pelo seed; PIN em **Funcionários → PIN**             |
| João, Thiago      | Tablet, PIN                | idem                                                         |
| André, Izaías     | Celular, PIN, só logística | idem; dispositivo com **uso exclusivo** do funcionário       |
| Outros testadores | Painel com função restrita | **Funções** (permissões mínimas) + **Funcionários → acesso** |

Use e-mails de teste (`…@teste.local` ou do domínio de testes) e PINs que não sejam usados em
nenhum outro sistema.

## 4. Dados sintéticos

```bash
HOMOLOG_URL=https://<domínio> HOMOLOG_EMAIL=<gestor de teste> HOMOLOG_PASSWORD='…' \
  node scripts/homolog-dados-sinteticos.mjs 5
```

Cria 5 clientes fictícios, cada um com pedido, recebimento das peças e OS aberta, pela própria
API (mesmas validações e auditoria). Fornecedores, materiais, planejamento e tarefas são criados
pelos testadores no roteiro abaixo — é exatamente o que se quer homologar.

## 5. iPhone (Safari) — gestor e logística

1. Abra `https://<domínio>/painel` no Safari e entre com o e-mail do gestor de teste.
2. Para André/Izaías: no painel do gestor, **Dispositivos → Cadastrar** (vincular ao funcionário
   e marcar "uso exclusivo"). No iPhone deles, abra `https://<domínio>/tablet`, digite o
   **código de vinculação** (válido por 15 minutos) e entre com o PIN.
3. Opcional: **Compartilhar → Adicionar à Tela de Início** — abre em tela cheia como aplicativo.
4. O que conferir: rolagem sem cortes laterais, câmera para fotos (o Safari pede permissão),
   retomada depois de bloquear a tela, e que o celular da logística **não** mostra valores
   financeiros nem retiradas de outra pessoa.

## 6. Os 4 tablets da oficina

Para cada tablet (Ricardo, Márcio, João, Thiago):

1. Painel → **Funcionários**: definir o PIN da pessoa.
2. Painel → **Dispositivos → Cadastrar**: nome do tablet, funcionário principal e "uso exclusivo"
   (ou compartilhado, se o tablet for de bancada). Anote o código exibido.
3. No tablet: abrir `https://<domínio>/tablet`, digitar o código, entrar com o PIN.
4. Adicionar à tela inicial (Safari: Compartilhar → Adicionar à Tela de Início; Chrome/Android:
   menu → Instalar aplicativo). A sessão do dispositivo dura até 30 dias sem uso.
5. Se um tablet for perdido: **Dispositivos → Revogar** — todas as sessões dele caem na hora.

Os tablets nunca exibem valores financeiros (exceto "Meus valores", quando o gestor concede a
permissão individual a Ricardo ou Márcio).

## 7. Roteiro de homologação sugerido

Repete, com pessoas reais e dados fictícios, o fluxo automatizado em
`apps/api/test/full-flow.test.ts` (32 passos) e `tests/e2e/specs/team-workshop.spec.ts`:

1. Cliente → pedido → retirada (André/Izaías no celular) → recebimento das peças.
2. OS → medição atribuída (tablet) → solicitação de materiais → aprovação.
3. Compra → recebimento de materiais (parcial; encerrar saldo se preciso) → estoque e prontidão.
4. Planejamento semanal → publicação → os quatro tablets executam ao mesmo tempo.
5. Pedido de ajuda, ocorrência, ausência e reprogramação.
6. Inspeção (Thiago) → correção → embalagem → entrega (logística) → recebimento financeiro.
7. Devolução de peça sem serviço (painel → Devoluções) e conferência de reservas e valores.
8. Resultado da OS no Financeiro e indicadores.
9. Derrubar o Wi-Fi de um tablet durante o uso e conferir a reconexão.

Registre cada divergência com data, tela, pessoa e captura de tela.

## 8. Logs, backups e controle de acesso

- **Logs**: `docker compose … logs -f api` (JSON, um objeto por linha, com `requestId`). Não há
  dados de senha, PIN ou token nos logs.
- **Backups**: o contêiner `backup` (imagem oficial `postgres:16`, com `pg_dump` da mesma versão
  do servidor) grava ao iniciar e depois diariamente no volume `backups` (banco + arquivos +
  SHA-256, 14 dias). Backup manual: `docker compose … exec backup bash /scripts/backup.sh
/data/backups`. Teste de restauração num banco **separado** (nunca sobre o de homologação):

  ```bash
  C="docker compose -f infra/homolog/docker-compose.homolog.yml --env-file infra/homolog/.env.homolog"
  $C exec postgres psql -U cenario -d cenario_homolog -c "create database cenario_restore_check"
  $C run --rm --no-deps --entrypoint bash backup -c \
    "bash /scripts/restore.sh /data/backups/<pasta> \
       --target postgresql://cenario:<senha>@postgres:5432/cenario_restore_check \
       --storage /tmp/rs --yes"
  ```

  Procedimento completo de recuperação em `OPERACAO.md`.

- **Acesso**: só HTTPS; banco sem porta pública; páginas com `X-Robots-Tag: noindex`; limitar o
  acesso por firewall ao IP da oficina é recomendado; contas de testadores com funções mínimas;
  revogar dispositivos e contas ao fim da homologação.

## 9. Encerramento da homologação

Ao concluir: exportar o relatório de divergências, apagar o ambiente de homologação
(`docker compose … down -v` só depois de guardar o que for necessário) e **não** migrar dados de
homologação para a produção — a produção começa com banco novo, segredos novos e o seed.
