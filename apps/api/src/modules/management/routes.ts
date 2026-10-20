import {
  MATERIALS_PENDING_STATES,
  closingWeekStart,
  deliveryCode,
  measurementCode,
  zonedDateTime,
  type OverviewDto,
  type ServiceTimelineDto,
  type TimelineDomain,
  type TimelineEntryDto,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { Errors } from '../../lib/errors';
import { dbDate } from '../attendance/common';
import { orderCode, pickupCode, receiptCode, serviceOrderCode } from '../commercial/common';
import { deadlineCalendar, deadlineCandidatesWhere, serviceDeadlines } from '../deadlines/service';
import { buildClosingItems, summarize } from '../finance/closing';
import { shopTimezone } from '../finance/common';
import { dueContext, dueOf } from '../finance/revenue';
import { idParams } from '../presenters';
import { DELIVERED_ITEM } from '../quality/common';

const FINAL_STAGES = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];
const OPEN_RECEIVABLE = ['ABERTO', 'PARCIAL'];
const STAGE_GROUP: Record<string, keyof NonNullable<OverviewDto['operations']>['pieces']> = {
  EM_PRODUCAO: 'production',
  AGUARDANDO_INSPECAO: 'quality',
  EM_INSPECAO: 'quality',
  EM_CORRECAO: 'rework',
  AGUARDANDO_EMBALAGEM: 'packaging',
  EM_EMBALAGEM: 'packaging',
  BLOQUEIO_EXPEDICAO: 'blocked',
  PRONTA_ENTREGA: 'ready',
  ENTREGA_AGENDADA: 'scheduled',
  EM_TRANSPORTE: 'inTransit',
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Quem pode abrir o Início gerencial (cada seção ainda exige a permissão do seu domínio). */
const OVERVIEW = {
  session: 'WEB',
  anyPermissions: ['os.ver', 'entregas.ver', 'entregas.gerenciar', 'financeiro.ver'],
} as const;

/**
 * Fase 10 (plano principal) — Início do gestor e linha do tempo do serviço. Só leitura; tudo vem
 * das fontes canônicas (motor de prazos, etapa gravada da peça, prontidão de materiais,
 * entregas, cobranças/contas a pagar/mão de obra). Nenhum número é inventado: seção sem
 * permissão volta `null`.
 */
export async function managementRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/management/overview', { config: { access: OVERVIEW } }, async (request) => {
    const perms = request.auth!.permissions;
    const cal = await deadlineCalendar(prisma);
    const active = {
      status: 'ABERTA' as const,
      items: { some: { fulfillmentStage: { notIn: FINAL_STAGES } } },
    };
    let operations: OverviewDto['operations'] = null;
    if (perms.has('os.ver')) {
      const [activeServiceOrders, awaitingMaterials, stages, states] = await Promise.all([
        prisma.serviceOrder.count({ where: active }),
        prisma.serviceOrder.count({
          where: { ...active, materialsReadiness: { in: [...MATERIALS_PENDING_STATES] } },
        }),
        prisma.serviceOrderItem.groupBy({
          by: ['fulfillmentStage'],
          where: { serviceOrder: { status: 'ABERTA' }, fulfillmentStage: { notIn: FINAL_STAGES } },
          _count: true,
        }),
        serviceDeadlines(prisma, deadlineCandidatesWhere(cal), cal),
      ]);
      const pieces = {
        production: 0,
        quality: 0,
        rework: 0,
        packaging: 0,
        blocked: 0,
        ready: 0,
        scheduled: 0,
        inTransit: 0,
      };
      for (const s of stages) {
        const g = STAGE_GROUP[s.fulfillmentStage];
        if (g) pieces[g] += s._count;
      }
      const deadlines = { late: 0, atRisk: 0, soon: 0 };
      for (const d of states.values()) {
        if (d.state === 'ATRASADO') deadlines.late += 1;
        else if (d.state === 'EM_RISCO') deadlines.atRisk += 1;
        else if (d.state === 'PROXIMO') deadlines.soon += 1;
      }
      operations = { activeServiceOrders, deadlines, awaitingMaterials, pieces };
    }

    let deliveries: OverviewDto['deliveries'] = null;
    if (perms.has('entregas.ver') || perms.has('entregas.gerenciar')) {
      const tz = await shopTimezone(prisma);
      const [upcoming, frustrated, deliveredToday] = await Promise.all([
        prisma.delivery.count({
          where: {
            status: 'AGENDADA',
            scheduledDate: { gte: dbDate(cal.today), lte: dbDate(addDays(cal.today, 2)) },
          },
        }),
        prisma.delivery.count({ where: { status: 'FRUSTRADA' } }),
        // F10-21m: peças entregues (regra canônica) em entregas concluídas hoje — o mesmo "hoje"
        // da oficina das entregas próximas, com os limites na meia-noite local.
        prisma.deliveryItem.count({
          where: {
            ...DELIVERED_ITEM,
            delivery: {
              ...DELIVERED_ITEM.delivery,
              completedAt: {
                gte: zonedDateTime(cal.today, '00:00', tz),
                lt: zonedDateTime(addDays(cal.today, 1), '00:00', tz),
              },
            },
          },
        }),
      ]);
      deliveries = { upcoming, frustrated, deliveredToday };
    }

    let finance: OverviewDto['finance'] = null;
    if (perms.has('financeiro.ver')) {
      const open = await prisma.customerReceivable.findMany({
        where: { status: { in: OPEN_RECEIVABLE }, order: { status: { not: 'CANCELADO' } } },
      });
      const ctx = await dueContext(
        prisma,
        open.map((r) => r.orderId),
      );
      const receivables = { openCents: 0, overdueCents: 0, overdueCount: 0 };
      for (const r of open) {
        const d = dueOf(r, ctx);
        receivables.openCents += d.openCents;
        if (d.overdue) {
          receivables.overdueCents += d.openCents;
          receivables.overdueCount += 1;
        }
      }
      const [payableRows, laborRows, valueRequests, laborReviews, paymentReports] =
        await Promise.all([
          prisma.accountPayable.findMany({
            where: { status: { in: OPEN_RECEIVABLE } },
            select: { amountCents: true, paidCents: true, dueDate: true },
          }),
          prisma.productionPayable.findMany({
            where: { status: { in: ['LIBERADO', 'PAGO_PARCIAL'] } },
            select: { agreedCents: true, adjustmentsCents: true, paidCents: true },
          }),
          prisma.valueChangeRequest.count({ where: { status: 'PENDENTE' } }),
          prisma.laborReview.count({ where: { status: 'ABERTA' } }),
          prisma.customerPaymentReport.count({ where: { status: 'PENDENTE' } }),
        ]);
      const payables = { openCents: 0, overdueCents: 0 };
      for (const p of payableRows) {
        const left = Math.max(0, p.amountCents - p.paidCents);
        payables.openCents += left;
        if (p.dueDate.toISOString().slice(0, 10) < ctx.today) payables.overdueCents += left;
      }
      const laborDueCents = laborRows.reduce(
        (a, p) => a + Math.max(0, p.agreedCents + p.adjustmentsCents - p.paidCents),
        0,
      );
      // F10-21s: "Pago na semana" do Fechamento semanal corrente (mesma fonte e mesma soma).
      const weekStart = closingWeekStart(cal.today);
      const { totals } = await summarize(
        prisma,
        (await buildClosingItems(prisma, weekStart)).items,
      );
      finance = {
        receivables,
        payables,
        laborDueCents,
        paid: { weekStart, paidInWeekCents: totals.paidInWeekCents },
        decisions: { valueRequests, laborReviews, paymentReports },
      };
    }

    return {
      generatedAt: new Date().toISOString(),
      today: cal.today,
      operations,
      deliveries,
      finance,
    } satisfies OverviewDto;
  });

  /**
   * Linha do tempo do serviço: visão composta sobre os históricos canônicos (pedido, retirada,
   * recebimento, OS, medição, produção, qualidade, entrega e — para quem vê o financeiro — a
   * cobrança). Nada novo é gravado; cada evento continua na sua tabela imutável.
   */
  app.get(
    '/api/v1/service-orders/:id/timeline',
    { config: { access: { session: 'WEB', permissions: ['os.ver'] } } },
    async (request): Promise<ServiceTimelineDto> => {
      const { id } = idParams.parse(request.params);
      const finance = request.auth!.permissions.has('financeiro.ver');
      const so = await prisma.serviceOrder.findUnique({
        where: { id },
        include: {
          order: { select: { id: true, number: true, createdAt: true } },
          items: { select: { id: true } },
        },
      });
      if (!so) throw Errors.notFound('Ordem de serviço');
      const itemIds = so.items.map((i) => i.id);
      const orderId = so.orderId;
      const LIMIT = 400;
      const take = LIMIT;
      const [
        pickups,
        receipts,
        revisions,
        measurements,
        tasks,
        quality,
        deliveries,
        receivableEvents,
        audits,
      ] = await Promise.all([
        orderId
          ? prisma.pickupEvent.findMany({
              where: { pickup: { orderId } },
              include: { pickup: { select: { number: true } } },
              orderBy: { occurredAt: 'desc' },
              take,
            })
          : [],
        orderId
          ? prisma.receipt.findMany({
              where: { orderId },
              orderBy: { receivedAt: 'desc' },
              take,
            })
          : [],
        prisma.serviceOrderRevision.findMany({
          where: { serviceOrderId: id },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.measurementRevision.findMany({
          where: { measurement: { serviceOrderId: id } },
          include: { measurement: { select: { number: true } } },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.productionTaskEvent.findMany({
          where: { task: { serviceOrderId: id } },
          include: { task: { select: { number: true, title: true } } },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.qualityEvent.findMany({
          where: { serviceOrderItemId: { in: itemIds } },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        prisma.deliveryEvent.findMany({
          where: { delivery: { items: { some: { serviceOrderItemId: { in: itemIds } } } } },
          include: { delivery: { select: { number: true } } },
          orderBy: { createdAt: 'desc' },
          take,
        }),
        finance && orderId
          ? prisma.financialEvent.findMany({
              where: {
                entityType: 'customer_receivable',
                entityId: {
                  in: (
                    await prisma.customerReceivable.findMany({
                      where: { orderId },
                      select: { id: true },
                    })
                  ).map((r) => r.id),
                },
              },
              orderBy: { createdAt: 'desc' },
              take,
            })
          : [],
        prisma.auditLog.findMany({
          where: {
            entityId: { in: [id, ...(orderId ? [orderId] : [])] },
            ...(finance ? {} : { NOT: { action: { startsWith: 'finance.' } } }),
          },
          orderBy: { createdAt: 'desc' },
          take,
        }),
      ]);
      const actorIds = [
        ...new Set(
          [
            ...pickups.map((e) => e.recordedById),
            ...receipts.map((r) => r.registeredById),
            ...revisions.map((r) => r.changedById),
            ...measurements.map((m) => m.actorId),
            ...tasks.map((t) => t.actorId),
            ...quality.map((q) => q.actorId),
            ...deliveries.map((d) => d.actorId),
            ...receivableEvents.map((f) => f.actorId),
            ...audits.map((a) => a.actorUserId),
          ].filter((x): x is string => Boolean(x)),
        ),
      ];
      const users = await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, displayName: true },
      });
      const name = new Map(users.map((u) => [u.id, u.displayName]));
      const who = (uid: string | null | undefined) => (uid ? (name.get(uid) ?? null) : null);
      const entries: TimelineEntryDto[] = [];
      const push = (
        at: Date,
        domain: TimelineDomain,
        kind: string,
        title: string,
        note: string | null,
        actor: string | null,
      ) => entries.push({ at: at.toISOString(), domain, kind, title, note, actor });
      if (so.order) push(so.order.createdAt, 'PEDIDO', 'CRIADO', 'Pedido registrado', null, null);
      for (const e of pickups)
        push(
          e.occurredAt,
          'RETIRADA',
          e.kind,
          `Retirada ${pickupCode(e.pickup.number)}${e.toStatus ? ` → ${e.toStatus}` : ''}`,
          e.note,
          who(e.recordedById),
        );
      for (const r of receipts)
        push(
          r.receivedAt,
          'RECEBIMENTO',
          'RECEBIDO',
          `Recebimento ${receiptCode(r.number)}`,
          r.notes,
          who(r.registeredById),
        );
      for (const r of revisions)
        push(r.createdAt, 'OS', r.scope, `OS · ${r.scope}`, r.reason, who(r.changedById));
      for (const m of measurements)
        push(
          m.createdAt,
          'MEDICAO',
          m.kind,
          `Medição ${measurementCode(m.measurement.number)} · ${m.kind}`,
          m.note,
          who(m.actorId),
        );
      for (const t of tasks)
        push(
          t.createdAt,
          'PRODUCAO',
          t.kind,
          `${t.task.title} · ${t.kind}${t.toStatus ? ` → ${t.toStatus}` : ''}`,
          t.note,
          who(t.actorId),
        );
      for (const q of quality)
        push(q.createdAt, 'QUALIDADE', q.kind, `Qualidade · ${q.kind}`, q.note, who(q.actorId));
      for (const d of deliveries)
        push(
          d.createdAt,
          'ENTREGA',
          d.kind,
          `Entrega ${deliveryCode(d.delivery.number)} · ${d.kind}`,
          d.note,
          who(d.actorId),
        );
      for (const f of receivableEvents)
        push(f.createdAt, 'FINANCEIRO', f.kind, `Cobrança · ${f.kind}`, f.note, who(f.actorId));
      for (const a of audits)
        push(a.createdAt, 'AUDITORIA', a.action, a.summary, null, who(a.actorUserId));
      entries.sort((a, b) => a.at.localeCompare(b.at));
      const truncated = entries.length > LIMIT;
      return {
        serviceOrder: { id: so.id, code: serviceOrderCode(so.number) },
        order: so.order ? { id: so.order.id, code: orderCode(so.order.number) } : null,
        entries: truncated ? entries.slice(entries.length - LIMIT) : entries,
        truncated,
      };
    },
  );
}
