import { createFirmaClient, type PrismaClient } from '@firma/db';
import { createTokenHasher } from '../../api/src/lib/crypto';
import type { App as CenarioApp } from '../../api/src/app';
import {
  createTestApp,
  db as cenarioDb,
  resetDatabase as resetCenario,
} from '../../api/test/helpers';
import { buildApp, type FirmaApp } from '../src/app';
import { loadEnv } from '../src/env';
import { hashPassword } from '../src/lib/crypto';

export const FIRMA_ORIGIN = 'http://localhost:3100';
let firmaDb: PrismaClient | null = null;
export const fdb = () => (firmaDb ??= createFirmaClient(process.env.FIRMA_DATABASE_URL));

/** Cenário Gestão real (em processo) atrás do fetch do Firma Viva. */
export function bridge(cenario: CenarioApp): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const res = await cenario.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      payload: init?.body as string | Buffer | undefined,
    });
    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, String(v));
    return new Response(res.rawPayload.length ? res.rawPayload : null, {
      status: res.statusCode,
      headers: h,
    });
  }) as typeof fetch;
}

export async function setup() {
  const cenario = await createTestApp();
  const firma = await buildApp({
    env: loadEnv(),
    db: fdb(),
    logger: false,
    cenarioFetch: bridge(cenario),
  });
  return { cenario, firma };
}

export async function resetAll() {
  const t = await fdb().$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await fdb().$executeRawUnsafe(`TRUNCATE ${t.map((x) => `"${x.tablename}"`).join(', ')} CASCADE`);
  await resetCenario();
  const hash = createTokenHasher(process.env.TOKEN_HASH_SECRET!);
  await cenarioDb().oAuthClient.create({
    data: {
      clientId: 'firma-viva',
      name: 'Firma Viva',
      secretHash: hash(process.env.FIRMA_CENARIO_CLIENT_SECRET!),
      redirectUris: ['http://localhost:3100/api/conexoes/cenario/retorno'],
      allowedScopes: ['jogo', 'operacao', 'escritorio'],
    },
  });
}

export async function createOrg(name: string, email: string, password: string, role = 'DONO') {
  const org = await fdb().organization.create({ data: { name } });
  const user = await fdb().user.upsert({
    where: { email },
    create: { email, name: email.split('@')[0]!, passwordHash: await hashPassword(password) },
    update: {},
  });
  await fdb().membership.create({ data: { orgId: org.id, userId: user.id, role } });
  return { org, user };
}

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, unknown>;
}

/** Navegador do Firma Viva (cookies + Origin). */
export class Browser {
  cookies = new Map<string, string>();
  constructor(private readonly f: FirmaApp) {}
  async req(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const res = await this.f.app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: {
        origin: FIRMA_ORIGIN,
        ...(this.cookies.size
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {}),
        ...headers,
      },
    });
    for (const c of res.cookies as { name: string; value: string; maxAge?: number }[]) {
      if (!c.value || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* texto */
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}, h?: Record<string, string>) => this.req('POST', u, b, h);
  put = (u: string, b: unknown = {}, h?: Record<string, string>) => this.req('PUT', u, b, h);
}

export async function login(f: FirmaApp, email: string, password: string) {
  const b = new Browser(f);
  const r = await b.post('/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login: ${r.status} ${JSON.stringify(r.body)}`);
  return b;
}
