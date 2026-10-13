import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { knownClientIp } from '../src/core/client-ip';
import { createTestApp, resetDatabase } from './helpers';

/**
 * Auditoria C3 — prova com o Caddy REAL e o Caddyfile de homologação: um X-Forwarded-For (ou
 * X-Real-IP/Forwarded) forjado pelo cliente não chega à API como IP real, e o limite anônimo
 * não é contornado através do proxy.
 *
 * Binário: CADDY_BIN (mesma versão da imagem caddy:2.10-alpine; o CI baixa e confere a soma).
 * No CI o teste é obrigatório; fora dele, sem o binário, é pulado com aviso.
 *
 * Únicas adaptações do Caddyfile para rodar aqui: destinos `api:4000`/`web:3000` trocados por
 * portas locais, site em http:// (sem certificado) e `admin off`. Cabeçalhos, autenticação do
 * proxy e roteamento são os do arquivo versionado.
 *
 * Endereços: o cliente conecta de 127.0.0.3; o Caddy conecta na API a partir de 127.0.0.1, que é
 * o único endereço em TRUST_PROXY (como o IP fixo do Caddy no Compose).
 */
const CADDY = process.env.CADDY_BIN;
const REQUIRED = Boolean(process.env.CI);
const ROOT = resolve(__dirname, '../../..');
const CADDYFILE = join(ROOT, 'infra/homolog/Caddyfile.homolog');
const GATE = 'a1b2c3d4e5f6a7b8';
const CLIENT_ADDR = '127.0.0.3';

if (!CADDY && !REQUIRED)
  console.warn('[proxy-caddy] CADDY_BIN não definido: teste do Caddy pulado (obrigatório no CI).');

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

function request(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, localAddress: CLIENT_ADDR, headers },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', fail);
    req.end();
  });
}

const FORGED = {
  'x-forwarded-for': '6.6.6.6, 7.7.7.7',
  'x-real-ip': '6.6.6.6',
  forwarded: 'for=6.6.6.6',
};

describe.skipIf(!CADDY && !REQUIRED)('Caddy de homologação na frente da API', () => {
  let api: App;
  let web: http.Server;
  let caddy: ChildProcess;
  let caddyPort = 0;
  let dir = '';
  const webSaw: http.IncomingHttpHeaders[] = [];
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    HOMOLOG_DOMAIN: `http://127.0.0.1:${caddyPort}`,
    HOMOLOG_BASIC_USER: 'teste',
    // bcrypt de 'senha-somente-teste' (fictícia, só para o Caddy carregar o basic_auth).
    HOMOLOG_BASIC_HASH: '$2a$14$GQhlzjuf3bQqAOv7yXIwuerbjSrfDt.RYp.x7maBmuyMM59Dwetjy',
    HOMOLOG_GATE_TOKEN: GATE,
    XDG_DATA_HOME: dir,
    XDG_CONFIG_HOME: dir,
    ...extra,
  });

  beforeAll(async () => {
    if (!CADDY) throw new Error('CADDY_BIN é obrigatório no CI (veja .github/workflows/ci.yml).');
    await resetDatabase();
    dir = mkdtempSync(join(tmpdir(), 'cenario-caddy-'));
    api = await createTestApp({
      TRUST_PROXY: '127.0.0.1',
      RATE_LIMIT_ANON_PER_MIN: '3',
      RATE_LIMIT_UNKNOWN_ANON_PER_MIN: '3',
    });
    // Rota de inspeção (só neste teste): o que a API concluiu sobre o cliente.
    api.app.get('/api/teste-ip', { config: { access: { public: true } } }, (request) => ({
      ip: request.ip,
      known: knownClientIp(request),
      xff: request.headers['x-forwarded-for'] ?? null,
      xRealIp: request.headers['x-real-ip'] ?? null,
      forwarded: request.headers.forwarded ?? null,
    }));
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const apiPort = (api.app.server.address() as net.AddressInfo).port;
    web = http.createServer((req, res) => {
      webSaw.push(req.headers);
      res.end('web');
    });
    await new Promise<void>((ok) => web.listen(0, '127.0.0.1', ok));
    const webPort = (web.address() as net.AddressInfo).port;
    caddyPort = await freePort();

    const original = readFileSync(CADDYFILE, 'utf8');
    expect(original).toContain('reverse_proxy api:4000');
    expect(original).toContain('reverse_proxy web:3000');
    const adapted = original
      .replace('reverse_proxy api:4000', `reverse_proxy 127.0.0.1:${apiPort}`)
      .replace('reverse_proxy web:3000', `reverse_proxy 127.0.0.1:${webPort}`)
      .replace(/^\{\n/m, '{\n\tadmin off\n');
    const file = join(dir, 'Caddyfile');
    writeFileSync(file, adapted);
    caddy = spawn(CADDY, ['run', '--config', file, '--adapter', 'caddyfile'], {
      env: env(),
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      const up = await request(caddyPort, '/api/health', {}).catch(() => null);
      if (up) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Caddy não respondeu');
  }, 60_000);

  afterAll(async () => {
    caddy?.kill();
    await api?.close();
    await new Promise((ok) => web?.close(ok));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('o Caddyfile versionado (sem adaptações) é válido', () => {
    const out = execFileSync(
      CADDY!,
      ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile'],
      {
        env: env({ HOMOLOG_DOMAIN: 'homolog.example.com' }),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(out).toContain('Valid configuration');
    const example = join(ROOT, 'infra/Caddyfile.example');
    execFileSync(CADDY!, ['validate', '--config', example, '--adapter', 'caddyfile'], {
      env: env(),
      stdio: 'ignore',
    });
  });

  it('cabeçalhos de IP forjados pelo cliente não chegam à API: o IP real é o da conexão', async () => {
    const r = await request(caddyPort, '/api/teste-ip', {
      cookie: `cenario_homolog=${GATE}`,
      ...FORGED,
    });
    expect(r.status).toBe(200);
    // 127.0.0.3 é loopback: a API o classifica como IP desconhecido (regra do proxy do Next),
    // mas o IP visto é exatamente o da conexão — nenhum valor forjado (6.6.6.6/7.7.7.7) passou.
    // O próprio Caddy entrega só o IP da conexão (sem os valores do cliente)...
    expect(JSON.parse(r.body)).toEqual({
      ip: CLIENT_ADDR,
      known: null,
      xff: CLIENT_ADDR,
      xRealIp: null,
      forwarded: null,
    });
  });

  it('o mesmo vale para o tráfego encaminhado ao Next.js', async () => {
    webSaw.length = 0;
    const r = await request(caddyPort, '/painel', { cookie: `cenario_homolog=${GATE}`, ...FORGED });
    expect(r.status).toBe(200);
    expect(webSaw[0]?.['x-forwarded-for']).toBe(CLIENT_ADDR);
    expect(webSaw[0]?.['x-real-ip']).toBeUndefined();
    expect(webSaw[0]?.forwarded).toBeUndefined();
  });

  // Se um XFF forjado chegasse como IP real, cada requisição teria um IP "conhecido" diferente
  // (10.0.x.x) e um contador próprio; como não chega, todas caem no mesmo contador e há 429.
  it('através do proxy, XFF e cookies inventados não criam contadores novos (limite anônimo 3)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(caddyPort, '/api/health', {
        cookie: `cenario_homolog=${GATE}; ${api.ctx.cookies.session}=${crypto.randomUUID()}`,
        'x-forwarded-for': `10.0.${i}.${i + 1}`,
      });
      codes.push(r.status);
    }
    // Os testes anteriores já usaram parte do mesmo contador.
    expect(codes).toContain(429);
    expect(codes.at(-1)).toBe(429);
  });

  it('sem a senha do proxy nada chega à API (401 do próprio Caddy)', async () => {
    const r = await request(caddyPort, '/api/teste-ip', FORGED);
    expect(r.status).toBe(401);
  });
});
