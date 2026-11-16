/**
 * Entrar no Firma Viva com a conta do Cenário Gestão (botão "Acessar ambiente interativo" do
 * painel do Cenário). Sem senha no Firma Viva: o navegador passa pela tela oficial do Cenário
 * (`/autorizar` com `prompt=none`), que só dispensa a confirmação quando a empresa já conectou
 * o Firma Viva. O código volta ao retorno de sempre; aqui ele é trocado, a identidade é lida e o
 * acesso concedido ao Cenário é revogado na hora (a entrada não guarda tokens).
 *
 * O Firma Viva é complemento do Cenário: não há tela de login nem etapa de conectar.
 * - Empresa sem organização no Firma Viva: a organização é criada na hora, com o nome da empresa.
 * - Organização sem conexão ativa: logo depois da entrada, o navegador passa de novo (sozinho)
 *   pela tela oficial com `prompt=none` e `org_ref`, e a conexão é gravada como na Central.
 * Quem entra:
 * 1. a conta do Firma Viva já ligada a essa pessoa do Cenário (mesma empresa); senão
 * 2. a conta com o mesmo e-mail que já é membro da organização da empresa; senão
 * 3. uma conta nova na organização: Dono se for a primeira pessoa; Gestor se o Cenário dá a ela
 *    alguma permissão de alteração; senão Membro (acompanha).
 * Uma conta de outra organização com o mesmo e-mail nunca é aberta por aqui (a pessoa ganha uma
 * conta própria para esta empresa).
 */
import type { OAuthState } from '@firma/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { audit } from '../lib/audit';
import { cenarioCompanyKey, tokenRequest } from '../lib/cenario';
import type { Role } from '../context';
import { pkceChallenge, randomToken } from '../lib/crypto';
import { openSession } from '../lib/session';
import { revokeAtCenario } from './connection';

export const ENTRAR_COOKIE = 'fv_entrar';
const ENTRAR_TTL_MS = 10 * 60_000;

export async function entrarRoutes(app: FastifyInstance) {
  const { db, env, hash, seal } = app.firma;

  /** Início (navegador, vindo do Cenário em nova guia): manda para a tela oficial do Cenário. */
  app.get('/api/entrar/cenario', { config: { rule: { public: true } } }, async (request, reply) => {
    // Já com sessão aberta no Firma Viva: vai direto para o jogo.
    if (request.user) return reply.redirect(`${env.FIRMA_WEB_URL}/jogo`);
    const state = randomToken();
    const verifier = randomToken(48);
    const browser = randomToken();
    await db.oAuthState.create({
      data: {
        stateHash: hash(state),
        purpose: 'ENTRAR',
        browserHash: hash(browser),
        verifierEnc: seal(verifier),
        expiresAt: new Date(Date.now() + ENTRAR_TTL_MS),
      },
    });
    void reply.setCookie(ENTRAR_COOKIE, browser, {
      httpOnly: true,
      secure: env.FIRMA_COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api',
      maxAge: ENTRAR_TTL_MS / 1000,
    });
    return reply
      .header('cache-control', 'no-store')
      .redirect(directAuthorizeUrl(app, state, verifier));
  });
}

/** Tela oficial do Cenário em modo de entrada direta (sem confirmação). */
function directAuthorizeUrl(
  app: FastifyInstance,
  state: string,
  verifier: string,
  org?: { id: string; name: string },
) {
  const { env } = app.firma;
  const url = new URL(`${env.CENARIO_WEB_URL}/autorizar`);
  url.searchParams.set('client_id', env.FIRMA_CENARIO_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.FIRMA_CENARIO_REDIRECT_URI);
  url.searchParams.set('scope', env.FIRMA_CENARIO_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'none');
  if (org) {
    url.searchParams.set('org_ref', org.id);
    url.searchParams.set('org_label', org.name);
  }
  return url.toString();
}

/** Permissões que o Cenário dá à pessoa (usuário ∩ escopo), lidas com o acesso da entrada. */
async function cenarioPermissions(app: FastifyInstance, accessToken: string): Promise<string[]> {
  const { env } = app.firma;
  try {
    const res = await app.cenarioFetch(`${env.CENARIO_API_URL}/api/v1/apps/me`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(env.FIRMA_CENARIO_COOKIE ? { cookie: env.FIRMA_CENARIO_COOKIE } : {}),
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { permissions?: string[] };
    return Array.isArray(body.permissions) ? body.permissions : [];
  } catch {
    return [];
  }
}

/** Retorno do Cenário para um pedido de entrada (chamado pelo retorno de sempre). */
export async function finishCenarioLogin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  st: OAuthState,
  q: { code?: string; error?: string },
) {
  const { db, env, hash, seal } = app.firma;
  const fail = (message: string) =>
    reply.redirect(`${env.FIRMA_WEB_URL}/acesso?erro=${encodeURIComponent(message)}`);
  const browser = request.cookies[ENTRAR_COOKIE];
  void reply.clearCookie(ENTRAR_COOKIE, { path: '/api' });
  if (st.usedAt || st.expiresAt <= new Date() || !browser || st.browserHash !== hash(browser))
    return fail('Pedido de entrada inválido ou expirado. Volte ao Cenário Gestão e tente de novo.');
  await db.oAuthState.update({ where: { id: st.id }, data: { usedAt: new Date() } });
  if (q.error || !q.code) return fail('Entrada cancelada na tela do Cenário Gestão.');

  const t = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code: q.code,
    code_verifier: app.firma.unseal(st.verifierEnc),
    redirect_uri: env.FIRMA_CENARIO_REDIRECT_URI,
  });
  if (!t.ok)
    return fail(
      `O Cenário Gestão recusou a entrada (${String(t.data.error_description ?? t.status)}).`,
    );
  const permissions = await cenarioPermissions(app, String(t.data.access_token));
  // A entrada só precisa saber quem é a pessoa: o acesso concedido é desfeito na hora.
  await revokeAtCenario(app, String(t.data.refresh_token));
  const company = t.data.company as { name: string; document: string | null };
  const person = t.data.user as { id: string; name: string; email: string | null };
  if (!person?.id) return fail('O Cenário Gestão não informou a pessoa.');
  const companyKey = cenarioCompanyKey(env.CENARIO_API_URL, company);

  // Organização da empresa: a ligada a ela (a conectada primeiro, senão a mais recente) ou nova.
  const known = await db.cenarioConnection.findFirst({
    where: { companyKey },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], // CONECTADA vem antes das demais
  });
  const active = known?.status === 'CONECTADA' ? known : null;
  let orgId = known?.orgId ?? null;
  let createdOrg = false;
  if (!orgId) {
    const org = await db.organization.create({ data: { name: company.name.slice(0, 120) } });
    orgId = org.id;
    createdOrg = true;
  }
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const isMember = async (userId: string) =>
    !!(await db.membership.findUnique({ where: { orgId_userId: { orgId: org.id, userId } } }));

  let userId: string | null = null;
  let created = false;
  const link = await db.cenarioLogin.findUnique({
    where: { companyKey_cenarioUserId: { companyKey, cenarioUserId: person.id } },
  });
  if (link && (await isMember(link.userId))) userId = link.userId;

  const email = person.email?.trim().toLowerCase() || null;
  const byEmail = email ? await db.user.findUnique({ where: { email } }) : null;
  if (!userId && byEmail && (await isMember(byEmail.id))) userId = byEmail.id;
  if (!userId) {
    const members = await db.membership.count({ where: { orgId: org.id } });
    const writes = permissions.some((p) => !p.endsWith('.ver') && !p.endsWith('.acessar'));
    const role: Role = members === 0 ? 'DONO' : writes ? 'GESTOR' : 'MEMBRO';
    // E-mail já usado por uma conta de fora desta organização: conta própria, sem abrir a outra.
    const ownEmail =
      email && !byEmail
        ? email
        : `cenario-${createHash('sha256').update(`${companyKey}#${person.id}`).digest('hex').slice(0, 24)}@sem-email.firmaviva.invalid`;
    const name = (person.name || 'Pessoa do Cenário').slice(0, 80);
    const u = await db.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: ownEmail } });
      const nu =
        existing ?? (await tx.user.create({ data: { email: ownEmail, name, passwordHash: null } }));
      await tx.membership.upsert({
        where: { orgId_userId: { orgId: org.id, userId: nu.id } },
        create: { orgId: org.id, userId: nu.id, role },
        update: {},
      });
      if (members === 0)
        await tx.organization.update({ where: { id: org.id }, data: { createdById: nu.id } });
      return nu;
    });
    userId = u.id;
    created = true;
  }
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.active) return fail('Sua conta do ambiente interativo está desativada.');
  await db.cenarioLogin.upsert({
    where: { companyKey_cenarioUserId: { companyKey, cenarioUserId: person.id } },
    create: { companyKey, cenarioUserId: person.id, userId },
    update: { userId, lastLoginAt: new Date() },
  });
  await openSession(app, request, reply, userId, org.id);
  request.user = { sessionId: '', id: user.id, name: user.name, email: user.email };
  await audit(request, {
    action: 'conta.entrou_pelo_cenario',
    summary: `${person.name} entrou pelo Cenário Gestão (${company.name})${createdOrg ? '; organização criada' : ''}${created ? '; conta criada' : ''}.`,
    company: company.name,
    orgId: org.id,
  });
  if (active) return reply.redirect(`${env.FIRMA_WEB_URL}/jogo`);

  // Sem conexão ativa: liga a empresa agora, sem tela (volta pelo retorno com purpose AUTO).
  const state = randomToken();
  const verifier = randomToken(48);
  await db.oAuthState.create({
    data: {
      stateHash: hash(state),
      purpose: 'AUTO',
      orgId: org.id,
      userId,
      verifierEnc: seal(verifier),
      expiresAt: new Date(Date.now() + ENTRAR_TTL_MS),
    },
  });
  return reply
    .header('cache-control', 'no-store')
    .redirect(directAuthorizeUrl(app, state, verifier, { id: org.id, name: org.name }));
}
