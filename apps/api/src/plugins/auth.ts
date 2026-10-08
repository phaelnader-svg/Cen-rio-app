import type { Permission } from '@cenario/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Errors } from '../lib/errors';
import { loadUserPermissions } from '../core/permissions';
import { sessionExpiry } from '../core/sessions';
import type { AccessRule } from '../core/types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Intervalo mínimo entre atualizações de "último acesso" (reduz escritas no banco). */
const TOUCH_INTERVAL_MS = 60_000;
/** Limite de idade de cookies aceito pelos navegadores (400 dias). */
export const MAX_COOKIE_AGE_SECONDS = 400 * 86_400;

export function cookieOptions(secure: boolean, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Autenticação, autorização e proteção de origem.
 *
 * - Toda rota /api precisa declarar `config.access`; caso contrário a API nem inicia
 *   (protege contra rotas esquecidas sem controle de acesso).
 * - Métodos que alteram estado e conexões WebSocket exigem cabeçalho Origin
 *   pertencente à lista de origens permitidas (proteção CSRF/CSWSH).
 * - Sessões de tablet só valem junto com a credencial do dispositivo vinculado.
 * - Sessões web exigem `painel.acessar`; sessões de tablet exigem `producao.acessar`.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  const { prisma, env, hashToken, cookies } = app.ctx;
  const allowedOrigins = new Set(env.ALLOWED_ORIGINS);

  app.decorateRequest('auth', null);
  app.decorateRequest('device', null);

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    const access = (route.config as { access?: AccessRule } | undefined)?.access;
    if (!access) {
      throw new Error(`Rota sem regra de acesso declarada: ${String(route.method)} ${route.url}`);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const access = request.routeOptions.config?.access;
    if (!access) return; // 404 e rotas fora de /api

    // 1. Origem (CSRF / WebSocket cross-site)
    const isUpgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
    if (!SAFE_METHODS.has(request.method) || isUpgrade) {
      const origin = request.headers.origin?.replace(/\/$/, '');
      if (!origin || !allowedOrigins.has(origin)) throw Errors.originNotAllowed();
    }

    // 2. Credencial de dispositivo
    await resolveDevice(request, reply);

    // 3. Sessão
    await resolveSession(request, reply);

    // 4. Regra de acesso
    enforce(request, access);
  });

  async function resolveDevice(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[cookies.device];
    if (!token) return;
    const device = await prisma.device.findUnique({ where: { credentialHash: hashToken(token) } });
    if (!device || device.status !== 'ACTIVE') {
      void reply.clearCookie(cookies.device, { path: '/' });
      return;
    }
    request.device = {
      id: device.id,
      name: device.name,
      assignedEmployeeId: device.assignedEmployeeId,
      restrictToAssigned: device.restrictToAssigned,
    };
    const now = Date.now();
    if (!device.lastSeenAt || now - device.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await prisma.device.update({
        where: { id: device.id },
        data: {
          lastSeenAt: new Date(now),
          lastIp: request.ip,
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
        },
      });
      // Renova o cookie do dispositivo (sessão permanente do tablet).
      void reply.setCookie(
        cookies.device,
        token,
        cookieOptions(env.COOKIE_SECURE, MAX_COOKIE_AGE_SECONDS),
      );
    }
  }

  async function resolveSession(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[cookies.session];
    if (!token) return;
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { employee: { select: { id: true, active: true } } } } },
    });
    const now = new Date();
    const valid =
      session &&
      !session.revokedAt &&
      session.expiresAt > now &&
      session.user.active &&
      (session.user.employee?.active ?? true) &&
      (session.kind === 'WEB' ||
        (request.device !== null && request.device.id === session.deviceId));
    if (!session || !valid) {
      void reply.clearCookie(cookies.session, { path: '/' });
      return;
    }
    const permissions = await loadUserPermissions(prisma, session.userId);
    let expiresAt = session.expiresAt;
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      expiresAt = sessionExpiry(env, session.kind, session.createdAt, now);
      await prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt },
      });
      const maxAge =
        session.kind === 'DEVICE'
          ? MAX_COOKIE_AGE_SECONDS
          : Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
      void reply.setCookie(cookies.session, token, cookieOptions(env.COOKIE_SECURE, maxAge));
    }
    request.auth = {
      sessionId: session.id,
      kind: session.kind,
      userId: session.userId,
      displayName: session.user.displayName,
      email: session.user.email,
      employeeId: session.user.employee?.id ?? null,
      deviceId: session.deviceId,
      permissions,
      expiresAt,
    };
  }

  function enforce(request: FastifyRequest, access: AccessRule) {
    if ('public' in access) return;
    if ('device' in access) {
      if (!request.device) throw Errors.deviceRequired();
      return;
    }
    const auth = request.auth;
    if (!auth) throw Errors.unauthenticated();
    if (access.session !== 'any' && auth.kind !== access.session) {
      throw Errors.forbidden(
        access.session === 'WEB'
          ? 'Esta operação está disponível apenas no painel administrativo.'
          : 'Esta operação está disponível apenas nos tablets da oficina.',
      );
    }
    const surface: Permission = auth.kind === 'WEB' ? 'painel.acessar' : 'producao.acessar';
    const required: readonly Permission[] = [
      ...(access.surfaceExempt ? [] : [surface]),
      ...(access.permissions ?? []),
    ];
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (
      access.anyPermissions?.length &&
      !access.anyPermissions.some((p) => auth.permissions.has(p))
    ) {
      missing.push(...access.anyPermissions);
    }
    if (missing.length > 0) {
      request.log.info({ missing, userId: auth.userId }, 'Acesso negado por permissão');
      throw Errors.forbidden();
    }
  }
});
