/**
 * Etapa 5 da lista de 53 (Firma Viva), lido pelo jogo pela autorização da empresa:
 * - item 38: quadro na parede da oficina — entregas, atrasos e faturamento desta semana
 *   comparados com o mesmo pedaço da semana passada (segunda até hoje);
 * - item 39: cliente esperando na recepção — peça pronta e parada há dias sem entrega (o mesmo
 *   critério do aviso "Peça pronta sem entrega" do Início e do sininho);
 * - item 36: fotos reais da peça — as fotos da OS, da peça e as que o tablet tirou (etapas,
 *   ocorrências e conferência), cada uma com a permissão de leitura do registro dela.
 * Nada aqui grava: só lê os registros do Cenário Gestão.
 */
import {
  type AttachmentEntity,
  type Permission,
  READY_WITHOUT_DELIVERY_DAYS,
  formatServiceOrderItemCode,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { now as clockNow } from '../../core/clock';
import { Errors } from '../../lib/errors';
import { VIEW_PERMISSIONS } from '../attachments/policy';
import { serviceOrderCode } from '../commercial/common';
import { readySince } from '../management/today';
import { GAME_ACCESS } from './common';

const DAY = 86_400_000;
const daySP = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
/** Meia-noite (São Paulo, UTC−3) do dia `yyyy-mm-dd`. */
const midnightSP = (day: string) => new Date(`${day}T03:00:00.000Z`);
const dateOnly = (day: string) => new Date(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export interface WallNumber {
  week: number;
  last: number;
}
export interface GameWallDto {
  /** Segunda-feira desta semana e o dia de hoje (yyyy-mm-dd). */
  from: string;
  to: string;
  deliveries: WallNumber;
  late: WallNumber;
  /** Recebido no caixa (centavos); só para quem vê o financeiro. */
  revenueCents: WallNumber | null;
  waiting: {
    serviceOrderId: string;
    osCode: string;
    customerName: string;
    items: { id: string; code: string; description: string }[];
    days: number;
  }[];
}

const allowed = (perms: ReadonlySet<Permission>, need: readonly Permission[]) =>
  need.some((p) => perms.has(p));

export async function gameWallRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Peças cujo prazo (dia prometido) caiu em [fromDay, toDay) e não saíram até o fim dele. */
  async function lateCount(fromDay: string, toDay: string) {
    if (fromDay >= toDay) return 0;
    const sos = await prisma.serviceOrder.findMany({
      where: {
        status: { not: 'CANCELADA' },
        promisedDate: { gte: dateOnly(fromDay), lt: dateOnly(toDay) },
      },
      select: {
        promisedDate: true,
        items: {
          where: { fulfillmentStage: { notIn: ['CANCELADA', 'DEVOLVIDA'] } },
          select: {
            deliveryItems: {
              where: { status: 'ENTREGUE' },
              select: { deliveredAt: true },
            },
          },
        },
      },
    });
    let n = 0;
    for (const so of sos) {
      const end = midnightSP(addDays(so.promisedDate!.toISOString().slice(0, 10), 1));
      const late = so.items.some(
        (i) => !i.deliveryItems.some((d) => d.deliveredAt && d.deliveredAt < end),
      );
      if (late) n++;
    }
    return n;
  }

  async function revenue(fromDay: string, toDayInclusive: string) {
    const range = { gte: dateOnly(fromDay), lte: dateOnly(toDayInclusive) };
    const [pay, manual] = await Promise.all([
      prisma.customerPayment.aggregate({
        where: { receivedAt: range },
        _sum: { amountCents: true },
      }),
      prisma.manualRevenue.aggregate({
        where: { receivedAt: range, cancelledAt: null },
        _sum: { amountCents: true },
      }),
    ]);
    return (pay._sum.amountCents ?? 0) + (manual._sum.amountCents ?? 0);
  }

  app.get('/api/v1/game/wall', { config: { access: GAME_ACCESS } }, async (request) => {
    const now = clockNow();
    const today = daySP(now);
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // segunda = 0
    const monday = addDays(today, -weekday);
    const lastMonday = addDays(monday, -7);
    const lastToday = addDays(today, -7);
    const ago = new Date(now.getTime() - 7 * DAY);
    const perms = request.auth!.permissions;
    const canMoney = perms.has('financeiro.ver');

    const [dWeek, dLast, lWeek, lLast, rWeek, rLast] = await Promise.all([
      prisma.deliveryItem.count({
        where: { status: 'ENTREGUE', deliveredAt: { gte: midnightSP(monday), lte: now } },
      }),
      prisma.deliveryItem.count({
        where: { status: 'ENTREGUE', deliveredAt: { gte: midnightSP(lastMonday), lte: ago } },
      }),
      lateCount(monday, today),
      lateCount(lastMonday, lastToday),
      canMoney ? revenue(monday, today) : Promise.resolve(0),
      canMoney ? revenue(lastMonday, lastToday) : Promise.resolve(0),
    ]);

    // Item 39: peças prontas e paradas (o mesmo aviso do Início), agrupadas por OS.
    const ready = await prisma.serviceOrderItem.findMany({
      where: { fulfillmentStage: 'PRONTA_ENTREGA', serviceOrder: { status: 'ABERTA' } },
      select: {
        id: true,
        position: true,
        description: true,
        serviceOrderId: true,
        serviceOrder: { select: { number: true, customer: { select: { name: true } } } },
      },
    });
    const since = await readySince(
      prisma,
      ready.map((r) => r.id),
    );
    const byOs = new Map<string, GameWallDto['waiting'][number]>();
    for (const r of ready) {
      const at = since.get(r.id);
      const days = at ? Math.floor((now.getTime() - at.getTime()) / DAY) : 0;
      if (days < READY_WITHOUT_DELIVERY_DAYS) continue;
      const w = byOs.get(r.serviceOrderId) ?? {
        serviceOrderId: r.serviceOrderId,
        osCode: serviceOrderCode(r.serviceOrder.number),
        customerName: r.serviceOrder.customer.name,
        items: [],
        days: 0,
      };
      w.items.push({
        id: r.id,
        code: formatServiceOrderItemCode(r.serviceOrder.number, r.position),
        description: r.description,
      });
      w.days = Math.max(w.days, days);
      byOs.set(r.serviceOrderId, w);
    }

    return {
      from: monday,
      to: today,
      deliveries: { week: dWeek, last: dLast },
      late: { week: lWeek, last: lLast },
      revenueCents: canMoney ? { week: rWeek, last: rLast } : null,
      waiting: [...byOs.values()].sort((a, b) => b.days - a.days).slice(0, 6),
    } satisfies GameWallDto;
  });

  // ───────────── Item 36: fotos reais da peça ─────────────
  const itemParams = z.object({ id: z.string().uuid() });
  app.get(
    '/api/v1/game/pieces/:id/photos',
    { config: { access: GAME_ACCESS } },
    async (request) => {
      const { id } = itemParams.parse(request.params);
      const perms = request.auth!.permissions;
      const item = await prisma.serviceOrderItem.findUnique({
        where: { id },
        select: { id: true, serviceOrderId: true },
      });
      if (!item) throw Errors.notFound('Peça');
      const [tasks, issues, inspections] = await Promise.all([
        prisma.productionTask.findMany({
          where: {
            OR: [
              { serviceOrderItemId: id },
              { serviceOrderId: item.serviceOrderId, serviceOrderItemId: null },
            ],
          },
          select: { id: true, title: true },
        }),
        prisma.productionIssue.findMany({
          where: { task: { serviceOrderItemId: id } },
          select: { id: true },
        }),
        prisma.qualityInspection.findMany({
          where: { serviceOrderItemId: id },
          select: { id: true },
        }),
      ]);
      const taskTitle = new Map(tasks.map((t) => [t.id, t.title]));
      const sources: { type: AttachmentEntity; ids: string[]; label: (id: string) => string }[] = [
        { type: 'SERVICE_ORDER', ids: [item.serviceOrderId], label: () => 'Na OS' },
        { type: 'SERVICE_ORDER_ITEM', ids: [id], label: () => 'Da peça' },
        {
          type: 'PRODUCTION_TASK',
          ids: tasks.map((t) => t.id),
          label: (x) => `Tablet: ${taskTitle.get(x) ?? 'etapa'}`,
        },
        { type: 'PRODUCTION_ISSUE', ids: issues.map((i) => i.id), label: () => 'Ocorrência' },
        {
          type: 'QUALITY_INSPECTION',
          ids: inspections.map((i) => i.id),
          label: () => 'Conferência',
        },
      ];
      const visible = sources.filter(
        (s) => s.ids.length && allowed(perms, VIEW_PERMISSIONS[s.type]),
      );
      const rows = visible.length
        ? await prisma.attachment.findMany({
            where: {
              deletedAt: null,
              OR: visible.map((s) => ({ entityType: s.type, entityId: { in: s.ids } })),
              file: { mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] } },
            },
            include: { file: true, createdBy: { select: { displayName: true } } },
            orderBy: { createdAt: 'asc' },
            take: 60,
          })
        : [];
      return rows.map((a) => ({
        id: a.id,
        url: `/api/files/${a.fileId}`,
        thumbUrl: `/api/files/${a.fileId}/miniatura`,
        caption: a.caption,
        source: visible.find((s) => s.type === a.entityType)!.label(a.entityId),
        createdBy: a.createdBy?.displayName ?? null,
        createdAt: a.createdAt.toISOString(),
      }));
    },
  );
}
