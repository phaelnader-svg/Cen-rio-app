import { confirmEmailSchema, forgotPasswordSchema, resetPasswordSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { captchaFailed } from '../../core/captcha';
import { revokeSessions } from '../../core/sessions';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { runAsCompany } from '../../core/tenant';
import { hashSecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { sendConfirmationEmail, sendPasswordResetEmail } from './emails';

/**
 * Conta (melhorias 3, 4 e 5): confirmar o e-mail, "esqueci minha senha" e o que a tela de entrar
 * precisa saber do anti-robô.
 */
export async function accountRoutes(app: FastifyInstance) {
  const { prisma, system, env, hashToken, mailer } = app.ctx;
  const throttle = new AuthThrottle(system);

  /** Chave pública do anti-robô (Turnstile); vazia = desligado. */
  app.get('/api/auth/signup-config', { config: { access: { public: true } } }, async () => ({
    captchaSiteKey: app.ctx.captcha ? env.TURNSTILE_SITE_KEY || null : null,
    // Sem envio de e-mail, a tela de entrar não oferece "Esqueci minha senha".
    emailEnabled: app.ctx.mailer.configured,
  }));

  /**
   * Esqueci minha senha. A resposta é sempre a mesma (204), exista o e-mail ou não, para ninguém
   * descobrir quem tem conta. Limites: por IP e por e-mail.
   */
  app.post(
    '/api/auth/password/forgot',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = forgotPasswordSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'forgot-ip');
      const emailKey = `forgot:${input.email}`;
      await throttle.assertAllowed([ipKey]);
      if (app.ctx.captcha && !(await app.ctx.captcha(input.captcha, request.ip)))
        throw captchaFailed();
      await throttle.registerFailure(ipKey, POLICIES.forgot);
      // Mais de 3 pedidos por hora para o mesmo e-mail: não manda mais (mas responde igual).
      const locked = await throttle
        .assertAllowed([emailKey])
        .then(() => false)
        .catch(() => true);
      if (!locked) {
        await throttle.registerFailure(emailKey, POLICIES.forgotEmail);
        const user = await system.user.findUnique({
          where: { email: input.email },
          include: { company: { select: { blockedAt: true } } },
        });
        if (user?.email && user.active && !user.company.blockedAt) {
          const target = { id: user.id, companyId: user.companyId, email: user.email };
          await runAsCompany(user.companyId, () =>
            prisma.$transaction(async (tx) => {
              await sendPasswordResetEmail(tx, env, hashToken, target);
              await audit(
                tx,
                { ...actorFrom(request), userId: user.id },
                {
                  action: 'auth.password_reset_requested',
                  entityType: 'user',
                  entityId: user.id,
                  summary: `${user.displayName} pediu uma senha nova pela tela de entrar.`,
                },
              );
            }),
          );
          mailer.kick();
        }
      }
      return reply.status(204).send();
    },
  );

  /** Senha nova pelo link do e-mail: troca a senha, encerra todas as sessões e confirma o e-mail. */
  app.post(
    '/api/auth/password/reset',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = resetPasswordSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'reset-ip');
      await throttle.assertAllowed([ipKey]);
      const row = await system.emailToken.findUnique({
        where: { tokenHash: hashToken(input.token) },
        include: { user: true },
      });
      if (!row || row.purpose !== 'REDEFINIR_SENHA' || row.usedAt || row.expiresAt <= new Date()) {
        await throttle.registerFailure(ipKey, POLICIES.ip);
        throw Errors.business(
          'Este link não vale mais (já foi usado ou passou de 1 hora). Peça outro em "Esqueci minha senha".',
        );
      }
      const passwordHash = await hashSecret(input.password);
      await runAsCompany(row.companyId, () =>
        prisma.$transaction(async (tx) => {
          // Uso único mesmo com dois cliques ao mesmo tempo.
          const burned = await tx.emailToken.updateMany({
            where: { id: row.id, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (burned.count !== 1) throw Errors.business('Este link já foi usado.');
          await tx.user.update({
            where: { id: row.userId },
            data: {
              passwordHash,
              credentialsChangedAt: new Date(),
              emailConfirmedAt: row.user.emailConfirmedAt ?? new Date(),
              version: { increment: 1 },
            },
          });
          const actor = { ...actorFrom(request), userId: row.userId };
          await revokeSessions(
            tx,
            actor,
            { userId: row.userId, kind: 'WEB' },
            'credentials_changed',
          );
          await audit(tx, actor, {
            action: 'auth.password_reset',
            entityType: 'user',
            entityId: row.userId,
            summary: `${row.user.displayName} criou uma senha nova pelo link do e-mail.`,
          });
        }),
      );
      return reply.status(204).send();
    },
  );

  /** Confirma o e-mail pelo link (não precisa estar logado). */
  app.post('/api/auth/email/confirm', { config: { access: { public: true } } }, async (request) => {
    const input = confirmEmailSchema.parse(request.body);
    const ipKey = clientIpKey(request, 'confirm-ip');
    await throttle.assertAllowed([ipKey]);
    const row = await system.emailToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      include: { user: { select: { emailConfirmedAt: true } } },
    });
    if (!row || row.purpose !== 'CONFIRMAR_EMAIL') {
      await throttle.registerFailure(ipKey, POLICIES.ip);
      throw Errors.business('Link de confirmação inválido. Peça outro no aviso do painel.');
    }
    if (row.user.emailConfirmedAt) return { confirmed: true };
    if (row.usedAt || row.expiresAt <= new Date())
      throw Errors.business('Este link expirou. Peça outro no aviso do painel.');
    await runAsCompany(row.companyId, () =>
      prisma.$transaction(async (tx) => {
        await tx.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
        await tx.user.update({
          where: { id: row.userId },
          data: { emailConfirmedAt: new Date() },
        });
      }),
    );
    return { confirmed: true };
  });

  /** Reenvia o link de confirmação para o e-mail de quem está logado. */
  app.post(
    '/api/auth/email/resend',
    { config: { access: { session: 'WEB', surfaceExempt: true } } },
    async (request, reply) => {
      const auth = request.auth!;
      const key = `confirm-resend:${auth.userId}`;
      await throttle.assertAllowed([key]);
      await throttle.registerFailure(key, POLICIES.forgotEmail);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.email) throw Errors.business('Seu usuário não tem e-mail cadastrado.');
      if (user.emailConfirmedAt) return reply.status(204).send();
      const email = user.email;
      await prisma.$transaction((tx) =>
        sendConfirmationEmail(tx, env, hashToken, {
          id: user.id,
          companyId: user.companyId,
          email,
        }),
      );
      mailer.kick();
      return reply.status(204).send();
    },
  );
}
