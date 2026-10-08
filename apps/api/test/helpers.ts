import { runSeed } from '@cenario/db/seed';
import { createPrismaClient, type PrismaClient } from '@cenario/db';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/config/env';

export const ORIGIN = 'http://localhost:3000';
export const ADMIN = { email: 'gestor@teste.local', password: 'SenhaDeTeste123' };

let shared: PrismaClient | null = null;
export function db(): PrismaClient {
  shared ??= createPrismaClient({ url: process.env.DATABASE_URL });
  return shared;
}

/** Limpa todas as tabelas (exceto o controle de migrations) e recria os dados base. */
export async function resetDatabase() {
  const prisma = db();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await runSeed({ withTeam: true, log: () => undefined });
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<App> {
  const env = loadEnv({ ...process.env, ...overrides });
  const built = await buildApp({ env, prisma: db(), logger: false, feedPollIntervalMs: 100 });
  return built;
}

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
  cookies: {
    name: string;
    value: string;
    httpOnly?: boolean;
    sameSite?: string;
    maxAge?: number;
  }[];
}

/** Cliente HTTP com "pote de cookies", simulando um navegador (painel ou tablet). */
export class Client {
  cookies = new Map<string, string>();
  constructor(
    private readonly app: App,
    public origin: string | null = ORIGIN,
  ) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const res = await this.app.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: {
        ...(this.origin ? { origin: this.origin } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader } : {}),
        ...headers,
      },
    });
    for (const c of res.cookies as Res['cookies'] & { expires?: Date }[]) {
      const expired =
        c.value === '' ||
        c.maxAge === 0 ||
        ((c as { expires?: Date }).expires?.getTime() ?? Infinity) < Date.now();
      if (expired) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let parsed: unknown = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = res.body;
    }
    return {
      status: res.statusCode,
      body: parsed,
      headers: res.headers,
      cookies: res.cookies as Res['cookies'],
    };
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.req('POST', url, body ?? {}, headers);
  put = (url: string, body?: unknown) => this.req('PUT', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);
}

export async function loginAdmin(app: App, creds = ADMIN): Promise<Client> {
  const c = new Client(app);
  const res = await c.post('/api/auth/login', creds);
  if (res.status !== 200)
    throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

export function idemKey() {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function employeeByName(name: string) {
  return db().employee.findFirstOrThrow({ where: { displayName: name } });
}

/** Cadastra um tablet, vincula-o num novo "navegador" e entra com o PIN do funcionário. */
export async function setupTablet(
  app: App,
  admin: Client,
  opts: { name: string; employee: string; pin: string; restrict?: boolean },
) {
  const employee = await employeeByName(opts.employee);
  const pinRes = await admin.put(`/api/employees/${employee.id}/pin`, { pin: opts.pin });
  if (pinRes.status !== 200) throw new Error(`pin: ${JSON.stringify(pinRes.body)}`);
  const created = await admin.post(
    '/api/devices',
    { name: opts.name, assignedEmployeeId: employee.id, restrictToAssigned: opts.restrict ?? true },
    { 'idempotency-key': idemKey() },
  );
  if (created.status !== 201) throw new Error(`device: ${JSON.stringify(created.body)}`);
  const tablet = new Client(app);
  const paired = await tablet.post('/api/tablet/pair', { code: created.body.pairing.code });
  if (paired.status !== 200) throw new Error(`pair: ${JSON.stringify(paired.body)}`);
  const login = await tablet.post('/api/tablet/login', { employeeId: employee.id, pin: opts.pin });
  if (login.status !== 200) throw new Error(`login tablet: ${JSON.stringify(login.body)}`);
  return { tablet, device: created.body.device, employee, me: login.body };
}

/** Conexão WebSocket de teste que acumula mensagens recebidas. */
export class WsClient {
  messages: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  ws!: WebSocket;
  closed: { code: number } | null = null;

  static async connect(app: App, client: Client, sinceSeq: string | null | undefined = null) {
    const w = new WsClient();
    const address = app.app.server.address();
    if (!address || typeof address === 'string') throw new Error('servidor não está ouvindo');
    w.ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime`, {
      headers: { cookie: client.cookieHeader, origin: client.origin ?? '' },
    });
    w.ws.on('message', (raw) => w.messages.push(JSON.parse(raw.toString())));
    w.ws.on('close', (code) => (w.closed = { code }));
    await new Promise<void>((resolve, reject) => {
      w.ws.once('open', () => resolve());
      w.ws.once('error', reject);
      w.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    await w.waitFor((m) => m.kind === 'hello');
    if (sinceSeq !== undefined) w.ws.send(JSON.stringify({ kind: 'resume', sinceSeq }));
    return w;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async waitFor(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `mensagem não recebida; recebidas: ${JSON.stringify(this.messages.map((m) => m.kind + ':' + (m.event?.type ?? '')))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  events(type?: string) {
    return this.messages
      .filter((m) => m.kind === 'event' && (!type || m.event.type === type))
      .map((m) => m.event);
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await new Promise((r) => this.ws.once('close', r));
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
