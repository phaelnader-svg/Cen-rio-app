import type { App } from '../src/app';
import type { Client } from './helpers';
import { db, idemKey, loginAdmin, setupTablet } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, addOs, createPlan, day, publish, tabletOf, userIdOf } from './production-helpers';

/**
 * Fase 8 (plano principal) — cenário de qualidade e entrega reutilizável (mesmo desenho do
 * quality.test.ts): OS com sofá (Ricardo) e poltronas (Márcio); Thiago inspeciona; João embala;
 * André entrega. Dados fictícios.
 */
export const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
  André: '640218',
};
export const post = (
  c: Client,
  path: string,
  body: Record<string, unknown> = {},
  key = idemKey(),
) => c.post(path, body, { 'idempotency-key': key });

export type Insp = {
  id: string;
  status: string;
  round: number;
  reason: string;
  version: number;
  items: { id: string; label: string }[];
};

export function qualityKit(getApp: () => App) {
  async function scenario() {
    const app = getApp();
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Fase 8');
    const ids = {
      ricardo: await userIdOf('Ricardo'),
      marcio: await userIdOf('Márcio'),
      joao: await userIdOf('João'),
      thiago: await userIdOf('Thiago'),
      andre: await userIdOf('André'),
      gestor: (await admin.get('/api/auth/me')).body.user.id as string,
    };
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ids.ricardo,
        date: day(-1),
      })
    ).body as { tasks: { id: string; serviceOrder: { id: string } }[] };
    for (const t of added.tasks.filter((x) => x.serviceOrder.id === so.id))
      await post(admin, `/api/v1/production-tasks/${t.id}/cancel`, { reason: 'Fora do teste' });
    const task = async (body: Record<string, unknown>) => {
      const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        date: day(-1),
        time: '08:00',
        ...body,
      });
      if (r.status !== 201) throw new Error(`task: ${JSON.stringify(r.body)}`);
      return r.body as { id: string; version: number };
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
    const tablets: Record<string, Client> = {};
    for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
      tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
    return { admin, so, sofa, poltronas, ids, tablets, sofaTask, poltronaTask, plan, task };
  }
  type S = Awaited<ReturnType<typeof scenario>>;

  async function finish(c: Client, taskId: string, note = 'Serviço concluído') {
    const s = await act(c, taskId, 'start');
    if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
    const r = await act(c, taskId, 'complete', { note });
    if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const inspection = async (c: Client, id: string) =>
    (await c.get(`/api/v1/quality/inspections/${id}`)).body as Insp;
  const openOf = (itemId: string) =>
    db().qualityInspection.findFirst({
      where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    });
  const stage = async (itemId: string) =>
    (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: itemId } })).fulfillmentStage;

  async function checkAll(c: Client, id: string, bad: string | null = null) {
    const i = await inspection(c, id);
    for (const [n, it] of i.items.entries()) {
      const r = await c.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
        result: bad && n === 0 ? 'NAO_CONFORME' : 'OK',
        note: bad && n === 0 ? bad : null,
      });
      if (r.status !== 200) throw new Error(`check: ${JSON.stringify(r.body)}`);
    }
    return inspection(c, id);
  }
  async function approveOpen(s: S, itemId: string) {
    const open = (await openOf(itemId))!;
    const i = await checkAll(s.tablets.Thiago!, open.id);
    const r = await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i.id}/approve`, {
      version: i.version,
    });
    if (r.status !== 200) throw new Error(`approve: ${JSON.stringify(r.body)}`);
    return r.body as Insp;
  }
  async function pack(s: S, itemId: string) {
    const p = (await db().packagingRecord.findFirst({
      where: { serviceOrderItemId: itemId },
      orderBy: { createdAt: 'desc' },
    }))!;
    const loc = await db().itemLocation.findUniqueOrThrow({ where: { key: 'EXPEDICAO' } });
    const r = await post(s.admin, `/api/v1/packaging/${p.id}/complete`, {
      protection: 'PLASTICO_BOLHA',
      locationId: loc.id,
      version: p.version,
    });
    if (r.status !== 200) throw new Error(`pack: ${JSON.stringify(r.body)}`);
  }
  /** Peça produzida, aprovada e embalada → pronta para entrega. */
  async function ready(s: S, which: 'sofa' | 'poltronas') {
    const item = which === 'sofa' ? s.sofa : s.poltronas;
    const t = which === 'sofa' ? s.sofaTask : s.poltronaTask;
    await finish(which === 'sofa' ? s.tablets.Ricardo! : s.tablets.Márcio!, t.id);
    await approveOpen(s, item.id);
    await pack(s, item.id);
  }
  const customerOf = async (s: S) =>
    (await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } })).customerId;
  async function schedule(s: S, body: Record<string, unknown> = {}) {
    return post(s.admin, '/api/v1/deliveries', {
      customerId: await customerOf(s),
      scheduledDate: day(1),
      windowStart: '09:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      ...body,
    });
  }
  async function andreTablet(s: S) {
    return (
      await setupTablet(getApp(), s.admin, {
        name: 'Celular André',
        employee: 'André',
        pin: PINS.André!,
      })
    ).tablet;
  }
  /** Saída + chegada; devolve a versão atual. */
  async function toDestination(c: Client, d: { id: string; version: number }) {
    const dep = await post(c, `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
    if (dep.status !== 200) throw new Error(`depart: ${JSON.stringify(dep.body)}`);
    const arr = await post(c, `/api/v1/deliveries/${d.id}/arrive`, { version: dep.body.version });
    if (arr.status !== 200) throw new Error(`arrive: ${JSON.stringify(arr.body)}`);
    return arr.body.version as number;
  }
  return {
    scenario,
    finish,
    inspection,
    openOf,
    stage,
    checkAll,
    approveOpen,
    pack,
    ready,
    customerOf,
    schedule,
    andreTablet,
    toDestination,
  };
}
