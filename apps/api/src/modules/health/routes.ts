import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  const { prisma, env } = app.ctx;

  /** Liveness: o processo está respondendo. */
  app.get('/api/health', { config: { access: { public: true } } }, async () => ({
    status: 'ok',
    environment: env.APP_ENV,
  }));

  /** Readiness: dependências (banco) disponíveis. */
  app.get('/api/ready', { config: { access: { public: true } } }, async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
}
