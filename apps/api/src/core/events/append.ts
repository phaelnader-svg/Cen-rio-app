import type { EventAudience, EventType } from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import type { ActorContext } from '../types';

/**
 * Chave do advisory lock que serializa a gravação de eventos. Garante que a
 * ordem de `seq` seja igual à ordem de COMMIT, de modo que nenhum leitor (tempo
 * real, consumidores) "pule" um evento com sequência menor confirmado depois.
 * Chame `appendEvent` no FINAL da transação para manter o lock por pouco tempo.
 */
const EVENT_LOCK_KEY = 7_263_540_001;

export interface NewEvent {
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  payload: Prisma.InputJsonValue;
  audience?: EventAudience;
}

export async function appendEvent(tx: Tx, actor: ActorContext, event: NewEvent) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EVENT_LOCK_KEY}::bigint)`;
  return tx.domainEvent.create({
    data: {
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      audience: event.audience ?? 'all',
      actorUserId: actor.userId,
      requestId: actor.requestId,
    },
  });
}

export async function appendEvents(tx: Tx, actor: ActorContext, events: NewEvent[]) {
  for (const e of events) await appendEvent(tx, actor, e);
}
