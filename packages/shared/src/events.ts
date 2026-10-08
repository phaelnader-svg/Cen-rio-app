/**
 * Eventos de domínio persistentes.
 *
 * Todo evento é gravado na tabela `domain_events` na mesma transação da
 * alteração que o originou (padrão outbox). Cada evento recebe uma sequência
 * global crescente usada pelos clientes para reconciliação após reconexão.
 */

export const EVENT_TYPES = {
  EMPLOYEE_CREATED: 'employee.created',
  EMPLOYEE_UPDATED: 'employee.updated',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  DEVICE_REGISTERED: 'device.registered',
  DEVICE_UPDATED: 'device.updated',
  DEVICE_PAIRED: 'device.paired',
  DEVICE_REVOKED: 'device.revoked',
  DEVICE_CONNECTION_CHANGED: 'device.connection_changed',
  SESSION_REVOKED: 'session.revoked',
  COMPANY_SETTINGS_UPDATED: 'company.settings_updated',
  SYNC_SIGNAL: 'sync.signal',
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_CANCELLED: 'order.cancelled',
  PICKUP_CREATED: 'pickup.created',
  PICKUP_UPDATED: 'pickup.updated',
  PICKUP_STATUS_CHANGED: 'pickup.status_changed',
  RECEIPT_REGISTERED: 'receipt.registered',
  SERVICE_ORDER_CREATED: 'service_order.created',
  SERVICE_ORDER_UPDATED: 'service_order.updated',
  ATTACHMENT_CHANGED: 'attachment.changed',
  MEASUREMENT_ASSIGNED: 'measurement.assigned',
  MEASUREMENT_STARTED: 'measurement.started',
  MEASUREMENT_UPDATED: 'measurement.updated',
  MEASUREMENT_COMPLETED: 'measurement.completed',
  MEASUREMENT_CANCELLED: 'measurement.cancelled',
  MATERIAL_REQUEST_SUBMITTED: 'material_request.submitted',
  MATERIAL_REQUEST_IN_REVIEW: 'material_request.in_review',
  MATERIAL_REQUEST_REVISED: 'material_request.revised',
  MATERIAL_REQUEST_APPROVED: 'material_request.approved',
  MATERIAL_REQUEST_RETURNED: 'material_request.returned',
  MATERIAL_REQUEST_REOPENED: 'material_request.reopened',
  SUPPLIER_CHANGED: 'supplier.changed',
  PURCHASE_ORDER_CREATED: 'purchase_order.created',
  PURCHASE_ORDER_UPDATED: 'purchase_order.updated',
  PURCHASE_ORDER_CONFIRMED: 'purchase_order.confirmed',
  PURCHASE_ORDER_CANCELLED: 'purchase_order.cancelled',
  MATERIAL_PARTIALLY_RECEIVED: 'material.partially_received',
  MATERIAL_RECEIVED: 'material.received',
  MATERIAL_RECEIPT_REVERSED: 'material_receipt.reversed',
  STOCK_RESERVED: 'stock.reserved',
  STOCK_RELEASED: 'stock.released',
  STOCK_MOVED: 'stock.moved',
  MATERIAL_SHORTAGE_DETECTED: 'material.shortage_detected',
  MATERIAL_READINESS_CHANGED: 'material.readiness_changed',
  LEFTOVER_CHANGED: 'leftover.changed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Audiência de um evento: quem pode recebê-lo em tempo real.
 * - `all`: qualquer sessão autenticada.
 * - `permission:<p>`: apenas sessões com a permissão.
 * - `user:<id>`: apenas sessões do usuário.
 * Várias audiências podem ser combinadas com `|` (basta atender a uma).
 */
type SingleAudience = 'all' | `permission:${string}` | `user:${string}`;
export type EventAudience = SingleAudience | `${SingleAudience}|${string}`;

/** Monta uma audiência "qualquer uma destas permissões". */
export function anyPermissionAudience(...permissions: string[]): EventAudience {
  return permissions.map((p) => `permission:${p}`).join('|') as EventAudience;
}

/** Verifica se um destinatário atende à audiência do evento. */
export function audienceAllows(
  audience: string,
  who: { userId: string; permissions: ReadonlySet<string> },
): boolean {
  return audience.split('|').some((a) => {
    if (a === 'all') return true;
    if (a.startsWith('permission:')) return who.permissions.has(a.slice('permission:'.length));
    if (a.startsWith('user:')) return who.userId === a.slice('user:'.length);
    return false;
  });
}

export interface RealtimeEvent<T = unknown> {
  /** Sequência global (string para preservar precisão de bigint). */
  seq: string;
  id: string;
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  payload: T;
  occurredAt: string;
}

/** Mensagens servidor → cliente no canal de tempo real. */
export type ServerMessage =
  | { kind: 'hello'; sessionId: string; userId: string; headSeq: string }
  | { kind: 'event'; event: RealtimeEvent }
  | { kind: 'replay.done'; fromSeq: string; toSeq: string; count: number }
  | { kind: 'resync.required'; reason: 'gap_too_large' | 'unknown_cursor'; headSeq: string }
  | { kind: 'pong'; t: number }
  | { kind: 'session.ended'; reason: 'revoked' | 'expired' | 'logout' };

/** Mensagens cliente → servidor. */
export type ClientMessage =
  | { kind: 'resume'; sinceSeq: string | null }
  | { kind: 'ping'; t: number };

/** Máximo de eventos reenviados numa reconexão antes de exigir ressincronização completa. */
export const MAX_REPLAY_EVENTS = 500;
