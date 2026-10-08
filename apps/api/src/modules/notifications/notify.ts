import {
  EVENT_TYPES,
  NOTIFICATION_KIND_LABEL,
  taskCode,
  type NotificationKind,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  /** Chave de deduplicação (única por usuário): repetir o mesmo fato não cria outra notificação. */
  dedupeKey: string;
  body: string;
  taskId?: string | null;
  serviceOrderId?: string | null;
  /** Avisar mesmo quem causou a mudança (ex.: a própria conclusão liberou a próxima tarefa). */
  includeActor?: boolean;
}

/**
 * Grava notificações persistentes na mesma transação da mudança que as originou
 * e publica `notification.created` só para o destinatário (o tablet atualiza a
 * caixa em tempo real; após reconexão, o evento é reenviado ou a lista recarregada).
 * Quem fez a ação não é notificado sobre a própria ação.
 */
export async function notify(tx: Tx, actor: ActorContext, items: NotificationInput[]) {
  for (const n of items) {
    if (!n.userId || (n.userId === actor.userId && !n.includeActor)) continue;
    const created = await tx.notification.createMany({
      data: [
        {
          userId: n.userId,
          kind: n.kind,
          title: NOTIFICATION_KIND_LABEL[n.kind],
          body: n.body.slice(0, 300),
          taskId: n.taskId ?? null,
          serviceOrderId: n.serviceOrderId ?? null,
          dedupeKey: n.dedupeKey.slice(0, 160),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) continue;
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.NOTIFICATION_CREATED,
      aggregateType: 'notification',
      aggregateId: n.userId,
      payload: { kind: n.kind, taskId: n.taskId ?? null },
      audience: `user:${n.userId}`,
    });
  }
}

type TaskLike = {
  id: string;
  number: number;
  title: string;
  version: number;
  status: string;
  assigneeUserId: string | null;
  serviceOrderId: string;
};

/** Notificação de uma tarefa para o responsável atual (ou outro usuário). */
export function taskNotice(
  t: TaskLike,
  kind: NotificationKind,
  body: string,
  userId: string | null = t.assigneeUserId,
): NotificationInput[] {
  if (!userId || t.status === 'RASCUNHO') return [];
  return [
    {
      userId,
      kind,
      // Atribuição e liberação na mesma versão (ex.: publicação) geram um único aviso.
      dedupeKey: `${kind === 'TAREFA_ATRIBUIDA' || kind === 'TAREFA_LIBERADA' ? 'ENTRADA' : kind}:${t.id}:${t.version}:${userId}`,
      body: `${taskCode(t.number)} · ${t.title} — ${body}`,
      taskId: t.id,
      serviceOrderId: t.serviceOrderId,
      includeActor: kind === 'TAREFA_LIBERADA',
    },
  ];
}
