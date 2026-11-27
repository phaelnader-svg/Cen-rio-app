'use client';
/**
 * "Falar com a Firma": caixa principal de conversa com o jogo, em qualquer ambiente e modo.
 * Envia a frase ao servidor (que interpreta, valida e resolve) e entrega o EFEITO ao mapa.
 * Consultas abrem na hora; prévias e confirmações aparecem como cartões aqui mesmo.
 *
 * Item 37 (lista de 53): falar com o Gerente por voz, com o mesmo microfone de segurar do app do
 * dono. Segurou e soltou, envia; um toque rápido deixa ouvindo até tocar de novo. O áudio vai ao
 * Cenário (voz do Google) e volta só o texto; sem a voz no servidor, usa a voz do navegador.
 */

/** Reconhecimento de voz do navegador (Chrome/Edge/Safari), plano B sem a voz no servidor. */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
const recognitionCtor = (): (new () => Recognition) | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as new () => Recognition) ?? null;
};
import type { CommandEffect, CommandResultDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, MessageCircle, Mic, Send } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { type Recording, canRecord, startRecording } from '@/lib/voice-recorder';

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
  // ── Voz (item 37) ──
  const serverVoice = useQuery({
    queryKey: ['game-voice'],
    queryFn: () => api<{ available: boolean }>('/api/v1/office/voice'),
    staleTime: 600_000,
    retry: false,
  });
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [holdMode, setHoldMode] = useState<'hold' | 'tap' | null>(null);
  const [voiceTip, setVoiceTip] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  const rec = useRef<Recognition | null>(null);
  const pressedAt = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const voiceAvailable = (serverVoice.data?.available && canRecord()) || Boolean(recognitionCtor());
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

  const stopServer = async () => {
    const r = recording.current;
    recording.current = null;
    clearTimeout(stopTimer.current);
    setListening(false);
    setHoldMode(null);
    if (!r) return;
    setTranscribing(true);
    try {
      const audio = await r.stop();
      if (!audio) return;
      const { text: heard } = await api<{ text: string }>('/api/v1/office/voice', {
        method: 'POST',
        body: { audio },
        idempotencyKey: newIdempotencyKey(),
      });
      if (heard.trim()) void send(heard);
      else setVoiceTip('Não deu para ouvir. Segure o microfone, fale e solte.');
    } catch (e) {
      setVoiceTip(e instanceof ApiError ? e.message : 'Não deu para entender o áudio agora.');
    } finally {
      setTranscribing(false);
    }
  };

  const startTalking = async () => {
    setVoiceTip(null);
    setOpen(true);
    if (serverVoice.data?.available && canRecord()) {
      try {
        setListening(true);
        recording.current = await startRecording();
        // Até 55 s por vez (o Google transcreve até 60 s de uma vez).
        stopTimer.current = setTimeout(() => void stopServer(), 55_000);
      } catch {
        recording.current = null;
        setListening(false);
        setHoldMode(null);
        setVoiceTip('O microfone está bloqueado. Libere o microfone para este site no navegador.');
      }
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setVoiceTip('Este navegador não ouve a voz. Escreva a pergunta.');
      return;
    }
    const r = new Ctor();
    r.lang = 'pt-BR';
    r.interimResults = true;
    r.continuous = true;
    let heard = '';
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? '')
        .join(' ');
      setText(heard);
    };
    r.onerror = (e) => {
      if (e?.error === 'not-allowed')
        setVoiceTip('O microfone está bloqueado. Libere o microfone para este site no navegador.');
    };
    r.onend = () => {
      setListening(false);
      setHoldMode(null);
      rec.current = null;
      if (heard.trim()) void send(heard);
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
    }
  };
  const stopTalking = () => {
    if (recording.current) void stopServer();
    else rec.current?.stop();
  };
  const onMicDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (busy || transcribing) return;
    if (listening) {
      stopTalking();
      return;
    }
    pressedAt.current = Date.now();
    setHoldMode('hold');
    void startTalking();
  };
  // Segurou (mais de meio segundo) e soltou: envia. Só tocou: continua ouvindo até tocar de novo.
  const onMicUp = () => {
    if (!pressedAt.current) return;
    const held = Date.now() - pressedAt.current >= 500;
    pressedAt.current = 0;
    if (held) stopTalking();
    else setHoldMode('tap');
  };

  return (
    <section
      className="pointer-events-auto flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border-2 border-brand-600/50 bg-[#fffaf2]/97 shadow-pop"
      data-testid="cenaria-chat"
      aria-label="Falar com o Gerente"
    >
      <button
        className="flex items-center gap-2 border-b border-brand-600/20 bg-brand-700 px-3 py-2 text-left text-sm font-bold text-[#f5ebdf]"
        onClick={() => setOpen((o) => !o)}
      >
        <MessageCircle className="size-4" /> Falar com o Gerente
        {/* Melhoria 173: sem o aviso "sem IA" fixo no topo; o chat só fala o que sabe. */}
        <span className="ml-auto" />
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
      {listening || transcribing || voiceTip ? (
        <p
          role="status"
          data-testid="gerente-voice-status"
          className={clsx(
            'mx-2 mt-1.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium',
            voiceTip && !listening && !transcribing
              ? 'bg-brand-50 text-brand-800'
              : 'bg-danger-50 text-danger-600',
          )}
        >
          {listening && !transcribing ? (
            <span className="size-2 animate-pulse rounded-full bg-danger-600" aria-hidden />
          ) : null}
          {transcribing
            ? 'Entendendo o que você falou…'
            : listening
              ? holdMode === 'tap'
                ? 'Ouvindo… toque no microfone para enviar'
                : 'Ouvindo… solte para enviar'
              : voiceTip}
        </p>
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
          placeholder={
            transcribing
              ? 'Entendendo…'
              : voiceAvailable
                ? 'Pergunte ou segure o microfone'
                : 'Ex.: Cadê o sofá da Ana?'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          aria-label="Falar com o Gerente"
          data-testid="cenaria-input"
        />
        {voiceAvailable && (!text.trim() || listening) ? (
          <button
            type="button"
            onPointerDown={onMicDown}
            onPointerUp={onMicUp}
            onPointerCancel={onMicUp}
            onPointerLeave={(e) => {
              if (e.buttons) onMicUp();
            }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              if (listening) stopTalking();
              else {
                setHoldMode('tap');
                void startTalking();
              }
            }}
            disabled={transcribing || busy}
            aria-label={listening ? 'Parar e enviar' : 'Segure para falar com o Gerente'}
            aria-pressed={listening}
            title="Segure para falar"
            data-testid="gerente-mic"
            style={{ WebkitTouchCallout: 'none', touchAction: 'none' }}
            className={clsx(
              'grid shrink-0 place-items-center rounded-xl px-3 transition select-none',
              listening
                ? 'animate-pulse bg-danger-600 text-white'
                : 'bg-brand-600 text-white disabled:opacity-50',
            )}
          >
            <Mic className="size-4" />
          </button>
        ) : (
          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-3 text-white disabled:opacity-50"
            disabled={busy || !text.trim()}
            aria-label="Enviar"
          >
            <Send className="size-4" />
          </button>
        )}
      </form>
    </section>
  );
}
