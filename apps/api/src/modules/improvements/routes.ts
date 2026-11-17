import {
  CANCEL_REASONS,
  FEEDBACK_STATUSES,
  GESTOR_ROLE_KEY,
  PLANS,
  QUOTE_STATUS_LABEL,
  TRASH_DAYS,
  TRASH_KINDS,
  feedbackCreateSchema,
  isQuoteStatus,
  normalizeSearch,
  planPriceCents,
  subscriptionCancelSchema,
  supportAccessSchema,
  systemNoticeSchema,
  type AttachmentEntity,
  type BusinessNumbersDto,
  type FeedbackDto,
  type FeedbackKind,
  type FeedbackStatus,
  type Permission,
  type SearchResultDto,
  type SystemNoticeDto,
  type TrashItemDto,
} from '@cenario/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { COMPANY_BILLING_SELECT, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import { publicLink } from '../../core/public-links';
import { createSession, revokeSessions } from '../../core/sessions';
import { PLATFORM_COMPANY_ID, requireCompanyId, runAsCompany } from '../../core/tenant';
import { cookieOptions } from '../../plugins/auth';
import { Errors } from '../../lib/errors';
import { MANAGE_PERMISSIONS, allowed } from '../attachments/policy';
import { orderCode, pickupCode, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { loadOsAlbum } from '../service-orders/album';
import { AsaasClient } from '../billing/asaas';

/**
 * Melhorias da segunda rodada (2026-11-17) que não pertencem a um módulo só: busca rápida (83),
 * sugestão ou problema (112), aviso de manutenção (131), lixeira (86), álbum e links do cliente
 * (82, 130), acesso de suporte (114), números do negócio (116), cancelar ou pausar a assinatura
 * (113), resumo da semana (111) e registro de erros da tela (96).
 */
const DAY_MS = 86_400_000;
const ANY_WEB = { session: 'WEB' } as const;
const PLATFORM = { session: 'WEB', permissions: ['empresa.configurar'] } as const;

function has(request: FastifyRequest, ...perms: Permission[]) {
  return perms.some((p) => request.auth!.permissions.has(p));
}

export async function improvementRoutes(app: FastifyInstance) {
  const { prisma, system, env, hashToken, cookies } = app.ctx;

  function assertPlatformOwner(request: FastifyRequest) {
    if (request.auth?.companyId !== PLATFORM_COMPANY_ID || request.auth.kind !== 'WEB')
      throw Errors.notFound('Página');
  }

  // ───────────────────────── Busca rápida (83) ─────────────────────────
  app.get('/api/v1/search', { config: { access: ANY_WEB } }, async (request) => {
    const { q } = z.object({ q: z.string().max(80) }).parse(request.query);
    const text = normalizeSearch(q);
    if (text.length < 2) return { items: [] as SearchResultDto[] };
    const digits = q.replace(/\D/g, '');
    const number = digits && digits.length <= 9 ? Number(digits) : null;
    const items: SearchResultDto[] = [];
    const like = { contains: text, mode: 'insensitive' as const };
    const nameLike = { contains: q.trim(), mode: 'insensitive' as const };

    const jobs: Promise<void>[] = [];
    if (has(request, 'clientes.ver'))
      jobs.push(
        prisma.customer
          .findMany({
            where: { searchText: like },
            orderBy: [{ active: 'desc' }, { name: 'asc' }],
            take: 6,
            select: { id: true, name: true, phone: true, whatsapp: true, active: true },
          })
          .then((rows) => {
            for (const c of rows)
              items.push({
                kind: 'CLIENTE',
                id: c.id,
                title: c.name,
                subtitle:
                  [c.whatsapp || c.phone, c.active ? null : 'arquivado'].filter(Boolean).join(' · ') ||
                  null,
                href: `/painel/clientes/${c.id}`,
              });
          }),
      );
    if (has(request, 'os.ver'))
      jobs.push(
        prisma.serviceOrder
          .findMany({
            where: {
              OR: [
                ...(number ? [{ number }] : []),
                { customer: { name: nameLike } },
              ],
            },
            orderBy: { number: 'desc' },
            take: 6,
            select: { id: true, number: true, status: true, customer: { select: { name: true } } },
          })
          .then((rows) => {
            for (const o of rows)
              items.push({
                kind: 'OS',
                id: o.id,
                title: serviceOrderCode(o.number),
                subtitle: `${o.customer.name}${o.status === 'CANCELADA' ? ' · cancelada' : ''}`,
                href: `/painel/os/${o.id}`,
              });
          }),
      );
    if (has(request, 'pedidos.ver'))
      jobs.push(
        prisma.commercialOrder
          .findMany({
            where: {
              OR: [...(number ? [{ number }] : []), { customer: { name: nameLike } }],
            },
            orderBy: { number: 'desc' },
            take: 4,
            select: {
              id: true,
              number: true,
              contractedService: true,
              customer: { select: { name: true } },
            },
          })
          .then((rows) => {
            for (const o of rows)
              items.push({
                kind: 'PEDIDO',
                id: o.id,
                title: `${orderCode(o.number)} · ${o.customer.name}`,
                subtitle: o.contractedService,
                href: `/painel/pedidos/${o.id}`,
              });
          }),
      );
    if (has(request, 'orcamentos.ver', 'orcamentos.gerenciar'))
      jobs.push(
        prisma.quote
          .findMany({
            where: {
              deletedAt: null,
              OR: [...(number ? [{ number }] : []), { customerName: nameLike }],
            },
            orderBy: { number: 'desc' },
            take: 4,
            select: { id: true, number: true, customerName: true, service: true, status: true },
          })
          .then((rows) => {
            for (const r of rows)
              items.push({
                kind: 'ORCAMENTO',
                id: r.id,
                title: `Orçamento nº ${r.number} · ${r.customerName}`,
                subtitle: `${r.service} · ${QUOTE_STATUS_LABEL[isQuoteStatus(r.status) ? r.status : 'ENVIADO']}`,
                href: `/painel/orcamentos?aba=salvos&foco=${r.id}`,
              });
          }),
      );
    if (has(request, 'retiradas.ver') && number)
      jobs.push(
        prisma.pickupRequest
          .findMany({
            where: { number },
            take: 2,
            select: { id: true, number: true, order: { select: { customer: { select: { name: true } } } } },
          })
          .then((rows) => {
            for (const p of rows)
              items.push({
                kind: 'RETIRADA',
                id: p.id,
                title: pickupCode(p.number),
                subtitle: p.order.customer.name,
                href: `/painel/retiradas?foco=${p.id}`,
              });
          }),
      );
    await Promise.all(jobs);
    // Número digitado: o registro com aquele número vem primeiro.
    const exact = (r: SearchResultDto) => (digits && r.title.includes(digits.padStart(5, '0')) ? 0 : 1);
    items.sort((a, b) => exact(a) - exact(b));
    return { items: items.slice(0, 16) };
  });

  // ───────────────────────── Sugestão ou problema (112) ─────────────────────────
  app.post(
    '/api/v1/feedback',
    { config: { access: ANY_WEB }, bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const input = feedbackCreateSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const f = await tx.feedbackReport.create({
          data: {
            userId: actor.userId,
            kind: input.kind,
            message: input.message,
            pageUrl: input.pageUrl?.slice(0, 500) || null,
            userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
            screenshot: input.screenshot ?? null,
          },
        });
        await audit(tx, actor, {
          action: 'feedback.sent',
          entityType: 'feedback_report',
          entityId: f.id,
          summary: `${input.kind === 'PROBLEMA' ? 'Problema' : 'Sugestão'} enviado ao suporte do Cenário.`,
        });
      });
      return reply.status(201).send({ ok: true });
    },
  );

  app.get('/api/v1/platform/feedback', { config: { access: PLATFORM } }, async (request) => {
    assertPlatformOwner(request);
    const rows = await system.feedbackReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        companyId: true,
        kind: true,
        message: true,
        pageUrl: true,
        status: true,
        createdAt: true,
        screenshot: false,
        company: { select: { tradeName: true } },
        user: { select: { displayName: true, email: true } },
      },
    });
    const withShot = new Set(
      (
        await system.feedbackReport.findMany({
          where: { id: { in: rows.map((r) => r.id) }, screenshot: { not: null } },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    return {
      items: rows.map(
        (r): FeedbackDto => ({
          id: r.id,
          companyId: r.companyId,
          companyName: r.company.tradeName,
          userName: r.user?.displayName ?? null,
          userEmail: r.user?.email ?? null,
          kind: r.kind as FeedbackKind,
          message: r.message,
          pageUrl: r.pageUrl,
          hasScreenshot: withShot.has(r.id),
          status: r.status as FeedbackStatus,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    };
  });

  app.get(
    '/api/v1/platform/feedback/:id/print',
    { config: { access: PLATFORM } },
    async (request, reply) => {
      assertPlatformOwner(request);
      const { id } = idParams.parse(request.params);
      const r = await system.feedbackReport.findUnique({
        where: { id },
        select: { screenshot: true },
      });
      const m = r?.screenshot ? /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(r.screenshot) : null;
      if (!m) throw Errors.notFound('Print');
      const data = Buffer.from(m[2]!, 'base64');
      return reply
        .header('content-type', m[1]!)
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(data);
    },
  );

  app.post(
    '/api/v1/platform/feedback/:id/status',
    { config: { access: PLATFORM } },
    async (request) => {
      assertPlatformOwner(request);
      const { id } = idParams.parse(request.params);
      const { status } = z.object({ status: z.enum(FEEDBACK_STATUSES) }).parse(request.body);
      const r = await system.feedbackReport.update({ where: { id }, data: { status } });
      return { id: r.id, status: r.status };
    },
  );

  // ───────────────────────── Aviso de manutenção (131) ─────────────────────────
  const noticeDto = (n: {
    id: string;
    message: string;
    showFrom: Date;
    showUntil: Date;
  }): SystemNoticeDto => ({
    id: n.id,
    message: n.message,
    showFrom: n.showFrom.toISOString(),
    showUntil: n.showUntil.toISOString(),
  });

  app.get('/api/v1/platform/notices', { config: { access: PLATFORM } }, async (request) => {
    assertPlatformOwner(request);
    const rows = await system.systemNotice.findMany({
      where: { showUntil: { gt: new Date(Date.now() - 7 * DAY_MS) } },
      orderBy: { showFrom: 'desc' },
    });
    return { items: rows.map(noticeDto) };
  });

  app.post('/api/v1/platform/notices', { config: { access: PLATFORM } }, async (request, reply) => {
    assertPlatformOwner(request);
    const input = systemNoticeSchema.parse(request.body);
    const n = await system.systemNotice.create({
      data: {
        message: input.message,
        showFrom: new Date(input.showFrom),
        showUntil: new Date(input.showUntil),
      },
    });
    await audit(system, actorFrom(request), {
      action: 'platform.notice_created',
      entityType: 'system_notice',
      entityId: n.id,
      summary: `Aviso de manutenção criado: "${n.message}".`,
    });
    return reply.status(201).send(noticeDto(n));
  });

  app.post(
    '/api/v1/platform/notices/:id/end',
    { config: { access: PLATFORM } },
    async (request) => {
      assertPlatformOwner(request);
      const { id } = idParams.parse(request.params);
      const n = await system.systemNotice.update({
        where: { id },
        data: { showUntil: new Date() },
      });
      return noticeDto(n);
    },
  );

  // ───────────────────────── Lixeira (86) ─────────────────────────
  app.get('/api/v1/trash', { config: { access: ANY_WEB } }, async (request) => {
    const since = new Date(Date.now() - TRASH_DAYS * DAY_MS);
    const left = (d: Date) => Math.max(0, Math.ceil((d.getTime() + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
    const items: TrashItemDto[] = [];
    if (has(request, 'orcamentos.gerenciar')) {
      const rows = await prisma.quote.findMany({
        where: { deletedAt: { gte: since } },
        orderBy: { deletedAt: 'desc' },
        select: {
          id: true,
          number: true,
          customerName: true,
          service: true,
          deletedAt: true,
          deletedBy: { select: { displayName: true } },
        },
      });
      for (const r of rows)
        items.push({
          kind: 'ORCAMENTO',
          id: r.id,
          title: `Orçamento nº ${r.number} · ${r.customerName}`,
          detail: r.service,
          deletedAt: r.deletedAt!.toISOString(),
          deletedBy: r.deletedBy?.displayName ?? null,
          daysLeft: left(r.deletedAt!),
          thumbUrl: null,
        });
    }
    const photoTypes = (Object.keys(MANAGE_PERMISSIONS) as AttachmentEntity[]).filter((t) =>
      allowed(request.auth!.permissions, MANAGE_PERMISSIONS[t]),
    );
    if (photoTypes.length) {
      const rows = await prisma.attachment.findMany({
        where: { deletedAt: { gte: since }, entityType: { in: photoTypes } },
        orderBy: { deletedAt: 'desc' },
        take: 200,
        select: { id: true, fileId: true, caption: true, entityType: true, deletedAt: true },
      });
      for (const r of rows)
        items.push({
          kind: 'FOTO',
          id: r.id,
          title: r.caption || 'Foto sem legenda',
          detail: PHOTO_PLACE[r.entityType as AttachmentEntity] ?? null,
          deletedAt: r.deletedAt!.toISOString(),
          deletedBy: null,
          daysLeft: left(r.deletedAt!),
          thumbUrl: `/api/v1/trash/foto/${r.id}`,
        });
    }
    if (has(request, 'clientes.gerenciar')) {
      const rows = await prisma.customer.findMany({
        where: { active: false, updatedAt: { gte: since } },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, name: true, phone: true, whatsapp: true, updatedAt: true },
      });
      for (const r of rows)
        items.push({
          kind: 'CLIENTE',
          id: r.id,
          title: r.name,
          detail: r.whatsapp || r.phone || null,
          deletedAt: r.updatedAt.toISOString(),
          deletedBy: null,
          daysLeft: left(r.updatedAt),
          thumbUrl: null,
        });
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { items };
  });

  /** Miniatura de uma foto apagada (só para quem pode restaurá-la). */
  app.get('/api/v1/trash/foto/:id', { config: { access: ANY_WEB } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const a = await prisma.attachment.findUnique({ where: { id }, include: { file: true } });
    if (!a || !a.deletedAt) throw Errors.notFound('Foto');
    if (!allowed(request.auth!.permissions, MANAGE_PERMISSIONS[a.entityType as AttachmentEntity]))
      throw Errors.forbidden();
    const key = a.file.thumbKey ?? a.file.storageKey;
    const { stream } = await app.ctx.storage.read(key);
    return reply
      .header('content-type', a.file.thumbKey ? 'image/webp' : a.file.mimeType)
      .header('cache-control', 'private, max-age=600')
      .header('x-content-type-options', 'nosniff')
      .send(stream);
  });

  app.post(
    '/api/v1/trash/:kind/:id/restore',
    { config: { access: ANY_WEB } },
    async (request) => {
      const { kind, id } = z
        .object({ kind: z.enum(TRASH_KINDS), id: z.string().uuid() })
        .parse(request.params);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        if (kind === 'ORCAMENTO') {
          if (!has(request, 'orcamentos.gerenciar')) throw Errors.forbidden();
          const q = await tx.quote.findFirst({ where: { id, deletedAt: { not: null } } });
          if (!q) throw Errors.notFound('Orçamento');
          await tx.quote.update({
            where: { id },
            data: { deletedAt: null, deletedById: null, version: { increment: 1 } },
          });
          await audit(tx, actor, {
            action: 'quotes.restored',
            entityType: 'quote',
            entityId: id,
            summary: `Orçamento nº ${q.number} recuperado da lixeira.`,
          });
        } else if (kind === 'FOTO') {
          const a = await tx.attachment.findUnique({ where: { id } });
          if (!a || !a.deletedAt) throw Errors.notFound('Foto');
          if (!allowed(request.auth!.permissions, MANAGE_PERMISSIONS[a.entityType as AttachmentEntity]))
            throw Errors.forbidden();
          await tx.attachment.update({ where: { id }, data: { deletedAt: null } });
          await tx.storedFile.update({ where: { id: a.fileId }, data: { deletedAt: null } });
          await audit(tx, actor, {
            action: 'attachment.restored',
            entityType: a.entityType.toLowerCase(),
            entityId: a.entityId,
            summary: 'Foto recuperada da lixeira.',
          });
        } else {
          if (!has(request, 'clientes.gerenciar')) throw Errors.forbidden();
          const c = await tx.customer.findFirst({ where: { id, active: false } });
          if (!c) throw Errors.notFound('Cliente');
          await tx.customer.update({
            where: { id },
            data: { active: true, version: { increment: 1 } },
          });
          await audit(tx, actor, {
            action: 'customer.reactivated',
            entityType: 'customer',
            entityId: id,
            summary: `Cliente ${c.name} recuperado da lixeira.`,
          });
        }
      });
      return { ok: true };
    },
  );

  // ───────────────────────── Álbum (82) e links do cliente (79, 130) ─────────────────────────
  app.get(
    '/api/v1/service-orders/:id/album',
    { config: { access: { session: 'WEB', permissions: ['os.ver'] } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const album = await loadOsAlbum(prisma, id, (fileId, thumb) =>
        thumb ? `/api/files/${fileId}/miniatura` : `/api/files/${fileId}`,
      );
      if (!album) throw Errors.notFound('OS');
      return {
        ...album,
        shareUrl: publicLink(env, hashToken, 'album', id),
      };
    },
  );

  app.get(
    '/api/v1/pickups/:id/schedule-link',
    { config: { access: { session: 'WEB', permissions: ['retiradas.gerenciar'] } } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const p = await prisma.pickupRequest.findUnique({ where: { id }, select: { id: true } });
      if (!p) throw Errors.notFound('Retirada');
      return { url: publicLink(env, hashToken, 'agendar', id) };
    },
  );

  // ───────────────────────── Acesso de suporte (114) ─────────────────────────
  /** O dono da empresa libera (ou corta) o acesso do suporte do Cenário por algumas horas. */
  app.post(
    '/api/v1/company/support-access',
    { config: { access: { session: 'WEB', permissions: ['empresa.configurar'] } } },
    async (request) => {
      const { hours } = supportAccessSchema.parse(request.body);
      if (request.auth!.companyId === PLATFORM_COMPANY_ID)
        throw Errors.business('A empresa da plataforma não precisa liberar o suporte.');
      const companyId = requireCompanyId();
      const until = hours ? new Date(Date.now() + hours * 3_600_000) : null;
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await tx.companySettings.update({
          where: { id: companyId },
          data: { supportAccessUntil: until },
        });
        if (!until) {
          const agents = await tx.user.findMany({
            where: { supportAgent: true },
            select: { id: true },
          });
          for (const a of agents)
            await revokeSessions(tx, actor, { userId: a.id }, 'revoked_by_admin');
        }
        await audit(tx, actor, {
          action: until ? 'support.access_granted' : 'support.access_revoked',
          entityType: 'company',
          entityId: String(companyId),
          summary: until
            ? `Acesso do suporte do Cenário liberado por ${hours} horas (até ${until.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}).`
            : 'Acesso do suporte do Cenário encerrado.',
        });
      });
      return { supportAccessUntil: until?.toISOString() ?? null };
    },
  );

  /**
   * O dono da plataforma entra na empresa que liberou o suporte. A sessão é de um usuário próprio
   * do suporte dentro daquela empresa (tudo que ele fizer aparece na Auditoria dela como
   * "Suporte Cenário") e acaba sozinha quando a liberação vence.
   */
  app.post(
    '/api/v1/platform/companies/:id/support-session',
    { config: { access: PLATFORM } },
    async (request, reply) => {
      assertPlatformOwner(request);
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id === PLATFORM_COMPANY_ID)
        throw Errors.business('Escolha uma empresa cliente.');
      const company = await system.companySettings.findUnique({
        where: { id },
        select: { supportAccessUntil: true, tradeName: true, blockedAt: true },
      });
      if (!company) throw Errors.notFound('Empresa');
      if (!company.supportAccessUntil || company.supportAccessUntil <= new Date())
        throw Errors.business(
          'Esta empresa não liberou o acesso do suporte. Peça para o dono liberar em Empresa > Acesso do suporte.',
        );
      if (company.blockedAt) throw Errors.business('Esta empresa está bloqueada.');
      const platformActor = actorFrom(request);
      const { token, session } = await runAsCompany(id, () =>
        prisma.$transaction(async (tx) => {
          const gestor = await tx.role.findFirst({ where: { key: GESTOR_ROLE_KEY } });
          if (!gestor) throw Errors.business('A empresa não tem a função de gestor.');
          let agent = await tx.user.findFirst({ where: { supportAgent: true } });
          if (!agent)
            agent = await tx.user.create({
              data: { displayName: 'Suporte Cenário', supportAgent: true, active: true },
            });
          else if (!agent.active)
            agent = await tx.user.update({ where: { id: agent.id }, data: { active: true } });
          await tx.userRole.upsert({
            where: { userId_roleId: { userId: agent.id, roleId: gestor.id } },
            create: { userId: agent.id, roleId: gestor.id },
            update: {},
          });
          const created = await createSession(tx, env, hashToken, {
            kind: 'WEB',
            userId: agent.id,
            deviceId: null,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          });
          await audit(
            tx,
            { ...platformActor, userId: agent.id, sessionId: created.session.id },
            {
              action: 'support.session_started',
              entityType: 'session',
              entityId: created.session.id,
              summary: `Suporte do Cenário entrou na empresa (${request.auth!.displayName}).`,
            },
          );
          return created;
        }),
      );
      await audit(system, platformActor, {
        action: 'platform.support_session',
        entityType: 'company',
        entityId: String(id),
        summary: `Entrou como suporte em ${company.tradeName}.`,
      });
      // A sessão do suporte nunca passa do fim da liberação.
      const end = Math.min(session.expiresAt.getTime(), company.supportAccessUntil.getTime());
      const maxAge = Math.max(60, Math.floor((end - Date.now()) / 1000));
      void reply.setCookie(cookies.session, token, cookieOptions(env.COOKIE_SECURE, maxAge));
      return { ok: true };
    },
  );

  // ───────────────────────── Números do negócio (116) ─────────────────────────
  app.get(
    '/api/v1/platform/business-numbers',
    { config: { access: PLATFORM } },
    async (request) => {
      assertPlatformOwner(request);
      const now = clockNow();
      const companies = await system.companySettings.findMany({
        where: { id: { not: PLATFORM_COMPANY_ID }, isDemo: false },
        select: {
          ...COMPANY_BILLING_SELECT,
          tradeName: true,
          createdAt: true,
          canceledAt: true,
          cancelReason: true,
          pausedUntil: true,
        },
      });
      const lastLogin = await system.user.groupBy({
        by: ['companyId'],
        where: { supportAgent: false },
        _max: { lastLoginAt: true },
      });
      const lastSeen = await system.session.groupBy({
        by: ['companyId'],
        where: { kind: 'WEB', user: { supportAgent: false } },
        _max: { lastSeenAt: true },
      });
      const last = new Map<number, Date | null>();
      for (const l of lastLogin) last.set(l.companyId, l._max.lastLoginAt);
      for (const s of lastSeen) {
        const cur = last.get(s.companyId);
        if (s._max.lastSeenAt && (!cur || s._max.lastSeenAt > cur))
          last.set(s.companyId, s._max.lastSeenAt);
      }
      const dto: BusinessNumbersDto = {
        mrrCents: 0,
        paying: 0,
        trial: 0,
        courtesy: 0,
        overdue: 0,
        canceled: 0,
        paused: 0,
        atRisk: [],
        cancelReasons: [],
        newLast30Days: 0,
      };
      const reasons = new Map<string, number>();
      for (const c of companies) {
        const status = statusOf(c, env, now);
        if (c.createdAt.getTime() > now.getTime() - 30 * DAY_MS) dto.newLast30Days++;
        if (c.cancelReason && (c.canceledAt || c.pausedUntil)) {
          const r = c.cancelReason.split(' — ')[0]!;
          reasons.set(r, (reasons.get(r) ?? 0) + 1);
        }
        if (c.pausedUntil && c.pausedUntil > now) dto.paused++;
        if (c.canceledAt) dto.canceled++;
        if (status === 'CORTESIA') {
          dto.courtesy++;
          continue;
        }
        if (status === 'TESTE') dto.trial++;
        if (status === 'ATIVA' || status === 'ATRASADA') {
          if (!c.canceledAt) {
            dto.paying++;
            const cents = planPriceCents(planOf(c), cycleOf(c));
            dto.mrrCents += cycleOf(c) === 'ANUAL' ? Math.round(cents / 12) : cents;
          }
        }
        if (status === 'ATRASADA' || status === 'VENCIDA') dto.overdue++;
        const seen = last.get(c.id) ?? null;
        if (
          (status === 'TESTE' || status === 'ATIVA' || status === 'ATRASADA') &&
          (!seen || seen.getTime() < now.getTime() - 7 * DAY_MS)
        )
          dto.atRisk.push({
            companyId: c.id,
            tradeName: c.tradeName,
            lastActivityAt: seen?.toISOString() ?? null,
          });
      }
      dto.cancelReasons = [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
      return dto;
    },
  );

  // ───────────────────────── Cancelar ou pausar a assinatura (113) ─────────────────────────
  const asaas = env.ASAAS_API_KEY
    ? new AsaasClient({ apiKey: env.ASAAS_API_KEY, baseUrl: env.ASAAS_BASE_URL }, (...a) =>
        app.ctx.fetch(...a),
      )
    : null;
  const BILLING_MANAGE = {
    session: 'WEB',
    permissions: ['empresa.configurar'],
    billingExempt: true,
  } as const;

  app.post(
    '/api/v1/subscription/cancel',
    { config: { access: BILLING_MANAGE } },
    async (request) => {
      const input = subscriptionCancelSchema.parse(request.body);
      const companyId = requireCompanyId();
      const company = await prisma.companySettings.findUniqueOrThrow({
        where: { id: companyId },
        select: { ...COMPANY_BILLING_SELECT, asaasSubscriptionId: true, canceledAt: true },
      });
      if (company.billingCourtesy || companyId === PLATFORM_COMPANY_ID)
        throw Errors.business('Esta empresa tem cortesia: não há assinatura para cancelar.');
      // A cobrança recorrente para no Asaas (as próximas mensalidades não são geradas).
      if (company.asaasSubscriptionId && asaas)
        await asaas.cancelSubscription(company.asaasSubscriptionId).catch((err: unknown) => {
          request.log.warn({ err }, 'Falha ao cancelar a assinatura no Asaas');
          throw Errors.business(
            'Não foi possível cancelar a cobrança agora. Tente de novo em alguns minutos.',
          );
        });
      const end = new Date(
        Math.max(company.paidUntil?.getTime() ?? 0, company.trialEndsAt?.getTime() ?? 0, Date.now()),
      );
      const reason = [input.reason, input.details].filter(Boolean).join(' — ').slice(0, 500);
      await prisma.$transaction(async (tx) => {
        await tx.companySettings.update({
          where: { id: companyId },
          data: {
            asaasSubscriptionId: null,
            cancelReason: reason,
            ...(input.action === 'CANCELAR'
              ? { canceledAt: new Date(), pausedUntil: null }
              : { pausedUntil: new Date(end.getTime() + 30 * DAY_MS), canceledAt: null }),
          },
        });
        await tx.subscriptionInvoice.updateMany({
          where: { status: { in: ['PENDENTE', 'VENCIDA'] } },
          data: { status: 'CANCELADA' },
        });
        await audit(tx, actorFrom(request), {
          action: input.action === 'CANCELAR' ? 'billing.canceled' : 'billing.paused',
          entityType: 'company',
          entityId: String(companyId),
          summary:
            input.action === 'CANCELAR'
              ? `Assinatura cancelada pela empresa (motivo: ${reason}). O acesso continua até ${end.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`
              : `Assinatura pausada por um mês pela empresa (motivo: ${reason}).`,
        });
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/subscription/resume',
    { config: { access: BILLING_MANAGE } },
    async (request) => {
      const companyId = requireCompanyId();
      await prisma.$transaction(async (tx) => {
        await tx.companySettings.update({
          where: { id: companyId },
          data: { canceledAt: null, pausedUntil: null },
        });
        await audit(tx, actorFrom(request), {
          action: 'billing.resumed',
          entityType: 'company',
          entityId: String(companyId),
          summary: 'Assinatura reativada pela empresa (falta escolher o plano e pagar).',
        });
      });
      return { ok: true };
    },
  );

  // ───────────────────────── Resumo da semana no celular (111) ─────────────────────────
  app.get(
    '/api/v1/management/week',
    {
      config: {
        access: {
          session: 'WEB',
          anyPermissions: ['os.ver', 'entregas.ver', 'financeiro.ver', 'pedidos.ver'],
        },
      },
    },
    async (request) => {
      const today = todayIso();
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
      const monday = addDays(today, -((weekday + 6) % 7));
      const nextMonday = addDays(monday, 7);
      const from = new Date(`${monday}T03:00:00.000Z`);
      const to = new Date(`${nextMonday}T03:00:00.000Z`);
      const out: {
        weekStart: string;
        weekEnd: string;
        newServices: { count: number; valueCents: number | null } | null;
        delivered: { pieces: number; scheduledRest: number } | null;
        receivedCents: number | null;
        quotes: { sent: number; approved: number; approvedCents: number; followUpDue: number } | null;
      } = {
        weekStart: monday,
        weekEnd: addDays(monday, 6),
        newServices: null,
        delivered: null,
        receivedCents: null,
        quotes: null,
      };
      if (has(request, 'pedidos.ver')) {
        const orders = await prisma.commercialOrder.findMany({
          where: { createdAt: { gte: from, lt: to }, status: { not: 'CANCELADO' } },
          select: { agreedValueCents: true },
        });
        out.newServices = {
          count: orders.length,
          valueCents: has(request, 'pedidos.valores')
            ? orders.reduce((s, o) => s + (o.agreedValueCents ?? 0), 0)
            : null,
        };
      }
      if (has(request, 'entregas.ver', 'entregas.gerenciar')) {
        const [pieces, rest] = await Promise.all([
          prisma.deliveryItem.count({
            where: { status: 'ENTREGUE', deliveredAt: { gte: from, lt: to } },
          }),
          prisma.delivery.count({
            where: {
              status: 'AGENDADA',
              scheduledDate: {
                gte: new Date(`${today}T00:00:00Z`),
                lt: new Date(`${nextMonday}T00:00:00Z`),
              },
            },
          }),
        ]);
        out.delivered = { pieces, scheduledRest: rest };
      }
      if (has(request, 'financeiro.ver')) {
        const r = await prisma.customerPayment.aggregate({
          where: {
            receivedAt: {
              gte: new Date(`${monday}T00:00:00Z`),
              lt: new Date(`${nextMonday}T00:00:00Z`),
            },
          },
          _sum: { amountCents: true },
        });
        out.receivedCents = r._sum.amountCents ?? 0;
      }
      if (has(request, 'orcamentos.ver', 'orcamentos.gerenciar')) {
        const [sent, approved, due] = await Promise.all([
          prisma.quote.count({ where: { deletedAt: null, createdAt: { gte: from, lt: to } } }),
          prisma.quote.findMany({
            where: { deletedAt: null, status: 'APROVADO', statusChangedAt: { gte: from, lt: to } },
            select: { totalCents: true },
          }),
          prisma.quote.count({
            where: { deletedAt: null, status: 'ENVIADO', followUpAt: { lte: new Date() } },
          }),
        ]);
        out.quotes = {
          sent,
          approved: approved.length,
          approvedCents: approved.reduce((s, q) => s + q.totalCents, 0),
          followUpDue: due,
        };
      }
      return out;
    },
  );

  // ───────────────────────── Erros na tela das pessoas (96) ─────────────────────────
  app.post(
    '/api/public/client-error',
    { config: { access: { public: true } }, bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const e = z
        .object({
          message: z.string().max(500),
          stack: z.string().max(4000).optional(),
          url: z.string().max(500).optional(),
          source: z.string().max(40).optional(),
        })
        .safeParse(request.body);
      if (e.success)
        request.log.error(
          {
            event: 'client.error',
            source: e.data.source ?? 'painel',
            url: e.data.url?.replace(/[?#].*$/, ''),
            clientMessage: e.data.message,
            clientStack: e.data.stack,
            userAgent: request.headers['user-agent']?.slice(0, 200),
          },
          'Erro na tela de uma pessoa',
        );
      return reply.status(204).send();
    },
  );

  // Planos e motivos ficam disponíveis para as telas (evita duplicar a lista no painel).
  app.get('/api/v1/subscription/cancel-options', { config: { access: BILLING_MANAGE } }, async () => ({
    reasons: CANCEL_REASONS,
    plans: Object.values(PLANS).map((p) => p.label),
  }));
}

const PHOTO_PLACE: Partial<Record<AttachmentEntity, string>> = {
  COMMERCIAL_ORDER: 'Pedido',
  PICKUP: 'Retirada',
  SERVICE_ORDER: 'Ordem de serviço',
  SERVICE_ORDER_ITEM: 'Peça da OS',
  PRODUCTION_TASK: 'Tarefa da produção',
  PRODUCTION_ISSUE: 'Ocorrência',
  QUALITY_INSPECTION: 'Qualidade',
  DELIVERY: 'Entrega',
  LOGISTICS_OCCURRENCE: 'Ocorrência da entrega',
  FINANCE_PAYABLE: 'Comprovante',
};

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
