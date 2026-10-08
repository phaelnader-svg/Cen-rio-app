import {
  EVENT_TYPES,
  audienceAllows,
  MAX_REPLAY_EVENTS,
  type ClientMessage,
  type Permission,
  type ServerMessage,
  type SessionKind,
} from '@cenario/shared';
import type { DomainEvent, PrismaClient } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { loadUserPermissions } from '../permissions';
import type { EventFeed } from '../events/feed';
import { toRealtimeEvent } from './serialize';

export interface ConnectionIdentity {
  sessionId: string;
  userId: string;
  kind: SessionKind;
  deviceId: string | null;
  permissions: ReadonlySet<Permission>;
}

interface Connection extends ConnectionIdentity {
  id: number;
  socket: WebSocket;
  permissions: Set<Permission>;
  /** Último seq entregue a este cliente. */
  cursor: bigint;
  /** Durante o reenvio pós-reconexão, eventos ao vivo ficam em espera. */
  replaying: boolean;
  buffer: DomainEvent[];
  resumed: boolean;
  alive: boolean;
}

export interface PresenceHandler {
  (deviceId: string, online: boolean): void;
}

const MAX_BUFFERED_BYTES = 1_000_000;
const OFFLINE_GRACE_MS = 10_000;

/**
 * Central de tempo real: mantém as conexões WebSocket autenticadas, entrega
 * eventos conforme a audiência, reenvia eventos perdidos após reconexão e
 * encerra imediatamente conexões de sessões revogadas.
 */
export class RealtimeHub {
  private readonly connections = new Map<number, Connection>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private revalidate: NodeJS.Timeout | null = null;
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private presenceHandler: PresenceHandler | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly feed: EventFeed,
    private readonly log: FastifyBaseLogger,
  ) {
    feed.onEvents((events) => this.dispatch(events));
  }

  start(): void {
    this.heartbeat = setInterval(() => this.checkHeartbeats(), 25_000);
    this.heartbeat.unref();
    this.revalidate = setInterval(() => void this.revalidateSessions(), 60_000);
    this.revalidate.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.revalidate) clearInterval(this.revalidate);
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    for (const c of this.connections.values()) c.socket.close(1001, 'Servidor reiniciando');
    this.connections.clear();
  }

  onPresence(handler: PresenceHandler): void {
    this.presenceHandler = handler;
  }

  get size(): number {
    return this.connections.size;
  }

  isDeviceOnline(deviceId: string): boolean {
    for (const c of this.connections.values()) if (c.deviceId === deviceId) return true;
    return this.offlineTimers.has(deviceId);
  }

  attach(socket: WebSocket, identity: ConnectionIdentity): void {
    const conn: Connection = {
      ...identity,
      permissions: new Set(identity.permissions),
      id: this.nextId++,
      socket,
      cursor: this.feed.headSeq,
      // Até o cliente informar de onde retomar ("resume"), eventos ao vivo ficam em espera.
      replaying: true,
      buffer: [],
      resumed: false,
      alive: true,
    };
    this.connections.set(conn.id, conn);
    if (conn.deviceId) this.markDeviceOnline(conn.deviceId);

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (raw) => void this.onMessage(conn, raw.toString()));
    socket.on('close', () => this.detach(conn));
    socket.on('error', (err) => {
      this.log.debug({ err, conn: conn.id }, 'Erro em conexão de tempo real');
    });

    this.send(conn, {
      kind: 'hello',
      sessionId: conn.sessionId,
      userId: conn.userId,
      headSeq: conn.cursor.toString(),
    });

    // Cliente que não envia "resume" passa a receber apenas eventos ao vivo.
    const resumeTimeout = setTimeout(() => {
      if (conn.replaying && this.connections.has(conn.id)) this.goLive(conn);
    }, 10_000);
    resumeTimeout.unref();
  }

  private goLive(conn: Connection): void {
    conn.replaying = false;
    const buffered = conn.buffer;
    conn.buffer = [];
    for (const event of buffered) this.deliver(conn, event);
  }

  private detach(conn: Connection): void {
    if (!this.connections.delete(conn.id)) return;
    if (conn.deviceId) {
      const stillConnected = [...this.connections.values()].some(
        (c) => c.deviceId === conn.deviceId,
      );
      if (!stillConnected) this.scheduleDeviceOffline(conn.deviceId);
    }
  }

  private markDeviceOnline(deviceId: string): void {
    const pendingOffline = this.offlineTimers.get(deviceId);
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      this.offlineTimers.delete(deviceId);
      return; // reconexão rápida: não houve mudança perceptível
    }
    const already = [...this.connections.values()].filter((c) => c.deviceId === deviceId);
    if (already.length === 1) this.presenceHandler?.(deviceId, true);
  }

  private scheduleDeviceOffline(deviceId: string): void {
    const timer = setTimeout(() => {
      this.offlineTimers.delete(deviceId);
      const reconnected = [...this.connections.values()].some((c) => c.deviceId === deviceId);
      if (!reconnected) this.presenceHandler?.(deviceId, false);
    }, OFFLINE_GRACE_MS);
    timer.unref();
    this.offlineTimers.set(deviceId, timer);
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    if (msg.kind === 'ping' && typeof msg.t === 'number') {
      this.send(conn, { kind: 'pong', t: msg.t });
      return;
    }
    if (msg.kind === 'resume') {
      await this.replay(conn, msg.sinceSeq);
    }
  }

  /** Reenvia ao cliente os eventos perdidos desde `sinceSeq` (reconciliação). */
  private async replay(conn: Connection, sinceSeq: string | null): Promise<void> {
    if (conn.resumed || !conn.replaying) return; // "resume" só é aceito uma vez, logo após o hello
    conn.resumed = true;
    if (sinceSeq === null || !/^\d{1,19}$/.test(sinceSeq)) {
      this.goLive(conn);
      return;
    }
    const since = BigInt(sinceSeq);
    const head = this.feed.headSeq;
    if (since > head) {
      this.send(conn, {
        kind: 'resync.required',
        reason: 'unknown_cursor',
        headSeq: head.toString(),
      });
      this.goLive(conn);
      return;
    }
    try {
      const missed = await this.prisma.domainEvent.findMany({
        where: { seq: { gt: since } },
        orderBy: { seq: 'asc' },
        take: MAX_REPLAY_EVENTS + 1,
      });
      if (missed.length > MAX_REPLAY_EVENTS) {
        conn.cursor = this.feed.headSeq;
        this.send(conn, {
          kind: 'resync.required',
          reason: 'gap_too_large',
          headSeq: conn.cursor.toString(),
        });
        return;
      }
      conn.cursor = since;
      let count = 0;
      for (const event of missed) {
        if (this.deliver(conn, event)) count++;
      }
      this.send(conn, {
        kind: 'replay.done',
        fromSeq: since.toString(),
        toSeq: conn.cursor.toString(),
        count,
      });
    } finally {
      this.goLive(conn);
    }
  }

  private dispatch(events: DomainEvent[]): void {
    const permissionChanged = events.some((e) =>
      [EVENT_TYPES.ROLE_UPDATED, EVENT_TYPES.ROLE_DELETED, EVENT_TYPES.EMPLOYEE_UPDATED].includes(
        e.type as never,
      ),
    );

    for (const event of events) {
      this.handleControlEvent(event);
      for (const conn of this.connections.values()) {
        if (conn.replaying) conn.buffer.push(event);
        else this.deliver(conn, event);
      }
    }
    if (permissionChanged) void this.refreshPermissions();
  }

  /** Entrega um evento se for novo para a conexão e visível para ela. */
  private deliver(conn: Connection, event: DomainEvent): boolean {
    if (event.seq <= conn.cursor) return false;
    conn.cursor = event.seq;
    if (!this.canSee(conn, event.audience)) return false;
    this.send(conn, { kind: 'event', event: toRealtimeEvent(event) });
    return true;
  }

  private canSee(conn: Connection, audience: string): boolean {
    return audienceAllows(audience, conn);
  }

  private handleControlEvent(event: DomainEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === EVENT_TYPES.SESSION_REVOKED && Array.isArray(payload.sessionIds)) {
      const ids = new Set(payload.sessionIds as string[]);
      this.endWhere((c) => ids.has(c.sessionId), 'revoked');
    }
    if (event.type === EVENT_TYPES.DEVICE_REVOKED) {
      this.endWhere((c) => c.deviceId === event.aggregateId, 'revoked');
    }
  }

  /** Encerra conexões (o cliente recebe o motivo antes do fechamento). */
  endWhere(
    predicate: (c: ConnectionIdentity) => boolean,
    reason: 'revoked' | 'expired' | 'logout',
  ) {
    for (const conn of [...this.connections.values()]) {
      if (!predicate(conn)) continue;
      this.send(conn, { kind: 'session.ended', reason });
      conn.socket.close(4401, 'Sessão encerrada');
      this.detach(conn);
    }
  }

  private async refreshPermissions(): Promise<void> {
    const byUser = new Map<string, Connection[]>();
    for (const c of this.connections.values()) {
      byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
    }
    for (const [userId, conns] of byUser) {
      try {
        const perms = await loadUserPermissions(this.prisma, userId);
        for (const c of conns) c.permissions = perms;
      } catch (err) {
        this.log.warn({ err }, 'Falha ao atualizar permissões de conexões');
      }
    }
  }

  private checkHeartbeats(): void {
    for (const conn of [...this.connections.values()]) {
      if (!conn.alive) {
        conn.socket.terminate();
        this.detach(conn);
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        /* conexão já encerrada */
      }
    }
  }

  /** Encerra conexões de sessões expiradas ou revogadas por outro caminho. */
  async revalidateSessions(): Promise<void> {
    if (this.connections.size === 0) return;
    const ids = [...new Set([...this.connections.values()].map((c) => c.sessionId))];
    try {
      const valid = await this.prisma.session.findMany({
        where: {
          id: { in: ids },
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: { active: true },
        },
        select: { id: true },
      });
      const validIds = new Set(valid.map((s) => s.id));
      this.endWhere((c) => !validIds.has(c.sessionId), 'expired');
    } catch (err) {
      this.log.warn({ err }, 'Falha ao revalidar sessões de tempo real');
    }
  }

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    if (conn.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.log.warn({ conn: conn.id }, 'Cliente lento demais; conexão encerrada');
      conn.socket.terminate();
      this.detach(conn);
      return;
    }
    conn.socket.send(JSON.stringify(message));
  }
}
