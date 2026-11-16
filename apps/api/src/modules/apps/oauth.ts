/**
 * Autorização delegada e revogável para aplicativos (OAuth 2.0, código de autorização + PKCE S256).
 *
 * Fluxo: o aplicativo (ex.: Firma Viva) abre /autorizar no Cenário Gestão; a pessoa entra com a
 * senha NA TELA OFICIAL do Cenário, revisa empresa e permissões e autoriza; o Cenário devolve um
 * código de uso único ao endereço de retorno cadastrado; o servidor do aplicativo troca o código
 * (com o verificador PKCE e o segredo do cliente) por um token de acesso curto e um token de
 * renovação. Aqui guardamos apenas hashes. Revogar encerra a concessão e a sessão ligada a ela.
 */
import {
  APP_ACCESS_TTL_SECONDS,
  APP_CODE_TTL_SECONDS,
  APP_REFRESH_TTL_DAYS,
  APP_SCOPES,
  parseScopes,
  scopePermissions,
  type AppScope,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { moduleEnabled } from '../../core/modules';
import { loadUserPermissions } from '../../core/permissions';
import { createSession, revokeSessions } from '../../core/sessions';
import type { ActorContext } from '../../core/types';
import { randomToken, safeEqual } from '../../lib/crypto';
import { Errors } from '../../lib/errors';

const authorizeQuery = z.object({
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().url().max(500),
  scope: z.string().max(200).default(''),
  state: z.string().min(8).max(200),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, 'code_challenge inválido'),
  code_challenge_method: z.literal('S256'),
  /** Organização do aplicativo que vai receber o vínculo (só exibição/registro). */
  org_ref: z.string().max(80).optional(),
  org_label: z.string().max(120).optional(),
  /**
   * `none`: entrar no aplicativo sem a tela de confirmação, quando a empresa JÁ autorizou este
   * aplicativo (há concessão ativa com essas permissões). Sem isso, a tela aparece normalmente.
   */
  prompt: z.enum(['none', 'consent']).optional(),
});

class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

function sendOAuthError(reply: FastifyReply, e: OAuthError) {
  return reply
    .code(e.status)
    .header('cache-control', 'no-store')
    .send({ error: e.error, error_description: e.message });
}

export async function revokeGrant(
  tx: Tx,
  actor: ActorContext,
  grantId: string,
  reason: string,
  revokedById: string | null,
) {
  const g = await tx.oAuthGrant.findUnique({
    where: { id: grantId },
    include: { client: { select: { name: true } } },
  });
  if (!g || g.revokedAt) return false;
  await tx.oAuthGrant.update({
    where: { id: g.id },
    data: {
      revokedAt: new Date(),
      revokedReason: reason.slice(0, 40),
      revokedById,
      refreshHash: null,
    },
  });
  await tx.oAuthAccessToken.deleteMany({ where: { grantId: g.id } });
  await revokeSessions(tx, actor, { id: g.sessionId }, 'revoked_by_admin');
  await audit(tx, actor, {
    action: 'app.revoked',
    entityType: 'oauth_grant',
    entityId: g.id,
    summary: `Acesso do aplicativo ${g.client.name}${g.externalLabel ? ` (${g.externalLabel})` : ''} revogado.`,
    changes: { reason },
  });
  return true;
}

export async function oauthRoutes(app: FastifyInstance) {
  const { prisma, env, hashToken } = app.ctx;

  async function validateRequest(q: z.infer<typeof authorizeQuery>) {
    const client = await prisma.oAuthClient.findUnique({ where: { clientId: q.client_id } });
    if (!client || !client.active)
      throw Errors.business('Aplicativo não cadastrado ou desativado.');
    if (!client.redirectUris.includes(q.redirect_uri)) {
      throw Errors.business('Endereço de retorno não autorizado para este aplicativo.');
    }
    const requested = parseScopes(q.scope);
    const scopes = requested.filter((s) => client.allowedScopes.includes(s));
    if (scopes.length === 0) throw Errors.business('Nenhuma permissão válida foi solicitada.');
    return { client, scopes };
  }

  async function company() {
    const c = await prisma.companySettings.findUnique({ where: { id: 1 } });
    return {
      name: c?.tradeName ?? 'Empresa',
      legalName: c?.legalName ?? null,
      document: c?.document ?? null,
    };
  }

  /**
   * Entrada direta (botão "Acessar ambiente interativo"): com `prompt=none`, a confirmação é
   * dispensada quando a empresa tem o complemento "Ambiente interativo" ligado (a contratação é a
   * autorização da empresa). Desligado, a entrada direta é recusada. A pessoa continua precisando
   * estar logada no Cenário, e o aplicativo nunca recebe mais do que ela pode fazer.
   */
  async function directEntry(prompt?: string) {
    if (prompt !== 'none') return false;
    if (!(await moduleEnabled(prisma, 'ambiente_interativo')))
      throw Errors.business(
        'O Ambiente interativo não está ativo para esta empresa. Fale com o Cenário Gestão para contratar o complemento.',
      );
    return true;
  }

  /** Dados da tela de consentimento (empresa, pessoa, permissões pedidas). */
  app.get(
    '/api/oauth/authorize/info',
    { config: { access: { session: 'WEB' } } },
    async (request) => {
      const q = authorizeQuery.parse(request.query);
      const { client, scopes } = await validateRequest(q);
      const auth = request.auth!;
      const perms = await loadUserPermissions(prisma, auth.userId);
      return {
        client: { id: client.clientId, name: client.name },
        company: await company(),
        user: { id: auth.userId, name: auth.displayName, email: auth.email },
        org: { ref: q.org_ref ?? null, label: q.org_label ?? null },
        scopes: scopes.map((s: AppScope) => {
          const def = APP_SCOPES[s];
          const granted = def.permissions.filter((p) => perms.has(p));
          return {
            key: s,
            label: def.label,
            description: def.description,
            grantedPermissions: granted.length,
            totalPermissions: def.permissions.length,
          };
        }),
        redirectHost: new URL(q.redirect_uri).host,
        skipConsent: await directEntry(q.prompt),
      };
    },
  );

  /** Decisão da pessoa na tela oficial: gera o código de uso único (ou recusa). */
  app.post('/api/oauth/authorize', { config: { access: { session: 'WEB' } } }, async (request) => {
    const body = authorizeQuery.extend({ decision: z.enum(['allow', 'deny']) }).parse(request.body);
    const { client, scopes } = await validateRequest(body);
    await directEntry(body.prompt);
    const target = new URL(body.redirect_uri);
    target.searchParams.set('state', body.state);
    if (body.decision === 'deny') {
      target.searchParams.set('error', 'access_denied');
      return { redirect: target.toString() };
    }
    const code = randomToken();
    const auth = request.auth!;
    await prisma.$transaction(async (tx) => {
      await tx.oAuthCode.create({
        data: {
          codeHash: hashToken(code),
          clientId: client.id,
          userId: auth.userId,
          redirectUri: body.redirect_uri,
          scopes,
          codeChallenge: body.code_challenge,
          externalRef: body.org_ref ?? null,
          externalLabel: body.org_label ?? null,
          expiresAt: new Date(Date.now() + APP_CODE_TTL_SECONDS * 1000),
        },
      });
      await audit(tx, actorFrom(request), {
        action: 'app.authorized',
        entityType: 'oauth_client',
        entityId: client.id,
        summary: `${auth.displayName} autorizou o aplicativo ${client.name}${body.org_label ? ` para ${body.org_label}` : ''}.`,
        changes: { scopes, ...(body.prompt === 'none' ? { entradaDireta: true } : {}) },
      });
    });
    target.searchParams.set('code', code);
    return { redirect: target.toString() };
  });

  function clientCredentials(request: FastifyRequest, body: Record<string, unknown>) {
    const h = request.headers.authorization;
    if (h?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
    }
    return { id: String(body.client_id ?? ''), secret: String(body.client_secret ?? '') };
  }

  async function authenticateClient(request: FastifyRequest, body: Record<string, unknown>) {
    const cred = clientCredentials(request, body);
    const client = cred.id
      ? await prisma.oAuthClient.findUnique({ where: { clientId: cred.id.slice(0, 64) } })
      : null;
    if (!client || !client.active || !safeEqual(client.secretHash, hashToken(cred.secret))) {
      throw new OAuthError(401, 'invalid_client', 'Aplicativo não autenticado.');
    }
    return client;
  }

  async function issue(tx: Tx, grantId: string) {
    const access = randomToken();
    const refresh = randomToken();
    const refreshExpiresAt = new Date(Date.now() + APP_REFRESH_TTL_DAYS * 86_400_000);
    await tx.oAuthAccessToken.create({
      data: {
        grantId,
        tokenHash: hashToken(access),
        expiresAt: new Date(Date.now() + APP_ACCESS_TTL_SECONDS * 1000),
      },
    });
    const g = await tx.oAuthGrant.update({
      where: { id: grantId },
      data: { refreshHash: hashToken(refresh), refreshExpiresAt },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    });
    // A sessão ligada à concessão vive enquanto o token de renovação valer.
    await tx.session.update({ where: { id: g.sessionId }, data: { expiresAt: refreshExpiresAt } });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: APP_ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      refresh_expires_in: APP_REFRESH_TTL_DAYS * 86_400,
      scope: g.scopes.join(' '),
      grant_id: g.id,
      user: { id: g.user.id, name: g.user.displayName, email: g.user.email },
      company: await company(),
    };
  }

  /** Troca o código (com PKCE) ou o token de renovação por tokens novos. Servidor a servidor. */
  app.post(
    '/api/oauth/token',
    { config: { access: { public: true, serverToServer: true } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const client = await authenticateClient(request, body);
        const actor = actorFrom(request);
        if (body.grant_type === 'authorization_code') {
          const code = String(body.code ?? '');
          const verifier = String(body.code_verifier ?? '');
          const redirectUri = String(body.redirect_uri ?? '');
          const result = await prisma.$transaction(async (tx) => {
            const row = await tx.oAuthCode.findUnique({ where: { codeHash: hashToken(code) } });
            if (!row || row.clientId !== client.id) {
              throw new OAuthError(400, 'invalid_grant', 'Código inválido.');
            }
            // Uso único: marca antes de qualquer outra verificação (reuso = recusa).
            const used = await tx.oAuthCode.updateMany({
              where: { id: row.id, usedAt: null },
              data: { usedAt: new Date() },
            });
            if (used.count === 0)
              throw new OAuthError(400, 'invalid_grant', 'Código já utilizado.');
            if (row.expiresAt <= new Date())
              throw new OAuthError(400, 'invalid_grant', 'Código expirado.');
            if (row.redirectUri !== redirectUri) {
              throw new OAuthError(
                400,
                'invalid_grant',
                'Endereço de retorno diferente do autorizado.',
              );
            }
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            if (
              !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
              !safeEqual(challenge, row.codeChallenge)
            ) {
              throw new OAuthError(400, 'invalid_grant', 'Verificador PKCE incorreto.');
            }
            const user = await tx.user.findUnique({
              where: { id: row.userId },
              include: { employee: { select: { active: true } } },
            });
            if (!user?.active || user.employee?.active === false) {
              throw new OAuthError(400, 'invalid_grant', 'Usuário inativo.');
            }
            const appActor = { ...actor, userId: user.id };
            // Uma concessão ativa por aplicativo + pessoa + organização: a anterior é substituída.
            const previous = await tx.oAuthGrant.findMany({
              where: {
                clientId: client.id,
                userId: user.id,
                externalRef: row.externalRef,
                revokedAt: null,
              },
              select: { id: true },
            });
            for (const p of previous) await revokeGrant(tx, appActor, p.id, 'substituida', user.id);
            const { session } = await createSession(tx, env, hashToken, {
              kind: 'WEB',
              userId: user.id,
              deviceId: null,
              ip: request.ip,
              userAgent: `${client.name} (aplicativo conectado)`,
            });
            const grant = await tx.oAuthGrant.create({
              data: {
                clientId: client.id,
                userId: user.id,
                sessionId: session.id,
                scopes: row.scopes,
                externalRef: row.externalRef,
                externalLabel: row.externalLabel,
              },
            });
            await audit(
              tx,
              { ...appActor, sessionId: session.id },
              {
                action: 'app.connected',
                entityType: 'oauth_grant',
                entityId: grant.id,
                summary: `Aplicativo ${client.name} conectado${row.externalLabel ? ` à organização ${row.externalLabel}` : ''}.`,
                changes: { scopes: row.scopes },
              },
            );
            return issue(tx, grant.id);
          });
          return reply.header('cache-control', 'no-store').send(result);
        }
        if (body.grant_type === 'refresh_token') {
          const refresh = String(body.refresh_token ?? '');
          const result = await prisma.$transaction(async (tx) => {
            const g = await tx.oAuthGrant.findUnique({
              where: { refreshHash: hashToken(refresh) },
              include: { session: true },
            });
            if (
              !g ||
              g.clientId !== client.id ||
              g.revokedAt ||
              g.session.revokedAt ||
              !g.refreshExpiresAt ||
              g.refreshExpiresAt <= new Date()
            ) {
              throw new OAuthError(400, 'invalid_grant', 'Autorização expirada ou revogada.');
            }
            // Rotação: o token de renovação anterior deixa de valer; acessos antigos expiram sozinhos.
            await tx.oAuthAccessToken.deleteMany({
              where: { grantId: g.id, expiresAt: { lt: new Date() } },
            });
            return issue(tx, g.id);
          });
          return reply.header('cache-control', 'no-store').send(result);
        }
        throw new OAuthError(400, 'unsupported_grant_type', 'Tipo de concessão não suportado.');
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    },
  );

  /** Revogação pelo aplicativo (Desconectar). Aceita token de acesso ou de renovação. */
  app.post(
    '/api/oauth/revoke',
    { config: { access: { public: true, serverToServer: true } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const client = await authenticateClient(request, body);
        const token = String(body.token ?? '');
        const h = hashToken(token);
        const byRefresh = await prisma.oAuthGrant.findUnique({ where: { refreshHash: h } });
        const byAccess = byRefresh
          ? null
          : await prisma.oAuthAccessToken.findUnique({
              where: { tokenHash: h },
              include: { grant: true },
            });
        const grant = byRefresh ?? byAccess?.grant ?? null;
        if (grant && grant.clientId === client.id) {
          await prisma.$transaction((tx) =>
            revokeGrant(
              tx,
              { ...actorFrom(request), userId: grant.userId, sessionId: grant.sessionId },
              grant.id,
              'desconectado_pelo_app',
              null,
            ),
          );
        }
        // RFC 7009: responde 200 mesmo para token desconhecido.
        return reply.header('cache-control', 'no-store').send({ ok: true });
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    },
  );

  /** Quem é o aplicativo conectado: empresa, pessoa, escopos e permissões efetivas. */
  app.get(
    '/api/v1/apps/me',
    { config: { access: { session: 'WEB', surfaceExempt: true } } },
    async (request) => {
      const auth = request.auth!;
      if (!auth.app) throw Errors.forbidden('Disponível apenas para aplicativos conectados.');
      return {
        company: await company(),
        user: { id: auth.userId, name: auth.displayName, email: auth.email },
        grantId: auth.app.grantId,
        scopes: auth.app.scopes,
        permissions: [...auth.permissions].sort(),
        expiresAt: auth.expiresAt.toISOString(),
      };
    },
  );

  /** Aplicativos conectados (painel): os da pessoa; quem revoga sessões vê todos. */
  app.get('/api/v1/apps/grants', { config: { access: { session: 'WEB' } } }, async (request) => {
    const auth = request.auth!;
    if (auth.app) throw Errors.forbidden();
    const all = auth.permissions.has('sessoes.revogar');
    const rows = await prisma.oAuthGrant.findMany({
      where: all ? {} : { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        client: { select: { name: true } },
        user: { select: { displayName: true } },
      },
    });
    return rows.map((g) => ({
      id: g.id,
      client: g.client.name,
      org: g.externalLabel,
      user: g.user.displayName,
      scopes: g.scopes.map((s) => ({
        key: s,
        label: (APP_SCOPES as Record<string, { label: string }>)[s]?.label ?? s,
      })),
      permissions: scopePermissions(g.scopes).size,
      createdAt: g.createdAt.toISOString(),
      lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
      revokedAt: g.revokedAt?.toISOString() ?? null,
      revokedReason: g.revokedReason,
      mine: g.userId === auth.userId,
    }));
  });

  // ── Cadastro de aplicativos (administração da empresa) ──
  const ADMIN = { session: 'WEB', permissions: ['empresa.configurar'] } as const;
  const clientView = (c: {
    clientId: string;
    name: string;
    redirectUris: string[];
    allowedScopes: string[];
    active: boolean;
    updatedAt: Date;
  }) => ({
    clientId: c.clientId,
    name: c.name,
    redirectUris: c.redirectUris,
    scopes: c.allowedScopes,
    active: c.active,
    updatedAt: c.updatedAt.toISOString(),
  });

  app.get('/api/v1/apps/clients', { config: { access: ADMIN } }, async (request) => {
    if (request.auth!.app) throw Errors.forbidden();
    const rows = await prisma.oAuthClient.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(clientView);
  });

  /**
   * Cadastra um aplicativo ou gira o segredo de um existente. O segredo aparece UMA vez na
   * resposta (só o hash fica guardado). Endereços de retorno: só HTTPS (http://localhost apenas
   * fora de produção), sem curingas, comparados exatamente na autorização.
   */
  app.post('/api/v1/apps/clients', { config: { access: ADMIN } }, async (request) => {
    if (request.auth!.app) throw Errors.forbidden();
    const input = z
      .object({
        clientId: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'Identificador: letras minúsculas, números e hífen.'),
        name: z.string().trim().min(2).max(80),
        redirectUris: z.array(z.string().url().max(500)).min(1).max(5),
        scopes: z.array(z.string()).min(1),
      })
      .parse(request.body);
    const scopes = parseScopes(input.scopes);
    if (!scopes.length)
      throw Errors.validation(undefined, 'Escolha ao menos uma permissão válida.');
    for (const r of input.redirectUris) {
      const u = new URL(r);
      const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
      if (u.protocol !== 'https:' && !(local && env.APP_ENV !== 'production'))
        throw Errors.validation(undefined, `Endereço de retorno precisa usar HTTPS: ${r}`);
      if (u.hash || u.username || u.password)
        throw Errors.validation(undefined, `Endereço de retorno inválido: ${r}`);
    }
    const secret = randomToken();
    const saved = await prisma.$transaction(async (tx) => {
      const c = await tx.oAuthClient.upsert({
        where: { clientId: input.clientId },
        create: {
          clientId: input.clientId,
          name: input.name,
          secretHash: hashToken(secret),
          redirectUris: input.redirectUris,
          allowedScopes: scopes,
        },
        update: {
          name: input.name,
          secretHash: hashToken(secret),
          redirectUris: input.redirectUris,
          allowedScopes: scopes,
          active: true,
        },
      });
      await audit(tx, actorFrom(request), {
        action: 'app.client_saved',
        entityType: 'oauth_client',
        entityId: c.id,
        summary: `Aplicativo ${c.name} (${c.clientId}) cadastrado/atualizado; segredo novo gerado.`,
        changes: { redirectUris: input.redirectUris, scopes },
      });
      return c;
    });
    return { ...clientView(saved), secret };
  });

  app.post(
    '/api/v1/apps/clients/:clientId/deactivate',
    { config: { access: ADMIN } },
    async (request) => {
      if (request.auth!.app) throw Errors.forbidden();
      const { clientId } = z.object({ clientId: z.string().max(64) }).parse(request.params);
      const c = await prisma.oAuthClient.findUnique({ where: { clientId } });
      if (!c) throw Errors.notFound('Aplicativo');
      await prisma.$transaction(async (tx) => {
        await tx.oAuthClient.update({ where: { id: c.id }, data: { active: false } });
        const grants = await tx.oAuthGrant.findMany({
          where: { clientId: c.id, revokedAt: null },
          select: { id: true },
        });
        for (const g of grants)
          await revokeGrant(tx, actorFrom(request), g.id, 'app_desativado', request.auth!.userId);
        await audit(tx, actorFrom(request), {
          action: 'app.client_deactivated',
          entityType: 'oauth_client',
          entityId: c.id,
          summary: `Aplicativo ${c.name} desativado; ${grants.length} autorização(ões) revogada(s).`,
        });
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/apps/grants/:id/revoke',
    { config: { access: { session: 'WEB' } } },
    async (request) => {
      const auth = request.auth!;
      if (auth.app) throw Errors.forbidden();
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const g = await prisma.oAuthGrant.findUnique({ where: { id } });
      if (!g) throw Errors.notFound('Autorização');
      if (g.userId !== auth.userId && !auth.permissions.has('sessoes.revogar')) {
        throw Errors.forbidden();
      }
      const ok = await prisma.$transaction((tx) =>
        revokeGrant(tx, actorFrom(request), g.id, 'revogado_no_cenario', auth.userId),
      );
      return { revoked: ok };
    },
  );
}
