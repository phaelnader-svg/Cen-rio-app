import {
  zonedDateTime,
  consolidateMaterials,
  consolidatedToCsv,
  formatServiceOrderItemCode,
  measurementCode,
  nextWeekday,
  periodQuerySchema,
  type ConsolidatedListDto,
  type ConsolidationInput,
  type PlanningDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { parseDateOnly, serviceOrderCode } from '../commercial/common';
import { awaitingMeasurement } from '../measurements/routes';
import { summaryInclude, toSummary, todayIn } from '../measurements/service';

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const VIEW = {
  session: 'WEB',
  anyPermissions: ['materiais.ver', 'materiais.aprovar', 'medicoes.gerenciar'],
} as const;
const n = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/**
 * Necessidades APROVADAS (quantidades conferidas) de OS abertas. Aprovação não é
 * compra: "comprado" e "recebido" serão integrados na Fase 4.
 */
async function approvedInputs(
  prisma: PrismaClient,
  from?: string,
  to?: string,
): Promise<ConsolidationInput[]> {
  const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
  const tz = company?.timezone ?? 'America/Sao_Paulo';
  const rows = await prisma.materialRequirement.findMany({
    where: {
      origin: 'SOLICITACAO_APROVADA',
      serviceOrder: { status: 'ABERTA' },
      ...(from || to
        ? {
            approvedAt: {
              // Dias LOCAIS da oficina (antes: meia-noite UTC — aprovações entre 21h e 24h
              // em Brasília caíam no dia seguinte).
              ...(from ? { gte: zonedDateTime(from, '00:00', tz) } : {}),
              ...(to ? { lt: zonedDateTime(nextDay(to), '00:00', tz) } : {}),
            },
          }
        : {}),
    },
    include: {
      serviceOrder: true,
      serviceOrderItem: true,
      materialRequestItem: { include: { request: { include: { measurement: true } } } },
    },
  });
  return rows.map((r) => ({
    kind: r.kind,
    sourcing: r.sourcing,
    description: r.description,
    color: r.color,
    reference: r.reference,
    foamDensity: r.foamDensity,
    thicknessCm: n(r.thicknessCm),
    lengthCm: n(r.lengthCm),
    widthCm: n(r.widthCm),
    unit: r.unitCode!,
    quantity: Number(r.quantity),
    serviceOrder: { id: r.serviceOrderId, code: serviceOrderCode(r.serviceOrder.number) },
    itemCode: r.serviceOrderItem
      ? formatServiceOrderItemCode(r.serviceOrder.number, r.serviceOrderItem.position)
      : null,
    measurementCode: r.materialRequestItem
      ? measurementCode(r.materialRequestItem.request.measurement.number)
      : null,
  }));
}

/** Itens de solicitações enviadas/em revisão (ainda não conferidos). */
async function requestedInputs(prisma: PrismaClient): Promise<ConsolidationInput[]> {
  const rows = await prisma.materialRequestItem.findMany({
    where: {
      request: {
        status: { in: ['ENVIADA', 'EM_REVISAO'] },
        measurement: { serviceOrder: { status: 'ABERTA' } },
      },
    },
    include: {
      serviceOrderItem: true,
      request: { include: { measurement: { include: { serviceOrder: true } } } },
    },
  });
  return rows.map((r) => {
    const so = r.request.measurement.serviceOrder;
    return {
      kind: r.kind,
      sourcing: r.sourcing,
      description: r.description,
      color: r.color,
      reference: r.reference,
      foamDensity: r.foamDensity,
      thicknessCm: n(r.thicknessCm),
      lengthCm: n(r.lengthCm),
      widthCm: n(r.widthCm),
      unit: r.unit,
      quantity: Number(r.quantity),
      serviceOrder: { id: so.id, code: serviceOrderCode(so.number) },
      itemCode: r.serviceOrderItem
        ? formatServiceOrderItemCode(so.number, r.serviceOrderItem.position)
        : null,
      measurementCode: measurementCode(r.request.measurement.number),
    };
  });
}

export async function materialRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/materials/consolidated', { config: { access: VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    const inputs = await approvedInputs(prisma, q.from, q.to);
    const requestCount = new Set(inputs.map((i) => i.measurementCode)).size;
    return {
      lines: consolidateMaterials(inputs),
      requestCount,
      generatedAt: new Date().toISOString(),
    } satisfies ConsolidatedListDto;
  });

  app.get(
    '/api/v1/materials/consolidated.csv',
    { config: { access: VIEW } },
    async (request, reply) => {
      const q = periodQuerySchema.parse(request.query);
      const csv = consolidatedToCsv(
        consolidateMaterials(await approvedInputs(prisma, q.from, q.to)),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="materiais-aprovados-${new Date().toISOString().slice(0, 10)}.csv"`,
        )
        .send(csv);
    },
  );

  /**
   * Preparação de sexta-feira (checklist). Não programa produção: apenas reúne
   * medições e necessidades de material do período de referência.
   */
  app.get('/api/v1/materials/planning', { config: { access: VIEW } }, async (request) => {
    const q = periodQuerySchema.parse(request.query);
    const company = await prisma.companySettings.findUnique({ where: { id: 1 } });
    const tz = company?.timezone ?? 'America/Sao_Paulo';
    const today = todayIn(tz);
    const measurementDay = nextWeekday(q.from ?? today, company?.measurementWeekday ?? 5);
    const from = q.from ?? today;
    const to = q.to ?? measurementDay;
    const [awaiting, pending, completed, awaitingApproval, requested, approved] = await Promise.all(
      [
        awaitingMeasurement(prisma),
        prisma.measurement.findMany({
          where: {
            status: { in: ['PENDENTE', 'EM_ANDAMENTO'] },
            dueDate: { lte: parseDateOnly(to)! },
          },
          include: summaryInclude,
          orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
        }),
        prisma.measurement.findMany({
          where: {
            status: 'CONCLUIDA',
            // Dias LOCAIS da oficina (antes: meia-noite UTC — medições concluídas entre 21h e
            // 24h no horário de Brasília caíam fora do período).
            completedAt: {
              gte: zonedDateTime(from, '00:00', tz),
              lt: zonedDateTime(nextDay(to), '00:00', tz),
            },
          },
          include: summaryInclude,
          orderBy: { completedAt: 'desc' },
        }),
        prisma.measurement.findMany({
          where: { request: { status: { in: ['ENVIADA', 'EM_REVISAO'] } } },
          include: summaryInclude,
          orderBy: { completedAt: 'asc' },
        }),
        requestedInputs(prisma),
        approvedInputs(prisma),
      ],
    );
    return {
      period: { from, to, measurementDay },
      awaiting,
      pending: pending.map((m) => toSummary(m, today)),
      completed: completed.map((m) => toSummary(m, today)),
      awaitingApproval: awaitingApproval.map((m) => toSummary(m, today)),
      materials: {
        requested: consolidateMaterials(requested),
        approved: consolidateMaterials(approved),
      },
    } satisfies PlanningDto;
  });
}
