import { request as httpsRequest } from 'node:https';
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

/**
 * Acesso pelo navegador à homologação atrás do Caddy, do jeito que uma pessoa faz:
 * abrir o domínio → diálogo do proxy (Basic) → cookie do proxy → tela de entrada → login do gestor.
 * Roda contra a pilha local (docker-compose.homolog.yml) ou contra a VM real; credenciais só por
 * variáveis de ambiente (HOMOLOG_WEB_URL, HOMOLOG_BASIC_USER/PASSWORD, SEED_ADMIN_EMAIL/PASSWORD).
 * Nenhum valor secreto é impresso. Só leitura, exceto o login (cria uma sessão do gestor fictício).
 */
const WEB = process.env.HOMOLOG_WEB_URL!;
const PROXY = process.env.HOMOLOG_BASIC_USER
  ? { username: process.env.HOMOLOG_BASIC_USER, password: process.env.HOMOLOG_BASIC_PASSWORD ?? '' }
  : undefined;
const ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? '',
  password: process.env.SEED_ADMIN_PASSWORD ?? '',
};
const IGNORE_TLS = process.env.HOMOLOG_IGNORE_HTTPS === '1';
// A única resposta de erro esperada antes do login: a aplicação perguntando "quem sou eu?".
const ESPERADO_ANTES_DO_LOGIN = /\/api\/auth\/me$/;

// Credencial propositalmente inválida: impede que o contexto use a senha do proxy herdada da
// configuração; só o cookie pode deixar passar.
const INVALIDA = { username: 'sem-credencial', password: 'invalida' };

/** Requisição HTTPS "crua": nenhuma credencial nem cookie. */
function cru(path: string) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = httpsRequest(`${WEB}${path}`, { rejectUnauthorized: !IGNORE_TLS }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function novoContexto(browser: Browser, extra: BrowserContextOptions = {}) {
  return browser.newContext({ ignoreHTTPSErrors: IGNORE_TLS, ...extra });
}

/** Registra tudo o que daria uma tela em branco: respostas de erro, falhas, erros de JS e de console. */
function vigiar(page: Page) {
  const ev = {
    erros: [] as string[],
    falhas: [] as string[],
    js: [] as string[],
    console: [] as string[],
    ws: [] as string[],
  };
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.status() >= 400 && !ESPERADO_ANTES_DO_LOGIN.test(p)) ev.erros.push(`${r.status()} ${p}`);
  });
  page.on('requestfailed', (r) =>
    ev.falhas.push(`${new URL(r.url()).pathname}: ${r.failure()?.errorText}`),
  );
  page.on('pageerror', (e) => ev.js.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/status of 401/.test(m.text())) ev.console.push(m.text());
  });
  page.on('websocket', (w) => ev.ws.push(new URL(w.url()).pathname));
  return ev;
}

async function cookieDoProxy(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === 'cenario_homolog');
}

test.describe.serial('Acesso pelo navegador: proxy → tela de entrada → painel', () => {
  test.skip(!PROXY, 'Instância sem proxy de autenticação.');

  test('1. Sem credencial: 401 com explicação, sem cookie e sem anúncio de HTTP/3', async () => {
    const r = await cru('/');
    expect(r.status).toBe(401);
    expect(String(r.headers['www-authenticate'])).toMatch(/^Basic /);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(String(r.headers['alt-svc'] ?? '')).not.toMatch(/h3/);
    expect(String(r.headers['content-type'])).toContain('text/html');
    expect(r.body).toContain('usuário e a senha do proxy');
    expect(r.body).not.toContain(PROXY!.username); // não revela o usuário
  });

  test('2. Credencial errada no diálogo do proxy (usuário do gestor, maiúscula, senha do gestor): recusada', async ({
    browser,
  }) => {
    const erradas = [
      { username: ADMIN.email, password: PROXY!.password },
      {
        username: PROXY!.username.charAt(0).toUpperCase() + PROXY!.username.slice(1),
        password: PROXY!.password,
      },
      { username: PROXY!.username, password: ADMIN.password },
    ];
    for (const cred of erradas) {
      const ctx = await novoContexto(browser, { httpCredentials: cred });
      const r = await ctx.request.get(`${WEB}/`, { maxRedirects: 0 });
      expect(r.status()).toBe(401);
      expect(await ctx.cookies()).toHaveLength(0);
      await ctx.close();
    }
  });

  test('3. Senha do proxy certa: chega à tela de entrada, sem erros de carregamento ou de JavaScript', async ({
    browser,
  }) => {
    const ctx = await novoContexto(browser, { httpCredentials: PROXY });
    const page = await ctx.newPage();
    const ev = vigiar(page);
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(/\/entrar/);
    expect(page.url()).not.toBe('about:blank');
    await expect(page.getByRole('heading', { name: 'Entrar no painel' })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    const c = await cookieDoProxy(page);
    expect(c, 'cookie do proxy gravado').toBeTruthy();
    expect(c).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(ev.erros, 'respostas de erro').toEqual([]);
    expect(ev.falhas, 'requisições falhas').toEqual([]);
    expect(ev.js, 'erros de JavaScript').toEqual([]);
    expect(ev.console, 'erros no console').toEqual([]);
    await ctx.close();
  });

  test('4. Como o Safari pode fazer: sem reenviar a senha, só com o cookie do proxy', async ({
    browser,
  }) => {
    const ctx1 = await novoContexto(browser, { httpCredentials: PROXY });
    const p1 = await ctx1.newPage();
    await p1.goto(`${WEB}/`);
    const c = await cookieDoProxy(p1);
    await ctx1.close();
    const ctx = await novoContexto(browser, { httpCredentials: INVALIDA });
    await ctx.addCookies([c!]);
    const page = await ctx.newPage();
    const ev = vigiar(page);
    await page.goto(`${WEB}/entrar`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Entrar no painel' })).toBeVisible();
    expect([...ev.erros, ...ev.falhas, ...ev.js]).toEqual([]);
    await ctx.close();
  });

  test('5. Login do gestor fictício: painel aberto e tempo real (WebSocket) conectado', async ({
    browser,
  }) => {
    test.skip(!ADMIN.email || !ADMIN.password, 'Credenciais do gestor não informadas.');
    const ctx = await novoContexto(browser, { httpCredentials: PROXY });
    const page = await ctx.newPage();
    const ev = vigiar(page);
    await page.goto(`${WEB}/entrar`, { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/painel/, { timeout: 30_000 });
    expect((await ctx.cookies()).some((x) => x.name === '__Host-cen_sid')).toBe(true);
    await expect.poll(() => ev.ws, { timeout: 15_000 }).toContain('/api/realtime');
    expect([...ev.erros, ...ev.falhas, ...ev.js]).toEqual([]);
    await ctx.close();
  });
});
