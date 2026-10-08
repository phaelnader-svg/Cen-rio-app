import type { AuditLogDto } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Cursor opaco: "<ISO date>|<id>" do último item da página anterior. */
  cursor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/)
    .optional(),
  entityType: z.string().max(60).optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/audit',
    { config: { access: { session: 'WEB', permissions: ['auditoria.ver'] } } },
    async (request) => {
      const q = querySchema.parse(request.query);
      const [cursorDate, cursorId] = q.cursor?.split('|') ?? [];
      const rows = await prisma.auditLog.findMany({
        where: {
          ...(q.entityType ? { entityType: q.entityType } : {}),
          ...(cursorDate && cursorId
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursorDate) } },
                  { createdAt: new Date(cursorDate), id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        include: { actor: { select: { id: true, displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(
          (r): AuditLogDto => ({
            id: r.id,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            actor: r.actor,
            summary: r.summary,
            changes: r.changes,
            ipAddress: r.ipAddress,
            createdAt: r.createdAt.toISOString(),
          }),
        ),
        nextCursor:
          rows.length > q.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
      };
    },
  );
}
