'use client';
/**
 * "Falar com a Cenário": caixa principal de conversa com o jogo, em qualquer ambiente e modo.
 * Envia a frase ao servidor (que interpreta, valida e resolve) e entrega o EFEITO ao mapa.
 * Consultas abrem na hora; prévias e confirmações aparecem como cartões aqui mesmo.
 */
import type { CommandEffect, CommandResultDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, MessageCircle, Send } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';

type Entry =
  | { who: 'eu'; text: string }
  | { who: 'cenaria'; text: string; result?: CommandResultDto };

export function CenariaChat({
  spaceKey,
  onEffect,
  card,
}: {
  spaceKey: string;
  onEffect: (e: CommandEffect, result: CommandResultDto) => void;
  /** Cartão ativo (prévia de mudança, confirmação de atribuição…). */
  card: ReactNode;
}) {
  const config = useQuery({
    queryKey: ['game-command-config'],
    queryFn: () =>
      api<{ provider: string; model: string | null; suggestions: string[] }>(
        '/api/v1/game/command/config',
      ),
    staleTime: 300_000,
  });
  const [open, setOpen] = useState(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' });
  }, [log.length, card]);

  const send = async (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    setText('');
    setOpen(true);
    setLog((l) => [...l.slice(-12), { who: 'eu', text: msg }]);
    setBusy(true);
    try {
      const r = await api<CommandResultDto>('/api/v1/game/command', {
        method: 'POST',
        body: { text: msg, spaceKey },
      });
      setLog((l) => [...l, { who: 'cenaria', text: r.reply, result: r }]);
      if (r.effect.kind !== 'ESCOLHER' && r.effect.kind !== 'NADA') onEffect(r.effect, r);
    } catch (e) {
      setLog((l) => [
        ...l,
        {
          who: 'cenaria',
          text: e instanceof ApiError ? e.message : 'Não consegui falar com o servidor agora.',
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="pointer-events-auto flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border-2 border-brand-600/50 bg-[#fffaf2]/97 shadow-pop"
      data-testid="cenaria-chat"
      aria-label="Falar com a Cenário"
    >
      <button
        className="flex items-center gap-2 border-b border-brand-600/20 bg-brand-700 px-3 py-2 text-left text-sm font-bold text-[#f5ebdf]"
        onClick={() => setOpen((o) => !o)}
      >
        <MessageCircle className="size-4" /> Falar com a Cenário
        <span className="ml-auto text-[10px] font-semibold opacity-80">
          {config.data?.provider === 'anthropic'
            ? `IA: ${config.data.model}`
            : 'sem IA: regras e sugestões'}
        </span>
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
      {open ? (
        <div
          className="max-h-[38vh] space-y-2 overflow-y-auto px-3 py-2 text-xs"
          data-testid="cenaria-log"
        >
          {log.map((e, i) =>
            e.who === 'eu' ? (
              <div key={i} className="ml-10 rounded-xl bg-brand-600 px-2.5 py-1.5 text-white">
                {e.text}
              </div>
            ) : (
              <div
                key={i}
                className="mr-4 rounded-xl border border-line bg-white px-2.5 py-1.5 whitespace-pre-wrap"
              >
                {e.text}
                {e.result?.effect.kind === 'ESCOLHER' ? (
                  <div className="mt-1.5 space-y-1" data-testid="cenaria-options">
                    {e.result.effect.options.map((o) => (
                      <button
                        key={o.label}
                        className="block w-full rounded-lg border border-bronze-500/40 bg-bronze-100 px-2 py-1 text-left hover:bg-bronze-100/70"
                        onClick={() => onEffect(o.effect, e.result!)}
                      >
                        <b>{o.label}</b>
                        <span className="block text-ink-soft">{o.detail}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {e.result?.effect.kind === 'LISTA' ? (
                  <div className="mt-1.5 space-y-1">
                    {e.result.effect.rows.map((r, j) =>
                      r.effect ? (
                        <button
                          key={j}
                          className="block w-full rounded-lg border border-line bg-subtle px-2 py-1 text-left"
                          onClick={() => onEffect(r.effect!, e.result!)}
                        >
                          <b>{r.label}</b> <span className="text-ink-soft">{r.detail}</span>
                        </button>
                      ) : (
                        <a
                          key={j}
                          href={r.href}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-lg border border-line bg-subtle px-2 py-1 underline"
                        >
                          <b>{r.label}</b> <span className="text-ink-soft">{r.detail}</span>
                        </a>
                      ),
                    )}
                  </div>
                ) : null}
                {e.result ? (
                  <div className="mt-1 text-[10px] text-ink-muted">
                    interpretado por {e.result.interpretedBy === 'IA' ? 'IA' : 'regras'} ·{' '}
                    {e.result.intent.acao.toLowerCase().replace('_', ' ')}
                  </div>
                ) : null}
              </div>
            ),
          )}
          {busy ? <div className="text-ink-muted">Pensando…</div> : null}
          {card}
          <div ref={end} />
        </div>
      ) : null}
      {open ? (
        <div className="flex gap-1 overflow-x-auto px-3 pb-1.5" data-testid="cenaria-suggestions">
          {(config.data?.suggestions ?? []).map((s) => (
            <button
              key={s}
              className="shrink-0 rounded-full border border-brand-600/30 bg-brand-50 px-2 py-0.5 text-[11px]"
              onClick={() => void send(s)}
              disabled={busy}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex gap-1.5 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          className={clsx('flex-1 rounded-xl border border-line-strong bg-white px-3 py-2 text-sm')}
          placeholder="Ex.: Cadê o sofá da Ana?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          aria-label="Falar com a Cenário"
          data-testid="cenaria-input"
        />
        <button
          type="submit"
          className="rounded-xl bg-brand-600 px-3 text-white disabled:opacity-50"
          disabled={busy || !text.trim()}
          aria-label="Enviar"
        >
          <Send className="size-4" />
        </button>
      </form>
    </section>
  );
}
