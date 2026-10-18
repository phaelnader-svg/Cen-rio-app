/**
 * R2 — confirmação semanal do profissional, exceção administrativa e portão de pagamento (D13).
 *
 * A confirmação é um retrato imutável (`weekly_closing_confirmations`) das linhas que o
 * profissional conferiu, calculadas da MESMA fonte do fechamento e do "Meus Ganhos"
 * (`buildClosingItems`). Nada é copiado para uma segunda fonte: a validade é recalculada ao vivo
 * comparando cada linha confirmada com a linha atual.
 *
 * D13: todo pagamento de profissional (direto, parcial, em lote, conta a pagar da viagem,
 * antecipado) só passa se a linha do item na semana estiver coberta por uma confirmação do
 * profissional ou por uma exceção administrativa (motivo + gestor + linhas exatas). Mudou o
 * devido → a linha antiga não cobre mais. Pagamentos da própria semana não fazem parte da linha:
 * pagar em parte não invalida a confirmação.
 */
import { createHash } from 'node:crypto';
import {
  closingWeekStart,
  confirmationCode,
  confirmationLine,
  confirmationPayload,
  myEarningsQuerySchema,
  sameLine,
  weekStartParamsSchema,
  type ClosingItemDto,
  type ConfirmationLine,
  type WeekConfirmationDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { FIN_MANAGE, dateOnly, financeEvent } from './common';
import { OWN_EARNINGS, UNLOCK_HEADER, unlockValid } from './my-earnings';
import { markStaleRequests, pendingRequestCodes } from './value-requests';

type Db = Tx | PrismaClient;
type Built = { items: ClosingItemDto[] };

async function build(db: Db, weekStart: string): Promise<Built> {
  // Import tardio: closing.ts usa as funções de pagamento que chamam este portão.
  const { buildClosingItems } = await import('./closing');
  return buildClosingItems(db, weekStart);
}

const weekDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const lockKey = (userId: string, weekStart: string) => `closing-confirm:${userId}:${weekStart}`;
async function lockWeek(tx: Tx, userId: string, weekStart: string) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    lockKey(userId, weekStart),
  );
}

export const personItems = (built: Built, userId: string) =>
  built.items.filter((i) => i.beneficiary.userId === userId);

/** Linhas que o profissional confere: o que está devido nesta semana (devido ou saldo anterior). */
export const payableLines = (items: ClosingItemDto[]) =>
  items.filter((i) => i.bucket === 'WEEK' || i.bucket === 'PREVIOUS').map(confirmationLine);

export const hashOf = (userId: string, weekStart: string, lines: readonly ConfirmationLine[]) =>
  createHash('sha256')
    .update(confirmationPayload(userId, weekStart, lines))
    .digest('hex');

const linesOf = (row: { items: Prisma.JsonValue }) => row.items as unknown as ConfirmationLine[];

/** Situação ao vivo da semana do profissional (mesmo cálculo para tablet e fechamento). */
export async function weekConfirmation(
  db: Db,
  userId: string,
  weekStart: string,
  built?: Built,
): Promise<WeekConfirmationDto> {
  const b = built ?? (await build(db, weekStart));
  const lines = payableLines(personItems(b, userId));
  const rows = await db.weeklyClosingConfirmation.findMany({
    where: { beneficiaryUserId: userId, weekStart: weekDate(weekStart) },
    orderBy: { createdAt: 'desc' },
  });
  const currentHash = lines.length ? hashOf(userId, weekStart, lines) : null;
  const match = currentHash ? rows.find((r) => r.hash === currentHash) : undefined;
  const latest = match ?? rows[0] ?? null;
  const state: WeekConfirmationDto['state'] = !lines.length
    ? 'SEM_ITENS'
    : match
      ? match.kind === 'PROFISSIONAL'
        ? 'CONFIRMADA'
        : 'LIBERADA_POR_EXCECAO'
      : rows.length
        ? 'DESATUALIZADA'
        : 'SEM_CONFIRMACAO';
  const changed: string[] = [];
  if (latest && !match) {
    const before = linesOf(latest);
    for (const l of lines) if (!before.some((x) => sameLine(x, l))) changed.push(l.code);
    for (const x of before)
      if (!lines.some((l) => l.id === x.id) && !changed.includes(x.code)) changed.push(x.code);
  }
  return {
    state,
    weekStart,
    currentHash,
    totalCents: lines.reduce((a, l) => a + l.dueCents, 0),
    lines: lines.map((l) => ({ code: l.code, kind: l.kind, dueCents: l.dueCents })),
    latest: latest
      ? {
          code: confirmationCode(latest.number),
          kind: latest.kind as 'PROFISSIONAL' | 'EXCECAO_ADMINISTRATIVA',
          createdAt: latest.createdAt.toISOString(),
          publicNote: latest.kind === 'EXCECAO_ADMINISTRATIVA' ? latest.publicNote : null,
        }
      : null,
    changed: changed.sort(),
    pendingRequests: await pendingRequestCodes(db, userId, lines),
  };
}

/**
 * D13: a linha atual do item precisa estar numa confirmação do profissional ou numa exceção
 * administrativa daquela pessoa e semana. Devolve a cobertura usada (para o histórico).
 */
export async function assertPaymentCovered(
  db: Db,
  input: {
    userId: string;
    weekStart: string;
    kind: 'MAO_DE_OBRA' | 'LOGISTICA';
    itemId: string;
    built?: Built;
  },
) {
  const b = input.built ?? (await build(db, input.weekStart));
  const item = b.items.find(
    (i) => i.kind === input.kind && i.id === input.itemId && i.beneficiary.userId === input.userId,
  );
  if (!item)
    throw Errors.business(
      `Este valor não aparece no fechamento da semana de ${input.weekStart.split('-').reverse().join('/')}: pague pela semana em que ele está.`,
    );
  const line = confirmationLine(item);
  const rows = await db.weeklyClosingConfirmation.findMany({
    where: { beneficiaryUserId: input.userId, weekStart: weekDate(input.weekStart) },
    orderBy: { createdAt: 'desc' },
  });
  const hit = rows.find((r) => linesOf(r).some((l) => sameLine(l, line)));
  if (!hit)
    throw Errors.business(
      `Esta semana ainda não foi confirmada pelo profissional (${item.code}). Peça a conferência no tablet ou use a exceção administrativa (com motivo).`,
    );
  return {
    id: hit.id,
    code: confirmationCode(hit.number),
    kind: hit.kind as 'PROFISSIONAL' | 'EXCECAO_ADMINISTRATIVA',
  };
}

/** Semana do pagamento: a do lote, ou a da data efetiva do pagamento. */
export const paymentWeek = (paidAt: string, weekStart?: string) =>
  weekStart ?? closingWeekStart(paidAt);

/** O profissional confere a semana que viu (hash) — nunca valor sabidamente contestado. */
export async function confirmWeek(
  tx: Tx,
  actor: ActorContext,
  input: { userId: string; weekStart: string; hash: string; deviceId: string | null },
) {
  await lockWeek(tx, input.userId, input.weekStart);
  await markStaleRequests(tx, actor, { beneficiaryUserId: input.userId });
  const b = await build(tx, input.weekStart);
  const lines = payableLines(personItems(b, input.userId));
  if (!lines.length) throw Errors.business('Nada a conferir nesta semana.');
  const pending = await pendingRequestCodes(tx, input.userId, lines);
  if (pending.length)
    throw Errors.business(
      `Há pedido de alteração pendente (${pending.join(', ')}): aguarde a decisão do gestor antes de confirmar a semana.`,
    );
  const hash = hashOf(input.userId, input.weekStart, lines);
  if (hash !== input.hash)
    throw Errors.conflict('Os valores mudaram desde que você abriu a semana: confira de novo.');
  const same = await tx.weeklyClosingConfirmation.findFirst({
    where: {
      beneficiaryUserId: input.userId,
      weekStart: weekDate(input.weekStart),
      kind: 'PROFISSIONAL',
      hash,
    },
  });
  if (same) return same;
  const row = await tx.weeklyClosingConfirmation.create({
    data: {
      beneficiaryUserId: input.userId,
      weekStart: weekDate(input.weekStart),
      kind: 'PROFISSIONAL',
      items: lines as unknown as Prisma.InputJsonValue,
      totalCents: lines.reduce((a, l) => a + l.dueCents, 0),
      hash,
      createdById: actor.userId,
      sessionId: actor.sessionId,
      deviceId: input.deviceId,
    },
  });
  const code = confirmationCode(row.number);
  await audit(tx, actor, {
    action: 'finance.week_confirmed',
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    summary: `${code}: semana ${input.weekStart} conferida pelo profissional (${lines.length} item(ns)).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    kind: 'CONFIRMADA',
    note: `Semana ${input.weekStart}`,
    data: { hash, items: lines.length },
  });
  return row;
}

/** Exceção administrativa: libera exatamente estas linhas desta pessoa e semana (com motivo). */
export async function createException(
  tx: Tx,
  actor: ActorContext,
  weekStart: string,
  input: z.output<typeof exceptionSchema>,
) {
  await lockWeek(tx, input.beneficiaryUserId, weekStart);
  const b = await build(tx, weekStart);
  const mine = personItems(b, input.beneficiaryUserId);
  let lines: ConfirmationLine[];
  if (input.itemIds?.length) {
    const ids = new Set(input.itemIds);
    const chosen = mine.filter((i) => ids.has(i.id));
    if (chosen.length !== ids.size)
      throw Errors.business('Há item que não é desta pessoa nesta semana.');
    if (chosen.some((i) => i.state === 'EM_REVISAO'))
      throw Errors.business('Item em revisão financeira: resolva a revisão antes de liberar.');
    lines = chosen.map(confirmationLine);
  } else lines = payableLines(mine);
  if (!lines.length) throw Errors.business('Nada a liberar para esta pessoa nesta semana.');
  const hash = hashOf(input.beneficiaryUserId, weekStart, lines);
  const row = await tx.weeklyClosingConfirmation.create({
    data: {
      beneficiaryUserId: input.beneficiaryUserId,
      weekStart: weekDate(weekStart),
      kind: 'EXCECAO_ADMINISTRATIVA',
      items: lines as unknown as Prisma.InputJsonValue,
      totalCents: lines.reduce((a, l) => a + l.dueCents, 0),
      hash,
      reason: input.reason,
      publicNote: input.publicNote?.trim() || 'Pagamento liberado administrativamente.',
      createdById: actor.userId,
      sessionId: actor.sessionId,
    },
  });
  const code = confirmationCode(row.number);
  await audit(tx, actor, {
    action: 'finance.week_exception',
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    summary: `${code}: exceção administrativa da semana ${weekStart} (${lines.map((l) => l.code).join(', ')}) — ${input.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    kind: 'EXCECAO_ADMINISTRATIVA',
    note: input.reason,
    data: { hash, items: lines.map((l) => l.code) },
  });
  return row;
}

export const exceptionSchema = z.object({
  beneficiaryUserId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Informe o motivo da exceção.').max(500),
  /** Texto que o profissional vê (neutro); padrão: "Pagamento liberado administrativamente." */
  publicNote: z.string().trim().max(300).optional().nullable(),
  /** Itens exatos (antecipação); ausente = tudo o que está devido na semana. */
  itemIds: z.array(z.string().uuid()).max(200).optional(),
});
const confirmSchema = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Confirmação explícita final ("Conferi os itens e valores"). */
  confirm: z.literal(true),
});

export async function confirmationRoutes(app: FastifyInstance) {
  const { prisma, hashToken } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn, { timeout: 60_000 });

  /** Tablet (D12): o profissional confirma a semana que conferiu. */
  app.post(
    '/api/v1/finance/my-earnings/confirm',
    { config: { access: OWN_EARNINGS, idempotent: true } },
    async (request, reply) => {
      const auth = request.auth!;
      if (!unlockValid(hashToken, auth, request.headers[UNLOCK_HEADER]))
        throw Errors.forbidden('Confirme seu PIN para ver seus ganhos.');
      const input = confirmSchema.parse(request.body);
      const { week } = myEarningsQuerySchema.parse({ week: input.week });
      const row = await tx((t) =>
        confirmWeek(t, actorFrom(request), {
          userId: auth.userId,
          weekStart: week!,
          hash: input.hash,
          deviceId: auth.deviceId,
        }),
      );
      void reply.header('cache-control', 'no-store');
      return {
        code: confirmationCode(row.number),
        weekStart: dateOnly(row.weekStart),
        createdAt: row.createdAt.toISOString(),
      };
    },
  );

  /** Gestor: exceção administrativa (motivo obrigatório; não finge ser a confirmação). */
  app.post(
    '/api/v1/finance/weekly-closings/:weekStart/exceptions',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const { weekStart } = weekStartParamsSchema.parse(request.params);
      const input = exceptionSchema.parse(request.body);
      const row = await tx((t) => createException(t, actorFrom(request), weekStart, input));
      return reply.status(201).send({
        code: confirmationCode(row.number),
        confirmation: await weekConfirmation(prisma, input.beneficiaryUserId, weekStart),
      });
    },
  );
}
