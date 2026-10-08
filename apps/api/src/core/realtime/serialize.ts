import type { DomainEvent } from '@cenario/db';
import type { EventType, RealtimeEvent } from '@cenario/shared';

export function toRealtimeEvent(e: DomainEvent): RealtimeEvent {
  return {
    seq: e.seq.toString(),
    id: e.id,
    type: e.type as EventType,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    payload: e.payload,
    occurredAt: e.occurredAt.toISOString(),
  };
}
