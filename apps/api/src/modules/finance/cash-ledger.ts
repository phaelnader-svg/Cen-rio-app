import {
  manualExpenseSchema,
  manualRevenueCancelSchema,
  manualRevenueSchema,
  payableCode,
  productionPayableCode,
  receivableCode,
  type CashLedgerDto,
  type CashLineDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { assertCategory } from './categories';
import { FIN_MANAGE, FIN_VIEW, dateOnly, parseDate, period, shopTimezone } from './common';
import { createPayable, payPayable } from './payables';

/**
 * Receitas e Despesas (2026-11-18): TUDO que entrou e TUDO que saiu no período, numa lista só,
 * vindo dos registros oficiais (nada é copiado). Entradas: pagamentos de clientes (com estornos e
 * reembolsos em negativo) e receitas avulsas. Saídas: toda conta paga (gastos fixos, logística,
 * compras, despesas avulsas) e todo pagamento de mão de obra; estornos ficam de fora do total.
 */

/** Marca das despesas lançadas pela aba Despesas (contas já pagas na hora). */
export const MANUAL_EXPENSE_NOTE = 'Lançada em Despesas (já paga).';

type Db = Tx | PrismaClient;
const dayOf = (d: Date) => dateOnly(d)!;
const sortLines = (l: CashLineDto[]) =>
  l.sort((a, b) => b.date.localeCompare(a.date) || b.amountCents - a.amountCents);

function ledger(from: string, to: string, lines: CashLineDto[]): CashLedgerDto {
  const valid = lines.filter((l) => !l.cancelled);
  const by = new Map<CashLineDto['source'], number>();
  for (const l of valid) by.set(l.source, (by.get(l.source) ?? 0) + l.amountCents);
  return {
    from,
    to,
    totalCents: valid.reduce((a, l) => a + l.amountCents, 0),
    bySource: [...by.entries()]
      .map(([source, totalCents]) => ({ source, totalCents }))
      .sort((a, b) => b.totalCents - a.totalCents),
    lines: sortLines(lines),
  };
}

export async function cashIn(db: Db, q: { from?: string; to?: string }): Promise<CashLedgerDto> {
  const p = period(q, await shopTimezone(db));
  const range = { gte: p.fromDate, lte: p.toDate };
  const [payments, manual] = await Promise.all([
    db.customerPayment.findMany({
      where: { receivedAt: range },
      include: {
        receivable: {
          select: {
            number: true,
            description: true,
            customer: { select: { name: true } },
            order: { select: { number: true } },
          },
        },
      },
    }),
    db.manualRevenue.findMany({ where: { receivedAt: range } }),
  ]);
  const lines: CashLineDto[] = [
    ...payments.map(
      (x): CashLineDto => ({
        id: x.id,
        date: dayOf(x.receivedAt),
        source: 'COBRANCA',
        description:
          (x.amountCents < 0 ? (x.refund ? 'Reembolso: ' : 'Estorno: ') : '') +
          x.receivable.description,
        party: x.receivable.customer.name,
        category: 'Serviços',
        method: x.method,
        amountCents: x.amountCents,
        reference: receivableCode(x.receivable.number),
        manual: false,
        cancelled: false,
      }),
    ),
    ...manual.map(
      (m): CashLineDto => ({
        id: m.id,
        date: dayOf(m.receivedAt),
        source: 'RECEITA_AVULSA',
        description: m.description,
        party: null,
        category: m.category,
        method: m.method,
        amountCents: m.amountCents,
        reference: null,
        manual: true,
        cancelled: Boolean(m.cancelledAt),
      }),
    ),
  ];
  return ledger(p.from, p.to, lines);
}

export async function cashOut(db: Db, q: { from?: string; to?: string }): Promise<CashLedgerDto> {
  const p = period(q, await shopTimezone(db));
  const range = { gte: p.fromDate, lte: p.toDate };
  const [payables, labor] = await Promise.all([
    db.payablePayment.findMany({
      where: { paidAt: range },
      include: {
        reversal: { select: { id: true } },
        payable: {
          select: {
            number: true,
            beneficiary: true,
            category: true,
            description: true,
            notes: true,
            expense: { select: { id: true } },
            logisticsCost: { select: { id: true } },
          },
        },
      },
    }),
    db.professionalPayment.findMany({
      where: { paidAt: range },
      include: {
        reversal: { select: { id: true } },
        payable: {
          select: {
            number: true,
            service: true,
            professional: { select: { displayName: true } },
          },
        },
      },
    }),
  ]);
  const lines: CashLineDto[] = [
    ...payables.map(
      (x): CashLineDto => ({
        id: x.id,
        date: dayOf(x.paidAt),
        source: x.payable.expense
          ? 'GASTO_FIXO'
          : x.payable.logisticsCost
            ? 'LOGISTICA'
            : x.payable.notes === MANUAL_EXPENSE_NOTE
              ? 'DESPESA_AVULSA'
              : 'CONTA',
        description: x.payable.description,
        party: x.payable.beneficiary,
        category: x.payable.category,
        method: x.method,
        amountCents: x.amountCents,
        reference: payableCode(x.payable.number),
        manual: false,
        cancelled: Boolean(x.reversal),
      }),
    ),
    ...labor.map(
      (x): CashLineDto => ({
        id: x.id,
        date: dayOf(x.paidAt),
        source: 'MAO_DE_OBRA',
        description: x.payable.service,
        party: x.payable.professional.displayName,
        category: 'Mão de obra',
        method: x.method,
        amountCents: x.amountCents,
        reference: productionPayableCode(x.payable.number),
        manual: false,
        cancelled: Boolean(x.reversal),
      }),
    ),
  ];
  return ledger(p.from, p.to, lines);
}

const periodQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function cashLedgerRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/finance/cash-in', { config: { access: FIN_VIEW } }, async (request) =>
    cashIn(prisma, periodQuery.parse(request.query)),
  );
  app.get('/api/v1/finance/cash-out', { config: { access: FIN_VIEW } }, async (request) =>
    cashOut(prisma, periodQuery.parse(request.query)),
  );

  /** Incluir despesa: uma conta já paga (aparece também em A pagar, como paga). */
  app.post(
    '/api/v1/finance/cash-out',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = manualExpenseSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await assertCategory(tx, input.category, 'payable');
        const p = await createPayable(tx, actor, {
          beneficiary: input.beneficiary,
          category: input.category,
          description: input.description,
          amountCents: input.amountCents,
          dueDate: input.date,
          notes: MANUAL_EXPENSE_NOTE,
        });
        await payPayable(tx, actor, p.id, {
          amountCents: input.amountCents,
          paidAt: input.date,
          method: input.method,
          note: input.notes ?? null,
          version: p.version,
        });
      });
      return reply.status(201).send(await cashOut(prisma, { from: input.date, to: input.date }));
    },
  );

  /** Incluir receita: dinheiro que entrou fora das cobranças de pedido. */
  app.post(
    '/api/v1/finance/cash-in',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = manualRevenueSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const r = await tx.manualRevenue.create({
          data: {
            receivedAt: parseDate(input.date),
            description: input.description,
            category: input.category,
            amountCents: input.amountCents,
            method: input.method,
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'finance.manual_revenue_created',
          entityType: 'manual_revenue',
          entityId: r.id,
          summary: `Receita avulsa: ${input.description} — ${(input.amountCents / 100).toFixed(2)}.`,
        });
      });
      return reply.status(201).send(await cashIn(prisma, { from: input.date, to: input.date }));
    },
  );

  app.post(
    '/api/v1/finance/cash-in/:id/cancel',
    { config: { access: FIN_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = manualRevenueCancelSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const r = await tx.manualRevenue.findUnique({ where: { id } });
        if (!r) throw Errors.notFound('Receita');
        if (r.cancelledAt) throw Errors.business('Receita já cancelada.');
        await tx.manualRevenue.update({
          where: { id },
          data: { cancelledAt: new Date(), cancelReason: input.reason },
        });
        await audit(tx, actor, {
          action: 'finance.manual_revenue_cancelled',
          entityType: 'manual_revenue',
          entityId: id,
          summary: `Receita avulsa cancelada: ${r.description} — ${input.reason}`,
        });
      });
      return { ok: true };
    },
  );
}
