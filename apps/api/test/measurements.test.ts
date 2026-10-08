import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  foam,
  gestorUserId,
  nextFriday,
  nextTuesday,
  openServiceOrder,
  tapeceiroTablet,
} from './measurement-helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Medição de rotina (sexta-feira) pelo gestor', () => {
  it('programa, mede por peça, envia e registra na OS — sem iniciar produção', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const me = await gestorUserId();

    const awaiting = await admin.get('/api/v1/measurements/awaiting');
    expect(awaiting.body.map((a: { item: { code: string } }) => a.item.code)).toEqual(
      so.items.map((i) => i.code),
    );

    const wrongDay = await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'ROTINA',
      assigneeUserId: me,
      dueDate: nextTuesday(),
    });
    expect(wrongDay.status).toBe(422);

    const r = await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'ROTINA',
      assigneeUserId: me,
      dueDate: nextFriday(),
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^MD-\d{5}$/);
    expect(r.body.status).toBe('PENDENTE');
    expect(r.body.request.status).toBe('RASCUNHO');
    // Peças com medição programada saem de "aguardando medição".
    expect((await admin.get('/api/v1/measurements/awaiting')).body).toHaveLength(0);

    const sub = await fillAndSubmit(admin, r.body, {
      pieces: [
        {
          serviceOrderItemId: so.items[0].id,
          dimensions: [
            { label: 'Largura', valueCm: 210 },
            { label: 'Profundidade', valueCm: 95 },
          ],
        },
        { serviceOrderItemId: so.items[1].id, dimensions: [{ label: 'Largura', valueCm: 80 }] },
      ],
      items: [
        fabric({ serviceOrderItemId: so.items[0].id, quantity: 12.5 }),
        fabric({
          serviceOrderItemId: so.items[1].id,
          description: 'Suede',
          color: 'Cinza',
          quantity: 6,
        }),
        foam({ serviceOrderItemId: so.items[0].id }),
      ],
    });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('CONCLUIDA');
    expect(sub.body.request.status).toBe('ENVIADA');
    expect(sub.body.items.map((i: { quantity: number }) => i.quantity)).toEqual([12.5, 6, 2]);

    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    expect(os.items[0].measurements).toEqual([
      { label: 'Largura', valueCm: 210 },
      { label: 'Profundidade', valueCm: 95 },
    ]);
    expect(os.items[0].measurementKind).toBe('ROTINA');
    expect(os.readiness.measurements).toBe('OK');
    expect(os.readiness.canStartProduction).toBe(false);
    expect(os.status).toBe('ABERTA');
    const revs = (await admin.get(`/api/v1/service-orders/${so.id}/revisions`)).body;
    expect(revs[0].scope).toBe('MEDICAO');
  });

  it('rotina não pode ser delegada a tapeceiro (só extraordinária)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const { userId } = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const r = await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'ROTINA',
      assigneeUserId: userId,
      dueDate: nextFriday(),
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('extraordinária');
  });
});

describe('Medição extraordinária delegada', () => {
  it('delegada a Ricardo: aparece no tablet dele, só ele executa, envia ao gestor', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const marcio = await tapeceiroTablet(app, admin, 'Márcio', '736152');

    const noReason = await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'EXTRAORDINARIA',
      assigneeUserId: ricardo.userId,
      dueDate: nextTuesday(),
    });
    expect(noReason.status).toBe(400);

    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0].id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'Sofá chegou segunda e precisa começar quarta',
      })
    ).body;
    expect(m.kind).toBe('EXTRAORDINARIA');
    expect(m.reason).toContain('quarta');

    const mine = await ricardo.tablet.get('/api/v1/measurements/mine');
    expect(mine.body.map((x: { id: string }) => x.id)).toEqual([m.id]);
    expect((await marcio.tablet.get('/api/v1/measurements/mine')).body).toEqual([]);
    // Márcio não vê nem altera a medição do Ricardo.
    expect((await marcio.tablet.get(`/api/v1/measurements/${m.id}`)).status).toBe(403);
    const intrude = await marcio.tablet.put(`/api/v1/measurements/${m.id}/draft`, {
      items: [fabric()],
      version: m.version,
    });
    expect(intrude.status).toBe(403);

    // Detalhe no tablet: dados técnicos, sem valores comerciais.
    const detail = await ricardo.tablet.get(`/api/v1/measurements/${m.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.serviceOrderInfo.items).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toMatch(/agreedValue|paymentTerms|350000/);

    const started = await ricardo.tablet.post(`/api/v1/measurements/${m.id}/start`, {
      version: m.version,
    });
    expect(started.body.status).toBe('EM_ANDAMENTO');
    // Peça de outra parte da OS não pode entrar nesta medição.
    const otherPiece = await ricardo.tablet.put(`/api/v1/measurements/${m.id}/draft`, {
      items: [fabric({ serviceOrderItemId: so.items[1].id })],
      version: started.body.version,
    });
    expect(otherPiece.status).toBe(400);
    const sub = await fillAndSubmit(ricardo.tablet, started.body, {
      pieces: [
        { serviceOrderItemId: so.items[0].id, dimensions: [{ label: 'Largura', valueCm: 205.5 }] },
      ],
      items: [fabric({ serviceOrderItemId: so.items[0].id, quantity: 11.75 })],
    });
    expect(sub.status).toBe(200);
    expect(sub.body.request.status).toBe('ENVIADA');
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    expect(os.items[0].measurementKind).toBe('EXTRAORDINARIA');
    expect(os.items[0].measuredBy).toBe('Ricardo');
  });

  it('delegada a Márcio para as poltronas, com espuma dimensionada', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const marcio = await tapeceiroTablet(app, admin, 'Márcio', '736152');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[1].id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: marcio.userId,
        dueDate: nextTuesday(),
        reason: 'Urgência do cliente',
      })
    ).body;
    const sub = await fillAndSubmit(marcio.tablet, m, {
      items: [
        foam({
          serviceOrderItemId: so.items[1].id,
          foamDensity: 'D33',
          thicknessCm: 5,
          quantity: 1,
        }),
      ],
    });
    expect(sub.status).toBe(200);
    expect(sub.body.items[0]).toMatchObject({
      foamDensity: 'D33',
      thicknessCm: 5,
      lengthCm: 200,
      widthCm: 60,
      unit: 'PLACA',
      quantity: 1,
    });
  });

  it('funcionário não autorizado não recebe nem executa medições', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const joao = await db().employee.findFirstOrThrow({ where: { displayName: 'João' } });
    const r = await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'EXTRAORDINARIA',
      assigneeUserId: joao.userId,
      dueDate: nextTuesday(),
      reason: 'Teste',
    });
    expect(r.status).toBe(422);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet João',
      employee: 'João',
      pin: '284619',
    });
    expect((await tablet.get('/api/v1/measurements/mine')).status).toBe(403);
    // Tapeceiro autorizado não pode criar/delegar medições.
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const self = await ricardo.tablet.post(
      '/api/v1/measurements',
      {
        serviceOrderId: so.id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'x',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(self.status).toBe(403);
  });

  it('autorização retirada depois da atribuição bloqueia a execução', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'x',
      })
    ).body;
    const emp = await db().employee.findFirstOrThrow({
      where: { displayName: 'Ricardo' },
      include: { user: { include: { roles: true } } },
    });
    await admin.put(`/api/employees/${emp.id}`, {
      fullName: emp.fullName,
      displayName: emp.displayName,
      jobTitle: emp.jobTitle,
      color: emp.color,
      roleIds: emp.user.roles.map((r) => r.roleId),
      extraPermissions: [],
      version: emp.version,
    });
    expect(
      (
        await ricardo.tablet.put(`/api/v1/measurements/${m.id}/draft`, {
          items: [fabric()],
          version: m.version,
        })
      ).status,
    ).toBe(403);
  });
});

describe('Integridade', () => {
  it('OS inexistente, peça de outra OS e medição duplicada', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente A');
    const other = await openServiceOrder(admin, 'Cliente B');
    const me = await gestorUserId();
    const base = {
      kind: 'EXTRAORDINARIA',
      assigneeUserId: me,
      dueDate: nextTuesday(),
      reason: 'x',
    };
    expect(
      (
        await createMeasurement(admin, {
          ...base,
          serviceOrderId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await createMeasurement(admin, {
          ...base,
          serviceOrderId: so.id,
          serviceOrderItemId: other.items[0].id,
        })
      ).status,
    ).toBe(400);

    // Mesma chave: mesma medição. Chaves diferentes ao mesmo tempo: só uma é criada.
    const key = idemKey();
    const a = await createMeasurement(
      admin,
      { ...base, serviceOrderId: so.id, serviceOrderItemId: so.items[0].id },
      key,
    );
    const b = await createMeasurement(
      admin,
      { ...base, serviceOrderId: so.id, serviceOrderItemId: so.items[0].id },
      key,
    );
    expect(b.body.id).toBe(a.body.id);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        createMeasurement(admin, {
          ...base,
          serviceOrderId: so.id,
          serviceOrderItemId: so.items[1].id,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    // Medição da OS inteira conflita com medição de peça em aberto.
    expect((await createMeasurement(admin, { ...base, serviceOrderId: so.id })).status).toBe(409);
    expect(await db().measurement.count({ where: { serviceOrderId: so.id } })).toBe(2);
  });

  it('unidades, decimais e regras de tecido/espuma', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'ROTINA',
        assigneeUserId: await gestorUserId(),
        dueDate: nextFriday(),
      })
    ).body;
    const save = (items: unknown[]) =>
      admin.put(`/api/v1/measurements/${m.id}/draft`, { items, version: m.version });
    const cases: [unknown, RegExp][] = [
      [fabric({ sourcing: 'ESTOQUE' }), /especificamente/],
      [fabric({ unit: 'PLACA' }), /não é compatível/],
      [fabric({ quantity: -2 }), /maior que zero/],
      [fabric({ quantity: 1.2345 }), /3 casas/],
      [foam({ quantity: 1.5 }), /inteiro/],
      [foam({ foamDensity: null }), /densidade/],
      [foam({ thicknessCm: null }), /espessura/],
      [
        {
          kind: 'OUTRO',
          sourcing: 'ESTOQUE',
          description: 'Grampos',
          quantity: 2.5,
          unit: 'EMBALAGEM',
        },
        /inteiro/,
      ],
    ];
    for (const [item, msg] of cases) {
      const r = await save([item]);
      expect(r.status, JSON.stringify(item)).toBe(400);
      expect(r.body.error.message).toMatch(msg);
    }
    const ok = await save([
      fabric({ quantity: 12.35 }),
      {
        kind: 'OUTRO',
        sourcing: 'ESTOQUE',
        description: 'MDF 15 mm',
        quantity: 1.25,
        unit: 'METRO_QUADRADO',
      },
      {
        kind: 'OUTRO',
        sourcing: 'ESTOQUE',
        description: 'Grampos 80/10',
        quantity: 2,
        unit: 'EMBALAGEM',
      },
    ]);
    expect(ok.status).toBe(200);
    const stored = await db().materialRequestItem.findMany({ orderBy: { position: 'asc' } });
    expect(stored.map((s) => Number(s.quantity))).toEqual([12.35, 1.25, 2]);
    // A restrição do banco também protege (mesmo se a API fosse contornada).
    await expect(
      db().materialRequestItem.update({ where: { id: stored[0]!.id }, data: { unit: 'PLACA' } }),
    ).rejects.toThrow();
  });
});

describe('Revisão, aprovação e devolução', () => {
  async function submitted() {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const ricardo = await tapeceiroTablet(app, admin, 'Ricardo', '482915');
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'EXTRAORDINARIA',
        assigneeUserId: ricardo.userId,
        dueDate: nextTuesday(),
        reason: 'Urgente',
      })
    ).body;
    const sub = await fillAndSubmit(ricardo.tablet, m, {
      items: [
        fabric({ serviceOrderItemId: so.items[0].id }),
        foam({ serviceOrderItemId: so.items[0].id }),
      ],
    });
    return { admin, so, ricardo, m: sub.body };
  }

  it('gestor revisa quantidades com registro do antes/depois e aprova (sem comprar nem iniciar produção)', async () => {
    const { admin, so, ricardo, m } = await submitted();
    const review = await admin.post(`/api/v1/measurements/${m.id}/request/review`, {
      version: m.request.version,
    });
    expect(review.body.request.status).toBe('EM_REVISAO');
    const revised = await admin.put(`/api/v1/measurements/${m.id}/request/items`, {
      items: [
        fabric({ serviceOrderItemId: so.items[0].id, quantity: 13.5 }),
        foam({ serviceOrderItemId: so.items[0].id }),
      ],
      reason: 'Conferido no local: precisa de mais 1,5 m',
      version: review.body.request.version,
    });
    expect(revised.status).toBe(200);
    expect(revised.body.items[0].quantity).toBe(13.5);
    const rev = revised.body.revisions.find((r: { kind: string }) => r.kind === 'REVISADA');
    expect(rev.changes.before[0].quantity).toBe(12);
    expect(rev.changes.after[0].quantity).toBe(13.5);

    // Executor não altera durante a revisão.
    expect(
      (
        await ricardo.tablet.put(`/api/v1/measurements/${m.id}/draft`, {
          items: [fabric()],
          version: revised.body.version,
        })
      ).status,
    ).toBe(422);
    // Aprovação exige permissão.
    expect(
      (
        await ricardo.tablet.post(
          `/api/v1/measurements/${m.id}/request/approve`,
          { version: revised.body.request.version },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
    const viewer = await panelUserWith(app, admin, 'compras', ['materiais.ver']);
    expect(
      (
        await viewer.post(
          `/api/v1/measurements/${m.id}/request/approve`,
          { version: revised.body.request.version },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);

    const key = idemKey();
    const approved = await admin.post(
      `/api/v1/measurements/${m.id}/request/approve`,
      { version: revised.body.request.version },
      { 'idempotency-key': key },
    );
    expect(approved.body.request.status).toBe('APROVADA');
    const again = await admin.post(
      `/api/v1/measurements/${m.id}/request/approve`,
      { version: revised.body.request.version },
      { 'idempotency-key': key },
    );
    expect(again.headers['idempotent-replayed']).toBe('true');

    const needs = await db().materialRequirement.findMany({
      where: { serviceOrderId: so.id, origin: 'SOLICITACAO_APROVADA' },
    });
    expect(needs.map((n) => Number(n.quantity)).sort()).toEqual([13.5, 2]);
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    expect(os.readiness.canStartProduction).toBe(false);
    expect(os.readiness.materials).toBe('FASE_FUTURA');
    // Aprovado não pode ser alterado silenciosamente.
    expect(
      (
        await admin.put(`/api/v1/measurements/${m.id}/request/items`, {
          items: [fabric()],
          reason: 'xxx',
          version: approved.body.request.version,
        })
      ).status,
    ).toBe(422);
    const approvedNeed = os.materials.find(
      (x: { origin: string }) => x.origin === 'SOLICITACAO_APROVADA',
    );
    expect(
      (await admin.del(`/api/v1/service-orders/${so.id}/materials/${approvedNeed.id}`)).status,
    ).toBe(422);
    // Cancelar exige reabrir antes.
    expect(
      (
        await admin.post(`/api/v1/measurements/${m.id}/cancel`, {
          reason: 'teste',
          version: approved.body.version,
        })
      ).status,
    ).toBe(422);

    // Reabrir é explícito e auditado; remove as necessidades aprovadas até nova aprovação.
    const reopened = await admin.post(`/api/v1/measurements/${m.id}/request/reopen`, {
      reason: 'Cliente trocou o tecido',
      version: approved.body.request.version,
    });
    expect(reopened.body.request.status).toBe('EM_REVISAO');
    expect(
      await db().materialRequirement.count({ where: { origin: 'SOLICITACAO_APROVADA' } }),
    ).toBe(0);
    expect(reopened.body.revisions.map((r: { kind: string }) => r.kind)).toEqual(
      expect.arrayContaining([
        'ATRIBUIDA',
        'ENVIADA',
        'EM_REVISAO',
        'REVISADA',
        'APROVADA',
        'REABERTA',
      ]),
    );
    await expect(db().measurementRevision.deleteMany()).rejects.toThrow(/somente inserção/);
  });

  it('devolução para correção: executor corrige e reenvia; histórico preserva as duas versões', async () => {
    const { admin, so, ricardo, m } = await submitted();
    const ret = await admin.post(`/api/v1/measurements/${m.id}/request/return`, {
      reason: 'Faltou a espuma do encosto',
      version: m.request.version,
    });
    expect(ret.body.request.status).toBe('DEVOLVIDA');
    expect(ret.body.status).toBe('EM_ANDAMENTO');

    const mine = (await ricardo.tablet.get(`/api/v1/measurements/${m.id}`)).body;
    expect(mine.returnReason).toBe('Faltou a espuma do encosto');
    expect(mine.can.edit).toBe(true);
    const resub = await fillAndSubmit(ricardo.tablet, mine, {
      items: [
        fabric({ serviceOrderItemId: so.items[0].id }),
        foam({ serviceOrderItemId: so.items[0].id }),
        foam({
          serviceOrderItemId: so.items[0].id,
          description: 'Espuma encosto',
          foamDensity: 'D23',
          thicknessCm: 10,
          quantity: 1,
        }),
      ],
    });
    expect(resub.status).toBe(200);
    expect(resub.body.request.status).toBe('ENVIADA');
    const kinds = resub.body.revisions.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ENVIADA', 'DEVOLVIDA', 'REENVIADA']));
    const first = resub.body.revisions.find((r: { kind: string }) => r.kind === 'ENVIADA');
    const second = resub.body.revisions.find((r: { kind: string }) => r.kind === 'REENVIADA');
    expect(first.changes.items).toHaveLength(2);
    expect(second.changes.items).toHaveLength(3);
  });

  it('decisões simultâneas: aprovar e devolver ao mesmo tempo — só uma vence', async () => {
    const { admin, m } = await submitted();
    const v = m.request.version;
    const [a, b] = await Promise.all([
      admin.post(
        `/api/v1/measurements/${m.id}/request/approve`,
        { version: v },
        { 'idempotency-key': idemKey() },
      ),
      admin.post(`/api/v1/measurements/${m.id}/request/return`, { reason: 'Conferir', version: v }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('rascunho com versão desatualizada é recusado (sem sobrescrever)', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin);
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        kind: 'ROTINA',
        assigneeUserId: await gestorUserId(),
        dueDate: nextFriday(),
      })
    ).body;
    const first = await admin.put(`/api/v1/measurements/${m.id}/draft`, {
      items: [fabric()],
      version: m.version,
    });
    expect(first.status).toBe(200);
    const stale = await admin.put(`/api/v1/measurements/${m.id}/draft`, {
      items: [fabric({ quantity: 1 })],
      version: m.version,
    });
    expect(stale.status).toBe(409);
    expect(Number((await db().materialRequestItem.findFirstOrThrow()).quantity)).toBe(12);
  });
});

describe('Consolidação e planejamento de sexta', () => {
  it('tecidos ficam por OS (mesmo com nomes iguais); comuns de estoque agrupam com origens; CSV', async () => {
    const admin = await loginAdmin(app);
    const me = await gestorUserId();
    const so1 = await openServiceOrder(admin, 'Cliente Um');
    const so2 = await openServiceOrder(admin, 'Cliente Dois');
    for (const [so, qty] of [
      [so1, 12],
      [so2, 8],
    ] as const) {
      const m = (
        await createMeasurement(admin, {
          serviceOrderId: so.id,
          kind: 'ROTINA',
          assigneeUserId: me,
          dueDate: nextFriday(),
        })
      ).body;
      const sub = await fillAndSubmit(admin, m, {
        items: [
          fabric({
            serviceOrderItemId: so.items[0].id,
            description: 'Linho',
            color: 'Bege',
            quantity: qty,
          }),
          fabric({
            serviceOrderItemId: so.items[1].id,
            description: 'Linho',
            color: 'Bege',
            quantity: 1.5,
          }),
          {
            kind: 'OUTRO',
            sourcing: 'ESTOQUE',
            description: 'Grampos 80/10',
            quantity: 1,
            unit: 'EMBALAGEM',
          },
        ],
      });
      await admin.post(
        `/api/v1/measurements/${m.id}/request/approve`,
        { version: sub.body.request.version },
        { 'idempotency-key': idemKey() },
      );
    }
    const list = (await admin.get('/api/v1/materials/consolidated')).body;
    const fabrics = list.lines.filter((l: { kind: string }) => l.kind === 'TECIDO');
    expect(
      fabrics.map((l: { serviceOrder: { code: string }; totalQuantity: number }) => [
        l.serviceOrder.code,
        l.totalQuantity,
      ]),
    ).toEqual([
      [so1.code, 13.5],
      [so2.code, 9.5],
    ]);
    expect(fabrics[0].origins).toHaveLength(2);
    const staples = list.lines.find(
      (l: { description: string }) => l.description === 'Grampos 80/10',
    );
    expect(staples.serviceOrder).toBeNull();
    expect(staples.totalQuantity).toBe(2);
    expect(
      staples.origins.map((o: { serviceOrderCode: string }) => o.serviceOrderCode).sort(),
    ).toEqual([so1.code, so2.code].sort());

    const csv = await app.app.inject({
      method: 'GET',
      url: '/api/v1/materials/consolidated.csv',
      headers: { cookie: admin.cookieHeader },
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain('Tipo;Material;Quantidade;Unidade;Destino;Origens');
    expect(csv.body).toContain(`Linho Bege;13,5;metros;${so1.code}`);
  });

  it('planejamento distingue solicitado × aprovado e não inventa compra/recebimento', async () => {
    const admin = await loginAdmin(app);
    const me = await gestorUserId();
    const so = await openServiceOrder(admin);
    const m = (
      await createMeasurement(admin, {
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0].id,
        kind: 'ROTINA',
        assigneeUserId: me,
        dueDate: nextFriday(),
      })
    ).body;
    await fillAndSubmit(admin, m, { items: [fabric({ serviceOrderItemId: so.items[0].id })] });
    const plan = (await admin.get('/api/v1/materials/planning')).body;
    expect(plan.awaiting.map((a: { item: { code: string } }) => a.item.code)).toEqual([
      so.items[1].code,
    ]);
    expect(plan.awaitingApproval).toHaveLength(1);
    expect(plan.completed).toHaveLength(1);
    expect(plan.materials.requested).toHaveLength(1);
    expect(plan.materials.approved).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toMatch(/COMPRAD|RECEBID/);
    const viewer = await panelUserWith(app, admin, 'semmateriais', ['os.ver']);
    expect((await viewer.get('/api/v1/materials/planning')).status).toBe(403);
    expect((await viewer.get('/api/v1/materials/consolidated')).status).toBe(403);
  });
});
