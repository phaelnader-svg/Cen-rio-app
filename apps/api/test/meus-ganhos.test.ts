import { closingWeekStart, isMonday, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { setClock as setAppClock } from '../src/core/clock';
import type { Client } from './helpers';
import {
  WsClient,
  createTestApp,
  db,
  resetDatabase,
  setupTablet,
  withoutOwnChanged,
} from './helpers';
import {
  F,
  PINS,
  TZ,
  adjust,
  finish,
  labor,
  moneyKeys,
  pay,
  post,
  prepareCompany,
  row,
  scenario,
  setOwner,
} from './labor-helpers';
import { day, tabletOf, today, userIdOf } from './production-helpers';

/**
 * R1 — "Meus Ganhos" no tablet: visão do próprio profissional sobre a mesma fonte do
 * fechamento; PIN libera por 5 minutos a sessão; privacidade estrita (HTTP, WS, notificações).
 */
let app: App;
const sockets: WsClient[] = [];
beforeAll(async () => {
  app = await createTestApp();
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
const LAST_WEEK = closingWeekStart(day(-7));
const unlock = (c: Client, pin: string) => post(c, F('/my-earnings/unlock'), { pin });
const earnings = (c: Client, token: string | undefined, week?: string) =>
  c.req(
    'GET',
    F(`/my-earnings${week ? `?week=${week}` : ''}`),
    undefined,
    token ? { 'x-earnings-unlock': token } : {},
  );
async function open(c: Client, pin: string, week?: string) {
  const u = await unlock(c, pin);
  if (u.status !== 200) throw new Error(`unlock: ${JSON.stringify(u.body)}`);
  const r = await earnings(c, u.body.unlockToken, week);
  if (r.status !== 200) throw new Error(`earnings: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Ricardo: sofá liberado (R$ 1.000, pago R$ 400); Márcio: poltronas previstas (R$ 450). */
async function base() {
  const s = await scenario(app);
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 100000,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  const mar = await labor(s.admin, {
    professionalUserId: s.ids.marcio,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.poltronas.id,
    agreedCents: 45000,
    service: 'Troca de tecido das poltronas',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  await pay(s.admin, ric.id, 40000);
  return { s, ric, mar };
}

describe('Meus Ganhos = fechamento (13–19)', () => {
  it('13/14. totais iguais aos do fechamento para a mesma pessoa e semana; previsto separado de devido', async () => {
    const { s, ric, mar } = await base();
    const mine = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    const closing = (
      await s.admin.get(F(`/weekly-closings/${WEEK}?beneficiaryUserId=${s.ids.ricardo}`))
    ).body;
    expect(mine.weekStart).toBe(WEEK);
    expect(mine.summary).toMatchObject({
      releasedCents: closing.totals.dueCents,
      paidInWeekCents: closing.totals.paidInWeekCents,
      balanceCents: closing.totals.currentOpenCents,
      forecastCents: closing.totals.forecastCents,
    });
    expect(mine.summary).toMatchObject({
      releasedCents: 100000,
      paidInWeekCents: 40000,
      balanceCents: 60000,
    });
    expect(mine.items.map((i: { code: string }) => i.code)).toEqual([ric.code]);
    expect(mine.items[0]).toMatchObject({
      situation: 'PAGO_PARCIAL',
      bucket: 'WEEK',
      agreedCents: 100000,
      releasedAt: today(),
      payments: [{ amountCents: 40000, paidAt: today(), reversed: false }],
    });
    // Márcio: só o próprio, previsto (fora do "a receber").
    const m = await open(s.tablets['Márcio']!, PINS['Márcio']!);
    expect(m.items.map((i: { code: string }) => i.code)).toEqual([mar.code]);
    expect(m.summary).toMatchObject({ forecastCents: 45000, releasedCents: 0, balanceCents: 0 });
    expect(m.items[0]).toMatchObject({ situation: 'PREVISTO', bucket: 'FORECAST', dueCents: 0 });
  });

  it('15/16. revisão aparece "Em revisão" sem somar no saldo; ajuste mostra o motivo', async () => {
    const { s, ric } = await base();
    expect((await adjust(s.admin, ric.id, 5000, 'Costura extra no braço')).status).toBe(200);
    let mine = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(mine.items[0].adjustments).toEqual([
      expect.objectContaining({
        amountCents: 5000,
        reason: 'Costura extra no braço',
        date: today(),
      }),
    ]);
    expect(mine.summary.balanceCents).toBe(65000);
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    mine = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(mine.items[0]).toMatchObject({ code: ric.code, situation: 'EM_REVISAO' });
    expect(mine.summary).toMatchObject({ inReviewCents: 65000, balanceCents: 0, releasedCents: 0 });
    // Resolução da revisão: o motivo (que descreve a divisão) não chega ao profissional.
    const rv = (await s.admin.get(F('/labor-reviews?status=ABERTA'))).body[0];
    const res = await post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), {
      lines: [
        { professionalUserId: s.ids.ricardo, amountCents: 90000 },
        { professionalUserId: s.ids.marcio, amountCents: 15000 },
      ],
      reason: 'Ricardo fez a base; Márcio termina por 150',
      version: rv.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    const text = JSON.stringify(after);
    expect(text).not.toMatch(/Márcio|termina/);
    expect(after.items[0].adjustments.at(-1)).toMatchObject({
      amountCents: -15000,
      reason: expect.stringMatching(/^Revisão financeira RF-\d{5}: valor definido pelo gestor\.$/),
    });
    await setOwner(s.admin, s.sofa.id, s.ids.ricardo, s.ids.marcio, 'Volta ao Ricardo');
    // O antigo "Meus valores" também não soma o que está em revisão.
    const old = await post(s.tablets.Ricardo!, F('/my-production/unlock'), { pin: PINS.Ricardo });
    // (nova revisão aberta pela volta do titular: R$ 900 devidos − R$ 400 pagos em revisão)
    expect(old.body.totals).toMatchObject({
      inReviewCents: 50000,
      releasedOpenCents: 0,
      dueCents: 0,
    });
  });

  it('17/18/19. pagamento total e estorno refletem na hora (situação e saldo)', async () => {
    const { s, ric } = await base();
    await pay(s.admin, ric.id, 60000);
    let mine = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(mine.items[0]).toMatchObject({ situation: 'PAGO', currentOpenCents: 0 });
    expect(mine.summary.balanceCents).toBe(0);
    const p = await db().professionalPayment.findFirstOrThrow({
      where: { productionPayableId: ric.id, amountCents: 60000 },
    });
    const rev = await post(s.admin, F(`/labor/${ric.id}/payments/${p.id}/reverse`), {
      reason: 'Pix devolvido',
      version: (await row(ric.id)).version,
    });
    expect(rev.status).toBe(200);
    mine = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(mine.items[0]).toMatchObject({ situation: 'PAGO_PARCIAL', currentOpenCents: 60000 });
    expect(mine.items[0].payments.filter((x: { reversed: boolean }) => x.reversed)).toHaveLength(1);
  });
});

describe('Privacidade e permissões (25–28, 34, 35)', () => {
  it('25/26. tapeceiro vê só o próprio; troca de IDs e rotas do financeiro recusadas', async () => {
    const { s, ric, mar } = await base();
    const r = s.tablets.Ricardo!;
    const mine = await open(r, PINS.Ricardo!);
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/45000|Márcio|poltronas/i);
    expect(text).not.toContain(mar.id);
    // Sem parâmetro de pessoa: o filtro é sempre a sessão (parâmetros extras são ignorados).
    const u = await unlock(r, PINS.Ricardo!);
    const tricked = await r.req(
      'GET',
      F(`/my-earnings?week=${WEEK}&userId=${s.ids.marcio}&beneficiaryUserId=${s.ids.marcio}`),
      undefined,
      { 'x-earnings-unlock': u.body.unlockToken },
    );
    expect(tricked.status).toBe(200);
    expect(tricked.body.items.map((i: { id: string }) => i.id)).toEqual([ric.id]);
    for (const p of [
      F(`/labor/${mar.id}`),
      F('/labor'),
      F(`/weekly-closings/${WEEK}`),
      F(`/service-orders/${s.so.id}/labor`),
      F('/dashboard'),
    ])
      expect((await r.get(p)).status, p).toBe(403);
    // O desbloqueio não serve para ações financeiras.
    const act = await r.req(
      'POST',
      F(`/labor/${ric.id}/payments`),
      { amountCents: 1, paidAt: today(), method: 'PIX', version: 1 },
      { 'x-earnings-unlock': u.body.unlockToken, 'idempotency-key': 'k1-r1-meus-ganhos' },
    );
    expect(act.status).toBe(403);
    // Sem dados da empresa: margem, preço ao cliente, materiais.
    expect(Object.keys(mine.items[0]).sort()).toEqual(
      [
        'adjustments',
        'adjustmentsCents',
        // R2: pedido de alteração próprio e se pode pedir.
        'canRequest',
        'request',
        'agreedCents',
        'bucket',
        'category',
        'code',
        'currentOpenCents',
        'description',
        'dueCents',
        'id',
        'paidInWeekCents',
        'payments',
        'piece',
        // Rodada 3 (F8-03): semana/data planejada do previsto — só informação do planejamento.
        'plannedFor',
        'releasedAt',
        'serviceOrders',
        'situation',
        'totalDueCents',
      ].sort(),
    );
  });

  it('27. logística vê só os próprios valores de viagem', async () => {
    const { s } = await base();
    const andre = await userIdOf('André');
    const izaias = await userIdOf('Izaías');
    const trip = async (payee: string, cents: number, name: string) => {
      const ap = await db().accountPayable.create({
        data: {
          beneficiary: name,
          category: 'LOGISTICA',
          description: `Entrega ${name}`,
          amountCents: cents,
          dueDate: new Date(`${today()}T00:00:00Z`),
        },
      });
      return db().logisticsCost.create({
        data: {
          kind: 'ENTREGA',
          description: `Entrega feita por ${name}`,
          amountCents: cents,
          date: new Date(`${today()}T00:00:00Z`),
          splitMethod: 'IGUAL',
          status: 'DEVIDO',
          payeeUserId: payee,
          dueAt: new Date(),
          payableId: ap.id,
        },
      });
    };
    const a = await trip(andre, 12000, 'André');
    await trip(izaias, 13000, 'Izaías');
    const tab = await tabletOf(app, s.admin, 'André', PINS['André']!);
    const mine = await open(tab, PINS['André']!);
    expect(mine.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    expect(mine.items[0]).toMatchObject({ category: 'LOGISTICA', situation: 'LIBERADO' });
    expect(mine.summary).toMatchObject({ releasedCents: 12000, balanceCents: 12000 });
    expect(JSON.stringify(mine)).not.toMatch(/13000|Izaías|100000|Ricardo/);
    // Ricardo não vê as viagens.
    const r = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(JSON.stringify(r)).not.toMatch(/12000|André/);
  });

  it('28. ajudante e equipe fixa: sem acesso e sem expor custo mensal (D14)', async () => {
    const { s } = await base();
    await db().teamMonthlyCost.create({
      data: {
        userId: s.ids.joao,
        month: new Date(`${today().slice(0, 7)}-01T00:00:00Z`),
        amountCents: 333300,
        createdById: null,
      },
    });
    const j = s.tablets['João']!;
    expect((await unlock(j, PINS['João']!)).status).toBe(403);
    expect((await earnings(j, 'x')).status).toBe(403);
    const r = await open(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(JSON.stringify(r)).not.toMatch(/333300|João/);
    // Permissão estreita: tapeceiro e logística não ganham acesso ao financeiro.
    const roles = await db().role.findMany({
      where: { key: { in: ['tapeceiro', 'logistica_terceirizada', 'ajudante'] } },
      include: { permissions: true },
    });
    for (const role of roles) {
      const perms = role.permissions.map((p) => p.permission);
      expect(
        perms.filter((p) => p.startsWith('financeiro.')),
        role.key ?? undefined,
      ).toEqual(role.key === 'ajudante' ? [] : ['financeiro.producao_propria']);
    }
  });

  it('34/35. WebSocket e notificações do tablet não levam valores', async () => {
    const s = await scenario(app);
    const ws = await WsClient.connect(app, s.tablets.Ricardo!);
    sockets.push(ws);
    const mo = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 98765,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await adjust(s.admin, mo.id, 1234, 'Ajuste de teste');
    await pay(s.admin, mo.id, 50000);
    await open(s.tablets.Ricardo!, PINS.Ricardo!);
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Troca');
    await ws.waitFor((m) => m.event?.type === 'production.piece_owner_changed');
    expect(moneyKeys(ws.messages)).toEqual([]);
    // Só o aviso próprio sem valores (F8-15b); nenhum outro evento financeiro.
    expect(JSON.stringify(withoutOwnChanged(ws.messages, s.ids.ricardo))).not.toMatch(
      /98765|99999|50000|finance\./,
    );
    const n = (await s.tablets.Ricardo!.get('/api/v1/notifications')).body;
    expect(moneyKeys(n)).toEqual([]);
    expect(JSON.stringify(n)).not.toMatch(/98765|50000|R\$/);
  });
});

describe('PIN e desbloqueio de 5 minutos (29–33)', () => {
  it('29/30. PIN errado recusado; bloqueio após tentativas (mesma política do login)', async () => {
    const { s } = await base();
    const m = s.tablets['Márcio']!;
    expect((await unlock(m, '000000')).status).toBe(401);
    expect((await unlock(m, PINS.Ricardo!)).status).toBe(401);
    expect((await unlock(m, '12')).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await unlock(m, '999999')).status;
    expect(last).toBe(429);
    expect((await unlock(m, PINS['Márcio']!)).status).toBe(429);
  });

  it('31/32/36/37. 5 minutos sem novo PIN (semana atual e anterior); depois expira', async () => {
    const { s } = await base();
    const r = s.tablets.Ricardo!;
    expect((await earnings(r, undefined)).status).toBe(403);
    const u = await unlock(r, PINS.Ricardo!);
    expect(u.status).toBe(200);
    expect(u.headers['cache-control']).toBe('no-store');
    expect(moneyKeys(u.body)).toEqual([]);
    // Relógio do teste parado às 09:00: o desbloqueio vale até 09:05.
    expect(u.body.expiresAt).toBe(zonedDateTime(today(), '09:05', TZ).toISOString());
    const cur = await earnings(r, u.body.unlockToken);
    expect(cur.status).toBe(200);
    expect(cur.headers['cache-control']).toBe('no-store');
    expect(cur.body).toMatchObject({ weekStart: WEEK, currentWeekStart: WEEK });
    const prev = await earnings(r, u.body.unlockToken, LAST_WEEK);
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ weekStart: LAST_WEEK, items: [] });
    expect(
      // Uma data que não é segunda-feira (aos domingos, day(-6) é segunda).
      (await earnings(r, u.body.unlockToken, isMonday(day(-6)) ? day(-5) : day(-6))).status,
    ).toBe(400);
    // 4 minutos depois ainda vale; 6 minutos depois, expirou.
    const t0 = zonedDateTime(today(), '09:00', TZ).getTime();
    setAppClock(() => new Date(t0 + 4 * 60_000));
    expect((await earnings(r, u.body.unlockToken)).status).toBe(200);
    setAppClock(() => new Date(t0 + 6 * 60_000));
    expect((await earnings(r, u.body.unlockToken)).status).toBe(403);
    setAppClock();
  });

  it('33. nova sessão / outro tablet / outra pessoa / token alterado: novo PIN obrigatório', async () => {
    const { s } = await base();
    const r = s.tablets.Ricardo!;
    const u = await unlock(r, PINS.Ricardo!);
    const token = u.body.unlockToken as string;
    // Outra pessoa (outra sessão) com o token do Ricardo: recusado.
    expect((await earnings(s.tablets['Márcio']!, token)).status).toBe(403);
    // Token adulterado (outra expiração ou assinatura): recusado.
    const [exp, sig] = token.split('.');
    expect((await earnings(r, `${Number(exp) + 3_600_000}.${sig}`)).status).toBe(403);
    expect((await earnings(r, `${exp}.${'0'.repeat(sig!.length)}`)).status).toBe(403);
    // Painel do gestor (sessão web): Meus Ganhos é só no tablet.
    expect(
      (await s.admin.req('GET', F('/my-earnings'), undefined, { 'x-earnings-unlock': token }))
        .status,
    ).toBe(403);
    // Nova sessão do Ricardo (outro tablet / reinício): não herda o desbloqueio.
    const again = (
      await setupTablet(app, s.admin, {
        name: 'Tablet reserva',
        employee: 'Ricardo',
        pin: PINS.Ricardo!,
      })
    ).tablet;
    expect((await earnings(again, token)).status).toBe(403);
  });

  it('38. fuso da oficina: liberação no domingo 23h30 local fica na semana daquele domingo', async () => {
    const { s, ric } = await base();
    const sunday = day(-((new Date(`${today()}T12:00:00Z`).getUTCDay() + 7) % 7 || 7));
    await db().productionPayable.update({
      where: { id: ric.id },
      data: { eligibleAt: zonedDateTime(sunday, '23:30', TZ) },
    });
    const week = closingWeekStart(sunday);
    const thatWeek = await open(s.tablets.Ricardo!, PINS.Ricardo!, week);
    expect(thatWeek.items.find((i: { id: string }) => i.id === ric.id)).toMatchObject({
      releasedAt: sunday,
      bucket: 'WEEK',
    });
  });
});
