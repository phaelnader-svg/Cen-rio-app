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
 * Quem fez a ação não é notificado sobre a própria ação. Repetir um fato já resolvido reativa o
 * aviso (a condição voltou).
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
    // F10-19: o mesmo fato voltou a acontecer depois de resolvido (ex.: peça "não entregue" volta a
    // ficar pronta) — o aviso volta a ficar ativo e não lido; um aviso ainda ativo não é tocado.
    const reopened = created.count
      ? 0
      : (
          await tx.notification.updateMany({
            where: {
              userId: n.userId,
              dedupeKey: n.dedupeKey.slice(0, 160),
              resolvedAt: { not: null },
            },
            data: { resolvedAt: null, readAt: null, body: n.body.slice(0, 300) },
          })
        ).count;
    if (created.count === 0 && reopened === 0) continue;
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.NOTIFICATION_CREATED,
      aggregateType: 'notification',
      aggregateId: n.userId,
      payload: { kind: n.kind, taskId: n.taskId ?? null },
      audience: `user:${n.userId}`,
    });
  }
}

/**
 * Rodada 2 (F10-19) — marca como RESOLVIDAS as notificações persistidas que pediam uma ação
 * sobre um assunto, chamada pela própria ação que resolve a condição (decisão, encerramento…),
 * na mesma transação. `subjects` são os prefixos da chave de deduplicação do assunto (ex.:
 * `VALOR:<id>` cobre `VALOR:<id>:<usuário>`), sempre junto com o tipo — avisos informativos do
 * mesmo assunto não são tocados. Idempotente e seguro sob concorrência: o UPDATE só alcança
 * linhas ainda ativas (a segunda chamada não muda nada nem publica evento). Nada é apagado; o
 * aviso continua no histórico ("resolvidas"). Cada destinatário recebe `notification.resolved`
 * (só para ele) para a caixa sair da lista ativa em tempo real.
 */
export async function resolveNotifications(
  tx: Tx,
  actor: ActorContext,
  kinds: NotificationKind | readonly NotificationKind[],
  subjects: readonly string[],
) {
  const list = (Array.isArray(kinds) ? kinds : [kinds]) as string[];
  if (!subjects.length || !list.length) return 0;
  const patterns = subjects.map((s) => `${s.replace(/[\\%_]/g, '\\$&')}:%`);
  const rows = await tx.$queryRaw<{ user_id: string }[]>`
    UPDATE notifications SET resolved_at = ${new Date()}
     WHERE resolved_at IS NULL
       AND kind = ANY(${list}::text[])
       AND (dedupe_key = ANY(${[...subjects]}::text[]) OR dedupe_key LIKE ANY(${patterns}::text[]))
    RETURNING user_id`;
  const users = [...new Set(rows.map((r) => r.user_id))];
  for (const userId of users)
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.NOTIFICATION_RESOLVED,
      aggregateType: 'notification',
      aggregateId: userId,
      payload: { count: rows.filter((r) => r.user_id === userId).length },
      audience: `user:${userId}`,
    });
  return rows.length;
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
