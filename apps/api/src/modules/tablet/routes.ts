import { EVENT_TYPES, pairDeviceSchema, tabletLoginSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import { createSession, revokeSessions } from '../../core/sessions';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { burnVerification, randomToken, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { MAX_COOKIE_AGE_SECONDS, cookieOptions } from '../../plugins/auth';
import { buildMe, toEmployeeSummary } from '../presenters';

export async function tabletRoutes(app: FastifyInstance) {
  const { prisma, env, hashToken, cookies } = app.ctx;
  const throttle = new AuthThrottle(prisma);

  /**
   * Situação do tablet: se está vinculado e quem pode entrar nele.
   * Rota pública: um navegador sem credencial de dispositivo recebe apenas `paired: false`.
   */
  app.get('/api/tablet/status', { config: { access: { public: true } } }, async (request) => {
    const device = request.device;
    if (!device) return { paired: false as const };

    const employees = await prisma.employee.findMany({
      where: {
        active: true,
        user: { active: true, pinHash: { not: null } },
        ...(device.restrictToAssigned && device.assignedEmployeeId
          ? { id: device.assignedEmployeeId }
          : {}),
      },
      include: { user: { select: { id: true } } },
      orderBy: { displayName: 'asc' },
    });
    // Só aparecem funcionários com permissão de acesso à produção.
    const allowed = [];
    for (const e of employees) {
      const perms = await loadUserPermissions(prisma, e.user.id);
      if (perms.has('producao.acessar')) allowed.push(toEmployeeSummary(e));
    }
    return {
      paired: true as const,
      device: { id: device.id, name: device.name },
      employees: allowed,
      authenticated: request.auth?.kind === 'DEVICE',
    };
  });

  /** Vincula este navegador/tablet usando o código de uso único gerado pelo gestor. */
  app.post('/api/tablet/pair', { config: { access: { public: true } } }, async (request, reply) => {
    const ipKey = clientIpKey(request, 'pair');
    const pairKey = ipKey ?? 'pair:global';
    const pairPolicy = ipKey ? POLICIES.pairing : POLICIES.pairingGlobal;
    await throttle.assertAllowed([pairKey]);
    const parsed = pairDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      await throttle.registerFailure(pairKey, pairPolicy);
      throw Errors.pairingInvalid();
    }
    const codeHash = hashToken(`pairing:${parsed.data.code}`);
    const credential = randomToken();

    const device = await prisma.$transaction(async (tx) => {
      const found = await tx.device.findUnique({ where: { pairingCodeHash: codeHash } });
      if (!found || !found.pairingCodeExpiresAt || found.pairingCodeExpiresAt < new Date()) {
        return null;
      }
      const actor = { ...actorFrom(request), userId: null };
      // Credencial anterior (se houver) deixa de valer: o tablet foi revinculado.
      await revokeSessions(tx, actor, { deviceId: found.id }, 'device_repaired');
      const updated = await tx.device.update({
        where: { id: found.id, version: found.version },
        data: {
          status: 'ACTIVE',
          credentialHash: hashToken(credential),
          pairingCodeHash: null,
          pairingCodeExpiresAt: null,
          pairedAt: new Date(),
          revokedAt: null,
          revokedById: null,
          lastSeenAt: new Date(),
          lastIp: request.ip,
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'device.paired',
        entityType: 'device',
        entityId: updated.id,
        summary: `Dispositivo "${updated.name}" vinculado.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.DEVICE_PAIRED,
        aggregateType: 'device',
        aggregateId: updated.id,
        payload: { id: updated.id, name: updated.name, version: updated.version },
        audience: 'permission:dispositivos.ver',
      });
      return updated;
    });

    if (!device) {
      await throttle.registerFailure(pairKey, pairPolicy);
      throw Errors.pairingInvalid();
    }
    void reply.clearCookie(cookies.session, { path: '/' });
    void reply.setCookie(
      cookies.device,
      credential,
      cookieOptions(env.COOKIE_SECURE, MAX_COOKIE_AGE_SECONDS),
    );
    return { paired: true, device: { id: device.id, name: device.name } };
  });

  /** Entrada do funcionário no tablet vinculado (funcionário + PIN). */
  app.post(
    '/api/tablet/login',
    { config: { access: { device: true } } },
    async (request, reply) => {
      const device = request.device!;
      const input = tabletLoginSchema.parse(request.body);
      const pinKey = `pin:${input.employeeId}`;
      const ipKey = clientIpKey(request, 'ip');
      await throttle.assertAllowed([pinKey, ipKey]);

      const employee = await prisma.employee.findUnique({
        where: { id: input.employeeId },
        include: { user: true },
      });
      const ok = employee?.user.pinHash
        ? await verifySecret(employee.user.pinHash, input.pin)
        : (await burnVerification(input.pin), false);

      if (!employee || !ok || !employee.active || !employee.user.active) {
        await throttle.registerFailure(pinKey, POLICIES.pin);
        await throttle.registerFailure(ipKey, POLICIES.ip);
        request.log.info(
          { event: 'auth.pin_failed', deviceId: device.id },
          'PIN incorreto no tablet',
        );
        throw Errors.invalidCredentials('PIN incorreto.');
      }
      if (
        device.restrictToAssigned &&
        device.assignedEmployeeId &&
        device.assignedEmployeeId !== employee.id
      ) {
        throw Errors.deviceNotAllowed();
      }
      const permissions = await loadUserPermissions(prisma, employee.userId);
      if (!permissions.has('producao.acessar')) {
        throw Errors.forbidden('Seu usuário não tem acesso à interface de produção.');
      }
      await throttle.reset(pinKey);

      const actor = { ...actorFrom(request), userId: employee.userId };
      const { session, token } = await prisma.$transaction(async (tx) => {
        // Um tablet mantém uma sessão ativa por vez.
        await revokeSessions(tx, actor, { deviceId: device.id }, 'replaced');
        const created = await createSession(tx, env, hashToken, {
          kind: 'DEVICE',
          userId: employee.userId,
          deviceId: device.id,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        await tx.user.update({ where: { id: employee.userId }, data: { lastLoginAt: new Date() } });
        await audit(
          tx,
          { ...actor, sessionId: created.session.id },
          {
            action: 'auth.tablet_login',
            entityType: 'session',
            entityId: created.session.id,
            summary: `${employee.displayName} entrou no tablet "${device.name}".`,
          },
        );
        return created;
      });

      void reply.setCookie(
        cookies.session,
        token,
        cookieOptions(env.COOKIE_SECURE, MAX_COOKIE_AGE_SECONDS),
      );
      return buildMe(prisma, {
        sessionId: session.id,
        kind: 'DEVICE',
        userId: employee.userId,
        deviceId: device.id,
        expiresAt: session.expiresAt,
        permissions,
      });
    },
  );
}
