'use client';

import { demoSlots } from '@cenario/shared';
import clsx from 'clsx';
import { CalendarCheck, CircleCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { currentOrigin, rememberOrigin } from '@/lib/origem';

const OPEN = 'cenario:demonstracao';

/** Abre a janela de marcar a demonstração (se o JavaScript não carregou, o link abre o WhatsApp). */
export function openDemo(e?: { preventDefault: () => void }) {
  e?.preventDefault();
  window.dispatchEvent(new Event(OPEN));
}

/**
 * Item 44 (2026-11-27): a pessoa escolhe o dia e o horário da demonstração no próprio site, e o
 * pedido aparece no painel da plataforma (com aviso no celular). O WhatsApp continua como opção.
 */
export function DemoDialogHost({ whatsappUrl }: { whatsappUrl: string | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    rememberOrigin();
    const on = () => setOpen(true);
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, []);
  if (!open) return null;
  return <DemoDialog whatsappUrl={whatsappUrl} onClose={() => setOpen(false)} />;
}

function DemoDialog({ whatsappUrl, onClose }: { whatsappUrl: string | null; onClose: () => void }) {
  const slots = useMemo(() => demoSlots(new Date()), []);
  const [when, setWhen] = useState<Date | null>(null);
  const [f, setF] = useState({ name: '', businessName: '', city: '', phone: '', website: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function send() {
    if (!when) {
      setError('Escolha o dia e o horário.');
      return;
    }
    setSaving(true);
    setError(null);
    setErrors({});
    try {
      const origem = currentOrigin();
      await api('/api/public/demonstracao', {
        method: 'POST',
        body: {
          name: f.name,
          businessName: f.businessName || undefined,
          city: f.city || undefined,
          phone: f.phone,
          preferredAt: when.toISOString(),
          ...(origem ? { origem } : {}),
          ...(f.website ? { website: f.website } : {}),
        },
      });
      setDone(true);
    } catch (e) {
      setErrors(fieldErrors(e));
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const fmt = (d: Date) =>
    d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (done)
    return (
      <Dialog
        open
        onClose={onClose}
        title="Demonstração marcada"
        footer={<Button onClick={onClose}>Fechar</Button>}
      >
        <div className="flex items-start gap-3" data-testid="demo-ok">
          <CircleCheck className="mt-0.5 size-6 shrink-0 text-ok-600" aria-hidden />
          <p className="text-[15px] text-ink-soft">
            Combinado! A gente chama você no WhatsApp <strong>{fmt(when!)}</strong> para mostrar o
            sistema funcionando, com os seus serviços. Leva uns 20 minutos.
          </p>
        </div>
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Agendar uma demonstração"
      description="Escolha quando é melhor. A gente mostra o sistema pelo WhatsApp, por vídeo, com os seus serviços."
      footer={
        <>
          {whatsappUrl && (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mr-auto text-sm font-medium text-ink-soft underline-offset-4 hover:underline"
            >
              Prefiro conversar agora no WhatsApp
            </a>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={send}
            loading={saving}
            icon={<CalendarCheck className="size-4" aria-hidden />}
            data-testid="demo-enviar"
          >
            Marcar
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="demo-dialog">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {slots.map((o) => {
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
                data-testid="demo-slot"
              >
                <span className="block first-letter:uppercase">
                  {o.toLocaleDateString('pt-BR', {
                    timeZone: 'America/Sao_Paulo',
                    weekday: 'short',
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </span>
                <span className="block text-ink-muted">
                  {o.toLocaleTimeString('pt-BR', {
                    timeZone: 'America/Sao_Paulo',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </button>
            );
          })}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Seu nome" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={f.name}
                autoComplete="name"
                onChange={(e) => set('name', e.target.value)}
                data-testid="demo-nome"
              />
            )}
          </Field>
          <Field label="Celular com DDD" required error={errors.phone}>
            {(p) => (
              <Input
                {...p}
                value={f.phone}
                inputMode="tel"
                autoComplete="tel"
                placeholder="(12) 99999-9999"
                onChange={(e) => set('phone', e.target.value)}
                data-testid="demo-telefone"
              />
            )}
          </Field>
          <Field label="Nome da tapeçaria">
            {(p) => (
              <Input
                {...p}
                value={f.businessName}
                autoComplete="organization"
                onChange={(e) => set('businessName', e.target.value)}
                data-testid="demo-empresa"
              />
            )}
          </Field>
          <Field label="Cidade">
            {(p) => (
              <Input
                {...p}
                value={f.city}
                autoComplete="address-level2"
                onChange={(e) => set('city', e.target.value)}
              />
            )}
          </Field>
        </div>
        {/* Campo-isca: escondido; só robô preenche. */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="hidden"
          value={f.website}
          onChange={(e) => set('website', e.target.value)}
        />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/** Botão flutuante "Agendar demonstração": abre a janela de marcar (sem JavaScript, o WhatsApp). */
export function DemoFloat({ href, origem }: { href: string | null; origem?: string }) {
  return (
    <a
      href={href ?? '#contato'}
      {...(href ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...(origem ? { 'data-origem': origem } : {})}
      onClick={openDemo}
      className="fixed right-4 bottom-4 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-ok-600 px-5 font-semibold text-white shadow-[var(--shadow-pop)] hover:bg-ok-600/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ok-600 sm:right-6 sm:bottom-6"
      data-testid="site-cta"
    >
      <CalendarCheck className="size-5" aria-hidden />
      Agendar demonstração
    </a>
  );
}
