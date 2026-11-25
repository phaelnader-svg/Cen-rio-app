/** Agendar a entrega da peça pronta (tarefa do Atendimento): texto e aprovação. */
import { customerMessage } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { assertModuleEnabled } from '../../core/modules';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { createDelivery } from '../quality/shipping';
import { companyName } from './agent-office';

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string) => iso.split('-').reverse().join('/');

export function deliveryText(
  company: string,
  customerName: string,
  piece: string,
  osNumber: number,
  date: string,
  windowStart: string,
  openCents: number,
) {
  return customerMessage({
    kind: 'ENTREGA_AGENDADA',
    customerName,
    companyName: company,
    piece,
    code: serviceOrderCode(osNumber),
    date: `${br(date)} a partir das ${windowStart}`,
    balance: openCents > 0 ? brl(openCents) : null,
  });
}

// ───────────────────────────── Agendar a entrega (aprovação) ─────────────────────────────

/**
 * Aprovar "agendar a entrega": cria a entrega no dia e horário escolhidos (as peças continuam
 * conferidas pela regra da entrega) e ajusta a mensagem ao cliente para a data final.
 */
export async function scheduleApprovedDelivery(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown },
  edits:
    | { text?: string; scheduledDate?: string; windowStart?: string; windowEnd?: string }
    | undefined,
) {
  if (!perms.has('entregas.gerenciar'))
    throw Errors.forbidden('Agendar a entrega exige a permissão de entregas.');
  await assertModuleEnabled(tx, 'logistica');
  const pl = { ...((p.payload ?? {}) as Record<string, unknown>) };
  const scheduledDate = edits?.scheduledDate ?? String(pl.scheduledDate);
  const windowStart = edits?.windowStart ?? String(pl.windowStart ?? '09:00');
  const windowEnd = edits?.windowEnd ?? (pl.windowEnd ? String(pl.windowEnd) : null);
  const d = await createDelivery(tx, actor, {
    customerId: String(pl.customerId),
    scheduledDate,
    windowStart,
    windowEnd,
    team: 'EQUIPE_PROPRIA',
    requiresInstallation: false,
    itemIds: (pl.itemIds as string[]) ?? [],
    provisional: false,
  });
  const changed = scheduledDate !== pl.scheduledDate || windowStart !== (pl.windowStart ?? '09:00');
  const text =
    edits?.text ??
    (changed
      ? deliveryText(
          await companyName(tx),
          String(pl.customerName ?? ''),
          String(pl.piece ?? 'o seu pedido'),
          Number(pl.osNumber ?? 0),
          scheduledDate,
          windowStart,
          Number(pl.openCents ?? 0),
        )
      : undefined);
  return { deliveryId: d.id, scheduledDate, windowStart, windowEnd, text };
}
