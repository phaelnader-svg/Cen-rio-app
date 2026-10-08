import { EVENT_TYPES, audienceAllows, eventsSinceSchema, syncSignalSchema } from '@cenario/shared';
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
    // A audiência pode combinar várias regras ("a|b"); o filtro é feito aqui,
    // em lotes, para que eventos invisíveis não reduzam a página devolvida.
    const visible: Awaited<ReturnType<typeof prisma.domainEvent.findMany>> = [];
    let cursor = BigInt(q.since);
    let exhausted = false;
    while (visible.length <= q.limit && !exhausted) {
      const batch = await prisma.domainEvent.findMany({
        where: { seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: 500,
      });
      exhausted = batch.length < 500;
      for (const e of batch) if (audienceAllows(e.audience, auth)) visible.push(e);
      if (batch.length) cursor = batch[batch.length - 1]!.seq;
    }
    const page = visible.slice(0, q.limit);
    return { events: page.map(toRealtimeEvent), hasMore: visible.length > q.limit };
  });
}
