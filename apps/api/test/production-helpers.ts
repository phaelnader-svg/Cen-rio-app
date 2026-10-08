import { mondayOf } from '@cenario/shared';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { db, idemKey, setupTablet } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import {
  approvedNeeds,
  confirmedFabricPurchase,
  createSupplier,
  linen,
  ok,
  receive,
} from './purchasing-helpers';

export const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
};
export const today = () => day(0);

export async function userIdOf(name: string) {
  return (await db().employee.findFirstOrThrow({ where: { displayName: name } })).userId;
}

export async function createPlan(admin: Client, weekOf = today()) {
  const r = await admin.post(
    '/api/v1/production-plans',
    { weekStart: mondayOf(weekOf) },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 201) throw new Error(`plan: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function addOs(admin: Client, planId: string, body: Record<string, unknown>) {
  return admin.post(`/api/v1/production-plans/${planId}/items`, body, {
    'idempotency-key': idemKey(),
  });
}

export async function publish(admin: Client, plan: { id: string; version: number }) {
  const r = await admin.post(
    `/api/v1/production-plans/${plan.id}/publish`,
    { version: plan.version, notes: 'Semana fictícia' },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 200) throw new Error(`publish: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** OS de sofá + poltronas; materiais: sem levantamento, aprovados (faltando) ou completos. */
export async function serviceOrderWith(
  admin: Client,
  materials: 'none' | 'missing' | 'complete',
  name = 'Cliente Produção',
) {
  if (materials === 'none') return { so: await openServiceOrder(admin, name), reqs: [] };
  const { so, reqs } = await approvedNeeds(admin, name, (s) => [linen(s.items[0].id)]);
  if (materials === 'complete') {
    const supplier = await createSupplier(admin, `Fornecedor ${name}`);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
  }
  return { so, reqs };
}

export type Task = {
  id: string;
  code: string;
  activity: string;
  status: string;
  blockers: string[];
  version: number;
  assignee: { userId: string } | null;
  serviceOrderItem: { id: string } | null;
  dependsOn: { id: string }[];
};

export const sofaTask = (plan: { tasks: Task[] }, soItemId: string, activity: string) =>
  plan.tasks.find((t) => t.serviceOrderItem?.id === soItemId && t.activity === activity)!;

export async function assign(admin: Client, task: Task, userId: string, reason?: string) {
  const r = await admin.put(`/api/v1/production-tasks/${task.id}`, {
    assigneeUserId: userId,
    version: task.version,
    reason,
  });
  if (r.status !== 200) throw new Error(`assign: ${JSON.stringify(r.body)}`);
  return r.body as Task;
}

export async function tabletOf(app: App, admin: Client, name: string, pin: string) {
  return (await setupTablet(app, admin, { name: `Tablet ${name}`, employee: name, pin })).tablet;
}

export const act = (c: Client, id: string, action: string, body: unknown = {}, key = idemKey()) =>
  c.post(`/api/v1/production-tasks/${id}/${action}`, body, { 'idempotency-key': key });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Envia uma foto (PNG mínimo) como anexo de um registro. */
export async function uploadPhoto(app: App, client: Client, entityType: string, entityId: string) {
  const boundary = '----foto';
  const part = (name: string, value: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const payload = Buffer.concat([
    Buffer.from(part('entityType', entityType) + part('entityId', entityId)),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/attachments',
    headers: {
      origin: 'http://localhost:3000',
      cookie: client.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
