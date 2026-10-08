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
} from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  // Rota usada apenas para provar que erros internos não vazam detalhes.
  app.app.get('/api/__teste/falha', { config: { access: { public: true } } }, async () => {
    throw new Error('detalhe interno: senha do banco=xyz');
  });
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

async function roleId(key: string) {
  return (await db().role.findUniqueOrThrow({ where: { key } })).id;
}

describe('Validação de dados', () => {
  it('rejeita cadastro inválido com erros por campo', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.post(
      '/api/employees',
      { fullName: 'A', displayName: '', jobTitle: 'x', color: 'azul', roleIds: [] },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    const paths = r.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['fullName', 'displayName', 'color', 'roleIds']));
  });

  it('PIN fraco e senha fraca são recusados', async () => {
    const admin = await loginAdmin(app);
    const joao = await employeeByName('João');
    expect((await admin.put(`/api/employees/${joao.id}/pin`, { pin: '123456' })).status).toBe(400);
    expect((await admin.put(`/api/employees/${joao.id}/pin`, { pin: '111111' })).status).toBe(400);
    expect((await admin.put(`/api/employees/${joao.id}/pin`, { pin: '12ab56' })).status).toBe(400);
    const weak = await admin.put(`/api/employees/${joao.id}/admin-access`, {
      email: 'joao@teste.local',
      password: 'curta',
    });
    expect(weak.status).toBe(400);
  });

  it('configurações da empresa validam horários coerentes', async () => {
    const admin = await loginAdmin(app);
    const current = (await admin.get('/api/company/settings')).body;
    const bad = await admin.put('/api/company/settings', { ...current, arrivalAlertAt: '08:00' });
    expect(bad.status).toBe(400);
    const tz = await admin.put('/api/company/settings', { ...current, timezone: 'Marte/Base' });
    expect(tz.status).toBe(400);
    const ok = await admin.put('/api/company/settings', { ...current, arrivalAlertAt: '09:45' });
    expect(ok.status).toBe(200);
    expect(ok.body.arrivalAlertAt).toBe('09:45');
    expect(ok.body.version).toBe(current.version + 1);
  });

  it('identificadores malformados e JSON inválido retornam 400', async () => {
    const admin = await loginAdmin(app);
    expect((await admin.get('/api/employees/nao-e-uuid')).status).toBe(400);
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('VALIDATION_ERROR');
  });

  it('upload de foto verifica o conteúdo real do arquivo', async () => {
    const admin = await loginAdmin(app);
    const joao = await employeeByName('João');
    const boundary = '----teste';
    const fake = Buffer.from('<script>alert(1)</script>');
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      fake,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.app.inject({
      method: 'POST',
      url: `/api/employees/${joao.id}/photo`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: admin.cookieHeader,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(415);

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const ok = await app.app.inject({
      method: 'POST',
      url: `/api/employees/${joao.id}/photo`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: admin.cookieHeader,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(ok.statusCode).toBe(200);
    const photoUrl = JSON.parse(ok.body).photoUrl as string;
    // Arquivo privado: exige sessão.
    expect((await new Client(app).get(photoUrl)).status).toBe(401);
    const file = await app.app.inject({
      method: 'GET',
      url: photoUrl,
      headers: { cookie: admin.cookieHeader },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('Tratamento de erros', () => {
  it('rota inexistente segue o formato padrão de erro', async () => {
    const r = await new Client(app).get('/api/nao-existe');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(r.body.error.requestId).toBeTruthy();
  });

  it('erro interno não expõe detalhes ao cliente', async () => {
    const r = await new Client(app).get('/api/__teste/falha');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(r.body)).not.toContain('senha');
    expect(r.headers['x-request-id']).toBe(r.body.error.requestId);
  });

  it('registro inexistente retorna 404', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.get('/api/employees/00000000-0000-4000-8000-000000000000');
    expect(r.status).toBe(404);
  });
});

describe('Concorrência e idempotência', () => {
  it('controle otimista: edição com versão desatualizada é rejeitada', async () => {
    const admin = await loginAdmin(app);
    const joao = await employeeByName('João');
    const body = {
      fullName: joao.fullName,
      displayName: joao.displayName,
      jobTitle: 'Ajudante geral',
      color: joao.color,
      roleIds: [await roleId('ajudante')],
      extraPermissions: [],
      version: joao.version,
    };
    const first = await admin.put(`/api/employees/${joao.id}`, body);
    expect(first.status).toBe(200);
    const stale = await admin.put(`/api/employees/${joao.id}`, { ...body, jobTitle: 'Outro' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.currentVersion).toBe(joao.version + 1);
  });

  it('edições simultâneas: apenas uma vence, a outra recebe conflito', async () => {
    const admin = await loginAdmin(app);
    const joao = await employeeByName('João');
    const base = {
      fullName: joao.fullName,
      displayName: joao.displayName,
      color: joao.color,
      roleIds: [await roleId('ajudante')],
      extraPermissions: [],
      version: joao.version,
    };
    const results = await Promise.all(
      ['Ajudante A', 'Ajudante B', 'Ajudante C'].map((jobTitle) =>
        admin.put(`/api/employees/${joao.id}`, { ...base, jobTitle }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
  });

  it('mesma chave de idempotência não duplica o cadastro (duplo clique / reenvio)', async () => {
    const admin = await loginAdmin(app);
    const key = idemKey();
    const body = {
      fullName: 'Pessoa Teste',
      displayName: 'Teste',
      jobTitle: 'Apoio',
      color: '#123123',
      roleIds: [await roleId('ajudante')],
    };
    const a = await admin.post('/api/employees', body, { 'idempotency-key': key });
    const b = await admin.post('/api/employees', body, { 'idempotency-key': key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(await db().employee.count({ where: { displayName: 'Teste' } })).toBe(1);

    const reuse = await admin.post(
      '/api/employees',
      { ...body, displayName: 'Outro' },
      { 'idempotency-key': key },
    );
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requisições simultâneas com a mesma chave executam apenas uma vez', async () => {
    const admin = await loginAdmin(app);
    const key = idemKey();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        admin.post('/api/devices', { name: 'Tablet concorrente' }, { 'idempotency-key': key }),
      ),
    );
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(await db().device.count()).toBe(1);
  });

  it('operação sensível sem chave de idempotência é recusada', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.post('/api/devices', { name: 'Sem chave' });
    expect(r.status).toBe(400);
  });
});

describe('Histórico e auditoria', () => {
  it('alterações geram auditoria com diferenças, sem dados sensíveis, e evento de domínio', async () => {
    const admin = await loginAdmin(app);
    const joao = await employeeByName('João');
    await admin.put(`/api/employees/${joao.id}/pin`, { pin: '284619' });
    await admin.put(`/api/employees/${joao.id}`, {
      fullName: 'João da Silva',
      displayName: 'João',
      jobTitle: joao.jobTitle,
      color: joao.color,
      roleIds: [await roleId('ajudante')],
      extraPermissions: [],
      version: joao.version + 1,
    });
    const logs = await db().auditLog.findMany({
      where: { entityId: joao.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual(['employee.pin_set', 'employee.updated']);
    expect(logs[1]!.changes).toMatchObject({ fullName: { from: 'João', to: 'João da Silva' } });
    expect(JSON.stringify(logs)).not.toContain('284619');
    const events = await db().domainEvent.findMany({ where: { aggregateId: joao.id } });
    expect(events.length).toBe(2);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/pinHash|284619/);

    const page = await admin.get('/api/audit?limit=2');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
    const next = await admin.get(
      `/api/audit?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
  });
});
