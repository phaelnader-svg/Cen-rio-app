import { writeFileSync } from 'node:fs';
import { zonedDateTime, type AttentionDto } from '@cenario/shared';
import { PrismaClient } from '@cenario/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { loadEnv } from '../src/config/env';
import { createTestApp, db, loginAdmin, resetDatabase } from './helpers';
import { today } from './production-helpers';
import { qualityKit } from './quality-helpers';

/**
 * Remediação F10-15 — volume e desempenho da Central (roda na regressão, volume moderado).
 *
 * A Central lê as fontes por inteiro (a contagem precisa ser exata e as regras de categoria,
 * deduplicação e filtros são as do código de domínio, sem cópia em SQL). Este teste mede, com um
 * cliente Prisma instrumentado: (1) quantas consultas SQL uma chamada faz — tem de ser CONSTANTE
 * no volume (sem N+1); (2) quantos registros de topo são carregados — cresce com o número de
 * exceções abertas (custo linear documentado); (3) o tempo da chamada.
 * Volumes maiores: CENTRAL_PERF=1 (fora da regressão) mede até 10 000 ocorrências abertas.
 */
let app: App;
let probe: App;
let counting = false;
let sql = 0;
let rows = 0;
const k = qualityKit(() => app);
const SIZES = process.env.CENTRAL_PERF ? [100, 1000, 3000, 10_000] : [100, 1000, 3000];

beforeAll(async () => {
  app = await createTestApp();
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setAttendanceClock(() => zonedDateTime(today(), '09:00', 'America/Sao_Paulo'));
  const base = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ emit: 'event', level: 'query' }],
  });
  base.$on('query', () => {
    if (counting) sql++;
  });
  const instrumented = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const r = await query(args);
          if (counting) rows += Array.isArray(r) ? r.length : r === null || r === undefined ? 0 : 1;
          return r;
        },
      },
    },
  }) as unknown as PrismaClient;
  probe = await buildApp({ env: loadEnv(process.env), prisma: instrumented, logger: false });
}, 120_000);
afterAll(async () => {
  setAttendanceClock();
  await probe?.close();
  await app?.close();
});

describe('F10-15: Central sob volume (contagem exata, consultas constantes)', () => {
  it('cresce o volume: contagem exata, nº de consultas constante, registros ~ lineares; tempo medido', async () => {
    const s = await k.scenario();
    const task = await db().productionTask.findFirstOrThrow({ where: { serviceOrderId: s.so.id } });
    const reporter = (
      await db().user.findFirstOrThrow({ where: { email: { contains: 'gestor' } } })
    ).id;
    const admin = await loginAdmin(probe);
    const results: { open: number; total: number; sql: number; rows: number; ms: number }[] = [];
    let made = 0;
    for (const n of SIZES) {
      for (let from = made; from < n; from += 1000) {
        const len = Math.min(1000, n - from);
        await db().productionIssue.createMany({
          data: Array.from({ length: len }, (_, i) => ({
            kind: 'OUTRO',
            impact: 'DIFICULDADE',
            blocksTask: false,
            description: `Ocorrência de volume ${from + i + 1}`,
            taskId: task.id,
            serviceOrderId: s.so.id,
            reporterUserId: reporter,
          })),
        });
      }
      made = n;
      await admin.get('/api/v1/attention'); // aquece (planos e conexões)
      sql = 0;
      rows = 0;
      counting = true;
      const t0 = performance.now();
      const res = await admin.get('/api/v1/attention');
      const ms = Math.round(performance.now() - t0);
      counting = false;
      expect(res.status).toBe(200);
      const a = res.body as AttentionDto;
      // Contagem exata acima de qualquer antigo `take` (100/300).
      expect(a.counts.ACAO).toBeGreaterThanOrEqual(n);
      expect(a.total).toBe(Object.values(a.counts).reduce((x, y) => x + y, 0));
      expect(a.items.length).toBeLessThanOrEqual(300);
      results.push({ open: n, total: a.total, sql, rows, ms });
    }
    // (1) Sem N+1: o número de consultas não depende do volume.
    expect(new Set(results.map((r) => r.sql)).size).toBe(1);
    // (2) Registros carregados = exceções abertas + uma parcela fixa (cenário e configuração).
    const fixed = results[0]!.rows - results[0]!.open;
    for (const r of results) expect(r.rows - r.open).toBe(fixed);
    // (3) Tempo: registrado no relatório; limite folgado só para pegar regressão grosseira.
    expect(results.at(-1)!.ms).toBeLessThan(15_000);
    const out = process.env.CENTRAL_PERF_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
    console.warn('[central-volume]', JSON.stringify(results));
  }, 300_000);
});
