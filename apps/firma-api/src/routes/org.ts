import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES, ROLE_LABEL, atLeast, type Role } from '../context';
import { audit } from '../lib/audit';
import { randomToken } from '../lib/crypto';
import { E } from '../lib/errors';
import { sendMail } from '../lib/mail';

export async function orgRoutes(app: FastifyInstance) {
  const { db, env, hash } = app.firma;

  app.get('/api/org/membros', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const orgId = request.org!.id;
    const [members, invites] = await Promise.all([
      db.membership.findMany({
        where: { orgId },
        include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      atLeast(request.org!.role, 'ADMIN')
        ? db.invite.findMany({
            where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);
    return {
      members: members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        roleLabel: ROLE_LABEL[m.role as Role],
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        roleLabel: ROLE_LABEL[i.role as Role],
        expiresAt: i.expiresAt.toISOString(),
      })),
      roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })),
    };
  });

  app.post('/api/org/convites', { config: { rule: { org: 'ADMIN' } } }, async (request) => {
    const input = z
      .object({
        email: z.string().trim().toLowerCase().email('Informe um e-mail válido.'),
        role: z.enum(['ADMIN', 'GESTOR', 'MEMBRO']),
      })
      .parse(request.body);
    const orgId = request.org!.id;
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (
      existing &&
      (await db.membership.findUnique({ where: { orgId_userId: { orgId, userId: existing.id } } }))
    )
      throw E.conflict('Esta pessoa já faz parte da organização.');
    const token = randomToken();
    const inv = await db.invite.create({
      data: {
        orgId,
        email: input.email,
        role: input.role,
        tokenHash: hash(token),
        invitedById: request.user!.id,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    const link = `${env.FIRMA_WEB_URL}/convite/${token}`;
    await sendMail(db, env, request.log, {
      to: input.email,
      subject: `Convite para ${request.org!.name} no Firma Viva`,
      body: `${request.user!.name} convidou você para a organização ${request.org!.name} no Firma Viva como ${ROLE_LABEL[input.role]}. O convite vale por 7 dias.`,
      link,
    });
    await audit(request, {
      action: 'convite.criado',
      summary: `Convite para ${input.email} (${ROLE_LABEL[input.role]}).`,
    });
    return {
      id: inv.id,
      email: inv.email,
      expiresAt: inv.expiresAt.toISOString(),
      // Prévia privada / desenvolvimento: o link volta na resposta para facilitar o teste.
      ...(env.FIRMA_APP_ENV === 'production' ? {} : { devLink: link }),
    };
  });

  app.post(
    '/api/org/convites/:id/cancelar',
    { config: { rule: { org: 'ADMIN' } } },
    async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      // Sempre filtrado pela organização da sessão (um ADMIN de outra organização não alcança).
      const r = await db.invite.updateMany({
        where: { id, orgId: request.org!.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!r.count) throw E.notFound('Convite');
      return { ok: true };
    },
  );

  app.put('/api/org/membros/:userId', { config: { rule: { org: 'ADMIN' } } }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.body);
    const orgId = request.org!.id;
    const m = await db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    if (!m) throw E.notFound('Membro');
    if ((m.role === 'DONO' || role === 'DONO') && request.org!.role !== 'DONO')
      throw E.forbidden('Só o dono transfere ou altera o papel de dono.');
    if (
      m.role === 'DONO' &&
      role !== 'DONO' &&
      (await db.membership.count({ where: { orgId, role: 'DONO' } })) < 2
    )
      throw E.conflict('A organização precisa de ao menos um dono.');
    await db.membership.update({ where: { orgId_userId: { orgId, userId } }, data: { role } });
    await audit(request, {
      action: 'membro.papel',
      summary: `Papel alterado para ${ROLE_LABEL[role]}.`,
      details: { userId },
    });
    return { ok: true };
  });

  app.delete(
    '/api/org/membros/:userId',
    { config: { rule: { org: 'ADMIN' } } },
    async (request) => {
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      const orgId = request.org!.id;
      const m = await db.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
      if (!m) throw E.notFound('Membro');
      if (m.role === 'DONO') throw E.conflict('Transfira o papel de dono antes de remover.');
      await db.membership.delete({ where: { orgId_userId: { orgId, userId } } });
      await db.session.updateMany({ where: { userId, orgId }, data: { orgId: null } });
      await audit(request, {
        action: 'membro.removido',
        summary: 'Membro removido da organização.',
        details: { userId },
      });
      return { ok: true };
    },
  );

  app.put('/api/org', { config: { rule: { org: 'ADMIN' } } }, async (request) => {
    const { name } = z.object({ name: z.string().trim().min(2).max(120) }).parse(request.body);
    await db.organization.update({ where: { id: request.org!.id }, data: { name } });
    await audit(request, {
      action: 'org.renomeada',
      summary: `Organização renomeada para ${name}.`,
    });
    return { ok: true };
  });

  app.get('/api/org/auditoria', { config: { rule: { org: 'ADMIN' } } }, async (request) => {
    const rows = await db.auditLog.findMany({
      where: { orgId: request.org!.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const users = await db.user.findMany({
      where: { id: { in: rows.map((r) => r.userId).filter((x): x is string => Boolean(x)) } },
      select: { id: true, name: true },
    });
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      who: users.find((u) => u.id === r.userId)?.name ?? null,
      action: r.action,
      summary: r.summary,
      company: r.company,
    }));
  });

  /** Caixa de saída (fora de produção): convites e recuperação de senha enviados. */
  app.get('/api/dev/caixa-de-saida', { config: { rule: { public: true } } }, async (request) => {
    // Só em desenvolvimento/teste: na prévia e em produção os links não ficam expostos.
    if (env.FIRMA_APP_ENV !== 'development' && env.FIRMA_APP_ENV !== 'test')
      throw E.notFound('Página');
    const { para } = z.object({ para: z.string().email() }).parse(request.query);
    const rows = await db.outboxMail.findMany({
      where: { to: para.toLowerCase() },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return rows.map((r) => ({ subject: r.subject, link: r.link, at: r.createdAt.toISOString() }));
  });
}
