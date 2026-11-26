import { mkdirSync } from 'node:fs';
import { expect, test, type Browser } from '@playwright/test';
import pg from 'pg';
import { hashSecret } from '../../../apps/api/src/lib/crypto';
import { E2E, rootEnv } from '../env';

/**
 * 2026-11-26 — Criar conta pede nome da empresa, nome e WhatsApp; empresa antiga sem WhatsApp
 * informa ao entrar; painel da plataforma mostra o contato; landing com Criar conta + Entrar e o
 * botão Agendar demonstração flutuando. Dados fictícios. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/cadastro-whatsapp';
const origin = `http://localhost:${E2E.webPort}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

async function signup(
  browser: Browser,
  d: { companyName: string; ownerName: string; whatsapp: string; email: string },
) {
  const ctx = await browser.newContext({ baseURL: origin });
  const r = await ctx.request.post('/api/auth/signup', {
    data: { ...d, password: 'SenhaBoa123', passwordConfirm: 'SenhaBoa123' },
    headers: { origin },
  });
  expect(r.status(), await r.text()).toBe(201);
  return ctx;
}

test('cadastro com WhatsApp, empresa antiga e painel da plataforma', async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });

  // 1) Landing (computador e celular).
  for (const [name, opts] of [
    ['1-landing-computador', DESK],
    ['2-landing-celular', PHONE],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    await ctx.addInitScript(() => localStorage.setItem('cenario-cookies-v1', 'recusado'));
    const p = await ctx.newPage();
    await p.goto('/conheca');
    await expect(p.getByTestId('site-cta')).toBeVisible();
    await p.screenshot({ path: `${OUT}/${name}.png` });
    if (name === '1-landing-computador') {
      await p.mouse.wheel(0, 2400);
      await p.waitForTimeout(400);
      await p.screenshot({ path: `${OUT}/1b-landing-rolada-duvidas-continua.png` });
      // A tarja do topo some ao rolar e, fechada no X, não volta mais.
      await expect(p.getByTestId('site-tarja')).not.toBeInViewport();
      await p.mouse.wheel(0, -4000);
      await p.getByTestId('site-tarja-fechar').click();
      await expect(p.getByTestId('site-tarja')).toBeHidden();
      await p.reload();
      await expect(p.getByTestId('site-cta')).toBeVisible();
      await expect(p.getByTestId('site-tarja')).toBeHidden();
      await p.screenshot({ path: `${OUT}/1e-landing-depois-de-fechar-a-tarja.png` });
    }
    await ctx.close();
  }

  // 2) Criar conta preenchido (computador e celular).
  for (const [name, opts] of [
    ['3-criar-conta-computador', DESK],
    ['4-criar-conta-celular', PHONE],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const p = await ctx.newPage();
    await p.goto('/entrar?criar=1');
    await p.getByTestId('signup-empresa').fill('Tapeçaria Bom Assento');
    await p.getByTestId('signup-nome').fill('Carla Mendes');
    await p.getByTestId('signup-whatsapp').pressSequentially('31991234567');
    await p.getByLabel('E-mail').fill('carla@bomassento.exemplo');
    await p.getByLabel('Senha', { exact: true }).fill('SenhaBoa123');
    await p.getByLabel('Confirmar senha').fill('SenhaBoa123');
    await expect(p.getByTestId('signup-whatsapp')).toHaveValue('(31) 99123-4567');
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    if (name === '4-criar-conta-celular') {
      // Sem o WhatsApp: o cadastro não passa.
      await p.getByTestId('signup-whatsapp').fill('');
      await p.getByRole('button', { name: 'Criar conta' }).click();
      await expect(p.getByText(/WhatsApp com DDD/).last()).toBeVisible();
      await p.screenshot({ path: `${OUT}/5-criar-conta-sem-whatsapp.png`, fullPage: true });
    }
    await ctx.close();
  }

  // 3) Duas empresas: uma nova (com WhatsApp) e uma "antiga" (sem WhatsApp).
  await (
    await signup(browser, {
      companyName: 'Tapeçaria Bom Assento',
      ownerName: 'Carla Mendes',
      whatsapp: '(31) 99123-4567',
      email: 'carla@bomassento.exemplo',
    })
  ).close();
  await (
    await signup(browser, {
      companyName: 'Estofados Primavera',
      ownerName: 'Jorge Lima',
      whatsapp: '(41) 98877-6655',
      email: 'jorge@primavera.exemplo',
    })
  ).close();
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE company_settings SET phone = NULL WHERE email = 'jorge@primavera.exemplo'`,
  );
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );
  await db.end();

  // 4) Empresa antiga entra e precisa informar o WhatsApp.
  for (const [name, opts] of [
    ['6-empresa-antiga-pede-whatsapp', DESK],
    ['7-empresa-antiga-pede-whatsapp-celular', PHONE],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const login = await ctx.request.post('/api/auth/login', {
      data: { email: 'jorge@primavera.exemplo', password: 'SenhaBoa123' },
      headers: { origin },
    });
    expect(login.ok(), await login.text()).toBe(true);
    const p = await ctx.newPage();
    await p.goto('/painel');
    await expect(p.getByTestId('welcome-whatsapp')).toBeVisible();
    await p.getByTestId('welcome-whatsapp').pressSequentially('41988776655');
    const salvar = p.getByRole('button', { name: 'Salvar' });
    await expect(salvar).toBeEnabled();
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    if (name === '7-empresa-antiga-pede-whatsapp-celular') {
      await salvar.click();
      await expect(p.getByTestId('welcome-whatsapp')).toBeHidden();
    }
    await ctx.close();
  }

  // 5) Painel da plataforma, aba Empresas (depois que a Primavera informou).
  await shotPanel('8-painel-empresas', DESK);
  await shotPanel('9-painel-empresas-celular', PHONE);

  async function shotPanel(name: string, opts: typeof DESK | typeof PHONE) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const r = await ctx.request.post('/api/plataforma/entrar', {
      data: { email: 'dono@plataforma.exemplo', password: 'PainelBom123' },
      headers: { origin },
    });
    expect(r.ok(), await r.text()).toBe(true);
    const p = await ctx.newPage();
    await p.goto('/plataforma/empresas');
    await expect(p.getByTestId('empresa-chamar-whatsapp').first()).toBeVisible();
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await ctx.close();
  }
});
