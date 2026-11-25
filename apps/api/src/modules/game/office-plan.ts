/**
 * Semana da produção (Gerente, 2026-11-25): a OS com material comprado e sem planejamento
 * ganha a proposta completa — data de início (hoje, se for dia útil; senão o próximo) e o
 * tapeceiro de cada peça (o titular que já está na peça, ou o tapeceiro com menos serviço aberto).
 * Aprovar (ou o Gerente sozinho, se liberado) planeja pelo mesmo caminho da tela "Semana da
 * oficina": tarefas em rascunho, fila pela data de início, nada publicado sem o dono.
 */
import { formatServiceOrderItemCode, holidayOf, planServicesSchema } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { workers } from '../production/plans';
import { activeTemplates, planServicesTx, templateOf } from '../production/pre-planning';

type Db = PrismaClient | Tx;

export interface PlanEntry {
  serviceOrderId: string;
  startDate: string;
  pieces: { serviceOrderItemId: string; upholstererUserId: string }[];
}

const isWorkday = (iso: string) => {
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidayOf(iso);
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export function firstWorkday(from: string) {
  let d = from;
  for (let i = 0; i < 10 && !isWorkday(d); i++) d = addDays(d, 1);
  return d;
}

/**
 * Proposta completa para uma OS, ou o motivo de não dar ainda (material não comprado, sem
 * tapeceiro cadastrado). As linhas explicam ao dono quem fica com cada peça.
 */
export async function planEntryFor(
  db: Db,
  serviceOrderId: string,
  today: string,
): Promise<{ entry: PlanEntry; lines: string[] } | { problem: string }> {
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { upholsterer: { select: { displayName: true } } },
      },
    },
  });
  if (!so) return { problem: 'A OS não existe mais.' };
  if (!so.materialPurchasedAt)
    return { problem: 'O material ainda não foi comprado: dá para planejar quando chegar.' };
  const [templates, people] = await Promise.all([activeTemplates(db), workers(db)]);
  const tapeceiros = people.filter((w) => w.isTapeceiro);
  // Carga de cada tapeceiro: tarefas abertas (não concluídas nem canceladas).
  const load = new Map<string, number>();
  if (tapeceiros.length) {
    const open = await db.productionTask.groupBy({
      by: ['assigneeUserId'],
      where: {
        assigneeUserId: { in: tapeceiros.map((t) => t.userId) },
        status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      },
      _count: { _all: true },
    });
    for (const o of open) if (o.assigneeUserId) load.set(o.assigneeUserId, o._count._all);
  }
  const pieces: PlanEntry['pieces'] = [];
  const lines: string[] = [];
  for (const i of so.items) {
    const tpl = templateOf(templates, i);
    const needs = Boolean(tpl?.steps.some((s) => s.stepClass === 'TAPECARIA'));
    const code = formatServiceOrderItemCode(so.number, i.position);
    if (!needs) continue;
    if (i.upholstererUserId) {
      lines.push(
        `${code} ${i.description}: ${i.upholsterer?.displayName ?? 'titular'} (já era o titular)`,
      );
      continue;
    }
    const pick = [...tapeceiros].sort(
      (a, b) =>
        (load.get(a.userId) ?? 0) - (load.get(b.userId) ?? 0) ||
        a.displayName.localeCompare(b.displayName),
    )[0];
    if (!pick) return { problem: 'Não há tapeceiro cadastrado para ficar com as peças.' };
    // A peça escolhida entra na conta do próximo (espalha as peças entre os tapeceiros).
    load.set(pick.userId, (load.get(pick.userId) ?? 0) + (tpl?.steps.length ?? 1));
    pieces.push({ serviceOrderItemId: i.id, upholstererUserId: pick.userId });
    lines.push(`${code} ${i.description}: ${pick.displayName} (com menos serviço agora)`);
  }
  return {
    entry: { serviceOrderId: so.id, startDate: firstWorkday(today), pieces },
    lines,
  };
}

/** Aprovar: planeja a OS na semana (data do dono, se ele mudou). */
export async function planApprovedService(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown },
  edits: { scheduledDate?: string } | undefined,
  today: string,
) {
  if (!perms.has('producao.planejar'))
    throw Errors.forbidden('Planejar a semana exige a permissão de planejar a produção.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const entry = pl.entry as PlanEntry | undefined;
  if (!entry) throw Errors.business('Planeje esta OS na Semana da oficina.');
  const startDate =
    edits?.scheduledDate && edits.scheduledDate >= today ? edits.scheduledDate : entry.startDate;
  const r = await planServicesTx(
    tx,
    actor,
    planServicesSchema.parse({
      entries: [{ ...entry, startDate: startDate < today ? firstWorkday(today) : startDate }],
    }),
  );
  return r.planned[0]!;
}
