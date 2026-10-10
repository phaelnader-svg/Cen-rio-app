import {
  EVENT_TYPES,
  anyPermissionAudience,
  logisticsRouteQuerySchema,
  logisticsRouteSequenceSchema,
  type LogisticsJobDto,
  type LogisticsRouteChangeDto,
  type LogisticsRouteDto,
  type LogisticsRouteStopDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import {
  asSnapshot,
  dateOnly,
  parseDateOnly,
  pickupCode,
  serviceOrderCode,
} from '../commercial/common';
import { deliveryInclude, toDeliveryJob } from './shipping';

/**
 * Correção global — ROTEIRO DIÁRIO da logística (retiradas e entregas de um dia).
 *
 * - A SEQUÊNCIA operacional (ordem das paradas) é do gestor e independe do horário combinado
 *   com o cliente: reordenar nunca altera data, horário de chegada nem a versão do compromisso.
 * - Alertas só com dados confiáveis: mesmo horário para a mesma pessoa, sequência que contraria
 *   os horários combinados e compromisso sem horário. Nenhuma estimativa de deslocamento é
 *   inventada.
 * - Quem executa (logística) vê só as paradas em que é responsável ou participante; nunca
 *   valores. O histórico de alterações da sequência fica no registro de auditoria.
 */

const ROUTE_AUDIENCE = anyPermissionAudience('entregas.ver', 'retiradas.ver', 'logistica.executar');
const MANAGER_VIEW = ['entregas.ver', 'retiradas.ver'] as const;

type Viewer = { userId: string; manager: boolean };
type Stop = LogisticsRouteStopDto & { key: string };

const hm = (t: string | null) => t ?? '';

async function collect(db: Tx | PrismaClient, date: string): Promise<Stop[]> {
  const day = parseDateOnly(date)!;
  const [deliveries, pickups] = await Promise.all([
    db.delivery.findMany({
      where: { scheduledDate: day, status: { not: 'CANCELADA' } },
      include: deliveryInclude,
    }),
    db.pickupRequest.findMany({
      where: { scheduledDate: day, status: { not: 'CANCELADA' } },
      include: {
        order: {
          include: {
            customer: { select: { name: true, phone: true } },
            serviceOrders: { where: { status: 'ABERTA' }, select: { number: true } },
          },
        },
        items: { include: { orderItem: { select: { description: true } } } },
        logisticsUser: { select: { id: true, displayName: true } },
      },
    }),
  ]);
  const costs = await db.logisticsCost.findMany({
    where: {
      status: { not: 'CANCELADO' },
      OR: [
        { deliveryId: { in: deliveries.map((d) => d.id) } },
        { pickupId: { in: pickups.map((p) => p.id) } },
      ],
    },
    include: { participants: { include: { user: { select: { id: true, displayName: true } } } } },
  });
  const people = (ref: { deliveryId?: string; pickupId?: string }) =>
    costs
      .filter((c) =>
        ref.deliveryId ? c.deliveryId === ref.deliveryId : c.pickupId === ref.pickupId,
      )
      .flatMap((c) =>
        c.participants.map((p) => ({ userId: p.user.id, displayName: p.user.displayName })),
      );
  const stops: Stop[] = [];
  for (const d of deliveries) {
    const job = toDeliveryJob(d);
    stops.push({
      key: `ENTREGA:${d.id}`,
      position: 0,
      savedSequence: d.routeSequence,
      confirmed: d.status !== 'PROVISORIA',
      serviceOrders: [
        ...new Set(
          d.items
            .filter((i) => i.active)
            .map((i) => serviceOrderCode(i.serviceOrderItem.serviceOrder.number)),
        ),
      ],
      team: d.team as LogisticsRouteStopDto['team'],
      responsible: d.responsible
        ? { userId: d.responsible.id, displayName: d.responsible.displayName }
        : null,
      participants: people({ deliveryId: d.id }),
      conflicts: [],
      job,
    });
  }
  for (const p of pickups) {
    const a = asSnapshot(p.addressSnapshot);
    const job: LogisticsJobDto = {
      id: p.id,
      kind: 'RETIRADA',
      code: pickupCode(p.number),
      status: p.status,
      customerName: p.order.customer.name,
      address: a
        ? {
            street: a.street,
            number: a.number,
            complement: a.complement,
            district: a.district,
            city: a.city,
            state: a.state,
            postalCode: a.postalCode,
            reference: a.reference,
          }
        : null,
      contactName: p.order.customer.name,
      contactPhone: p.order.customer.phone,
      scheduledDate: dateOnly(p.scheduledDate),
      windowStart: p.windowStart,
      windowEnd: p.windowEnd,
      requiresInstallation: false,
      instructions: p.instructions,
      pieces: p.items.map((i) => ({
        id: i.orderItemId,
        code: null,
        description: i.orderItem.description,
        quantity: i.quantity,
        status: null,
      })),
      departedAt: null,
      arrivedAt: null,
      installedAt: null,
      completedAt: null,
      version: p.version,
    };
    stops.push({
      key: `RETIRADA:${p.id}`,
      position: 0,
      savedSequence: p.routeSequence,
      confirmed: p.status !== 'AGUARDANDO_AGENDAMENTO',
      serviceOrders: p.order.serviceOrders.map((s) => serviceOrderCode(s.number)),
      team: p.team as LogisticsRouteStopDto['team'],
      responsible: p.logisticsUser
        ? { userId: p.logisticsUser.id, displayName: p.logisticsUser.displayName }
        : null,
      participants: people({ pickupId: p.id }),
      conflicts: [],
      job,
    });
  }
  // Ordem: sequência gravada pelo gestor; as ainda não ordenadas vão ao fim, pelo horário.
  stops.sort(
    (x, y) =>
      (x.savedSequence ?? 1e9) - (y.savedSequence ?? 1e9) ||
      (x.job.windowStart ? 0 : 1) - (y.job.windowStart ? 0 : 1) ||
      hm(x.job.windowStart).localeCompare(hm(y.job.windowStart)) ||
      x.job.code.localeCompare(y.job.code),
  );
  stops.forEach((s, i) => (s.position = i + 1));
  return stops;
}

function analyze(stops: Stop[]): string[] {
  const warnings: string[] = [];
  const who = (s: Stop) => [
    ...(s.responsible ? [s.responsible] : []),
    ...s.participants.filter((p) => p.userId !== s.responsible?.userId),
  ];
  for (const [i, s] of stops.entries()) {
    const t = s.job.windowStart;
    if (s.confirmed && !t)
      s.conflicts.push(
        'Sem horário de chegada combinado (registro antigo): combine com o cliente.',
      );
    if (!t) continue;
    for (const o of stops.slice(0, i)) {
      if (!o.job.windowStart) continue;
      if (o.job.windowStart === t) {
        const same = who(s).filter((p) => who(o).some((q) => q.userId === p.userId));
        if (same.length)
          s.conflicts.push(
            `Mesmo horário de chegada (${t}) que ${o.job.code} para ${same.map((p) => p.displayName).join(' e ')}.`,
          );
      } else if (o.job.windowStart > t) {
        s.conflicts.push(
          `Na sequência vem depois de ${o.job.code} (chegada ${o.job.windowStart}), mas a chegada combinada aqui é ${t}: confira o deslocamento.`,
        );
      }
    }
  }
  const pending = stops.filter((s) => !s.confirmed).length;
  if (pending)
    warnings.push(
      `${pending} parada(s) não confirmada(s) (pré-agendamento ou retirada só solicitada): não são compromisso com o cliente.`,
    );
  const noOwner = stops.filter((s) => s.confirmed && !s.responsible).length;
  if (noOwner) warnings.push(`${noOwner} parada(s) sem responsável pela execução.`);
  return warnings;
}

export async function loadRoute(
  db: Tx | PrismaClient,
  date: string,
  viewer: Viewer,
): Promise<LogisticsRouteDto> {
  const all = await collect(db, date);
  const warnings = analyze(all);
  const mine = (s: Stop) =>
    s.responsible?.userId === viewer.userId ||
    s.participants.some((p) => p.userId === viewer.userId);
  const stops = viewer.manager ? all : all.filter(mine);
  return {
    date,
    scope: viewer.manager ? 'GESTOR' : 'EQUIPE',
    stops: stops.map(({ key: _k, ...s }) => s),
    warnings: viewer.manager ? warnings : [],
  };
}

export async function setRouteSequence(
  tx: Tx,
  actor: ActorContext,
  input: {
    date: string;
    stops: { kind: 'RETIRADA' | 'ENTREGA'; id: string }[];
    reason?: string | null;
  },
) {
  // Uma alteração de roteiro por vez para o mesmo dia.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`roteiro:${input.date}`}))`;
  const current = await collect(tx, input.date);
  const asked = input.stops.map((s) => `${s.kind}:${s.id}`);
  const have = new Set(current.map((s) => s.key));
  if (asked.length !== have.size || asked.some((k) => !have.has(k)))
    throw Errors.conflict(
      'O roteiro do dia mudou (parada nova, remarcada ou cancelada): atualize a tela e reordene de novo.',
    );
  const code = new Map(current.map((s) => [s.key, s.job.code]));
  const before = current.map((s) => code.get(s.key)!);
  const after = asked.map((k) => code.get(k)!);
  for (const [i, s] of input.stops.entries()) {
    // Só a posição no roteiro: data, horário de chegada e versão do compromisso NÃO mudam.
    if (s.kind === 'ENTREGA')
      await tx.delivery.update({ where: { id: s.id }, data: { routeSequence: i + 1 } });
    else await tx.pickupRequest.update({ where: { id: s.id }, data: { routeSequence: i + 1 } });
  }
  const changed = before.join() !== after.join();
  const reason = input.reason?.trim() || null;
  if (changed)
    await audit(tx, actor, {
      action: 'logistics.route_sequence',
      entityType: 'logistics_route',
      entityId: input.date,
      summary:
        `Roteiro de ${input.date.split('-').reverse().join('/')}: ${after.join(' → ')}${reason ? `. Motivo: ${reason}` : ''}`.slice(
          0,
          300,
        ),
      changes: { before, after, reason },
    });
  const users = new Set(
    current
      .flatMap((s) => [s.responsible?.userId, ...s.participants.map((p) => p.userId)])
      .filter(Boolean),
  );
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.LOGISTICS_ROUTE_CHANGED,
    aggregateType: 'logistics_route',
    aggregateId: input.date,
    payload: { date: input.date },
    audience: [ROUTE_AUDIENCE, ...[...users].map((u) => `user:${u}`)].join(
      '|',
    ) as typeof ROUTE_AUDIENCE,
  });
  return { changed, before, after };
}

export async function routeHistory(
  db: Tx | PrismaClient,
  date: string,
): Promise<LogisticsRouteChangeDto[]> {
  const rows = await db.auditLog.findMany({
    where: { entityType: 'logistics_route', entityId: date },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const actors = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)) } },
    select: { id: true, displayName: true },
  });
  return rows.map((r) => {
    const c = (r.changes ?? {}) as { before?: string[]; after?: string[]; reason?: string | null };
    return {
      at: r.createdAt.toISOString(),
      actor: actors.find((a) => a.id === r.actorUserId)?.displayName ?? null,
      reason: c.reason ?? null,
      before: c.before ?? [],
      after: c.after ?? [],
    };
  });
}

export async function logisticsRouteRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get(
    '/api/v1/logistics/route',
    {
      config: {
        access: {
          session: 'any',
          anyPermissions: ['entregas.ver', 'retiradas.ver', 'logistica.executar'],
        },
      },
    },
    async (request) => {
      const { date } = logisticsRouteQuerySchema.parse(request.query);
      const auth = request.auth!;
      const manager = auth.kind === 'WEB' && MANAGER_VIEW.some((p) => auth.permissions.has(p));
      return loadRoute(prisma, date, { userId: auth.userId, manager });
    },
  );
  app.get(
    '/api/v1/logistics/route/history',
    { config: { access: { session: 'WEB', anyPermissions: [...MANAGER_VIEW] } } },
    async (request) => {
      const { date } = logisticsRouteQuerySchema.parse(request.query);
      return routeHistory(prisma, date);
    },
  );
  app.put(
    '/api/v1/logistics/route/sequence',
    {
      config: {
        access: { session: 'WEB', anyPermissions: ['entregas.gerenciar', 'retiradas.gerenciar'] },
        idempotent: true,
      },
    },
    async (request) => {
      const input = logisticsRouteSequenceSchema.parse(request.body);
      const auth = request.auth!;
      const r = await prisma.$transaction((tx) => setRouteSequence(tx, actorFrom(request), input));
      return {
        ...r,
        route: await loadRoute(prisma, input.date, { userId: auth.userId, manager: true }),
      };
    },
  );
}
