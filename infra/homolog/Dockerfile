# Imagens de HOMOLOGAÇÃO do Cenário Gestão (API e web). Construir na raiz do repositório:
#   docker build -f infra/homolog/Dockerfile --target api -t cenario-api:homolog .
#   docker build -f infra/homolog/Dockerfile --target web -t cenario-web:homolog .
# Não contém segredos: tudo vem do ambiente em tempo de execução (exceto API_INTERNAL_URL,
# gravado no build do Next.js).
FROM node:22-bookworm-slim AS base
# COREPACK_HOME compartilhado: o pnpm fica dentro da imagem (sem download ao iniciar).
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1 \
  COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# openssl: exigido pelo motor do Prisma. O backup roda na imagem oficial postgres:16
# (pg_dump da mesma versão do servidor), não nesta.
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && chmod -R a+rX /corepack
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/shared/package.json packages/shared/
COPY tests/e2e/package.json tests/e2e/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG API_INTERNAL_URL=http://api:4000
RUN pnpm --filter @cenario/db generate \
  && pnpm --filter @cenario/api build \
  && API_INTERNAL_URL=$API_INTERNAL_URL pnpm --filter @cenario/web build

# API: aplica as migrations pendentes (nunca reset) e inicia. Usuário sem privilégios.
FROM build AS api
ENV NODE_ENV=production
RUN mkdir -p /data/storage && chown -R node:node /data /app/packages/db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "pnpm db:migrate && node apps/api/dist/server.js"]

FROM build AS web
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@cenario/web", "start"]
