# Cenário Gestão

Sistema de gestão de produção da **Cenário Estofados** — painel administrativo do gestor e
interface de produção para os tablets da oficina, sincronizados em tempo real.

> **Status: Fase 8 concluída.** Fases 1–6 (fundação, comercial e OS, medições, compras e estoque,
> planejamento e motor de produção, tablets com Meu dia e avisos), Fase 7 (presença operacional) e
> Fase 8 (pedidos de ajuda com distribuição automática de ajudantes, reprogramação simples
> automática e propostas críticas para o gestor aprovar). Central de atenção, qualidade e entregas
> são das próximas fases.

## Documentação

| Documento                                            | Conteúdo                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md)           | Arquitetura, decisões técnicas, módulos, eventos e tempo real |
| [docs/SEGURANCA.md](docs/SEGURANCA.md)               | Autenticação, sessões, permissões, proteções e riscos aceitos |
| [docs/OPERACAO.md](docs/OPERACAO.md)                 | Ambientes, variáveis, deploy, backup e restauração            |
| [docs/FASE-1-RELATORIO.md](docs/FASE-1-RELATORIO.md) | Entregáveis da Fase 1, APIs, testes executados e pendências   |
| [docs/FASE-2-RELATORIO.md](docs/FASE-2-RELATORIO.md) | Entregáveis da Fase 2, APIs, testes executados e pendências   |
| [docs/FASE-3-RELATORIO.md](docs/FASE-3-RELATORIO.md) | Entregáveis da Fase 3, APIs, testes executados e pendências   |
| [docs/FASE-4-RELATORIO.md](docs/FASE-4-RELATORIO.md) | Entregáveis da Fase 4, APIs, testes executados e pendências   |
| [docs/FASE-5-RELATORIO.md](docs/FASE-5-RELATORIO.md) | Entregáveis da Fase 5, APIs, testes executados e pendências   |
| [docs/FASE-6-RELATORIO.md](docs/FASE-6-RELATORIO.md) | Entregáveis da Fase 6, APIs, testes executados e pendências   |
| [docs/FASE-7-RELATORIO.md](docs/FASE-7-RELATORIO.md) | Entregáveis da Fase 7, APIs, testes executados e pendências   |
| [docs/FASE-8-RELATORIO.md](docs/FASE-8-RELATORIO.md) | Entregáveis da Fase 8, APIs, testes executados e pendências   |

## Requisitos

- Node.js 22.12+ e pnpm 10 (`corepack enable`)
- PostgreSQL 16 (local ou via `docker compose up -d postgres`)

## Executar localmente

```bash
pnpm install                      # instala dependências e gera o cliente Prisma
cp .env.example .env              # preencha DATABASE_URL, TOKEN_HASH_SECRET e SEED_ADMIN_*
#   TOKEN_HASH_SECRET: openssl rand -base64 48
docker compose up -d postgres     # opcional: PostgreSQL local com bancos de teste
pnpm db:migrate                   # aplica as migrations versionadas
pnpm db:seed                      # funções padrão, configurações e conta do gestor
pnpm dev                          # API em :4000 e web em :3000
```

- Painel: <http://localhost:3000/painel> (entre com `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`)
- Tablet: <http://localhost:3000/tablet> — no painel, cadastre o dispositivo em
  **Dispositivos e sessões**, digite o código no tablet e entre com o PIN do funcionário
  (defina o PIN em **Funcionários → PIN**).

Para acessar de tablets na rede da oficina, inclua o endereço usado (ex.:
`http://192.168.0.10:3000`) em `ALLOWED_ORIGINS`.

## Verificações

```bash
pnpm check          # formatação, lint, typecheck e testes unitários/integração
pnpm test:backup    # backup + restauração num banco temporário, com comparação
pnpm test:e2e       # Playwright: painel e tablets em navegadores separados
```

Os testes usam bancos exclusivos (`TEST_DATABASE_URL`, `E2E_DATABASE_URL`), que são
**apagados** a cada execução; o nome do banco precisa conter `test`.

## Estrutura

```
apps/api        API Fastify (monólito modular): autenticação, permissões, módulos, tempo real
apps/web        Next.js: painel administrativo (/painel) e interface dos tablets (/tablet, PWA)
packages/db     Schema Prisma, migrations versionadas, seed
packages/shared Catálogo de permissões, esquemas de validação (zod), eventos e tipos
tests/e2e       Testes ponta a ponta (Playwright)
scripts         Backup, restauração e teste de restauração
infra           Exemplo de proxy reverso (Caddy) e inicialização do PostgreSQL local
docs            Documentação técnica
```
