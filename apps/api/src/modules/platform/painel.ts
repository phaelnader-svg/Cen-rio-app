import {
  CLOSE_KEEP_DAYS,
  SCREEN_LABELS,
  SIGNUP_SOURCE_LABEL,
  companyCloseSchema,
  demoRequestSchema,
  groupFeedback,
  paymentProofCreateSchema,
  paymentProofRejectSchema,
  platformPushSchema,
  screenViewSchema,
  signupSourceFrom,
  timelineNoteSchema,
  whatsappDigits,
  type FeedbackGroupDto,
  type PaymentProofStatus,
  type PlatformDemoDto,
  type PlatformPaymentProofDto,
  type ScreenUsageDto,
  type SignupSource,
  type TimelineItemDto,
} from '@cenario/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { cycleOf, planOf } from '../../core/billing';
import { captchaFailed } from '../../core/captcha';
import { now as clockNow } from '../../core/clock';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { companyPriceCents } from '../../core/platform-config';
import { PLATFORM_RECORD_ID, requireCompanyId, runAsCompany } from '../../core/tenant';
import { AuthThrottle, clientIpKey } from '../../core/throttle';
import { Errors } from '../../lib/errors';
import { notifyPlatformAdmins } from '../onboarding/routes';
import { pushKeys, pushPlatformAdmins } from '../push/push';
import { platformLog } from './admin-auth';
import { recordPaymentTx } from './routes';

const PLATFORM = { platform: true } as const;
const DAY = 86_400_000;
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtWhen = (d: Date) =>
  d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const daySP = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

/** O início do arquivo confere com o tipo declarado (foto JPG/PNG ou PDF). */
function fileLooksLike(mime: string, data: Buffer): boolean {
  if (mime === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8;
  if (mime === 'image/png') return data.subarray(0, 4).toString('hex') === '89504e47';
  if (mime === 'application/pdf') return data.subarray(0, 4).toString('latin1') === '%PDF';
  return false;
}

/**
 * Painel da plataforma, etapa 2 (2026-11-27): comprovante pela tela (41), avisos no celular (43),
 * demonstrações do site (44), linha do tempo (46), telas usadas (49), sugestões agrupadas (50) e
 * encerrar empresa (51).
 */
export async function painelRoutes(app: FastifyInstance) {
  const { prisma, system, env } = app.ctx;
  const throttle = new AuthThrottle(system);
  const webUrl = () => env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0]!;
  const notify = (m: {
    subject: string;
    title: string;
    paragraphs: string[];
    path: string;
    kind: string;
    push: string;
  }) =>
    notifyPlatformAdmins(system, {
      subject: m.subject,
      title: m.title,
      paragraphs: m.paragraphs,
      url: `${webUrl()}${m.path}`,
      kind: m.kind,
      push: m.push,
    }).then(() => app.ctx.mailer.kick());

  function companyId(request: FastifyRequest): number {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) throw Errors.notFound('Empresa');
    return id;
  }

  // ───────────────────────── Comprovante pela tela (41) ─────────────────────────
  app.post(
    '/api/v1/subscription/proofs',
    {
      config: {
        access: { session: 'WEB', permissions: ['empresa.configurar'], billingExempt: true },
      },
      bodyLimit: 3 * 1024 * 1024,
    },
    async (request, reply) => {
      const input = paymentProofCreateSchema.parse(request.body);
      const data = Buffer.from(input.data, 'base64');
      if (!fileLooksLike(input.mime, data))
        throw Errors.validation(
          { data: 'Arquivo inválido.' },
          'Não deu para abrir o arquivo. Mande uma foto ou o PDF do comprovante.',
        );
      const id = requireCompanyId();
      const open = await prisma.paymentProof.count({ where: { status: 'PENDENTE' } });
      if (open >= 3)
        throw Errors.business(
          'Já tem comprovantes esperando conferência. Assim que forem conferidos, você pode mandar outro.',
        );
      const auth = request.auth!;
      const company = await prisma.companySettings.findUniqueOrThrow({
        where: { id },
        select: { tradeName: true },
      });
      const proof = await prisma.$transaction(async (tx) => {
        const p = await tx.paymentProof.create({
          data: {
            amountCents: input.amountCents,
            paidOn: new Date(`${input.paidOn}T12:00:00.000Z`),
            mime: input.mime,
            data: input.data,
            note: input.note || null,
            createdById: auth.userId,
          },
        });
        await audit(tx, actorFrom(request), {
          action: 'billing.proof_sent',
          entityType: 'payment_proof',
          entityId: p.id,
          summary: `${auth.displayName} mandou o comprovante do PIX de ${fmtBRL(input.amountCents)} (${fmtDay(p.paidOn)}).`,
        });
        return p;
      });
      await notify({
        subject: `Comprovante de ${company.tradeName}: ${fmtBRL(input.amountCents)}`,
        title: `Comprovante de ${company.tradeName}`,
        paragraphs: [
          `${auth.displayName} mandou o comprovante do PIX de ${fmtBRL(input.amountCents)}, pago em ${fmtDay(proof.paidOn)}.`,
          'Confira na Cobrança do painel e aperte Confirmar.',
        ],
        path: '/plataforma/cobranca',
        kind: 'plataforma-comprovante',
        push: `${fmtBRL(input.amountCents)} pago em ${fmtDay(proof.paidOn)}. Toque para conferir.`,
      }).catch((err: unknown) => app.log.warn({ err }, 'Falha ao avisar o comprovante'));
      return reply.status(201).send({ id: proof.id });
    },
  );

  const proofSelect = {
    id: true,
    companyId: true,
    amountCents: true,
    paidOn: true,
    status: true,
    rejectReason: true,
    createdAt: true,
    mime: true,
    note: true,
    company: {
      select: {
        tradeName: true,
        plan: true,
        billingCycle: true,
        billingPriceCents: true,
        billingPriceUntil: true,
      },
    },
    createdBy: { select: { displayName: true } },
  } as const;

  app.get('/api/v1/platform/proofs', { config: { access: PLATFORM } }, async (request) => {
    const { status } = z
      .object({ status: z.enum(['PENDENTE', 'TODOS']).default('PENDENTE') })
      .parse(request.query);
    const rows = await system.paymentProof.findMany({
      where: status === 'PENDENTE' ? { status: 'PENDENTE' } : {},
      orderBy: { createdAt: status === 'PENDENTE' ? 'asc' : 'desc' },
      take: 100,
      select: proofSelect,
    });
    return {
      items: rows.map(
        (r): PlatformPaymentProofDto => ({
          id: r.id,
          companyId: r.companyId,
          tradeName: r.company.tradeName,
          amountCents: r.amountCents,
          paidOn: r.paidOn.toISOString().slice(0, 10),
          status: r.status as PaymentProofStatus,
          rejectReason: r.rejectReason,
          createdAt: r.createdAt.toISOString(),
          mime: r.mime,
          note: r.note,
          sentBy: r.createdBy?.displayName ?? null,
          expectedCents: companyPriceCents({
            plan: planOf(r.company),
            cycle: cycleOf(r.company),
            billingPriceCents: r.company.billingPriceCents,
            billingPriceUntil: r.company.billingPriceUntil,
          }),
        }),
      ),
    };
  });

  app.get(
    '/api/v1/platform/proofs/:proofId/file',
    { config: { access: PLATFORM } },
    async (request, reply) => {
      const { proofId } = z.object({ proofId: z.guid() }).parse(request.params);
      const p = await system.paymentProof.findUnique({
        where: { id: proofId },
        select: { mime: true, data: true },
      });
      if (!p) throw Errors.notFound('Comprovante');
      return reply
        .header('content-type', p.mime)
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('content-disposition', 'inline')
        .send(Buffer.from(p.data, 'base64'));
    },
  );

  /** Confirmar: vira o pagamento (o mesmo do "Recebi o pagamento") e o cliente é avisado. */
  app.post(
    '/api/v1/platform/proofs/:proofId/confirm',
    { config: { access: PLATFORM } },
    async (request) => {
      const { proofId } = z.object({ proofId: z.guid() }).parse(request.params);
      const { cycles, amountCents } = z
        .object({
          cycles: z.number().int().min(1).max(12).default(1),
          amountCents: z.number().int().min(100).max(10_000_000).optional(),
        })
        .parse(request.body ?? {});
      const r = await system.$transaction(async (tx) => {
        const p = await tx.paymentProof.findUnique({ where: { id: proofId } });
        if (!p) throw Errors.notFound('Comprovante');
        const taken = await tx.paymentProof.updateMany({
          where: { id: proofId, status: 'PENDENTE' },
          data: { status: 'CONFIRMADO', reviewedAt: new Date() },
        });
        if (taken.count !== 1) throw Errors.business('Este comprovante já foi conferido.');
        const paid = await recordPaymentTx(tx, request, p.companyId, {
          amountCents: amountCents ?? p.amountCents,
          receivedOn: p.paidOn.toISOString().slice(0, 10),
          cycles,
          unblock: true,
          note: 'comprovante pela tela',
        });
        await tx.paymentProof.update({
          where: { id: proofId },
          data: { invoiceId: paid.invoiceId },
        });
        return paid;
      });
      app.ctx.mailer.kick();
      return { ok: true, paidUntil: r.paidUntil };
    },
  );

  app.post(
    '/api/v1/platform/proofs/:proofId/reject',
    { config: { access: PLATFORM } },
    async (request) => {
      const { proofId } = z.object({ proofId: z.guid() }).parse(request.params);
      const { reason } = paymentProofRejectSchema.parse(request.body);
      await system.$transaction(async (tx) => {
        const p = await tx.paymentProof.findUnique({
          where: { id: proofId },
          include: {
            company: { select: { tradeName: true, email: true } },
            createdBy: { select: { email: true } },
          },
        });
        if (!p) throw Errors.notFound('Comprovante');
        const taken = await tx.paymentProof.updateMany({
          where: { id: proofId, status: 'PENDENTE' },
          data: { status: 'RECUSADO', reviewedAt: new Date(), rejectReason: reason },
        });
        if (taken.count !== 1) throw Errors.business('Este comprovante já foi conferido.');
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(p.companyId)}, true)`;
        const body = simpleEmail({
          title: 'O comprovante não conferiu',
          paragraphs: [
            `O comprovante de ${fmtBRL(p.amountCents)} da ${p.company.tradeName} não pôde ser confirmado.`,
            `Motivo: ${reason}`,
            'Na tela Assinatura você pode mandar outro, ou falar com a gente pelo WhatsApp.',
          ],
          button: { label: 'Abrir a assinatura', url: `${webUrl()}/painel/assinatura` },
        });
        for (const to of new Set(
          [p.company.email, p.createdBy?.email].filter((e): e is string => !!e),
        ))
          await enqueueEmail(tx, {
            to,
            subject: 'O comprovante do PIX não conferiu',
            kind: 'assinatura-comprovante-recusado',
            ...body,
          });
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_RECORD_ID)}, true)`;
        await platformLog(tx, request, {
          action: 'platform.proof_rejected',
          companyId: p.companyId,
          summary: `Comprovante de ${fmtBRL(p.amountCents)} de ${p.company.tradeName} recusado: ${reason}`,
        });
      });
      app.ctx.mailer.kick();
      return { ok: true };
    },
  );

  // ───────────────────────── Avisos no celular (43) ─────────────────────────
  app.get('/api/v1/platform/push', { config: { access: PLATFORM } }, async () => ({
    publicKey: (await pushKeys(system)).publicKey,
  }));

  app.put('/api/v1/platform/push', { config: { access: PLATFORM } }, async (request) => {
    const input = platformPushSchema.parse(request.body);
    const adminId = request.platformAdmin!.id;
    await system.platformPushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        adminId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
      },
      update: {
        adminId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
      },
    });
    await platformLog(system, request, {
      action: 'platform.push_on',
      summary: 'Avisos no celular ligados neste aparelho.',
    });
    return { ok: true, devices: await system.platformPushSubscription.count() };
  });

  app.post('/api/v1/platform/push/test', { config: { access: PLATFORM } }, async () => {
    const sent = await pushPlatformAdmins(
      system,
      env.PUBLIC_WEB_URL,
      {
        title: 'Cenário Gestão',
        body: 'Avisos ligados. É assim que chegam as empresas novas, pagamentos e demonstrações.',
        url: '/plataforma',
        tag: 'teste',
      },
      app.log,
    );
    return { sent };
  });

  // ───────────────────────── Demonstração pelo site (44) ─────────────────────────
  app.post(
    '/api/public/demonstracao',
    { config: { access: { public: true } } },
    async (request, reply) => {
      const input = demoRequestSchema.parse(request.body);
      const ipKey = clientIpKey(request, 'demo-ip');
      await throttle.assertAllowed([ipKey, 'demo:global']);
      if (input.website) throw captchaFailed();
      if (app.ctx.captcha && input.captcha && !(await app.ctx.captcha(input.captcha, request.ip)))
        throw captchaFailed();
      const when = new Date(input.preferredAt);
      const now = clockNow();
      if (when.getTime() < now.getTime() || when.getTime() > now.getTime() + 30 * DAY)
        throw Errors.validation({ preferredAt: 'Escolha um horário.' }, 'Escolha um horário.');
      await throttle.registerFailure(ipKey, {
        maxFailures: 5,
        windowSeconds: 3600,
        baseLockSeconds: 3600,
        maxLockSeconds: 3600,
      });
      await throttle.registerFailure('demo:global', {
        maxFailures: 60,
        windowSeconds: 3600,
        baseLockSeconds: 600,
        maxLockSeconds: 3600,
      });
      const origem = signupSourceFrom(input.origem);
      await runAsCompany(PLATFORM_RECORD_ID, () =>
        system.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_RECORD_ID)}, true)`;
          await tx.contactRequest.create({
            data: {
              companyId: PLATFORM_RECORD_ID,
              kind: 'DEMONSTRACAO',
              name: input.name,
              phone: input.phone,
              businessName: input.businessName || null,
              city: input.city || null,
              preferredAt: when,
              note: input.origem
                ? `Veio por: ${SIGNUP_SOURCE_LABEL[origem.source]}${origem.detail ? ` (${origem.detail})` : ''}`
                : null,
            },
          });
        }),
      );
      await notify({
        subject: `Demonstração marcada: ${input.businessName || input.name}`,
        title: 'Demonstração marcada pelo site',
        paragraphs: [
          `${input.name}${input.businessName ? `, da ${input.businessName}` : ''}${input.city ? ` (${input.city})` : ''}, quer ver o sistema.`,
          `Quando: ${fmtWhen(when)}.`,
          `Telefone: ${input.phone}.`,
        ],
        path: '/plataforma/avisos',
        kind: 'plataforma-demonstracao',
        push: `${input.businessName || input.name}: ${fmtWhen(when)}.`,
      }).catch((err: unknown) => app.log.warn({ err }, 'Falha ao avisar a demonstração'));
      return reply.status(201).send({ ok: true });
    },
  );

  app.get('/api/v1/platform/demos', { config: { access: PLATFORM } }, async () => {
    const rows = await system.contactRequest.findMany({
      where: {
        companyId: PLATFORM_RECORD_ID,
        kind: 'DEMONSTRACAO',
        OR: [{ status: 'PENDENTE' }, { createdAt: { gte: new Date(Date.now() - 30 * DAY) } }],
      },
      orderBy: [{ status: 'desc' }, { preferredAt: 'asc' }],
      take: 100,
    });
    return {
      items: rows.map((r): PlatformDemoDto => {
        const d = whatsappDigits(r.phone);
        const text = `Olá, ${r.name.split(' ')[0]}! Aqui é do Cenário Gestão. Confirmando a demonstração ${fmtWhen(r.preferredAt)}. Pode ser por aqui mesmo, por vídeo?`;
        return {
          id: r.id,
          name: r.name,
          businessName: r.businessName,
          city: r.city,
          phone: r.phone,
          preferredAt: r.preferredAt.toISOString(),
          note: r.note,
          status: r.status as PlatformDemoDto['status'],
          createdAt: r.createdAt.toISOString(),
          whatsappUrl:
            d.length >= 10
              ? `https://wa.me/${d.length <= 11 ? `55${d}` : d}?text=${encodeURIComponent(text)}`
              : null,
        };
      }),
    };
  });

  app.post(
    '/api/v1/platform/demos/:demoId/:action',
    { config: { access: PLATFORM } },
    async (request) => {
      const { demoId, action } = z
        .object({ demoId: z.guid(), action: z.enum(['feita', 'cancelar']) })
        .parse(request.params);
      const r = await system.contactRequest.updateMany({
        where: { id: demoId, companyId: PLATFORM_RECORD_ID, kind: 'DEMONSTRACAO' },
        data:
          action === 'feita'
            ? { status: 'FEITO', doneAt: new Date() }
            : { status: 'CANCELADO', doneAt: new Date() },
      });
      if (r.count !== 1) throw Errors.notFound('Demonstração');
      await platformLog(system, request, {
        action: action === 'feita' ? 'platform.demo_done' : 'platform.demo_canceled',
        summary: action === 'feita' ? 'Demonstração feita.' : 'Demonstração desmarcada.',
      });
      return { ok: true };
    },
  );

  // ───────────────────────── Linha do tempo (46) ─────────────────────────
  app.get(
    '/api/v1/platform/companies/:id/timeline',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const c = await system.companySettings.findUnique({
        where: { id },
        select: {
          tradeName: true,
          createdAt: true,
          isPlatform: true,
          signupSource: true,
          signupSourceDetail: true,
        },
      });
      if (!c || c.isPlatform) throw Errors.notFound('Empresa');
      // O banco do sistema atravessa empresas: toda consulta abaixo filtra pela empresa.
      const [logs, invoices, emails, proofs, helps, feedback] = await Promise.all([
        system.platformAuditLog.findMany({
          where: { targetCompanyId: id },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { action: true, summary: true, createdAt: true },
        }),
        system.subscriptionInvoice.findMany({
          where: { companyId: id, status: 'PAGA', provider: { not: 'MANUAL' } },
          select: { amountCents: true, paidAt: true, createdAt: true },
        }),
        system.outboundEmail.findMany({
          where: { companyId: id, kind: { not: { in: ['confirmar-email', 'redefinir-senha'] } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { subject: true, sentAt: true, createdAt: true },
        }),
        system.paymentProof.findMany({
          where: { companyId: id },
          select: { amountCents: true, createdAt: true },
        }),
        system.contactRequest.findMany({
          where: { companyId: id },
          select: { kind: true, preferredAt: true, createdAt: true },
        }),
        system.feedbackReport.findMany({
          where: { companyId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { kind: true, message: true, createdAt: true },
        }),
      ]);
      const items: TimelineItemDto[] = [
        {
          at: c.createdAt.toISOString(),
          kind: 'cadastro',
          text: `Criou a conta${c.signupSource ? ` (veio de: ${SIGNUP_SOURCE_LABEL[c.signupSource as SignupSource] ?? c.signupSource}${c.signupSourceDetail ? `, ${c.signupSourceDetail}` : ''})` : ''}.`,
        },
        ...logs
          .filter((l) => l.action !== 'platform.company_created')
          .map(
            (l): TimelineItemDto => ({
              at: l.createdAt.toISOString(),
              kind:
                l.action === 'platform.note'
                  ? 'conversa'
                  : l.action === 'platform.payment' || l.action === 'platform.payment_undone'
                    ? 'pagamento'
                    : l.action === 'platform.help_done'
                      ? 'ajuda'
                      : 'mudanca',
              text: l.summary,
            }),
          ),
        ...invoices.map(
          (i): TimelineItemDto => ({
            at: (i.paidAt ?? i.createdAt).toISOString(),
            kind: 'pagamento',
            text: `Pagou ${fmtBRL(i.amountCents)} online.`,
          }),
        ),
        ...emails.map(
          (e): TimelineItemDto => ({
            at: (e.sentAt ?? e.createdAt).toISOString(),
            kind: 'aviso',
            text: `E-mail${e.sentAt ? '' : ' na fila'}: ${e.subject}`,
          }),
        ),
        ...proofs.map(
          (p): TimelineItemDto => ({
            at: p.createdAt.toISOString(),
            kind: 'comprovante',
            text: `Mandou o comprovante de ${fmtBRL(p.amountCents)}.`,
          }),
        ),
        ...helps.map(
          (h): TimelineItemDto => ({
            at: h.createdAt.toISOString(),
            kind: 'ajuda',
            text: `Pediu ajuda para começar (para ${fmtWhen(h.preferredAt)}).`,
          }),
        ),
        ...feedback.map(
          (f): TimelineItemDto => ({
            at: f.createdAt.toISOString(),
            kind: 'sugestao',
            text: `${f.kind === 'PROBLEMA' ? 'Avisou um problema' : 'Mandou uma sugestão'}: ${f.message.slice(0, 140)}`,
          }),
        ),
      ];
      items.sort((a, b) => b.at.localeCompare(a.at));
      return { tradeName: c.tradeName, items };
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/timeline',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const { text } = timelineNoteSchema.parse(request.body);
      const c = await system.companySettings.findUnique({ where: { id }, select: { id: true } });
      if (!c) throw Errors.notFound('Empresa');
      await platformLog(system, request, { action: 'platform.note', companyId: id, summary: text });
      return { ok: true };
    },
  );

  // ───────────────────────── Telas usadas (49) ─────────────────────────
  app.post(
    '/api/v1/usage/screen',
    { config: { access: { session: 'WEB', billingExempt: true } } },
    async (request, reply) => {
      const { screen } = screenViewSchema.parse(request.body);
      const day = new Date(`${daySP(clockNow())}T00:00:00.000Z`);
      const companyIdNow = requireCompanyId();
      await prisma.screenView.upsert({
        where: { companyId_screen_day: { companyId: companyIdNow, screen, day } },
        create: { screen, day },
        update: { views: { increment: 1 } },
      });
      return reply.status(204).send();
    },
  );

  app.get('/api/v1/platform/screens', { config: { access: PLATFORM } }, async () => {
    const days = 30;
    const since = new Date(`${daySP(new Date(clockNow().getTime() - days * DAY))}T00:00:00.000Z`);
    const companies = await system.companySettings.findMany({
      where: { isPlatform: false, isDemo: false, closedAt: null },
      select: { id: true },
    });
    const ids = companies.map((c) => c.id);
    const rows = await system.screenView.groupBy({
      by: ['screen', 'companyId'],
      where: { companyId: { in: ids }, day: { gte: since } },
      _sum: { views: true },
    });
    const by = new Map<string, { companies: Set<number>; views: number }>();
    for (const r of rows) {
      const v = by.get(r.screen) ?? { companies: new Set<number>(), views: 0 };
      v.companies.add(r.companyId);
      v.views += r._sum.views ?? 0;
      by.set(r.screen, v);
    }
    const label = (s: string) => SCREEN_LABELS[s] ?? s.replace(/^painel\/?/, '') ?? s;
    const dto: ScreenUsageDto = {
      days,
      companies: new Set(rows.map((r) => r.companyId)).size,
      items: [...by]
        .map(([screen, v]) => ({
          screen,
          label: label(screen),
          companies: v.companies.size,
          views: v.views,
        }))
        .sort((a, b) => b.companies - a.companies || b.views - a.views),
      unused: Object.entries(SCREEN_LABELS)
        .filter(([s]) => !by.has(s))
        .map(([screen, l]) => ({ screen, label: l })),
    };
    return dto;
  });

  // ───────────────────────── Sugestões agrupadas (50) ─────────────────────────
  app.get('/api/v1/platform/feedback/groups', { config: { access: PLATFORM } }, async () => {
    const rows = await system.feedbackReport.findMany({
      where: {
        kind: 'SUGESTAO',
        status: { not: 'RESOLVIDO' },
        createdAt: { gte: new Date(Date.now() - 365 * DAY) },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        companyId: true,
        message: true,
        createdAt: true,
        company: { select: { tradeName: true } },
      },
    });
    const groups = groupFeedback(rows).map((g): FeedbackGroupDto => {
      const sorted = [...g].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return {
        key: sorted[sorted.length - 1]!.id,
        title: sorted[sorted.length - 1]!.message.slice(0, 120),
        companies: new Set(g.map((r) => r.companyId)).size,
        count: g.length,
        lastAt: sorted[0]!.createdAt.toISOString(),
        items: sorted.map((r) => ({
          id: r.id,
          companyName: r.company.tradeName,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
    groups.sort((a, b) => b.companies - a.companies || b.count - a.count);
    return { items: groups };
  });

  // ───────────────────────── Encerrar empresa (51) ─────────────────────────
  app.post(
    '/api/v1/platform/companies/:id/close',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const input = companyCloseSchema.parse(request.body);
      return system.$transaction(async (tx) => {
        const c = await tx.companySettings.findUnique({ where: { id } });
        if (!c || c.isPlatform) throw Errors.notFound('Empresa');
        if (c.closedAt) throw Errors.business('Esta empresa já está encerrada.');
        if (input.confirmName !== c.tradeName)
          throw Errors.validation(
            { confirmName: 'O nome não confere.' },
            'Digite o nome da empresa exatamente como está, para confirmar.',
          );
        const now = new Date();
        const purgeAfter = new Date(now.getTime() + CLOSE_KEEP_DAYS * DAY);
        await tx.companySettings.update({
          where: { id },
          data: {
            closedAt: now,
            closeReason: input.reason,
            purgeAfter,
            blockedAt: c.blockedAt ?? now,
            blockedReason: 'Empresa encerrada',
            canceledAt: c.canceledAt ?? now,
            serverConnections: false,
          },
        });
        // Ninguém da empresa continua dentro.
        await tx.session.updateMany({
          where: { user: { companyId: id }, revokedAt: null },
          data: { revokedAt: now },
        });
        await platformLog(tx, request, {
          action: 'platform.company_closed',
          companyId: id,
          summary: `${c.tradeName} encerrada: ${input.reason}. Dados guardados até ${fmtDay(purgeAfter)}.`,
        });
        return { ok: true, purgeAfter: purgeAfter.toISOString() };
      });
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/reopen',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      return system.$transaction(async (tx) => {
        const c = await tx.companySettings.findUnique({ where: { id } });
        if (!c || c.isPlatform || !c.closedAt) throw Errors.notFound('Empresa encerrada');
        await tx.companySettings.update({
          where: { id },
          data: {
            closedAt: null,
            closeReason: null,
            purgeAfter: null,
            blockedAt: null,
            blockedReason: null,
            canceledAt: null,
          },
        });
        await platformLog(tx, request, {
          action: 'platform.company_reopened',
          companyId: id,
          summary: `${c.tradeName} reaberta: a equipe já pode entrar.`,
        });
        return { ok: true };
      });
    },
  );

  /** Baixar os dados de uma empresa (o mesmo arquivo que ela baixa em Empresa). */
  app.get(
    '/api/v1/platform/companies/:id/export.zip',
    { config: { access: PLATFORM } },
    async (request, reply) => {
      const id = companyId(request);
      const c = await system.companySettings.findUnique({
        where: { id },
        select: { tradeName: true, isPlatform: true },
      });
      if (!c || c.isPlatform) throw Errors.notFound('Empresa');
      const { buildCompanyZip } = await import('../exports/company-export');
      const zip = await runAsCompany(id, async () => (await buildCompanyZip(prisma, id)).zip);
      await platformLog(system, request, {
        action: 'platform.company_exported',
        companyId: id,
        summary: `Dados da ${c.tradeName} baixados pelo painel.`,
      });
      const slug = c.tradeName
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .toLowerCase()
        .slice(0, 40);
      return reply
        .header('content-type', 'application/zip')
        .header(
          'content-disposition',
          `attachment; filename="dados-${slug}-${new Date().toISOString().slice(0, 10)}.zip"`,
        )
        .header('cache-control', 'no-store')
        .send(zip);
    },
  );
}
