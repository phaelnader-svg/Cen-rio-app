import {
  deadlineWindowEnd,
  orderDeadline,
  serviceDeadline,
  type DeadlineFacts,
  type OrderDeadlineState,
  type ServiceDeadline,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { attendanceConfig, dbDate } from '../attendance/common';
import { dateOnly } from '../commercial/common';

type Db = PrismaClient | Tx;

/** Bloqueios que não são rotina (rotina = ainda não publicada / aguardando a etapa anterior). */
const BLOCKING = ['MATERIAIS', 'OCORRENCIA', 'BLOQUEIO', 'SEM_RESPONSAVEL'];
const STARTED = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA'];
const OPEN_TASK = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'];
const INACTIVE_STAGES = ['DEVOLVIDA', 'CANCELADA'];

/** "Hoje" no fuso da empresa (relógio operacional) e os dias de trabalho configurados. */
export async function deadlineCalendar(db: Db) {
  const cfg = await attendanceConfig(db);
  const c = await db.companySettings.findUnique({
    where: { id: 1 },
    select: { workingDays: true },
  });
  return { today: cfg.today, workingDays: c?.workingDays ?? [1, 2, 3, 4, 5] };
}
export type DeadlineCalendar = Awaited<ReturnType<typeof deadlineCalendar>>;

const factsSelect = {
  id: true,
  status: true,
  promisedDate: true,
  materialsReadiness: true,
  items: {
    select: {
      fulfillmentStage: true,
      deliveryItems: {
        where: { active: true },
        select: { delivery: { select: { id: true, status: true, scheduledDate: true } } },
      },
    },
  },
  productionPlanItems: { select: { id: true }, take: 1 },
  productionTasks: {
    where: { status: { not: 'CANCELADA' as const } },
    select: { status: true, startedAt: true, blockers: true, pauseImpediment: true },
  },
} satisfies Prisma.ServiceOrderSelect;

/**
 * Estado do prazo de várias OS de uma vez (uma consulta + a das ocorrências de entregas
 * frustradas). Fonte ÚNICA para lista, detalhe, Central e Início. Só leitura.
 */
export async function serviceDeadlines(
  db: Db,
  where: Prisma.ServiceOrderWhereInput,
  cal?: DeadlineCalendar,
): Promise<Map<string, ServiceDeadline>> {
  const calendar = cal ?? (await deadlineCalendar(db));
  const rows = await db.serviceOrder.findMany({ where, select: factsSelect });
  const frustrated = [
    ...new Set(
      rows.flatMap((r) =>
        r.items.flatMap((i) =>
          i.deliveryItems
            .filter((d) => d.delivery.status === 'FRUSTRADA')
            .map((d) => d.delivery.id),
        ),
      ),
    ),
  ];
  const kindByDelivery = new Map<string, string>();
  if (frustrated.length) {
    const occ = await db.logisticsOccurrence.findMany({
      where: { deliveryId: { in: frustrated } },
      select: { deliveryId: true, kind: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const o of occ) if (o.deliveryId) kindByDelivery.set(o.deliveryId, o.kind);
  }
  const out = new Map<string, ServiceDeadline>();
  for (const r of rows) {
    const facts: DeadlineFacts = {
      status: r.status,
      promisedDate: dateOnly(r.promisedDate),
      pieces: r.items
        .filter((i) => !INACTIVE_STAGES.includes(i.fulfillmentStage))
        .map((i) => {
          const d = i.deliveryItems[0]?.delivery ?? null;
          return {
            stage: i.fulfillmentStage,
            delivery: d ? { status: d.status, scheduledDate: dateOnly(d.scheduledDate)! } : null,
            frustrationKind:
              d && d.status === 'FRUSTRADA' ? (kindByDelivery.get(d.id) ?? null) : null,
          };
        }),
      planned: r.productionPlanItems.length > 0 || r.productionTasks.length > 0,
      started: r.productionTasks.some((t) => t.startedAt || STARTED.includes(t.status)),
      blocked: r.productionTasks.some(
        (t) =>
          (t.status === 'BLOQUEADA' && t.blockers.some((b) => BLOCKING.includes(b))) ||
          (t.status === 'PAUSADA' && t.pauseImpediment) ||
          (OPEN_TASK.includes(t.status) && t.blockers.includes('OCORRENCIA')),
      ),
      materialsReadiness: r.materialsReadiness,
    };
    out.set(r.id, serviceDeadline(facts, calendar.today, calendar.workingDays));
  }
  return out;
}

export async function serviceDeadlineOf(db: Db, id: string) {
  const m = await serviceDeadlines(db, { id });
  return m.get(id)!;
}

/** OS que podem estar atrasadas ou em risco: abertas, com prazo até o fim da janela. */
export const deadlineCandidatesWhere = (cal: DeadlineCalendar): Prisma.ServiceOrderWhereInput => ({
  status: 'ABERTA',
  promisedDate: { not: null, lte: dbDate(deadlineWindowEnd(cal.today, cal.workingDays)) },
  // Fase 10: OS com todas as peças entregues/devolvidas/canceladas já está ENCERRADA para o
  // prazo — fora da consulta (antes o histórico inteiro de OS entregues era carregado).
  items: { some: { fulfillmentStage: { notIn: ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'] } } },
});

/** Pedidos com prazo vencido/próximo e peças que ainda deveriam chegar à oficina. */
export async function orderDeadlines(
  db: Db,
  where: Prisma.CommercialOrderWhereInput,
  cal?: DeadlineCalendar,
) {
  const calendar = cal ?? (await deadlineCalendar(db));
  const rows = await db.commercialOrder.findMany({
    where: { status: { not: 'CANCELADO' }, promisedDate: { not: null }, ...where },
    select: {
      id: true,
      number: true,
      status: true,
      promisedDate: true,
      updatedAt: true,
      customer: { select: { name: true } },
      items: { select: { description: true, quantity: true, receivedQuantity: true } },
    },
  });
  const out: {
    id: string;
    number: number;
    customerName: string;
    promisedDate: string;
    updatedAt: Date;
    state: OrderDeadlineState;
    missing: { description: string; quantity: number }[];
  }[] = [];
  for (const o of rows) {
    const missing = o.items
      .map((i) => ({ description: i.description, quantity: i.quantity - i.receivedQuantity }))
      .filter((i) => i.quantity > 0);
    const promisedDate = dateOnly(o.promisedDate)!;
    const state = orderDeadline(
      { status: o.status, promisedDate, missingPieces: missing.length },
      calendar.today,
      calendar.workingDays,
    );
    if (state)
      out.push({
        id: o.id,
        number: o.number,
        customerName: o.customer.name,
        promisedDate,
        updatedAt: o.updatedAt,
        state,
        missing,
      });
  }
  return out;
}

/** Pedidos candidatos à atenção pré-OS: não cancelados, com prazo até o fim da janela. */
export const orderCandidatesWhere = (cal: DeadlineCalendar): Prisma.CommercialOrderWhereInput => ({
  promisedDate: { lte: dbDate(deadlineWindowEnd(cal.today, cal.workingDays)) },
  status: { in: ['AGUARDANDO_RETIRADA', 'RETIRADA_AGENDADA', 'RECEBIDO_PARCIAL'] },
});
