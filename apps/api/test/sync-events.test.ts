import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { SYNC_MAX_SCANNED, SYNC_SCAN_BATCH } from '../src/modules/sync/routes';
import {
  ADMIN,
  type Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';

/**
 * Auditoria P4 — `/api/sync/events` com leitura limitada por chamada e cursor `nextSince`.
 * Garantias verificadas: ordem por `seq`, continuidade entre páginas (sem duplicar nem pular
 * eventos visíveis), visibilidade por audiência e avanço do cursor sobre eventos invisíveis.
 */
let app: App;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(() => resetDatabase());

type Page = {
  events: { seq: string; payload: { message?: string } }[];
  hasMore: boolean;
  nextSince: string;
};

async function page(c: Client, since: string, limit?: number): Promise<Page> {
  const r = await c.get(`/api/sync/events?since=${since}${limit ? `&limit=${limit}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** Percorre o cursor até `hasMore=false`; devolve as páginas. */
async function drain(c: Client, since: string, limit?: number) {
  const pages: Page[] = [];
  for (let cursor = since, i = 0; i < 100; i++) {
    const p = await page(c, cursor, limit);
    pages.push(p);
    expect(BigInt(p.nextSince) >= BigInt(cursor), 'cursor nunca recua').toBe(true);
    cursor = p.nextSince;
    if (!p.hasMore) return pages;
  }
  throw new Error('paginação não terminou');
}

const messages = (pages: Page[]) => pages.flatMap((p) => p.events.map((e) => e.payload.message));
const seqs = (pages: Page[]) => pages.flatMap((p) => p.events.map((e) => BigInt(e.seq)));

/** Insere `n` eventos de uma vez, na ordem de `prefix0..prefix{n-1}`. */
async function insert(n: number, prefix: string, audience: string) {
  await db().$executeRawUnsafe(
    `INSERT INTO domain_events (id, type, aggregate_type, aggregate_id, payload, audience)
     SELECT gen_random_uuid(), 'sync.signal', 'sync', 'x',
            jsonb_build_object('message', $1 || g), $2
     FROM generate_series(0, $3 - 1) g ORDER BY g`,
    prefix,
    audience,
    n,
  );
}

async function head() {
  const r = await db().domainEvent.aggregate({ _max: { seq: true } });
  return (r._max.seq ?? 0n).toString();
}

const INVISIBLE = 'permission:permissao.inexistente';

describe('/api/sync/events — leitura limitada e cursor', () => {
  it('pagina eventos visíveis em ordem, sem duplicar nem pular (páginas cheias e última parcial)', async () => {
    const admin = await loginAdmin(app);
    const since = await head();
    await insert(450, 'v', 'all');
    const pages = await drain(admin, since, 200);
    expect(pages.map((p) => p.events.length)).toEqual([200, 200, 50]);
    expect(messages(pages)).toEqual(Array.from({ length: 450 }, (_, i) => `v${i}`));
    const s = seqs(pages);
    for (let i = 1; i < s.length; i++) expect(s[i]! > s[i - 1]!).toBe(true);
    // Página cheia: o cursor é o seq do último evento DEVOLVIDO.
    expect(pages[0]!.nextSince).toBe(pages[0]!.events.at(-1)!.seq);
    expect(pages.at(-1)!.hasMore).toBe(false);
  });

  it('página com exatamente `limit` eventos e nada depois informa hasMore=false', async () => {
    const admin = await loginAdmin(app);
    const since = await head();
    await insert(20, 'e', 'all');
    const p = await page(admin, since, 20);
    expect(p.events).toHaveLength(20);
    expect(p.hasMore).toBe(false);
    expect(p.nextSince).toBe(p.events.at(-1)!.seq);
    // E um evento a mais depois: aparece na continuação.
    await insert(1, 'depois', 'all');
    const q = await page(admin, p.nextSince, 20);
    expect(messages([q])).toEqual(['depois0']);
  });

  it('eventos invisíveis consomem o limite de leitura sem perda dos visíveis nem salto indevido', async () => {
    const { tablet } = await setupTablet(app, await loginAdmin(app), {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    const since = await head();
    // Visíveis espalhados entre invisíveis, inclusive nas fronteiras de lote e do limite de leitura.
    await insert(1, 'a', 'all');
    await insert(SYNC_SCAN_BATCH - 2, 'x', INVISIBLE);
    await insert(1, 'b', 'all'); // último do 1º lote
    await insert(SYNC_MAX_SCANNED - SYNC_SCAN_BATCH - 1, 'y', INVISIBLE);
    await insert(1, 'c', 'all'); // exatamente o último examinável na 1ª chamada
    await insert(1, 'd', 'all'); // primeiro além do limite de leitura
    await insert(SYNC_MAX_SCANNED + 10, 'z', INVISIBLE);
    await insert(1, 'e', 'all');

    const first = await page(tablet, since, 200);
    expect(messages([first])).toEqual(['a0', 'b0', 'c0']);
    expect(first.hasMore).toBe(true);
    // Leitura limitada: examinou exatamente SYNC_MAX_SCANNED e o cursor parou no último examinado.
    expect(BigInt(first.nextSince) - BigInt(since)).toBe(BigInt(SYNC_MAX_SCANNED));

    const second = await page(tablet, first.nextSince, 200);
    expect(messages([second])).toEqual(['d0']);
    expect(second.hasMore).toBe(true); // só invisíveis restantes no limite, mas ainda há a ler

    const rest = await drain(tablet, second.nextSince, 200);
    expect(messages(rest)).toEqual(['e0']);
    expect(rest.at(-1)!.nextSince).toBe(await head());
  });

  it('respeita a visibilidade por permissão e por usuário entre sessões diferentes', async () => {
    const admin = await loginAdmin(app);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    const adminUser = await db().user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    const since = await head();
    await insert(3, 'todos', 'all');
    await insert(3, 'gestor', `user:${adminUser.id}`);
    await insert(3, 'diag', 'permission:sincronizacao.diagnosticar');
    await insert(3, 'ninguem', INVISIBLE);

    const all = (m: (string | undefined)[], p: string) => m.filter((x) => x?.startsWith(p));
    const tab = messages(await drain(tablet, since, 2));
    expect(all(tab, 'gestor')).toHaveLength(0);
    expect(all(tab, 'ninguem')).toHaveLength(0);
    expect(all(tab, 'todos')).toEqual(['todos0', 'todos1', 'todos2']);

    const adm = messages(await drain(admin, since, 2));
    expect(all(adm, 'gestor')).toEqual(['gestor0', 'gestor1', 'gestor2']);
    expect(all(adm, 'diag')).toEqual(['diag0', 'diag1', 'diag2']);
    expect(all(adm, 'ninguem')).toHaveLength(0);
  });

  it('eventos gravados simultaneamente durante a paginação chegam todos, em ordem, uma vez', async () => {
    const admin = await loginAdmin(app);
    const since = await head();
    const sent = Array.from({ length: 30 }, (_, i) => `sim${i}`);
    const collected: Page[] = [];
    let cursor = since;
    const writers = Promise.all(
      sent.map((message) =>
        admin.post('/api/sync/signal', { message }, { 'idempotency-key': idemKey() }),
      ),
    );
    // Lê enquanto as gravações concorrentes acontecem.
    for (let i = 0; i < 20; i++) {
      const p = await page(admin, cursor, 4);
      collected.push(p);
      cursor = p.nextSince;
    }
    for (const r of await writers) expect(r.status).toBe(201);
    collected.push(...(await drain(admin, cursor, 4)));

    const got = messages(collected).filter((m): m is string => !!m?.startsWith('sim'));
    expect(new Set(got).size).toBe(got.length); // sem duplicação
    expect([...got].sort()).toEqual([...sent].sort()); // sem perda
    const s = seqs(collected);
    for (let i = 1; i < s.length; i++) expect(s[i]! > s[i - 1]!).toBe(true);
  });

  it('mantém o contrato anterior (events + hasMore) com os valores padrão', async () => {
    const admin = await loginAdmin(app);
    await insert(2, 'p', 'all');
    const p = await page(admin, '0');
    expect(Array.isArray(p.events)).toBe(true);
    expect(typeof p.hasMore).toBe('boolean');
    expect(messages([p])).toEqual(expect.arrayContaining(['p0', 'p1']));
    expect(p.nextSince).toBe(await head());
    // Cursor no fim: página vazia, sem mais nada, cursor parado.
    const end = await page(admin, p.nextSince);
    expect(end).toEqual({ events: [], hasMore: false, nextSince: p.nextSince });
  });
});
