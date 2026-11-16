/**
 * Entrar no Firma Viva com a conta do Cenário Gestão (botão "Acessar ambiente interativo" do
 * painel do Cenário). Sem senha no Firma Viva: o navegador passa pela tela oficial do Cenário
 * (`/autorizar` com `prompt=none`), que só dispensa a confirmação quando a empresa já conectou
 * o Firma Viva. O código volta ao retorno de sempre; aqui ele é trocado, a identidade é lida e o
 * acesso concedido ao Cenário é revogado na hora (a entrada não guarda tokens).
 *
 * Quem entra:
 * 1. a conta do Firma Viva já ligada a essa pessoa do Cenário (mesma empresa); senão
 * 2. a conta com o mesmo e-mail que já é membro da organização conectada a essa empresa; senão
 * 3. uma conta nova, membro "acompanha" da organização conectada (o dono promove se quiser).
 * Uma conta de outra organização com o mesmo e-mail nunca é aberta por aqui.
 */
import type { OAuthState } from '@firma/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { audit } from '../lib/audit';
import { cenarioCompanyKey, tokenRequest } from '../lib/cenario';
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
    const url = new URL(`${env.CENARIO_WEB_URL}/autorizar`);
    url.searchParams.set('client_id', env.FIRMA_CENARIO_CLIENT_ID);
    url.searchParams.set('redirect_uri', env.FIRMA_CENARIO_REDIRECT_URI);
    url.searchParams.set('scope', env.FIRMA_CENARIO_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'none');
    return reply.header('cache-control', 'no-store').redirect(url.toString());
  });
}

/** Retorno do Cenário para um pedido de entrada (chamado pelo retorno de sempre). */
export async function finishCenarioLogin(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  st: OAuthState,
  q: { code?: string; error?: string },
) {
  const { db, env, hash } = app.firma;
  const fail = (message: string) =>
    reply.redirect(`${env.FIRMA_WEB_URL}/entrar?erro=${encodeURIComponent(message)}`);
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
  // A entrada só precisa saber quem é a pessoa: o acesso concedido é desfeito na hora.
  await revokeAtCenario(app, String(t.data.refresh_token));
  const company = t.data.company as { name: string; document: string | null };
  const person = t.data.user as { id: string; name: string; email: string | null };
  if (!person?.id) return fail('O Cenário Gestão não informou a pessoa.');
  const companyKey = cenarioCompanyKey(env.CENARIO_API_URL, company);

  const conn = await db.cenarioConnection.findFirst({
    where: { companyKey, status: 'CONECTADA' },
  });
  if (!conn)
    return fail(
      `A empresa ${company.name} ainda não está conectada ao Firma Viva. Quem administra a organização precisa conectá-la na Central de Conexões.`,
    );
  const orgId = conn.orgId;
  const isMember = async (userId: string) =>
    !!(await db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } }));

  let userId: string | null = null;
  let created = false;
  const link = await db.cenarioLogin.findUnique({
    where: { companyKey_cenarioUserId: { companyKey, cenarioUserId: person.id } },
  });
  if (link && (await isMember(link.userId))) userId = link.userId;

  const email = person.email?.trim().toLowerCase() || null;
  if (!userId && email) {
    const byEmail = await db.user.findUnique({ where: { email } });
    if (byEmail && (await isMember(byEmail.id))) userId = byEmail.id;
    else if (byEmail)
      return fail(
        `Já existe uma conta do Firma Viva com o e-mail ${email} em outra organização. Entre com a senha dessa conta.`,
      );
  }
  if (!userId) {
    const syntheticEmail = `cenario-${createHash('sha256').update(`${companyKey}#${person.id}`).digest('hex').slice(0, 24)}@sem-email.firmaviva.invalid`;
    const name = (person.name || 'Pessoa do Cenário').slice(0, 80);
    const u = await db.$transaction(async (tx) => {
      const nu = await tx.user.create({
        data: { email: email ?? syntheticEmail, name, passwordHash: null },
      });
      await tx.membership.create({ data: { orgId, userId: nu.id, role: 'MEMBRO' } });
      return nu;
    });
    userId = u.id;
    created = true;
  }
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.active) return fail('Sua conta do Firma Viva está desativada.');
  await db.cenarioLogin.upsert({
    where: { companyKey_cenarioUserId: { companyKey, cenarioUserId: person.id } },
    create: { companyKey, cenarioUserId: person.id, userId },
    update: { userId, lastLoginAt: new Date() },
  });
  await openSession(app, request, reply, userId, orgId);
  request.user = { sessionId: '', id: user.id, name: user.name, email: user.email };
  await audit(request, {
    action: 'conta.entrou_pelo_cenario',
    summary: `${person.name} entrou pelo Cenário Gestão (${company.name})${created ? '; conta criada como membro que acompanha' : ''}.`,
    company: company.name,
    orgId,
  });
  return reply.redirect(`${env.FIRMA_WEB_URL}/jogo`);
}
