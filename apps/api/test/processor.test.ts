import type { DomainEvent } from '@cenario/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventProcessor } from '../src/core/events/processor';
import { db, resetDatabase } from './helpers';

const silent = { warn: () => undefined, error: () => undefined, info: () => undefined } as never;

async function emit(n: number) {
  for (let i = 0; i < n; i++) {
    await db().domainEvent.create({
      data: { type: 'sync.signal', aggregateType: 't', aggregateId: String(i), payload: { i } },
    });
  }
}

describe('Processamento confiável de eventos (automações)', () => {
  beforeEach(resetDatabase);

  it('entrega em ordem, uma única vez, e guarda o checkpoint', async () => {
    await emit(5);
    const seen: number[] = [];
    const p = new EventProcessor(db(), silent);
    const consumer = {
      name: 'teste-ordem',
      handle: async (e: DomainEvent) => {
        seen.push((e.payload as { i: number }).i);
      },
    };
    p.register(consumer);
    await p.kick();
    await p.kick();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    const cp = await db().eventConsumer.findUniqueOrThrow({ where: { name: 'teste-ordem' } });
    expect(cp.lastSeq).toBe(5n);
  });

  it('falha não avança o checkpoint; nova tentativa processa a partir do evento que falhou', async () => {
    await emit(3);
    let fail = true;
    const seen: number[] = [];
    const p = new EventProcessor(db(), silent);
    p.register({
      name: 'teste-falha',
      handle: async (e) => {
        const i = (e.payload as { i: number }).i;
        if (i === 1 && fail) throw new Error('indisponível');
        seen.push(i);
      },
    });
    await p.kick();
    expect(seen).toEqual([0]);
    const cp = await db().eventConsumer.findUniqueOrThrow({ where: { name: 'teste-falha' } });
    expect(cp.lastSeq).toBe(1n);
    expect(cp.failedAttempts).toBe(1);
    expect(cp.lastError).toContain('indisponível');

    fail = false;
    await db().eventConsumer.update({
      where: { name: 'teste-falha' },
      data: { nextAttemptAt: null },
    });
    await p.kick();
    expect(seen).toEqual([0, 1, 2]);
  });

  it('efeitos no banco feitos pelo handler são atômicos com o checkpoint', async () => {
    await emit(1);
    const p = new EventProcessor(db(), silent);
    p.register({
      name: 'teste-atomico',
      handle: async (_e, tx) => {
        await tx.auditLog.create({ data: { action: 'auto', entityType: 't', summary: 'efeito' } });
        throw new Error('falhou depois do efeito');
      },
    });
    await p.kick();
    expect(await db().auditLog.count({ where: { action: 'auto' } })).toBe(0);
  });

  it('duas instâncias não processam o mesmo consumidor em paralelo', async () => {
    await emit(20);
    const seen: number[] = [];
    const make = () => {
      const p = new EventProcessor(db(), silent);
      p.register({
        name: 'teste-concorrente',
        handle: async (e) => {
          seen.push((e.payload as { i: number }).i);
        },
      });
      return p;
    };
    await Promise.all([make().kick(), make().kick(), make().kick()]);
    await make().kick();
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
