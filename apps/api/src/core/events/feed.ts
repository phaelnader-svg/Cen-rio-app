import type { DomainEvent, PrismaClient } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';

type Listener = (events: DomainEvent[]) => void;

/**
 * Fluxo de eventos confirmados no banco.
 *
 * Usa LISTEN/NOTIFY do PostgreSQL para baixa latência e uma varredura periódica
 * como contingência (notificações podem se perder em quedas de conexão). Como a
 * leitura é sempre "seq > último entregue", a combinação nunca perde eventos e
 * funciona igualmente com várias instâncias da API.
 */
export class EventFeed {
  private client: pg.Client | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeq = 0n;
  private fetching: Promise<void> | null = null;
  private pending = false;
  private stopped = true;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly databaseUrl: string,
    private readonly log: FastifyBaseLogger,
    private readonly pollIntervalMs = 2_000,
  ) {}

  get headSeq(): bigint {
    return this.lastSeq;
  }

  onEvents(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const head = await this.prisma.domainEvent.aggregate({ _max: { seq: true } });
    this.lastSeq = head._max.seq ?? 0n;
    await this.connectListener();
    this.pollTimer = setInterval(() => void this.fetchNew(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
    await this.fetching;
  }

  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('notification', () => void this.fetchNew());
    client.on('error', (err) => {
      this.log.warn({ err }, 'Conexão LISTEN perdida; usando varredura até reconectar');
      this.scheduleReconnect();
    });
    client.on('end', () => this.scheduleReconnect());
    try {
      await client.connect();
      await client.query('LISTEN cenario_domain_events');
      this.client = client;
      // Recupera o que tiver chegado durante a reconexão.
      void this.fetchNew();
    } catch (err) {
      this.log.warn({ err }, 'Não foi possível escutar eventos do banco; nova tentativa em breve');
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.client = null;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, 3_000);
    this.reconnectTimer.unref();
  }

  /** Busca eventos novos (serializado; chamadas concorrentes geram no máximo uma nova rodada). */
  fetchNew(): Promise<void> {
    if (this.fetching) {
      this.pending = true;
      return this.fetching;
    }
    this.fetching = (async () => {
      try {
        do {
          this.pending = false;
          for (;;) {
            const events = await this.prisma.domainEvent.findMany({
              where: { seq: { gt: this.lastSeq } },
              orderBy: { seq: 'asc' },
              take: 500,
            });
            if (events.length === 0) break;
            this.lastSeq = events[events.length - 1]!.seq;
            for (const listener of this.listeners) {
              try {
                listener(events);
              } catch (err) {
                this.log.error({ err }, 'Falha ao entregar eventos a um ouvinte');
              }
            }
            if (events.length < 500) break;
          }
        } while (this.pending && !this.stopped);
      } catch (err) {
        if (!this.stopped) this.log.error({ err }, 'Falha ao ler eventos novos');
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }
}
