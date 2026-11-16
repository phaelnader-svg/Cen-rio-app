import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../app';
import type { CenarioConnection } from '@firma/db';
import { ROLE_LABEL, atLeast, type Role } from '../context';
import { audit } from '../lib/audit';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto';
import { E } from '../lib/errors';
import { sendMail } from '../lib/mail';
import { openSession } from '../lib/session';

const email = z.string().trim().toLowerCase().email('Informe um e-mail válido.').max(254);
export const passwordSchema = z
  .string()
  .min(10, 'A senha precisa ter ao menos 10 caracteres.')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Use letras e números na senha.');

/** Bloqueio simples por conta e por IP depois de tentativas erradas (prévia privada). */
const failures = new Map<string, { n: number; until: number }>();
function assertNotLocked(keys: string[]) {
  const now = Date.now();
  for (const k of keys) {
    const f = failures.get(k);
    if (f && f.until > now) throw E.locked();
  }
}
function fail(keys: string[]) {
  for (const k of keys) {
    const f = failures.get(k) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) {
      f.until = Date.now() + 15 * 60_000;
      f.n = 0;
    }
    failures.set(k, f);
  }
}

/**
 * O que a pessoa pode fazer no jogo agora: o papel na organização limita; com a empresa
 * conectada, vale no máximo o que a autorização do Cenário liberou.
 */
export function effectivePermissions(role: Role, c: CenarioConnection | null): string[] {
  const own = ['jogo.acessar'];
  if (atLeast(role, 'GESTOR')) own.push('jogo.construir', 'agentes.usar', 'agentes.gerenciar');
  if (!c || c.status !== 'CONECTADA') return own;
  const fromCenario = c.permissions.filter(
    (p) => atLeast(role, 'GESTOR') || p.endsWith('.ver') || p.endsWith('.acessar'),
  );
  return [
    ...new Set([
      ...own.filter(
        (p) => p === 'jogo.acessar' || fromCenario.includes(p) || !c.permissions.length,
      ),
      ...fromCenario,
    ]),
  ];
}

export async function authRoutes(app: FastifyInstance) {
  const { db, env, hash } = app.firma;

  const startSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    orgId: string | null,
  ) => openSession(app, request, reply, userId, orgId);

  async function me(userId: string, sessionOrgId: string | null) {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await db.membership.findMany({
      where: { userId },
      include: { org: { include: { connection: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const current = memberships.find((m) => m.orgId === sessionOrgId) ?? null;
    const c = current?.org.connection;
    return {
      permissions: current ? effectivePermissions(current.role as Role, c ?? null) : [],
      user: { id: user.id, name: user.name, email: user.email },
      organizations: memberships.map((m) => ({
        id: m.org.id,
        name: m.org.name,
        role: m.role,
        roleLabel: ROLE_LABEL[m.role as Role],
      })),
      organization: current
        ? {
            id: current.org.id,
            name: current.org.name,
            role: current.role,
            roleLabel: ROLE_LABEL[current.role as Role],
            cenario: c
              ? {
                  status: c.status,
                  companyName: c.companyName,
                  lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
                }
              : { status: 'NAO_CONECTADA', companyName: null, lastSyncAt: null },
          }
        : null,
    };
  }

  app.post('/api/auth/login', { config: { rule: { public: true } } }, async (request, reply) => {
    const input = z.object({ email, password: z.string().min(1).max(200) }).parse(request.body);
    const keys = [`e:${input.email}`, `ip:${request.ip}`];
    assertNotLocked(keys);
    const user = await db.user.findUnique({ where: { email: input.email } });
    const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
    if (!user || !ok || !user.active) {
      fail(keys);
      throw E.invalidCredentials();
    }
    failures.delete(keys[0]!);
    await startSession(request, reply, user.id, null);
    const session = await db.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return me(user.id, session.orgId);
  });

  app.post('/api/auth/logout', { config: { rule: { user: true } } }, async (request, reply) => {
    await db.session.update({
      where: { id: request.user!.sessionId },
      data: { revokedAt: new Date() },
    });
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { rule: { user: true } } }, async (request) =>
    me(request.user!.id, request.org?.id ?? null),
  );

  /** Troca a organização aberta (só entre as organizações da pessoa). */
  app.post('/api/auth/organizacao', { config: { rule: { user: true } } }, async (request) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(request.body);
    const m = await db.membership.findUnique({
      where: { orgId_userId: { orgId, userId: request.user!.id } },
    });
    if (!m) throw E.notFound('Organização');
    await db.session.update({ where: { id: request.user!.sessionId }, data: { orgId } });
    return me(request.user!.id, orgId);
  });

  app.post('/api/auth/senha', { config: { rule: { user: true } } }, async (request) => {
    const input = z
      .object({ current: z.string().min(1), password: passwordSchema })
      .parse(request.body);
    const user = await db.user.findUniqueOrThrow({ where: { id: request.user!.id } });
    if (!(await verifyPassword(user.passwordHash, input.current))) throw E.invalidCredentials();
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password) },
    });
    await db.session.updateMany({
      where: { userId: user.id, id: { not: request.user!.sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });

  // ── Recuperação de senha ──
  app.post('/api/auth/recuperar', { config: { rule: { public: true } } }, async (request) => {
    const input = z.object({ email }).parse(request.body);
    const keys = [`r:${input.email}`, `rip:${request.ip}`];
    assertNotLocked(keys);
    fail(keys); // limita pedidos repetidos
    const user = await db.user.findUnique({ where: { email: input.email } });
    if (user?.active) {
      const token = randomToken();
      await db.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hash(token),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const link = `${env.FIRMA_WEB_URL}/redefinir-senha/${token}`;
      await sendMail(db, env, request.log, {
        to: user.email,
        subject: 'Firma Viva — redefinir senha',
        body: `Olá, ${user.name}. Para criar uma nova senha no Firma Viva, abra o link abaixo (vale por 1 hora). Se não foi você, ignore este e-mail.`,
        link,
      });
    }
    // Mesma resposta exista ou não a conta.
    return {
      ok: true,
      message: 'Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha.',
    };
  });

  app.post('/api/auth/redefinir', { config: { rule: { public: true } } }, async (request) => {
    const input = z
      .object({ token: z.string().min(20).max(100), password: passwordSchema })
      .parse(request.body);
    const row = await db.passwordReset.findUnique({ where: { tokenHash: hash(input.token) } });
    if (!row || row.usedAt || row.expiresAt <= new Date())
      throw E.validation('Link inválido ou expirado. Peça um novo em "Esqueci minha senha".');
    await db.$transaction([
      db.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      db.user.update({
        where: { id: row.userId },
        data: { passwordHash: await hashPassword(input.password) },
      }),
      db.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { ok: true };
  });

  // ── Convites (acesso só por convite) ──
  async function inviteByToken(token: string) {
    const inv = await db.invite.findUnique({
      where: { tokenHash: hash(token) },
      include: { org: { select: { id: true, name: true } } },
    });
    if (!inv || inv.revokedAt || inv.acceptedAt || inv.expiresAt <= new Date())
      throw E.validation('Convite inválido, já usado ou expirado. Peça um novo convite.');
    return inv;
  }

  app.get('/api/auth/convite/:token', { config: { rule: { public: true } } }, async (request) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
    const inv = await inviteByToken(token);
    const existing = await db.user.findUnique({
      where: { email: inv.email },
      select: { id: true },
    });
    return {
      organization: inv.org.name,
      email: inv.email,
      role: inv.role,
      roleLabel: ROLE_LABEL[inv.role as Role],
      hasAccount: Boolean(existing),
    };
  });

  app.post(
    '/api/auth/convite/:token',
    { config: { rule: { public: true } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
      const inv = await inviteByToken(token);
      const existing = await db.user.findUnique({ where: { email: inv.email } });
      let userId: string;
      if (existing) {
        const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
        if (!(await verifyPassword(existing.passwordHash, password))) throw E.invalidCredentials();
        userId = existing.id;
      } else {
        const input = z
          .object({ name: z.string().trim().min(2).max(80), password: passwordSchema })
          .parse(request.body);
        const u = await db.user.create({
          data: {
            email: inv.email,
            name: input.name,
            passwordHash: await hashPassword(input.password),
          },
        });
        userId = u.id;
      }
      await db.$transaction([
        db.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
        db.membership.upsert({
          where: { orgId_userId: { orgId: inv.orgId, userId } },
          create: { orgId: inv.orgId, userId, role: inv.role },
          update: {},
        }),
      ]);
      await startSession(request, reply, userId, inv.orgId);
      request.user = { sessionId: '', id: userId, name: '', email: inv.email };
      await audit(request, {
        orgId: inv.orgId,
        action: 'membro.entrou',
        summary: `${inv.email} aceitou o convite (${ROLE_LABEL[inv.role as Role]}).`,
      });
      return me(userId, inv.orgId);
    },
  );
}
