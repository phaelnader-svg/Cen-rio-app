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
/** Eventos examinados por lote e, no máximo, por chamada de `/api/sync/events`. */
export const SYNC_SCAN_BATCH = 500;
export const SYNC_MAX_SCANNED = 5000;

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
   * Reconciliação por HTTP (alternativa ao reenvio pelo WebSocket): eventos visíveis para a
   * sessão a partir de `since`, em ordem de `seq`.
   *
   * Leitura LIMITADA por chamada (auditoria P4): no máximo `SYNC_MAX_SCANNED` eventos são
   * examinados, mesmo que poucos sejam visíveis para a sessão. A continuação é o cursor
   * `nextSince`, com a garantia: todo evento com `since < seq <= nextSince` foi examinado e, se
   * visível, está nesta página ou numa anterior. Por isso:
   * - página cheia (`limit`): `nextSince` = `seq` do último evento DEVOLVIDO (os visíveis depois
   *   dele não são pulados);
   * - limite de leitura atingido: `nextSince` = último `seq` EXAMINADO (eventos invisíveis não
   *   são perdidos — não pertencem à sessão — e o cursor avança sem repetir a varredura).
   * `seq` segue a ordem de commit (trava em `appendEvent`), então o cursor não pula eventos
   * confirmados depois. `hasMore` indica que há eventos a examinar depois de `nextSince`.
   */
  app.get('/api/sync/events', { config: { access: { session: 'any' } } }, async (request) => {
    const q = eventsSinceSchema.parse(request.query);
    const auth = request.auth!;
    const page: Awaited<ReturnType<typeof prisma.domainEvent.findMany>> = [];
    let next = BigInt(q.since);
    let scanned = 0;
    let exhausted = false;
    let full = false;
    while (!exhausted && !full && scanned < SYNC_MAX_SCANNED) {
      const take = Math.min(SYNC_SCAN_BATCH, SYNC_MAX_SCANNED - scanned);
      const batch = await prisma.domainEvent.findMany({
        where: { seq: { gt: next } },
        orderBy: { seq: 'asc' },
        take,
      });
      exhausted = batch.length < take;
      for (const [i, e] of batch.entries()) {
        scanned++;
        next = e.seq;
        if (!audienceAllows(e.audience, auth)) continue;
        page.push(e);
        if (page.length === q.limit) {
          full = true;
          // Só não há mais nada se este era o último de um lote que não veio cheio.
          exhausted = exhausted && i === batch.length - 1;
          break;
        }
      }
    }
    return {
      events: page.map(toRealtimeEvent),
      hasMore: !exhausted,
      nextSince: next.toString(),
    };
  });
}
