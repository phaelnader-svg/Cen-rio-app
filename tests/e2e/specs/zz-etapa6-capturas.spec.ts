import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@cenario/db';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { createSystemPrisma } from '../../../apps/api/src/core/tenant';
import { hashSecret } from '../../../apps/api/src/lib/crypto';
import { companyCopiesRound } from '../../../apps/api/src/modules/platform/company-copies';
import { E2E, rootEnv } from '../env';

/**
 * Etapa 6 da lista de 53: recuperar os dados de uma empresa só (52) e limpeza automática das
 * encerradas há 90 dias (aviso por e-mail uma semana antes, planilhas no arquivo). Dados
 * fictícios. Roda a rodada diária de verdade (mesmo código do servidor). Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/etapa6';
const origin = `http://localhost:${E2E.webPort}`;
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' };
const headers = () => ({ origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') });
// O mesmo STORAGE_DIR da API do E2E (playwright.config.ts: '../../storage-e2e' a partir de apps/api).
const STORAGE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../storage-e2e');

async function call(req: APIRequestContext, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await req.fetch(path, { method, data, headers: headers() });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}

let n = 1;
async function shot(p: Page, name: string, fullPage = false) {
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png`, fullPage });
}

test('capturas: etapa 6 (recuperar uma empresa e limpeza das encerradas)', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  // Cópias e arquivo de rodadas anteriores (outra base de teste) ficam de fora.
  for (const d of ['copias-empresas', 'arquivo-empresas'])
    rmSync(resolve(STORAGE, d), { recursive: true, force: true });
  const env = rootEnv();
  const db = new pg.Client({ connectionString: env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );
  await db.query(`UPDATE platform_settings SET whatsapp = '12999990000'`).catch(() => undefined);

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
    if (ids.length === 1)
      for (const name of ['Maria Aparecida', 'João Batista', 'Lúcia Ferraz', 'Pedro Henrique'])
        await call(ctx.request, 'POST', '/api/v1/customers', {
          kind: 'PF',
          name,
          phone: null,
          allowSimilar: true,
        });
    await ctx.close();
  }
  const [bela, dois, atelier] = ids as [number, number, number];

  // Painel da plataforma.
  const pc = await browser.newContext({
    ...DESK,
    baseURL: origin,
    timezoneId: 'America/Sao_Paulo',
  });
  const login = await pc.request.post('/api/plataforma/entrar', {
    data: { email: 'dono@plataforma.exemplo', password: 'PainelBom123' },
    headers: { origin },
  });
  expect(login.ok(), await login.text()).toBe(true);
  for (const [id, name, reason] of [
    [dois, 'Tapeçaria Dois Irmãos', 'Fechou a oficina'],
    [atelier, 'Atelier do Estofado', 'Mudou de ramo'],
  ] as const)
    await call(pc.request, 'POST', `/api/v1/platform/companies/${id}/close`, {
      reason,
      confirmName: name,
    });
  // Dois Irmãos encerrada há 85 dias (apaga em 5); Atelier há 91 (apaga hoje).
  await db.query(
    `UPDATE company_settings SET closed_at = now() - interval '85 days', purge_after = now() + interval '5 days' WHERE id = $1`,
    [dois],
  );
  await db.query(
    `UPDATE company_settings SET closed_at = now() - interval '91 days', purge_after = now() - interval '1 day' WHERE id = $1`,
    [atelier],
  );

  // A rodada diária de verdade: cópia do dia, aviso dos 7 dias e limpeza do Atelier.
  const base = createPrismaClient({ url: env.E2E_DATABASE_URL });
  const r = await companyCopiesRound({
    owner: base,
    system: createSystemPrisma(base),
    storageDir: STORAGE,
    webUrl: origin,
    log: { warn: (o: unknown, m: string) => console.warn(m, o) } as never,
  });
  await base.$disconnect();
  expect(r.notices).toBe(1);
  expect(r.purged).toBe(1);

  // Depois da cópia, a Bela Vista "apagou" dois clientes sem querer.
  await db.query(
    `DELETE FROM customers WHERE company_id = $1 AND name IN ('João Batista', 'Lúcia Ferraz')`,
    [bela],
  );

  const pp = await pc.newPage();
  await pp.goto('/plataforma/empresas', { waitUntil: 'networkidle' });
  const card = (name: string) => pp.getByTestId('platform-company').filter({ hasText: name });
  await card('Estofados Bela Vista').scrollIntoViewIfNeeded();
  await shot(pp, 'empresas-botao-recuperar');
  await card('Estofados Bela Vista').getByTestId('empresa-recuperar').click();
  await expect(pp.getByTestId('recuperar-copias')).toBeVisible();
  await shot(pp, 'recuperar-escolher-copia');
  await pp.getByTestId('recuperar-copias').getByRole('button').first().click();
  await expect(pp.getByTestId('recuperar-comparar').getByRole('table')).toBeVisible();
  await pp.getByTestId('recuperar-nome').fill('Estofados Bela Vista');
  await shot(pp, 'recuperar-comparar-confirmar');
  await pp.getByTestId('recuperar-confirmar').click();
  await expect(pp.getByText(/voltou para a cópia de/)).toBeVisible();
  await shot(pp, 'recuperar-pronto');
  const { rows: back } = await db.query(
    `SELECT count(*)::int AS n FROM customers WHERE company_id = $1`,
    [bela],
  );
  expect(back[0].n).toBe(4);
  // A lista agora tem a cópia de "antes" (para desfazer).
  await card('Estofados Bela Vista').getByTestId('empresa-recuperar').click();
  await expect(pp.getByText('Antes de recuperar (para desfazer)')).toBeVisible();
  await shot(pp, 'recuperar-lista-com-antes');
  await pp.keyboard.press('Escape');

  // Encerrada que vai ser apagada e o arquivo da que já foi (espera o aviso verde sumir).
  await pp.waitForTimeout(7000);
  await pp.getByTestId('arquivo-empresas').scrollIntoViewIfNeeded();
  await shot(pp, 'encerrada-e-arquivo');

  // Os e-mails (o mesmo HTML que vai para a caixa de entrada).
  const mails = await db.query(
    `SELECT kind, "to", subject, html FROM outbound_emails
      WHERE kind IN ('empresa-sera-apagada', 'plataforma-empresa-apagar', 'plataforma-empresa-apagada')
      ORDER BY created_at`,
  );
  const mp = await pc.newPage();
  for (const m of mails.rows as { kind: string; to: string; subject: string; html: string }[]) {
    await mp.setContent(
      `<div style="font:14px sans-serif;padding:16px 24px;border-bottom:1px solid #ddd;background:#f7f7f5">
         <b>Para:</b> ${m.to}<br><b>Assunto:</b> ${m.subject}</div>${m.html}`,
    );
    await shot(mp, `email-${m.kind}`, true);
  }
  await db.end();
});
