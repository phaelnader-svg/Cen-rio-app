/**
 * Cliente do Cenário Gestão por organização: usa a autorização delegada (tokens selados no
 * banco), renova o token de acesso quando preciso e suspende as ações integradas quando a
 * autorização expira ou é revogada. Nenhum token sai do servidor do Firma Viva.
 */
import type { CenarioConnection } from '@firma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { E } from './errors';

export interface CenarioResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json<T = unknown>(): T;
}

const refreshing = new Map<string, Promise<CenarioConnection>>();

/** Conexão só com o escopo de consulta: o Firma Viva nunca envia alterações ao Cenário. */
export function isReadOnly(c: Pick<CenarioConnection, 'scopes'> | null) {
  return Boolean(c && c.scopes.length > 0 && c.scopes.every((s) => s === 'consulta'));
}

export function isActive(c: CenarioConnection | null): c is CenarioConnection {
  return Boolean(c && c.status === 'CONECTADA' && c.accessEnc && c.refreshEnc);
}

export interface CenarioCompany {
  id?: number | null;
  name: string;
  document: string | null;
}

/**
 * Identidade da empresa no Cenário: endereço + número da empresa. Uma organização por empresa.
 * O nome e o documento NÃO servem de identidade: duas empresas podem ter o mesmo nome (ou nenhum
 * CNPJ), e foi assim que a entrada de uma empresa chegou a abrir a organização de outra.
 */
export const cenarioCompanyKey = (apiUrl: string, company: CenarioCompany) =>
  company.id !== null && company.id !== undefined
    ? `${apiUrl}#empresa:${company.id}`.toLowerCase()
    : legacyCompanyKey(apiUrl, company);

/** Chave antiga (documento ou nome): só para reconhecer, com conferência, as ligações de antes. */
export const legacyCompanyKey = (apiUrl: string, company: CenarioCompany) =>
  `${apiUrl}#${company.document || company.name}`.toLowerCase();

export async function tokenRequest(app: FastifyInstance, body: Record<string, string>) {
  const { env } = app.firma;
  const res = await app.cenarioFetch(`${env.CENARIO_API_URL}/api/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(env.FIRMA_CENARIO_COOKIE ? { cookie: env.FIRMA_CENARIO_COOKIE } : {}),
    },
    body: JSON.stringify({
      ...body,
      client_id: env.FIRMA_CENARIO_CLIENT_ID,
      client_secret: env.FIRMA_CENARIO_CLIENT_SECRET,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

async function suspend(
  app: FastifyInstance,
  c: CenarioConnection,
  status: 'EXPIRADA' | 'REVOGADA',
  why: string,
) {
  await app.firma.db.cenarioConnection.update({
    where: { id: c.id },
    data: {
      status,
      accessEnc: null,
      refreshEnc: null,
      accessExpiresAt: null,
      lastError: why.slice(0, 300),
    },
  });
  await app.firma.db.auditLog.create({
    data: {
      orgId: c.orgId,
      action: 'conexao.suspensa',
      summary: `Conexão com o Cenário Gestão suspensa: ${why}`,
      company: c.companyName,
    },
  });
}

async function refresh(app: FastifyInstance, c: CenarioConnection): Promise<CenarioConnection> {
  const pending = refreshing.get(c.orgId);
  if (pending) return pending;
  const p = (async () => {
    const ctx = app.firma;
    const r = await tokenRequest(app, {
      grant_type: 'refresh_token',
      refresh_token: ctx.unseal(c.refreshEnc!),
    });
    if (!r.ok) {
      const why =
        r.data.error === 'invalid_grant'
          ? 'a autorização foi revogada no Cenário Gestão ou expirou.'
          : `o Cenário Gestão recusou a renovação (${r.status}).`;
      await suspend(app, c, r.data.error === 'invalid_grant' ? 'REVOGADA' : 'EXPIRADA', why);
      throw E.suspended(why);
    }
    return ctx.db.cenarioConnection.update({
      where: { id: c.id },
      data: {
        accessEnc: ctx.seal(String(r.data.access_token)),
        refreshEnc: ctx.seal(String(r.data.refresh_token)),
        accessExpiresAt: new Date(Date.now() + Number(r.data.expires_in ?? 3600) * 1000),
        lastError: null,
      },
    });
  })().finally(() => refreshing.delete(c.orgId));
  refreshing.set(c.orgId, p);
  return p;
}

/**
 * Número da empresa do Cenário a que uma conexão dá acesso, perguntado ao próprio Cenário com o
 * token dela. `null` quando não dá para saber (conexão suspensa, Cenário fora, versão antiga).
 */
export async function connectionCompanyId(
  app: FastifyInstance,
  conn: CenarioConnection,
): Promise<number | null> {
  if (!isActive(conn)) return null;
  try {
    let c = conn;
    if (!c.accessExpiresAt || c.accessExpiresAt.getTime() - Date.now() < 60_000)
      c = await refresh(app, c);
    const res = await app.cenarioFetch(`${app.firma.env.CENARIO_API_URL}/api/v1/apps/me`, {
      headers: {
        authorization: `Bearer ${app.firma.unseal(c.accessEnc!)}`,
        accept: 'application/json',
        ...(app.firma.env.FIRMA_CENARIO_COOKIE
          ? { cookie: app.firma.env.FIRMA_CENARIO_COOKIE }
          : {}),
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { company?: { id?: unknown } };
    return typeof body.company?.id === 'number' ? body.company.id : null;
  } catch {
    return null;
  }
}

/** Conexão ativa da organização da requisição (ou erro claro de conexão necessária/suspensa). */
export async function activeConnection(request: FastifyRequest) {
  const c = await request.server.firma.db.cenarioConnection.findUnique({
    where: { orgId: request.org!.id },
  });
  if (!c || c.status === 'DESCONECTADA') throw E.needsConnection();
  if (!isActive(c as CenarioConnection | null))
    throw E.suspended(
      (c as CenarioConnection).status === 'REVOGADA'
        ? 'a autorização foi revogada no Cenário Gestão.'
        : 'a autorização expirou.',
    );
  return c;
}

/**
 * Chamada ao Cenário Gestão em nome da organização. `actorName` identifica a pessoa do Firma
 * Viva na auditoria do Cenário (cabeçalho X-App-Actor).
 */
export async function cenarioCall(
  request: FastifyRequest,
  method: string,
  path: string,
  opts: {
    body?: Buffer | string;
    contentType?: string;
    idempotencyKey?: string;
    accept?: string;
  } = {},
): Promise<CenarioResponse> {
  const app = request.server;
  let c = await activeConnection(request);
  if (!c.accessExpiresAt || c.accessExpiresAt.getTime() - Date.now() < 60_000)
    c = await refresh(app, c);
  const doFetch = (conn: CenarioConnection) =>
    app.cenarioFetch(`${app.firma.env.CENARIO_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${app.firma.unseal(conn.accessEnc!)}`,
        accept: opts.accept ?? 'application/json',
        'x-app-actor': encodeURIComponent(`${request.user!.name} (${request.org!.name})`),
        ...(app.firma.env.FIRMA_CENARIO_COOKIE
          ? { cookie: app.firma.env.FIRMA_CENARIO_COOKIE }
          : {}),
        ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: opts.body,
    });
  let res: Response;
  try {
    res = await doFetch(c);
    if (res.status === 401) {
      c = await refresh(app, c);
      res = await doFetch(c);
      if (res.status === 401) {
        await suspend(app, c, 'REVOGADA', 'o Cenário Gestão recusou a autorização.');
        throw E.suspended('o Cenário Gestão recusou a autorização.');
      }
    }
  } catch (e) {
    if (e instanceof Error && 'statusCode' in e) throw e;
    await app.firma.db.cenarioConnection.update({
      where: { id: c.id },
      data: { lastError: 'Cenário Gestão fora do ar ou inacessível.' },
    });
    throw Object.assign(
      new Error('Cenário Gestão fora do ar ou inacessível. Tente de novo em instantes.'),
      {
        statusCode: 502,
      },
    );
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (res.ok)
    await app.firma.db.cenarioConnection.update({
      where: { id: c.id },
      data: { lastSyncAt: new Date(), lastError: null },
    });
  return {
    status: res.status,
    headers: res.headers,
    body,
    json: <T>() => JSON.parse(body.toString('utf8') || 'null') as T,
  };
}

/** Atalho JSON: devolve o corpo ou lança o erro do Cenário. */
export async function cenarioJson<T>(
  request: FastifyRequest,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const r = await cenarioCall(request, method, path, {
    ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  const data = r.json<T & { error?: { code: string; message: string; details?: unknown } }>();
  if (r.status >= 400) {
    throw Object.assign(
      new Error(data?.error?.message ?? `Cenário Gestão respondeu ${r.status}.`),
      {
        statusCode: r.status,
        cenario: data?.error,
      },
    );
  }
  return data;
}
