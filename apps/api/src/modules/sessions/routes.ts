import type { SessionDto } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { revokeSessions } from '../../core/sessions';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';

export async function sessionRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/sessions',
    { config: { access: { session: 'WEB', permissions: ['sessoes.ver'] } } },
    async (request) => {
      const sessions = await prisma.session.findMany({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        include: {
          user: { select: { id: true, displayName: true } },
          device: { select: { id: true, name: true } },
        },
        orderBy: { lastSeenAt: 'desc' },
        take: 500,
      });
      return sessions.map(
        (s): SessionDto => ({
          id: s.id,
          kind: s.kind,
          user: s.user,
          device: s.device,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          current: s.id === request.auth!.sessionId,
        }),
      );
    },
  );

  app.post(
    '/api/sessions/:id/revoke',
    { config: { access: { session: 'WEB', permissions: ['sessoes.revogar'] } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: { id },
          include: { user: { select: { displayName: true } }, device: { select: { name: true } } },
        });
        if (!session || session.revokedAt) throw Errors.notFound('Sessão ativa');
        const actor = actorFrom(request);
        await revokeSessions(tx, actor, { id }, 'revoked_by_admin');
        await audit(tx, actor, {
          action: 'session.revoked',
          entityType: 'session',
          entityId: id,
          summary: `Sessão de ${session.user.displayName}${
            session.device ? ` no dispositivo "${session.device.name}"` : ' no painel'
          } encerrada remotamente.`,
        });
      });
      return reply.status(204).send();
    },
  );
}
