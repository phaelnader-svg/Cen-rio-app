import { timingSafeEqual } from 'node:crypto';
import {
  PLANS,
  PROVISIONAL_TRADE_NAME,
  SUBSCRIPTION_STATUS_LABEL,
  addCycle,
  isPlanKey,
  subscribeSchema,
  type BillingCycle,
  type InvoiceStatus,
  type PlanKey,
  type SubscriptionDto,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import {
  COMPANY_BILLING_SELECT,
  billingOn,
  blocksAt,
  cycleOf,
  planOf,
  plansCatalog,
  statusOf,
  type CompanyBillingRow,
} from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import {
  companyPriceCents,
  listPriceCents,
  platformConfig,
  whatsappLink,
} from '../../core/platform-config';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { requireCompanyId, runAsCompany } from '../../core/tenant';
import { Errors } from '../../lib/errors';
import { AsaasClient, AsaasError, type AsaasPayment } from './asaas';

/**
 * Assinatura do Cenário Gestão (melhorias 1 e 2). O gestor escolhe o plano e o ciclo, o sistema
 * cria a assinatura no Asaas e abre a página de pagamento (Pix, boleto ou cartão). O Asaas avisa
 * pelo webhook quando a cobrança é paga, e o "pago até" da empresa anda um ciclo. O plano novo
 * (com ou sem o jogo) passa a valer quando o pagamento dele é confirmado.
 */

const checkoutSchema = subscribeSchema.extend({
  /** CPF ou CNPJ de quem paga (o Asaas exige). Vazio = o documento cadastrado em Empresa. */
  document: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === 11 || v.length === 14, {
      message: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).',
    })
    .optional(),
});

const PAID_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_RECEIVED_IN_CASH']);
const CANCEL_EVENTS = new Set([
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED',
]);

/** Data de hoje em São Paulo (AAAA-MM-DD). */
export function todaySaoPaulo(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
const dateOnly = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export async function billingRoutesPlatform(app: FastifyInstance) {
  const { prisma, system, env, mailer } = app.ctx;
  const asaas = env.ASAAS_API_KEY
    ? new AsaasClient({ apiKey: env.ASAAS_API_KEY, baseUrl: env.ASAAS_BASE_URL }, (...a) =>
        app.ctx.fetch(...a),
      )
    : null;
  const webUrl = () => env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0]!;

  async function subscriptionDto(db: PrismaClient): Promise<SubscriptionDto> {
    const c = await db.companySettings.findUniqueOrThrow({
      where: { id: requireCompanyId() },
      select: { ...COMPANY_BILLING_SELECT, billingPriceCents: true, tradeName: true },
    });
    const invoices = await db.subscriptionInvoice.findMany({
      orderBy: { dueDate: 'desc' },
      take: 24,
    });
    const status = statusOf(c, env, clockNow());
    const plan = planOf(c);
    const end = blocksAt(c, env);
    return {
      plan,
      planLabel: PLANS[plan].label,
      cycle: cycleOf(c),
      status,
      statusLabel: SUBSCRIPTION_STATUS_LABEL[status],
      trialEndsAt: c.trialEndsAt?.toISOString() ?? null,
      paidUntil: c.paidUntil?.toISOString() ?? null,
      blocksAt: end?.toISOString() ?? null,
      billingEnabled: billingOn(env),
      canPayOnline: asaas !== null,
      includesGame: PLANS[plan].includesGame,
      invoices: invoices.map((i) => ({
        id: i.id,
        plan: isPlanKey(i.plan) ? i.plan : 'gestao',
        cycle: i.cycle === 'ANUAL' ? 'ANUAL' : 'MENSAL',
        amountCents: i.amountCents,
        dueDate: i.dueDate.toISOString().slice(0, 10),
        status: i.status as InvoiceStatus,
        paymentUrl: i.status === 'PENDENTE' || i.status === 'VENCIDA' ? i.paymentUrl : null,
        paidAt: i.paidAt?.toISOString() ?? null,
        periodEnd: i.periodEnd?.toISOString() ?? null,
      })),
      plans: plansCatalog(),
      annualDiscountPct: platformConfig().annualDiscountBps / 100,
      manual: manualPayment(c, plan),
    };
  }

  /** Cobrança feita pelo dono da plataforma: PIX e WhatsApp do painel /plataforma. */
  function manualPayment(
    c: CompanyBillingRow & { billingPriceCents: number | null; tradeName: string },
    plan: PlanKey,
  ): SubscriptionDto['manual'] {
    const cfg = platformConfig();
    if (!cfg.pixKey && !cfg.whatsapp) return null;
    const amountCents = companyPriceCents({
      plan,
      cycle: cycleOf(c),
      billingPriceCents: c.billingPriceCents,
    });
    const name = c.tradeName && c.tradeName !== PROVISIONAL_TRADE_NAME ? ` da ${c.tradeName}` : '';
    return {
      pixKey: cfg.pixKey,
      pixName: cfg.pixName,
      pixBank: cfg.pixBank,
      message: cfg.paymentMessage,
      amountCents,
      whatsappUrl: whatsappLink(
        `Olá! Sou${name} e quero continuar com o Cenário Gestão (${PLANS[plan].label}, ${fmtBRL(amountCents)} ${cycleOf(c) === 'ANUAL' ? 'por ano' : 'por mês'}). Segue o comprovante do PIX.`,
      ),
    };
  }

  // Funciona mesmo com a assinatura vencida: é por aqui que a empresa paga e volta a entrar.
  app.get(
    '/api/v1/subscription',
    { config: { access: { session: 'WEB', permissions: ['empresa.ver'], billingExempt: true } } },
    async () => subscriptionDto(prisma),
  );

  app.post(
    '/api/v1/subscription/checkout',
    {
      config: {
        access: { session: 'WEB', permissions: ['empresa.configurar'], billingExempt: true },
      },
    },
    async (request) => {
      if (!asaas)
        throw Errors.business(
          'O pagamento online ainda não está disponível. Fale com o Cenário Gestão pelo WhatsApp.',
        );
      const input = checkoutSchema.parse(request.body);
      const auth = request.auth!;
      const companyId = requireCompanyId();
      const company = await prisma.companySettings.findUniqueOrThrow({ where: { id: companyId } });
      if (company.billingCourtesy)
        throw Errors.business('Esta empresa tem cortesia: não há o que pagar.');
      const document = input.document || (company.document ?? '').replace(/\D/g, '');
      if (document.length !== 11 && document.length !== 14)
        throw Errors.validation(
          { document: 'Informe o CPF ou CNPJ de quem paga.' },
          'Informe o CPF ou CNPJ de quem paga a assinatura.',
        );
      const email = company.email || auth.email;
      if (!email)
        throw Errors.business('Cadastre o e-mail da empresa em Empresa antes de assinar.');
      const name = company.legalName || company.tradeName;
      const value = listPriceCents(input.plan, input.cycle);

      try {
        let customerId = company.asaasCustomerId;
        if (!customerId) {
          customerId = (
            await asaas.createCustomer({
              name,
              email,
              cpfCnpj: document,
              externalReference: `cenario-empresa:${companyId}`,
            })
          ).id;
        } else {
          await asaas.updateCustomer(customerId, { name, email, cpfCnpj: document });
        }
        // Trocar de plano ou de ciclo: a assinatura anterior é cancelada no Asaas.
        if (company.asaasSubscriptionId) {
          await asaas.cancelSubscription(company.asaasSubscriptionId).catch((err: unknown) => {
            request.log.warn({ err }, 'Falha ao cancelar a assinatura anterior no Asaas');
          });
          await prisma.subscriptionInvoice.updateMany({
            where: { status: { in: ['PENDENTE', 'VENCIDA'] }, provider: 'ASAAS' },
            data: { status: 'CANCELADA' },
          });
        }
        // Vencimento: hoje se já venceu ou se o plano muda (o plano novo vale ao pagar); senão,
        // no fim do período atual (teste grátis ou mês pago).
        const status = statusOf(company, env, clockNow());
        const end = Math.max(
          company.trialEndsAt?.getTime() ?? 0,
          company.paidUntil?.getTime() ?? 0,
        );
        const today = todaySaoPaulo(clockNow());
        const samePlan = planOf(company) === input.plan;
        const nextDueDate =
          samePlan && (status === 'TESTE' || status === 'ATIVA') && end > clockNow().getTime()
            ? todaySaoPaulo(new Date(end))
            : today;
        const sub = await asaas.createSubscription({
          customer: customerId,
          value: value / 100,
          nextDueDate,
          cycle: input.cycle === 'ANUAL' ? 'YEARLY' : 'MONTHLY',
          description: `${PLANS[input.plan].label} (${input.cycle === 'ANUAL' ? 'anual' : 'mensal'}) — ${company.tradeName}`,
          externalReference: `cenario-empresa:${companyId}:${input.plan}:${input.cycle}`,
        });
        const payments = (await asaas.subscriptionPayments(sub.id)).data ?? [];
        await prisma.$transaction(async (tx) => {
          await tx.companySettings.update({
            where: { id: companyId },
            data: {
              asaasCustomerId: customerId,
              asaasSubscriptionId: sub.id,
              document: company.document || document,
            },
          });
          for (const p of payments) {
            await tx.subscriptionInvoice.upsert({
              where: { externalId: p.id },
              create: invoiceData(p, input.plan, input.cycle),
              update: { paymentUrl: p.invoiceUrl ?? null },
            });
          }
          await audit(tx, actorFrom(request), {
            action: 'billing.subscribed',
            entityType: 'company',
            entityId: String(companyId),
            summary: `Assinatura ${PLANS[input.plan].label} (${input.cycle.toLowerCase()}) de ${fmtBRL(value)} gerada no Asaas, vencimento ${nextDueDate.split('-').reverse().join('/')}.`,
          });
        });
        const first = payments.find((p) => p.invoiceUrl);
        return {
          paymentUrl: first?.invoiceUrl ?? null,
          subscription: await subscriptionDto(prisma),
        };
      } catch (err) {
        if (err instanceof AsaasError)
          throw Errors.business(`O Asaas recusou a assinatura: ${err.message}`);
        throw err;
      }
    },
  );

  function invoiceData(p: AsaasPayment, plan: PlanKey, cycle: BillingCycle) {
    return {
      provider: 'ASAAS',
      externalId: p.id,
      plan,
      cycle,
      amountCents: Math.round(p.value * 100),
      dueDate: dateOnly(p.dueDate),
      status: 'PENDENTE',
      paymentUrl: p.invoiceUrl ?? null,
    };
  }

  /** O plano e o ciclo vêm da referência da assinatura (`cenario-empresa:<id>:<plano>:<ciclo>`). */
  function refOf(ref: string | null | undefined) {
    const m = /^cenario-empresa:(\d+)(?::([a-z_]+):(MENSAL|ANUAL))?$/.exec(ref ?? '');
    if (!m) return null;
    return {
      companyId: Number(m[1]),
      plan: m[2] && isPlanKey(m[2]) ? m[2] : null,
      cycle: (m[3] as BillingCycle | undefined) ?? null,
    };
  }

  /** Processa uma notificação de cobrança do Asaas. Idempotente: repetir não paga duas vezes. */
  async function handlePaymentEvent(event: string, p: AsaasPayment): Promise<string> {
    let invoice = await system.subscriptionInvoice.findUnique({ where: { externalId: p.id } });
    let companyId = invoice?.companyId ?? null;
    let plan: PlanKey | null = invoice && isPlanKey(invoice.plan) ? invoice.plan : null;
    let cycle: BillingCycle | null = invoice ? (invoice.cycle as BillingCycle) : null;
    if (!invoice) {
      // Cobrança nova de uma assinatura (o Asaas gera uma por ciclo).
      const bySub = p.subscription
        ? await system.companySettings.findFirst({
            where: { asaasSubscriptionId: p.subscription },
            select: { id: true },
          })
        : null;
      const ref = refOf(p.externalReference);
      companyId = bySub?.id ?? ref?.companyId ?? null;
      if (!companyId) return 'cobrança de outra origem (ignorada)';
      const last = await system.subscriptionInvoice.findFirst({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      });
      plan = ref?.plan ?? (last && isPlanKey(last.plan) ? last.plan : null);
      cycle = ref?.cycle ?? (last?.cycle as BillingCycle | undefined) ?? null;
      const company = await system.companySettings.findUniqueOrThrow({
        where: { id: companyId },
        select: COMPANY_BILLING_SELECT,
      });
      plan ??= planOf(company);
      cycle ??= cycleOf(company);
      invoice = await system.subscriptionInvoice.create({
        data: { ...invoiceData(p, plan, cycle), companyId },
      });
    }
    const cid = companyId!;
    return runAsCompany(cid, () =>
      prisma.$transaction(async (tx) => {
        const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
        const actor = { userId: null, sessionId: null, ip: null, requestId: null };
        if (PAID_EVENTS.has(event)) {
          if (inv.status === 'PAGA') return 'já paga';
          const company = (await tx.companySettings.findUniqueOrThrow({
            where: { id: cid },
            select: { ...COMPANY_BILLING_SELECT, tradeName: true, email: true },
          })) as CompanyBillingRow & { tradeName: string; email: string | null };
          const invCycle: BillingCycle = inv.cycle === 'ANUAL' ? 'ANUAL' : 'MENSAL';
          const base = new Date(Math.max(company.paidUntil?.getTime() ?? 0, inv.dueDate.getTime()));
          const periodEnd = addCycle(base, invCycle);
          await tx.subscriptionInvoice.update({
            where: { id: inv.id },
            data: { status: 'PAGA', paidAt: new Date(), periodEnd },
          });
          await tx.companySettings.update({
            where: { id: cid },
            data: { paidUntil: periodEnd, plan: inv.plan, billingCycle: invCycle },
          });
          await audit(tx, actor, {
            action: 'billing.paid',
            entityType: 'company',
            entityId: String(cid),
            summary: `Pagamento de ${fmtBRL(inv.amountCents)} confirmado pelo Asaas: ${PLANS[isPlanKey(inv.plan) ? inv.plan : 'gestao'].label} liberado até ${fmtDate(periodEnd)}.`,
          });
          await notifyCompany(tx, cid, company.email, {
            kind: 'assinatura-paga',
            subject: 'Pagamento confirmado — Cenário Gestão',
            title: 'Pagamento confirmado',
            paragraphs: [
              `Recebemos o pagamento de ${fmtBRL(inv.amountCents)} da assinatura de ${company.tradeName}.`,
              `O sistema está liberado até ${fmtDate(periodEnd)}. Obrigado!`,
            ],
          });
          return `paga até ${periodEnd.toISOString().slice(0, 10)}`;
        }
        if (event === 'PAYMENT_OVERDUE') {
          if (inv.status !== 'PENDENTE') return 'sem mudança';
          await tx.subscriptionInvoice.update({
            where: { id: inv.id },
            data: { status: 'VENCIDA' },
          });
          const company = await tx.companySettings.findUniqueOrThrow({ where: { id: cid } });
          await notifyCompany(tx, cid, company.email, {
            kind: 'assinatura-vencida',
            subject: 'Mensalidade do Cenário Gestão em aberto',
            title: 'Mensalidade em aberto',
            paragraphs: [
              `A cobrança de ${fmtBRL(inv.amountCents)} com vencimento em ${fmtDate(inv.dueDate)} ainda não foi paga.`,
              `O sistema continua funcionando por ${env.BILLING_GRACE_DAYS} dias depois do vencimento. Depois disso, só a tela de assinatura abre até o pagamento.`,
            ],
            button: inv.paymentUrl ? { label: 'Pagar agora', url: inv.paymentUrl } : undefined,
          });
          return 'vencida';
        }
        if (CANCEL_EVENTS.has(event)) {
          if (inv.status === 'CANCELADA') return 'sem mudança';
          await tx.subscriptionInvoice.update({
            where: { id: inv.id },
            data: { status: 'CANCELADA' },
          });
          return 'cancelada';
        }
        // Criada ou alterada: atualiza valor, vencimento e o link de pagamento.
        if (inv.status === 'PENDENTE' || inv.status === 'VENCIDA')
          await tx.subscriptionInvoice.update({
            where: { id: inv.id },
            data: {
              amountCents: Math.round(p.value * 100),
              dueDate: dateOnly(p.dueDate),
              paymentUrl: p.invoiceUrl ?? inv.paymentUrl,
            },
          });
        return 'atualizada';
      }),
    );
  }

  /** E-mail para a empresa e para os gestores dela. */
  async function notifyCompany(
    tx: Parameters<typeof enqueueEmail>[0],
    companyId: number,
    companyEmail: string | null,
    m: {
      kind: string;
      subject: string;
      title: string;
      paragraphs: string[];
      button?: { label: string; url: string };
    },
  ) {
    const owners = await tx.user.findMany({
      where: {
        companyId,
        active: true,
        email: { not: null },
        roles: { some: { role: { key: 'gestor' } } },
      },
      select: { email: true },
    });
    const to = new Set([companyEmail, ...owners.map((o) => o.email)].filter(Boolean) as string[]);
    const body = simpleEmail({
      title: m.title,
      paragraphs: m.paragraphs,
      button: m.button ?? { label: 'Abrir a assinatura', url: `${webUrl()}/painel/assinatura` },
    });
    for (const addr of to)
      await enqueueEmail(tx, { to: addr, subject: m.subject, kind: m.kind, ...body });
  }

  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    sub.post(
      '/api/webhooks/assinatura/asaas',
      { config: { access: { webhook: true } } },
      async (request, reply) => {
        const secret = env.ASAAS_WEBHOOK_TOKEN;
        const got = request.headers['asaas-access-token'];
        if (!secret || typeof got !== 'string' || !same(got, secret))
          return reply.status(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Notificação sem autenticação válida.' },
          });
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('{}');
        let payload: { event?: string; payment?: AsaasPayment };
        try {
          payload = JSON.parse(raw.toString('utf8') || '{}') as typeof payload;
        } catch {
          return reply
            .status(400)
            .send({ error: { code: 'VALIDATION_ERROR', message: 'JSON inválido.' } });
        }
        if (!payload.event?.startsWith('PAYMENT_') || !payload.payment?.id)
          return { received: true, result: 'evento ignorado' };
        const result = await handlePaymentEvent(payload.event, payload.payment);
        mailer.kick();
        return { received: true, result };
      },
    );
  });
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
