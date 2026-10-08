import { EVENT_TYPES, type NotificationDto } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';

const listQuery = z.object({
  unread: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ACCESS = { session: 'any' } as const;

/**
 * Caixa de notificações do usuário autenticado (painel ou tablet). Cada usuário
 * só vê e marca as próprias; a tarefa vinculada continua protegida pela rota da tarefa.
 */
export async function notificationRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  const toDto = (n: {
    id: string;
    kind: string;
    title: string;
    body: string;
    taskId: string | null;
    serviceOrderId: string | null;
    createdAt: Date;
    readAt: Date | null;
  }): NotificationDto => ({
    id: n.id,
    kind: n.kind as NotificationDto['kind'],
    title: n.title,
    body: n.body,
    taskId: n.taskId,
    serviceOrderId: n.serviceOrderId,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
  });

  app.get('/api/v1/notifications', { config: { access: ACCESS } }, async (request) => {
    const q = listQuery.parse(request.query);
    const userId = request.auth!.userId;
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId, ...(q.unread ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { items: items.map(toDto), unread };
  });

  async function markRead(
    userId: string,
    ids: string[] | null,
    request: Parameters<typeof actorFrom>[0],
  ) {
    const changed = await prisma.$transaction(async (tx) => {
      const r = await tx.notification.updateMany({
        where: { userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
        data: { readAt: new Date() },
      });
      if (r.count > 0) {
        // Outras sessões do mesmo usuário (ex.: painel e tablet) atualizam o contador.
        await appendEvent(tx, actorFrom(request), {
          type: EVENT_TYPES.NOTIFICATION_READ,
          aggregateType: 'notification',
          aggregateId: userId,
          payload: { count: r.count },
          audience: `user:${userId}`,
        });
      }
      return r.count;
    });
    const unread = await prisma.notification.count({ where: { userId, readAt: null } });
    return { changed, unread };
  }

  app.post('/api/v1/notifications/:id/read', { config: { access: ACCESS } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const userId = request.auth!.userId;
    const n = await prisma.notification.findUnique({ where: { id } });
    // Notificação de outra pessoa responde como inexistente (não revela que existe).
    if (!n || n.userId !== userId) throw Errors.notFound('Notificação');
    return markRead(userId, [id], request);
  });

  app.post('/api/v1/notifications/read-all', { config: { access: ACCESS } }, async (request) =>
    markRead(request.auth!.userId, null, request),
  );
}
