import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Caddyfile de PRODUÇÃO com o Caddy REAL: o sistema interno continua fora dos buscadores
 * (X-Robots-Tag noindex) e só a página comercial pública (/conheca e /site/*) fica sem o
 * cabeçalho — quem decide se ela pode ser indexada é o próprio Next.js (SITE_COMERCIAL).
 *
 * Únicas adaptações para rodar aqui: destinos `api:4000`/`web:3000` trocados por um servidor
 * local, domínios em http:// (sem certificado) e `admin off`. Mesmo binário de proxy-caddy.test.ts.
 */
const CADDY = process.env.CADDY_BIN;
const REQUIRED = Boolean(process.env.CI);
const ROOT = resolve(__dirname, '../../..');
const CADDYFILE = join(ROOT, 'infra/prod/Caddyfile.prod');

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => ok(port));
    });
  });
}

function get(port: number, path: string): Promise<http.IncomingMessage> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => ok(res));
    });
    req.on('error', fail);
    req.end();
  });
}

describe.skipIf(!CADDY && !REQUIRED)('Caddy de produção: indexação', () => {
  let backend: http.Server;
  let caddy: ChildProcess;
  let port = 0;
  let dir = '';
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PROD_DOMAIN: `http://127.0.0.1:${port}`,
    PROD_DOMAIN_WWW: `http://www.localhost:${port}`,
    XDG_DATA_HOME: dir,
    XDG_CONFIG_HOME: dir,
    ...extra,
  });

  beforeAll(async () => {
    if (!CADDY) throw new Error('CADDY_BIN é obrigatório no CI (veja .github/workflows/ci.yml).');
    dir = mkdtempSync(join(tmpdir(), 'cenario-caddy-prod-'));
    backend = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((ok) => backend.listen(0, '127.0.0.1', ok));
    const backendPort = (backend.address() as net.AddressInfo).port;
    port = await freePort();

    const original = readFileSync(CADDYFILE, 'utf8');
    expect(original).toContain('reverse_proxy api:4000');
    expect(original).toContain('reverse_proxy web:3000');
    const adapted = original
      .replace('reverse_proxy api:4000', `reverse_proxy 127.0.0.1:${backendPort}`)
      .replace('reverse_proxy web:3000', `reverse_proxy 127.0.0.1:${backendPort}`)
      .replace(/^\{\n/m, '{\n\tadmin off\n');
    const file = join(dir, 'Caddyfile');
    writeFileSync(file, adapted);
    caddy = spawn(CADDY, ['run', '--config', file, '--adapter', 'caddyfile'], {
      env: env(),
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      const up = await get(port, '/api/health').catch(() => null);
      if (up) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Caddy não respondeu');
  }, 60_000);

  afterAll(async () => {
    caddy?.kill();
    await new Promise((ok) => backend?.close(ok));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('o Caddyfile versionado (sem adaptações) é válido', () => {
    const out = execFileSync(
      CADDY!,
      ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile'],
      {
        env: env({ PROD_DOMAIN: 'exemplo.com.br', PROD_DOMAIN_WWW: 'www.exemplo.com.br' }),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(out).toContain('Valid configuration');
  });

  it('o sistema interno continua com noindex', async () => {
    for (const path of ['/', '/painel', '/tablet', '/entrar', '/api/health', '/conheca-x']) {
      const r = await get(port, path);
      expect(r.headers['x-robots-tag'], path).toBe('noindex, nofollow');
      expect(r.headers['x-content-type-options'], path).toBe('nosniff');
    }
  });

  it('a página comercial e as imagens dela não recebem o noindex do proxy', async () => {
    for (const path of ['/conheca', '/site/inicio.webp']) {
      const r = await get(port, path);
      expect(r.statusCode, path).toBe(200);
      expect(r.headers['x-robots-tag'], path).toBeUndefined();
      // Os demais cabeçalhos de segurança continuam.
      expect(r.headers['x-content-type-options'], path).toBe('nosniff');
      expect(r.headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    }
  });
});
