import {
  platformLoginSchema,
  platformPasswordSchema,
  passwordPolicySchema,
  EMAIL_MAX,
  type PlatformAuditDto,
  type PlatformMeDto,
} from '@cenario/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { PLATFORM_COMPANY_ID } from '../../core/tenant';
import { burnVerification, hashSecret, randomToken, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { cookieOptions, platformSessionExpiry } from '../../plugins/auth';
import type { Tx, PrismaClient } from '@cenario/db';

const PLATFORM = { platform: true } as const;

/** Registra no histórico do painel (Minha conta → Histórico). */
export async function platformLog(
  db: Tx | PrismaClient,
  request: FastifyRequest,
  entry: { action: string; summary: string; companyId?: number | null },
) {
  await db.platformAuditLog.create({
    data: {
      adminId: request.platformAdmin?.id ?? null,
      action: entry.action,
      targetCompanyId: entry.companyId ?? null,
      summary: entry.summary.slice(0, 300),
      ipAddress: request.ip ?? null,
    },
  });
}

const firstAccessSchema = z
  .object({
    email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
    displayName: z.string().trim().min(2, { message: 'Informe o seu nome.' }).max(80),
    password: passwordPolicySchema,
    passwordConfirm: z.string().max(128),
  })
  .refine((v) => v.password === v.passwordConfirm, {
    message: 'As senhas não conferem.',
    path: ['passwordConfirm'],
  });

/**
 * Login do painel da plataforma (/plataforma). Separado do login das empresas: tabela, cookie e
 * sessão próprios. O primeiro acesso é criado uma vez, por quem já administra a Cenário Estofados
 * (empresa nº 1) — sem comando no servidor. Depois disso o painel não depende daquela conta.
 */
export async function platformAuthRoutes(app: FastifyInstance) {
  const { system, env, hashToken, cookies } = app.ctx;
  const throttle = new AuthThrottle(system);

  async function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    admin: { id: string; email: string; displayName: string },
  ): Promise<PlatformMeDto> {
    const token = randomToken();
    const now = new Date();
    const expiresAt = platformSessionExpiry(now, now);
    await system.$transaction(async (tx) => {
      const s = await tx.platformAdminSession.create({
        data: {
          adminId: admin.id,
          tokenHash: hashToken(token),
          expiresAt,
          ipAddress: request.ip?.slice(0, 64) ?? null,
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
        },
      });
      await tx.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
      await tx.platformAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'platform.login',
          summary: `${admin.displayName} entrou no painel.`,
          ipAddress: request.ip ?? null,
        },
      });
      return s;
    });
    void reply.setCookie(
      cookies.platform,
      token,
      cookieOptions(env.COOKIE_SECURE, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
    );
    return { id: admin.id, email: admin.email, displayName: admin.displayName };
  }

  /** A tela de entrar mostra "Criar o acesso" enquanto ninguém foi cadastrado. */
  app.get('/api/plataforma/estado', { config: { access: { public: true } } }, async () => ({
    hasAdmin: (await system.platformAdmin.count()) > 0,
  }));

  app.post(
    '/api/plataforma/primeiro-acesso',
    { config: { access: { session: 'WEB', permissions: ['empresa.configurar'] } } },
    async (request, reply) => {
      if (request.auth?.companyId !== PLATFORM_COMPANY_ID || request.auth.app)
        throw Errors.forbidden(
          'O primeiro acesso do painel é criado por quem administra a Cenário Estofados.',
        );
      const input = firstAccessSchema.parse(request.body);
      const passwordHash = await hashSecret(input.password);
      const admin = await system.$transaction(async (tx) => {
        // Trava: só existe um "primeiro acesso" (duas abas ao mesmo tempo não criam dois).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform-first-admin'))`;
        if ((await tx.platformAdmin.count()) > 0)
          throw Errors.conflict('O acesso do painel já foi criado. Entre com ele.');
        const created = await tx.platformAdmin.create({
          data: { email: input.email, displayName: input.displayName, passwordHash },
        });
        await tx.platformAuditLog.create({
          data: {
            adminId: created.id,
            action: 'platform.first_access',
            summary: `Acesso do painel criado para ${input.email} (por ${request.auth!.displayName}, da Cenário Estofados).`,
            ipAddress: request.ip ?? null,
          },
        });
        return created;
      });
      return startSession(request, reply, admin);
    },
  );

  app.post(
    '/api/plataforma/entrar',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = platformLoginSchema.parse(request.body);
      const accountKey = `plataforma:${input.email}`;
      const ipKey = clientIpKey(request, 'ip');
      await throttle.assertAllowed([accountKey, ipKey]);
      const admin = await system.platformAdmin.findUnique({ where: { email: input.email } });
      const ok = admin
        ? await verifySecret(admin.passwordHash, input.password)
        : (await burnVerification(input.password), false);
      if (!admin || !ok || !admin.active) {
        await throttle.registerFailure(accountKey, POLICIES.account);
        await throttle.registerFailure(ipKey, POLICIES.ip);
        request.log.info(
          { event: 'platform.login_failed' },
          'Falha de login no painel da plataforma',
        );
        throw Errors.invalidCredentials('E-mail ou senha incorretos.');
      }
      await throttle.reset(accountKey);
      return startSession(request, reply, admin);
    },
  );

  app.post('/api/plataforma/sair', { config: { access: PLATFORM } }, async (request, reply) => {
    await system.platformAdminSession.update({
      where: { id: request.platformAdmin!.sessionId },
      data: { revokedAt: new Date() },
    });
    void reply.clearCookie(cookies.platform, { path: '/' });
    return { ok: true };
  });

  app.get('/api/plataforma/eu', { config: { access: PLATFORM } }, async (request) => {
    const a = request.platformAdmin!;
    return { id: a.id, email: a.email, displayName: a.displayName } satisfies PlatformMeDto;
  });

  app.post('/api/plataforma/senha', { config: { access: PLATFORM } }, async (request) => {
    const input = platformPasswordSchema.parse(request.body);
    const me = request.platformAdmin!;
    const admin = await system.platformAdmin.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifySecret(admin.passwordHash, input.currentPassword)))
      throw Errors.validation(
        { currentPassword: 'Senha atual incorreta.' },
        'A senha atual não confere.',
      );
    const passwordHash = await hashSecret(input.newPassword);
    await system.$transaction(async (tx) => {
      await tx.platformAdmin.update({
        where: { id: me.id },
        data: { passwordHash, credentialsChangedAt: new Date() },
      });
      // As outras sessões abertas (outro computador, celular) saem.
      await tx.platformAdminSession.updateMany({
        where: { adminId: me.id, revokedAt: null, id: { not: me.sessionId } },
        data: { revokedAt: new Date() },
      });
      await platformLog(tx, request, {
        action: 'platform.password_changed',
        summary: `${me.displayName} trocou a senha do painel.`,
      });
    });
    return { ok: true };
  });

  /** Histórico do painel (o que foi feito aqui) + o que as rotas antigas gravaram na auditoria. */
  app.get('/api/plataforma/historico', { config: { access: PLATFORM } }, async () => {
    const rows = await system.platformAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { admin: { select: { displayName: true } } },
    });
    return {
      items: rows.map(
        (r): PlatformAuditDto => ({
          id: r.id,
          at: r.createdAt.toISOString(),
          action: r.action,
          summary: r.summary,
          by: r.admin?.displayName ?? null,
        }),
      ),
    };
  });
}
