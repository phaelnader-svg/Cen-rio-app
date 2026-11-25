'use client';

import type { ManualPaymentDto, MeDto, SubscriptionDto } from '@cenario/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, CreditCard, Lock, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { daysUntil, formatCents, formatDay } from '@/lib/billing';

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

/**
 * Assinatura vencida: no lugar da tela, o aviso com o caminho para pagar. Com a cobrança feita pelo
 * Cenário Gestão (PIX), a chave e o botão do WhatsApp aparecem aqui mesmo.
 */
export function BillingLocked({ canManage }: { canManage: boolean }) {
  const q = useQuery({
    queryKey: ['subscription'],
    queryFn: () => api<SubscriptionDto>('/api/v1/subscription'),
    enabled: canManage,
  });
  const s = q.data;
  const trialEnded = !!s && !s.paidUntil && !!s.trialEndsAt;
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-warn-50 text-warn-600">
        <Lock className="size-6" aria-hidden />
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {trialEnded ? 'Seu teste grátis acabou' : 'A assinatura venceu'}
      </h1>
      <p className="mt-2 text-[15px] text-ink-muted">
        {canManage
          ? s?.manual
            ? 'Os dados da empresa estão guardados. Pague pelo PIX e mande o comprovante: assim que o pagamento for confirmado, tudo volta a funcionar.'
            : 'Os dados da empresa estão guardados. Assim que o pagamento for confirmado, tudo volta a funcionar na hora.'
          : 'Os dados da empresa estão guardados. Peça a quem administra a empresa para regularizar a assinatura.'}
      </p>
      {canManage && s?.manual && (
        <div className="mt-6">
          <ManualPaymentCard manual={s.manual} cycle={s.cycle} planLabel={s.planLabel} />
        </div>
      )}
      {canManage && !s?.manual && (
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

/** Pagamento por PIX para o Cenário Gestão (cobrança feita pelo dono da plataforma). */
export function ManualPaymentCard({
  manual,
  cycle,
  planLabel,
}: {
  manual: ManualPaymentDto;
  cycle: string;
  planLabel: string;
}) {
  const toast = useToast();
  return (
    <div className="card p-5 text-left" data-testid="pagar-pix">
      <p className="text-sm text-ink-muted">{planLabel}</p>
      <p className="text-2xl font-semibold tabular-nums">
        {formatCents(manual.amountCents)}
        <span className="text-sm font-normal text-ink-muted">
          {cycle === 'ANUAL' ? ' por ano' : ' por mês'}
        </span>
      </p>
      {manual.pixKey && (
        <>
          <p className="mt-4 text-sm text-ink-muted">Chave PIX</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-subtle px-3 py-2 text-[15px]">
              {manual.pixKey}
            </code>
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="size-4" aria-hidden />}
              onClick={() => {
                void navigator.clipboard.writeText(manual.pixKey!);
                toast('ok', 'Chave PIX copiada.');
              }}
            >
              Copiar
            </Button>
          </div>
          {(manual.pixName || manual.pixBank) && (
            <p className="mt-1 text-sm text-ink-muted">
              {[manual.pixName, manual.pixBank].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      )}
      {manual.message && <p className="mt-4 text-[15px] text-ink-soft">{manual.message}</p>}
      {manual.whatsappUrl && (
        <a
          href={manual.whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-ok-600 px-4 py-2 text-center font-semibold text-white hover:opacity-90"
        >
          <MessageCircle className="size-4 shrink-0" aria-hidden /> Mandar o comprovante
        </a>
      )}
    </div>
  );
}
