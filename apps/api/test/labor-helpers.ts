import { closingWeekStart, zonedDateTime } from '@cenario/shared';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { db, employeeByName, idemKey, loginAdmin } from './helpers';
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

/** R1: cenário e utilitários comuns dos testes de mão de obra e de "Meus Ganhos". */
export const TZ = 'America/Sao_Paulo';
export const setClock = (hhmm: string) =>
  setAttendanceClock(() => zonedDateTime(today(), hhmm, TZ));

export const PINS: Record<string, string> = {
  Ricardo: '482915',
  Márcio: '736152',
  Thiago: '271828',
  João: '121212',
  André: '505050',
  Izaías: '606060',
};
export const F = (path: string) => `/api/v1/finance${path}`;
export const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
export const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });

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

export type Scenario = {
  admin: Client;
  so: { id: string; items: { id: string }[] };
  sofa: { id: string };
  poltronas: { id: string };
  ids: { ricardo: string; marcio: string; joao: string; thiago: string };
  tablets: Record<string, Client>;
  sofaTask: { id: string };
  poltronaTask: { id: string };
};

/** OS publicada (sofá do Ricardo, poltronas do Márcio); quem está em `arrive` chegou; 09:00. */
export async function scenario(
  app: App,
  opts: { owners?: boolean; arrive?: string[] } = {},
): Promise<Scenario> {
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
      date: today(),
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
  for (const name of opts.arrive ?? Object.keys(tablets)) {
    const r = await post(tablets[name]!, '/api/v1/attendance/me/arrive');
    if (r.status !== 200) throw new Error(`arrive: ${JSON.stringify(r.body)}`);
  }
  setClock('09:00');
  return { admin, so, sofa, poltronas, ids, tablets, sofaTask, poltronaTask };
}

export async function setOwner(
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

export async function labor(admin: Client, body: Record<string, unknown>, key = idemKey()) {
  const r = await post(
    admin,
    F('/labor'),
    { service: 'Reforma completa do sofá', agreedCents: 80000, ...body },
    key,
  );
  if (r.status !== 201) throw new Error(`labor: ${JSON.stringify(r.body)}`);
  return r.body as { id: string; code: string; version: number };
}

/** Conclui a tarefa pelo tablet (libera a mão de obra com condição "produção concluída"). */
export async function finish(c: Client, taskId: string) {
  const s = await act(c, taskId, 'start');
  if (s.status !== 200) throw new Error(`start: ${JSON.stringify(s.body)}`);
  const r = await act(c, taskId, 'complete', { note: 'Serviço concluído' });
  if (r.status !== 200) throw new Error(`complete: ${JSON.stringify(r.body)}`);
}

export const row = (id: string) => db().productionPayable.findUniqueOrThrow({ where: { id } });

/**
 * R2 (D13): libera a semana por exceção administrativa (motivo registrado) — usado pelos testes
 * que não tratam da confirmação do profissional, para pagar como antes.
 */
export async function allowWeek(
  admin: Client,
  userId: string,
  weekStart: string,
  itemIds?: string[],
) {
  const r = await post(admin, F(`/weekly-closings/${weekStart}/exceptions`), {
    beneficiaryUserId: userId,
    reason: 'Teste: liberação administrativa',
    ...(itemIds ? { itemIds } : {}),
  });
  if (r.status !== 201) throw new Error(`exceção: ${JSON.stringify(r.body)}`);
  return r.body as { code: string };
}

export async function pay(admin: Client, id: string, amountCents: number, paidAt = today()) {
  const p = await row(id);
  await allowWeek(admin, p.professionalUserId, closingWeekStart(paidAt));
  const r = await post(admin, F(`/labor/${id}/payments`), {
    amountCents,
    paidAt,
    method: 'PIX',
    version: (await row(id)).version,
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`pay: ${JSON.stringify(r.body)}`);
  return r.body as { paymentId?: string };
}

export async function adjust(admin: Client, id: string, amountCents: number, reason: string) {
  return post(admin, F(`/labor/${id}/adjustments`), {
    amountCents,
    reason,
    version: (await row(id)).version,
  });
}

/** Ausência confirmada do Ricardo e a proposta com a alternativa de trocar o principal. */
export async function absenceProposal(s: Scenario) {
  const ricardo = await employeeByName('Ricardo');
  const r = await s.admin.post('/api/v1/attendance/actions', {
    date: today(),
    employeeId: ricardo.id,
    action: 'CONFIRMAR_AUSENCIA',
    reason: 'Consulta médica',
  });
  if (r.status !== 200) throw new Error(`absence: ${JSON.stringify(r.body)}`);
  const list = (await s.admin.get('/api/v1/reschedule-proposals?status=PENDENTE')).body as {
    id: string;
    version: number;
    alternatives: { id: string; actions: { taskId: string; toUserId?: string }[] }[];
  }[];
  const p = list.find((x) => x.alternatives.some((a) => a.id === 'TROCAR_PRINCIPAL'));
  if (!p) throw new Error(`sem TROCAR_PRINCIPAL: ${JSON.stringify(list)}`);
  return p;
}

export const changePrincipal = (
  s: Scenario,
  p: Awaited<ReturnType<typeof absenceProposal>>,
  toUserId: string,
  key = idemKey(),
) =>
  post(
    s.admin,
    `/api/v1/reschedule-proposals/${p.id}/adjust`,
    {
      alternativeId: 'TROCAR_PRINCIPAL',
      overrides: p.alternatives
        .find((a) => a.id === 'TROCAR_PRINCIPAL')!
        .actions.map((a) => ({ taskId: a.taskId, toUserId })),
      note: 'Ricardo ausente: Márcio assume o sofá',
      version: p.version,
    },
    key,
  );

/** Chaves com cara de dinheiro (para conferir que nada vaza a quem não deve ver). */
export const moneyKeys = (v: unknown): string[] => {
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
