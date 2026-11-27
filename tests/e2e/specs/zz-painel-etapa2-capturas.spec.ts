import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import pg from 'pg';
import { hashSecret } from '../../../apps/api/src/lib/crypto';
import { E2E, rootEnv } from '../env';

/**
 * 2026-11-27 — Etapa 2 da lista de 53 (itens 40, 41, 43–51): PIX com QR Code, comprovante pela
 * tela, demonstração marcada no site, de onde veio cada empresa, linha do tempo, mensagens
 * editáveis, preço de lançamento com prazo, telas usadas, sugestões agrupadas e encerrar empresa.
 * Dados fictícios. Prints em CAPTURAS_DIR.
 */
const OUT = process.env.CAPTURAS_DIR ?? 'test-results/painel-etapa2';
const origin = `http://localhost:${E2E.webPort}`;
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  locale: 'pt-BR',
};
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' };
const headers = () => ({ origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') });

async function call(
  req: APIRequestContext,
  method: 'POST' | 'GET' | 'PUT',
  path: string,
  data?: unknown,
) {
  const r = await req.fetch(path, { method, data, headers: headers() });
  expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
  return r.status() === 204 ? null : r.json();
}

let n = 1;
async function shot(p: Page, name: string, fullPage = false) {
  await p.waitForTimeout(350);
  await p.screenshot({ path: `${OUT}/${String(n++).padStart(2, '0')}-${name}.png`, fullPage });
}

test('capturas: painel da plataforma, etapa 2', async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });

  const db = new pg.Client({ connectionString: rootEnv().E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO platform_admins (id, email, display_name, password_hash)
     VALUES (gen_random_uuid(), 'dono@plataforma.exemplo', 'Dono', $1)
     ON CONFLICT (email) DO NOTHING`,
    [await hashSecret('PainelBom123')],
  );

  // Painel da plataforma: PIX cadastrado (com a cidade, que vai no QR Code).
  const pc = await browser.newContext({ ...DESK, baseURL: origin });
  const r = await pc.request.post('/api/plataforma/entrar', {
    data: { email: 'dono@plataforma.exemplo', password: 'PainelBom123' },
    headers: { origin },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await call(pc.request, 'PUT', '/api/v1/platform/settings', {
    pixKey: '(12) 99111-2233',
    pixName: 'Cenario Gestao',
    pixBank: 'Banco Exemplo',
    pixCity: 'São José dos Campos',
    whatsapp: '12991112233',
  });

  // Três tapeçarias fictícias, cada uma vinda de um lugar.
  const contas = [
    {
      companyName: 'Tapeçaria Bom Assento',
      ownerName: 'Carla Mendes',
      whatsapp: '(12) 99123-4567',
      email: 'carla@bomassento.exemplo',
      origem: 'indicacao:Tapeçaria do João',
    },
    {
      companyName: 'Estofados Primavera',
      ownerName: 'Marcos Lima',
      whatsapp: '(11) 98234-5678',
      email: 'marcos@primavera.exemplo',
      origem: 'blog:quanto-cobrar-reforma',
    },
    {
      companyName: 'Reforma & Cia Estofados',
      ownerName: 'Paula Rocha',
      whatsapp: '(19) 99345-6789',
      email: 'paula@reformaecia.exemplo',
      origem: 'anuncio:google',
    },
  ];
  const ctxs = [];
  for (const c of contas) {
    const ctx = await browser.newContext({ ...DESK, baseURL: origin });
    await call(ctx.request, 'POST', '/api/auth/signup', {
      ...c,
      password: 'SenhaBoa123',
      passwordConfirm: 'SenhaBoa123',
    });
    ctxs.push(ctx);
  }
  const [ca, cb] = ctxs as [(typeof ctxs)[0], (typeof ctxs)[0]];

  // Sugestões parecidas de empresas diferentes (item 50) e telas usadas (item 49).
  await call(ca.request, 'POST', '/api/v1/feedback', {
    kind: 'SUGESTAO',
    message: 'Queria mandar o orçamento em PDF direto pelo WhatsApp do cliente',
  });
  await call(cb.request, 'POST', '/api/v1/feedback', {
    kind: 'SUGESTAO',
    message: 'Mandar o orçamento em PDF pelo WhatsApp sem baixar antes',
  });
  await call(ctxs[2]!.request, 'POST', '/api/v1/feedback', {
    kind: 'SUGESTAO',
    message: 'Orçamento em PDF no WhatsApp com a logo',
  });
  await call(cb.request, 'POST', '/api/v1/feedback', {
    kind: 'SUGESTAO',
    message: 'Ver a agenda da semana no celular deitado',
  });
  const uso: [typeof ca, string, number][] = [
    [ca, 'painel', 14],
    [ca, 'painel/orcamentos', 22],
    [ca, 'painel/pedidos', 9],
    [ca, 'painel/financeiro', 4],
    [cb, 'painel', 8],
    [cb, 'painel/orcamentos', 11],
    [cb, 'painel/clientes', 5],
    [ctxs[2]!, 'painel', 3],
  ];
  // Uma visita de cada pela tela (o caminho real); o resto da contagem direto no banco.
  for (const [ctx, screen] of uso)
    await call(ctx.request, 'POST', '/api/v1/usage/screen', { screen });
  for (const [ctx, screen, times] of uso) {
    const email = contas[ctxs.indexOf(ctx)]!.email;
    await db.query(
      `UPDATE screen_views SET views = $3
        WHERE screen = $2 AND company_id = (SELECT company_id FROM users WHERE email = $1)`,
      [email, screen, times],
    );
  }

  // 1) Assinatura da tapeçaria: QR Code com o valor e o comprovante pela tela.
  const p = await ca.newPage();
  await p.goto('/painel/assinatura');
  await expect(p.getByTestId('pix-qr')).toBeVisible({ timeout: 20_000 });
  await shot(p, 'assinatura-qr-code', true);

  // Foto do comprovante (fictícia), feita na hora.
  const fake = await ca.newPage();
  await fake.setViewportSize({ width: 420, height: 620 });
  await fake.setContent(`<body style="font-family:sans-serif;padding:28px;background:#fff">
    <h2 style="color:#2a7a4b">Pix enviado</h2><p>R$ 399,00</p><p>Para: Cenario Gestao</p>
    <p>Banco Exemplo</p><p>27/11/2026 09:12</p><p style="color:#888">ID E0000000020261127091200000</p></body>`);
  const foto = await fake.screenshot();
  await fake.close();
  await p.getByTestId('comprovante-arquivo').setInputFiles({
    name: 'comprovante-pix.png',
    mimeType: 'image/png',
    buffer: foto,
  });
  await shot(p, 'assinatura-comprovante-escolhido');
  await p.getByTestId('comprovante-enviar').click();
  await expect(p.getByText('Recebemos o comprovante')).toBeVisible({ timeout: 15_000 });
  await shot(p, 'assinatura-comprovante-enviado');

  // Celular da tapeçaria: QR Code na tela pequena.
  const cbPhone = await browser.newContext({
    ...PHONE,
    storageState: await cb.storageState(),
    baseURL: origin,
  });
  const pb = await cbPhone.newPage();
  await pb.goto('/painel/assinatura');
  await expect(pb.getByTestId('pix-qr')).toBeVisible({ timeout: 20_000 });
  await shot(pb, 'assinatura-celular', true);
  await cbPhone.close();

  // 2) Site: "Agendar demonstração" abre a janela de marcar (item 44).
  const site = await browser.newContext({ ...DESK, baseURL: origin });
  await site.addInitScript(() => localStorage.setItem('cenario-cookies-v1', 'recusado'));
  const sp = await site.newPage();
  await sp.goto('/conheca?utm_source=instagram&utm_campaign=novembro');
  await sp.getByTestId('site-cta').click();
  await expect(sp.getByTestId('demo-dialog')).toBeVisible();
  await sp.getByTestId('demo-slot').nth(2).click();
  await sp.getByTestId('demo-nome').fill('Roberto Sales');
  await sp.getByTestId('demo-telefone').fill('(12) 99456-7890');
  await sp.getByTestId('demo-empresa').fill('Sales Tapeçaria');
  await sp.getByLabel('Cidade').fill('Taubaté');
  await shot(sp, 'site-marcar-demonstracao');
  await sp.getByTestId('demo-enviar').click();
  await expect(sp.getByTestId('demo-ok')).toBeVisible({ timeout: 15_000 });
  await shot(sp, 'site-demonstracao-marcada');
  await site.close();
  const sitePhone = await browser.newContext({ ...PHONE, baseURL: origin });
  await sitePhone.addInitScript(() => localStorage.setItem('cenario-cookies-v1', 'recusado'));
  const spp = await sitePhone.newPage();
  await spp.goto('/conheca');
  await spp.getByTestId('site-cta').click();
  await expect(spp.getByTestId('demo-dialog')).toBeVisible();
  await spp.getByTestId('demo-slot').nth(4).click();
  await spp.getByTestId('demo-nome').fill('Denise Prado');
  await spp.getByTestId('demo-telefone').fill('(35) 99567-8901');
  await shot(spp, 'site-demonstracao-celular');
  await spp.getByTestId('demo-enviar').click();
  await expect(spp.getByTestId('demo-ok')).toBeVisible({ timeout: 15_000 });
  await sitePhone.close();

  // Preço de lançamento com prazo (item 48) e anotação na linha do tempo (item 46).
  const list = (await call(pc.request, 'GET', '/api/v1/platform/companies')) as {
    items: { id: number; tradeName: string }[];
  };
  const idOf = (name: string) => list.items.find((c) => c.tradeName === name)!.id;
  await call(pc.request, 'PUT', `/api/v1/platform/companies/${idOf('Estofados Primavera')}`, {
    billingPriceCents: 29900,
    billingPriceUntil: '2027-03-31',
  });
  await call(
    pc.request,
    'POST',
    `/api/v1/platform/companies/${idOf('Tapeçaria Bom Assento')}/timeline`,
    {
      text: 'Liguei para a Carla: vai cadastrar a equipe na segunda.',
    },
  );

  // 3) Painel da plataforma.
  const pp = await pc.newPage();
  await pp.goto('/plataforma');
  await expect(pp.getByTestId('origens')).toBeVisible({ timeout: 20_000 });
  await shot(pp, 'plataforma-inicio', true);

  await pp.goto('/plataforma/cobranca');
  await expect(pp.getByTestId('comprovantes')).toBeVisible();
  await shot(pp, 'plataforma-cobranca-comprovante', true);

  await pp.goto('/plataforma/empresas');
  await expect(pp.getByTestId('empresa-origem').first()).toBeVisible();
  await shot(pp, 'plataforma-empresas', true);

  const cardA = pp.getByTestId('platform-company').filter({ hasText: 'Tapeçaria Bom Assento' });
  await cardA.getByTestId('empresa-linha-do-tempo').click();
  await expect(pp.getByTestId('linha-tempo')).toBeVisible();
  await shot(pp, 'plataforma-linha-do-tempo');
  await pp.keyboard.press('Escape');

  const cardP = pp.getByTestId('platform-company').filter({ hasText: 'Estofados Primavera' });
  await cardP.getByRole('button', { name: 'Editar' }).click();
  await expect(pp.getByLabel('Valor combinado vale até')).toBeVisible();
  await shot(pp, 'plataforma-preco-de-lancamento');
  await pp.keyboard.press('Escape');

  const cardC = pp.getByTestId('platform-company').filter({ hasText: 'Reforma & Cia Estofados' });
  await cardC.getByTestId('empresa-encerrar').click();
  await pp.getByLabel('Motivo').fill('Fechou a oficina.');
  await pp.getByTestId('encerrar-nome').fill('Reforma & Cia Estofados');
  await shot(pp, 'plataforma-encerrar-empresa');
  await pp.getByTestId('encerrar-confirmar').click();
  await expect(pp.getByTestId('empresa-encerrada')).toBeVisible({ timeout: 15_000 });
  await pp.getByTestId('empresa-encerrada').scrollIntoViewIfNeeded();
  await pp.waitForTimeout(4500); // o aviso verde some
  await shot(pp, 'plataforma-empresa-encerrada');

  await pp.goto('/plataforma/recebimento');
  await expect(pp.getByTestId('pix-qr')).toBeVisible();
  await expect(pp.getByTestId('mensagens-prontas')).toBeVisible();
  await shot(pp, 'plataforma-como-eu-recebo', true);

  await pp.goto('/plataforma/avisos');
  await expect(pp.getByTestId('demonstracoes')).toBeVisible();
  await expect(pp.getByTestId('sugestoes-agrupadas')).toBeVisible();
  await expect(pp.getByTestId('telas-usadas')).toBeVisible();
  await shot(pp, 'plataforma-avisos', true);

  // Confirmar o comprovante com 1 clique.
  await pp.goto('/plataforma/cobranca');
  await pp.getByTestId('comprovante-confirmar').first().click();
  await expect(pp.getByTestId('comprovante-linha')).toHaveCount(0, { timeout: 15_000 });
  await shot(pp, 'plataforma-cobranca-confirmado', true);

  for (const ctx of ctxs) await ctx.close();
  await pc.close();
  await db.end();
});
