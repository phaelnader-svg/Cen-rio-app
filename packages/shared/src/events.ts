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
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Audiência de um evento: quem pode recebê-lo em tempo real.
 * - `all`: qualquer sessão autenticada.
 * - `permission:<p>`: apenas sessões com a permissão.
 * - `user:<id>`: apenas sessões do usuário.
 */
export type EventAudience = 'all' | `permission:${string}` | `user:${string}`;

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
