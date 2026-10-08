import { EVENT_TYPES, eventsSinceSchema, syncSignalSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { toRealtimeEvent } from '../../core/realtime/serialize';

/**
 * Diagnóstico de sincronização: sinais de teste persistidos como eventos reais,
 * entregues a todas as sessões conectadas com a permissão de diagnóstico. Serve
 * para o gestor verificar, a qualquer momento, que painel e tablets estão
 * recebendo atualizações (inclusive após queda de conexão).
 */
export async function syncRoutes(app: FastifyInstance) {
  const { prisma, hub } = app.ctx;

  app.post(
    '/api/sync/signal',
    {
      config: {
        access: { session: 'any', permissions: ['sincronizacao.diagnosticar'] },
        idempotent: true,
      },
    },
    async (request, reply) => {
      const input = syncSignalSchema.parse(request.body);
      const auth = request.auth!;
      const device = auth.deviceId
        ? await prisma.device.findUnique({ where: { id: auth.deviceId }, select: { name: true } })
        : null;
      const event = await prisma.$transaction((tx) =>
        appendEvent(tx, actorFrom(request), {
          type: EVENT_TYPES.SYNC_SIGNAL,
          aggregateType: 'sync',
          aggregateId: auth.sessionId,
          payload: {
            message: input.message,
            from: {
              userId: auth.userId,
              displayName: auth.displayName,
              surface: auth.kind === 'WEB' ? 'painel' : 'tablet',
              deviceName: device?.name ?? null,
            },
          },
          audience: 'permission:sincronizacao.diagnosticar',
        }),
      );
      return reply.status(201).send(toRealtimeEvent(event));
    },
  );

  app.get('/api/sync/status', { config: { access: { session: 'any' } } }, async () => {
    const head = await prisma.domainEvent.aggregate({ _max: { seq: true } });
    return {
      headSeq: (head._max.seq ?? 0n).toString(),
      connections: hub.size,
      serverTime: new Date().toISOString(),
    };
  });

  /**
   * Reconciliação por HTTP (alternativa ao reenvio pelo WebSocket): eventos
   * visíveis para a sessão a partir de `since`.
   */
  app.get('/api/sync/events', { config: { access: { session: 'any' } } }, async (request) => {
    const q = eventsSinceSchema.parse(request.query);
    const auth = request.auth!;
    const audiences = [
      'all',
      `user:${auth.userId}`,
      ...[...auth.permissions].map((p) => `permission:${p}`),
    ];
    const rows = await prisma.domainEvent.findMany({
      where: { seq: { gt: BigInt(q.since) }, audience: { in: audiences } },
      orderBy: { seq: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return { events: page.map(toRealtimeEvent), hasMore: rows.length > q.limit };
  });
}
