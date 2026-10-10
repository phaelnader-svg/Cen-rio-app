# Imagens de HOMOLOGAÇÃO do Cenário Gestão (API e web). Construir na raiz do repositório:
#   docker build -f infra/homolog/Dockerfile --target api -t cenario-api:homolog .
#   docker build -f infra/homolog/Dockerfile --target web -t cenario-web:homolog .
# Não contém segredos: tudo vem do ambiente em tempo de execução (exceto API_INTERNAL_URL,
# gravado no build do Next.js).
#
# Base completa (não a "slim"): já traz OpenSSL 3 (exigido pelo motor do Prisma) e os
# certificados de CA, sem precisar de apt-get no build. Versão fixa para builds reproduzíveis.
FROM node:22.23.3-bookworm AS base
# COREPACK_HOME compartilhado: o pnpm fica dentro da imagem (sem download ao iniciar).
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1 \
  COREPACK_HOME=/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
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

# API: partida em infra/homolog/api-iniciar.sh. MIGRATE_ON_START=1 (padrão, uso local) aplica as
# migrations pendentes (nunca reset); MIGRATE_ON_START=0 (homologação) só confere e recusa iniciar
# com migration pendente — elas são aplicadas por "vm.sh migrar", depois do ponto de recuperação.
# Usuário sem privilégios; o Node recebe o SIGTERM (encerramento seguro em até 10 s).
FROM build AS api
ENV NODE_ENV=production
RUN mkdir -p /data/storage && chown -R node:node /data /app/packages/db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "infra/homolog/api-iniciar.sh"]

# Web: Next.js iniciado diretamente pelo Node (sem o processo extra do pnpm).
FROM build AS web
ENV NODE_ENV=production
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/entrar').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
