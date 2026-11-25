import {
  platformLoginSchema,
  platformPasswordSchema,
  platformForgotSchema,
  platformResetSchema,
  type PlatformAuditDto,
  type PlatformMeDto,
} from '@cenario/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { PLATFORM_RECORD_ID, runAsCompany } from '../../core/tenant';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
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

/**
 * Login do painel da plataforma (/plataforma). Separado do login das empresas: tabela, cookie e
 * sessão próprios. Não depende de nenhuma tapeçaria (2026-11-25): a senha esquecida volta por
 * e-mail; numa instalação nova, o primeiro acesso é criado no servidor (comando do suporte).
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

  /** A tela de entrar avisa quando o acesso do painel ainda não foi criado (instalação nova). */
  app.get('/api/plataforma/estado', { config: { access: { public: true } } }, async () => ({
    hasAdmin: (await system.platformAdmin.count()) > 0,
  }));

  /**
   * Esqueci a senha do painel. A resposta é sempre 204, exista o e-mail ou não. O link vale 1 hora
   * e só uma vez. Não depende de nenhuma conta de tapeçaria (pedido do dono em 25/11/2026).
   */
  app.post(
    '/api/plataforma/esqueci',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const { email } = platformForgotSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'plataforma-esqueci');
      const emailKey = `plataforma-esqueci:${email}`;
      await throttle.assertAllowed([ipKey]);
      await throttle.registerFailure(ipKey, POLICIES.forgot);
      const locked = await throttle
        .assertAllowed([emailKey])
        .then(() => false)
        .catch(() => true);
      if (locked) return reply.status(204).send();
      await throttle.registerFailure(emailKey, POLICIES.forgotEmail);
      const admin = await system.platformAdmin.findUnique({ where: { email } });
      if (!admin?.active) return reply.status(204).send();
      const token = randomToken();
      const url = `${(env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0] || '').replace(/\/$/, '')}/plataforma/nova-senha?token=${encodeURIComponent(token)}`;
      const body = simpleEmail({
        title: 'Senha nova do painel',
        paragraphs: [
          'Recebemos um pedido para trocar a senha do painel da plataforma do Cenário Gestão.',
          'O link vale por 1 hora e só pode ser usado uma vez.',
        ],
        button: { label: 'Criar senha nova', url },
        footer: 'Se não foi você que pediu, ignore este e-mail: a senha atual continua valendo.',
      });
      await runAsCompany(PLATFORM_RECORD_ID, () =>
        system.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_RECORD_ID)}, true)`;
          await tx.platformAdminReset.updateMany({
            where: { adminId: admin.id, usedAt: null },
            data: { usedAt: new Date() },
          });
          await tx.platformAdminReset.create({
            data: {
              adminId: admin.id,
              tokenHash: hashToken(token),
              expiresAt: new Date(Date.now() + 60 * 60_000),
            },
          });
          await enqueueEmail(tx, {
            to: admin.email,
            subject: 'Senha nova do painel — Cenário Gestão',
            kind: 'plataforma-senha',
            ...body,
          });
          await tx.platformAuditLog.create({
            data: {
              adminId: admin.id,
              action: 'platform.password_reset_requested',
              summary: 'Pedido de senha nova pela tela de entrar do painel.',
              ipAddress: request.ip ?? null,
            },
          });
        }),
      );
      app.ctx.mailer.kick();
      return reply.status(204).send();
    },
  );

  /** Senha nova pelo link do e-mail: troca a senha e encerra todas as sessões do painel. */
  app.post(
    '/api/plataforma/nova-senha',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = platformResetSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'plataforma-nova-senha');
      await throttle.assertAllowed([ipKey]);
      const row = await system.platformAdminReset.findUnique({
        where: { tokenHash: hashToken(input.token) },
        include: { admin: true },
      });
      if (!row || row.usedAt || row.expiresAt <= new Date() || !row.admin.active) {
        await throttle.registerFailure(ipKey, POLICIES.ip);
        throw Errors.business(
          'Este link não vale mais (já foi usado ou passou de 1 hora). Peça outro em "Esqueci a senha".',
        );
      }
      const passwordHash = await hashSecret(input.password);
      await system.$transaction(async (tx) => {
        const burned = await tx.platformAdminReset.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (burned.count !== 1) throw Errors.business('Este link já foi usado.');
        await tx.platformAdmin.update({
          where: { id: row.adminId },
          data: { passwordHash, credentialsChangedAt: new Date() },
        });
        await tx.platformAdminSession.updateMany({
          where: { adminId: row.adminId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.platformAuditLog.create({
          data: {
            adminId: row.adminId,
            action: 'platform.password_reset',
            summary: 'Senha do painel trocada pelo link do e-mail.',
            ipAddress: request.ip ?? null,
          },
        });
      });
      return startSession(request, reply, row.admin);
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
