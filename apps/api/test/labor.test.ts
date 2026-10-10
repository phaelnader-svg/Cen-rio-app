import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { panelUserWith } from './commercial-helpers';
import { grant, openServiceOrder } from './measurement-helpers';
import {
  act,
  addOs,
  createPlan,
  day,
  publish,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';

/**
 * Evolução, Fase 5 — mão de obra dos tapeceiros: valor por peça ligado ao titular, revisão
 * financeira na substituição, liberação por evento, pagamentos parciais, "Meus valores" com
 * PIN e base semanal para a Fase 7. Dados fictícios; valores em centavos.
 * OS de teste: sofá (titular Ricardo) + poltronas (titular Márcio).
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const setClock = (hhmm: string) => setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));

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
  await db().companySettings.update({
    where: { id: 1 },
    data: {
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '07:00',
      workdayStart: '08:30',
      arrivalAlertAt: '09:30',
      workdayEnd: '18:00',
      lateAlertMinutes: 15,
    },
  });
  setClock('08:00');
});
afterEach(async () => {
  setAttendanceClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};
const F = (path: string) => `/api/v1/finance${path}`;
const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });
const moneyKeys = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object')
      for (const [k, val] of Object.entries(x)) {
        if (/cents$|price|revenue|margin|cost|valor|preco|amount|salary|payable/i.test(k))
          out.push(k);
        walk(val);
      }
  };
  walk(v);
  return out;
};

/** OS publicada com titulares por peça; Ricardo, Márcio, Thiago e João chegaram; 09:00. */
async function scenario(opts: { owners?: boolean } = {}) {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, 'Cliente Mão de Obra');
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ids.ricardo,
      date: day(-1),
    })
  ).body as { tasks: { id: string }[] };
  for (const t of added.tasks)
    await post(admin, `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora do teste' });
  const task = async (body: Record<string, unknown>) => {
    const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      date: day(-1),
      time: '08:00',
      ...body,
    });
    if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  };
  const sofa = so.items[0]!;
  const poltronas = so.items[1]!;
  const sofaTask = await task({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do sofá',
    serviceOrderItemId: sofa.id,
    role: 'PRINCIPAL',
    assigneeUserId: ids.ricardo,
  });
  const poltronaTask = await task({
    activity: 'ACABAMENTO',
    title: 'Acabamento das poltronas',
    serviceOrderItemId: poltronas.id,
    role: 'PRINCIPAL',
    assigneeUserId: ids.marcio,
  });
  await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
  if (opts.owners !== false) {
    await setOwner(admin, sofa.id, ids.ricardo, null);
    await setOwner(admin, poltronas.id, ids.marcio, null);
  }
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'Thiago', 'João'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  for (const name of Object.keys(tablets)) {
    const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive');
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  return { admin, so, sofa, poltronas, ids, tablets, sofaTask, poltronaTask };
}

async function setOwner(
  admin: Client,
  itemId: string,
  userId: string,
  expectedUserId: string | null,
  reason?: string,
) {
  const r = await put(admin, `/api/v1/service-order-items/${itemId}/upholsterer`, {
    userId,
    expectedUserId,
    reason,
    confirm: Boolean(expectedUserId),
  });
  if (r.status !== 200) throw new Error(`owner: ${JSON.stringify(r.body)}`);
  return r.body as { changed: boolean; financialReviewRequired?: boolean };
}

async function labor(admin: Client, body: Record<string, unknown>, key = idemKey()) {
  return post(
    admin,
    F('/labor'),
    { service: 'Reforma completa do sofá', agreedCents: 80000, ...body },
    key,
  );
}

async function finish(c: Client, taskId: string) {
  const s = await act(c, taskId, 'start');
  if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
  const r = await act(c, taskId, 'complete', { note: 'Serviço concluído' });
  if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
}

async function approveInspection(thiago: Client, itemId: string) {
  const open = await db().qualityInspection.findFirstOrThrow({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
  });
  let i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  for (const it of i.items) {
    const r = await thiago.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
      result: 'OK',
      note: null,
    });
    if (r.status !== 200) throw new Error(`check: ${JSON.stringify(r.body)}`);
  }
  i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  const r = await post(thiago, `/api/v1/quality/inspections/${i.id}/approve`, {
    version: i.version,
  });
  if (r.status !== 200) throw new Error(`approve: ${JSON.stringify(r.body)}`);
}

const pay = (c: Client, id: string, amountCents: number, version: number, key = idemKey()) =>
  post(
    c,
    F(`/labor/${id}/payments`),
    { amountCents, paidAt: today(), method: 'PIX', version },
    key,
  );
const row = (id: string) => db().productionPayable.findUniqueOrThrow({ where: { id } });

// ───────────────────────────────────────────────────────────────────────────

describe('Valor por peça (CA5-01, 02, 03, 04)', () => {
  it('1. valor por peça ligado ao titular; peças independentes; valores inválidos recusados', async () => {
    const s = await scenario();
    // Validação: zero, negativo, ausente, fracionário.
    for (const agreedCents of [0, -100, undefined, 10.5]) {
      const r = await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        agreedCents,
      });
      expect(r.status, String(agreedCents)).toBe(400);
    }
    // Valor por peça de outra pessoa que não o titular: recusado (sem dividir).
    const wrong = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
    });
    expect(wrong.status).toBe(422);
    // OS inteira com peças de titulares diferentes: recusado (rateio não inequívoco).
    const whole = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
    });
    expect(whole.status).toBe(422);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 80000,
    });
    const mar = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      service: 'Troca de tecido das poltronas',
      agreedCents: 45000,
    });
    expect([ric.status, mar.status]).toEqual([201, 201]);
    expect(ric.body).toMatchObject({
      situation: 'PREVISTO',
      review: null,
      needsPieceReview: false,
    });
    const v = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v.pieces).toHaveLength(2);
    const [pSofa, pPolt] = v.pieces;
    expect(pSofa).toMatchObject({
      upholsterer: { userId: s.ids.ricardo },
      missingValue: false,
      openReview: null,
    });
    expect(pSofa.payables.map((p: { agreedCents: number }) => p.agreedCents)).toEqual([80000]);
    expect(pPolt.payables.map((p: { agreedCents: number }) => p.agreedCents)).toEqual([45000]);
    expect(pPolt.payables[0].professional.userId).toBe(s.ids.marcio);
    expect(v.wholeOrder).toEqual([]);
    // Persistência em centavos inteiros, uma obrigação por peça.
    const rows = await db().productionPayable.findMany({ orderBy: { number: 'asc' } });
    expect(rows.map((r) => [r.professionalUserId, r.agreedCents])).toEqual([
      [s.ids.ricardo, 80000],
      [s.ids.marcio, 45000],
    ]);
    // Peça sem valor: "sem valor combinado", nunca R$ 0.
    await db().productionPayable.update({
      where: { id: mar.body.id },
      data: { status: 'CANCELADO', cancelReason: 'teste' },
    });
    const v2 = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v2.pieces[1].missingValue).toBe(true);
  });

  it('2. edição do valor combinado: permissão, motivo, versão, antes/depois e nunca após pagamento', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    const operator = await panelUserWith(app, s.admin, 'fin-op', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const url = F(`/labor/${mo.id}/agreed`);
    expect(
      (await post(operator, url, { agreedCents: 90000, reason: 'Revisão', version: mo.version }))
        .status,
    ).toBe(403);
    expect((await post(s.admin, url, { agreedCents: 90000, version: mo.version })).status).toBe(
      400,
    );
    expect(
      (await post(s.admin, url, { agreedCents: 0, reason: 'Zerar', version: mo.version })).status,
    ).toBe(400);
    expect(
      (await post(s.admin, url, { agreedCents: 90000, reason: 'Velha', version: mo.version + 5 }))
        .status,
    ).toBe(409);
    const ok = await post(s.admin, url, {
      agreedCents: 90000,
      reason: 'Braços com costura extra',
      version: mo.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ agreedCents: 90000, dueCents: 90000 });
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'finance.labor_agreed_changed' },
    });
    expect(log.changes).toEqual({ agreedCents: { from: 80000, to: 90000 } });
    expect(log.summary).toContain('Braços com costura extra');
    expect(ok.body.history.map((h: { kind: string }) => h.kind)).toContain('VALOR_ALTERADO');
    // Depois de pagamento: só ajuste justificado.
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    const p = await pay(s.admin, mo.id, 10000, cur.version);
    expect(p.status).toBe(200);
    const after = await post(s.admin, url, {
      agreedCents: 70000,
      reason: 'Depois do pagamento',
      version: p.body.version,
    });
    expect(after.status).toBe(422);
    expect((await row(mo.id)).agreedCents).toBe(90000);
  });

  it('3. legado por OS: valor preservado; definir titular de outra pessoa abre revisão, sem replicar', async () => {
    const s = await scenario({ owners: false });
    // Valor antigo da OS inteira, combinado antes dos titulares por peça.
    const whole = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      service: 'OS inteira (legado)',
      agreedCents: 125000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    expect(whole.status).toBe(201);
    await setOwner(s.admin, s.sofa.id, s.ids.ricardo, null); // mesmo profissional: sem revisão
    expect(await db().laborReview.count()).toBe(0);
    const r = await setOwner(s.admin, s.poltronas.id, s.ids.marcio, null);
    expect(r.financialReviewRequired).toBe(true);
    const reviews = await db().laborReview.findMany();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'ABERTA', serviceOrderItemId: null });
    // Nada foi copiado para as peças; o valor da OS continua igual.
    expect(await db().productionPayable.count()).toBe(1);
    const dto = (await s.admin.get(F(`/labor/${whole.body.id}`))).body;
    expect(dto).toMatchObject({
      agreedCents: 125000,
      situation: 'EM_REVISAO',
      needsPieceReview: true,
      review: { code: 'RF-00001' },
    });
    // Conclusão não libera enquanto a revisão estiver aberta.
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await finish(s.tablets['Márcio']!, s.poltronaTask.id);
    expect((await row(whole.body.id)).status).toBe('PREVISTO');
  });
});

describe('Privacidade e tablet (CA5-05, 06)', () => {
  it('4. Meus valores: só os próprios, com PIN redigitado; sem acesso cruzado nem para terceiros', async () => {
    const s = await scenario();
    const ric = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        agreedCents: 81234,
      })
    ).body;
    const mar = (
      await labor(s.admin, {
        professionalUserId: s.ids.marcio,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.poltronas.id,
        agreedCents: 45678,
      })
    ).body;
    const R = s.tablets.Ricardo!;
    const M = s.tablets['Márcio']!;
    const J = s.tablets['João']!;
    // Sem a permissão específica: nada.
    expect((await post(R, F('/my-production/unlock'), { pin: PINS.Ricardo })).status).toBe(403);
    await grant(s.admin, 'Ricardo', ['financeiro.producao_propria']);
    await grant(s.admin, 'Márcio', ['financeiro.producao_propria']);
    // Tablet: a sessão do aparelho não basta.
    expect((await R.get(F('/my-production'))).status).toBe(403);
    // PIN errado (e PIN de outra pessoa) recusado.
    expect((await post(R, F('/my-production/unlock'), { pin: '000000' })).status).toBe(401);
    expect((await post(R, F('/my-production/unlock'), { pin: PINS['Márcio'] })).status).toBe(401);
    expect((await post(R, F('/my-production/unlock'), { pin: '12' })).status).toBe(400);
    const mineR = await post(R, F('/my-production/unlock'), { pin: PINS.Ricardo });
    expect(mineR.status).toBe(200);
    expect(mineR.headers['cache-control']).toBe('no-store');
    expect(mineR.body.items.map((i: { code: string }) => i.code)).toEqual([ric.code]);
    expect(mineR.body.totals.forecastCents).toBe(81234);
    expect(JSON.stringify(mineR.body)).not.toMatch(/45678|Márcio/);
    const mineM = await post(M, F('/my-production/unlock'), { pin: PINS['Márcio'] });
    expect(mineM.body.items.map((i: { code: string }) => i.code)).toEqual([mar.code]);
    expect(JSON.stringify(mineM.body)).not.toMatch(/81234|Ricardo/);
    // Acesso cruzado por URL/API/export: recusado.
    for (const p of [
      F(`/labor/${mar.id}`),
      F('/labor'),
      F(`/service-orders/${s.so.id}/labor`),
      F('/labor-reviews'),
      F(`/labor-weekly?from=${day(-7)}&to=${today()}`),
      F(`/reports/labor?from=${day(-7)}&to=${today()}`),
    ]) {
      const r = await R.get(p);
      expect(r.status, p).toBe(403);
      expect(JSON.stringify(r.body)).not.toMatch(/45678/);
    }
    // João (sem permissão), usuário do painel sem financeiro: nada.
    expect((await post(J, F('/my-production/unlock'), { pin: PINS['João'] })).status).toBe(403);
    const plain = await panelUserWith(app, s.admin, 'sem-fin', ['producao.ver']);
    for (const p of [
      F(`/labor/${ric.id}`),
      F(`/service-orders/${s.so.id}/labor`),
      F('/my-production'),
    ])
      expect((await plain.get(p)).status, p).toBe(403);
    // Bloqueio após tentativas erradas (mesma política do login por PIN).
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await post(M, F('/my-production/unlock'), { pin: '999999' })).status;
    expect(last).toBe(429);
    expect((await post(M, F('/my-production/unlock'), { pin: PINS['Márcio'] })).status).toBe(429);
  });

  it('5. sem vazamento: endpoints de produção, Minha semana, notificações e WebSocket', async () => {
    const s = await scenario();
    await grant(s.admin, 'Ricardo', ['financeiro.producao_propria']);
    const ws = track(await WsClient.connect(app, s.tablets.Ricardo!));
    const wsAdmin = track(await WsClient.connect(app, s.admin));
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    const cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    expect(cur.situation).toBe('EM_REVISAO');
    await wsAdmin.waitFor((m) => m.event?.type === 'production.piece_owner_changed');
    await ws.waitFor((m) => m.event?.type === 'production.piece_owner_changed');
    const paths = [
      '/api/auth/me',
      '/api/v1/production-tasks/mine',
      '/api/v1/production-tasks/mine/queue',
      `/api/v1/production-tasks/${s.sofaTask.id}`,
      '/api/v1/notifications?limit=50',
      '/api/v1/attendance/me',
    ];
    for (const [name, c] of Object.entries(s.tablets))
      for (const p of paths) {
        const r = await c.get(p);
        if (r.status >= 400) continue;
        expect(moneyKeys(r.body), `${name} ${p}`).toEqual([]);
      }
    expect(moneyKeys(ws.messages)).toEqual([]);
    expect(JSON.stringify(ws.messages)).not.toMatch(/finance\.|80000/);
    // O painel do gestor recebe os eventos financeiros (revisão aberta).
    expect(JSON.stringify(wsAdmin.messages)).toMatch(/finance\./);
  });
});

describe('Estados, qualidade e pagamentos (CA5-07, 08, 09, 10)', () => {
  it('6. concluir não paga; aprovação libera por evento (sem abrir tela); retrabalho não duplica', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'QUALIDADE_APROVADA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'De novo' });
    expect((await row(mo.id)).status).toBe('PREVISTO');
    expect(await db().professionalPayment.count()).toBe(0);
    const waiting = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    expect(waiting).toMatchObject({ status: 'PREVISTO', situation: 'AGUARDANDO_QUALIDADE' });
    // Aprovação do Thiago: o banco muda na mesma transação (lido direto, sem GET).
    await approveInspection(s.tablets.Thiago!, s.sofa.id);
    const r = await row(mo.id);
    expect(r.status).toBe('LIBERADO');
    expect(r.eligibleAt).not.toBeNull();
    // Leituras repetidas não criam eventos nem obrigações novas.
    for (let i = 0; i < 3; i++) await s.admin.get(F(`/labor/${mo.id}`));
    expect(await db().productionPayable.count()).toBe(1);
    expect(await db().financialEvent.count({ where: { entityId: mo.id, kind: 'LIBERADO' } })).toBe(
      1,
    );
    // Liberado continua liberado (liberação não é revertida por leitura).
    expect((await s.admin.get(F(`/labor/${mo.id}`))).body.situation).toBe('LIBERADO');
  });

  it('6b. reprovação e retrabalho: nada liberado nem duplicado até a nova aprovação', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'QUALIDADE_APROVADA',
      })
    ).body;
    const T = s.tablets.Thiago!;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const first = await db().qualityInspection.findFirstOrThrow({
      where: { serviceOrderItemId: s.sofa.id, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    });
    let i = (await T.get(`/api/v1/quality/inspections/${first.id}`)).body;
    for (const it of i.items)
      await T.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
        result: it.label === i.items[0].label ? 'NAO_CONFORME' : 'OK',
        note: it.label === i.items[0].label ? 'Ponto solto' : null,
      });
    i = (await T.get(`/api/v1/quality/inspections/${first.id}`)).body;
    const rej = await post(T, `/api/v1/quality/inspections/${i.id}/reject`, {
      reason: 'Refazer a costura',
      version: i.version,
    });
    expect(rej.status).toBe(200);
    expect((await row(mo.id)).status).toBe('PREVISTO');
    const c = await db().productionTask.findFirstOrThrow({ where: { activity: 'CORRECAO' } });
    const st = await act(s.tablets.Ricardo!, c.id, 'start');
    expect(st.status).toBe(200);
    expect(
      (await act(s.tablets.Ricardo!, c.id, 'complete', { note: 'Costura refeita' })).status,
    ).toBe(200);
    expect((await row(mo.id)).status).toBe('PREVISTO');
    expect((await s.admin.get(F(`/labor/${mo.id}`))).body.situation).toBe('AGUARDANDO_QUALIDADE');
    await approveInspection(T, s.sofa.id);
    expect((await row(mo.id)).status).toBe('LIBERADO');
    // Uma obrigação, um evento de liberação, nenhum pagamento automático.
    expect(await db().productionPayable.count()).toBe(1);
    expect(await db().financialEvent.count({ where: { entityId: mo.id, kind: 'LIBERADO' } })).toBe(
      1,
    );
    expect(await db().professionalPayment.count()).toBe(0);
  });

  it('7. pagamento parcial: saldo correto, nunca acima do devido, permissão e idempotência', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    let cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    const viewer = await panelUserWith(app, s.admin, 'fin-ver', ['financeiro.ver']);
    expect((await pay(viewer, mo.id, 10000, cur.version)).status).toBe(403);
    const key = idemKey();
    const a = await pay(s.admin, mo.id, 30000, cur.version, key);
    const again = await pay(s.admin, mo.id, 30000, cur.version, key);
    expect(a.body).toMatchObject({ status: 'PAGO_PARCIAL', paidCents: 30000, openCents: 50000 });
    expect(again.body).toEqual(a.body);
    cur = a.body;
    expect((await pay(s.admin, mo.id, 50001, cur.version)).status).toBe(422);
    const b = await pay(s.admin, mo.id, 50000, cur.version);
    expect(b.body).toMatchObject({ status: 'PAGO', paidCents: 80000, openCents: 0 });
    expect((await pay(s.admin, mo.id, 1, b.body.version)).status).toBe(422);
    expect(await db().professionalPayment.count()).toBe(2);
    const sum = await db().professionalPayment.aggregate({ _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(80000);
  });

  it('8. concorrência: criação, pagamento, edição e resolução simultâneos não duplicam', async () => {
    const s = await scenario();
    const body = {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      eligibility: 'PRODUCAO_CONCLUIDA',
    };
    const created = await Promise.all([labor(s.admin, body), labor(s.admin, body)]);
    expect(created.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db().productionPayable.count()).toBe(1);
    const mo = created.find((r) => r.status === 201)!.body;
    const edits = await Promise.all(
      [85000, 86000].map((v) =>
        post(s.admin, F(`/labor/${mo.id}/agreed`), {
          agreedCents: v,
          reason: 'Concorrência',
          version: mo.version,
        }),
      ),
    );
    expect(edits.map((r) => r.status).sort()).toEqual([200, 409]);
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    const pays = await Promise.all([
      pay(s.admin, mo.id, cur.dueCents, cur.version),
      pay(s.admin, mo.id, cur.dueCents, cur.version),
    ]);
    expect(pays.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db().professionalPayment.count()).toBe(1);
    // Revisão: duas resoluções simultâneas → uma só.
    const s2 = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 40000,
    });
    await setOwner(s.admin, s.poltronas.id, s.ids.ricardo, s.ids.marcio, 'Márcio de férias');
    const rv = await db().laborReview.findFirstOrThrow({ where: { status: 'ABERTA' } });
    const res = {
      lines: [
        { professionalUserId: s.ids.marcio, amountCents: 10000 },
        { professionalUserId: s.ids.ricardo, amountCents: 30000 },
      ],
      reason: 'Márcio cortou; Ricardo costura e monta',
      version: rv.version,
    };
    const both = await Promise.all([
      post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), res),
      post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), res),
    ]);
    expect(both.map((r) => r.status).sort(), JSON.stringify(both.map((r) => r.body))).toEqual([
      200, 422,
    ]);
    expect(
      await db().productionPayable.count({ where: { serviceOrderItemId: s.poltronas.id } }),
    ).toBe(2);
    expect(
      await db().financialAdjustment.count({ where: { productionPayableId: s2.body.id } }),
    ).toBe(1);
    // Índice do banco: segunda obrigação viva da mesma pessoa na mesma peça é impossível.
    await expect(
      db().productionPayable.create({
        data: {
          professionalUserId: s.ids.ricardo,
          serviceOrderId: s.so.id,
          serviceOrderItemId: s.sofa.id,
          service: 'Duplicada',
          agreedCents: 1,
          eligibility: 'PRODUCAO_CONCLUIDA',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('Substituição e revisão financeira (CA5-11, 12, 13)', () => {
  it('9. substituição com valor: revisão aberta, nada transferido, operações travadas', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    let cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    const partial = await pay(s.admin, mo.id, 30000, cur.version);
    expect(partial.body.status).toBe('PAGO_PARCIAL');
    const before = await row(mo.id);
    const r = await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    expect(r.financialReviewRequired).toBe(true);
    // Nada transferido: mesma obrigação, mesmo valor, mesmos pagamentos.
    const after = await row(mo.id);
    expect(after).toMatchObject({
      professionalUserId: s.ids.ricardo,
      agreedCents: before.agreedCents,
      paidCents: 30000,
      status: 'PAGO_PARCIAL',
    });
    expect(await db().productionPayable.count()).toBe(1);
    const change = await db().serviceOrderItemOwnerChange.findFirstOrThrow({
      where: { kind: 'SUBSTITUICAO' },
    });
    const review = await db().laborReview.findFirstOrThrow({ where: { status: 'ABERTA' } });
    expect(review).toMatchObject({ serviceOrderItemId: s.sofa.id, ownerChangeId: change.id });
    // Repetir a substituição (ida e volta) não abre segunda revisão no mesmo escopo.
    await setOwner(s.admin, s.sofa.id, s.ids.ricardo, s.ids.marcio, 'Voltou');
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Afastado de novo');
    expect(await db().laborReview.count({ where: { status: 'ABERTA' } })).toBe(1);
    cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    expect(cur).toMatchObject({ situation: 'EM_REVISAO', review: { code: 'RF-00001' } });
    // Bloqueios: pagamento, ajuste, edição e novo valor na peça.
    expect((await pay(s.admin, mo.id, 1000, cur.version)).status).toBe(422);
    expect(
      (
        await post(s.admin, F(`/labor/${mo.id}/adjustments`), {
          amountCents: 1000,
          reason: 'Extra',
          version: cur.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post(s.admin, F(`/labor/${mo.id}/agreed`), {
          agreedCents: 1000,
          reason: 'Mudar',
          version: cur.version,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await labor(s.admin, {
          professionalUserId: s.ids.marcio,
          serviceOrderId: s.so.id,
          serviceOrderItemId: s.sofa.id,
        })
      ).status,
    ).toBe(422);
    expect(await db().professionalPayment.count()).toBe(1);
    // Pendência visível na distribuição e no painel do financeiro.
    const v = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v.pieces[0].openReview).toMatchObject({ code: 'RF-00001' });
    expect(v.openReviews[0].lines).toEqual([
      expect.objectContaining({
        professionalUserId: s.ids.ricardo,
        dueCents: 80000,
        paidCents: 30000,
      }),
    ]);
  });

  it('10. resolução explícita: conciliação, nunca abaixo do pago, auditoria e histórico íntegro', async () => {
    const s = await scenario();
    const mo = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const cur = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    await pay(s.admin, mo.id, 30000, cur.version);
    await setOwner(s.admin, s.sofa.id, s.ids.marcio, s.ids.ricardo, 'Ricardo afastado');
    const rv = (await s.admin.get(F('/labor-reviews?status=ABERTA'))).body[0];
    const url = F(`/labor-reviews/${rv.id}/resolve`);
    const operator = await panelUserWith(app, s.admin, 'fin-op2', [
      'financeiro.ver',
      'financeiro.gerenciar',
    ]);
    const okLines = [
      { professionalUserId: s.ids.ricardo, amountCents: 35000 },
      { professionalUserId: s.ids.marcio, amountCents: 45000 },
    ];
    expect(
      (await post(operator, url, { lines: okLines, reason: 'Divisão', version: rv.version }))
        .status,
    ).toBe(403);
    // Sem o profissional que já tinha valor: recusado (nada some em silêncio).
    expect(
      (
        await post(s.admin, url, {
          lines: [{ professionalUserId: s.ids.marcio, amountCents: 80000 }],
          reason: 'Tudo para o Márcio',
          version: rv.version,
        })
      ).status,
    ).toBe(422);
    // Abaixo do já pago: recusado.
    expect(
      (
        await post(s.admin, url, {
          lines: [
            { professionalUserId: s.ids.ricardo, amountCents: 20000 },
            { professionalUserId: s.ids.marcio, amountCents: 60000 },
          ],
          reason: 'Abaixo do pago',
          version: rv.version,
        })
      ).status,
    ).toBe(422);
    // Ajudante não recebe por produção.
    expect(
      (
        await post(s.admin, url, {
          lines: [...okLines, { professionalUserId: s.ids.joao, amountCents: 1000 }],
          reason: 'Ajudante',
          version: rv.version,
        })
      ).status,
    ).toBe(422);
    expect((await post(s.admin, url, { lines: okLines, version: rv.version })).status).toBe(400);
    const done = await post(s.admin, url, {
      lines: okLines,
      reason: 'Ricardo fez o corte e parte da costura; Márcio termina',
      version: rv.version,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'RESOLVIDA', code: 'RF-00001' });
    expect(done.body.resolution).toEqual([
      expect.objectContaining({
        professionalUserId: s.ids.ricardo,
        beforeCents: 80000,
        afterCents: 35000,
        paidCents: 30000,
        payableId: mo.id,
      }),
      expect.objectContaining({
        professionalUserId: s.ids.marcio,
        beforeCents: 0,
        afterCents: 45000,
        paidCents: 0,
      }),
    ]);
    // Ricardo: valor original + ajuste justificado; pagamento anterior intacto.
    const ric = (await s.admin.get(F(`/labor/${mo.id}`))).body;
    expect(ric).toMatchObject({
      agreedCents: 80000,
      adjustmentsCents: -45000,
      dueCents: 35000,
      paidCents: 30000,
      openCents: 5000,
      status: 'PAGO_PARCIAL',
      review: null,
    });
    expect(ric.payments).toHaveLength(1);
    // Márcio: obrigação própria ligada à revisão, liberada (produção já concluída).
    const mar = await db().productionPayable.findFirstOrThrow({
      where: { professionalUserId: s.ids.marcio },
    });
    expect(mar).toMatchObject({ agreedCents: 45000, reviewId: rv.id, status: 'LIBERADO' });
    // Conciliação: total devido = 80.000 antes e depois.
    const total = await db().productionPayable.findMany({
      where: { status: { not: 'CANCELADO' } },
    });
    expect(total.reduce((a, p) => a + p.agreedCents + p.adjustmentsCents, 0)).toBe(80000);
    expect(await db().auditLog.count({ where: { action: 'finance.labor_review_resolved' } })).toBe(
      1,
    );
    // Revisão resolvida é imutável; repetir é recusado; pagamento volta a funcionar.
    expect(
      (await post(s.admin, url, { lines: okLines, reason: 'De novo', version: rv.version + 1 }))
        .status,
    ).toBe(422);
    await expect(
      db().laborReview.update({ where: { id: rv.id }, data: { reason: 'x' } }),
    ).rejects.toThrow(/imutável/);
    await expect(db().laborReview.deleteMany()).rejects.toThrow();
    expect((await pay(s.admin, mo.id, 5000, ric.version)).body.status).toBe('PAGO');
    // Pendência da distribuição some com a resolução.
    const v = (await s.admin.get(F(`/service-orders/${s.so.id}/labor`))).body;
    expect(v.openReviews).toEqual([]);
    expect(v.pieces[0].openReview).toBeNull();
  });
});

describe('Base da Fase 7 (CA5-16)', () => {
  it('11. totais por tapeceiro e semana: combinado, liberado, pago e saldo, sem duplicar', async () => {
    const s = await scenario();
    const ric = (
      await labor(s.admin, {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        eligibility: 'PRODUCAO_CONCLUIDA',
      })
    ).body;
    await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 45000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const cur = (await s.admin.get(F(`/labor/${ric.id}`))).body;
    await pay(s.admin, ric.id, 30000, cur.version);
    const viewer = await panelUserWith(app, s.admin, 'fin-ver2', ['financeiro.ver']);
    const w = await viewer.get(F(`/labor-weekly?from=${day(-6)}&to=${day(6)}`));
    expect(w.status).toBe(200);
    const by = (uid: string) =>
      (
        w.body.rows as {
          professionalUserId: string;
          agreedCents: number;
          releasedCents: number;
          paidCents: number;
          weekStart: string;
        }[]
      )
        .filter((r) => r.professionalUserId === uid)
        .reduce(
          (a, r) => ({
            agreed: a.agreed + r.agreedCents,
            released: a.released + r.releasedCents,
            paid: a.paid + r.paidCents,
          }),
          { agreed: 0, released: 0, paid: 0 },
        );
    expect(by(s.ids.ricardo)).toEqual({ agreed: 80000, released: 80000, paid: 30000 });
    expect(by(s.ids.marcio)).toEqual({ agreed: 45000, released: 0, paid: 0 });
    for (const r of w.body.rows) expect(new Date(`${r.weekStart}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(w.body.openByProfessional).toEqual([
      expect.objectContaining({ professionalUserId: s.ids.ricardo, openCents: 50000 }),
    ]);
    // Período fora: nada.
    const empty = (await viewer.get(F(`/labor-weekly?from=${day(30)}&to=${day(36)}`))).body;
    expect(empty.rows).toEqual([]);
    expect((await viewer.get(F(`/labor-weekly?from=${day(6)}&to=${day(-6)}`))).status).toBe(400);
  });
});
