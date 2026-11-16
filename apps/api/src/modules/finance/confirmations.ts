/**
 * R2 — confirmação semanal do profissional, exceção administrativa e portão de pagamento (D13).
 *
 * A confirmação é um retrato imutável (`weekly_closing_confirmations`) das linhas que o
 * profissional conferiu, calculadas da MESMA fonte do fechamento e do "Meus Ganhos"
 * (`buildClosingItems`). Nada é copiado para uma segunda fonte: a validade é recalculada ao vivo
 * comparando cada linha confirmada com a linha atual.
 *
 * D13: todo pagamento de profissional (direto, parcial, em lote, conta a pagar da viagem,
 * antecipado) só passa se a semana estiver coberta por uma confirmação do profissional VIGENTE
 * (retrato idêntico ao estado atual da semana: mudou qualquer item/valor, ou entrou item novo →
 * a confirmação inteira deixa de valer) ou se a linha estiver numa exceção administrativa
 * (motivo + gestor + linhas exatas; cobertura linha a linha, inalterada). Pagamentos da própria
 * semana não fazem parte da linha: pagar em parte não invalida a confirmação.
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
import { OWN_EARNINGS, UNLOCK_HEADER, unlockEvidence } from './my-earnings';
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

type CoverageRow = { kind: string; hash: string; items: Prisma.JsonValue };

/**
 * Situação da semana do profissional a partir das linhas atuais e das conferências gravadas
 * (mais recentes primeiro): a MESMA regra do tablet, do fechamento e da Central.
 */
export function confirmationState<R extends CoverageRow>(
  userId: string,
  weekStart: string,
  lines: readonly ConfirmationLine[],
  rows: readonly R[],
) {
  const currentHash = lines.length ? hashOf(userId, weekStart, lines) : null;
  const match = currentHash ? rows.find((r) => r.hash === currentHash) : undefined;
  const state: WeekConfirmationDto['state'] = !lines.length
    ? 'SEM_ITENS'
    : match
      ? match.kind === 'PROFISSIONAL'
        ? 'CONFIRMADA'
        : 'LIBERADA_POR_EXCECAO'
      : rows.length
        ? 'DESATUALIZADA'
        : 'SEM_CONFIRMACAO';
  return { state, currentHash, match };
}

/**
 * Portão D13 (regra única): a conferência que cobre a linha atual do item — a do profissional
 * só se o retrato for exatamente o estado atual da semana inteira (`payHash`); a exceção
 * administrativa, linha a linha.
 */
export const coveringRow = <R extends CoverageRow>(
  rows: readonly R[],
  payHash: string,
  line: ConfirmationLine,
) =>
  rows.find((r) =>
    r.kind === 'PROFISSIONAL' ? r.hash === payHash : linesOf(r).some((l) => sameLine(l, line)),
  );

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
  const { state, currentHash, match } = confirmationState(userId, weekStart, lines, rows);
  const latest = match ?? rows[0] ?? null;
  const changed: string[] = [];
  if (latest && !match) {
    const before = linesOf(latest);
    for (const l of lines) if (!before.some((x) => sameLine(x, l))) changed.push(l.code);
    for (const x of before)
      if (!lines.some((l) => l.id === x.id) && !changed.includes(x.code)) changed.push(x.code);
  }
  const history = await historyOf(
    db,
    rows,
    personItems(b, userId).map(confirmationLine),
    lines,
    currentHash,
  );
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
    history,
  };
}

type ConfirmationRow = {
  id: string;
  number: number;
  kind: string;
  items: Prisma.JsonValue;
  totalCents: number;
  hash: string;
  createdAt: Date;
};

/** Linhas de um retrato que não conferem mais com as linhas atuais da pessoa na semana. */
const staleCodes = (row: ConfirmationRow, current: readonly ConfirmationLine[]) =>
  linesOf(row)
    .filter((x) => !current.some((l) => sameLine(x, l)))
    .map((x) => x.code)
    .sort();

/**
 * O que difere do retrato: linhas que mudaram/sumiram e, na confirmação do profissional (que
 * cobre a semana inteira), também os itens que entraram no fechamento depois dela.
 */
const changedCodes = (
  row: ConfirmationRow,
  current: readonly ConfirmationLine[],
  payable: readonly ConfirmationLine[],
) => {
  const out = new Set(staleCodes(row, current));
  if (row.kind === 'PROFISSIONAL') {
    const mine = linesOf(row);
    for (const l of payable) if (!mine.some((x) => x.id === l.id)) out.add(l.code);
  }
  return [...out].sort();
};

/**
 * F9-03/F9-06: histórico das conferências da semana. A validade é a mesma do portão D13 (linha a
 * linha, ao vivo); a versão do fechamento e a invalidação vêm dos eventos financeiros já
 * existentes (`financial_events`) — nada é recalculado para o passado nem inventado.
 */
async function historyOf(
  db: Db,
  rows: ConfirmationRow[],
  current: readonly ConfirmationLine[],
  payable: readonly ConfirmationLine[],
  currentHash: string | null,
): Promise<WeekConfirmationDto['history']> {
  if (!rows.length) return [];
  const events = await db.financialEvent.findMany({
    where: {
      entityType: 'weekly_closing_confirmation',
      entityId: { in: rows.map((r) => r.id) },
      kind: { in: ['CONFIRMADA', 'EXCECAO_ADMINISTRATIVA', 'INVALIDADA'] },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => {
    const mine = events.filter((e) => e.entityId === r.id);
    const created = mine.find((e) => e.kind !== 'INVALIDADA');
    const invalid = mine.find((e) => e.kind === 'INVALIDADA');
    const changed = changedCodes(r, current, payable);
    const total = linesOf(r).length;
    const closingVersion = (created?.data as { closingVersion?: number | null } | null)
      ?.closingVersion;
    return {
      code: confirmationCode(r.number),
      kind: r.kind as 'PROFISSIONAL' | 'EXCECAO_ADMINISTRATIVA',
      createdAt: r.createdAt.toISOString(),
      totalCents: r.totalCents,
      hash: r.hash,
      closingVersion: typeof closingVersion === 'number' ? closingVersion : null,
      status:
        r.kind === 'PROFISSIONAL'
          ? r.hash === currentHash
            ? 'VIGENTE'
            : 'INVALIDA'
          : r.hash === currentHash || !changed.length
            ? 'VIGENTE'
            : changed.length < total
              ? 'EM_PARTE'
              : 'INVALIDA',
      changed,
      invalidatedAt: invalid?.createdAt.toISOString() ?? null,
      invalidatedBy: (invalid?.data as { by?: string } | null)?.by ?? null,
    };
  });
}

/**
 * Versão do fechamento semanal do gestor no momento da conferência (null = semana ainda não
 * conferida pelo gestor). Gravada no evento financeiro da própria conferência.
 */
async function closingStamp(tx: Tx, weekStart: string) {
  const c = await tx.weeklyClosing.findUnique({
    where: { weekStart: weekDate(weekStart) },
    select: { version: true, status: true },
  });
  return { closingVersion: c?.version ?? null, closingStatus: c?.status ?? null };
}

/**
 * F9-06: ao registrar uma nova conferência, as anteriores desta pessoa e semana cujo retrato não
 * confere mais com o estado atual ganham o registro de invalidação (quando e por qual conferência
 * isso foi constatado). Uma vez só por conferência; as linhas antigas continuam intactas.
 */
async function recordInvalidations(
  tx: Tx,
  actor: ActorContext,
  input: { userId: string; weekStart: string; byId: string; byCode: string },
  current: readonly ConfirmationLine[],
  payable: readonly ConfirmationLine[],
) {
  const payHash = hashOf(input.userId, input.weekStart, payable);
  const older = await tx.weeklyClosingConfirmation.findMany({
    where: {
      beneficiaryUserId: input.userId,
      weekStart: weekDate(input.weekStart),
      id: { not: input.byId },
    },
  });
  if (!older.length) return;
  const already = new Set(
    (
      await tx.financialEvent.findMany({
        where: {
          entityType: 'weekly_closing_confirmation',
          entityId: { in: older.map((o) => o.id) },
          kind: 'INVALIDADA',
        },
        select: { entityId: true },
      })
    ).map((e) => e.entityId),
  );
  for (const o of older) {
    if (already.has(o.id)) continue;
    const changed = changedCodes(o, current, payable);
    // Profissional: vale inteira só se o retrato é exatamente o estado atual da semana.
    const invalid = o.kind === 'PROFISSIONAL' ? o.hash !== payHash : changed.length > 0;
    if (!invalid) continue;
    await financeEvent(tx, actor, {
      entityType: 'weekly_closing_confirmation',
      entityId: o.id,
      kind: 'INVALIDADA',
      note: `${confirmationCode(o.number)}: valores mudaram (${changed.join(', ')}); constatado na conferência ${input.byCode}.`,
      data: { by: input.byCode, byId: input.byId, changed },
    });
  }
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
  // Decisão do proprietário (Rodada 1): a confirmação do profissional vale INTEIRA ou não vale —
  // qualquer item/valor do retrato que mudar (ou item novo no fechamento da semana) invalida tudo,
  // inclusive as linhas que não mudaram. A exceção administrativa segue linha a linha, como antes.
  const payHash = hashOf(input.userId, input.weekStart, payableLines(personItems(b, input.userId)));
  const hit = coveringRow(rows, payHash, line);
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

/**
 * Rodada 2 (F10-11/F10-12) — a semana de TODOS os profissionais numa leitura só, com as mesmas
 * regras do tablet/fechamento (`confirmationState`) e do portão D13 (`coveringRow`):
 * - `state`: situação da conferência (SEM_CONFIRMACAO/DESATUALIZADA pedem a confirmação);
 * - `available`: o que já pode ser pago — item DEVIDO da semana (ou saldo anterior), pagável
 *   (obrigação vinculada, sem revisão), com saldo atual e coberto por confirmação VIGENTE do
 *   profissional ou por exceção administrativa (linha a linha). Recebedor inativo não recebe.
 * Nada é gravado; nenhum valor novo é calculado — as linhas são as de `buildClosingItems`.
 */
export async function weekCoverage(db: Db, weekStart: string, built?: Built) {
  const b = built ?? (await build(db, weekStart));
  const people = new Map<string, string>();
  for (const i of b.items)
    if (i.beneficiary.userId) people.set(i.beneficiary.userId, i.beneficiary.displayName);
  const ids = [...people.keys()];
  const [rows, active] = await Promise.all([
    db.weeklyClosingConfirmation.findMany({
      where: { weekStart: weekDate(weekStart), beneficiaryUserId: { in: ids } },
      orderBy: { createdAt: 'desc' },
    }),
    db.user.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } }),
  ]);
  const activeIds = new Set(active.map((u) => u.id));
  return ids.map((userId) => {
    const mine = personItems(b, userId);
    const lines = payableLines(mine);
    const own = rows.filter((r) => r.beneficiaryUserId === userId);
    const { state } = confirmationState(userId, weekStart, lines, own);
    const payHash = hashOf(userId, weekStart, lines);
    const available = activeIds.has(userId)
      ? mine.filter(
          (i) =>
            i.payable &&
            i.currentOpenCents > 0 &&
            (i.bucket === 'WEEK' || i.bucket === 'PREVIOUS') &&
            coveringRow(own, payHash, confirmationLine(i)),
        )
      : [];
    return { userId, displayName: people.get(userId)!, state, available };
  });
}

/** Semana do pagamento: a do lote, ou a da data efetiva do pagamento. */
export const paymentWeek = (paidAt: string, weekStart?: string) =>
  weekStart ?? closingWeekStart(paidAt);

/** O profissional confere a semana que viu (hash) — nunca valor sabidamente contestado. */
/** F10-20b: a última conferência (ou exceção) da pessoa na semana — o "antes" da auditoria. */
async function previousConfirmation(tx: Tx, userId: string, weekStart: string) {
  const r = await tx.weeklyClosingConfirmation.findFirst({
    where: { beneficiaryUserId: userId, weekStart: weekDate(weekStart) },
    orderBy: { createdAt: 'desc' },
  });
  return r ? { kind: r.kind, code: confirmationCode(r.number), hash: r.hash } : null;
}

export async function confirmWeek(
  tx: Tx,
  actor: ActorContext,
  input: {
    userId: string;
    weekStart: string;
    hash: string;
    deviceId: string | null;
    /** F9-02: prova do desbloqueio D12 (método e validade; nunca o PIN nem o token). */
    verification?: { method: 'PIN_D12'; unlockExpiresAt: string } | null;
  },
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
  const stamp = await closingStamp(tx, input.weekStart);
  const prior = await previousConfirmation(tx, input.userId, input.weekStart);
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
    changes: {
      before: prior,
      after: { kind: 'PROFISSIONAL', code, items: lines.map((l) => l.code), hash },
      verification: input.verification ?? null,
      sessionId: actor.sessionId,
      deviceId: input.deviceId,
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    kind: 'CONFIRMADA',
    note: `Semana ${input.weekStart}`,
    data: { hash, items: lines.length, ...stamp, verification: input.verification ?? null },
  });
  await recordInvalidations(
    tx,
    actor,
    { userId: input.userId, weekStart: input.weekStart, byId: row.id, byCode: code },
    personItems(b, input.userId).map(confirmationLine),
    lines,
  );
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
  const stamp = await closingStamp(tx, weekStart);
  const prior = await previousConfirmation(tx, input.beneficiaryUserId, weekStart);
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
    // F10-20b: o que valia antes (última conferência/exceção) e o que passa a valer.
    changes: {
      before: prior,
      after: { kind: 'EXCECAO_ADMINISTRATIVA', code, items: lines.map((l) => l.code), hash },
      reason: input.reason,
    },
  });
  await financeEvent(tx, actor, {
    entityType: 'weekly_closing_confirmation',
    entityId: row.id,
    kind: 'EXCECAO_ADMINISTRATIVA',
    note: input.reason,
    data: { hash, items: lines.map((l) => l.code), ...stamp },
  });
  await recordInvalidations(
    tx,
    actor,
    { userId: input.beneficiaryUserId, weekStart, byId: row.id, byCode: code },
    mine.map(confirmationLine),
    payableLines(mine),
  );
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
      const verification = unlockEvidence(hashToken, auth, request.headers[UNLOCK_HEADER]);
      if (!verification) throw Errors.forbidden('Confirme seu PIN para ver seus ganhos.');
      const input = confirmSchema.parse(request.body);
      const { week } = myEarningsQuerySchema.parse({ week: input.week });
      const row = await tx((t) =>
        confirmWeek(t, actorFrom(request), {
          userId: auth.userId,
          weekStart: week!,
          hash: input.hash,
          deviceId: auth.deviceId,
          verification,
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
