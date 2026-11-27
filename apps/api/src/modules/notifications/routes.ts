import { EVENT_TYPES, hiddenNotificationKinds, type NotificationDto } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { shortCustomerName } from '../../core/device-privacy';
import { appendEvent } from '../../core/events/append';
import { moduleState } from '../../core/modules';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';

const listQuery = z.object({
  unread: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Rodada 2 (F10-19): ativas (padrão), resolvidas (histórico) ou todas. */
  status: z.enum(['ativas', 'resolvidas', 'todas']).default('ativas'),
});
const STATUS_WHERE = {
  ativas: { resolvedAt: null },
  resolvidas: { resolvedAt: { not: null } },
  todas: {},
} as const;

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
    resolvedAt: Date | null;
  }): NotificationDto => ({
    id: n.id,
    kind: n.kind as NotificationDto['kind'],
    title: n.title,
    body: n.body,
    taskId: n.taskId,
    serviceOrderId: n.serviceOrderId,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt?.toISOString() ?? null,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
  });

  /**
   * Reformulação, Fase 0: avisos de uma funcionalidade desligada (ex.: pedidos de ajuda) saem da
   * caixa e do contador — continuam gravados e voltam ao religar. Nada é apagado.
   */
  const visibleKinds = async () => {
    const hidden = hiddenNotificationKinds(await moduleState(prisma));
    return hidden.length ? { kind: { notIn: hidden } } : {};
  };

  app.get('/api/v1/notifications', { config: { access: ACCESS } }, async (request) => {
    const q = listQuery.parse(request.query);
    const userId = request.auth!.userId;
    const device = request.auth!.kind === 'DEVICE';
    const kinds = await visibleKinds();
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId,
          ...STATUS_WHERE[q.status],
          ...(q.unread ? { readAt: null } : {}),
          ...kinds,
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        // Tablet: o texto do aviso cita o cliente pela forma reduzida ("Maria F."), como as
        // demais respostas de tablet; o painel recebe o texto gravado, com o nome completo.
        include: device
          ? { serviceOrder: { select: { customer: { select: { name: true } } } } }
          : undefined,
      }),
      // O contador é de avisos ATIVOS não lidos: o que já foi resolvido não pede mais atenção.
      prisma.notification.count({ where: { userId, readAt: null, resolvedAt: null, ...kinds } }),
    ]);
    return {
      items: items.map((n) => {
        const name = (n as { serviceOrder?: { customer: { name: string } } | null }).serviceOrder
          ?.customer.name;
        const dto = toDto(n);
        return device && name
          ? { ...dto, body: dto.body.split(name).join(shortCustomerName(name)) }
          : dto;
      }),
      unread,
    };
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
    const unread = await prisma.notification.count({
      where: { userId, readAt: null, resolvedAt: null, ...(await visibleKinds()) },
    });
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
