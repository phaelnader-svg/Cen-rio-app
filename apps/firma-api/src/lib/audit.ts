import type { Prisma } from '@firma/db';
import type { FastifyRequest } from 'fastify';

/** Auditoria do Firma Viva: quem, em qual organização e em qual empresa conectada. */
export async function audit(
  request: FastifyRequest,
  entry: {
    action: string;
    summary: string;
    company?: string | null;
    details?: object;
    orgId?: string | null;
  },
) {
  await request.server.firma.db.auditLog.create({
    data: {
      orgId: entry.orgId === undefined ? (request.org?.id ?? null) : entry.orgId,
      userId: request.user?.id ?? null,
      action: entry.action.slice(0, 60),
      summary: entry.summary.slice(0, 400),
      company: entry.company?.slice(0, 160) ?? null,
      details: (entry.details as Prisma.InputJsonValue | undefined) ?? undefined,
      ipAddress: request.ip?.slice(0, 64) ?? null,
    },
  });
}
