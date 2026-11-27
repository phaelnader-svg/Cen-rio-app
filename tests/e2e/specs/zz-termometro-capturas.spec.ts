import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { hashSecret } from '../../../apps/api/src/lib/crypto';
import { E2E, rootEnv } from '../env';

/**
 * 2026-11-27 — Termômetro de uso no painel da plataforma: os 5 passos de cada empresa, os dias em
 * que ela entrou e o aviso de quem está no teste e parou de entrar (com o WhatsApp pronto).
 * Dados fictícios. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/termometro';
const origin = `http://localhost:${E2E.webPort}`;
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  locale: 'pt-BR',
};
const headers = () => ({ origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') });

async function call(req: APIRequestContext, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await req.fetch(path, { method, data, headers: headers() });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}

async function shot(p: Page, name: string, fullPage = false) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

test('capturas: termômetro das empresas', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );

  const contas = [
    {
      companyName: 'Estofados Bela Vista',
      ownerName: 'Sandra Moraes',
      whatsapp: '(12) 99421-7788',
      email: 'sandra@belavista.exemplo',
    },
    {
      companyName: 'Tapeçaria Dois Irmãos',
      ownerName: 'Renato Farias',
      whatsapp: '(11) 98512-3344',
      email: 'renato@doisirmaos.exemplo',
    },
    {
      companyName: 'Atelier do Estofado',
      ownerName: 'Cláudia Neves',
      whatsapp: '(19) 99633-1122',
      email: 'claudia@atelier.exemplo',
    },
  ];
  const ids: number[] = [];
  for (const c of contas) {
    const ctx = await browser.newContext({ ...DESK, baseURL: origin });
    await call(ctx.request, 'POST', '/api/auth/signup', {
      ...c,
      password: 'SenhaBoa123',
      passwordConfirm: 'SenhaBoa123',
    });
    const { rows } = await db.query('SELECT company_id FROM users WHERE email = $1', [c.email]);
    ids.push(rows[0].company_id);
    // A primeira usa de verdade: cliente e pedido (orçamento aprovado) pela própria conta.
    if (ids.length === 1) {
      const cust = await call(ctx.request, 'POST', '/api/v1/customers', {
        kind: 'PF',
        name: 'Cliente da Sandra',
        phone: null,
        allowSimilar: true,
        addresses: [
          {
            label: 'Casa',
            street: 'Rua Fictícia',
            number: '1',
            district: 'Centro',
            city: 'Taubaté',
            state: 'SP',
            postalCode: '12000-000',
          },
        ],
      });
      await call(ctx.request, 'POST', '/api/v1/orders', {
        customerId: cust.id,
        pickupAddressId: cust.addresses[0].id,
        contractedService: 'Reforma',
        agreedValueCents: 180000,
        paymentTerms: 'À vista',
        items: [{ pieceType: 'SOFA', description: 'Sofá retrátil', quantity: 1 }],
      });
    }
    await ctx.close();
  }
  const [a, b, c] = ids as [number, number, number];
  const ago = (d: number) => `now() - interval '${d} days'`;

  // Bela Vista: cadastro há 9 dias, orçamento, pedido, convite e 6 dias de uso.
  await db.query(`UPDATE company_settings SET created_at = ${ago(9)} WHERE id = $1`, [a]);
  await db.query(
    `INSERT INTO quotes (id, company_id, number, customer_name, service, total_cents, snapshot, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 10200, 'Cliente da Sandra', 'Reforma de Sofá', 180000, '{}'::jsonb, ${ago(8)}, now())`,
    [a],
  );
  await db.query(
    `INSERT INTO employee_invites (id, company_id, employee_id, token_hash, expires_at, created_at)
     SELECT gen_random_uuid(), $1, e.id, md5(random()::text), now() + interval '7 days', ${ago(6)}
       FROM employees e WHERE e.company_id = $1 LIMIT 1`,
    [a],
  );
  for (const d of [9, 8, 6, 4, 2, 0])
    await db.query(
      `INSERT INTO screen_views (company_id, screen, day, views) VALUES ($1, 'painel', (${ago(d)})::date, 5)
       ON CONFLICT DO NOTHING`,
      [a],
    );
  // Dois Irmãos: cadastro há 4 dias, entrou só no primeiro dia (parou: aviso vermelho).
  await db.query(`UPDATE company_settings SET created_at = ${ago(4)} WHERE id = $1`, [b]);
  await db.query(
    `UPDATE sessions SET created_at = ${ago(4)}, last_seen_at = ${ago(4)} + interval '20 minutes' WHERE company_id = $1`,
    [b],
  );
  await db.query(`UPDATE users SET last_login_at = ${ago(4)} WHERE company_id = $1`, [b]);
  await db.query(`UPDATE screen_views SET day = (${ago(4)})::date WHERE company_id = $1`, [b]);
  await db.query(
    `INSERT INTO quotes (id, company_id, number, customer_name, service, total_cents, snapshot, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 10200, 'Teste', 'Reforma de Poltrona', 90000, '{}'::jsonb, ${ago(4)}, now())`,
    [b],
  );
  // Atelier: criou a conta hoje e ainda não fez nada.
  void c;

  const pc = await browser.newContext({ ...DESK, baseURL: origin });
  const r = await pc.request.post('/api/plataforma/entrar', {
    data: { email: 'dono@plataforma.exemplo', password: 'PainelBom123' },
    headers: { origin },
  });
  expect(r.ok(), await r.text()).toBe(true);
  const pp = await pc.newPage();
  await pp.goto('/plataforma/empresas', { waitUntil: 'networkidle' });
  const card = (name: string) => pp.getByTestId('platform-company').filter({ hasText: name });
  await expect(card('Tapeçaria Dois Irmãos').getByTestId('empresa-parada')).toBeVisible();
  await expect(card('Estofados Bela Vista').getByTestId('empresa-parada')).toHaveCount(0);
  await card('Estofados Bela Vista').scrollIntoViewIfNeeded();
  await shot(pp, '1-empresas-termometro', true);

  // No celular (o aviso leva para cá): o card da empresa parada com o WhatsApp pronto.
  const mc = await browser.newContext({ ...PHONE, baseURL: origin });
  await mc.addCookies(await pc.cookies());
  const mp = await mc.newPage();
  await mp.goto(`/plataforma/empresas?parada=${b}`, { waitUntil: 'networkidle' });
  const parada = mp.getByTestId('platform-company').filter({ hasText: 'Tapeçaria Dois Irmãos' });
  await parada.scrollIntoViewIfNeeded();
  await shot(mp, '2-celular-empresa-parada');
  const href = await parada.getByTestId('empresa-oferecer-ajuda').getAttribute('href');
  expect(decodeURIComponent(href ?? '')).toContain('Travou em alguma coisa?');
  await db.end();
});
