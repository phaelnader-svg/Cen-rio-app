import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { createFirmaClient, type PrismaClient } from '@firma/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { atLeast, type Access, type Role } from './context';
import type { Env } from './env';
import { createHasher, createSealer } from './lib/crypto';
import { E, FirmaError } from './lib/errors';
import { authRoutes } from './routes/auth';
import { connectionRoutes } from './routes/connection';
import { entrarRoutes } from './routes/entrar';
import { gameRoutes } from './routes/game';
import { orgRoutes } from './routes/org';

export const SESSION_COOKIE = 'fv_sessao';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOUCH_MS = 60_000;

export interface FirmaApp {
  app: FastifyInstance;
  db: PrismaClient;
  close(): Promise<void>;
}

export async function buildApp(opts: {
  env: Env;
  db?: PrismaClient;
  logger?: boolean;
  /** Substitui o fetch usado para falar com o Cenário Gestão (testes). */
  cenarioFetch?: typeof fetch;
}): Promise<FirmaApp> {
  const { env } = opts;
  const db = opts.db ?? createFirmaClient(env.FIRMA_DATABASE_URL);
  const sealer = createSealer(env.FIRMA_SEAL_KEY);
  const app = Fastify({
    logger: opts.logger === false ? false : { level: env.FIRMA_LOG_LEVEL },
    genReqId: () => randomUUID(),
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: env.FIRMA_APP_ENV === 'production' || env.FIRMA_APP_ENV === 'preview',
  });
  app.decorate('firma', {
    env,
    db,
    hash: createHasher(env.FIRMA_TOKEN_HASH_SECRET),
    seal: sealer.seal,
    unseal: sealer.open,
  });
  app.decorate('cenarioFetch', opts.cenarioFetch ?? fetch);
  app.decorateRequest('user', null);
  app.decorateRequest('org', null);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false, global: true });

  // Uploads e demais corpos não JSON seguem como estão para o Cenário Gestão.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    if (!(route.config as { rule?: Access } | undefined)?.rule)
      throw new Error(`Rota sem regra de acesso: ${String(route.method)} ${route.url}`);
  });

  const allowed = new Set([env.FIRMA_WEB_URL, ...env.FIRMA_EXTRA_ORIGINS]);
  app.addHook('onRequest', async (request, reply) => {
    const access = request.routeOptions.config?.rule;
    if (!access) return;
    if (!SAFE.has(request.method)) {
      const origin = request.headers.origin?.replace(/\/$/, '');
      if (!origin || !allowed.has(origin)) throw E.origin();
    }
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const s = await db.session.findUnique({
        where: { tokenHash: app.firma.hash(token) },
        include: { user: true },
      });
      const now = new Date();
      if (!s || s.revokedAt || s.expiresAt <= now || !s.user.active) {
        void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      } else {
        request.user = { sessionId: s.id, id: s.userId, name: s.user.name, email: s.user.email };
        if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_MS)
          await db.session.update({ where: { id: s.id }, data: { lastSeenAt: now } });
        if (s.orgId) {
          // Isolamento: a organização da sessão só vale se a pessoa ainda for membro dela.
          const m = await db.membership.findUnique({
            where: { orgId_userId: { orgId: s.orgId, userId: s.userId } },
            include: { org: { select: { id: true, name: true } } },
          });
          if (m) request.org = { id: m.org.id, name: m.org.name, role: m.role as Role };
        }
      }
    }
    if ('public' in access) return;
    if (!request.user) throw E.unauthenticated();
    if ('user' in access) return;
    if (!request.org) throw E.forbidden('Escolha uma organização para continuar.');
    if (!atLeast(request.org.role, access.org)) throw E.forbidden();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FirmaError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues[0]?.message ?? 'Dados inválidos.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          requestId: request.id,
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const fromCenario = (
      error as { cenario?: { code: string; message: string; details?: unknown } }
    ).cenario;
    if (fromCenario) {
      // Erro de regra do Cenário Gestão (conflito de versão, vínculos, permissão): repassado igual.
      return reply.status(status).send({ error: { ...fromCenario, requestId: request.id } });
    }
    if (status >= 500) request.log.error(error);
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: status >= 500 ? 'Erro inesperado no Firma Viva.' : (error as Error).message,
        requestId: request.id,
      },
    });
  });

  app.get('/api/health', { config: { rule: { public: true } } }, async () => ({
    ok: true,
    produto: 'Firma Viva',
  }));
  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(connectionRoutes);
  await app.register(entrarRoutes);
  await app.register(gameRoutes);
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      if (!opts.db) await db.$disconnect();
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    cenarioFetch: typeof fetch;
  }
}
