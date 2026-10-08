import type { Prisma, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import type { ActorContext } from './types';

export function actorFrom(request: FastifyRequest): ActorContext {
  return {
    userId: request.auth?.userId ?? null,
    sessionId: request.auth?.sessionId ?? null,
    ip: request.ip ?? null,
    requestId: request.id ?? null,
  };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  /** Diferenças ou detalhes serializáveis em JSON (sem dados sensíveis). */
  changes?: object;
}

/** Grava auditoria dentro da transação da alteração (atômico com a mudança). */
export async function audit(tx: Tx, actor: ActorContext, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: actor.userId,
      sessionId: actor.sessionId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary.slice(0, 300),
      changes: (entry.changes as Prisma.InputJsonValue | undefined) ?? undefined,
      ipAddress: actor.ip,
      requestId: actor.requestId,
    },
  });
}
