import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
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

  // 1c) Tela Entrar: fala com quem já tem conta e convida quem ainda não tem.
  for (const [name, opts] of [
    ['0-entrar-computador', DESK],
    ['0b-entrar-celular', PHONE],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const p = await ctx.newPage();
    await p.goto('/entrar');
    await expect(p.getByTestId('criar-conta')).toBeVisible();
    if (name === '0-entrar-computador')
      await expect(p.getByTestId('entrar-boas-vindas')).toContainText('Bom te ver de novo');
    await expect(p.getByTestId('criar-conta')).toContainText('7 dias grátis');
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await ctx.close();
  }

  // 2) Criar conta preenchido (computador e celular): sem telefone no cadastro.
  for (const [name, opts] of [
    ['3-criar-conta-computador', DESK],
    ['4-criar-conta-celular', PHONE],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const p = await ctx.newPage();
    await p.goto('/entrar?criar=1');
    await p.getByTestId('signup-empresa').fill('Tapeçaria Bom Assento');
    await p.getByTestId('signup-nome').fill('Carla Mendes');
    await p.getByLabel('E-mail').fill('carla@bomassento.exemplo');
    await p.getByLabel('Senha', { exact: true }).fill('SenhaBoa123');
    await p.getByLabel('Confirmar senha').fill('SenhaBoa123');
    await expect(p.getByTestId('signup-whatsapp')).toHaveCount(0);
    await expect(p.getByTestId('signup-trial')).toContainText('R$ 399 por mês');
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await ctx.close();
  }

  // 3) Conta criada pela tela; a primeira coisa no sistema é a janela do telefone.
  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );
  await db.end();
  for (const [prefix, opts, d] of [
    [
      '6',
      DESK,
      {
        empresa: 'Tapeçaria Bom Assento',
        nome: 'Carla Mendes',
        email: 'carla@bomassento.exemplo',
        tel: '31991234567',
      },
    ],
    [
      '7',
      PHONE,
      {
        empresa: 'Estofados Primavera',
        nome: 'Jorge Lima',
        email: 'jorge@primavera.exemplo',
        tel: '41988776655',
      },
    ],
  ] as const) {
    const ctx = await browser.newContext({ ...opts, baseURL: origin });
    const p = await ctx.newPage();
    await p.goto('/entrar?criar=1');
    await p.getByTestId('signup-empresa').fill(d.empresa);
    await p.getByTestId('signup-nome').fill(d.nome);
    await p.getByLabel('E-mail').fill(d.email);
    await p.getByLabel('Senha', { exact: true }).fill('SenhaBoa123');
    await p.getByLabel('Confirmar senha').fill('SenhaBoa123');
    await p.getByRole('button', { name: 'Criar conta' }).click();
    const tel = p.getByTestId('welcome-whatsapp');
    await expect(tel).toBeVisible({ timeout: 20_000 });
    await expect(p.getByRole('dialog')).not.toContainText(/whatsapp/i);
    const confirmar = p.getByRole('button', { name: 'Confirmar' });
    await expect(confirmar).toBeDisabled();
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${prefix}-pede-telefone-vazio.png` });
    // Telefone fixo não passa: tem que ser celular com DDD e 9 números.
    await tel.pressSequentially('1133334444');
    await expect(
      p.getByText('Escreva o celular com DDD e 9 números', { exact: false }),
    ).toBeVisible();
    await expect(confirmar).toBeDisabled();
    await p.screenshot({ path: `${OUT}/${prefix}b-pede-telefone-fixo-nao-passa.png` });
    await tel.fill('');
    await tel.pressSequentially(d.tel);
    await expect(confirmar).toBeEnabled();
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${prefix}c-pede-telefone-preenchido.png` });
    await confirmar.click();
    await expect(tel).toBeHidden();
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
