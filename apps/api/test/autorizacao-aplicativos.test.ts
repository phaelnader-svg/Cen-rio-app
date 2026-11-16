import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createTokenHasher } from '../src/lib/crypto';
import { Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';

/**
 * Autorização delegada e revogável (OAuth 2.0 + PKCE) usada pelo Firma Viva:
 * a senha só é digitada no Cenário; o aplicativo recebe tokens; permissões = usuário ∩ escopos;
 * revogar (pelo app ou pelo painel) corta o acesso na hora; a auditoria registra o "via".
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());

const SECRET = 'segredo-de-teste-do-firma-viva-0123456789abcdef';
const REDIRECT = 'http://localhost:3100/api/conexoes/cenario/retorno';

beforeEach(async () => {
  await resetDatabase();
  const hash = createTokenHasher(process.env.TOKEN_HASH_SECRET!);
  await db().oAuthClient.create({
    data: {
      clientId: 'firma-viva',
      name: 'Firma Viva',
      secretHash: hash(SECRET),
      redirectUris: [REDIRECT],
      allowedScopes: ['jogo', 'operacao', 'escritorio'],
    },
  });
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeParams(challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: 'firma-viva',
    redirect_uri: REDIRECT,
    scope: 'jogo operacao',
    state: 'estado-123456',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    org_ref: 'org-a',
    org_label: 'Cenário Estofados',
    ...extra,
  };
}

async function connect(admin: Client) {
  const { verifier, challenge } = pkce();
  const p = authorizeParams(challenge);
  const r = await admin.post('/api/oauth/authorize', { ...p, decision: 'allow' });
  expect(r.status).toBe(200);
  const url = new URL(r.body.redirect as string);
  expect(url.origin + url.pathname).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe('estado-123456');
  const code = url.searchParams.get('code')!;
  const server = new Client(app, null);
  const t = await server.post('/api/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: 'firma-viva',
    client_secret: SECRET,
  });
  return { t, code, verifier, server };
}

const bearer = (c: Client, token: string, url: string, actor?: string) =>
  c.req('GET', url, undefined, {
    authorization: `Bearer ${token}`,
    ...(actor ? { 'x-app-actor': encodeURIComponent(actor) } : {}),
  });

describe('autorização delegada de aplicativos', () => {
  it('tela oficial exige login do Cenário e mostra empresa e permissões', async () => {
    const anon = new Client(app);
    const q = new URLSearchParams(authorizeParams(pkce().challenge)).toString();
    expect((await anon.get(`/api/oauth/authorize/info?${q}`)).status).toBe(401);
    const admin = await loginAdmin(app);
    const info = await admin.get(`/api/oauth/authorize/info?${q}`);
    expect(info.status).toBe(200);
    expect(info.body.client.name).toBe('Firma Viva');
    expect(info.body.company.name).toBeTruthy();
    expect(info.body.org.label).toBe('Cenário Estofados');
    expect(info.body.scopes.map((s: { key: string }) => s.key)).toEqual(['jogo', 'operacao']);
    // Endereço de retorno não cadastrado é recusado.
    const bad = new URLSearchParams(
      authorizeParams(pkce().challenge, { redirect_uri: 'https://malicioso.example/cb' }),
    ).toString();
    expect((await admin.get(`/api/oauth/authorize/info?${bad}`)).status).toBe(422);
  });

  it('código + PKCE → tokens; permissões reduzidas aos escopos; código de uso único', async () => {
    const admin = await loginAdmin(app);
    const { t, code, verifier, server } = await connect(admin);
    expect(t.status).toBe(200);
    expect(t.body.token_type).toBe('Bearer');
    expect(t.body.company.name).toBeTruthy();
    expect(t.body.scope).toBe('jogo operacao');
    const token = t.body.access_token as string;

    // Nada de segredo no banco em texto puro.
    const grant = await db().oAuthGrant.findFirstOrThrow();
    expect(grant.refreshHash).not.toBe(t.body.refresh_token);

    const me = await bearer(server, token, '/api/v1/apps/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('os.ver');
    expect(me.body.permissions).toContain('jogo.construir');
    // Escopo "escritorio" não foi pedido: financeiro fica de fora mesmo para o gestor.
    expect(me.body.permissions).not.toContain('financeiro.ver');
    expect((await bearer(server, token, '/api/v1/game/snapshot')).status).toBe(200);
    expect((await bearer(server, token, '/api/v1/office/cash')).status).toBe(403);
    // Administração e sessões nunca ficam disponíveis para o aplicativo.
    expect((await bearer(server, token, '/api/sessions')).status).toBe(403);
    expect((await bearer(server, token, '/api/auth/me')).status).toBe(403);

    // Reuso do código: recusado.
    const again = await server.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('verificador PKCE errado e segredo errado são recusados', async () => {
    const admin = await loginAdmin(app);
    const { challenge } = pkce();
    const r = await admin.post('/api/oauth/authorize', {
      ...authorizeParams(challenge),
      decision: 'allow',
    });
    const code = new URL(r.body.redirect as string).searchParams.get('code')!;
    const server = new Client(app, null);
    const wrongSecret = await server.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT,
      client_id: 'firma-viva',
      client_secret: 'errado',
    });
    expect(wrongSecret.status).toBe(401);
    const wrongVerifier = await server.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error_description).toMatch(/PKCE/);
  });

  it('recusa na tela oficial devolve access_denied sem código', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.post('/api/oauth/authorize', {
      ...authorizeParams(pkce().challenge),
      decision: 'deny',
    });
    const url = new URL(r.body.redirect as string);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
  });

  it('renovação gira o token; revogar pelo aplicativo ou pelo painel corta o acesso', async () => {
    const admin = await loginAdmin(app);
    const { t, server } = await connect(admin);
    const r1 = await server.post('/api/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(r1.status).toBe(200);
    // O token de renovação anterior não vale mais (rotação).
    const old = await server.post('/api/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(old.status).toBe(400);

    // Painel: lista e revoga.
    const list = await admin.get('/api/v1/apps/grants');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ client: 'Firma Viva', org: 'Cenário Estofados' });
    const rv = await admin.post(`/api/v1/apps/grants/${list.body[0].id}/revoke`);
    expect(rv.body.revoked).toBe(true);
    expect((await bearer(server, r1.body.access_token, '/api/v1/apps/me')).status).toBe(401);
    const refreshAfter = await server.post('/api/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: r1.body.refresh_token,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(refreshAfter.status).toBe(400);

    // Nova conexão e "Desconectar" pelo aplicativo.
    const second = await connect(admin);
    expect((await bearer(server, second.t.body.access_token, '/api/v1/apps/me')).status).toBe(200);
    const revoke = await server.post('/api/oauth/revoke', {
      token: second.t.body.refresh_token,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(revoke.status).toBe(200);
    expect((await bearer(server, second.t.body.access_token, '/api/v1/apps/me')).status).toBe(401);
  });

  it('ação feita pelo aplicativo fica auditada com aplicativo, organização e pessoa', async () => {
    const admin = await loginAdmin(app);
    const { t, server } = await connect(admin);
    const spaces = await bearer(server, t.body.access_token, '/api/v1/game/spaces');
    expect(spaces.status).toBe(200);
    const created = await server.req(
      'POST',
      '/api/v1/game/spaces',
      { name: 'Depósito', kind: 'OUTRO', widthCm: 600, depthCm: 400 },
      {
        authorization: `Bearer ${t.body.access_token}`,
        'x-app-actor': encodeURIComponent('Rafa (Firma Viva)'),
        'idempotency-key': 'teste-app-espaco-1',
      },
    );
    expect([200, 201]).toContain(created.status);
    const log = await db().auditLog.findFirst({
      where: { summary: { contains: 'via Firma Viva' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.summary).toMatch(/via Firma Viva · Cenário Estofados · Rafa \(Firma Viva\)/);
  });

  it('entrada direta (prompt=none): sem tela de confirmação, ainda exigindo o login do Cenário', async () => {
    const admin = await loginAdmin(app);
    const q = new URLSearchParams(
      authorizeParams(pkce().challenge, { prompt: 'none', org_ref: '' }),
    ).toString();
    const info = await admin.get(`/api/oauth/authorize/info?${q}`);
    expect(info.status).toBe(200);
    expect(info.body.skipConsent).toBe(true);
    const normal = new URLSearchParams(authorizeParams(pkce().challenge)).toString();
    expect((await admin.get(`/api/oauth/authorize/info?${normal}`)).body.skipConsent).toBe(false);
    expect((await new Client(app).get(`/api/oauth/authorize/info?${q}`)).status).toBe(401);
  });
});
