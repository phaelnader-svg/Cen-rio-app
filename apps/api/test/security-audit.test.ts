import type { Permission } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { loadUserPermissions } from '../src/core/permissions';
import type { AccessRule } from '../src/core/types';
import type { Client } from './helpers';
import {
  Client as HttpClient,
  WsClient,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
  sleep,
} from './helpers';
import { createCustomer, createOrder, createPickup, panelUserWith } from './commercial-helpers';

/**
 * Fase 12 — auditoria de segurança pela API (não pela interface). Percorre TODAS as rotas
 * registradas com sessões de perfis diferentes e confere que o servidor nega o que a regra
 * declarada não permite; depois testa isolamento entre usuários, arquivos, injeção e limites.
 */
let app: App;
const sockets: WsClient[] = [];
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const UUID = '00000000-0000-4000-8000-000000000000';
type Route = { method: string; url: string; access: AccessRule };
const routes = () =>
  (app.app.routeCatalog as Route[]).filter((r) => r.method !== 'HEAD' && r.url.startsWith('/api'));
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, UUID);

/** O que a regra declarada permite para uma sessão (mesma lógica documentada do servidor). */
function allows(
  access: AccessRule,
  kind: 'WEB' | 'DEVICE',
  perms: ReadonlySet<Permission>,
): boolean {
  if ('public' in access || 'device' in access) return true;
  if (access.session !== 'any' && access.session !== kind) return false;
  const surface: Permission = kind === 'WEB' ? 'painel.acessar' : 'producao.acessar';
  const required = [...(access.surfaceExempt ? [] : [surface]), ...(access.permissions ?? [])];
  if (!required.every((p) => perms.has(p))) return false;
  if (access.anyPermissions?.length && !access.anyPermissions.some((p) => perms.has(p)))
    return false;
  return true;
}

async function probeDenied(client: Client, kind: 'WEB' | 'DEVICE', userId: string) {
  const perms = await loadUserPermissions(db(), userId);
  let checked = 0;
  const leaks: string[] = [];
  for (const r of routes()) {
    if (allows(r.access, kind, perms)) continue;
    const res = await client.req(
      r.method as 'GET',
      concrete(r.url),
      r.method === 'GET' ? undefined : {},
      {
        'idempotency-key': idemKey(),
      },
    );
    checked += 1;
    if (res.status !== 403) leaks.push(`${r.method} ${r.url} → ${res.status}`);
  }
  return { checked, leaks };
}

describe('Matriz de acesso: todas as rotas', () => {
  it('o catálogo cobre todas as rotas /api e toda rota tem regra de acesso', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(250);
    for (const r of all) expect(r.access, `${r.method} ${r.url}`).toBeTruthy();
    const open = all.filter((r) => 'public' in r.access).map((r) => `${r.method} ${r.url}`);
    // Só login, saúde, prontidão e o estado de vinculação do tablet são públicos.
    expect(open.sort()).toEqual(
      [
        'GET /api/health',
        'GET /api/ready',
        'GET /api/tablet/status',
        'POST /api/auth/login',
        'POST /api/tablet/pair',
      ].sort(),
    );
  });

  it('sem sessão, toda rota protegida responde 401 (nenhuma executa)', async () => {
    const anon = new HttpClient(app);
    const leaks: string[] = [];
    let checked = 0;
    for (const r of routes()) {
      if ('public' in r.access || 'device' in r.access) continue;
      const res = await anon.req(
        r.method as 'GET',
        concrete(r.url),
        r.method === 'GET' ? undefined : {},
        {
          'idempotency-key': idemKey(),
        },
      );
      checked += 1;
      if (res.status !== 401) leaks.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(checked).toBeGreaterThan(250);
    expect(leaks).toEqual([]);
  });

  it('alteração sem Origin permitido é recusada em todas as rotas que mudam estado (CSRF)', async () => {
    const admin = await loginAdmin(app);
    const foreign = new HttpClient(app, 'https://site-malicioso.exemplo');
    foreign.cookies = new Map(admin.cookies);
    const leaks: string[] = [];
    for (const r of routes()) {
      if (r.method === 'GET') continue;
      const res = await foreign.req(
        r.method as 'POST',
        concrete(r.url),
        {},
        { 'idempotency-key': idemKey() },
      );
      if (res.status !== 403) leaks.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('tablet de produção (Ricardo): todo o painel, financeiro e gestão negados', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '482915',
    });
    const { checked, leaks } = await probeDenied(tablet, 'DEVICE', employee.userId!);
    expect(checked).toBeGreaterThan(200);
    expect(leaks).toEqual([]);
  });

  it('logística terceirizada (André): só as próprias retiradas e entregas', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Celular André',
      employee: 'André',
      pin: '640218',
    });
    const { checked, leaks } = await probeDenied(tablet, 'DEVICE', employee.userId!);
    expect(checked).toBeGreaterThan(250);
    expect(leaks).toEqual([]);
  });

  it('usuário do painel com acesso restrito (só pedidos): nada além do concedido', async () => {
    const admin = await loginAdmin(app);
    const office = await panelUserWith(app, admin, 'escritorio-auditoria', ['pedidos.ver']);
    const me = (await office.get('/api/auth/me')).body.user.id as string;
    const { checked, leaks } = await probeDenied(office, 'WEB', me);
    expect(checked).toBeGreaterThan(250);
    expect(leaks).toEqual([]);
  });
});

describe('Isolamento entre usuários', () => {
  it('André não vê nem executa a retirada atribuída ao Izaías', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin, { name: 'Cliente Auditoria' });
    const order = await createOrder(admin, customer);
    const pickup = await createPickup(admin, order);
    const izaias = (await db().user.findFirstOrThrow({ where: { displayName: 'Izaías' } })).id;
    const assigned = await admin.put(`/api/v1/pickups/${pickup.id}/logistics`, {
      logisticsUserId: izaias,
      version: pickup.version,
    });
    expect(assigned.status).toBe(200);
    const { tablet: andre } = await setupTablet(app, admin, {
      name: 'Celular André',
      employee: 'André',
      pin: '640218',
    });
    const jobs = (await andre.get('/api/v1/logistics/jobs')).body as { id: string }[];
    expect(jobs.map((j) => j.id)).not.toContain(pickup.id);
    const step = await andre.post(
      `/api/v1/logistics/pickups/${pickup.id}/step`,
      {
        step: 'SAIDA',
        version: (await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } })).version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(step.status, JSON.stringify(step.body)).toBe(403);
    // Sem dados comerciais: o pedido e o cliente não são acessíveis.
    expect((await andre.get(`/api/v1/orders/${order.id}`)).status).toBe(403);
    expect((await andre.get(`/api/v1/customers/${customer.id}`)).status).toBe(403);
  });

  it('arquivos privados: tablet não abre comprovante financeiro; caminho malicioso é recusado', async () => {
    const admin = await loginAdmin(app);
    const payable = await admin.post(
      '/api/v1/finance/payables',
      {
        beneficiary: 'Fornecedor Exemplo',
        category: 'SERVICOS',
        description: 'Conserto',
        amountCents: 1000,
        dueDate: '2030-01-10',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(payable.status).toBe(201);
    const { uploadPhoto } = await import('./production-helpers');
    const up = await uploadPhoto(app, admin, 'FINANCE_PAYABLE', payable.body.id);
    expect(up.status).toBe(201);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect((await tablet.get(up.body.url)).status).toBe(403);
    expect(
      (
        await tablet.get(
          `/api/v1/attachments?entityType=FINANCE_PAYABLE&entityId=${payable.body.id}`,
        )
      ).status,
    ).toBe(403);
    expect((await admin.get(up.body.url)).status).toBe(200);
    for (const bad of [
      '/api/files/..%2F..%2Fetc%2Fpasswd',
      '/api/files/%2e%2e',
      '/api/files/not-a-uuid',
    ])
      expect([400, 404]).toContain((await admin.get(bad)).status);
  });

  it('entradas maliciosas não quebram consultas nem vazam dados (injeção)', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Cliente Seguro' });
    for (const q of [
      "'; DROP TABLE customers; --",
      '%',
      '_',
      "' OR '1'='1",
      '\\',
      '<script>alert(1)</script>',
    ]) {
      const r = await admin.get(`/api/v1/customers?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      const f = await admin.get(`/api/v1/finance/orders?search=${encodeURIComponent(q)}`);
      expect(f.status, q).toBe(200);
    }
    expect(await db().customer.count()).toBe(1);
    // Texto com HTML é guardado como texto (a interface escapa); nada é interpretado no servidor.
    const c = await createCustomer(admin, {
      name: '<img src=x onerror=alert(1)>',
      allowSimilar: true,
    });
    expect(c.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('corpo acima do limite é recusado (413) e cabeçalhos de segurança estão presentes', async () => {
    const admin = await loginAdmin(app);
    const big = await admin.post(
      '/api/v1/finance/payables',
      { beneficiary: 'x'.repeat(400_000) },
      { 'idempotency-key': idemKey() },
    );
    expect(big.status).toBe(413);
    const h = (await admin.get('/api/health')).headers;
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options'] ?? h['content-security-policy']).toBeTruthy();
    expect(h['x-powered-by']).toBeUndefined();
  });

  it('sessão revogada perde o tempo real na hora; permissão retirada vale na próxima ação', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet Ricardo',
      employee: 'Ricardo',
      pin: '482915',
    });
    const ws = await WsClient.connect(app, tablet);
    sockets.push(ws);
    const sessions = (await admin.get('/api/sessions')).body as {
      id: string;
      userId?: string;
      user?: { id: string };
    }[];
    const target = sessions.find((s) => (s.userId ?? s.user?.id) === employee.userId);
    expect(target).toBeTruthy();
    const rev = await admin.post(
      `/api/sessions/${target!.id}/revoke`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect([200, 204]).toContain(rev.status);
    for (let i = 0; i < 100 && !ws.closed; i++) await sleep(50);
    expect(ws.closed).not.toBeNull();
    expect((await tablet.get('/api/v1/production-tasks/mine')).status).toBe(401);
  });
});
