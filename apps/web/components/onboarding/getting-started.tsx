'use client';

import type { GettingStartedStep } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowRight, Check, LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert, Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useGettingStarted } from '@/lib/onboarding';

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Item 1 (26/11/2026): "Comece por aqui" no Início da empresa nova. Seis passos na ordem
 * da oficina; cada um se marca sozinho quando a coisa acontece. Some quando tudo está feito
 * ou quando o dono toca em "Já sei usar". Só o dono vê.
 */
export function GettingStartedCard() {
  const gs = useGettingStarted();
  const qc = useQueryClient();
  const [helpOpen, setHelpOpen] = useState(false);
  const [hiding, setHiding] = useState(false);
  if (!gs.data?.show) return null;
  const { steps, helpRequestedFor } = gs.data;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);

  async function hide() {
    setHiding(true);
    try {
      await api('/api/onboarding/hide', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
    } finally {
      setHiding(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6" data-testid="getting-started">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Comece por aqui</h2>
          <p className="mt-0.5 text-[15px] text-ink-muted">
            {done} de {steps.length} feitos. Cada passo se marca sozinho quando você faz.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {helpRequestedFor ? (
            <span
              className="inline-flex items-center gap-2 rounded-xl bg-ok-50 px-3 py-2 text-sm font-medium text-ok-600"
              data-testid="help-scheduled"
            >
              <LifeBuoy className="size-4" aria-hidden />A gente fala com você{' '}
              {fmtWhen(helpRequestedFor)}
            </span>
          ) : (
            <Button
              variant="secondary"
              icon={<LifeBuoy className="size-4" aria-hidden />}
              onClick={() => setHelpOpen(true)}
              data-testid="help-start"
            >
              Quero ajuda para começar
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={hide}
            loading={hiding}
            data-testid="getting-started-hide"
          >
            Já sei usar
          </Button>
        </div>
      </div>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-subtle"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-label="Passos feitos"
      >
        <div
          className="h-full rounded-full bg-ok-600 transition-all"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s, i) => (
          <StepItem key={s.key} step={s} n={i + 1} next={next?.key === s.key} />
        ))}
      </ol>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </Card>
  );
}

function StepItem({ step, n, next }: { step: GettingStartedStep; n: number; next: boolean }) {
  return (
    <li>
      <Link
        href={step.href}
        data-testid={`gs-step-${step.key}`}
        data-done={step.done ? 'true' : 'false'}
        className={clsx(
          'flex h-full items-start gap-3 rounded-xl border p-3 transition-colors',
          step.done
            ? 'border-line bg-subtle text-ink-muted'
            : next
              ? 'border-brand-200 bg-brand-50 hover:border-brand-500'
              : 'border-line hover:bg-subtle',
        )}
      >
        <span
          className={clsx(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            step.done ? 'bg-ok-600 text-white' : 'border border-line-strong text-ink-soft',
          )}
        >
          {step.done ? <Check className="size-3.5" aria-hidden /> : n}
        </span>
        <span className="min-w-0 flex-1">
          <span className={clsx('block font-medium', step.done ? 'line-through' : 'text-ink')}>
            {step.label}
          </span>
          {!step.done && <span className="mt-0.5 block text-sm text-ink-muted">{step.hint}</span>}
        </span>
        {!step.done && next && (
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-brand-700" aria-hidden />
        )}
      </Link>
    </li>
  );
}

/** Próximos dias úteis (seg a sáb), às 9h, 14h e 17h, para tocar e escolher. */
function suggestions(): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (out.length < 9) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) continue;
    for (const h of [9, 14, 17]) {
      const x = new Date(d);
      x.setHours(h);
      out.push(x);
    }
  }
  return out;
}

/** Item 6: a pessoa escolhe o dia e o horário; o dono da plataforma recebe o aviso. */
function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [when, setWhen] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = suggestions();

  async function send() {
    if (!when) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/onboarding/help', {
        method: 'POST',
        body: { preferredAt: when.toISOString(), ...(note.trim() ? { note: note.trim() } : {}) },
      });
      await qc.invalidateQueries({ queryKey: ['onboarding'] });
      toast('ok', 'Pedido enviado. A gente liga no dia e no horário que você escolheu.');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Quero ajuda para começar"
      description="Escolha quando é melhor para você. A gente liga no telefone da empresa e configura junto, sem pressa."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={send} loading={saving} disabled={!when} data-testid="help-send">
            Pedir ajuda
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="help-dialog">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {options.map((o) => {
            const on = when?.getTime() === o.getTime();
            return (
              <button
                key={o.toISOString()}
                type="button"
                onClick={() => setWhen(o)}
                aria-pressed={on}
                className={clsx(
                  'rounded-xl border px-3 py-2 text-left text-sm',
                  on
                    ? 'border-brand-700 bg-brand-50 font-semibold text-brand-800'
                    : 'border-line hover:bg-subtle',
                )}
                data-testid="help-slot"
              >
                <span className="block first-letter:uppercase">
                  {o.toLocaleDateString('pt-BR', {
                    weekday: 'short',
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </span>
                <span className="block text-ink-muted">
                  {o.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </button>
            );
          })}
        </div>
        <Field label="Quer adiantar alguma coisa? (opcional)">
          {(p) => (
            <Input
              {...p}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex.: quero ajuda com os preços"
            />
          )}
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/**
 * Empresa nova: ao abrir o Início pela primeira vez na sessão, vai direto para as perguntas.
 * Só depois das boas-vindas (nome e telefone) e uma vez por sessão; "Responder depois" volta.
 */
export function SetupRedirect({ ready }: { ready: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const gs = useGettingStarted(ready);
  const ask = ready && pathname === '/painel' && gs.data?.askSetup === true;
  useEffect(() => {
    if (!ask) return;
    try {
      if (sessionStorage.getItem('cenario:perguntas')) return;
      sessionStorage.setItem('cenario:perguntas', '1');
    } catch {
      return;
    }
    router.replace('/painel/comecar');
  }, [ask, router]);
  return null;
}
