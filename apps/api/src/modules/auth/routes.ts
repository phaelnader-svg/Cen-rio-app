import {
  DEFAULT_ROLE_SKILLS,
  EVENT_TYPES,
  GESTOR_ROLE_KEY,
  PROVISIONAL_TRADE_NAME,
  adminLoginSchema,
  changePasswordSchema,
  signupSchema,
} from '@cenario/shared';
import { createCompanyContent, isUniqueViolation } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { loadUserPermissions } from '../../core/permissions';
import { createSession, revokeSessions } from '../../core/sessions';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { burnVerification, hashSecret, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { cookieOptions } from '../../plugins/auth';
import { buildMe, employeeEventPayload } from '../presenters';
import { captchaFailed } from '../../core/captcha';
import { sendConfirmationEmail } from '../account/emails';
import { signupExtrasSchema } from '@cenario/shared';

export async function authRoutes(app: FastifyInstance) {
  const { prisma, system, env, hashToken, cookies } = app.ctx;
  const throttle = new AuthThrottle(prisma);

  /** Login do painel administrativo (e-mail + senha). */
  app.post('/api/auth/login', { config: { access: { public: true } } }, async (request, reply) => {
    const input = adminLoginSchema.parse(request.body);
    const accountKey = `email:${input.email}`;
    const ipKey = clientIpKey(request, 'ip');
    await throttle.assertAllowed([accountKey, ipKey]);

    // Multi-empresa: o e-mail é único no sistema todo e diz de qual empresa é o usuário.
    const user = await system.user.findUnique({
      where: { email: input.email },
      include: {
        employee: { select: { active: true } },
        company: { select: { blockedAt: true } },
      },
    });
    const ok = user?.passwordHash
      ? await verifySecret(user.passwordHash, input.password)
      : (await burnVerification(input.password), false);

    if (!user || !ok || !user.active || user.employee?.active === false) {
      await throttle.registerFailure(accountKey, POLICIES.account);
      await throttle.registerFailure(ipKey, POLICIES.ip);
      request.log.info({ event: 'auth.login_failed' }, 'Falha de login no painel');
      throw Errors.invalidCredentials('E-mail ou senha incorretos.');
    }

    if (user.company.blockedAt) {
      throw Errors.forbidden(
        'O acesso desta empresa está bloqueado. Fale com o suporte do Cenário.',
      );
    }
    if (request.tenant) request.tenant.companyId = user.companyId;
    const permissions = await loadUserPermissions(prisma, user.id);
    if (!permissions.has('painel.acessar')) {
      throw Errors.forbidden('Seu usuário não tem acesso ao painel administrativo.');
    }
    await throttle.reset(accountKey);

    const actor = { ...actorFrom(request), userId: user.id };
    const { session, token } = await prisma.$transaction(async (tx) => {
      const created = await createSession(tx, env, hashToken, {
        kind: 'WEB',
        userId: user.id,
        deviceId: null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit(
        tx,
        { ...actor, sessionId: created.session.id },
        {
          action: 'auth.login',
          entityType: 'session',
          entityId: created.session.id,
          summary: `${user.displayName} entrou no painel administrativo.`,
        },
      );
      return created;
    });

    const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
    void reply.setCookie(cookies.session, token, cookieOptions(env.COOKIE_SECURE, maxAge));
    return buildMe(prisma, {
      sessionId: session.id,
      kind: 'WEB',
      userId: user.id,
      deviceId: null,
      expiresAt: session.expiresAt,
      permissions,
    });
  });

  /**
   * Criar conta (tela /entrar). Multi-empresa, etapa 4 (decisão do dono, 16/11/2026): cada conta
   * criada é uma EMPRESA NOVA, com dados separados de todas as outras, e entra direto, sem
   * aprovação. Quem cria vira o gestor dessa empresa (todas as permissões dela). Nunca entra numa
   * empresa que já existe.
   */
  app.post('/api/auth/signup', { config: { access: { public: true } } }, async (request, reply) => {
    const input = signupSchema.parse(request.body);
    const extras = signupExtrasSchema.parse(request.body ?? {});
    const ipKey = clientIpKey(request, 'signup-ip');
    await throttle.assertAllowed([ipKey, 'signup:global']);
    // Anti-robô (melhoria 5): campo-isca invisível (só robô preenche) e o Turnstile, quando
    // configurado. O robô recebe a mesma recusa e não gasta o limite de quem é de verdade.
    if (extras.website) throw captchaFailed();
    if (app.ctx.captcha && !(await app.ctx.captcha(extras.captcha, request.ip)))
      throw captchaFailed();
    await throttle.registerFailure(ipKey, POLICIES.signup);
    await throttle.registerFailure(
      'signup:global',
      app.ctx.captcha ? POLICIES.signupGlobalWithCaptcha : POLICIES.signupGlobal,
    );

    const taken = await system.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (taken) throw Errors.conflict('Já existe uma conta com este e-mail. Entre com a sua senha.');

    const passwordHash = await hashSecret(input.password);
    const displayName = (input.email.split('@')[0] || 'Gestor').slice(0, 40).padEnd(2, '_');
    let created;
    try {
      created = await system.$transaction(async (tx) => {
        // Cobrança: teste grátis (7 dias, decisão do dono), no plano Cenário Gestão.
        const company = await tx.companySettings.create({
          data: {
            tradeName: PROVISIONAL_TRADE_NAME,
            email: input.email,
            plan: 'gestao',
            trialEndsAt: new Date(Date.now() + env.BILLING_TRIAL_DAYS * 86_400_000),
          },
        });
        // Daqui em diante a transação é da empresa nova, com a trava do banco ligada: tudo o que
        // for gravado fica nela, e nada de outra empresa aparece.
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(company.id)}, true),
          set_config('app.bypass_rls', 'off', true)`;
        if (request.tenant) request.tenant.companyId = company.id;

        const roles = await createCompanyContent(tx);
        const user = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            displayName,
            credentialsChangedAt: new Date(),
            roles: { create: { roleId: roles.get(GESTOR_ROLE_KEY)! } },
          },
        });
        const employee = await tx.employee.create({
          data: {
            userId: user.id,
            fullName: displayName,
            displayName,
            jobTitle: 'Gestor',
            color: '#1D4ED8',
          },
        });
        const skills = DEFAULT_ROLE_SKILLS[GESTOR_ROLE_KEY] ?? [];
        if (skills.length)
          await tx.employeeSkill.createMany({
            data: skills.map((skill) => ({ employeeId: employee.id, skill })),
          });
        const session = await createSession(tx, env, hashToken, {
          kind: 'WEB',
          userId: user.id,
          deviceId: null,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        const actor = { ...actorFrom(request), userId: user.id, sessionId: session.session.id };
        await audit(tx, actor, {
          action: 'auth.signup',
          entityType: 'company',
          entityId: String(company.id),
          summary: `Conta criada pela tela de entrar (${input.email}): empresa nova nº ${company.id}.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.EMPLOYEE_CREATED,
          aggregateType: 'employee',
          aggregateId: employee.id,
          payload: employeeEventPayload(employee),
        });
        // Melhoria 3: link para confirmar o e-mail (a conta já funciona; o painel mostra o aviso).
        await sendConfirmationEmail(tx, env, hashToken, {
          id: user.id,
          companyId: company.id,
          email: input.email,
        });
        return { ...session, userId: user.id };
      });
    } catch (error) {
      if (request.tenant) request.tenant.companyId = null;
      if (isUniqueViolation(error, 'email')) {
        throw Errors.conflict('Já existe uma conta com este e-mail. Entre com a sua senha.');
      }
      throw error;
    }

    app.ctx.mailer.kick();
    const { session, token, userId } = created;
    const permissions = await loadUserPermissions(prisma, userId);
    const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
    void reply.setCookie(cookies.session, token, cookieOptions(env.COOKIE_SECURE, maxAge));
    const me = await buildMe(prisma, {
      sessionId: session.id,
      kind: 'WEB',
      userId,
      deviceId: null,
      expiresAt: session.expiresAt,
      permissions,
    });
    return reply.status(201).send(me);
  });

  /** Encerra a sessão atual (painel ou tablet). No tablet, o dispositivo continua vinculado. */
  app.post(
    '/api/auth/logout',
    { config: { access: { session: 'any', surfaceExempt: true } } },
    async (request, reply) => {
      const auth = request.auth!;
      await prisma.$transaction(async (tx) => {
        const actor = actorFrom(request);
        await revokeSessions(tx, actor, { id: auth.sessionId }, 'logout');
        await audit(tx, actor, {
          action: 'auth.logout',
          entityType: 'session',
          entityId: auth.sessionId,
          summary: `${auth.displayName} saiu (${auth.kind === 'WEB' ? 'painel' : 'tablet'}).`,
        });
      });
      void reply.clearCookie(cookies.session, { path: '/' });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/auth/me',
    { config: { access: { session: 'any', surfaceExempt: true } } },
    async (request) => buildMe(prisma, request.auth!),
  );

  /** Troca da própria senha; encerra as demais sessões do usuário. */
  app.post(
    '/api/auth/password',
    { config: { access: { session: 'WEB' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const input = changePasswordSchema.parse(request.body);
      const key = `password-change:${auth.userId}`;
      await throttle.assertAllowed([key]);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.passwordHash || !(await verifySecret(user.passwordHash, input.currentPassword))) {
        await throttle.registerFailure(key, POLICIES.account);
        throw Errors.invalidCredentials('Senha atual incorreta.');
      }
      await throttle.reset(key);
      const passwordHash = await hashSecret(input.newPassword);
      await prisma.$transaction(async (tx) => {
        const actor = actorFrom(request);
        await tx.user.update({
          where: { id: auth.userId },
          data: { passwordHash, credentialsChangedAt: new Date(), version: { increment: 1 } },
        });
        await revokeSessions(
          tx,
          actor,
          { userId: auth.userId, kind: 'WEB', id: { not: auth.sessionId } },
          'credentials_changed',
        );
        await audit(tx, actor, {
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: auth.userId,
          summary: `${auth.displayName} alterou a própria senha.`,
        });
      });
      return reply.status(204).send();
    },
  );
}
