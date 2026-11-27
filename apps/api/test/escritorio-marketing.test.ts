import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { createCustomer } from './commercial-helpers';

/**
 * Marketing do Escritório (2026-11-25): post de antes e depois do serviço entregue (aprovar = o
 * cliente deixou divulgar) e promoção no mês que costuma ser fraco, para os clientes antigos.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { plan: 'gestao_jogo', tradeName: 'Tapeçaria Teste', phone: '12999990000' },
  });
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

async function photo(entityType: string, entityId: string) {
  const id = randomUUID();
  await db().storedFile.create({
    data: {
      id,
      storageKey: `test/${id}`,
      purpose: 'attachment',
      originalName: 'foto.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: '0'.repeat(64),
    },
  });
  await db().attachment.create({ data: { fileId: id, entityType: entityType as never, entityId } });
  return id;
}

describe('Marketing do Escritório', () => {
  it('post de antes e depois: separa as fotos, não põe o nome do cliente e salva ao aprovar', async () => {
    setClock(() => new Date('2026-11-25T15:00:00Z'));
    const admin = await loginAdmin(app);
    ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'MARKETING' }), 201);
    const so = await openServiceOrder(admin, 'Cliente Sigiloso');
    const items = await db().serviceOrderItem.findMany({ where: { serviceOrderId: so.id } });
    const soRow = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    const d = await db().delivery.create({
      data: {
        customerId: soRow.customerId,
        addressSnapshot: {},
        scheduledDate: new Date('2026-11-24T00:00:00Z'),
        status: 'CONCLUIDA',
        completedAt: new Date('2026-11-24T15:00:00Z'),
      },
    });
    for (const i of items)
      await db().deliveryItem.create({ data: { deliveryId: d.id, serviceOrderItemId: i.id } });
    // Sem a foto do depois, não propõe.
    const before = await photo('SERVICE_ORDER', so.id);
    await round(admin);
    expect(
      (await overview(admin)).pending.filter((x) => x.task === 'POST_ANTES_DEPOIS'),
    ).toHaveLength(0);

    const after = await photo('DELIVERY', d.id);
    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'POST_ANTES_DEPOIS')!;
    expect(p.title).toMatch(/Post de antes e depois da OS-/);
    expect(p.detail).toMatch(/Antes e depois: sofá 3 lugares e poltronas/);
    expect(p.detail).toMatch(/Tapeçaria Teste/);
    expect(p.detail).toMatch(/\(12\) 99999-0000/);
    expect(p.detail).not.toMatch(/Sigiloso/);
    expect((p.payload.photos as { fileId: string }[]).map((f) => f.fileId)).toEqual([
      before,
      after,
    ]);

    const r = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    expect(r.status).toBe('APROVADA');
    const post = await db().marketingPost.findUniqueOrThrow({
      where: { id: String(r.payload.postId) },
    });
    expect(post.status).toBe('RASCUNHO');
    expect(post.mediaUrls).toEqual([`/api/files/${before}`, `/api/files/${after}`]);
    // Não propõe de novo a mesma OS.
    await round(admin);
    expect(
      (await overview(admin)).pending.filter((x) => x.task === 'POST_ANTES_DEPOIS'),
    ).toHaveLength(0);
    const t = (await overview(admin)).agents
      .find((a) => a.roleKey === 'MARKETING')!
      .tasks.find((x) => x.key === 'POST_ANTES_DEPOIS')!;
    expect(t.maxLevel).toBe(2);
  });

  it('mês fraco: com histórico, propõe o desconto para quem não volta há 6 meses', async () => {
    setClock(() => new Date('2027-01-05T15:00:00Z'));
    const admin = await loginAdmin(app);
    ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'MARKETING' }), 201);
    const mk = (name: string, phone: string) =>
      createCustomer(admin, { name, phone }) as Promise<{ id: string }>;
    const ana = await mk('Ana Souza', '(12) 99111-0001');
    const bia = await mk('Bia Lima', '(12) 99111-0002');
    // 2025-01 a 2026-12: janeiro fecha R$ 1.000, os outros meses R$ 5.000.
    for (let k = 0; k < 24; k++) {
      const y = 2025 + Math.floor(k / 12);
      const m = (k % 12) + 1;
      const recent = y === 2026 && m >= 6;
      await db().commercialOrder.create({
        data: {
          customerId: recent ? bia.id : ana.id,
          contractedService: 'Reforma',
          agreedValueCents: m === 1 ? 100_000 : 500_000,
          status: 'AGUARDANDO_RETIRADA',
          createdAt: new Date(`${y}-${String(m).padStart(2, '0')}-10T12:00:00Z`),
        },
      });
    }
    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'PROMOCAO_MES_FRACO')!;
    expect(p.title).toBe('Janeiro costuma ser fraco: promoção de 10% para 1 cliente antigo');
    expect(p.detail).toMatch(/80% a menos/);
    expect((p.payload.recipients as { name: string }[]).map((x) => x.name)).toEqual(['Ana Souza']);

    const r = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    const list = r.payload.sendList as { name: string; href: string }[];
    expect(list).toHaveLength(1);
    const msg = decodeURIComponent(list[0]!.href);
    expect(msg).toMatch(/Olá, Ana! Aqui é da Tapeçaria Teste/);
    expect(msg).toMatch(/10% de desconto nos serviços fechados até 31\/01/);
    expect(msg).not.toMatch(/\{nome\}/);

    // Depois do dia 10 não propõe; e sem histórico de 12 meses também não.
    await db().aiAgentProposal.deleteMany({});
    setClock(() => new Date('2027-01-15T15:00:00Z'));
    await round(admin);
    expect(
      (await overview(admin)).pending.filter((x) => x.task === 'PROMOCAO_MES_FRACO'),
    ).toHaveLength(0);
  });

  it('parceiros: lista quem mandou serviço e prepara a mensagem para quem parou', async () => {
    setClock(() => new Date('2026-11-25T15:00:00Z'));
    const admin = await loginAdmin(app);
    ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey: 'MARKETING' }), 201);
    const mk = (body: Record<string, unknown>) =>
      createCustomer(admin, body) as Promise<{ id: string }>;
    const loja = await mk({ kind: 'PJ', name: 'Casa Bela Móveis', phone: '(12) 99111-0010' });
    const arq = await mk({ name: 'Marina Arquiteta', phone: '(12) 99111-0011' });
    const indicado = await mk({ name: 'Carlos Dias', phone: '(12) 99111-0012' });
    const ativa = await mk({ kind: 'PJ', name: 'Loja Ativa', phone: '(12) 99111-0013' });
    await db().customer.update({ where: { id: indicado.id }, data: { referredById: arq.id } });
    const order = (customerId: string, when: string, cents: number) =>
      db().commercialOrder.create({
        data: {
          customerId,
          contractedService: 'Reforma',
          agreedValueCents: cents,
          status: 'AGUARDANDO_RETIRADA',
          createdAt: new Date(`${when}T12:00:00Z`),
        },
      });
    await order(loja.id, '2026-03-10', 300_000);
    await order(loja.id, '2026-06-10', 200_000);
    await order(indicado.id, '2026-05-02', 150_000);
    await order(ativa.id, '2026-11-01', 100_000);

    await round(admin);
    const p = (await overview(admin)).pending.find((x) => x.task === 'PARCEIROS')!;
    expect(p.title).toBe('Lembrar 2 parceiros que não mandam serviço há 3 meses');
    expect(p.detail).toMatch(/Casa Bela Móveis: 2 serviços/);
    expect(p.detail).toMatch(/Loja Ativa: 1 serviço,/);
    expect((p.payload.recipients as { name: string }[]).map((x) => x.name).sort()).toEqual([
      'Casa Bela Móveis',
      'Marina Arquiteta',
    ]);

    const r = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    const msgs = (r.payload.sendList as { href: string }[]).map((x) => decodeURIComponent(x.href));
    expect(msgs.some((m) => /Olá, Casa Bela Móveis!/.test(m))).toBe(true);
    expect(msgs.some((m) => /Olá, Marina!/.test(m))).toBe(true);
    expect(msgs.join()).toMatch(/10% de desconto/);

    // No mesmo mês não propõe de novo.
    await round(admin);
    expect((await overview(admin)).pending.filter((x) => x.task === 'PARCEIROS')).toHaveLength(0);
  });
});
