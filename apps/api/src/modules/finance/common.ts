import { anyPermissionAudience, type EventType } from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';

/**
 * Fase 11 — financeiro operacional. Tudo do gestor (sessão do painel); o profissional por
 * produção vê só os próprios valores quando o gestor concede `financeiro.producao_propria`.
 */
export const FIN_VIEW = { session: 'WEB', permissions: ['financeiro.ver'] } as const;
export const FIN_MANAGE = {
  session: 'WEB',
  permissions: ['financeiro.ver', 'financeiro.gerenciar'],
} as const;
export const FIN_ADJUST = {
  session: 'WEB',
  permissions: ['financeiro.ver', 'financeiro.ajustes'],
} as const;
export const FIN_OWN = { session: 'any', permissions: ['financeiro.producao_propria'] } as const;

/** Eventos financeiros só para quem vê o financeiro (nunca para os tablets da produção). */
export const FINANCE_AUDIENCE = anyPermissionAudience('financeiro.ver');

export const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const todayIso = (timeZone = 'America/Sao_Paulo') =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

export async function lockRow(tx: Tx, table: string, id: string, what: string) {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "${table}" WHERE id = $1::uuid FOR UPDATE`,
    id,
  );
  if (!rows.length) throw Errors.notFound(what);
}

export function checkVersion(row: { version: number }, version: number) {
  if (row.version !== version) throw Errors.versionConflict(row.version);
}

/** Histórico financeiro imutável + evento de domínio (sem valores no payload). */
export async function financeEvent(
  tx: Tx,
  actor: ActorContext,
  entry: {
    entityType: string;
    entityId: string;
    kind: string;
    note?: string | null;
    data?: unknown;
    type?: EventType;
    status?: string;
  },
) {
  await tx.financialEvent.create({
    data: {
      entityType: entry.entityType,
      entityId: entry.entityId,
      kind: entry.kind,
      note: entry.note?.slice(0, 1000) ?? null,
      data: (entry.data as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
    },
  });
  if (entry.type) {
    await appendEvent(tx, actor, {
      type: entry.type,
      aggregateType: entry.entityType,
      aggregateId: entry.entityId,
      payload: { id: entry.entityId, kind: entry.kind, status: entry.status ?? null },
      audience: FINANCE_AUDIENCE,
    });
  }
}

export async function historyOf(db: Tx | PrismaClient, entityType: string, entityId: string) {
  const rows = await db.financialEvent.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: 'asc' },
  });
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    note: r.note,
    actor: r.actorId ? (users.get(r.actorId) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Período [from, to] (datas locais); padrão: mês corrente. */
export function period(q: { from?: string; to?: string }) {
  const today = todayIso();
  const from = q.from ?? `${today.slice(0, 7)}-01`;
  const to = q.to ?? today;
  if (to < from) throw Errors.validation(undefined, 'O fim do período é anterior ao início.');
  return {
    from,
    to,
    fromDate: parseDate(from),
    toDate: parseDate(to),
    /** Fim exclusivo para timestamps (dia seguinte, no fuso UTC-3 aproximado por data local). */
    toExclusive: new Date(parseDate(to).getTime() + 86_400_000 + 3 * 3_600_000),
    fromTs: new Date(parseDate(from).getTime() + 3 * 3_600_000),
  };
}
