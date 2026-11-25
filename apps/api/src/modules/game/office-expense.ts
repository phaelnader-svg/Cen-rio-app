/**
 * Despesa pela foto (Financeiro, 2026-11-25): aprovar o que o agente leu do comprovante lança a
 * despesa (com a conta a pagar dela) e, se o comprovante mostra que já foi pago, dá a baixa.
 * Usado na aprovação do dono e quando o agente faz sozinho (nível 3 até o limite, ou 4).
 */
import { PAYMENT_METHODS, type PaymentMethod } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { assertCategory } from '../finance/categories';
import { createExpense, payPayable } from '../finance/payables';

export interface ExpenseEdits {
  amountCents?: number;
  date?: string;
  beneficiary?: string;
  description?: string;
  category?: string;
  paid?: boolean;
}

export async function launchApprovedExpense(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown },
  edits: ExpenseEdits | undefined,
) {
  if (!perms.has('financeiro.gerenciar'))
    throw Errors.forbidden('Lançar despesa exige a permissão de gerenciar o financeiro.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (pl.expenseId) throw Errors.conflict('Esta despesa já foi lançada.');
  const v = {
    amountCents: edits?.amountCents ?? Number(pl.totalCents ?? 0),
    date: edits?.date ?? String(pl.date ?? ''),
    beneficiary: (edits?.beneficiary ?? String(pl.beneficiary ?? '')).trim(),
    description: (edits?.description ?? String(pl.description ?? '')).trim(),
    category: edits?.category ?? String(pl.category ?? 'OUTRAS'),
    paid: edits?.paid ?? pl.paid === true,
  };
  if (!(v.amountCents > 0))
    throw Errors.validation(undefined, 'Falta o valor da despesa. Toque em Mudar e preencha.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date))
    throw Errors.validation(undefined, 'Falta a data da despesa. Toque em Mudar e preencha.');
  if (v.beneficiary.length < 2)
    throw Errors.validation(undefined, 'Falta quem recebeu. Toque em Mudar e preencha.');
  if (v.description.length < 2) v.description = `Despesa ${v.beneficiary}`.slice(0, 200);
  await assertCategory(tx, v.category, 'expense');
  const e = await createExpense(tx, actor, {
    category: v.category,
    description: v.description.slice(0, 200),
    amountCents: v.amountCents,
    competence: v.date.slice(0, 7),
    dueDate: v.date,
    beneficiary: v.beneficiary.slice(0, 160),
  });
  if (v.paid && e.payableId) {
    const method = (PAYMENT_METHODS as readonly string[]).includes(String(pl.method))
      ? (pl.method as PaymentMethod)
      : 'OUTRO';
    await payPayable(tx, actor, e.payableId, {
      amountCents: v.amountCents,
      paidAt: v.date,
      method,
      note: 'Pago conforme o comprovante (foto lida pelo Financeiro).',
      version: 1,
    });
  }
  return { expenseId: e.id, ...v, totalCents: v.amountCents };
}
