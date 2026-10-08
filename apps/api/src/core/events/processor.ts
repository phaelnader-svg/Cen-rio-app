import type { DomainEvent, PrismaClient, Tx } from '@cenario/db';
import type { EventType } from '@cenario/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Consumidor de eventos (base para automações das próximas fases).
 *
 * Garantias:
 * - Ordem: eventos são entregues em ordem crescente de `seq`, um por vez.
 * - Atomicidade: o handler recebe a transação em que o checkpoint avança; efeitos
 *   no banco feitos via `tx` são confirmados junto com o checkpoint (exatamente
 *   uma vez para efeitos no banco; pelo menos uma vez para efeitos externos).
 * - Exclusividade: `FOR UPDATE SKIP LOCKED` impede que duas instâncias processem
 *   o mesmo consumidor simultaneamente.
 * - Falhas: o checkpoint não avança; o erro é registrado e a tentativa é
 *   repetida com espera exponencial (máx. 5 min). O consumidor fica bloqueado
 *   naquele evento até o sucesso, preservando a ordem.
 */
export interface EventConsumer {
  name: string;
  /** Tipos de interesse; eventos de outros tipos apenas avançam o checkpoint. */
  types?: readonly EventType[];
  handle(event: DomainEvent, tx: Tx): Promise<void>;
}

const MAX_BACKOFF_MS = 5 * 60_000;

export class EventProcessor {
  private readonly consumers = new Map<string, EventConsumer>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  register(consumer: EventConsumer): void {
    if (this.consumers.has(consumer.name)) {
      throw new Error(`Consumidor de eventos duplicado: ${consumer.name}`);
    }
    this.consumers.set(consumer.name, consumer);
  }

  get registered(): string[] {
    return [...this.consumers.keys()];
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.kick(), intervalMs);
    this.timer.unref();
    void this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Solicita processamento imediato (chamado quando chega notificação de novo evento). */
  async kick(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        for (const consumer of this.consumers.values()) {
          await this.drain(consumer);
        }
      } while (this.rerun);
    } catch (error) {
      this.log.error({ err: error }, 'Falha no processador de eventos');
    } finally {
      this.running = false;
    }
  }

  /** Processa todos os eventos pendentes de um consumidor. Retorna quantos foram processados. */
  async drain(consumer: EventConsumer): Promise<number> {
    await this.prisma.eventConsumer.upsert({
      where: { name: consumer.name },
      create: { name: consumer.name },
      update: {},
    });
    let processed = 0;
    while (await this.processNext(consumer)) processed++;
    return processed;
  }

  /**
   * Processa o PRÓXIMO evento do consumidor. Bloqueio, leitura do próximo evento,
   * execução e avanço do checkpoint acontecem na mesma transação, o que garante
   * que nenhum evento seja pulado mesmo com várias instâncias concorrentes.
   * Retorna false quando não há trabalho (ou outra instância detém o consumidor).
   */
  private async processNext(consumer: EventConsumer): Promise<boolean> {
    let current: DomainEvent | null = null;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ last_seq: bigint; next_attempt_at: Date | null }[]>`
            SELECT last_seq, next_attempt_at FROM event_consumers
            WHERE name = ${consumer.name} FOR UPDATE SKIP LOCKED`;
          const row = rows[0];
          if (!row) return false; // outra instância está processando
          if (row.next_attempt_at && row.next_attempt_at > new Date()) return false;
          const event = await tx.domainEvent.findFirst({
            where: { seq: { gt: row.last_seq } },
            orderBy: { seq: 'asc' },
          });
          if (!event) return false;
          current = event;
          const interested = !consumer.types || consumer.types.includes(event.type as EventType);
          if (interested) await consumer.handle(event, tx);
          await tx.eventConsumer.update({
            where: { name: consumer.name },
            data: { lastSeq: event.seq, failedAttempts: 0, lastError: null, nextAttemptAt: null },
          });
          return true;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      const failed = current as DomainEvent | null;
      const state = await this.prisma.eventConsumer.findUnique({ where: { name: consumer.name } });
      const attempts = (state?.failedAttempts ?? 0) + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 12));
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.eventConsumer.update({
        where: { name: consumer.name },
        data: {
          failedAttempts: attempts,
          lastError: `seq ${failed?.seq ?? '?'}: ${message}`.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + backoff),
        },
      });
      this.log.warn(
        { consumer: consumer.name, seq: failed?.seq.toString(), attempts, err: error },
        'Consumidor de eventos falhou; nova tentativa agendada',
      );
      return false;
    }
  }
}
