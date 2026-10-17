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
  closingWeekEnd,
  closingWeekStart,
  myEarningsQuerySchema,
  myProductionUnlockSchema,
  type ClosingItemDto,
  type MyEarningsDto,
  type MyEarningsSituation,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom } from '../../core/audit';
import { now } from '../../core/clock';
import { AuthThrottle, POLICIES } from '../../core/throttle';
import type { AuthContext } from '../../core/types';
import { burnVerification, safeEqual, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
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
    })),
  }));
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
  };
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
