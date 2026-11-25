/**
 * Melhorias da segunda rodada (2026-11-17): situação e funil do orçamento (77, 81), orçamento que
 * vira serviço (78), links do cliente (79, 82, 130), busca rápida (83), lixeira (86), sugestões
 * (112), aviso de manutenção (131), acesso de suporte (114), números do negócio (116),
 * cancelar/pausar (113), duas etapas (98), baixar todos os dados (99), importar planilha (75) e
 * página de status (100).
 */
import { emptyQuoteDraft } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { hotp, base32Decode } from '../src/lib/totp';
import { readCsv } from '../src/lib/sheet';
import { sniffAudio } from '../src/modules/attachments/routes';
import { publicLinkSignature } from '../src/core/public-links';
import {
  address,
  createCustomer,
  createOrder,
  createPickup,
  generateOsFromOrder,
} from './commercial-helpers';
import {
  ADMIN,
  Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  loginPlatform,
} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const post = (c: Client, url: string, body: unknown = {}) =>
  c.req('POST', url, body, { 'idempotency-key': idemKey() });

function day(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function savedQuote(c: Client, customerName = 'Maria Proposta') {
  const settings = ok(await c.get('/api/v1/quotes/settings'));
  if (settings.taxRateBps === null)
    ok(
      await c.req('PATCH', '/api/v1/quotes/settings', {
        version: settings.version,
        taxRateBps: 600,
      }),
    );
  return ok(
    await post(c, '/api/v1/quotes', {
      ...emptyQuoteDraft(),
      customerName,
      phone: '12999990000',
      service: 'Reforma de Sofá',
      profitCents: 100000,
      validityDays: 15,
    }),
    201,
  );
}

async function criarConta(email = 'nova@tapecaria.local') {
  const c = new Client(app);
  ok(
    await c.post('/api/auth/signup', { email, password: 'senha123', passwordConfirm: 'senha123' }),
    201,
  );
  return c;
}

const query = (url: string) => new URL(url).searchParams.get('t')!;
const path = (url: string) => new URL(url).pathname;

describe('Orçamento: situação, lembrete, funil e link do cliente', () => {
  it('nasce enviado com lembrete; recusa exige motivo; funil soma por situação', async () => {
    const admin = await loginAdmin(app);
    const q = await savedQuote(admin);
    expect(q.status).toBe('ENVIADO');
    expect(q.followUpAt).not.toBeNull();
    expect(q.followUpDue).toBe(false);

    const semMotivo = await admin.post(`/api/v1/quotes/${q.id}/status`, {
      version: q.version,
      status: 'RECUSADO',
    });
    expect(semMotivo.status).toBe(400);

    const recusado = ok(
      await admin.post(`/api/v1/quotes/${q.id}/status`, {
        version: q.version,
        status: 'RECUSADO',
        lostReason: 'Preço',
      }),
    );
    expect(recusado).toMatchObject({ status: 'RECUSADO', lostReason: 'Preço', followUpAt: null });

    const q2 = await savedQuote(admin, 'João Funil');
    ok(
      await admin.post(`/api/v1/quotes/${q2.id}/status`, {
        version: q2.version,
        status: 'ENVIADO',
        followUpDate: day(-1),
      }),
    );
    const funnel = ok(await admin.get(`/api/v1/quotes/funnel?from=${day(-3)}&to=${day(1)}`));
    expect(funnel.total.count).toBe(2);
    expect(funnel.byStatus.RECUSADO.count).toBe(1);
    expect(funnel.lostReasons[0]).toMatchObject({ reason: 'Preço', count: 1 });
    expect(funnel.followUpDue).toBe(1);
    expect(funnel.approvalRateBps).toBe(0);
  });

  it('o cliente abre o link, vê só a proposta e aprova; link adulterado não abre nada', async () => {
    const admin = await loginAdmin(app);
    const q = await savedQuote(admin);
    const { url } = ok(await admin.get(`/api/v1/quotes/${q.id}/link`));
    const anon = new Client(app);
    const bad = await anon.get(
      `${path(url)}?t=${'0'.repeat(24)}`.replace('/proposta/', '/api/public/proposta/'),
    );
    expect(bad.status).toBe(404);

    const pub = ok(await anon.get(`/api/public/proposta/${q.id}?t=${query(url)}`));
    expect(pub).toMatchObject({
      number: q.number,
      customerName: 'Maria Proposta',
      status: 'ENVIADO',
    });
    // O link mostra a mesma proposta do painel: telefone do cliente e opção a prazo, nada de custo.
    expect(pub).toHaveProperty('customerPhone');
    expect(pub).toHaveProperty('paymentOptionName');
    // Melhoria 141: os textos da proposta gravados no orçamento chegam ao link do cliente.
    expect(pub.texts).toMatchObject({ title: expect.any(String), intro: expect.any(String) });
    expect(JSON.stringify(pub)).not.toContain('costCents');
    expect(JSON.stringify(pub)).not.toContain('rateBps');
    expect(JSON.stringify(pub)).not.toContain('profitCents');

    const aprovado = ok(await anon.post(`/api/public/proposta/${q.id}/aprovar`, { t: query(url) }));
    expect(aprovado.status).toBe('APROVADO');
    const depois = ok(await admin.get(`/api/v1/quotes/${q.id}`));
    expect(depois).toMatchObject({ status: 'APROVADO', approvedVia: 'LINK' });
    expect(depois.linkViewedAt).not.toBeNull();
    const avisos = await db().notification.count({ where: { kind: 'ORCAMENTO_APROVADO' } });
    expect(avisos).toBeGreaterThan(0);

    // 2026-11-24: o cliente não escolhe mais o dia da retirada pelo link; a oficina combina.
    expect(aprovado).not.toHaveProperty('canChoosePickup');
    expect(aprovado).not.toHaveProperty('pickupDays');
    const escolha = await anon.post(`/api/public/proposta/${q.id}/retirada`, {
      t: query(url),
      date: day(2),
      shift: 'MANHA',
    });
    expect(escolha.status).toBe(404);
    const noPainel = ok(await admin.get(`/api/v1/quotes/${q.id}`));
    expect(noPainel).toMatchObject({ pickupDate: null, pickupShift: null });
  });

  it('o orçamento aprovado vira serviço uma vez só e fica ligado ao pedido', async () => {
    const admin = await loginAdmin(app);
    const q = await savedQuote(admin);
    const body = {
      quoteId: q.id,
      customer: { mode: 'NOVO', kind: 'PF', name: 'Maria Proposta', phone: '(12) 99999-0000' },
      service: {
        contractedService: 'Reforma de Sofá',
        agreedValueCents: q.totalCents,
        promisedDate: day(20),
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        ],
      },
      pickup: null,
    };
    const r = ok(await post(admin, '/api/v1/services', body), 201);
    const depois = ok(await admin.get(`/api/v1/quotes/${q.id}`));
    expect(depois).toMatchObject({ status: 'APROVADO', orderId: r.order.id });
    const outra = await post(admin, '/api/v1/services', {
      ...body,
      customer: { ...body.customer, name: 'Maria Proposta 2', phone: '(12) 99999-0001' },
    });
    expect(outra.status).toBe(422);
    // Já virou pedido: não volta para "recusado" sem cancelar o pedido.
    const volta = await admin.post(`/api/v1/quotes/${q.id}/status`, {
      version: depois.version,
      status: 'RECUSADO',
      lostReason: 'Preço',
    });
    expect(volta.status).toBe(422);
  });
});

describe('Retirada pelo link (só para ver)', () => {
  it('o cliente não escolhe o dia; links antigos só mostram a retirada', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    const pickup = await createPickup(admin, order, null);
    // O painel não gera mais o link de escolha.
    const link = await admin.get(`/api/v1/pickups/${pickup.id}/schedule-link`);
    expect(link.status).toBe(404);
    // Um link já enviado (assinatura válida) ainda abre, sem dias para escolher.
    const t = publicLinkSignature(app.app.ctx.hashToken, 'agendar', pickup.id);
    const anon = new Client(app);
    const info = ok(await anon.get(`/api/public/agendar/${pickup.id}?t=${t}`));
    expect(info).toMatchObject({ open: true, scheduledDate: null });
    expect(info).not.toHaveProperty('days');
    expect(info.address).toContain(address.street);
    const escolha = await anon.post(`/api/public/agendar/${pickup.id}`, {
      t,
      date: day(2),
      shift: 'TARDE',
    });
    expect(escolha.status).toBe(404);
    const row = await db().pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } });
    expect(row.status).toBe('AGUARDANDO_AGENDAMENTO');
    expect(row.customerScheduledAt).toBeNull();
  });
});

describe('Álbum de antes e depois', () => {
  it('abre pelo link com assinatura e só lista fotos da OS', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const r = ok(
      await post(admin, '/api/v1/services', {
        customer: { mode: 'EXISTENTE', customerId: customer.id },
        service: {
          contractedService: 'Reforma',
          promisedDate: day(20),
          items: [
            {
              pieceType: 'SOFA',
              description: 'Sofá',
              quantity: 1,
              serviceType: 'REFORMA_COMPLETA',
            },
          ],
        },
        pickup: null,
      }),
      201,
    );
    const osId = (await generateOsFromOrder(admin, r.order.id)).id;
    const album = ok(await admin.get(`/api/v1/service-orders/${osId}/album`));
    expect(album).toMatchObject({ before: [], during: [], after: [] });
    const anon = new Client(app);
    ok(await anon.get(`/api/public/album/${osId}?t=${query(album.shareUrl)}`));
    expect((await anon.get(`/api/public/album/${osId}?t=abc`)).status).toBe(404);
  });
});

describe('Busca rápida, lixeira e sugestões', () => {
  it('acha cliente pelo nome e orçamento pelo número; restaura orçamento apagado', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Valdomiro Buscável' });
    const q = await savedQuote(admin, 'Valdomiro Buscável');
    const found = ok(await admin.get('/api/v1/search?q=valdomiro'));
    expect(found.items.map((i: J) => i.kind)).toEqual(
      expect.arrayContaining(['CLIENTE', 'ORCAMENTO']),
    );
    const byNumber = ok(await admin.get(`/api/v1/search?q=${q.number}`));
    expect(byNumber.items[0].id).toBe(q.id);

    ok(await admin.post(`/api/v1/quotes/${q.id}/delete`));
    const trash = ok(await admin.get('/api/v1/trash'));
    expect(trash.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ORCAMENTO', id: q.id, daysLeft: 30 }),
      ]),
    );
    ok(await admin.post(`/api/v1/trash/ORCAMENTO/${q.id}/restore`));
    expect((await admin.get(`/api/v1/quotes/${q.id}`)).status).toBe(200);
  });

  it('sugestão de outra empresa chega só ao dono da plataforma', async () => {
    const nova = await criarConta();
    ok(
      await nova.post('/api/v1/feedback', {
        kind: 'SUGESTAO',
        message: 'Queria ver o prazo no tablet.',
        pageUrl: '/painel',
      }),
      201,
    );
    expect((await nova.get('/api/v1/platform/feedback')).status).toBe(401);
    const admin = await loginPlatform(app);
    const list = ok(await admin.get('/api/v1/platform/feedback'));
    expect(list.items[0]).toMatchObject({ kind: 'SUGESTAO', status: 'NOVO' });
  });
});

describe('Aviso de manutenção e página de status', () => {
  it('o aviso aparece para todos no horário e some quando é encerrado', async () => {
    const admin = await loginPlatform(app);
    const n = ok(
      await admin.post('/api/v1/platform/notices', {
        message: 'O sistema atualiza hoje às 22h.',
        showFrom: new Date(Date.now() - 60_000).toISOString(),
        showUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      201,
    );
    const anon = new Client(app);
    expect(ok(await anon.get('/api/public/aviso')).notice.message).toContain('22h');
    ok(await admin.post(`/api/v1/platform/notices/${n.id}/end`));
    expect(ok(await anon.get('/api/public/aviso')).notice).toBeNull();
    const status = ok(await anon.get('/api/public/status'));
    expect(status.ok).toBe(true);
    expect(status.days).toHaveLength(90);
  });
});

describe('Acesso de suporte', () => {
  it('só entra quando a empresa libera, como "Suporte Cenário", e sai quando ela corta', async () => {
    const nova = await criarConta('suporte@tapecaria.local');
    const novaId = (
      await db().user.findFirstOrThrow({ where: { email: 'suporte@tapecaria.local' } })
    ).companyId;
    const admin = await loginPlatform(app);
    const negado = await admin.post(`/api/v1/platform/companies/${novaId}/support-session`);
    expect(negado.status).toBe(422);

    ok(await nova.post('/api/v1/company/support-access', { hours: 2 }));
    const suporte = await loginPlatform(app);
    ok(await suporte.post(`/api/v1/platform/companies/${novaId}/support-session`));
    const me = ok(await suporte.get('/api/auth/me'));
    expect(me.user).toMatchObject({ displayName: 'Suporte Cenário', supportAgent: true });
    expect(me.company.platformOwner).toBe(false);

    ok(await nova.post('/api/v1/company/support-access', { hours: 0 }));
    expect((await suporte.get('/api/auth/me')).status).toBe(401);
  });
});

describe('Números do negócio e cancelar/pausar', () => {
  it('conta teste grátis e o motivo de quem cancela', async () => {
    const nova = await criarConta('cancela@tapecaria.local');
    ok(
      await nova.post('/api/v1/subscription/cancel', {
        action: 'CANCELAR',
        reason: 'Ficou caro',
        details: 'Por enquanto',
      }),
    );
    const admin = await loginPlatform(app);
    const estofados = await loginAdmin(app);
    const n = ok(await admin.get('/api/v1/platform/business-numbers'));
    expect(n.canceled).toBe(1);
    expect(n.cancelReasons).toEqual([{ reason: 'Ficou caro', count: 1 }]);
    expect(n.trial).toBe(1);
    expect(
      (
        await estofados.post('/api/v1/subscription/cancel', {
          action: 'PAUSAR',
          reason: 'Outro motivo',
        })
      ).status,
    ).toBe(422);
    const estado = ok(await nova.get('/api/v1/subscription/cancel-options'));
    expect(estado.canceledAt).not.toBeNull();
    expect(estado.cancelReason).toBe('Ficou caro — Por enquanto');
    ok(await nova.post('/api/v1/subscription/resume', {}));
    expect(ok(await nova.get('/api/v1/subscription/cancel-options')).canceledAt).toBeNull();
  });

  it('a conta de demonstração é separada, entra com a senha mostrada e fica fora dos números', async () => {
    const admin = await loginPlatform(app);
    const demo = ok(
      await admin.post('/api/v1/platform/demo-company', { email: 'demo@cenario.local' }),
    );
    expect(demo.password.length).toBeGreaterThanOrEqual(10);
    const c = new Client(app);
    ok(await c.post('/api/auth/login', { email: 'demo@cenario.local', password: demo.password }));
    const me = ok(await c.get('/api/auth/me'));
    expect(me.company.isDemo).toBe(true);
    const clientes = ok(await c.get('/api/v1/customers'));
    expect(clientes.items.length).toBe(5);
    const lista = ok(await admin.get('/api/v1/platform/companies'));
    expect(lista.items.find((x: J) => x.id === demo.companyId).isDemo).toBe(true);
    const n = ok(await admin.get('/api/v1/platform/business-numbers'));
    expect(n.trial + n.paying + n.courtesy).toBe(0);
    expect(
      (await admin.post('/api/v1/platform/demo-company', { email: 'demo@cenario.local' })).status,
    ).toBe(409);
  });
});

describe('Recado por áudio', () => {
  it('reconhece o formato pelo conteúdo e só aceita em tarefas e ocorrências', async () => {
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'audio/webm',
    );
    expect(sniffAudio(Buffer.from('OggS0000000000'))).toBe('audio/ogg');
    expect(sniffAudio(Buffer.from('\0\0\0\x18ftypM4A 0000'))).toBe('audio/mp4');
    expect(sniffAudio(Buffer.from('<html>000000000'))).toBeNull();
    const admin = await loginAdmin(app);
    const boundary = '----audio';
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const send = (entityType: string, file: Buffer) =>
      app.app.inject({
        method: 'POST',
        url: '/api/v1/attachments/audio',
        headers: {
          origin: 'http://localhost:3000',
          cookie: admin.cookieHeader,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            part('entityType', entityType) +
              part('entityId', '00000000-0000-4000-8000-000000000001') +
              `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recado"\r\nContent-Type: audio/webm\r\n\r\n`,
          ),
          file,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]);
    expect((await send('SERVICE_ORDER', webm)).statusCode).toBe(400);
    expect((await send('PRODUCTION_TASK', Buffer.from('nao e audio nenhum'))).statusCode).toBe(415);
    expect((await send('PRODUCTION_TASK', webm)).statusCode).toBe(404);
  });
});

describe('Verificação em duas etapas', () => {
  it('liga com o código do celular; o login passa a pedir o código; recuperação vale uma vez', async () => {
    const admin = await loginAdmin(app);
    const setup = ok(await admin.post('/api/v1/account/2fa/setup'));
    const code = () => hotp(base32Decode(setup.secret), Math.floor(Date.now() / 30_000));
    expect((await admin.post('/api/v1/account/2fa/enable', { code: '000000' })).status).toBe(422);
    const { recoveryCodes } = ok(await admin.post('/api/v1/account/2fa/enable', { code: code() }));
    expect(recoveryCodes).toHaveLength(8);

    const c = new Client(app);
    const first = ok(await c.post('/api/auth/login', ADMIN));
    expect(first.twoFactorRequired).toBe(true);
    expect(c.cookies.size).toBe(0);
    const wrong = await c.post('/api/auth/login/2fa', {
      challenge: first.challenge,
      code: '123456',
    });
    expect(wrong.status).toBe(401);
    ok(await c.post('/api/auth/login/2fa', { challenge: first.challenge, code: code() }));
    expect(ok(await c.get('/api/auth/me')).user.twoFactor).toBe(true);

    const c2 = new Client(app);
    const again = ok(await c2.post('/api/auth/login', ADMIN));
    ok(
      await c2.post('/api/auth/login/2fa', { challenge: again.challenge, code: recoveryCodes[0] }),
    );
    const c3 = new Client(app);
    const third = ok(await c3.post('/api/auth/login', ADMIN));
    expect(
      (await c3.post('/api/auth/login/2fa', { challenge: third.challenge, code: recoveryCodes[0] }))
        .status,
    ).toBe(401);
  });
});

describe('Baixar todos os dados e importar planilha', () => {
  it('o zip traz só os dados da própria empresa e nenhum segredo', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Cliente Da Cenário' });
    const nova = await criarConta('zip@tapecaria.local');
    await createCustomer(nova, { name: 'Cliente Da Nova Zip' });
    const r = await app.app.inject({
      method: 'GET',
      url: '/api/v1/company/export.zip',
      headers: { cookie: nova.cookieHeader },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const text = r.rawPayload.toString('latin1');
    expect(text).toContain('customers.csv');
    expect(text).toContain('Cliente Da Nova Zip');
    expect(text).not.toContain('Cliente Da Cenário');
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('$argon2');
  });

  it('importa clientes linha a linha e devolve as linhas com problema', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Já Existe', phone: '(11) 91111-2222' });
    const r = ok(
      await admin.post('/api/v1/customers/import', {
        rows: [
          {
            line: 2,
            name: 'Ana Importada',
            phone: '(12) 98888-1111',
            city: 'Jacareí',
            state: 'SP',
            street: 'Rua A',
            number: '10',
          },
          { line: 3, name: 'Telefone Ruim', phone: '123' },
          { line: 4, name: 'Já Existe', phone: '(11) 91111-2222' },
        ],
      }),
    );
    expect(r.created).toBe(1);
    expect(r.problems.map((p: J) => p.line)).toEqual([3, 4]);
    const ana = await db().customer.findFirstOrThrow({
      where: { name: 'Ana Importada' },
      include: { addresses: true },
    });
    expect(ana.addresses[0]?.city).toBe('Jacareí');

    const precos = ok(
      await admin.post('/api/v1/quotes/catalog/import-prices', {
        rows: [
          { line: 2, name: 'Linho cinza', category: 'Tecido', unit: 'metro', price: 'R$ 45,90' },
          { line: 3, name: 'Sem preço', price: 'abc' },
        ],
      }),
    );
    expect(precos).toMatchObject({ created: 1, updated: 0 });
    const linho = await db().quoteCatalogItem.findFirstOrThrow({ where: { name: 'Linho cinza' } });
    expect(linho).toMatchObject({ priceCents: 4590, unit: 'm', category: 'Tecidos' });
  });

  it('lê CSV com ponto e vírgula e aspas', () => {
    expect(readCsv('Nome;Telefone\n"Silva; Ana";1199\n')).toEqual([
      ['Nome', 'Telefone'],
      ['Silva; Ana', '1199'],
    ]);
  });
});
