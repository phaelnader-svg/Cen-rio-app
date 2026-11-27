/**
 * Etapa 3 da lista de 53 melhorias (2026-11-27): repetir do último (7), prazo pela fila (12),
 * lucro mínimo (13), chuva (16), tempo das etapas (17), lucro por peça (18), folgas e prazos (19),
 * padrão da casa (20), "Como ficou?" (22) e cuidados com a peça (23). Dados fictícios.
 */
import { GENERAL_CARE_TEXT, careTextFor } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { publicLink } from '../src/core/public-links';
import { runAsCompany } from '../src/core/tenant';
import { sniffVideoType } from '../src/modules/production/house-standards';
import { rainPeriod, rainRound } from '../src/modules/quality/rain';
import { Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42', 'ascii'),
  Buffer.alloc(200, 7),
]);

async function upload(client: Client, data: Buffer, name: string, mime: string) {
  const boundary = '----padrao';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/house-standards/upload',
    headers: {
      origin: 'http://localhost:3000',
      cookie: client.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as J };
}

type S = Awaited<ReturnType<typeof k.scenario>>;

/** Entrega concluída pela OS (as duas peças prontas). */
async function delivered(s: S) {
  await db().serviceOrderItem.update({
    where: { id: s.sofa.id },
    data: { fabricName: 'Veludo cotelê' },
  });
  await db().serviceOrderItem.update({
    where: { id: s.poltronas.id },
    data: { fabricName: 'Linho Rústico' },
  });
  await k.ready(s, 'sofa');
  await k.ready(s, 'poltronas');
  const d = ok(
    await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'Cliente buscou' }),
  );
  return d.deliveryId as string;
}

const linkParts = (url: string) => {
  const u = new URL(url);
  return { id: u.pathname.split('/').pop()!, t: u.searchParams.get('t')! };
};

describe('Cuidados com a peça (23)', () => {
  it('texto pelo nome do tecido, o da tapeçaria vale mais e sem tecido sai o geral', () => {
    expect(careTextFor('Veludo cotelê')).toContain('sentido do pelo');
    expect(careTextFor('Couro legítimo café')).toContain('hidrate');
    expect(careTextFor('Corino preto')).toContain('sabão neutro');
    expect(careTextFor('Tecido X')).toBe(GENERAL_CARE_TEXT);
    expect(careTextFor(null)).toBe(GENERAL_CARE_TEXT);
    expect(careTextFor('Veludo cotelê', { 'veludo cotelê': 'Só aspirar.' })).toBe('Só aspirar.');
  });
});

describe('"Como ficou?" depois da entrega (22)', () => {
  it('link só com a entrega concluída, nota uma vez só, nota baixa avisa e entra na estatística', async () => {
    const s = await k.scenario();
    const id = await delivered(s);

    // Cuidados escritos pela tapeçaria na Base de dados.
    ok(
      await s.admin.put('/api/v1/quotes/care-texts', {
        texts: { 'Linho Rústico': 'Aspire toda semana e lave a capa a seco.' },
      }),
    );
    const care = ok(await s.admin.get('/api/v1/quotes/care-texts'));
    expect(care.items.find((i: J) => i.fabric === 'Linho Rústico').custom).toBe(true);
    expect(care.items.find((i: J) => i.fabric === 'Veludo cotelê').custom).toBe(false);

    const link = ok(await s.admin.get(`/api/v1/deliveries/${id}/review-link`));
    expect(link.url).toContain(`/avaliar/${id}?t=`);
    expect(link.text).toContain('como ficou');
    expect(link.rated).toBe(false);
    const { t } = linkParts(link.url);

    const anon = new Client(app);
    // Assinatura errada ou de outro tipo de link não abre.
    expect((await anon.get(`/api/public/avaliar/${id}?t=${'0'.repeat(24)}`)).status).toBe(404);
    const albumSig = linkParts(publicLink(app.ctx.env, app.ctx.hashToken, 'album', id)).t;
    expect((await anon.get(`/api/public/avaliar/${id}?t=${albumSig}`)).status).toBe(404);

    const page = ok(await anon.get(`/api/public/avaliar/${id}?t=${t}`));
    expect(page.review).toBeNull();
    expect(page.pieces).toHaveLength(2);
    expect(page.care.find((c: J) => c.fabric === 'Linho Rústico').text).toContain('lave a capa');
    expect(page.care.find((c: J) => c.fabric === 'Veludo cotelê').text).toContain('pelo');
    expect(JSON.stringify(page)).not.toMatch(/Cents|lucro|profit/i);

    // Robô (campo-isca) não grava.
    ok(await anon.post(`/api/public/avaliar/${id}`, { t, stars: 1, website: 'http://spam' }));
    expect((await db().delivery.findUniqueOrThrow({ where: { id } })).ratedAt).toBeNull();
    // Nota fora de 1 a 5 é recusada.
    expect((await anon.post(`/api/public/avaliar/${id}`, { t, stars: 6 })).status).toBe(400);

    const sent = ok(
      await anon.post(`/api/public/avaliar/${id}`, {
        t,
        stars: 2,
        comment: 'O braço ficou torto.',
      }),
    );
    expect(sent.review.stars).toBe(2);
    const alerts = await db().notification.findMany({ where: { kind: 'AVALIACAO_BAIXA' } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.body).toContain('nota 2 de 5');

    // Segunda resposta não troca a primeira.
    const again = ok(await anon.post(`/api/public/avaliar/${id}`, { t, stars: 5 }));
    expect(again.review.stars).toBe(2);
    expect(ok(await s.admin.get(`/api/v1/deliveries/${id}/review-link`)).rated).toBe(true);

    const sum = ok(await s.admin.get('/api/v1/reports/ratings?days=90'));
    expect(sum.count).toBe(1);
    expect(sum.average).toBe(2);
    expect(sum.byStars).toEqual([0, 1, 0, 0, 0]);
    expect(sum.delivered).toBe(1);
    expect(sum.low[0].comment).toBe('O braço ficou torto.');
  });

  it('nota boa não gera alerta; entrega não concluída não tem link', async () => {
    const s = await k.scenario();
    const id = await delivered(s);
    const { t } = linkParts(ok(await s.admin.get(`/api/v1/deliveries/${id}/review-link`)).url);
    await db().delivery.update({ where: { id }, data: { status: 'AGENDADA' } });
    expect((await s.admin.get(`/api/v1/deliveries/${id}/review-link`)).status).toBe(422);
    const anon = new Client(app);
    expect((await anon.get(`/api/public/avaliar/${id}?t=${t}`)).status).toBe(404);
    await db().delivery.update({ where: { id }, data: { status: 'CONCLUIDA' } });
    ok(await anon.post(`/api/public/avaliar/${id}`, { t, stars: 5 }));
    expect(await db().notification.count({ where: { kind: 'AVALIACAO_BAIXA' } })).toBe(0);
  });
});

describe('Padrão da casa (20)', () => {
  it('foto ou vídeo por etapa, aparece no tablet, troca e apaga', async () => {
    const s = await k.scenario();
    expect(sniffVideoType(MP4)).toBe('video/mp4');
    expect(sniffVideoType(PNG)).toBeNull();
    expect(
      (await upload(s.admin, Buffer.from('texto qualquer'), 'a.txt', 'text/plain')).status,
    ).toBe(415);
    const photo = ok(await upload(s.admin, PNG, 'grampo.png', 'image/png'));
    ok(
      await s.admin.put('/api/v1/house-standards/REVESTIMENTO', {
        text: 'Grampo a cada dois dedos, do meio para as pontas.',
        fileId: photo.fileId,
      }),
    );
    // O tapeceiro vê no tablet.
    const tablet = s.tablets['Ricardo']!;
    const seen = ok(await tablet.get('/api/v1/house-standards/REVESTIMENTO'));
    expect(seen.item.text).toContain('dois dedos');
    expect(seen.item.mime).toMatch(/^image\//);
    expect((await tablet.get(seen.item.fileUrl)).status).toBe(200);
    // Tablet não edita.
    expect(
      (await tablet.put('/api/v1/house-standards/REVESTIMENTO', { text: 'outro' })).status,
    ).toBe(403);

    // Troca por vídeo: o vídeo toca por partes (Safari do iPad) e a foto antiga sai.
    const video = ok(await upload(s.admin, MP4, 'grampo.mp4', 'video/mp4'));
    ok(
      await s.admin.put('/api/v1/house-standards/REVESTIMENTO', {
        text: 'Grampo a cada dois dedos.',
        fileId: video.fileId,
      }),
    );
    expect(
      (await db().storedFile.findUniqueOrThrow({ where: { id: photo.fileId } })).deletedAt,
    ).not.toBeNull();
    const part = await app.app.inject({
      method: 'GET',
      url: `/api/files/${video.fileId}`,
      headers: { cookie: s.admin.cookieHeader, range: 'bytes=0-9' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-9/${MP4.length}`);
    expect(part.rawPayload.length).toBe(10);

    // Texto vazio e sem arquivo apaga o padrão da etapa.
    ok(await s.admin.put('/api/v1/house-standards/REVESTIMENTO', { text: '', fileId: null }));
    expect(ok(await s.admin.get('/api/v1/house-standards')).items).toHaveLength(0);
  });
});

describe('Folgas e prazos (19)', () => {
  it('mostra as OS com prazo na semana da folga e trabalho com a pessoa', async () => {
    const s = await k.scenario();
    const emp = await db().employee.findUniqueOrThrow({ where: { userId: s.ids.ricardo } });
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date('2027-03-10T00:00:00.000Z') },
    });
    const q = (start: string, end: string) =>
      s.admin.get(`/api/v1/attendance/leave-impact?employeeId=${emp.id}&start=${start}&end=${end}`);
    const hit = ok(await q('2027-03-08', '2027-03-09'));
    expect(hit.tight).toHaveLength(1);
    expect(hit.tight[0].openTasks).toBe(1);
    expect(hit.tight[0].code).toMatch(/^OS/);
    // Prazo uma semana depois do fim da folga ainda conta; mais longe, não.
    expect(ok(await q('2027-03-01', '2027-03-03')).tight).toHaveLength(1);
    expect(ok(await q('2027-02-20', '2027-02-25')).tight).toHaveLength(0);
    // Quem não tem tarefa na OS não aperta nada.
    const other = await db().employee.findUniqueOrThrow({ where: { userId: s.ids.joao } });
    expect(
      ok(
        await s.admin.get(
          `/api/v1/attendance/leave-impact?employeeId=${other.id}&start=2027-03-08&end=2027-03-09`,
        ),
      ).tight,
    ).toHaveLength(0);
    expect((await q('2027-03-09', '2027-03-08')).status).toBe(422);
  });
});

describe('Aviso de chuva (16)', () => {
  it('na véspera, com entrega marcada e chuva forte, avisa uma vez; sem chuva, só marca o dia', async () => {
    const s = await k.scenario();
    const id = await delivered(s);
    // 2027-03-09 às 17h em São Paulo; entrega marcada para o dia seguinte.
    const now = new Date('2027-03-09T20:00:00.000Z');
    await db().delivery.update({
      where: { id },
      data: { status: 'AGENDADA', scheduledDate: new Date('2027-03-10T00:00:00.000Z') },
    });
    const calls: string[] = [];
    const fake = (pct: number) => async (url: string) => {
      calls.push(url);
      if (url.includes('geocoding'))
        return {
          ok: true,
          json: async () => ({ results: [{ latitude: -23.5, longitude: -46.6 }] }),
        };
      const hourly = Array.from({ length: 24 }, (_, h) => (h >= 13 && h < 17 ? pct : 10));
      return { ok: true, json: async () => ({ hourly: { precipitation_probability: hourly } }) };
    };
    const prisma = app.ctx.prisma;
    // Antes das 16h não olha.
    expect(
      await runAsCompany(1, () =>
        rainRound(prisma, fake(90), new Date('2027-03-09T15:00:00.000Z')),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);

    expect(await runAsCompany(1, () => rainRound(prisma, fake(90), now))).toBe(true);
    const n = await db().notification.findMany({ where: { kind: 'CHUVA_AMANHA' } });
    expect(n.length).toBeGreaterThan(0);
    expect(n[0]!.body).toContain('à tarde');
    expect(n[0]!.body).toContain('1 entrega marcada');
    // Uma vez por dia.
    expect(await runAsCompany(1, () => rainRound(prisma, fake(90), now))).toBe(false);
    const cs = await db().companySettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(cs.weatherLat).toBe(-23.5);

    // Dia seguinte sem chuva: olha, marca e não avisa.
    await db().delivery.update({
      where: { id },
      data: { scheduledDate: new Date('2027-03-11T00:00:00.000Z') },
    });
    const before = await db().notification.count({ where: { kind: 'CHUVA_AMANHA' } });
    expect(
      await runAsCompany(1, () =>
        rainRound(prisma, fake(20), new Date('2027-03-10T20:00:00.000Z')),
      ),
    ).toBe(false);
    expect(await db().notification.count({ where: { kind: 'CHUVA_AMANHA' } })).toBe(before);
    expect(rainPeriod([...Array(6).fill(0), ...Array(6).fill(70), ...Array(12).fill(0)])).toEqual({
      pct: 70,
      when: 'de manhã',
    });
  });
});

describe('Orçamento e números (7, 12, 13, 17, 18)', () => {
  it('as consultas novas respondem e o lucro mínimo é salvo', async () => {
    const admin = await loginAdmin(app);
    const st = ok(await admin.get('/api/v1/quotes/settings'));
    ok(
      await admin.req('PATCH', '/api/v1/quotes/settings', {
        version: st.version,
        minProfitBps: 3000,
      }),
    );
    expect(ok(await admin.get('/api/v1/quotes/settings')).minProfitBps).toBe(3000);
    expect(ok(await admin.get('/api/v1/quotes/last-of?phone=11999990000')).item).toBeNull();
    const sug = ok(await admin.get('/api/v1/quotes/delivery-suggestion?pieces=2'));
    expect(sug).toHaveProperty('aheadPieces');
    const profit = ok(await admin.get('/api/v1/reports/profit-by-piece?months=12'));
    expect(profit.items).toEqual([]);
    const times = ok(await admin.get('/api/v1/production/stage-times'));
    expect(times.days).toBe(120);
  });
});
