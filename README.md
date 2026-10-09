# Cenário Gestão

Sistema de gestão de produção da **Cenário Estofados** — painel administrativo do gestor e
interface de produção para os tablets da oficina, sincronizados em tempo real.

> **Status: Fase 12 concluída (auditoria final; pronto para homologação, não para produção).** Fases 1–6 (fundação, comercial e OS, medições, compras e estoque,
> planejamento e motor de produção, tablets com Meu dia e avisos), Fase 7 (presença operacional),
> Fase 8 (ajuda e reprogramação), Fase 9 (central de atenção e ocorrências), Fase 10 (qualidade,
> embalagem, entregas, logística e devoluções) e Fase 11 (financeiro operacional: receita por OS,
> recebimentos, contas a pagar, custos de material, mão de obra por produção, logística,
> despesas, margem de contribuição, painel, produtividade e relatórios — sem integração bancária).
> Fase 12: auditoria final de segurança, integridade, sincronização, desempenho e telas,
> correção das pendências e preparação da homologação — veja a matriz Go/No-Go no relatório.

## Documentação

| Documento                                                                | Conteúdo                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md)                               | Arquitetura, decisões técnicas, módulos, eventos e tempo real |
| [docs/SEGURANCA.md](docs/SEGURANCA.md)                                   | Autenticação, sessões, permissões, proteções e riscos aceitos |
| [docs/OPERACAO.md](docs/OPERACAO.md)                                     | Ambientes, variáveis, deploy, backup e restauração            |
| [docs/HOMOLOGACAO.md](docs/HOMOLOGACAO.md)                               | Ambiente de testes, contas, tablets, iPhone e roteiro         |
| [docs/HOMOLOGACAO-GCP-PREPARACAO.md](docs/HOMOLOGACAO-GCP-PREPARACAO.md) | Homologação no Google Cloud: preparação, custos e comandos    |
| [docs/HOMOLOGACAO-GCP-ETAPA1.md](docs/HOMOLOGACAO-GCP-ETAPA1.md)         | Etapa 1 no Google Cloud: infraestrutura mínima e verificações |
| [docs/FASE-1-RELATORIO.md](docs/FASE-1-RELATORIO.md)                     | Entregáveis da Fase 1, APIs, testes executados e pendências   |
| [docs/FASE-2-RELATORIO.md](docs/FASE-2-RELATORIO.md)                     | Entregáveis da Fase 2, APIs, testes executados e pendências   |
| [docs/FASE-3-RELATORIO.md](docs/FASE-3-RELATORIO.md)                     | Entregáveis da Fase 3, APIs, testes executados e pendências   |
| [docs/FASE-4-RELATORIO.md](docs/FASE-4-RELATORIO.md)                     | Entregáveis da Fase 4, APIs, testes executados e pendências   |
| [docs/FASE-5-RELATORIO.md](docs/FASE-5-RELATORIO.md)                     | Entregáveis da Fase 5, APIs, testes executados e pendências   |
| [docs/FASE-6-RELATORIO.md](docs/FASE-6-RELATORIO.md)                     | Entregáveis da Fase 6, APIs, testes executados e pendências   |
| [docs/FASE-7-RELATORIO.md](docs/FASE-7-RELATORIO.md)                     | Entregáveis da Fase 7, APIs, testes executados e pendências   |
| [docs/FASE-8-RELATORIO.md](docs/FASE-8-RELATORIO.md)                     | Entregáveis da Fase 8, APIs, testes executados e pendências   |
| [docs/FASE-9-RELATORIO.md](docs/FASE-9-RELATORIO.md)                     | Entregáveis da Fase 9, APIs, testes executados e pendências   |
| [docs/FASE-10-RELATORIO.md](docs/FASE-10-RELATORIO.md)                   | Entregáveis da Fase 10, APIs, testes executados e pendências  |
| [docs/FASE-11-RELATORIO.md](docs/FASE-11-RELATORIO.md)                   | Entregáveis da Fase 11, APIs, testes executados e pendências  |
| [docs/FASE-12-RELATORIO.md](docs/FASE-12-RELATORIO.md)                   | Auditoria final, correções, Go/No-Go e homologação            |

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
pnpm test:e2e       # Playwright: painel e tablets em navegadores separados, auditoria visual
pnpm --filter @cenario/api perf   # desempenho local (TEST_DATABASE_URL de um banco *_test)
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
infra           Proxy reverso (Caddy), PostgreSQL local e ambiente de homologação (infra/homolog)
docs            Documentação técnica
```
