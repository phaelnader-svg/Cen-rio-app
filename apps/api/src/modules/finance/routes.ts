import { randomUUID } from 'node:crypto';
import {
  cancelFinanceSchema,
  commercialAdjustmentSchema,
  createLaborSchema,
  createPayableSchema,
  createReceivableSchema,
  expenseSchema,
  financeSettingsSchema,
  generateRecurringSchema,
  laborAdjustmentSchema,
  laborQuerySchema,
  logisticsCostSchema,
  manualCostSchema,
  payLaborSchema,
  payPayableSchema,
  periodQuerySchema,
  receivableQuerySchema,
  receivePaymentSchema,
  recurringExpenseSchema,
  reportQuerySchema,
  revenueSplitSchema,
  reversePaymentSchema,
  teamCostSchema,
  toCsv,
  EVENT_TYPES,
  type ExpenseCategory,
  type RecurringExpenseDto,
  type TeamCostDto,
} from '@cenario/shared';
import type { Prisma } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { workers } from '../production/plans';
import {
  FIN_ADJUST,
  FIN_MANAGE,
  FIN_OWN,
  FIN_VIEW,
  checkVersion,
  dateOnly,
  financeEvent,
  lockRow,
  parseDate,
  period,
} from './common';
import { syncMaterialCosts } from './costs';
import {
  adjustLabor,
  cancelLabor,
  createLabor,
  laborInclude,
  myProduction,
  payLabor,
  refreshLaborOf,
  toLaborDto,
} from './labor';
import {
  cancelExpense,
  cancelLogisticsCost,
  cancelPayable,
  createExpense,
  createLogisticsCost,
  createPayable,
  expenseInclude,
  generateRecurring,
  logisticsInclude,
  payPayable,
  payableInclude,
  toExpenseDto,
  toLogisticsDto,
  toPayableDto,
  upsertTeamCost,
} from './payables';
import { REPORTS, buildReport } from './reports';
// Registra a reação ao cancelamento de OS (valores de produção) — Fase 12.
import './withdrawal';
import { dashboard, orderResult, productivity, taxRate } from './results';
import {
  addCommercialAdjustment,
  cancelReceivable,
  createReceivable,
  orderRevenueDto,
  receivableInclude,
  receivePayment,
  reversePayment,
  setRevenueSplit,
  toReceivableDto,
} from './revenue';

const paymentParams = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() });
const reportParams = z.object({ kind: z.enum(REPORTS) });
const payableQuerySchema = periodQuerySchema.extend({
  status: z.string().max(60).optional(),
  category: z.string().max(30).optional(),
});
const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

/**
 * Fase 11 — financeiro operacional (API v1). Tudo exige a sessão do painel e as permissões do
 * financeiro, exceto "meus valores de produção" (o próprio tapeceiro, se autorizado). Não há
 * integração bancária: recebimentos e pagamentos são apenas registrados.
 */
export async function financeRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(fn, { timeout: 30_000 });

  // ─────────────────────────── Configuração ───────────────────────────

  app.get('/api/v1/finance/settings', { config: { access: FIN_VIEW } }, async () => ({
    taxRateBps: await taxRate(prisma),
  }));

  app.put('/api/v1/finance/settings', { config: { access: FIN_ADJUST } }, async (request) => {
    const input = financeSettingsSchema.parse(request.body);
    return tx(async (t) => {
      const before = await taxRate(t);
      await t.companySettings.update({ where: { id: 1 }, data: { taxRateBps: input.taxRateBps } });
      await audit(t, actorFrom(request), {
        action: 'finance.settings',
        entityType: 'company_settings',
        entityId: '1',
        summary: 'Alíquota de tributos estimados alterada.',
        changes: { taxRateBps: { from: before, to: input.taxRateBps } },
      });
      return { taxRateBps: input.taxRateBps };
    });
  });

  /** Pessoas para combinar valores (tapeceiros) e custos mensais (equipe fixa). */
  app.get('/api/v1/finance/people', { config: { access: FIN_VIEW } }, async () => workers(prisma));

  // ─────────────────────────── Receita por pedido / OS ───────────────────────────

  app.get('/api/v1/finance/orders', { config: { access: FIN_VIEW } }, async (request) => {
    const q = z
      .object({ search: z.string().max(100).optional(), open: z.enum(['1', '0']).optional() })
      .parse(request.query);
    const orders = await prisma.commercialOrder.findMany({
      where: {
        status: { not: 'CANCELADO' },
        ...(q.search ? { customer: { name: { contains: q.search, mode: 'insensitive' } } } : {}),
      },
      orderBy: { number: 'desc' },
      take: 200,
      select: { id: true },
    });
    const rows = await Promise.all(orders.map((o) => orderRevenueDto(prisma, o.id)));
    return q.open === '1' ? rows.filter((r) => r.financialStatus !== 'QUITADO') : rows;
  });

  app.get('/api/v1/finance/orders/:id', { config: { access: FIN_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return orderRevenueDto(prisma, id);
  });

  app.post(
    '/api/v1/finance/orders/:id/adjustments',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = commercialAdjustmentSchema.parse(request.body);
      await tx((t) => addCommercialAdjustment(t, actorFrom(request), id, input));
      return orderRevenueDto(prisma, id);
    },
  );

  app.put(
    '/api/v1/finance/orders/:id/revenue-split',
    { config: { access: FIN_ADJUST } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = revenueSplitSchema.parse(request.body);
      await tx((t) => setRevenueSplit(t, actorFrom(request), id, input));
      return orderRevenueDto(prisma, id);
    },
  );

  // ─────────────────────────── Contas a receber ───────────────────────────

  app.get('/api/v1/finance/receivables', { config: { access: FIN_VIEW } }, async (request) => {
    const q = receivableQuerySchema.parse(request.query);
    const rows = await prisma.customerReceivable.findMany({
      where: {
        ...(q.status ? { status: { in: q.status.split(',') } } : {}),
        ...(q.orderId ? { orderId: q.orderId } : {}),
        ...(q.from ? { dueDate: { gte: parseDate(q.from) } } : {}),
        ...(q.to
          ? { dueDate: { ...(q.from ? { gte: parseDate(q.from) } : {}), lte: parseDate(q.to) } }
          : {}),
      },
      include: receivableInclude,
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      take: 300,
    });
    return Promise.all(rows.map((r) => toReceivableDto(prisma, r)));
  });

  const receivableDto = async (id: string) =>
    toReceivableDto(
      prisma,
      await prisma.customerReceivable.findUniqueOrThrow({
        where: { id },
        include: receivableInclude,
      }),
    );

  app.get('/api/v1/finance/receivables/:id', { config: { access: FIN_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!(await prisma.customerReceivable.count({ where: { id } })))
      throw Errors.notFound('Conta a receber');
    return receivableDto(id);
  });

  app.post(
    '/api/v1/finance/receivables',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createReceivableSchema.parse(request.body);
      const row = await tx((t) => createReceivable(t, actorFrom(request), input));
      return reply.status(201).send(await receivableDto(row.id));
    },
  );

  app.post(
    '/api/v1/finance/receivables/:id/payments',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = receivePaymentSchema.parse(request.body);
      await tx((t) => receivePayment(t, actorFrom(request), id, input));
      return receivableDto(id);
    },
  );

  app.post(
    '/api/v1/finance/receivables/:id/payments/:paymentId/reverse',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id, paymentId } = paymentParams.parse(request.params);
      const input = reversePaymentSchema.parse(request.body);
      const pay = await prisma.customerPayment.findUnique({ where: { id: paymentId } });
      if (!pay || pay.receivableId !== id) throw Errors.notFound('Recebimento');
      await tx((t) => reversePayment(t, actorFrom(request), paymentId, input.reason));
      return receivableDto(id);
    },
  );

  app.post(
    '/api/v1/finance/receivables/:id/cancel',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelFinanceSchema.parse(request.body);
      await tx((t) => cancelReceivable(t, actorFrom(request), id, input));
      return receivableDto(id);
    },
  );

  // ─────────────────────────── Contas a pagar ───────────────────────────

  const payableDto = async (id: string) =>
    toPayableDto(
      prisma,
      await prisma.accountPayable.findUniqueOrThrow({ where: { id }, include: payableInclude }),
    );

  app.get('/api/v1/finance/payables', { config: { access: FIN_VIEW } }, async (request) => {
    const q = payableQuerySchema.parse(request.query);
    const due: Prisma.DateTimeFilter = {};
    if (q.from) due.gte = parseDate(q.from);
    if (q.to) due.lte = parseDate(q.to);
    const rows = await prisma.accountPayable.findMany({
      where: {
        ...(q.status ? { status: { in: q.status.split(',') } } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.from || q.to ? { dueDate: due } : {}),
      },
      include: payableInclude,
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      take: 300,
    });
    return Promise.all(rows.map((r) => toPayableDto(prisma, r)));
  });

  app.get('/api/v1/finance/payables/:id', { config: { access: FIN_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!(await prisma.accountPayable.count({ where: { id } })))
      throw Errors.notFound('Conta a pagar');
    return payableDto(id);
  });

  app.post(
    '/api/v1/finance/payables',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createPayableSchema.parse(request.body);
      const row = await tx((t) => createPayable(t, actorFrom(request), input));
      return reply.status(201).send(await payableDto(row.id));
    },
  );

  app.post(
    '/api/v1/finance/payables/:id/payments',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = payPayableSchema.parse(request.body);
      await tx((t) => payPayable(t, actorFrom(request), id, input));
      return payableDto(id);
    },
  );

  app.post(
    '/api/v1/finance/payables/:id/cancel',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelFinanceSchema.parse(request.body);
      await tx((t) => cancelPayable(t, actorFrom(request), id, input));
      return payableDto(id);
    },
  );

  // ─────────────────────────── Mão de obra por produção ───────────────────────────

  const laborDto = async (id: string) =>
    toLaborDto(
      prisma,
      await prisma.productionPayable.findUniqueOrThrow({ where: { id }, include: laborInclude }),
    );

  app.get('/api/v1/finance/labor', { config: { access: FIN_VIEW } }, async (request) => {
    const q = laborQuerySchema.parse(request.query);
    const where: Prisma.ProductionPayableWhereInput = {
      ...(q.status ? { status: { in: q.status.split(',') } } : {}),
      ...(q.professionalUserId ? { professionalUserId: q.professionalUserId } : {}),
      ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
    };
    await tx((t) =>
      refreshLaborOf(t, actorFrom(request), { ...where, status: { in: ['PREVISTO', 'LIBERADO'] } }),
    );
    const rows = await prisma.productionPayable.findMany({
      where,
      include: laborInclude,
      orderBy: { number: 'desc' },
      take: 300,
    });
    return Promise.all(rows.map((r) => toLaborDto(prisma, r)));
  });

  app.get('/api/v1/finance/labor/:id', { config: { access: FIN_VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!(await prisma.productionPayable.count({ where: { id } })))
      throw Errors.notFound('Valor de produção');
    await tx((t) => refreshLaborOf(t, actorFrom(request), { id }));
    return laborDto(id);
  });

  app.post(
    '/api/v1/finance/labor',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createLaborSchema.parse(request.body);
      const row = await tx((t) => createLabor(t, actorFrom(request), input));
      return reply.status(201).send(await laborDto(row.id));
    },
  );

  app.post(
    '/api/v1/finance/labor/:id/adjustments',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = laborAdjustmentSchema.parse(request.body);
      await tx((t) => adjustLabor(t, actorFrom(request), id, input));
      return laborDto(id);
    },
  );

  app.post(
    '/api/v1/finance/labor/:id/payments',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = payLaborSchema.parse(request.body);
      await tx((t) => payLabor(t, actorFrom(request), id, input));
      return laborDto(id);
    },
  );

  app.post(
    '/api/v1/finance/labor/:id/cancel',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelFinanceSchema.parse(request.body);
      await tx((t) => cancelLabor(t, actorFrom(request), id, input));
      return laborDto(id);
    },
  );

  /** Ricardo/Márcio: só os próprios valores, e só com autorização do gestor. */
  app.get('/api/v1/finance/my-production', { config: { access: FIN_OWN } }, async (request) => {
    const userId = request.auth!.userId;
    await tx((t) =>
      refreshLaborOf(t, actorFrom(request), {
        professionalUserId: userId,
        status: { in: ['PREVISTO', 'LIBERADO'] },
      }),
    );
    return myProduction(prisma, userId);
  });

  // ─────────────────────────── Equipe de remuneração fixa ───────────────────────────

  const teamDto = (
    r: Prisma.TeamMonthlyCostGetPayload<{ include: { user: true } }>,
  ): TeamCostDto => ({
    id: r.id,
    user: { userId: r.userId, displayName: r.user.displayName },
    month: dateOnly(r.month)!.slice(0, 7),
    amountCents: r.amountCents,
    notes: r.notes,
    version: r.version,
  });

  app.get('/api/v1/finance/team-costs', { config: { access: FIN_VIEW } }, async (request) => {
    const q = monthQuerySchema.parse(request.query);
    const rows = await prisma.teamMonthlyCost.findMany({
      where: q.month ? { month: parseDate(`${q.month}-01`) } : {},
      include: { user: true },
      orderBy: [{ month: 'desc' }],
      take: 200,
    });
    return rows.map(teamDto);
  });

  app.put('/api/v1/finance/team-costs', { config: { access: FIN_MANAGE } }, async (request) => {
    const input = teamCostSchema.parse(request.body);
    const row = await tx((t) => upsertTeamCost(t, actorFrom(request), input));
    return teamDto(
      await prisma.teamMonthlyCost.findUniqueOrThrow({
        where: { id: row.id },
        include: { user: true },
      }),
    );
  });

  // ─────────────────────────── Custos logísticos ───────────────────────────

  app.get('/api/v1/finance/logistics-costs', { config: { access: FIN_VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    const date: Prisma.DateTimeFilter = {};
    if (q.from) date.gte = parseDate(q.from);
    if (q.to) date.lte = parseDate(q.to);
    const rows = await prisma.logisticsCost.findMany({
      where: q.from || q.to ? { date } : {},
      include: logisticsInclude,
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
      take: 300,
    });
    return rows.map(toLogisticsDto);
  });

  app.post(
    '/api/v1/finance/logistics-costs',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = logisticsCostSchema.parse(request.body);
      const row = await tx((t) => createLogisticsCost(t, actorFrom(request), input));
      return reply.status(201).send(
        toLogisticsDto(
          await prisma.logisticsCost.findUniqueOrThrow({
            where: { id: row.id },
            include: logisticsInclude,
          }),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/logistics-costs/:id/cancel',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelFinanceSchema.parse(request.body);
      await tx((t) => cancelLogisticsCost(t, actorFrom(request), id, input));
      return toLogisticsDto(
        await prisma.logisticsCost.findUniqueOrThrow({ where: { id }, include: logisticsInclude }),
      );
    },
  );

  // ─────────────────────────── Despesas operacionais ───────────────────────────

  app.get('/api/v1/finance/expenses', { config: { access: FIN_VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    const p = period(q);
    const rows = await prisma.operationalExpense.findMany({
      where: { competence: { gte: parseDate(`${p.from.slice(0, 7)}-01`), lte: p.toDate } },
      include: expenseInclude,
      orderBy: [{ competence: 'desc' }, { number: 'desc' }],
      take: 300,
    });
    return rows.map(toExpenseDto);
  });

  app.post(
    '/api/v1/finance/expenses',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = expenseSchema.parse(request.body);
      const row = await tx((t) => createExpense(t, actorFrom(request), input));
      return reply.status(201).send(
        toExpenseDto(
          await prisma.operationalExpense.findUniqueOrThrow({
            where: { id: row.id },
            include: expenseInclude,
          }),
        ),
      );
    },
  );

  app.post(
    '/api/v1/finance/expenses/:id/cancel',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelFinanceSchema.parse(request.body);
      await tx((t) => cancelExpense(t, actorFrom(request), id, input));
      return toExpenseDto(
        await prisma.operationalExpense.findUniqueOrThrow({
          where: { id },
          include: expenseInclude,
        }),
      );
    },
  );

  const recurringDto = (r: Prisma.RecurringExpenseGetPayload<object>): RecurringExpenseDto => ({
    id: r.id,
    category: r.category as ExpenseCategory,
    description: r.description,
    amountCents: r.amountCents,
    dayOfMonth: r.dayOfMonth,
    beneficiary: r.beneficiary,
    startMonth: dateOnly(r.startMonth)!.slice(0, 7),
    endMonth: r.endMonth ? dateOnly(r.endMonth)!.slice(0, 7) : null,
    active: r.active,
    version: r.version,
  });

  app.get('/api/v1/finance/recurring-expenses', { config: { access: FIN_VIEW } }, async () =>
    (
      await prisma.recurringExpense.findMany({
        orderBy: [{ active: 'desc' }, { description: 'asc' }],
      })
    ).map(recurringDto),
  );

  app.post(
    '/api/v1/finance/recurring-expenses',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = recurringExpenseSchema.parse(request.body);
      if (input.endMonth && input.endMonth < input.startMonth)
        throw Errors.validation(undefined, 'O fim da recorrência é anterior ao início.');
      const row = await tx(async (t) => {
        const r = await t.recurringExpense.create({
          data: {
            category: input.category,
            description: input.description,
            amountCents: input.amountCents,
            dayOfMonth: input.dayOfMonth,
            beneficiary: input.beneficiary,
            startMonth: parseDate(`${input.startMonth}-01`),
            endMonth: input.endMonth ? parseDate(`${input.endMonth}-01`) : null,
            active: input.active,
          },
        });
        await audit(t, actorFrom(request), {
          action: 'finance.recurring_created',
          entityType: 'recurring_expense',
          entityId: r.id,
          summary: `Despesa recorrente "${r.description}" cadastrada.`,
        });
        await financeEvent(t, actorFrom(request), {
          entityType: 'recurring_expense',
          entityId: r.id,
          kind: 'CADASTRADA',
          data: { amountCents: r.amountCents, dayOfMonth: r.dayOfMonth },
        });
        return r;
      });
      return reply.status(201).send(recurringDto(row));
    },
  );

  app.put(
    '/api/v1/finance/recurring-expenses/:id',
    { config: { access: FIN_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = recurringExpenseSchema.parse(request.body);
      if (input.version === undefined) throw Errors.validation(undefined, 'Versão obrigatória.');
      if (input.endMonth && input.endMonth < input.startMonth)
        throw Errors.validation(undefined, 'O fim da recorrência é anterior ao início.');
      const row = await tx(async (t) => {
        await lockRow(t, 'recurring_expenses', id, 'Despesa recorrente');
        const cur = await t.recurringExpense.findUniqueOrThrow({ where: { id } });
        checkVersion(cur, input.version!);
        // Alterar o modelo não muda despesas já geradas (histórico preservado).
        const r = await t.recurringExpense.update({
          where: { id },
          data: {
            category: input.category,
            description: input.description,
            amountCents: input.amountCents,
            dayOfMonth: input.dayOfMonth,
            beneficiary: input.beneficiary,
            startMonth: parseDate(`${input.startMonth}-01`),
            endMonth: input.endMonth ? parseDate(`${input.endMonth}-01`) : null,
            active: input.active,
            version: { increment: 1 },
          },
        });
        await audit(t, actorFrom(request), {
          action: 'finance.recurring_updated',
          entityType: 'recurring_expense',
          entityId: id,
          summary: `Despesa recorrente "${r.description}" alterada.`,
          changes: {
            amountCents: { from: cur.amountCents, to: r.amountCents },
            active: { from: cur.active, to: r.active },
          },
        });
        await financeEvent(t, actorFrom(request), {
          entityType: 'recurring_expense',
          entityId: id,
          kind: 'ALTERADA',
          data: { from: cur.amountCents, to: r.amountCents, active: r.active },
        });
        return r;
      });
      return recurringDto(row);
    },
  );

  app.post(
    '/api/v1/finance/recurring-expenses/generate',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { month } = generateRecurringSchema.parse(request.body);
      return tx((t) => generateRecurring(t, actorFrom(request), month));
    },
  );

  // ─────────────────────────── Custos e resultado por OS ───────────────────────────

  app.get('/api/v1/finance/service-orders', { config: { access: FIN_VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    const p = period(q);
    const sos = await prisma.serviceOrder.findMany({
      where: { status: 'ABERTA', createdAt: { lt: p.toExclusive } },
      orderBy: { number: 'desc' },
      take: 100,
      select: { id: true },
    });
    const out = [];
    for (const s of sos) {
      const r = await tx((t) => orderResult(t, actorFrom(request), s.id));
      const done =
        r.completedAt !== null &&
        r.completedAt >= p.fromTs.toISOString() &&
        r.completedAt < p.toExclusive.toISOString();
      if (done || !r.delivered) {
        const { materials, labor, logistics, ...rest } = r;
        out.push({
          ...rest,
          materials: { ...materials, lines: [] },
          labor: labor.length,
          logistics: logistics.length,
        });
      }
    }
    return out;
  });

  app.get(
    '/api/v1/finance/service-orders/:id',
    { config: { access: FIN_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      if (!(await prisma.serviceOrder.count({ where: { id } }))) throw Errors.notFound('OS');
      return tx((t) => orderResult(t, actorFrom(request), id));
    },
  );

  /** Correção/lançamento manual de custo da OS (material sem preço, outro custo variável). */
  app.post(
    '/api/v1/finance/costs',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request, reply) => {
      const input = manualCostSchema.parse(request.body);
      await tx(async (t) => {
        await lockRow(t, 'service_orders', input.serviceOrderId, 'OS');
        await syncMaterialCosts(t, actorFrom(request), input.serviceOrderId);
        const row = await t.serviceOrderCost.create({
          data: {
            serviceOrderId: input.serviceOrderId,
            category: input.category,
            source: 'AJUSTE_MANUAL',
            sourceKey: `manual:${randomUUID()}`,
            description: input.description,
            amountCents: input.amountCents,
            priced: true,
            occurredAt: new Date(),
            note: input.reason,
            actorId: request.auth!.userId,
          },
        });
        await audit(t, actorFrom(request), {
          action: 'finance.cost_adjusted',
          entityType: 'service_order',
          entityId: input.serviceOrderId,
          summary: `Custo lançado manualmente: ${input.description}.`,
          changes: {
            amountCents: { from: null, to: input.amountCents },
            reason: { from: null, to: input.reason },
          },
        });
        await financeEvent(t, actorFrom(request), {
          entityType: 'service_order',
          entityId: input.serviceOrderId,
          kind: 'CUSTO_MANUAL',
          note: `${input.description} — ${input.reason}`,
          data: { costId: row.id, amountCents: input.amountCents },
          type: EVENT_TYPES.FINANCE_COST_UPDATED,
        });
      });
      return reply
        .status(201)
        .send(await tx((t) => orderResult(t, actorFrom(request), input.serviceOrderId)));
    },
  );

  // ─────────────────────────── Painel, indicadores e relatórios ───────────────────────────

  app.get('/api/v1/finance/dashboard', { config: { access: FIN_VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    return tx((t) => dashboard(t, actorFrom(request), q));
  });

  app.get('/api/v1/finance/productivity', { config: { access: FIN_VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    return productivity(prisma, q);
  });

  app.get(
    '/api/v1/finance/reports/:kind',
    { config: { access: FIN_VIEW } },
    async (request, reply) => {
      const { kind } = reportParams.parse(request.params);
      const q = reportQuerySchema.parse(request.query);
      const p = period(q);
      const report = await tx((t) => buildReport(t, actorFrom(request), kind, q));
      if (q.format === 'csv')
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${kind}-${p.from}-a-${p.to}.csv"`)
          .send(toCsv(report.header, report.rows));
      return { kind, from: p.from, to: p.to, ...report };
    },
  );
}
