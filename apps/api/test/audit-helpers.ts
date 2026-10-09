import { zonedDateTime } from '@cenario/shared';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { db, idemKey, loginAdmin } from './helpers';
import { openServiceOrder } from './measurement-helpers';
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

/** Fase 12 — cenário compartilhado pelas auditorias: OS publicada e os quatro tablets. */
export const TZ = 'America/Sao_Paulo';
export const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};
export const setClock = (hhmm: string) =>
  setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));
export const post = (
  c: Client,
  path: string,
  body: Record<string, unknown> = {},
  key = idemKey(),
) => c.post(path, body, { 'idempotency-key': key });

export async function prepareCompany() {
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
}

/**
 * OS (sofá + poltronas) publicada: sofá → Ricardo, poltronas → Márcio, preparação → João;
 * tablets do Ricardo, Márcio, João e Thiago; todos chegaram; relógio às 09:00.
 */
export async function workshop(app: App, name = 'Cliente Auditoria') {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(admin, name);
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
  const prep = await task({
    activity: 'PREPARACAO',
    title: 'Preparação das poltronas',
    serviceOrderItemId: poltronas.id,
    role: 'APOIO',
    assigneeUserId: ids.joao,
  });
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
  for (const n of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    tablets[n] = await tabletOf(app, admin, n, PINS[n]!);
  setClock('08:30');
  for (const n of Object.keys(tablets)) {
    const r = await post(tablets[n]!, '/api/v1/attendance/me/arrive');
    if (r.status !== 200) throw new Error(`arrive ${n}: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  return { admin, so, sofa, poltronas, ids, tablets, prep, sofaTask, poltronaTask, plan };
}

export async function finish(c: Client, taskId: string) {
  const s = await act(c, taskId, 'start');
  if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
  const r = await act(c, taskId, 'complete', { note: 'Serviço concluído' });
  if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
}

/** Thiago confere tudo como conforme e aprova (ou reprova com um defeito). */
export async function decideInspection(thiago: Client, itemId: string, reject?: string) {
  const open = await db().qualityInspection.findFirstOrThrow({
    where: { serviceOrderItemId: itemId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
  });
  let i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  for (const [n, it] of (i.items as { id: string }[]).entries()) {
    const r = await thiago.put(`/api/v1/quality/inspections/${i.id}/items/${it.id}`, {
      result: reject && n === 0 ? 'NAO_CONFORME' : 'OK',
      note: reject && n === 0 ? reject : null,
    });
    if (r.status !== 200) throw new Error(`check: ${JSON.stringify(r.body)}`);
  }
  i = (await thiago.get(`/api/v1/quality/inspections/${open.id}`)).body;
  const r = reject
    ? await post(thiago, `/api/v1/quality/inspections/${i.id}/reject`, {
        reason: reject,
        version: i.version,
      })
    : await post(thiago, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version });
  if (r.status !== 200) throw new Error(`decide: ${JSON.stringify(r.body)}`);
  return r.body;
}
