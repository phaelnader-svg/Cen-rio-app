import { zonedDateTime } from '@cenario/shared';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { db, idemKey, loginAdmin } from './helpers';
import {
  addOs,
  assign,
  createPlan,
  day,
  publish,
  serviceOrderWith,
  sofaTask,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';

/** Fase 7 (Simplificação): cenário comum de presença e apoio. Relógio operacional fixo. */
export const TZ = 'America/Sao_Paulo';
export const at = (hhmm: string, date = today()) => zonedDateTime(date, hhmm, TZ);
export const setClock = (hhmm: string, date = today()) => setAttendanceClock(() => at(hhmm, date));

export const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
};

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

export type T = {
  id: string;
  code: string;
  activity: string;
  status: string;
  version: number;
  scheduledAt: string | null;
  assignee: { userId: string } | null;
  supportFor: { id: string } | null;
};

export const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
export const arrive = (c: Client) => post(c, '/api/v1/attendance/me/arrive');
export const depart = (c: Client, body: unknown = {}) =>
  post(c, '/api/v1/attendance/me/depart', body);
export const attendanceAction = (admin: Client, body: Record<string, unknown>) =>
  admin.post('/api/v1/attendance/actions', { date: today(), ...body });
export const ask = (c: Client, body: Record<string, unknown>, key = idemKey()) =>
  post(c, '/api/v1/help-requests', body, key);
export const notices = async (userId: string, kind?: string) =>
  db().notification.findMany({
    where: { userId, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: 'asc' },
  });

/**
 * Sofá publicado (materiais completos): Ricardo é o principal (corte de tecido liberado);
 * João tem desmontagem e preparação; Márcio um revestimento e Thiago uma cabeceira, liberados.
 * Quem estiver em `arrive` confirma chegada às 8h30; o relógio fica em 9h.
 */
export async function scenario(app: App, opts: { arrive?: string[] } = {}) {
  const arriving = opts.arrive ?? ['Ricardo', 'João', 'Thiago'];
  const admin = await loginAdmin(app);
  const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Presença e Apoio');
  const ids = {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
  // Titular da peça (regra canônica da R1): Ricardo, o principal do sofá.
  const own = await admin.req(
    'PUT',
    `/api/v1/service-order-items/${so.items[0].id}/upholsterer`,
    { userId: ids.ricardo, expectedUserId: null },
    { 'idempotency-key': idemKey() },
  );
  if (own.status !== 200) throw new Error(`titular: ${JSON.stringify(own.body)}`);
  const plan = await createPlan(admin);
  const added = (
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: ids.ricardo,
      date: day(-1),
    })
  ).body;
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added, so.items[0].id, a), ids.joao);
  const extra = async (body: Record<string, unknown>) => {
    const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      date: day(-1),
      time: '08:00',
      ...body,
    });
    if (r.status !== 201) throw new Error(`extra: ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const marcioTask = await extra({
    activity: 'REVESTIMENTO',
    title: 'Revestimento do braço',
    assigneeUserId: ids.marcio,
  });
  const thiagoTask = await extra({
    activity: 'OUTRA',
    title: 'Cabeceira estofada',
    assigneeUserId: ids.thiago,
  });
  const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
  const published = await publish(admin, draft);
  const t = (a: string) => sofaTask(published, so.items[0].id, a) as unknown as T;
  const tablets: Record<string, Client> = {};
  for (const name of ['Ricardo', 'Márcio', 'João', 'Thiago'])
    tablets[name] = await tabletOf(app, admin, name, PINS[name]!);
  setClock('08:30');
  for (const name of arriving) {
    const r = await arrive(tablets[name]!);
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  const reload = async (id: string) =>
    (await admin.get(`/api/v1/production-tasks/${id}`)).body as T;
  return {
    admin,
    so,
    plan,
    ids,
    t,
    main: t('CORTE_TECIDO'),
    marcioTask: await reload(marcioTask.id),
    thiagoTask: await reload(thiagoTask.id),
    tablets,
    reload,
  };
}
