import type { Prisma, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import type { ActorContext } from './types';

export function actorFrom(request: FastifyRequest): ActorContext {
  // Painel da plataforma: não é usuário de nenhuma empresa; a auditoria diz quem foi pelo e-mail.
  if (request.platformAdmin)
    return {
      userId: null,
      sessionId: null,
      ip: request.ip ?? null,
      requestId: request.id ?? null,
      via: `Painel da plataforma (${request.platformAdmin.email})`,
    };
  return {
    userId: request.auth?.userId ?? null,
    sessionId: request.auth?.sessionId ?? null,
    ip: request.ip ?? null,
    requestId: request.id ?? null,
    via: request.auth?.app
      ? [request.auth.app.clientName, request.auth.app.externalLabel, request.auth.app.onBehalfOf]
          .filter(Boolean)
          .join(' · ')
      : null,
  };
}

/** Aceita a requisição (rotas) ou um ator já resolvido (serviços de domínio reutilizáveis). */
export function actorOf(source: FastifyRequest | ActorContext): ActorContext {
  return 'headers' in source ? actorFrom(source) : source;
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
  if (actor.via) {
    // Acesso delegado: registra por qual aplicativo, organização e pessoa a ação veio.
    entry = {
      ...entry,
      summary: `${entry.summary} [via ${actor.via}]`,
      changes: Array.isArray(entry.changes)
        ? { itens: entry.changes, via: actor.via }
        : { ...(entry.changes ?? {}), via: actor.via },
    };
  }
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
