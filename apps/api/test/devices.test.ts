import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  Client,
  createTestApp,
  db,
  employeeByName,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Cadastro e vinculação de dispositivos', () => {
  it('gestor cadastra tablet e recebe código de uso único (armazenado só como hash)', async () => {
    const admin = await loginAdmin(app);
    const ricardo = await employeeByName('Ricardo');
    const r = await admin.post(
      '/api/devices',
      { name: 'Tablet Ricardo', location: 'Corte', assignedEmployeeId: ricardo.id },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(201);
    expect(r.body.device.status).toBe('PENDING_PAIRING');
    expect(r.body.pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const row = await db().device.findUniqueOrThrow({ where: { id: r.body.device.id } });
    expect(row.pairingCodeHash).not.toContain(r.body.pairing.code.replace('-', ''));
    expect((await admin.get('/api/devices')).body).toHaveLength(1);

    const dup = await admin.post(
      '/api/devices',
      { name: 'Tablet Ricardo' },
      { 'idempotency-key': idemKey() },
    );
    expect(dup.status).toBe(409);
  });

  it('vincula com o código, que não pode ser reutilizado', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.post(
      '/api/devices',
      { name: 'Tablet 1' },
      { 'idempotency-key': idemKey() },
    );
    const tablet = new Client(app);
    expect((await tablet.post('/api/tablet/pair', { code: 'AAAA-BBBB' })).status).toBe(400);
    const ok = await tablet.post('/api/tablet/pair', { code: r.body.pairing.code.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(tablet.cookies.has('cen_dev')).toBe(true);
    const status = await tablet.get('/api/tablet/status');
    expect(status.body.paired).toBe(true);

    const other = new Client(app);
    const reuse = await other.post('/api/tablet/pair', { code: r.body.pairing.code });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('PAIRING_CODE_INVALID');
  });

  it('código de vinculação expirado é recusado', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.post(
      '/api/devices',
      { name: 'Tablet 2' },
      { 'idempotency-key': idemKey() },
    );
    await db().device.update({
      where: { id: r.body.device.id },
      data: { pairingCodeExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await new Client(app).post('/api/tablet/pair', { code: r.body.pairing.code })).status,
    ).toBe(400);
  });

  it('login por PIN só funciona em tablet vinculado', async () => {
    const ricardo = await employeeByName('Ricardo');
    const anon = new Client(app);
    const r = await anon.post('/api/tablet/login', { employeeId: ricardo.id, pin: '482915' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('DEVICE_REQUIRED');
  });

  it('tablet exclusivo aceita apenas o funcionário atribuído e lista só ele', async () => {
    const admin = await loginAdmin(app);
    const marcio = await employeeByName('Márcio');
    await admin.put(`/api/employees/${marcio.id}/pin`, { pin: '736152' });
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    const status = await tablet.get('/api/tablet/status');
    expect(status.body.employees.map((e: { displayName: string }) => e.displayName)).toEqual([
      'Ricardo',
    ]);
    const wrong = await tablet.post('/api/tablet/login', { employeeId: marcio.id, pin: '736152' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('DEVICE_NOT_ALLOWED');
  });

  it('PIN errado repetido bloqueia temporariamente o funcionário', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    await tablet.post('/api/auth/logout');
    for (let i = 0; i < 5; i++) {
      expect(
        (await tablet.post('/api/tablet/login', { employeeId: employee.id, pin: '000111' })).status,
      ).toBe(401);
    }
    const locked = await tablet.post('/api/tablet/login', {
      employeeId: employee.id,
      pin: '482915',
    });
    expect(locked.status).toBe(429);
  });
});

describe('Sessões persistentes e revogação', () => {
  it('sessão do tablet é persistente e vinculada ao dispositivo', async () => {
    const admin = await loginAdmin(app);
    const { tablet, me } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect(me.session.kind).toBe('DEVICE');
    const session = await db().session.findUniqueOrThrow({ where: { id: me.session.id } });
    // Sessão de tablet: expira só por ociosidade (30 dias), renovada a cada uso.
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const sid = tablet.cookies.get('cen_sid')!;
    // "Navegador" novo com o mesmo cookie de sessão, mas SEM a credencial do dispositivo: negado.
    const thief = new Client(app);
    thief.cookies.set('cen_sid', sid);
    expect((await thief.get('/api/auth/me')).status).toBe(401);
    // O próprio tablet continua autenticado em requisições futuras.
    expect((await tablet.get('/api/auth/me')).status).toBe(200);
  });

  it('expiração por ociosidade encerra a sessão', async () => {
    const admin = await loginAdmin(app);
    await db().session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await admin.get('/api/auth/me')).status).toBe(401);
  });

  it('gestor revoga uma sessão remotamente e o tablet perde o acesso na hora', async () => {
    const admin = await loginAdmin(app);
    const { tablet, me } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    const list = await admin.get('/api/sessions');
    expect(list.body.some((s: { id: string }) => s.id === me.session.id)).toBe(true);
    expect((await admin.post(`/api/sessions/${me.session.id}/revoke`)).status).toBe(204);
    expect((await tablet.get('/api/auth/me')).status).toBe(401);
    // o dispositivo continua vinculado: basta digitar o PIN de novo
    expect((await tablet.get('/api/tablet/status')).body.paired).toBe(true);
    const audit = await db().auditLog.findFirst({ where: { action: 'session.revoked' } });
    expect(audit).not.toBeNull();
  });

  it('revogar o dispositivo invalida credencial e todas as sessões; novo código reativa', async () => {
    const admin = await loginAdmin(app);
    const { tablet, device, employee } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect((await admin.post(`/api/devices/${device.id}/revoke`)).status).toBe(200);
    expect((await tablet.get('/api/auth/me')).status).toBe(401);
    expect((await tablet.get('/api/tablet/status')).body.paired).toBe(false);
    const login = await tablet.post('/api/tablet/login', {
      employeeId: employee.id,
      pin: '482915',
    });
    expect(login.status).toBe(403);

    const code = await admin.post(
      `/api/devices/${device.id}/pairing-code`,
      {},
      { 'idempotency-key': idemKey() },
    );
    expect(code.status).toBe(200);
    expect((await tablet.post('/api/tablet/pair', { code: code.body.code })).status).toBe(200);
    expect(
      (await tablet.post('/api/tablet/login', { employeeId: employee.id, pin: '482915' })).status,
    ).toBe(200);
  });

  it('trocar o PIN encerra as sessões de tablet do funcionário', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect((await admin.put(`/api/employees/${employee.id}/pin`, { pin: '591737' })).status).toBe(
      200,
    );
    expect((await tablet.get('/api/auth/me')).status).toBe(401);
  });

  it('nova entrada no mesmo tablet substitui a sessão anterior', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee, me } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
      restrict: false,
    });
    const again = await tablet.post('/api/tablet/login', {
      employeeId: employee.id,
      pin: '482915',
    });
    expect(again.status).toBe(200);
    const old = await db().session.findUniqueOrThrow({ where: { id: me.session.id } });
    expect(old.revokedReason).toBe('replaced');
  });

  it('dispositivo ativo não pode ser excluído sem antes ser revogado', async () => {
    const admin = await loginAdmin(app);
    const { device } = await setupTablet(app, admin, {
      name: 'Tablet T',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect((await admin.del(`/api/devices/${device.id}`)).status).toBe(422);
    await admin.post(`/api/devices/${device.id}/revoke`);
    expect((await admin.del(`/api/devices/${device.id}`)).status).toBe(204);
  });
});
