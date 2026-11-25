import { resetPlatformConfigCache } from '../src/core/platform-config';
import { runSeed } from '@cenario/db/seed';
import { createPrismaClient, scopedPrismaClient, type PrismaClient } from '@cenario/db';
import { currentCompanyId, runAsCompany } from '../src/core/tenant';
import WebSocket from 'ws';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/config/env';

export const ORIGIN = 'http://localhost:3000';
export const ADMIN = { email: 'gestor@teste.local', password: 'SenhaDeTeste123' };

let shared: PrismaClient | null = null;
let sharedSystem: PrismaClient | null = null;
/** Conexão direta (dona das tabelas): só para limpar o banco entre os testes. */
export function rawDb(): PrismaClient {
  shared ??= createPrismaClient({ url: process.env.DATABASE_URL });
  return shared;
}
/**
 * Banco "do sistema" para preparar e conferir dados nos testes: enxerga todas as empresas
 * (multi-empresa). Linhas novas sem empresa explícita vão para a empresa definida em
 * `asCompany` (padrão: 1, a Cenário Estofados).
 */
export function db(): PrismaClient {
  sharedSystem ??= scopedPrismaClient(rawDb(), () => ({
    companyId: currentCompanyId() ?? 1,
    bypass: true,
  }));
  return sharedSystem;
}

/** Limpa todas as tabelas (exceto o controle de migrations) e recria os dados base. */
/**
 * Etapa E1: as travas de materiais vêm DESLIGADAS por padrão. As suítes que provam o controle
 * formal de materiais (a produção esperando compra recebida ou reserva) usam este reset, que grava
 * a trava LIGADA — o estado de uma instalação que escolheu esse controle em Empresa → Funcionalidades.
 */
export async function resetDatabaseWithMaterialsGate() {
  await resetDatabase();
  await db().moduleSetting.create({ data: { key: 'materiais', enabled: true } });
}

export async function resetDatabase() {
  const prisma = rawDb();
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // Suítes com `startBackground()` mantêm tarefas periódicas gravando entre os testes; o TRUNCATE
  // de várias tabelas pode entrar em deadlock com uma delas (40P01 — o PostgreSQL aborta um dos
  // lados). Repetir o TRUNCATE é a resolução padrão; qualquer outro erro sobe na hora.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(
        `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
      break;
    } catch (e) {
      if (attempt >= 3 || !/40P01|deadlock detected/.test(String(e))) throw e;
    }
  }
  await runSeed({ withTeam: true, log: () => undefined });
  // Painel da plataforma: a configuração (preços, bloqueio) volta aos valores de fábrica.
  resetPlatformConfigCache();
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<App> {
  const env = loadEnv({ ...process.env, ...overrides });
  const built = await buildApp({ env, prisma: rawDb(), logger: false, feedPollIntervalMs: 100 });
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
  /** Endereço da conexão vista pela API e cabeçalhos de rede extras (ex.: X-Forwarded-For). */
  remoteAddress = '127.0.0.1';
  networkHeaders: Record<string, string> = {};
  constructor(
    private readonly app: App,
    public origin: string | null = ORIGIN,
  ) {}

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async req(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const res = await this.app.app.inject({
      method,
      url,
      remoteAddress: this.remoteAddress,
      payload: body === undefined ? undefined : (body as object),
      headers: {
        ...this.networkHeaders,
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
  put = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.req('PUT', url, body ?? {}, headers);
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
/**
 * Rodada 2 (F8-15b): tira das mensagens do tempo real o aviso próprio "seus ganhos mudaram"
 * (`finance.own_changed`), que só pode chegar ao próprio dono e sem nenhum valor — falha se
 * chegar a outra pessoa ou carregar números. O restante segue para as asserções de privacidade.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withoutOwnChanged(messages: any[], userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const own = (m: any) => m?.event?.type === 'finance.own_changed';
  for (const m of messages.filter(own)) {
    if (m.event.aggregateId !== userId)
      throw new Error(`finance.own_changed de outra pessoa: ${JSON.stringify(m.event)}`);
    if (/Cents|\d{3,}/.test(JSON.stringify(m.event.payload)))
      throw new Error(`finance.own_changed com valores: ${JSON.stringify(m.event.payload)}`);
  }
  return messages.filter((m) => !own(m));
}

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

  /**
   * Espera, por evento (cada mensagem recebida é testada no ato), a primeira mensagem que
   * satisfaz `pred`. Prazo padrão de 15 s: sob carga (suíte da API em paralelo com o E2E) a
   * entrega pelo outbox passou de 5 s. Esgotar o prazo ou o socket fechar continua sendo FALHA.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitFor(pred: (m: any) => boolean, timeoutMs = 15_000): Promise<any> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    const received = () =>
      JSON.stringify(this.messages.map((m) => m.kind + ':' + (m.event?.type ?? '')));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.ws.off('message', onMessage);
        this.ws.off('close', onClose);
      };
      // Roda depois do listener que acumula `messages` (registrado na conexão).
      const onMessage = () => {
        const m = this.messages.find(pred);
        if (m) {
          done();
          resolve(m);
        }
      };
      const onClose = (code: number) => {
        done();
        reject(new Error(`conexão fechada (${code}) antes da mensagem; recebidas: ${received()}`));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`mensagem não recebida em ${timeoutMs} ms; recebidas: ${received()}`));
      }, timeoutMs);
      this.ws.on('message', onMessage);
      this.ws.on('close', onClose);
    });
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

let sharedOwner: PrismaClient | null = null;
/**
 * Dono das tabelas, atravessando empresas: para testes que aplicam e revertem migrations (DDL)
 * dentro de uma transação.
 */
export function ownerDb(): PrismaClient {
  sharedOwner ??= scopedPrismaClient(rawDb(), () => ({
    companyId: currentCompanyId() ?? 1,
    bypass: true,
    owner: true,
  }));
  return sharedOwner;
}

/**
 * Multi-empresa: roda como trabalho da empresa 1 (Cenário Estofados) — para chamar direto as
 * tarefas periódicas (ausência presumida, alertas, liberação), que em produção rodam uma vez por
 * empresa (`forEachCompany`).
 */
export function naEmpresa1<T>(fn: () => Promise<T>): Promise<T> {
  return runAsCompany(1, fn);
}

export const PLATFORM_ADMIN = { email: 'dono@plataforma.local', password: 'PainelDono123' };

/**
 * Painel da plataforma (/plataforma): cria o acesso do painel uma vez (pelo gestor da Cenário
 * Estofados, como na publicação) e devolve um cliente logado só no painel.
 */
export async function loginPlatform(app: App, creds = PLATFORM_ADMIN): Promise<Client> {
  const c = new Client(app);
  const estado = await c.get('/api/plataforma/estado');
  if (!estado.body.hasAdmin) {
    const gestor = await loginAdmin(app);
    const r = await gestor.post('/api/plataforma/primeiro-acesso', {
      email: creds.email,
      displayName: 'Dono da plataforma',
      password: creds.password,
      passwordConfirm: creds.password,
    });
    if (r.status !== 200) throw new Error(`primeiro acesso falhou: ${JSON.stringify(r.body)}`);
  }
  const res = await c.post('/api/plataforma/entrar', creds);
  if (res.status !== 200)
    throw new Error(`login do painel falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}
