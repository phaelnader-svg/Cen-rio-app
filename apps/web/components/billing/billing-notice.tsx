'use client';

import type { MeDto } from '@cenario/shared';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, Lock } from 'lucide-react';
import Link from 'next/link';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { daysUntil, formatDay } from '@/lib/billing';

export const SUBSCRIPTION_PATH = '/painel/assinatura';

/**
 * Avisos do topo do painel (cobrança e e-mail). Só quem administra a empresa vê os de cobrança,
 * porque é quem paga. O e-mail sem confirmar aparece para a própria pessoa.
 */
export function BillingNotices({ me, canManage }: { me: MeDto; canManage: boolean }) {
  const toast = useToast();
  const resend = useMutation({
    mutationFn: () => api('/api/auth/email/resend', { method: 'POST' }),
    onSuccess: () => toast('ok', `Mandamos o link de novo para ${me.user.email}.`),
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const sub = me.company.subscription;
  // Melhoria 140: um aviso só no topo, com uma linha por assunto. Fica laranja quando urgente
  // (mensalidade em aberto ou teste grátis com 2 dias ou menos).
  const lines: React.ReactNode[] = [];
  let urgent = false;

  if (canManage && sub.billingEnabled && sub.status === 'TESTE' && sub.blocksAt) {
    const d = daysUntil(sub.blocksAt);
    if (d <= 2) urgent = true;
    lines.push(
      <p key="teste">
        Teste grátis: {d === 0 ? 'termina hoje' : `faltam ${d} ${d === 1 ? 'dia' : 'dias'}`}.{' '}
        <Link href={SUBSCRIPTION_PATH} className="font-semibold underline underline-offset-4">
          Escolher o plano
        </Link>
      </p>,
    );
  }
  if (canManage && sub.billingEnabled && sub.status === 'ATRASADA') {
    urgent = true;
    lines.push(
      <p key="atrasada">
        A mensalidade está em aberto. O sistema bloqueia em {formatDay(sub.blocksAt)}.{' '}
        <Link href={SUBSCRIPTION_PATH} className="font-semibold underline underline-offset-4">
          Pagar agora
        </Link>
      </p>,
    );
  }
  if (me.user.email && !me.user.emailConfirmed) {
    lines.push(
      <p key="email">
        Confirme o seu e-mail pelo link que mandamos para {me.user.email}. É por ele que você
        recupera a senha.{' '}
        <button
          type="button"
          className="font-semibold underline underline-offset-4"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          Mandar de novo
        </button>
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return (
    <Alert tone={urgent ? 'warn' : 'info'} className="mb-6">
      <div className="space-y-1">{lines}</div>
    </Alert>
  );
}

/** Assinatura vencida: no lugar da tela, o aviso com o caminho para pagar. */
export function BillingLocked({ canManage }: { canManage: boolean }) {
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-warn-50 text-warn-600">
        <Lock className="size-6" aria-hidden />
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">A assinatura venceu</h1>
      <p className="mt-2 text-[15px] text-ink-muted">
        {canManage
          ? 'Os dados da empresa estão guardados. Assim que o pagamento for confirmado, tudo volta a funcionar na hora.'
          : 'Os dados da empresa estão guardados. Peça a quem administra a empresa para regularizar a assinatura.'}
      </p>
      {canManage && (
        <Link
          href={SUBSCRIPTION_PATH}
          className="mt-6 inline-flex h-12 items-center gap-2 rounded-xl bg-brand-700 px-5 font-semibold text-white hover:bg-brand-800"
        >
          <CreditCard className="size-4" aria-hidden /> Ver a assinatura e pagar
        </Link>
      )}
    </div>
  );
}
