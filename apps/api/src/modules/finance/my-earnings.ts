/**
 * R1 — "Meus Ganhos" no tablet: o profissional vê só a própria remuneração variável (tapeçaria
 * por peça e logística), por semana, sobre a MESMA fonte do fechamento (`buildClosingItems`).
 * Nenhuma tabela nova: é uma visão segura das obrigações, ajustes, pagamentos e estornos.
 *
 * D12: o PIN redigitado libera a consulta por 5 minutos NESTA sessão do tablet (token assinado
 * pelo servidor e ligado à sessão e à pessoa; outra sessão, reinício ou expiração pedem o PIN
 * de novo). O token só serve para esta consulta — nenhuma ação financeira o aceita.
 */
import {
  classifyStep,
  closingWeekEnd,
  closingWeekStart,
  mondayOf,
  myEarningsQuerySchema,
  myProductionUnlockSchema,
  type ClosingItemDto,
  type MyEarningsDto,
  type MyEarningsSituation,
  type OwnPendingWorkDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom } from '../../core/audit';
import { now } from '../../core/clock';
import { AuthThrottle, POLICIES } from '../../core/throttle';
import type { AuthContext } from '../../core/types';
import { burnVerification, safeEqual, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { pieceCode } from '../quality/common';
import { buildClosingItems } from './closing';
import { localDateOf, shopTimezone, todayIso } from './common';
import { refreshLaborOf } from './labor';

type Db = Tx | PrismaClient;

/** Só no tablet (DEC-5) e só com a permissão estreita de ver os próprios ganhos. */
export const OWN_EARNINGS = {
  session: 'DEVICE',
  permissions: ['financeiro.producao_propria'],
} as const;
export const UNLOCK_MINUTES = 5;
export const UNLOCK_HEADER = 'x-earnings-unlock';

const signature = (hash: (t: string) => string, auth: AuthContext, exp: number) =>
  hash(`my-earnings|${auth.sessionId}|${auth.userId}|${exp}`);

export function issueUnlock(hash: (t: string) => string, auth: AuthContext) {
  const exp = now().getTime() + UNLOCK_MINUTES * 60_000;
  return { unlockToken: `${exp}.${signature(hash, auth, exp)}`, expiresAt: new Date(exp) };
}

export function unlockValid(hash: (t: string) => string, auth: AuthContext, token: unknown) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isSafeInteger(exp) || exp <= now().getTime()) return false;
  return safeEqual(sig, signature(hash, auth, exp));
}

/**
 * Rodada 3 (F9-02): evidência segura de que a ação veio de um desbloqueio D12 válido — só o
 * método e a validade do desbloqueio (nunca o PIN, o token ou a assinatura). Nulo se inválido.
 */
export function unlockEvidence(hash: (t: string) => string, auth: AuthContext, token: unknown) {
  if (!unlockValid(hash, auth, token)) return null;
  const exp = Number(String(token).split('.')[0]);
  return { method: 'PIN_D12' as const, unlockExpiresAt: new Date(exp).toISOString() };
}

function situationOf(i: ClosingItemDto): MyEarningsSituation {
  if (i.state === 'EM_REVISAO') return 'EM_REVISAO';
  if (i.state === 'PREVISTO') return 'PREVISTO';
  if (i.state !== 'DEVIDO') return 'AGUARDANDO_LIBERACAO';
  if (i.currentOpenCents === 0) return 'PAGO';
  return i.payments.some((p) => !p.reversed) ? 'PAGO_PARCIAL' : 'LIBERADO';
}

/** Os próprios ganhos de `userId` na semana — nunca os de outra pessoa (filtro pela sessão). */
export async function myEarnings(db: Db, userId: string, week?: string): Promise<MyEarningsDto> {
  const tz = await shopTimezone(db);
  const currentWeekStart = closingWeekStart(todayIso(tz));
  const weekStart = week ?? currentWeekStart;
  const weekEnd = closingWeekEnd(weekStart);
  const built = await buildClosingItems(db, weekStart);
  const mine = built.items.filter((i) => i.beneficiary.userId === userId);
  const laborIds = mine.filter((i) => i.kind === 'MAO_DE_OBRA').map((i) => i.id);
  const costIds = mine.filter((i) => i.kind === 'LOGISTICA').map((i) => i.id);
  const [laborAdj, costAdj] = await Promise.all([
    db.financialAdjustment.findMany({
      where: { productionPayableId: { in: laborIds } },
      orderBy: { createdAt: 'asc' },
    }),
    db.logisticsCostAdjustment.findMany({
      where: { logisticsCostId: { in: costIds } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  // O motivo da resolução de revisão descreve a divisão entre profissionais (nomes e valores de
  // outras pessoas): no "Meus Ganhos" aparece só a referência da revisão.
  const ownReason = (reason: string) => {
    const review = /^Revisão (RF-\d+):/.exec(reason);
    return review ? `Revisão financeira ${review[1]}: valor definido pelo gestor.` : reason;
  };
  const adjustmentsOf = (id: string) =>
    [
      ...laborAdj.filter((a) => a.productionPayableId === id),
      ...costAdj.filter((a) => a.logisticsCostId === id),
    ].map((a) => {
      const date = localDateOf(a.createdAt, tz);
      return {
        amountCents: a.amountCents,
        reason: ownReason(a.reason),
        date,
        afterWeek: date > weekEnd,
      };
    });
  // R2: pedidos de alteração próprios, pagamentos liberados por exceção e a conferência da semana.
  const { ownRequestIndex } = await import('./value-requests');
  const { weekConfirmation } = await import('./confirmations');
  const requests = await ownRequestIndex(
    db,
    userId,
    mine.map((i) => i.id),
  );
  const costPayables = costIds.length
    ? (
        await db.logisticsCost.findMany({
          where: { id: { in: costIds } },
          select: { payableId: true },
        })
      ).flatMap((c) => (c.payableId ? [c.payableId] : []))
    : [];
  const paidEvents = await db.financialEvent.findMany({
    where: {
      OR: [
        { entityType: 'production_payable', entityId: { in: laborIds } },
        { entityType: 'account_payable', entityId: { in: costPayables } },
      ],
      kind: { in: ['PAGAMENTO', 'PAGAMENTO_ANTECIPADO', 'QUITADA', 'PAGAMENTO_PARCIAL'] },
    },
    select: { data: true },
  });
  const administrative = new Set(
    paidEvents.flatMap((e) => {
      const d = (e.data ?? {}) as { paymentId?: string; coverage?: { kind?: string } };
      return d.paymentId && d.coverage?.kind === 'EXCECAO_ADMINISTRATIVA' ? [d.paymentId] : [];
    }),
  );
  const items: MyEarningsDto['items'] = mine.map((i) => ({
    id: i.id,
    code: i.code,
    category: i.category,
    situation: situationOf(i),
    bucket: i.bucket === 'WEEK' || i.bucket === 'PREVIOUS' ? i.bucket : 'FORECAST',
    description: i.description,
    serviceOrders: i.serviceOrders.map((o) => o.code),
    piece: i.piece?.code ?? null,
    agreedCents: i.agreedCents,
    adjustmentsCents: i.adjustmentsCents,
    totalDueCents: i.totalDueCents,
    dueCents: i.dueCents,
    paidInWeekCents: i.paidInWeekCents,
    currentOpenCents: i.currentOpenCents,
    releasedAt: i.competence,
    adjustments: adjustmentsOf(i.id),
    payments: i.payments.map((p) => ({
      amountCents: p.amountCents,
      paidAt: p.paidAt,
      reversed: p.reversed,
      administrative: administrative.has(p.id),
    })),
    request: requests.get(i.id) ?? null,
    plannedFor: null,
    canRequest:
      situationOf(i) !== 'PAGO' &&
      i.state !== 'EM_REVISAO' &&
      requests.get(i.id)?.status !== 'PENDENTE' &&
      (i.category === 'TAPECARIA' || i.state === 'DEVIDO'),
  }));
  const planned = await plannedForForecast(
    db,
    userId,
    mine.filter((i) => i.state === 'PREVISTO'),
    tz,
  );
  for (const it of items) it.plannedFor = planned.get(it.id) ?? null;
  const sum = (f: (i: ClosingItemDto) => boolean, k: keyof ClosingItemDto) =>
    mine.filter(f).reduce((a, i) => a + (i[k] as number), 0);
  const settled = (i: ClosingItemDto) => i.bucket === 'WEEK' || i.bucket === 'PREVIOUS';
  return {
    weekStart,
    weekEnd,
    currentWeekStart,
    timezone: tz,
    summary: {
      forecastCents: sum((i) => i.state === 'PREVISTO', 'currentOpenCents'),
      awaitingCents: sum(
        (i) => i.state === 'AGUARDANDO_QUALIDADE' || i.state === 'PENDENTE_CONFIGURACAO',
        'currentOpenCents',
      ),
      inReviewCents: sum((i) => i.state === 'EM_REVISAO', 'currentOpenCents'),
      releasedCents: sum(settled, 'dueCents'),
      paidInWeekCents: sum(settled, 'paidInWeekCents'),
      paidAfterCents: sum(settled, 'paidAfterCents'),
      balanceCents: sum(settled, 'currentOpenCents'),
    },
    items,
    confirmation: await weekConfirmation(db, userId, weekStart, built),
    pendingWork: weekStart === currentWeekStart ? await ownPendingWork(db, userId) : [],
  };
}

export const PENDING_WORK_LABEL = {
  SEM_VALOR: 'Valor ainda não disponível',
  EM_REVISAO: 'Valor em revisão pelo gestor',
} as const;

/**
 * Rodada 3 (F8-06): trabalho executado ainda sem obrigação — só ESTADO, nunca valor. A relação
 * execução → futura obrigação só é inequívoca quando: a pessoa é a TITULAR da peça (o valor da
 * peça é do titular), concluiu uma etapa de TAPEÇARIA própria (não apoio, não correção, não
 * ocorrência) e não existe NENHUMA obrigação dela na peça nem na OS inteira (qualquer situação —
 * cancelada inclusive, pois aí já houve decisão). Peça/OS cancelada fica de fora. Qualquer outro
 * caso (titular diferente, sem titular, valor da OS de outra pessoa) é ambíguo e não aparece.
 */
export async function ownPendingWork(db: Db, userId: string): Promise<OwnPendingWorkDto[]> {
  const tasks = await db.productionTask.findMany({
    where: {
      assigneeUserId: userId,
      status: 'CONCLUIDA',
      OR: [{ stepClass: 'TAPECARIA' }, { stepClass: null }],
      supportForTaskId: null,
      issueId: null,
      inspectionId: null,
      serviceOrderItem: {
        upholstererUserId: userId,
        fulfillmentStage: { not: 'CANCELADA' },
        serviceOrder: { status: { not: 'CANCELADA' } },
      },
    },
    select: {
      completedAt: true,
      stepClass: true,
      activity: true,
      role: true,
      serviceOrderItem: {
        select: {
          id: true,
          serviceOrderId: true,
          position: true,
          description: true,
          serviceOrder: { select: { number: true } },
        },
      },
    },
    orderBy: { completedAt: 'asc' },
  });
  const pieces = new Map<
    string,
    { piece: NonNullable<(typeof tasks)[number]['serviceOrderItem']>; at: Date }
  >();
  for (const t of tasks) {
    const p = t.serviceOrderItem;
    // Etapa sem classe gravada: vale a classificação canônica (atividade + papel concordantes).
    if (!p || (t.stepClass ?? classifyStep(t.activity, t.role)) !== 'TAPECARIA') continue;
    const at = t.completedAt ?? new Date(0);
    const cur = pieces.get(p.id);
    if (!cur || at > cur.at) pieces.set(p.id, { piece: p, at });
  }
  if (!pieces.size) return [];
  const all = [...pieces.values()];
  const [payables, reviews] = await Promise.all([
    db.productionPayable.findMany({
      where: {
        professionalUserId: userId,
        OR: [
          { serviceOrderItemId: { in: [...pieces.keys()] } },
          {
            serviceOrderItemId: null,
            serviceOrderId: { in: all.map((x) => x.piece.serviceOrderId) },
          },
        ],
      },
      select: { serviceOrderId: true, serviceOrderItemId: true },
    }),
    db.laborReview.findMany({
      where: {
        status: 'ABERTA',
        OR: [
          { serviceOrderItemId: { in: [...pieces.keys()] } },
          {
            serviceOrderItemId: null,
            serviceOrderId: { in: all.map((x) => x.piece.serviceOrderId) },
          },
        ],
      },
      select: { serviceOrderId: true, serviceOrderItemId: true },
    }),
  ]);
  const covered = (
    rows: { serviceOrderId: string; serviceOrderItemId: string | null }[],
    id: string,
    so: string,
  ) =>
    rows.some(
      (r) =>
        r.serviceOrderItemId === id || (r.serviceOrderItemId === null && r.serviceOrderId === so),
    );
  return all
    .filter((x) => !covered(payables, x.piece.id, x.piece.serviceOrderId))
    .map((x) => {
      const state = covered(reviews, x.piece.id, x.piece.serviceOrderId)
        ? 'EM_REVISAO'
        : 'SEM_VALOR';
      return {
        serviceOrder: serviceOrderCode(x.piece.serviceOrder.number),
        piece: pieceCode(x.piece),
        description: x.piece.description,
        state,
        label: PENDING_WORK_LABEL[state],
        completedAt: x.at.toISOString(),
      };
    });
}

export async function myEarningsRoutes(app: FastifyInstance) {
  const { prisma, hashToken } = app.ctx;
  const throttle = new AuthThrottle(prisma);

  /** PIN redigitado → desbloqueio de 5 minutos desta sessão (sem valores na resposta). */
  app.post(
    '/api/v1/finance/my-earnings/unlock',
    { config: { access: OWN_EARNINGS } },
    async (request, reply) => {
      const { pin } = myProductionUnlockSchema.parse(request.body);
      const auth = request.auth!;
      const employee = await prisma.employee.findUnique({
        where: { userId: auth.userId },
        include: { user: true },
      });
      const key = `pin:${employee?.id ?? auth.userId}`;
      await throttle.assertAllowed([key]);
      const ok = employee?.user.pinHash
        ? await verifySecret(employee.user.pinHash, pin)
        : (await burnVerification(pin), false);
      if (!ok) {
        await throttle.registerFailure(key, POLICIES.pin);
        throw Errors.invalidCredentials('PIN incorreto.');
      }
      await throttle.reset(key);
      void reply.header('cache-control', 'no-store');
      const u = issueUnlock(hashToken, auth);
      return { unlockToken: u.unlockToken, expiresAt: u.expiresAt.toISOString() };
    },
  );

  app.get(
    '/api/v1/finance/my-earnings',
    { config: { access: OWN_EARNINGS } },
    async (request: FastifyRequest, reply) => {
      const auth = request.auth!;
      if (!unlockValid(hashToken, auth, request.headers[UNLOCK_HEADER]))
        throw Errors.forbidden('Confirme seu PIN para ver seus ganhos.');
      const q = myEarningsQuerySchema.parse(request.query);
      await prisma.$transaction((t) =>
        refreshLaborOf(t, actorFrom(request), {
          professionalUserId: auth.userId,
          status: { in: ['PREVISTO', 'LIBERADO'] },
        }),
      );
      void reply.header('cache-control', 'no-store');
      return myEarnings(prisma, auth.userId, q.week);
    },
  );
}

/**
 * Rodada 3 (F8-03, decisão C): para cada item PREVISTO, a semana/data PLANEJADA — informação
 * operacional, nunca semana financeira. Mão de obra: a etapa pendente mais próxima da própria
 * pessoa na peça (ou na OS, se o valor é da OS inteira), pela semana do plano e o horário
 * programado. Logística: a data agendada da viagem. Sem planejamento: null ("sem semana").
 * Só leitura: nada é gravado e o fechamento não muda.
 */
async function plannedForForecast(
  db: Db,
  userId: string,
  forecast: ClosingItemDto[],
  tz: string,
): Promise<Map<string, { weekStart: string; date: string | null }>> {
  const out = new Map<string, { weekStart: string; date: string | null }>();
  if (!forecast.length) return out;
  const labor = forecast.filter((i) => i.kind === 'MAO_DE_OBRA');
  if (labor.length) {
    const tasks = await db.productionTask.findMany({
      where: {
        assigneeUserId: userId,
        status: { notIn: ['CONCLUIDA', 'CANCELADA', 'RASCUNHO'] },
        planId: { not: null },
        serviceOrderId: { in: labor.flatMap((i) => i.serviceOrders.map((o) => o.id)) },
      },
      select: {
        serviceOrderId: true,
        serviceOrderItemId: true,
        scheduledAt: true,
        plan: { select: { weekStart: true } },
      },
    });
    const key = (t: (typeof tasks)[number]) =>
      `${t.plan!.weekStart.toISOString().slice(0, 10)}|${t.scheduledAt?.toISOString() ?? '~'}`;
    for (const i of labor) {
      const mineTasks = tasks
        .filter((t) =>
          i.piece
            ? t.serviceOrderItemId === i.piece.id
            : i.serviceOrders.some((o) => o.id === t.serviceOrderId),
        )
        .filter((t) => t.plan)
        .sort((a, b) => key(a).localeCompare(key(b)));
      const t = mineTasks[0];
      if (t)
        out.set(i.id, {
          weekStart: t.plan!.weekStart.toISOString().slice(0, 10),
          date: t.scheduledAt ? localDateOf(t.scheduledAt, tz) : null,
        });
    }
  }
  const trips = forecast.filter((i) => i.kind === 'LOGISTICA');
  if (trips.length) {
    const costs = await db.logisticsCost.findMany({
      where: { id: { in: trips.map((i) => i.id) } },
      select: {
        id: true,
        pickup: { select: { scheduledDate: true } },
        delivery: { select: { scheduledDate: true } },
      },
    });
    for (const c of costs) {
      const d = c.pickup?.scheduledDate ?? c.delivery?.scheduledDate ?? null;
      if (!d) continue;
      const date = d.toISOString().slice(0, 10);
      out.set(c.id, { weekStart: mondayOf(date), date });
    }
  }
  return out;
}
