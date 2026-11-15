/**
 * Cobranças do pedido aprovado (entrada/saldo, cartão parcelado) no provedor (Asaas), sobre as
 * contas a receber OFICIAIS do Cenário Gestão. A baixa acontece só pela confirmação do provedor
 * (webhook autenticado) e uma única vez: o evento é gravado uma vez e a cobrança guarda o
 * recebimento oficial gerado (payment_id único) — reenvios e eventos repetidos não duplicam.
 */
import { PAYMENT_METHODS, type PaymentMethod } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { connectionOf, requireConnection } from '../integrations/connections';
import { officeWebhookSecret, onOfficeWebhook } from '../integrations/office-webhooks';
import { orderRevenue, createReceivable, receivePayment, reversePayment } from '../finance/revenue';
import { shopTimezone, todayIso } from '../finance/common';
import { idParams } from '../presenters';
import { OFFICE_FIN, OFFICE_VIEW, PROVIDER_ACTOR, brl, officeEvent, orderCodeOf } from './common';
import { type BillingType, asaasCancel, asaasCreateCharge, asaasUpdateDue } from './providers';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const planSchema = z.object({
  mode: z.enum(['ENTRADA_SALDO', 'CARTAO_TOTAL', 'A_VISTA']),
  entradaPercent: z.number().int().min(1).max(99).default(50),
  installments: z.number().int().min(1).max(12).default(1),
  method: z.enum(['PIX', 'BOLETO']).default('PIX'),
  entradaDue: dateOnly.optional(),
  /** Saldo: na entrega (padrão) ou numa data. */
  saldoTrigger: z.enum(['ENTREGA', 'DATA']).default('ENTREGA'),
  saldoDue: dateOnly.optional(),
});
export type ChargePlan = z.infer<typeof planSchema>;

export interface PlannedLine {
  description: string;
  amountCents: number;
  expectedMethod: PaymentMethod;
  billingType: BillingType;
  installments: number | null;
  dueTrigger: 'DATA' | 'ENTREGA';
  dueDate: string | null;
  emitNow: boolean;
}

/** Divide o saldo a lançar do pedido conforme o plano (ex.: R$ 3.000 50/50 → 2 × R$ 1.500). */
export function planCharges(remainingCents: number, p: ChargePlan, today: string): PlannedLine[] {
  if (remainingCents <= 0) return [];
  const due = p.entradaDue ?? today;
  if (p.mode === 'CARTAO_TOTAL')
    return [
      {
        description: `Total no cartão${p.installments > 1 ? ` em ${p.installments}×` : ''}`,
        amountCents: remainingCents,
        expectedMethod: 'CARTAO_CREDITO',
        billingType: 'CARTAO',
        installments: p.installments,
        dueTrigger: 'DATA',
        dueDate: due,
        emitNow: true,
      },
    ];
  if (p.mode === 'A_VISTA')
    return [
      {
        description: `Pagamento à vista (${p.method === 'PIX' ? 'Pix' : 'boleto'})`,
        amountCents: remainingCents,
        expectedMethod: p.method,
        billingType: p.method,
        installments: null,
        dueTrigger: 'DATA',
        dueDate: due,
        emitNow: true,
      },
    ];
  const entrada = Math.round((remainingCents * p.entradaPercent) / 100);
  return [
    {
      description: `Entrada (${p.entradaPercent}%)`,
      amountCents: entrada,
      expectedMethod: p.method,
      billingType: p.method,
      installments: null,
      dueTrigger: 'DATA',
      dueDate: due,
      emitNow: true,
    },
    {
      description: `Saldo (${100 - p.entradaPercent}%)${p.saldoTrigger === 'ENTREGA' ? ' na entrega' : ''}`,
      amountCents: remainingCents - entrada,
      expectedMethod: p.method,
      billingType: p.method,
      installments: null,
      dueTrigger: p.saldoTrigger,
      dueDate: p.saldoTrigger === 'DATA' ? (p.saldoDue ?? addDays(today, 30)) : null,
      emitNow: p.saldoTrigger === 'DATA',
    },
  ];
}

const METHOD_FROM_ASAAS: Record<string, PaymentMethod> = {
  PIX: 'PIX',
  BOLETO: 'BOLETO',
  CREDIT_CARD: 'CARTAO_CREDITO',
  DEBIT_CARD: 'CARTAO_DEBITO',
  TRANSFER: 'TRANSFERENCIA',
  DEPOSIT: 'TRANSFERENCIA',
};

export function chargeDto(c: {
  id: string;
  receivableId: string;
  provider: string;
  providerChargeId: string;
  billingType: string;
  amountCents: number;
  installments: number | null;
  dueDate: Date;
  status: string;
  pixPayload: string | null;
  paymentUrl: string | null;
  paidAt: Date | null;
  paymentId: string | null;
  version: number;
}) {
  return {
    id: c.id,
    receivableId: c.receivableId,
    provider: c.provider,
    providerChargeId: c.providerChargeId,
    billingType: c.billingType,
    amountCents: c.amountCents,
    installments: c.installments,
    dueDate: c.dueDate.toISOString().slice(0, 10),
    status: c.status,
    pixPayload: c.pixPayload,
    paymentUrl: c.paymentUrl,
    paidAt: c.paidAt?.toISOString() ?? null,
    baixada: Boolean(c.paymentId),
    version: c.version,
  };
}

/** Emite no provedor a cobrança de uma conta a receber oficial (uma aberta por conta). */
async function emitCharge(
  tx: Tx,
  actor: Parameters<typeof audit>[1],
  receivableId: string,
  billingType: BillingType,
  dueDate: string,
) {
  const r = await tx.customerReceivable.findUnique({
    where: { id: receivableId },
    include: { customer: true, order: true, charges: { where: { status: 'ABERTA' } } },
  });
  if (!r) throw Errors.notFound('Conta a receber');
  if (r.status === 'CANCELADO' || r.status === 'RECEBIDO')
    throw Errors.business('Esta conta já está quitada ou cancelada.');
  if (r.charges.length) return r.charges[0]!;
  const conn = await requireConnection(tx, 'COBRANCAS');
  const amount = r.amountCents - r.receivedCents;
  const ext = await asaasCreateCharge(
    { mode: conn.mode, secret: conn.secret as never },
    {
      customer: {
        name: r.customer.name,
        document: r.customer.document,
        email: r.customer.email,
        phone: r.customer.whatsapp ?? r.customer.phone,
      },
      billingType,
      amountCents: amount,
      dueDate,
      description: `${orderCodeOf(r.order.number)} — ${r.description}`,
      externalReference: r.id,
      installments: r.installments,
    },
  );
  const ch = await tx.paymentCharge.create({
    data: {
      receivableId,
      provider: ext.test ? 'ASAAS_TESTE' : 'ASAAS',
      providerChargeId: ext.id,
      billingType,
      amountCents: amount,
      installments: r.installments,
      dueDate: new Date(`${dueDate}T00:00:00Z`),
      pixPayload: ext.pixPayload,
      paymentUrl: ext.paymentUrl,
      createdById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'office.charge_created',
    entityType: 'payment_charge',
    entityId: ch.id,
    summary: `Cobrança ${billingType} de ${brl(amount)} (${r.description}) emitida${ext.test ? ' em teste' : ' no Asaas'} para ${orderCodeOf(r.order.number)}.`,
  });
  await officeEvent(tx, actor, 'payment_charge', ch.id, { orderId: r.orderId });
  return ch;
}

/** Baixa pelo retorno do provedor: única por cobrança (bloqueio + payment_id). */
export async function settleFromProvider(
  tx: Tx,
  providerChargeId: string,
  p: {
    value?: number;
    billingType?: string;
    paymentDate?: string;
    clientPaymentDate?: string;
    confirmedDate?: string;
  },
) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM payment_charges WHERE provider_charge_id = ${providerChargeId} FOR UPDATE`;
  if (!rows.length) return 'cobrança desconhecida';
  const ch = await tx.paymentCharge.findUniqueOrThrow({
    where: { id: rows[0]!.id },
    include: { receivable: { include: { order: true } } },
  });
  if (ch.paymentId) return 'já baixada (confirmação repetida ignorada)';
  if (ch.status === 'CANCELADA') return 'cobrança cancelada';
  const r = ch.receivable;
  const tz = await shopTimezone(tx);
  const today = todayIso(tz);
  const date =
    [p.paymentDate, p.clientPaymentDate, p.confirmedDate].find((d) => d && d <= today) ?? today;
  const amount = Math.min(
    Math.round((p.value ?? ch.amountCents / 100) * 100),
    r.amountCents - r.receivedCents,
  );
  if (amount <= 0) return 'conta já quitada';
  const { payment } = await receivePayment(tx, PROVIDER_ACTOR, r.id, {
    amountCents: amount,
    receivedAt: date,
    method:
      METHOD_FROM_ASAAS[p.billingType ?? ''] ??
      (ch.billingType === 'CARTAO'
        ? 'CARTAO_CREDITO'
        : ch.billingType === 'BOLETO'
          ? 'BOLETO'
          : 'PIX'),
    installments: ch.billingType === 'CARTAO' ? ch.installments : null,
    note: `Confirmado pelo provedor (${ch.provider}, ${ch.providerChargeId}).`,
    version: r.version,
  });
  await tx.paymentCharge.update({
    where: { id: ch.id },
    data: { status: 'PAGA', paidAt: new Date(), paymentId: payment.id, version: { increment: 1 } },
  });
  await tx.accountingDocument.create({
    data: {
      month: date.slice(0, 7),
      kind: 'COMPROVANTE',
      title: `Recebimento ${brl(amount)} — ${orderCodeOf(r.order.number)} ${r.description} (${ch.provider})`,
      refType: 'customer_payment',
      refId: payment.id,
    },
  });
  await audit(tx, PROVIDER_ACTOR, {
    action: 'office.charge_paid',
    entityType: 'payment_charge',
    entityId: ch.id,
    summary: `Pagamento de ${brl(amount)} confirmado pelo provedor; baixa registrada na conta a receber.`,
  });
  await officeEvent(tx, PROVIDER_ACTOR, 'payment_charge', ch.id, { orderId: r.orderId });
  return 'baixa registrada';
}

export async function chargeRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Prévia (não grava): parcelas propostas sobre o saldo a lançar do pedido. */
  app.post(
    '/api/v1/office/orders/:id/charges/preview',
    { config: { access: OFFICE_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const plan = planSchema.parse(request.body ?? {});
      const rev = await orderRevenue(prisma, id);
      if (rev.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
      const today = todayIso(await shopTimezone(prisma));
      const conn = await connectionOf(prisma, 'COBRANCAS');
      return {
        order: orderCodeOf(rev.order.number),
        customer: rev.order.customer.name,
        finalCents: rev.finalCents,
        billedCents: rev.billedCents,
        remainingCents: rev.finalCents - rev.billedCents,
        lines: planCharges(rev.finalCents - rev.billedCents, plan, today),
        provider:
          conn?.status === 'CONECTADA'
            ? { label: conn.accountLabel, test: conn.mode === 'TESTE_LOCAL' }
            : null,
      };
    },
  );

  /** Aprovação do plano: cria as contas a receber oficiais e emite as cobranças marcadas. */
  app.post(
    '/api/v1/office/orders/:id/charges',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const plan = planSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      return prisma.$transaction(
        async (tx) => {
          const rev = await orderRevenue(tx, id);
          if (rev.finalCents === null) throw Errors.business('O pedido não tem valor contratado.');
          const today = todayIso(await shopTimezone(tx));
          const lines = planCharges(rev.finalCents - rev.billedCents, plan, today);
          if (!lines.length)
            throw Errors.business('Todo o valor do pedido já está lançado em contas a receber.');
          const so = rev.shares[0]?.id ?? null;
          const out = [];
          for (const l of lines) {
            const r = await createReceivable(tx, actor, {
              orderId: id,
              serviceOrderId: so,
              description: l.description,
              amountCents: l.amountCents,
              dueTrigger: l.dueTrigger,
              dueDate: l.dueDate,
              expectedMethod: l.expectedMethod,
              installments: l.installments,
              notes: 'Plano de cobrança aprovado no escritório.',
            });
            const ch = l.emitNow
              ? await emitCharge(tx, actor, r.id, l.billingType, l.dueDate ?? today)
              : null;
            out.push({
              receivableId: r.id,
              description: r.description,
              amountCents: r.amountCents,
              dueTrigger: r.dueTrigger,
              dueDate: l.dueDate,
              charge: ch ? chargeDto(ch) : null,
            });
          }
          return { lines: out };
        },
        { timeout: 30_000 },
      );
    },
  );

  app.post(
    '/api/v1/office/receivables/:id/charge',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({ billingType: z.enum(['PIX', 'BOLETO', 'CARTAO', 'LINK']), dueDate: dateOnly })
        .parse(request.body);
      return prisma.$transaction(
        async (tx) =>
          chargeDto(await emitCharge(tx, actorFrom(request), id, b.billingType, b.dueDate)),
        { timeout: 30_000 },
      );
    },
  );

  app.get(
    '/api/v1/office/orders/:id/charges',
    { config: { access: OFFICE_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.customerReceivable.findMany({
        where: { orderId: id },
        include: { charges: { orderBy: { createdAt: 'desc' } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id,
        description: r.description,
        amountCents: r.amountCents,
        receivedCents: r.receivedCents,
        status: r.status,
        dueTrigger: r.dueTrigger,
        dueDate: r.dueDate?.toISOString().slice(0, 10) ?? null,
        expectedMethod: r.expectedMethod,
        version: r.version,
        charges: r.charges.map(chargeDto),
      }));
    },
  );

  /** Ajustar vencimento: no provedor e na conta a receber (com histórico). */
  app.put(
    '/api/v1/office/charges/:id/due',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({ dueDate: dateOnly, version: z.number().int().positive() })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const ch = await tx.paymentCharge.findUnique({
          where: { id },
          include: { receivable: true },
        });
        if (!ch) throw Errors.notFound('Cobrança');
        if (ch.version !== b.version) throw Errors.conflict('A cobrança mudou. Recarregue.');
        if (ch.status !== 'ABERTA' && ch.status !== 'VENCIDA')
          throw Errors.business('Só cobranças em aberto têm vencimento ajustável.');
        const conn = await requireConnection(tx, 'COBRANCAS');
        await asaasUpdateDue(
          { mode: conn.mode, secret: conn.secret as never },
          ch.providerChargeId,
          b.dueDate,
        );
        const u = await tx.paymentCharge.update({
          where: { id },
          data: {
            dueDate: new Date(`${b.dueDate}T00:00:00Z`),
            status: 'ABERTA',
            version: { increment: 1 },
          },
        });
        if (ch.receivable.dueTrigger === 'DATA')
          await tx.customerReceivable.update({
            where: { id: ch.receivableId },
            data: { dueDate: new Date(`${b.dueDate}T00:00:00Z`), version: { increment: 1 } },
          });
        await audit(tx, actor, {
          action: 'office.charge_due_changed',
          entityType: 'payment_charge',
          entityId: id,
          summary: `Vencimento ajustado para ${b.dueDate.split('-').reverse().join('/')}.`,
          changes: { from: ch.dueDate.toISOString().slice(0, 10), to: b.dueDate },
        });
        await officeEvent(tx, actor, 'payment_charge', id);
        return chargeDto(u);
      });
    },
  );

  app.post(
    '/api/v1/office/charges/:id/cancel',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const ch = await tx.paymentCharge.findUnique({ where: { id } });
        if (!ch) throw Errors.notFound('Cobrança');
        if (ch.paymentId) throw Errors.business('Cobrança já paga: use o estorno no financeiro.');
        const conn = await requireConnection(tx, 'COBRANCAS');
        await asaasCancel({ mode: conn.mode, secret: conn.secret as never }, ch.providerChargeId);
        const u = await tx.paymentCharge.update({
          where: { id },
          data: { status: 'CANCELADA', version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'office.charge_cancelled',
          entityType: 'payment_charge',
          entityId: id,
          summary: 'Cobrança cancelada no provedor.',
        });
        await officeEvent(tx, actor, 'payment_charge', id);
        return chargeDto(u);
      });
    },
  );

  /** Mensagem pronta para o WhatsApp (rascunho na caixa de entrada; o envio é seu). */
  app.post(
    '/api/v1/office/charges/:id/whatsapp',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const ch = await prisma.paymentCharge.findUnique({
        where: { id },
        include: { receivable: { include: { customer: true, order: true } } },
      });
      if (!ch) throw Errors.notFound('Cobrança');
      const r = ch.receivable;
      const first = r.customer.name.split(' ')[0];
      const text = [
        `Olá, ${first}! Segue a cobrança da ${r.description.toLowerCase()} do seu pedido na Cenário Estofados: ${brl(ch.amountCents)}, vencimento ${ch.dueDate.toISOString().slice(0, 10).split('-').reverse().join('/')}.`,
        ch.pixPayload ? `Pix copia e cola:\n${ch.pixPayload}` : null,
        ch.paymentUrl ? `Ou pague pelo link: ${ch.paymentUrl}` : null,
        'Assim que o pagamento cair, a baixa é automática. Obrigado!',
      ]
        .filter(Boolean)
        .join('\n\n');
      const conv = await prisma.inboxConversation.findFirst({
        where: {
          channel: 'WHATSAPP',
          OR: [
            { customerId: r.customerId },
            ...(r.serviceOrderId ? [{ serviceOrderId: r.serviceOrderId }] : []),
          ],
        },
        orderBy: { lastMessageAt: 'desc' },
      });
      if (!conv)
        return {
          text,
          conversationId: null,
          detail:
            'Nenhuma conversa de WhatsApp vinculada a este cliente: copie a mensagem ou vincule a conversa na caixa de entrada.',
        };
      await prisma.$transaction(async (tx) => {
        await tx.inboxMessage.updateMany({
          where: { conversationId: conv.id, status: 'RASCUNHO' },
          data: { status: 'DESCARTADA' },
        });
        await tx.inboxMessage.create({
          data: {
            conversationId: conv.id,
            direction: 'OUT',
            kind: 'TEXT',
            text,
            status: 'RASCUNHO',
            createdById: actorFrom(request).userId,
          },
        });
      });
      return {
        text,
        conversationId: conv.id,
        detail: 'Rascunho colocado na conversa do cliente: revise e envie pela caixa de entrada.',
      };
    },
  );

  /** Modo de teste: o "Asaas" confirma o pagamento pelo MESMO webhook (com o token do webhook). */
  app.post(
    '/api/v1/office/charges/:id/simulate',
    { config: { access: OFFICE_FIN } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          event: z
            .enum(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_REFUNDED'])
            .default('PAYMENT_RECEIVED'),
          eventId: z.string().max(80).optional(),
        })
        .parse(request.body ?? {});
      const ch = await prisma.paymentCharge.findUnique({ where: { id } });
      if (!ch?.provider.endsWith('_TESTE'))
        throw Errors.business('Simulação só para cobranças emitidas em modo de teste.');
      const today = todayIso(await shopTimezone(prisma));
      const body = {
        id: b.eventId ?? `evt_teste_${Date.now()}`,
        event: b.event,
        dateCreated: new Date().toISOString(),
        payment: {
          object: 'payment',
          id: ch.providerChargeId,
          value: ch.amountCents / 100,
          netValue: ch.amountCents / 100,
          billingType: ch.billingType === 'CARTAO' ? 'CREDIT_CARD' : ch.billingType,
          status: b.event.replace('PAYMENT_', ''),
          dueDate: ch.dueDate.toISOString().slice(0, 10),
          paymentDate: today,
          clientPaymentDate: today,
          externalReference: ch.receivableId,
        },
      };
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/asaas',
        payload: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'asaas-access-token': officeWebhookSecret('ASAAS')!,
        },
      });
      return { status: res.statusCode, ...(res.json() as object), eventId: body.id };
    },
  );

  onOfficeWebhook('ASAAS', async (db, payload) => {
    const ev = String(payload.event ?? '');
    const pay = (payload.payment ?? {}) as {
      id?: string;
      value?: number;
      billingType?: string;
      paymentDate?: string;
      clientPaymentDate?: string;
      confirmedDate?: string;
    };
    if (!pay.id) return 'sem cobrança';
    if (ev === 'PAYMENT_RECEIVED' || ev === 'PAYMENT_CONFIRMED')
      return db.$transaction((tx) => settleFromProvider(tx, pay.id!, pay));
    return db.$transaction(async (tx) => {
      const ch = await tx.paymentCharge.findUnique({ where: { providerChargeId: pay.id! } });
      if (!ch) return 'cobrança desconhecida';
      if (ev === 'PAYMENT_OVERDUE' && ch.status === 'ABERTA') {
        await tx.paymentCharge.update({
          where: { id: ch.id },
          data: { status: 'VENCIDA', version: { increment: 1 } },
        });
        await officeEvent(tx, PROVIDER_ACTOR, 'payment_charge', ch.id);
        return 'vencida';
      }
      if (
        (ev === 'PAYMENT_REFUNDED' || ev === 'PAYMENT_CHARGEBACK_REQUESTED') &&
        ch.paymentId &&
        ch.status === 'PAGA'
      ) {
        const r = await tx.customerReceivable.findUniqueOrThrow({ where: { id: ch.receivableId } });
        await reversePayment(tx, PROVIDER_ACTOR, ch.paymentId, {
          reason: `Estorno confirmado pelo provedor (${ev}).`,
          version: r.version,
        });
        await tx.paymentCharge.update({
          where: { id: ch.id },
          data: { status: 'ESTORNADA', version: { increment: 1 } },
        });
        await officeEvent(tx, PROVIDER_ACTOR, 'payment_charge', ch.id);
        return 'estornada';
      }
      if (ev === 'PAYMENT_DELETED' && !ch.paymentId) {
        await tx.paymentCharge.update({
          where: { id: ch.id },
          data: { status: 'CANCELADA', version: { increment: 1 } },
        });
        return 'cancelada';
      }
      return `evento ${ev} sem efeito`;
    });
  });
  void PAYMENT_METHODS;
}
