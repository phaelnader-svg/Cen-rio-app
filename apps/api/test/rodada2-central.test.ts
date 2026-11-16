import {
  closingWeekStart,
  zonedDateTime,
  type AttentionDto,
  type AttentionItemDto,
  type OverviewDto,
} from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { panelUserWith } from './commercial-helpers';
import type { Client } from './helpers';
import { createTestApp, db, loginAdmin, resetDatabase } from './helpers';
import {
  F,
  PINS,
  adjust,
  allowWeek,
  finish,
  labor,
  moneyKeys,
  post,
  prepareCompany,
  row,
  scenario,
} from './labor-helpers';
import { day, today } from './production-helpers';
import { qualityKit } from './quality-helpers';

/**
 * Remediação pós-auditoria, Rodada 2 — cartões que faltavam na Central (F10-08/13d, F10-11/13o,
 * F10-12, F10-13r) e os indicadores "entregues" e "valores pagos" do Início (F10-21m/s). Tudo é
 * projeção das fontes canônicas: cada teste muda a fonte pelo fluxo existente e confere que o
 * item aparece, continua (pelo saldo/estado) e some quando a causa deixa de existir.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(() => setAttendanceClock());

const WEEK = closingWeekStart(today());
const LAST_WEEK = closingWeekStart(day(-7));
const attention = async (c: Client, query = '') => {
  const r = await c.get(`/api/v1/attention${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AttentionDto;
};
const itemOf = async (c: Client, key: string): Promise<AttentionItemDto | undefined> =>
  (await attention(c)).items.find((i) => i.key === key);
const overview = async (c: Client) => {
  const r = await c.get('/api/v1/management/overview');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as OverviewDto;
};

// ─────────────────── F10-11/F10-13o e F10-12 — confirmação e pagamentos ───────────────────

const H = (token: string) => ({ 'x-earnings-unlock': token });
async function tok(c: Client, pin: string) {
  const r = await post(c, F('/my-earnings/unlock'), { pin });
  if (r.status !== 200) throw new Error(`unlock: ${JSON.stringify(r.body)}`);
  return r.body.unlockToken as string;
}
async function confirmOwn(c: Client, pin: string) {
  const t = await tok(c, pin);
  const e = (await c.req('GET', F('/my-earnings'), undefined, H(t))).body;
  const r = await c.req(
    'POST',
    F('/my-earnings/confirm'),
    { week: WEEK, hash: e.confirmation.currentHash, confirm: true },
    { ...H(t), 'idempotency-key': crypto.randomUUID() },
  );
  if (r.status !== 200) throw new Error(`confirm: ${JSON.stringify(r.body)}`);
}
const payDirect = async (admin: Client, id: string, amountCents: number) =>
  post(admin, F(`/labor/${id}/payments`), {
    amountCents,
    paidAt: today(),
    method: 'PIX',
    version: (await row(id)).version,
  });
const confKey = (userId: string) => `FINANCEIRO:confirmacao:${userId}`;
const payKey = (userId: string) => `FINANCEIRO:pagamento:${userId}`;

/** Ricardo com R$ 1.000 liberado (DEVIDO); Márcio com R$ 450 previsto. */
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
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  return { s, ric, mar };
}

describe('F10-11/F10-13o — fechamentos aguardando confirmação', () => {
  it('devido sem confirmação aparece; confirmação válida some; mudança reabre; nova confirmação some', async () => {
    const { s, ric } = await base();
    // Só previsto: nada a confirmar ainda.
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeUndefined();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    let it = await itemOf(s.admin, confKey(s.ids.ricardo));
    expect(it).toMatchObject({
      type: 'FINANCEIRO',
      category: 'ATENCAO',
      status: 'SEM_CONFIRMACAO',
      statusLabel: 'Sem confirmação',
      employee: { userId: s.ids.ricardo, displayName: 'Ricardo' },
      link: `/painel/financeiro?tab=fechamento&semana=${WEEK}&profissional=${s.ids.ricardo}`,
    });
    // Previsto do Márcio não pede confirmação.
    expect(await itemOf(s.admin, confKey(s.ids.marcio))).toBeUndefined();
    await confirmOwn(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeUndefined();
    // D13 integral: qualquer mudança invalida a confirmação inteira — volta a pedir.
    expect((await adjust(s.admin, ric.id, 5000, 'Ajuste depois da conferência')).status).toBe(200);
    it = await itemOf(s.admin, confKey(s.ids.ricardo));
    expect(it).toMatchObject({ status: 'DESATUALIZADA', statusLabel: 'Confirmação desatualizada' });
    // A confirmação antiga (inválida) continua no histórico e não conta.
    expect(await db().weeklyClosingConfirmation.count()).toBe(1);
    await confirmOwn(s.tablets.Ricardo!, PINS.Ricardo!);
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeUndefined();
  });

  it('outra pessoa e outra semana não interferem; exceção administrativa não finge confirmação', async () => {
    const { s } = await base();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await finish(s.tablets['Márcio']!, s.poltronaTask.id);
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeDefined();
    expect(await itemOf(s.admin, confKey(s.ids.marcio))).toBeDefined();
    // Confirmação do Márcio não resolve o Ricardo.
    await confirmOwn(s.tablets['Márcio']!, PINS['Márcio']!);
    expect(await itemOf(s.admin, confKey(s.ids.marcio))).toBeUndefined();
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeDefined();
    // Retrato da semana passada (mesmo hash de hoje) não vale para a semana corrente.
    const e = (await s.admin.get(F(`/weekly-closings/${WEEK}`))).body;
    const ricRow = e.rows.find(
      (r: { beneficiary: { userId: string } }) => r.beneficiary.userId === s.ids.ricardo,
    );
    await db().weeklyClosingConfirmation.create({
      data: {
        beneficiaryUserId: s.ids.ricardo,
        weekStart: new Date(`${LAST_WEEK}T00:00:00Z`),
        kind: 'PROFISSIONAL',
        items: [],
        totalCents: 0,
        hash: ricRow.confirmation.currentHash,
      },
    });
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeDefined();
    // Exceção administrativa: sai de "aguardando confirmação", mas o estado é a exceção.
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    expect(await itemOf(s.admin, confKey(s.ids.ricardo))).toBeUndefined();
    const after = (await s.admin.get(F(`/weekly-closings/${WEEK}`))).body;
    const ric = after.rows.find(
      (r: { beneficiary: { userId: string } }) => r.beneficiary.userId === s.ids.ricardo,
    );
    expect(ric.confirmation.state).toBe('LIBERADA_POR_EXCECAO');
  });

  it('privacidade e permissões: sem valores; sem financeiro não aparece; tablet 403', async () => {
    const { s } = await base();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const it = await itemOf(s.admin, confKey(s.ids.ricardo));
    expect(moneyKeys(it)).toEqual([]);
    expect(JSON.stringify(it)).not.toMatch(/100000|1\.000/);
    const central = await panelUserWith(app, s.admin, 'central', ['ocorrencias.ver']);
    const a = await attention(central);
    expect(a.items.some((i) => i.type === 'FINANCEIRO')).toBe(false);
    const fin = await panelUserWith(app, s.admin, 'fin', ['ocorrencias.ver', 'financeiro.ver']);
    expect(await itemOf(fin, confKey(s.ids.ricardo))).toBeDefined();
    // O link abre o fechamento da semana para quem vê o financeiro.
    expect((await fin.get(F(`/weekly-closings/${WEEK}`))).status).toBe(200);
    expect((await s.tablets.Ricardo!.get('/api/v1/attention')).status).toBe(403);
  });
});

describe('F10-12 — pagamentos disponíveis', () => {
  it('previsto não; devido sem confirmação não; confirmado sim; parcial continua; total some; estorno volta', async () => {
    const { s, ric } = await base();
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeUndefined();
    expect(await itemOf(s.admin, payKey(s.ids.marcio))).toBeUndefined();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    // DEVIDO, mas sem confirmação válida: bloqueado pelo D13 → não disponível.
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeUndefined();
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(422);
    await confirmOwn(s.tablets.Ricardo!, PINS.Ricardo!);
    let it = await itemOf(s.admin, payKey(s.ids.ricardo));
    expect(it).toMatchObject({
      type: 'FINANCEIRO',
      category: 'ACAO',
      status: 'DISPONIVEL',
      link: `/painel/financeiro?tab=fechamento&semana=${WEEK}&profissional=${s.ids.ricardo}`,
    });
    expect(it!.title).toMatch(/1 pagamento\(s\)/);
    expect(moneyKeys(it)).toEqual([]);
    // Pagamento parcial: continua disponível pelo saldo.
    expect((await payDirect(s.admin, ric.id, 40000)).status).toBe(200);
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeDefined();
    // Quitado: some.
    const paid = await payDirect(s.admin, ric.id, 60000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeUndefined();
    // Estorno do último pagamento: o saldo devido existe de novo e a confirmação continua a
    // valer (pagamentos não fazem parte do retrato) → volta a ficar disponível.
    const last = await db().professionalPayment.findFirstOrThrow({
      where: { productionPayableId: ric.id, amountCents: 60000 },
    });
    const rev = await post(s.admin, F(`/labor/${ric.id}/payments/${last.id}/reverse`), {
      reason: 'Pix devolvido pelo banco',
      version: (await row(ric.id)).version,
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    it = await itemOf(s.admin, payKey(s.ids.ricardo));
    expect(it).toBeDefined();
  });

  it('exceção administrativa coerente com o D13; mudança posterior bloqueia de novo', async () => {
    const { s, ric } = await base();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeDefined();
    // Valor mudou depois da exceção: a linha antiga não cobre (D13) → não disponível.
    expect((await adjust(s.admin, ric.id, 3000, 'Ajuste após a exceção')).status).toBe(200);
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeUndefined();
    expect((await payDirect(s.admin, ric.id, 1000)).status).toBe(422);
  });

  it('permissões: sem financeiro não aparece', async () => {
    const { s } = await base();
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await confirmOwn(s.tablets.Ricardo!, PINS.Ricardo!);
    const ops = await panelUserWith(app, s.admin, 'operacao', ['ocorrencias.ver', 'os.ver']);
    expect(await itemOf(ops, payKey(s.ids.ricardo))).toBeUndefined();
    expect(await itemOf(s.admin, payKey(s.ids.ricardo))).toBeDefined();
  });
});

// ─────────────────────────── F10-21s — valores pagos ───────────────────────────

describe('F10-21s — valores pagos (Pago na semana do Fechamento)', () => {
  const closingPaid = async (c: Client, week = WEEK) =>
    (await c.get(F(`/weekly-closings/${week}`))).body.totals.paidInWeekCents as number;

  it('nada pago → 0; parcial; total; estorno; igual ao Fechamento; semana anterior separada', async () => {
    const { s, ric } = await base();
    let o = await overview(s.admin);
    expect(o.finance!.paid).toEqual({ weekStart: WEEK, paidInWeekCents: 0 });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    await confirmOwn(s.tablets.Ricardo!, PINS.Ricardo!);
    expect((await overview(s.admin)).finance!.paid.paidInWeekCents).toBe(0);
    expect((await payDirect(s.admin, ric.id, 40000)).status).toBe(200);
    o = await overview(s.admin);
    expect(o.finance!.paid.paidInWeekCents).toBe(40000);
    expect(o.finance!.paid.paidInWeekCents).toBe(await closingPaid(s.admin));
    expect((await payDirect(s.admin, ric.id, 60000)).status).toBe(200);
    expect((await overview(s.admin)).finance!.paid.paidInWeekCents).toBe(100000);
    const last = await db().professionalPayment.findFirstOrThrow({
      where: { productionPayableId: ric.id, amountCents: 60000 },
    });
    await post(s.admin, F(`/labor/${ric.id}/payments/${last.id}/reverse`), {
      reason: 'Pix devolvido',
      version: (await row(ric.id)).version,
    });
    o = await overview(s.admin);
    expect(o.finance!.paid.paidInWeekCents).toBe(40000);
    expect(o.finance!.paid.paidInWeekCents).toBe(await closingPaid(s.admin));
    // O previsto do Márcio (R$ 450) nunca entra; a semana anterior não tem pagamento.
    expect(await closingPaid(s.admin, LAST_WEEK)).toBe(0);
  });

  it('sem permissão financeira: seção nula (nunca zero enganoso)', async () => {
    const { s } = await base();
    const ops = await panelUserWith(app, s.admin, 'operacao', ['os.ver']);
    const o = await overview(ops);
    expect(o.finance).toBeNull();
    expect(JSON.stringify(o)).not.toMatch(/paidInWeekCents/);
  });
});

// ─────────────────────────── F10-21m — entregues ───────────────────────────

describe('F10-21m — entregues hoje (peças, regra canônica da Fase 8)', () => {
  beforeEach(() => setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ)));
  const delivered = async (c: Client) => (await overview(c)).deliveries!.deliveredToday;

  it('entrega real conta por peça; parcial só as entregues; marcada no destino sem concluir não', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    expect(await delivered(s.admin)).toBe(0);
    const d = (await k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] })).body;
    expect(await delivered(s.admin)).toBe(0); // agendada
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    expect(await delivered(s.admin)).toBe(0); // saiu e chegou, sem conclusão
    const marked = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [
        { serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' },
        {
          serviceOrderItemId: s.poltronas.id,
          status: 'NAO_ENTREGUE',
          note: 'Cliente pediu depois',
        },
      ],
      version: v,
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(await delivered(s.admin)).toBe(0); // marcada no destino, ainda não concluída
    const done = await post(andre, `/api/v1/deliveries/${d.id}/complete`, {
      version: marked.body.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Parcial: só a peça entregue conta.
    expect(await delivered(s.admin)).toBe(1);
  });

  it('tentativa frustrada não conta', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const andre = await k.andreTablet(s);
    const f = (await k.schedule(s)).body;
    const fv = await k.toDestination(andre, f);
    const fr = await post(andre, `/api/v1/deliveries/${f.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Ninguém em casa',
      version: fv,
    });
    expect(fr.status, JSON.stringify(fr.body)).toBe(200);
    expect(await delivered(s.admin)).toBe(0);
  });

  it('entrega cancelada não conta', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const c = (await k.schedule(s)).body;
    const cancel = await post(s.admin, `/api/v1/deliveries/${c.id}/cancel`, {
      reason: 'Cliente remarcou',
      version: c.version,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(await delivered(s.admin)).toBe(0);
  });

  it('várias peças na mesma entrega contam uma a uma', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    await k.ready(s, 'poltronas');
    const andre = await k.andreTablet(s);
    const d = (await k.schedule(s, { itemIds: [s.sofa.id, s.poltronas.id] })).body;
    const v = await k.toDestination(andre, d);
    const marked = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [
        { serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' },
        { serviceOrderItemId: s.poltronas.id, status: 'ENTREGUE' },
      ],
      version: v,
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(
      (await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: marked.body.version }))
        .status,
    ).toBe(200);
    expect(await delivered(s.admin)).toBe(2);
  });

  it('período = dia da oficina (fuso): 23h30 de ontem não conta; 00h30 e 23h59 de hoje contam', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const marked = await post(andre, `/api/v1/deliveries/${d.id}/items`, {
      items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
      version: v,
    });
    await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: marked.body.version });
    const setCompleted = (iso: string, hhmm: string) =>
      db().delivery.update({
        where: { id: d.id },
        data: { completedAt: zonedDateTime(iso, hhmm, TZ) },
      });
    await setCompleted(day(-1), '23:30'); // 02:30 UTC de hoje
    expect(await delivered(s.admin)).toBe(0);
    await setCompleted(today(), '00:30'); // 03:30 UTC de hoje
    expect(await delivered(s.admin)).toBe(1);
    await setCompleted(today(), '23:59'); // 02:59 UTC de amanhã
    expect(await delivered(s.admin)).toBe(1);
    await setCompleted(day(1), '00:01');
    expect(await delivered(s.admin)).toBe(0);
  });

  it('sem permissão de entregas: seção nula', async () => {
    const admin = await loginAdmin(app);
    const ops = await panelUserWith(app, admin, 'operacao', ['os.ver']);
    expect((await overview(ops)).deliveries).toBeNull();
    const dl = await panelUserWith(app, admin, 'entregas', ['entregas.ver']);
    expect((await overview(dl)).deliveries).toMatchObject({ deliveredToday: 0 });
  });
});
