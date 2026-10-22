import {
  ALL_PERMISSIONS,
  type AttentionDto,
  type OverviewDto,
  closingWeekStart,
} from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { AccessRule } from '../src/core/types';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { createCustomer, createOrder, panelUserWith } from './commercial-helpers';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';
import {
  F,
  PINS,
  finish,
  labor,
  moneyKeys,
  post,
  prepareCompany,
  scenario,
  setOwner,
} from './labor-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
} from './purchasing-helpers';
import { day, today } from './production-helpers';
import {
  ask,
  prepareCompany as preparePresence,
  scenario as presenceScenario,
  setClock as setPresenceClock,
} from './presence-helpers';

/**
 * O valor como número isolado — nunca como pedaço de um id (UUID ou código), que pode conter os
 * mesmos dígitos por acaso (ex.: "…768852164321").
 */
const valueOf = (...values: number[]) => new RegExp(`(?<![\\w-])(?:${values.join('|')})(?![\\w-])`);

/**
 * Remediação pós-auditoria, Rodada 4 — MATRIZ DE PERMISSÕES e TEMPO REAL (transversal).
 *
 * Já provado em outros arquivos (não repetido aqui):
 * - F1-07b (rodada4-travas-estruturais): regra de acesso das 379 rotas igual a 9fb1786 e amostra
 *   de finanças/compras/presença recusada para painel sem a permissão (IDs fictícios).
 * - Central/Início por domínio (rodada3-central F10-18; rodada4-central-indicadores F10-21j/t):
 *   "só ocorrencias.ver" sem cartões de outros domínios; finance null sem financeiro.ver.
 * - Meus Ganhos (meus-ganhos 25–28/33): tablet só vê o próprio; ajudante sem acesso; GET pelo
 *   painel do gestor recusado; confirmação pelo painel recusada (rodada3-financeiro F9-02).
 * - Tempo real (realtime, sync-events, rodada2-eventos F8-15b, rodada3-financeiro F1-09,
 *   purchasing-realtime): tablet sem eventos administrativos; reenvio após queda; own_changed só
 *   ao dono e sem números; tablet com financeiro.ver sem finance.* de terceiros.
 *
 * O que este arquivo acrescenta (lacunas):
 * A) Central e Início com dados REAIS de todos os domínios ao mesmo tempo, por perfil (gestor,
 *    operacional, financeiro sem compras, compras sem financeiro, tablet): conteúdo sem itens de
 *    domínio alheio, sem chaves/valores monetários, e filtro `?type=` não fura o corte; Meus Ganhos
 *    nas 4 rotas para painel (inclusive quem TEM financeiro.producao_propria) e tablet sem a
 *    permissão; deep links da Central com IDs reais → 403; TODAS as rotas WEB do catálogo
 *    recusadas para tablet com todas as permissões; rotas exclusivas do tablet recusadas no painel.
 * B) A mesma pessoa em sessão WEB e DEVICE (corte por tipo de sessão), compras só para quem tem
 *    compras, diagnóstico preservado no tablet, own_changed com payload exatamente {reason}, e o
 *    reenvio pós-reconexão (WS e HTTP) com o mesmo recorte de audiência — sem vazar no replay.
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);

beforeAll(async () => {
  // Limites altos só para o varrimento do catálogo (centenas de requisições da mesma sessão).
  app = await createTestApp({
    RATE_LIMIT_SESSION_PER_MIN: '100000',
    RATE_LIMIT_IP_PER_MIN: '100000',
  });
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await prepareCompany();
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const WEEK = closingWeekStart(today());
const MONEY = /Cents|R\$/;
const attention = async (c: Client, q = '') => {
  const r = await c.get(`/api/v1/attention${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AttentionDto;
};
const overview = async (c: Client) => {
  const r = await c.get('/api/v1/management/overview');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as OverviewDto;
};
const COMPRAS_KEY = /^MATERIAL:(comprar|aguardando-entrega|rascunho)/;
const isFin = (t: string) => t === 'FINANCEIRO' || t === 'COBRANCA';

/** Dados reais de todos os domínios: mão de obra devida, revisão, cobranças vencidas e compras. */
async function world() {
  const s = await scenario(app);
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 123457,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id); // devida → "aguardando confirmação"
  // Revisão financeira real: troca do titular das poltronas com mão de obra lançada.
  await labor(s.admin, {
    professionalUserId: s.ids.marcio,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.poltronas.id,
    agreedCents: 45678,
  });
  const swap = await setOwner(s.admin, s.poltronas.id, s.ids.ricardo, s.ids.marcio, 'Troca');
  expect(swap.financialReviewRequired).toBe(true);
  const review = (
    (await s.admin.get(F('/labor-reviews?status=ABERTA'))).body as { id: string }[]
  )[0]!;
  // Cobrança vencida.
  const cust = await createCustomer(s.admin, { name: 'Cliente Matriz', allowSimilar: true });
  const order = await createOrder(s.admin, cust);
  const rec = await post(s.admin, F('/receivables'), {
    orderId: order.id,
    description: 'Entrada',
    amountCents: 77777,
    dueDate: day(-3),
    expectedMethod: 'PIX',
  });
  expect(rec.status, JSON.stringify(rec.body)).toBe(201);
  // Compras: uma necessidade comprada (aguardando entrega) e outra ainda a comprar.
  const bought = await approvedNeeds(s.admin, 'Cliente Compra Feita', (so) => [
    linen(so.items[0].id),
  ]);
  await approvedNeeds(s.admin, 'Cliente A Comprar', (so) => [linen(so.items[0].id)]);
  const supplier = await createSupplier(s.admin);
  const po = await confirmedFabricPurchase(s.admin, supplier.id, bought.reqs[0]!, 4567);
  return { s, ric, review, receivable: rec.body as { id: string }, po: po as { id: string } };
}

// ═══════════════════════════════ A) MATRIZ DE PERMISSÕES ═══════════════════════════════

describe('Matriz — Central e Início por perfil, com dados reais de todos os domínios', () => {
  it('cada perfil vê só o próprio domínio; sem financeiro nada monetário; sem compras nada de compras', async () => {
    const w = await world();
    const { admin } = w.s;
    const profiles = {
      operacional: await panelUserWith(app, admin, 'mx-op', [
        'os.ver',
        'producao.ver',
        'ocorrencias.ver',
      ]),
      financeiro: await panelUserWith(app, admin, 'mx-fin', [
        'ocorrencias.ver',
        'financeiro.ver',
        'financeiro.gerenciar',
        'os.ver',
      ]),
      compras: await panelUserWith(app, admin, 'mx-comp', [
        'ocorrencias.ver',
        'compras.ver',
        'compras.gerenciar',
        'os.ver',
      ]),
    };

    // Gestor: todos os cartões existem (o corte abaixo é de permissão, não falta de dado).
    const g = await attention(admin);
    const gKeys = g.items.map((i) => i.key);
    expect(gKeys).toContain(`FINANCEIRO:revisao:${w.review.id}`);
    expect(gKeys).toContain(`FINANCEIRO:confirmacao:${w.s.ids.ricardo}`);
    expect(gKeys).toContain(`COBRANCA:VENCIDA:${w.receivable.id}`);
    expect(gKeys).toContain(`MATERIAL:aguardando-entrega:${w.po.id}`);
    expect(gKeys).toContain('MATERIAL:comprar');
    expect(JSON.stringify(g)).toMatch(/R\$/); // a cobrança traz o saldo: o teste de vazamento discrimina

    // Operacional: nada de financeiro nem de compras; nenhum valor monetário.
    const op = await attention(profiles.operacional);
    expect(op.items.filter((i) => isFin(i.type) || COMPRAS_KEY.test(i.key))).toEqual([]);
    expect(JSON.stringify(op)).not.toMatch(MONEY);
    expect(moneyKeys(op)).toEqual([]);
    expect(JSON.stringify(op)).not.toContain(w.po.id);
    // O filtro por tipo não fura o corte (nem contagem).
    for (const t of ['FINANCEIRO', 'COBRANCA', 'MATERIAL']) {
      const f = await attention(profiles.operacional, `?type=${t}`);
      expect(f.items, t).toEqual([]);
      expect(f.total, t).toBe(0);
    }

    // Financeiro sem compras: vê as decisões e cobranças, nenhum cartão/ID de compras.
    const fin = await attention(profiles.financeiro);
    const finKeys = fin.items.map((i) => i.key);
    expect(finKeys).toContain(`FINANCEIRO:revisao:${w.review.id}`);
    expect(finKeys).toContain(`COBRANCA:VENCIDA:${w.receivable.id}`);
    expect(finKeys.filter((k) => COMPRAS_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(fin)).not.toContain(w.po.id);
    expect(
      (await attention(profiles.financeiro, '?type=MATERIAL')).items.filter((i) =>
        COMPRAS_KEY.test(i.key),
      ),
    ).toEqual([]);

    // Compras sem financeiro: vê os cartões de compras, nada financeiro, nenhum valor.
    const comp = await attention(profiles.compras);
    const compKeys = comp.items.map((i) => i.key);
    expect(compKeys).toContain(`MATERIAL:aguardando-entrega:${w.po.id}`);
    expect(compKeys).toContain('MATERIAL:comprar');
    expect(comp.items.filter((i) => isFin(i.type))).toEqual([]);
    expect(JSON.stringify(comp)).not.toMatch(MONEY);
    expect(JSON.stringify(comp)).not.toMatch(valueOf(123457, 45678, 77777, 4567));
    expect(moneyKeys(comp)).toEqual([]);

    // Início: finance null sem financeiro.ver (com cobranças e mão de obra reais existentes).
    const OVERVIEW_KEYS = [
      'attention',
      'deliveries',
      'finance',
      'generatedAt',
      'operations',
      'today',
    ];
    for (const [tag, c] of [
      ['operacional', profiles.operacional],
      ['compras', profiles.compras],
    ] as const) {
      const o = await overview(c);
      expect(o.finance, tag).toBeNull();
      expect(JSON.stringify(o), tag).not.toMatch(/Cents|overdueCount|laborReviews|valueRequests/);
      expect(Object.keys(o).sort(), tag).toEqual(OVERVIEW_KEYS);
    }
    const oFin = await overview(profiles.financeiro);
    expect(oFin.finance!.receivables.overdueCount).toBe(1);
    expect(oFin.finance!.decisions.laborReviews).toBe(1);
    // O Início NÃO tem bloco de compras para ninguém (nem para o gestor): nada a esconder.
    for (const c of [admin, profiles.financeiro, profiles.operacional]) {
      const keys: string[] = [];
      const walk = (x: unknown) => {
        if (x && typeof x === 'object')
          for (const [k, v] of Object.entries(x)) {
            keys.push(k);
            walk(v);
          }
      };
      walk(await overview(c));
      expect(keys.filter((k) => /purchas|compra|supplier|fornecedor/i.test(k))).toEqual([]);
    }

    // Tablets (tapeceiro e ajudante): Central e Início recusados.
    for (const t of [w.s.tablets.Ricardo!, w.s.tablets['João']!]) {
      expect((await t.get('/api/v1/attention')).status).toBe(403);
      expect((await t.get('/api/v1/management/overview')).status).toBe(403);
    }
    // Operacional sem ocorrencias.ver nem abre a Central.
    const semCentral = await panelUserWith(app, admin, 'mx-op2', ['os.ver', 'producao.ver']);
    expect((await semCentral.get('/api/v1/attention')).status).toBe(403);
    expect((await overview(semCentral)).finance).toBeNull();
  });

  it('deep links da Central (IDs reais) não são atalho: 403 para quem não tem a permissão do destino', async () => {
    const w = await world();
    const { admin } = w.s;
    const op = await panelUserWith(app, admin, 'mx-dl-op', [
      'os.ver',
      'producao.ver',
      'ocorrencias.ver',
    ]);
    const fin = await panelUserWith(app, admin, 'mx-dl-fin', ['ocorrencias.ver', 'financeiro.ver']);
    const comp = await panelUserWith(app, admin, 'mx-dl-comp', ['ocorrencias.ver', 'compras.ver']);
    const finance = [
      F(`/weekly-closings/${WEEK}`),
      F('/labor-reviews'),
      F(`/labor-reviews/${w.review.id}`),
      F(`/receivables/${w.receivable.id}`),
      F(`/labor/${w.ric.id}`),
    ];
    const purchasing = [`/api/v1/purchase-orders/${w.po.id}`, '/api/v1/purchase-orders'];
    const status = async (c: Client, urls: string[]) =>
      Object.fromEntries(await Promise.all(urls.map(async (u) => [u, (await c.get(u)).status])));
    const all = (urls: string[], s: number) => Object.fromEntries(urls.map((u) => [u, s]));
    // Quem tem a permissão abre (o link existe e funciona).
    expect(await status(admin, [...finance, ...purchasing])).toEqual(
      all([...finance, ...purchasing], 200),
    );
    expect(await status(fin, finance)).toEqual(all(finance, 200));
    expect(await status(comp, purchasing)).toEqual(all(purchasing, 200));
    // Sem a permissão: recusado, com IDs reais.
    expect(await status(op, [...finance, ...purchasing])).toEqual(
      all([...finance, ...purchasing], 403),
    );
    expect(await status(fin, purchasing)).toEqual(all(purchasing, 403));
    expect(await status(comp, finance)).toEqual(all(finance, 403));
    for (const t of [w.s.tablets.Ricardo!, w.s.tablets['João']!])
      expect(await status(t, [...finance, ...purchasing])).toEqual(
        all([...finance, ...purchasing], 403),
      );
    // Os 403 não carregam dado do registro.
    const denied = await op.get(F(`/labor-reviews/${w.review.id}`));
    expect(JSON.stringify(denied.body)).not.toMatch(valueOf(45678));
    expect(JSON.stringify(denied.body)).not.toMatch(/Márcio/);
  });

  it('deep link do pedido de ajuda: painel sem produção e tablet de outra pessoa → 403; o próprio e o gestor abrem', async () => {
    setAttendanceClock();
    await preparePresence();
    // Só o Ricardo chegou: o pedido fica PENDENTE (ninguém mais é parte dele).
    const s = await presenceScenario(app, { arrive: ['Ricardo'] });
    const h = await ask(s.tablets.Ricardo!, { taskId: s.main.id, kind: 'PARAFUSAR' });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    setPresenceClock('09:30');
    // O link da Central aponta para este pedido exato.
    const a = await attention(s.admin, '?type=AJUDA');
    const link = a.items.find((i) => i.key === `AJUDA:${h.body.id}`)?.link;
    expect(link).toBe(`/painel/ajuda?foco=${h.body.id}`);
    const url = `/api/v1/help-requests/${h.body.id}`;
    const fin = await panelUserWith(app, s.admin, 'mx-help-fin', [
      'ocorrencias.ver',
      'financeiro.ver',
    ]);
    expect((await fin.get(url)).status).toBe(403);
    expect((await fin.get('/api/v1/help-requests')).status).toBe(403);
    // Tablet de um colega que não é parte do pedido.
    expect(h.body.status).toBe('PENDENTE');
    const res = await s.tablets['Márcio']!.get(url);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(s.main.id);
    expect((await s.tablets.Ricardo!.get(url)).status).toBe(200);
    expect((await s.admin.get(url)).status).toBe(200);
  });

  it('Meus Ganhos: as 4 rotas só no tablet com financeiro.producao_propria', async () => {
    const s = await scenario(app);
    await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    const R = s.tablets.Ricardo!;
    const u = await post(R, F('/my-earnings/unlock'), { pin: PINS.Ricardo });
    expect(u.status).toBe(200);
    const token = u.body.unlockToken as string;
    const H = { 'x-earnings-unlock': token, 'idempotency-key': idemKey() };
    const mine = await R.req('GET', F('/my-earnings'), undefined, H);
    expect(mine.status).toBe(200);
    const routes = [
      ['GET', F('/my-earnings'), undefined],
      ['POST', F('/my-earnings/unlock'), { pin: PINS.Ricardo }],
      [
        'POST',
        F('/my-earnings/requests'),
        { targetKind: 'PRODUCAO', targetId: s.so.id, requestedCents: 1, reason: 'x' },
      ],
      ['POST', F('/my-earnings/confirm'), { weekStart: WEEK }],
    ] as const;
    // Painel: gestor, financeiro e até quem TEM financeiro.producao_propria no painel.
    const webOwn = await panelUserWith(app, s.admin, 'mx-mg-own', ['financeiro.producao_propria']);
    const webFin = await panelUserWith(app, s.admin, 'mx-mg-fin', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const refused: string[] = [];
    for (const [tag, c] of [
      ['gestor', s.admin],
      ['webFin', webFin],
      ['webOwn', webOwn],
      ['tablet ajudante', s.tablets['João']!],
    ] as const)
      for (const [m, url, body] of routes) {
        const r = await c.req(m, url, body, { ...H, 'idempotency-key': idemKey() });
        if (r.status !== 403) refused.push(`${tag} ${m} ${url} → ${r.status}`);
        expect(JSON.stringify(r.body)).not.toMatch(/100000|agreedCents/);
      }
    expect(refused).toEqual([]);
  });
});

describe('Matriz — tipo de sessão: tablet não usa rota do painel e painel não usa rota do tablet', () => {
  type Route = { method: string; url: string; access: AccessRule };
  const UUID = '00000000-0000-4000-8000-000000000000';
  const concrete = (u: string) => u.replace(/:[A-Za-z]+/g, UUID);
  const routes = () =>
    (app.app.routeCatalog as Route[]).filter(
      (r) => r.method !== 'HEAD' && r.url !== '/api/realtime',
    );

  it('tablet com TODAS as permissões: toda rota WEB do catálogo responde 403', async () => {
    const admin = await loginAdmin(app);
    const t = await setupTablet(app, admin, {
      name: 'Tablet Matriz',
      employee: 'Ricardo',
      pin: '482915',
    });
    // Concessões individuais (mesmo recurso do teste F1-09): tudo que o gestor tem.
    await db().userPermission.createMany({
      data: ALL_PERMISSIONS.map((permission) => ({ userId: t.employee.userId!, permission })),
      skipDuplicates: true,
    });
    const web = routes().filter((r) => 'session' in r.access && r.access.session === 'WEB');
    expect(web.length).toBeGreaterThan(250);
    const leaks: string[] = [];
    for (const r of web) {
      const res = await t.tablet.req(
        r.method as 'GET',
        concrete(r.url),
        r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
        { 'idempotency-key': idemKey() },
      );
      if (res.status !== 403) leaks.push(`${r.method} ${r.url} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    // Controle: a mesma sessão continua válida nas rotas do tablet/“any”.
    expect((await t.tablet.get('/api/auth/me')).status).toBe(200);
  });

  it('painel do gestor (todas as permissões): toda rota exclusiva de DEVICE responde 403; login de tablet exige o tablet vinculado', async () => {
    const admin = await loginAdmin(app);
    const deviceOnly = routes().filter(
      (r) => 'session' in r.access && r.access.session === 'DEVICE',
    );
    expect(deviceOnly.map((r) => r.url).sort()).toEqual(
      [
        '/api/v1/finance/my-earnings',
        '/api/v1/finance/my-earnings/confirm',
        '/api/v1/finance/my-earnings/requests',
        '/api/v1/finance/my-earnings/unlock',
      ].sort(),
    );
    for (const r of deviceOnly) {
      const res = await admin.req(r.method as 'GET', r.url, r.method === 'GET' ? undefined : {}, {
        'idempotency-key': idemKey(),
      });
      expect(res.status, `${r.method} ${r.url}`).toBe(403);
    }
    const ric = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const login = await admin.post('/api/tablet/login', { employeeId: ric.id, pin: '482915' });
    expect([401, 403]).toContain(login.status);
    expect(login.cookies.filter((c) => c.value)).toEqual([]);
  });
});

// ═══════════════════════════════════ B) TEMPO REAL ═══════════════════════════════════

type Ev = { type: string; aggregateId: string; payload: Record<string, unknown>; seq: string };

/** Pessoas do teste: a mesma "Paula" no painel (WEB) e no tablet (DEVICE). */
async function people() {
  const s = await scenario(app);
  const paulaWeb = await panelUserWith(app, s.admin, 'paula', [
    'producao.acessar',
    'producao.executar',
    'financeiro.ver',
    'compras.ver',
    'sincronizacao.diagnosticar',
    'financeiro.producao_propria',
  ]);
  const pt = await setupTablet(app, s.admin, {
    name: 'Tablet Paula',
    employee: 'paula',
    pin: '914273',
  });
  const ops = await panelUserWith(app, s.admin, 'mx-rt-op', ['os.ver', 'producao.ver']);
  const clients = {
    gestor: s.admin,
    paulaWeb,
    paulaDevice: pt.tablet,
    ricardo: s.tablets.Ricardo!,
    marcio: s.tablets['Márcio']!,
    ops,
  };
  return { s, clients, paulaId: pt.employee.userId! };
}
type Who = keyof Awaited<ReturnType<typeof people>>['clients'];

/** Gera, pelas rotas reais: financeiro (mão de obra), compras (rascunho), diagnóstico e um marcador "all". */
async function fire(s: Awaited<ReturnType<typeof scenario>>, paulaDevice: Client) {
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 98765,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  const { reqs } = await approvedNeeds(s.admin, 'Cliente Tempo Real', (so) => [
    linen(so.items[0].id),
  ]);
  const supplier = await createSupplier(s.admin);
  const po = await createPurchase(s.admin, {
    supplierId: supplier.id,
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
        quantity: 12,
        unitPriceCents: 4321,
      },
    ],
  });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  const sig = await paulaDevice.post(
    '/api/sync/signal',
    { message: 'diag-tablet' },
    { 'idempotency-key': idemKey() },
  );
  expect(sig.status).toBe(201);
  const c = await confirmPurchase(s.admin, po.body); // purchase_order.confirmed: audiência "all" (marcador final)
  expect(c.status).toBe(200);
  return { laborId: ric.id, poId: po.body.id as string };
}

/** O que cada sessão pode e não pode receber dos eventos de `fire`. */
function checkAudience(got: Record<Who, Ev[]>, ids: { ricardo: string; paula: string }) {
  const types = (w: Who) => new Set(got[w].map((e) => e.type));
  const finMgmt = (w: Who) =>
    got[w].filter((e) => e.type.startsWith('finance.') && e.type !== 'finance.own_changed');
  const own = (w: Who) => got[w].filter((e) => e.type === 'finance.own_changed');
  const diag = (w: Who) => got[w].filter((e) => e.type === 'sync.signal');
  // Marcador "all": todos receberam o fim da sequência (as ausências abaixo são reais).
  for (const w of Object.keys(got) as Who[])
    expect(types(w).has('purchase_order.confirmed'), w).toBe(true);
  // Financeiro gerencial: só sessões WEB com financeiro.ver.
  expect(finMgmt('gestor').length).toBeGreaterThan(0);
  expect(finMgmt('paulaWeb').length).toBeGreaterThan(0);
  for (const w of ['paulaDevice', 'ricardo', 'marcio', 'ops'] as const)
    expect(finMgmt(w), w).toEqual([]);
  // own_changed do Ricardo: só ele; payload exatamente { reason } sem números.
  expect(own('ricardo').map((e) => e.aggregateId)).toEqual(expect.arrayContaining([ids.ricardo]));
  for (const e of own('ricardo')) {
    expect(Object.keys(e.payload)).toEqual(['reason']);
    expect(typeof e.payload.reason).toBe('string');
    expect(String(e.payload.reason)).not.toMatch(/\d/);
  }
  for (const w of ['gestor', 'paulaWeb', 'paulaDevice', 'marcio', 'ops'] as const)
    expect(own(w), w).toEqual([]);
  // Compras (rascunho criado: audiência de gestão de compras/estoque): só WEB com compras.ver.
  for (const w of ['gestor', 'paulaWeb'] as const)
    expect(types(w).has('purchase_order.created'), w).toBe(true);
  for (const w of ['paulaDevice', 'ricardo', 'marcio', 'ops'] as const)
    expect(types(w).has('purchase_order.created'), w).toBe(false);
  // Diagnóstico preservado: chega aos tablets com a permissão (inclusive a Paula no tablet) e ao painel.
  for (const w of ['gestor', 'paulaWeb', 'paulaDevice', 'ricardo', 'marcio'] as const)
    expect(
      diag(w).map((e) => e.payload.message),
      w,
    ).toContain('diag-tablet');
  expect(diag('ops')).toEqual([]);
  // Nenhum payload leva valores (nem para o gestor).
  for (const w of Object.keys(got) as Who[]) {
    expect(JSON.stringify(got[w]), w).not.toMatch(valueOf(98765, 4321, 51852));
    expect(moneyKeys(got[w].map((e) => e.payload)), w).toEqual([]);
  }
}

describe('Tempo real — audiência por permissão, por pessoa e por tipo de sessão', () => {
  it('ao vivo: cada sessão recebe o que lhe cabe; a mesma pessoa vê finance/compras no painel e não no tablet', async () => {
    const { s, clients, paulaId } = await people();
    const ws = {} as Record<Who, WsClient>;
    for (const [w, c] of Object.entries(clients))
      ws[w as Who] = track(await WsClient.connect(app, c));
    const ids = await fire(s, clients.paulaDevice);
    await Promise.all(
      Object.values(ws).map((w) =>
        w.waitFor(
          (m) => m.event?.type === 'purchase_order.confirmed' && m.event.aggregateId === ids.poId,
        ),
      ),
    );
    const got = Object.fromEntries(
      Object.entries(ws).map(([w, c]) => [w, c.events() as Ev[]]),
    ) as Record<Who, Ev[]>;
    checkAudience(got, { ricardo: s.ids.ricardo, paula: paulaId });
    // O aviso do tablet indica a origem sem expor nada além do nome/superfície.
    const sig = got.paulaWeb.find((e) => e.type === 'sync.signal')!;
    expect((sig.payload.from as { surface: string }).surface).toBe('tablet');
  });

  it('reconexão: replay pelo WebSocket e por HTTP com o mesmo recorte (nada de outra audiência vaza no reenvio)', async () => {
    const { s, clients, paulaId } = await people();
    // Último seq de cada sessão antes da queda (todas conectadas e então desconectadas).
    const since = {} as Record<Who, string>;
    for (const [w, c] of Object.entries(clients)) {
      const live = await WsClient.connect(app, c);
      since[w as Who] = (
        live.messages.find((m) => m.kind === 'hello') as { headSeq: string }
      ).headSeq;
      await live.close();
    }
    await fire(s, clients.paulaDevice);
    // Reconecta com o último seq → recebe só o que é seu.
    const got = {} as Record<Who, Ev[]>;
    for (const [w, c] of Object.entries(clients)) {
      const r = track(await WsClient.connect(app, c, since[w as Who]));
      const done = await r.waitFor((m) => m.kind === 'replay.done');
      got[w as Who] = r.events() as Ev[];
      expect(done.count, w).toBe(got[w as Who].length);
    }
    checkAudience(got, { ricardo: s.ids.ricardo, paula: paulaId });
    // HTTP (/api/sync/events) entrega exatamente o mesmo conjunto que o replay do WebSocket.
    for (const [w, c] of Object.entries(clients)) {
      const http: Ev[] = [];
      let cursor = since[w as Who];
      for (;;) {
        const r = await c.get(`/api/sync/events?since=${cursor}&limit=200`);
        expect(r.status, w).toBe(200);
        http.push(...(r.body.events as Ev[]));
        cursor = r.body.nextSince;
        if (!r.body.hasMore) break;
      }
      const last = BigInt(got[w as Who].at(-1)!.seq);
      expect(
        http.filter((e) => BigInt(e.seq) <= last).map((e) => e.seq),
        w,
      ).toEqual(got[w as Who].map((e) => e.seq));
    }
  });
});
