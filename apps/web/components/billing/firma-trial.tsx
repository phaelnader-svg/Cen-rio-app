'use client';

import type { GameTrialDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gamepad2, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AMBIENTE_INTERATIVO_PATH } from '@/lib/ambiente-interativo';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatCents, formatDay } from '@/lib/billing';

/** Item 34 (lista de 53): teste de 7 dias do Firma Viva (só quem configura a empresa). */
export function useGameTrial(enabled: boolean) {
  return useQuery({
    queryKey: ['firma-viva', 'teste'],
    queryFn: () => api<GameTrialDto>('/api/v1/firma-viva/teste'),
    enabled,
    staleTime: 300_000,
  });
}

const OPEN_LINK =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 focus-visible:ring-4 focus-visible:ring-brand-100';
const SOFT_LINK =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-brand-700/40 bg-surface px-3 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:ring-4 focus-visible:ring-brand-100';

/**
 * Botão do Firma Viva no topo do painel (só o dono):
 * - plano com o jogo ou em teste: abre o jogo em outra guia (no teste, mostra os dias que faltam);
 * - plano de R$ 399 que ainda não testou: "Experimentar o Firma Viva" (7 dias, uma vez);
 * - teste acabado: leva à Assinatura, com a oferta do plano com o Firma Viva.
 */
export function FirmaHeaderButton({ gameOn, enabled }: { gameOn: boolean; enabled: boolean }) {
  const trial = useGameTrial(enabled);
  const [ask, setAsk] = useState(false);
  if (!enabled) return null;
  const t = trial.data;
  // O diálogo fica montado mesmo depois de o teste começar (ele mostra "Abrir o Firma Viva").
  const dialog = t ? <FirmaTrialDialog open={ask} onClose={() => setAsk(false)} trial={t} /> : null;
  let button: React.ReactNode = null;
  if (gameOn || t?.status === 'ATIVO')
    button = (
      <a
        href={AMBIENTE_INTERATIVO_PATH}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="ambiente-interativo"
        aria-label="Abrir o Firma Viva (abre em nova guia)"
        // Melhoria 159: nome do produto e o verde da marca; curto para caber no celular.
        className={OPEN_LINK}
      >
        <Gamepad2 className="size-4" aria-hidden />
        <span className="hidden sm:inline">Firma Viva</span>
        {t?.status === 'ATIVO' && (
          <span
            className="rounded-md bg-white/20 px-1.5 py-0.5 text-xs font-semibold"
            data-testid="firma-teste-dias"
          >
            {t.daysLeft === 1 ? 'último dia' : `${t.daysLeft} dias`}
          </span>
        )}
      </a>
    );
  else if (t?.status === 'DISPONIVEL')
    button = (
      <button
        type="button"
        onClick={() => setAsk(true)}
        className={SOFT_LINK}
        data-testid="firma-experimentar"
      >
        <Gamepad2 className="size-4" aria-hidden />
        <span className="hidden sm:inline">Experimentar o Firma Viva</span>
        <span className="sm:hidden">Testar</span>
      </button>
    );
  else if (t?.status === 'ENCERRADO')
    button = (
      <Link href="/painel/assinatura#firma-viva" className={SOFT_LINK} data-testid="firma-assinar">
        <Gamepad2 className="size-4" aria-hidden />
        <span className="hidden sm:inline">Firma Viva</span>
      </Link>
    );
  return (
    <>
      {button}
      {dialog}
    </>
  );
}

/** Explica o teste antes de começar; depois de começar, o mesmo diálogo abre o jogo. */
export function FirmaTrialDialog({
  open,
  onClose,
  trial,
}: {
  open: boolean;
  onClose: () => void;
  trial: GameTrialDto;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [started, setStarted] = useState<GameTrialDto | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api<GameTrialDto>('/api/v1/firma-viva/teste', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (r) => {
      setStarted(r);
      qc.setQueryData(['firma-viva', 'teste'], r);
      void qc.invalidateQueries({ queryKey: ['company', 'modules'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={started ? 'Teste começou' : 'Experimente o Firma Viva por 7 dias'}
      footer={
        started ? (
          <a
            href={AMBIENTE_INTERATIVO_PATH}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className={buttonClass('primary', 'md')}
            data-testid="firma-abrir"
          >
            <Gamepad2 className="size-4" aria-hidden />
            Abrir o Firma Viva
          </a>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Agora não
            </Button>
            <Button
              onClick={() => start.mutate()}
              loading={start.isPending}
              data-testid="firma-comecar"
            >
              Começar o teste
            </Button>
          </>
        )
      }
    >
      {started ? (
        <p className="text-[15px] leading-6 text-ink-soft">
          O Firma Viva está liberado até <strong>{formatDay(started.endsAt)}</strong>. O botão verde
          no topo do painel abre o jogo em outra guia e mostra quantos dias faltam.
        </p>
      ) : (
        <ul className="space-y-3 text-[15px] leading-6 text-ink-soft">
          <li>A sua oficina e o escritório em 3D, com as OS, a equipe e as peças de verdade.</li>
          <li>O Gerente responde por voz e os agentes de IA trabalham no escritório.</li>
          <li>
            Grátis, sem cobrança e sem mudar o seu plano. Depois dos 7 dias, para continuar, o plano
            Cenário Gestão + Firma Viva sai por{' '}
            <strong>{formatCents(trial.upgradeMonthlyCents)} por mês</strong>.
          </li>
        </ul>
      )}
    </Dialog>
  );
}

/** Cartão na Assinatura: o teste (começar, dias que faltam ou acabou) e a oferta do plano. */
export function FirmaTrialCard({ enabled }: { enabled: boolean }) {
  const trial = useGameTrial(enabled);
  const [ask, setAsk] = useState(false);
  const t = trial.data;
  if (!enabled || !t || t.status === 'INCLUIDO') return null;
  const price = formatCents(t.upgradeMonthlyCents);
  return (
    <div
      id="firma-viva"
      className="card mb-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center"
      data-testid="firma-teste-cartao"
    >
      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Gamepad2 className="size-5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {t.status === 'DISPONIVEL'
            ? 'Experimente o Firma Viva por 7 dias, grátis'
            : t.status === 'ATIVO'
              ? `Você está testando o Firma Viva: ${t.daysLeft === 1 ? 'hoje é o último dia' : `faltam ${t.daysLeft} dias`}`
              : 'O seu teste de 7 dias do Firma Viva acabou'}
        </p>
        <p className="mt-1 text-[15px] text-ink-soft">
          {t.status === 'DISPONIVEL'
            ? `A oficina e o escritório em 3D com os dados reais, o Gerente por voz e os agentes de IA. Depois, para continuar, o plano Cenário Gestão + Firma Viva sai por ${price} por mês.`
            : t.status === 'ATIVO'
              ? `Vale até ${formatDay(t.endsAt)}. Para continuar depois, o plano Cenário Gestão + Firma Viva sai por ${price} por mês.`
              : `Para continuar com o jogo, a Conversar e os agentes, mude para o plano Cenário Gestão + Firma Viva: ${price} por mês. Os seus dados do jogo continuam guardados.`}
        </p>
      </div>
      <FirmaTrialDialog open={ask} onClose={() => setAsk(false)} trial={t} />
      {t.status === 'DISPONIVEL' ? (
        <Button onClick={() => setAsk(true)}>Começar o teste</Button>
      ) : (
        t.whatsappUrl && (
          <a
            href={t.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass(t.status === 'ENCERRADO' ? 'primary' : 'secondary', 'md')}
            data-testid="firma-mudar-plano"
          >
            <MessageCircle className="size-4" aria-hidden />
            Quero o plano com Firma Viva
          </a>
        )
      )}
    </div>
  );
}
