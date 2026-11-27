import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { hashSecret } from '../../../apps/api/src/lib/crypto';
import { E2E, rootEnv } from '../env';

/**
 * 2026-11-26 — Primeiro dia da empresa nova (itens 1, 2, 4, 5, 6 e 42 da lista de 53):
 * perguntas do começo, "Comece por aqui", explicação da tela, link de cadastro do funcionário,
 * "Quero ajuda para começar" e o painel da plataforma mostrando o passo. Dados fictícios.
 * Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/comeco-guiado';
const origin = `http://localhost:${E2E.webPort}`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

async function call(page: Page, method: 'POST' | 'GET', path: string, data?: unknown) {
  const r = await page.request.fetch(path, {
    method,
    data,
    headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
  });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.json();
}

test('capturas: primeiro dia da empresa nova', async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });

  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );

  // 1) Conta criada pelo site; depois do telefone, o sistema abre as perguntas sozinho.
  const ctx = await browser.newContext({ ...DESK, baseURL: origin });
  const p = await ctx.newPage();
  await p.goto('/entrar?criar=1');
  await p.getByTestId('signup-empresa').fill('Tapeçaria Bom Assento');
  await p.getByTestId('signup-nome').fill('Carla Mendes');
  await p.getByLabel('E-mail').fill('carla@bomassento.exemplo');
  await p.getByLabel('Senha', { exact: true }).fill('SenhaBoa123');
  await p.getByLabel('Confirmar senha').fill('SenhaBoa123');
  await p.getByRole('button', { name: 'Criar conta' }).click();
  const tel = p.getByTestId('welcome-whatsapp');
  await expect(tel).toBeVisible({ timeout: 20_000 });
  await tel.pressSequentially('12991234567');
  await p.getByRole('button', { name: 'Confirmar' }).click();
  await expect(p).toHaveURL(/\/painel\/comecar$/, { timeout: 20_000 });
  await expect(p.getByTestId('setup-wizard')).toBeVisible();

  let n = 1;
  const shot = async (name: string) => {
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png` });
  };
  const next = () => p.getByTestId('setup-proxima').click();

  // Peças
  for (const id of await p
    .locator('[data-testid^="peca-"]')
    .evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute('data-testid')!)))
    await p.getByTestId(id).click();
  await shot('pergunta-pecas');
  await next();
  // Tecidos
  for (const name of ['Suede', 'Linho']) {
    const chip = p.getByRole('button', { name, exact: true });
    if (await chip.count()) await chip.first().click();
  }
  await shot('pergunta-tecidos');
  await next();
  await shot('pergunta-espuma');
  await next();
  await shot('pergunta-frete');
  await next();
  await p.getByRole('button', { name: 'Sim, às vezes' }).click();
  await shot('pergunta-servico-na-casa');
  await next();
  await p.getByPlaceholder('Digite a cidade da oficina').fill('São José dos Ca');
  await p.getByRole('button', { name: 'São José dos Campos', exact: false }).first().click();
  await p.getByPlaceholder('Digite para acrescentar uma cidade').fill('Jacare');
  await p
    .getByRole('button', { name: /^Jacareí/ })
    .first()
    .click();
  await p.getByPlaceholder('Digite para acrescentar uma cidade').fill('Tauba');
  await p
    .getByRole('button', { name: /^Taubaté/ })
    .first()
    .click();
  await shot('pergunta-cidades');
  await next();
  await shot('pergunta-cartao');
  await next();
  await shot('pergunta-mei-simples');
  await next();
  await shot('pergunta-dias-horario');
  await next();
  await shot('pergunta-prazo');
  await next();
  await shot('pergunta-equipe');
  await next();
  await shot('pergunta-logo');
  await next();
  await shot('pergunta-meta');
  await p.getByTestId('setup-concluir').click();

  // 2) Início com o "Comece por aqui".
  await expect(p).toHaveURL(/\/painel$/, { timeout: 20_000 });
  await expect(p.getByTestId('getting-started')).toBeVisible();
  await expect(p.getByTestId('gs-step-perguntas')).toHaveAttribute('data-done', 'true');
  await shot('inicio-comece-por-aqui');

  // 3) Tabela de preços montada, com a explicação da tela na primeira vez.
  await p.getByTestId('gs-step-precos').click();
  await expect(p.getByTestId('page-tip')).toBeVisible();
  await shot('explicacao-da-tela');
  await p.getByTestId('page-tip-ok').click();
  await p.goto('/painel/orcamentos?tab=base&base=mao');
  await p.waitForTimeout(800);
  await shot('mao-de-obra-montada');
  await expect(p.getByTestId('page-tip')).toBeHidden();

  // 4) Funcionário cadastrado só com nome e celular; link de cadastro pelo WhatsApp.
  const roles = (await call(p, 'GET', '/api/roles')) as { id: string; key: string }[];
  const role = roles.find((r) => r.key === 'tapeceiro') ?? roles[0]!;
  await call(p, 'POST', '/api/employees', {
    fullName: 'Rogério Alves',
    displayName: 'Rogério',
    jobTitle: 'Tapeceiro',
    phone: '(12) 99876-5432',
    color: '#1b6e6e',
    roleIds: [role.id],
  });
  await p.goto('/painel/funcionarios');
  await expect(p.getByTestId('invite-Rogério')).toBeVisible();
  await shot('funcionarios-com-explicacao');
  await p.getByTestId('invite-Rogério').click();
  await expect(p.getByTestId('invite-whatsapp')).toBeVisible();
  const url = await p.getByTestId('invite-url').inputValue();
  await shot('link-de-cadastro');
  await p.keyboard.press('Escape');

  // 5) O funcionário abre o link no celular.
  const phone = await browser.newContext({ ...PHONE });
  const fp = await phone.newPage();
  await fp.goto(url.replace(/^https?:\/\/[^/]+/, origin));
  await expect(fp.getByTestId('invite-form')).toBeVisible();
  await fp.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-celular-do-funcionario.png`,
  });
  await fp.getByTestId('invite-pin').fill('402917');
  await fp.getByTestId('invite-pin2').fill('402917');
  await fp.getByTestId('invite-finish').click();
  await expect(fp.getByTestId('invite-done')).toBeVisible();
  await fp.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-celular-cadastro-feito.png`,
  });
  await phone.close();

  // 6) "Quero ajuda para começar".
  await p.goto('/painel');
  await expect(p.getByTestId('gs-step-equipe')).toHaveAttribute('data-done', 'true');
  await p.getByTestId('help-start').click();
  await p.getByTestId('help-slot').nth(1).click();
  await shot('quero-ajuda');
  await p.getByTestId('help-send').click();
  await expect(p.getByTestId('help-scheduled')).toBeVisible();
  await shot('inicio-ajuda-marcada');

  // 7) Celular do dono: Início com o "Comece por aqui".
  const own = await browser.newContext({ ...PHONE, storageState: await ctx.storageState() });
  const op = await own.newPage();
  await op.goto(`${origin}/painel`);
  await expect(op.getByTestId('getting-started')).toBeVisible();
  await op.waitForTimeout(400);
  await op.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-inicio-celular.png`,
    fullPage: true,
  });
  await own.close();
  await ctx.close();

  // 8) Painel da plataforma: em que passo a empresa parou e o pedido de ajuda.
  const pc = await browser.newContext({ ...DESK, baseURL: origin });
  const r = await pc.request.post('/api/plataforma/entrar', {
    data: { email: 'dono@plataforma.exemplo', password: 'PainelBom123' },
    headers: { origin },
  });
  expect(r.ok(), await r.text()).toBe(true);
  const pp = await pc.newPage();
  await pp.goto('/plataforma/empresas');
  await expect(pp.getByTestId('empresa-pediu-ajuda')).toBeVisible();
  await expect(pp.getByTestId('empresa-comeco').first()).toContainText('falta');
  await pp.screenshot({
    path: `${OUT}/${String(n++).padStart(2, '0')}-plataforma-empresas.png`,
    fullPage: true,
  });
  await pc.close();
  await db.end();
});
