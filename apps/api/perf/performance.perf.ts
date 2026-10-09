import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { EventProcessor } from '../src/core/events/processor';
import type { Client } from '../test/helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from '../test/helpers';
import { openServiceOrder } from '../test/measurement-helpers';
import { addOs, createPlan, publish, today, userIdOf } from '../test/production-helpers';
import { prepareCompany } from '../test/audit-helpers';

/**
 * Fase 12 — testes controlados de desempenho (somente local, sem serviços externos).
 * Gera volume sintético pela própria API (clientes, pedidos, OS, programação, financeiro) e
 * mede latências in-process (app.inject — sem rede), conexões WebSocket simultâneas, upload de
 * fotos e processamento de eventos. Resultado: docs/evidencias/fase-12/desempenho.json.
 * Executar: TEST_DATABASE_URL=…/cenario_perf_test pnpm --filter @cenario/api perf
 */
const VOLUME = { orders: Number(process.env.PERF_ORDERS ?? 120), planned: 40 };
let app: App;
let admin: Client;
const results: Record<string, unknown> = {};
const ids: { so: string[]; plan?: string } = { so: [] };

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
  await resetDatabase();
  await prepareCompany();
  admin = await loginAdmin(app);
}, 600_000);
afterAll(async () => {
  mkdirSync('../../docs/evidencias/fase-12', { recursive: true });
  writeFileSync(
    '../../docs/evidencias/fase-12/desempenho.json',
    JSON.stringify(
      {
        executadoEm: new Date().toISOString(),
        maquina: {
          cpus: cpus().length,
          modelo: cpus()[0]?.model,
          memoriaGB: Math.round(totalmem() / 2 ** 30),
        },
        node: process.version,
        volume: VOLUME,
        ...results,
      },
      null,
      2,
    ),
  );
  await app.close();
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};
async function measure(
  label: string,
  run: () => Promise<{ status: number }>,
  n = 20,
  concurrency = 5,
) {
  // Sessão nova por medição: o limite de 600 requisições/min é por sessão (proteção real).
  admin = await loginAdmin(app);
  await run(); // aquecimento
  const seq: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await run();
    seq.push(performance.now() - t);
    expect(r.status, label).toBeLessThan(400);
  }
  const par: number[] = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const t = performance.now();
      await run();
      par.push(performance.now() - t);
    }),
  );
  const out = {
    sequencial: { n, p50ms: pct(seq, 50), p95ms: pct(seq, 95), maxms: pct(seq, 100) },
    simultaneo: {
      n: concurrency,
      totalms: Math.round(performance.now() - t0),
      maxms: pct(par, 100),
    },
  };
  (results.latencias as Record<string, unknown>)[label] = out;
  return out;
}

/** PNG RGB válido com conteúdo pseudoaleatório (não comprime: tamanho realista de foto). */
function pngPhoto(w: number, h: number) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = 12345;
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = i % (w * 3 + 1) === 0 ? 0 : x & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('Desempenho', () => {
  it('gera volume sintético pela API', async () => {
    const t = performance.now();
    const cpu = process.cpuUsage();
    for (let i = 0; i < VOLUME.orders; i++) {
      if (i % 40 === 0) admin = await loginAdmin(app);
      const so = await openServiceOrder(admin, `Cliente Sintético ${String(i).padStart(3, '0')}`);
      ids.so.push(so.id);
    }
    admin = await loginAdmin(app);
    const plan = await createPlan(admin);
    ids.plan = plan.id;
    const ricardo = await userIdOf('Ricardo');
    for (const so of ids.so.slice(0, VOLUME.planned))
      await addOs(admin, plan.id, { serviceOrderId: so, principalUserId: ricardo, date: today() });
    const tp = performance.now();
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    results.publicacaoSemanal = { os: VOLUME.planned, ms: Math.round(performance.now() - tp) };
    admin = await loginAdmin(app);
    for (const [i, so] of ids.so.entries()) {
      if (i % 100 === 0) admin = await loginAdmin(app);
      const orderId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so } })).orderId;
      const r = await admin.post(
        '/api/v1/finance/receivables',
        {
          orderId,
          description: 'Entrada',
          amountCents: 100000,
          dueDate: today(),
          expectedMethod: 'PIX',
        },
        { 'idempotency-key': idemKey() },
      );
      expect(r.status).toBe(201);
    }
    const u = process.cpuUsage(cpu);
    results.geracao = {
      segundos: Math.round((performance.now() - t) / 100) / 10,
      cpuUsuarioS: Math.round(u.user / 1e5) / 10,
      registros: {
        os: await db().serviceOrder.count(),
        pecas: await db().serviceOrderItem.count(),
        tarefas: await db().productionTask.count(),
        eventosDeDominio: await db().domainEvent.count(),
        auditoria: await db().auditLog.count(),
      },
    };
    results.latencias = {};
  }, 900_000);

  it('consultas principais (latência in-process)', async () => {
    const so = ids.so[0]!;
    await measure('OS: lista (100)', () => admin.get('/api/v1/service-orders?limit=100'));
    await measure('OS: detalhe', () => admin.get(`/api/v1/service-orders/${so}`));
    await measure('Planejamento semanal (plano publicado)', () =>
      admin.get(`/api/v1/production-plans/${ids.plan}`),
    );
    await measure('Quadro de produção', () => admin.get('/api/v1/production-board'));
    await measure('Central de atenção', () => admin.get('/api/v1/attention'));
    await measure('Compras: necessidades', () => admin.get('/api/v1/purchasing/needs'));
    await measure('Estoque: itens', () => admin.get('/api/v1/stock-items'));
    await measure('Prontidão de materiais', () => admin.get('/api/v1/material-readiness'));
    await measure('Pedidos: lista', () => admin.get('/api/v1/orders?limit=100'));
    await measure('Financeiro: contas a receber', () => admin.get('/api/v1/finance/receivables'));
    await measure('Financeiro: painel (mês)', () => admin.get('/api/v1/finance/dashboard'), 5, 2);
    await measure('Financeiro: resultado de uma OS', () =>
      admin.get(`/api/v1/finance/service-orders/${so}`),
    );
  }, 900_000);

  it('sincronização com vários clientes conectados', async () => {
    admin = await loginAdmin(app);
    const clients: WsClient[] = [];
    for (let i = 0; i < 40; i++) clients.push(await WsClient.connect(app, admin));
    const lat: number[] = [];
    for (let k = 0; k < 10; k++) {
      const msg = `perf-${k}`;
      const t = performance.now();
      await admin.post('/api/sync/signal', { message: msg }, { 'idempotency-key': idemKey() });
      await Promise.all(
        clients.map((c) => c.waitFor((m) => m.event?.payload?.message === msg, 10_000)),
      );
      lat.push(performance.now() - t);
    }
    await Promise.all(clients.map((c) => c.close()));
    results.tempoReal = {
      clientes: clients.length,
      sinais: lat.length,
      ateTodosReceberem: { p50ms: pct(lat, 50), p95ms: pct(lat, 95), maxms: pct(lat, 100) },
      observacao: 'Inclui o intervalo de leitura do feed de eventos (100 ms nos testes).',
    };
  }, 300_000);

  it('upload de fotografias', async () => {
    admin = await loginAdmin(app);
    const photo = pngPhoto(1000, 750);
    const times: number[] = [];
    const boundary = '----perf';
    for (let i = 0; i < 10; i++) {
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\nSERVICE_ORDER\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${ids.so[i]}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: image/png\r\n\r\n`,
      );
      const t = performance.now();
      const res = await app.app.inject({
        method: 'POST',
        url: '/api/v1/attachments',
        headers: {
          origin: 'http://localhost:3000',
          cookie: admin.cookieHeader,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([head, photo, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      });
      times.push(performance.now() - t);
      expect(res.statusCode).toBe(201);
    }
    results.upload = {
      fotos: times.length,
      tamanhoKB: Math.round(photo.length / 1024),
      p50ms: pct(times, 50),
      maxms: pct(times, 100),
    };
  }, 300_000);

  it('processamento de eventos', async () => {
    await db().domainEvent.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        type: 'sync.signal',
        aggregateType: 'perf',
        aggregateId: String(i),
        payload: { i },
      })),
    });
    const p = new EventProcessor(db(), {
      warn: () => undefined,
      error: () => undefined,
      info: () => undefined,
    } as never);
    let n = 0;
    p.register({ name: 'perf-consumidor', handle: async () => void (n += 1) });
    const t = performance.now();
    for (let i = 0; i < 50 && n < 2000; i++) await p.kick();
    results.eventos = {
      processados: n,
      ms: Math.round(performance.now() - t),
      porSegundo: Math.round((n / (performance.now() - t)) * 1000),
    };
    results.memoriaMB = Math.round(process.memoryUsage().rss / 2 ** 20);
    expect(n).toBeGreaterThanOrEqual(2000);
  }, 300_000);
});
