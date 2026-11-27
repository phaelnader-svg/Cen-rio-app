import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CustomerDto, OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder } from './commercial-helpers';

/**
 * Atendimento do Escritório (2026-11-25): pergunta se ficou tudo certo no dia seguinte à entrega,
 * parabéns de aniversário com desconto, convite para indicar e agradecimento a quem indicou.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock(() => new Date('2026-11-25T15:00:00Z'));
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));
const round = (c: Client) => send(c, 'POST', '/api/v1/office/round', {}).then((r) => ok(r));
const delivered = (customerId: string, iso: string) =>
  db().delivery.create({
    data: {
      customerId,
      addressSnapshot: {},
      scheduledDate: new Date(`${iso.slice(0, 10)}T00:00:00Z`),
      status: 'CONCLUIDA',
      completedAt: new Date(iso),
    },
  });

async function setup() {
  const admin = await loginAdmin(app);
  ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'ATENDIMENTO' }), 201);
  return admin;
}

describe('Atendimento do Escritório', () => {
  it('cadastro guarda o aniversário e quem indicou; recusa data inválida', async () => {
    const admin = await setup();
    const ana = (await createCustomer(admin, {
      name: 'Ana Souza',
      phone: '(12) 99111-0001',
    })) as CustomerDto;
    const bia = ok<CustomerDto>(
      await send(admin, 'POST', '/api/v1/customers', {
        kind: 'PF',
        name: 'Bia Lima',
        phone: '(12) 99111-0002',
        birthDay: 25,
        birthMonth: 11,
        referredById: ana.id,
      }),
      201,
    );
    const got = ok<CustomerDto>(await admin.get(`/api/v1/customers/${bia.id}`));
    expect(got.birthDay).toBe(25);
    expect(got.referredBy).toEqual({ id: ana.id, name: 'Ana Souza' });
    const bad = await send(admin, 'POST', '/api/v1/customers', {
      kind: 'PF',
      name: 'Caio',
      birthDay: 31,
      birthMonth: 2,
    });
    expect(bad.status).toBe(400);
    // Atualizar sem mandar os campos novos não apaga.
    ok(
      await send(admin, 'PUT', `/api/v1/customers/${bia.id}`, {
        kind: 'PF',
        name: 'Bia Lima',
        phone: '(12) 99111-0002',
        version: got.version,
      }),
    );
    const again = ok<CustomerDto>(await admin.get(`/api/v1/customers/${bia.id}`));
    expect(again.birthMonth).toBe(11);
    expect(again.referredBy?.id).toBe(ana.id);
  });

  it('pergunta se ficou tudo certo, pede indicação, dá parabéns e agradece quem indicou', async () => {
    const admin = await setup();
    ok(await send(admin, 'PUT', '/api/v1/office/settings', { customerDiscountPct: 15 }));
    const ana = (await createCustomer(admin, {
      name: 'Ana Souza',
      phone: '(12) 99111-0001',
    })) as CustomerDto & { addresses: { id: string }[] };
    const caio = (await createCustomer(admin, {
      name: 'Caio Reis',
      phone: '(12) 99111-0003',
    })) as CustomerDto & { addresses: { id: string }[] };
    // Bia: aniversário hoje, já fez serviço, indicada pela Ana; fechou o pedido agora.
    const bia = ok<CustomerDto & { addresses: { id: string }[] }>(
      await send(admin, 'POST', '/api/v1/customers', {
        kind: 'PF',
        name: 'Bia Lima',
        phone: '(12) 99111-0002',
        birthDay: 25,
        birthMonth: 11,
        referredById: ana.id,
        addresses: [{ label: 'Casa', street: 'Rua A', number: '1', city: 'Jacareí', state: 'SP' }],
      }),
      201,
    );
    await createOrder(admin, bia);
    await delivered(ana.id, '2026-11-24T18:00:00Z'); // ontem
    await delivered(caio.id, '2026-11-08T18:00:00Z'); // há 17 dias

    await round(admin);
    const p = (await overview(admin)).pending;
    const by = (task: string) => p.filter((x) => x.task === task);
    expect(by('PESQUISA_SATISFACAO').map((x) => x.payload.customerName)).toEqual(['Ana Souza']);
    expect(by('PESQUISA_SATISFACAO')[0]!.detail).toMatch(/ficou tudo do jeito/);
    expect(by('INDICACAO').map((x) => x.payload.customerName)).toEqual(['Caio Reis']);
    expect(by('INDICACAO')[0]!.detail).toMatch(/15% de desconto/);
    expect(by('ANIVERSARIO').map((x) => x.payload.customerName)).toEqual(['Bia Lima']);
    expect(by('ANIVERSARIO')[0]!.detail).toMatch(/Feliz aniversário/);
    expect(by('AGRADECER_INDICACAO').map((x) => x.payload.customerName)).toEqual(['Ana Souza']);
    expect(by('AGRADECER_INDICACAO')[0]!.detail).toMatch(/indicar Bia/);
    // Ontem não pede a avaliação ainda (só a partir do 2º dia).
    expect(by('PEDIR_AVALIACAO')).toHaveLength(0);

    // Rodar de novo não repete.
    await round(admin);
    expect((await overview(admin)).pending.length).toBe(p.length);
  });
});
