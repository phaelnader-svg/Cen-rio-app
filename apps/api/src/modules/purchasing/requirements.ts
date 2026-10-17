import type { Prisma, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { BUYABLE_ORIGINS, lockRows, refreshReadiness } from './common';

/**
 * Etapa 2 (compras sem duplicidade) — ciclo de vida das necessidades sem apagar histórico.
 * Nenhuma compra, recebimento, reserva, movimento, sobra ou custo é alterado aqui: só o estado
 * operacional da necessidade e os vínculos operacionais tarefa ↔ material.
 */

/**
 * Cancela (CANCELADA, com motivo e autor) as necessidades ATIVAS aprovadas que atendem ao filtro.
 * Bloqueia as linhas e relê sob bloqueio: concorrente que já as encerrou não é sobrescrito. Os
 * vínculos de tarefas com essas necessidades são removidos (auditado) para que nenhuma tarefa fique
 * presa a um material que não existe mais. Devolve os ids cancelados.
 */
export async function cancelRequirements(
  tx: Tx,
  actor: ActorContext,
  where: Prisma.MaterialRequirementWhereInput,
  reason: string,
  opts: { refresh?: boolean } = {},
) {
  const found = await tx.materialRequirement.findMany({
    where: { ...where, origin: { in: [...BUYABLE_ORIGINS] }, status: 'ATIVA' },
    select: { id: true },
  });
  if (!found.length) return [] as string[];
  await lockRows(
    tx,
    'material_requirements',
    found.map((r) => r.id),
  );
  const rows = await tx.materialRequirement.findMany({
    where: { id: { in: found.map((r) => r.id) }, status: 'ATIVA' },
  });
  const now = new Date();
  for (const r of rows) {
    await tx.materialRequirement.update({
      where: { id: r.id },
      data: {
        status: 'CANCELADA',
        closedAt: now,
        closedById: actor.userId,
        closeReason: reason.slice(0, 500),
      },
    });
    await unlinkTasks(tx, actor, r.id, `necessidade cancelada: ${reason}`);
  }
  if (rows.length) {
    const first = rows[0]!;
    await audit(tx, actor, {
      action: 'material_requirement.cancelled',
      // Previsão pré-OS (Etapa 3): o histórico fica na peça do pedido.
      entityType: first.serviceOrderId ? 'service_order' : 'commercial_order_item',
      entityId: first.serviceOrderId ?? first.orderItemId!,
      summary: `${rows.length} necessidade(s) de material cancelada(s): ${reason}`.slice(0, 500),
      changes: { requirements: rows.map((r) => r.id), reason },
    });
    if (opts.refresh !== false)
      await refreshReadiness(tx, actor, [
        ...new Set(rows.flatMap((r) => (r.serviceOrderId ? [r.serviceOrderId] : []))),
      ]);
  }
  return rows.map((r) => r.id);
}

/** Remove os vínculos tarefa ↔ necessidade (configuração operacional; o histórico fica na auditoria). */
async function unlinkTasks(tx: Tx, actor: ActorContext, requirementId: string, reason: string) {
  const links = await tx.productionTaskMaterial.findMany({ where: { requirementId } });
  if (!links.length) return;
  await tx.productionTaskMaterial.deleteMany({ where: { requirementId } });
  await audit(tx, actor, {
    action: 'production_task.materials_unlinked',
    entityType: 'material_requirement',
    entityId: requirementId,
    summary: `Vínculo de ${links.length} tarefa(s) com o material removido (${reason}).`.slice(
      0,
      500,
    ),
    changes: { tasks: links.map((l) => l.taskId) },
  });
}

/**
 * A sucessora passa a responder pelas tarefas que dependiam da predecessora (a tarefa espera o
 * material que substituiu o anterior). Se a tarefa já dependia da sucessora, só o vínculo antigo sai.
 */
export async function moveTaskLinks(tx: Tx, actor: ActorContext, fromId: string, toId: string) {
  const links = await tx.productionTaskMaterial.findMany({ where: { requirementId: fromId } });
  if (!links.length) return;
  await tx.productionTaskMaterial.createMany({
    data: links.map((l) => ({ taskId: l.taskId, requirementId: toId })),
    skipDuplicates: true,
  });
  await tx.productionTaskMaterial.deleteMany({ where: { requirementId: fromId } });
  await audit(tx, actor, {
    action: 'production_task.materials_moved',
    entityType: 'material_requirement',
    entityId: fromId,
    summary: `Vínculo de ${links.length} tarefa(s) passou para a necessidade que substituiu esta.`,
    changes: { tasks: links.map((l) => l.taskId), from: fromId, to: toId },
  });
}

/** Exige necessidade ATIVA para qualquer vínculo novo (compra, reserva, sobra): 409 se mudou. */
export function assertActiveRequirement(
  r: { status: string } | null | undefined,
  what = 'A necessidade de material',
) {
  if (r && r.status !== 'ATIVA')
    throw Errors.conflict(
      `${what} foi ${r.status === 'SUBSTITUIDA' ? 'substituída por uma nova medição' : 'cancelada'}. Atualize a tela e use a necessidade atual.`,
      { status: r.status },
    );
}
