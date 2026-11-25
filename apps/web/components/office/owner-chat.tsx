'use client';

import type { OwnerChatCard, OwnerChatReplyDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUp, Camera, ChevronRight, Mic, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { preparePhoto } from '@/lib/photos';

/**
 * Conversar (app do dono, 2026-11-25): o dono escreve ou fala e a IA responde com os dados da
 * empresa. Os números chegam em cartões montados pelo sistema; pedidos de tarefa viram cartões
 * no Aprovar. A foto de um comprovante vira gasto pronto para aprovar (o Financeiro lê).
 * A conversa fica guardada só neste aparelho, até "Começar de novo".
 */

type Line =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; cards: OwnerChatCard[] }
  | { role: 'error'; text: string };

const STORE = 'cenario-conversa';
const load = (): Line[] => {
  try {
    const raw = window.sessionStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Line[]) : [];
  } catch {
    return [];
  }
};
const save = (l: Line[]) => {
  try {
    window.sessionStorage.setItem(STORE, JSON.stringify(l.slice(-40)));
  } catch {
    /* sem armazenamento: a conversa só não sobrevive à troca de tela */
  }
};

const SUGGESTIONS = [
  'Quanto lucrei este mês?',
  'Quais entregas tem esta semana?',
  'O que está atrasado?',
  'O que falta comprar?',
];

/** Reconhecimento de voz do navegador (Chrome, Safari), quando existe. */
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as new () => Recognition) ?? null;
}

export function OwnerChat({ onApprove }: { onApprove?: () => void }) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [canTalk, setCanTalk] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines(load());
    setCanTalk(!!recognitionCtor());
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [lines, busy]);
  // O campo cresce com o texto (até umas 5 linhas), sem cortar o que foi escrito.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text]);
  const typed = text.trim().length > 0;

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    const next: Line[] = [...lines, { role: 'user', text: question }];
    setLines(next);
    save(next);
    setText('');
    setBusy(true);
    try {
      const history = next
        .filter((l): l is Exclude<Line, { role: 'error' }> => l.role !== 'error')
        .slice(-20)
        .map((l) => ({ role: l.role, text: l.text.slice(0, 4000) }));
      // A conversa começa sempre por uma fala do dono.
      while (history[0]?.role === 'assistant') history.shift();
      const r = await api<OwnerChatReplyDto>('/api/v1/office/chat', {
        method: 'POST',
        body: { messages: history },
        idempotencyKey: newIdempotencyKey(),
      });
      const done: Line[] = [...next, { role: 'assistant', text: r.reply, cards: r.cards }];
      setLines(done);
      save(done);
      if (r.cards.some((c) => c.kind === 'aprovar'))
        void qc.invalidateQueries({ queryKey: ['office'] });
    } catch (e) {
      const done: Line[] = [...next, { role: 'error', text: errorMessage(e) }];
      setLines(done);
      save(done);
    } finally {
      setBusy(false);
    }
  };

  // Foto do comprovante: o Financeiro lê e deixa o gasto no Aprovar (ou lança, se liberado).
  const sendPhoto = async (file: File) => {
    if (busy) return;
    const next: Line[] = [...lines, { role: 'user', text: 'Foto do comprovante' }];
    setLines(next);
    save(next);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', await preparePhoto(file));
      const r = await api<{ proposalId: string; title: string; doneAlone: boolean }>(
        '/api/v1/office/receipt',
        { method: 'POST', body: fd },
      );
      const done: Line[] = [
        ...next,
        r.doneAlone
          ? { role: 'assistant', text: `Li o comprovante e já lancei: ${r.title}.`, cards: [] }
          : {
              role: 'assistant',
              text: 'Li o comprovante e deixei o gasto pronto. Confira o valor e aprove.',
              cards: [{ kind: 'aprovar', proposalId: r.proposalId, title: r.title }],
            },
      ];
      setLines(done);
      save(done);
      void qc.invalidateQueries({ queryKey: ['office'] });
    } catch (e) {
      const done: Line[] = [...next, { role: 'error', text: errorMessage(e) }];
      setLines(done);
      save(done);
    } finally {
      setBusy(false);
    }
  };

  const talk = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = 'pt-BR';
    r.interimResults = false;
    r.continuous = false;
    let heard = '';
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? '')
        .join(' ');
      setText(heard);
    };
    r.onerror = () => setListening(false);
    r.onend = () => {
      setListening(false);
      // Falou e parou: já pergunta, sem precisar tocar em enviar.
      if (heard.trim()) void ask(heard);
    };
    rec.current = r;
    setListening(true);
    r.start();
  };

  const restart = () => {
    setLines([]);
    save([]);
  };

  return (
    <div data-testid="owner-chat">
      <header className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] leading-tight font-bold tracking-tight text-ink">Conversar</h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Pergunte sobre a oficina ou peça uma tarefa.
          </p>
        </div>
        {lines.length > 0 && (
          <button
            type="button"
            onClick={restart}
            className="flex h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink-soft"
          >
            <RotateCcw className="size-4" aria-hidden />
            Começar de novo
          </button>
        )}
      </header>

      {lines.length === 0 && (
        <div className="space-y-2">
          <p className="px-1 text-[13px] font-semibold text-ink-muted">Experimente</p>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void ask(s)}
              className="flex w-full items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
            >
              {s}
              <ChevronRight className="size-4 text-ink-muted" aria-hidden />
            </button>
          ))}
          <p className="px-1 pt-2 text-sm text-ink-muted">
            Ela também prepara tarefas, como &quot;faz um orçamento para a Maria&quot; ou
            &quot;avisa o João que o sofá fica pronto sexta&quot;. Para lançar um gasto, toque na
            câmera e mande a foto do comprovante. Tudo vai para o Aprovar antes de sair.
          </p>
        </div>
      )}

      <ol className="space-y-3">
        {lines.map((l, i) => (
          <li key={i} className={clsx('flex', l.role === 'user' ? 'justify-end' : 'justify-start')}>
            {l.role === 'user' ? (
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-700 px-4 py-2.5 text-[15px] whitespace-pre-wrap text-white">
                {l.text}
              </p>
            ) : l.role === 'error' ? (
              <p className="max-w-[90%] rounded-2xl rounded-bl-md border border-danger-600/30 bg-danger-50 px-4 py-2.5 text-[15px] text-danger-700">
                {l.text}
              </p>
            ) : (
              <div className="w-full max-w-[95%] space-y-2">
                <p className="rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-2.5 text-[15px] whitespace-pre-wrap text-ink">
                  {l.text}
                </p>
                {l.cards.map((c, k) => (
                  <ChatCard key={k} card={c} onApprove={onApprove} />
                ))}
              </div>
            )}
          </li>
        ))}
        {busy && (
          <li className="flex justify-start">
            <p className="rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-2.5 text-[15px] text-ink-muted">
              {lines.at(-1)?.text === 'Foto do comprovante'
                ? 'Lendo o comprovante…'
                : 'Olhando no sistema…'}
            </p>
          </li>
        )}
      </ol>
      <div ref={end} className="h-24" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(text);
        }}
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 border-t border-line bg-canvas/95 px-4 py-2 backdrop-blur"
      >
        <div className="mx-auto flex max-w-xl items-end gap-2">
          <textarea
            ref={field}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(text);
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder={listening ? 'Ouvindo…' : 'Pergunte ou peça uma tarefa'}
            aria-label="Sua pergunta"
            className="max-h-32 min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-3xl border border-line-strong bg-surface px-3.5 py-[11px] text-[15px] leading-5 text-ink outline-none placeholder:text-[14px] placeholder:text-ink-muted focus:border-brand-500"
          />
          <button
            type="button"
            onClick={() => photo.current?.click()}
            disabled={busy}
            aria-label="Mandar foto do comprovante"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-ink disabled:opacity-40"
          >
            <Camera className="size-5" aria-hidden />
          </button>
          <input
            ref={photo}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="chat-photo"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void sendPhoto(file);
            }}
          />
          {canTalk && (!typed || listening) ? (
            <button
              type="button"
              onClick={talk}
              aria-label={listening ? 'Parar de ouvir' : 'Falar'}
              aria-pressed={listening}
              className={clsx(
                'grid size-11 shrink-0 place-items-center rounded-full border',
                listening
                  ? 'animate-pulse border-danger-600 bg-danger-600 text-white'
                  : 'border-line-strong bg-surface text-ink',
              )}
            >
              <Mic className="size-5" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || !typed}
              aria-label="Enviar"
              className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-700 text-white disabled:opacity-40"
            >
              <ArrowUp className="size-5" aria-hidden />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function ChatCard({ card, onApprove }: { card: OwnerChatCard; onApprove?: () => void }) {
  if (card.kind === 'aprovar')
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50 p-4">
        <p className="text-[13px] font-semibold text-brand-700">Deixei no Aprovar</p>
        <p className="mt-0.5 text-[15px] font-semibold text-ink">{card.title}</p>
        {onApprove && (
          <button
            type="button"
            onClick={onApprove}
            className="mt-3 h-11 w-full rounded-xl bg-brand-700 text-[15px] font-semibold text-white"
          >
            Ver e aprovar
          </button>
        )}
      </div>
    );
  if (card.kind === 'numeros')
    return (
      <div className="rounded-2xl border border-line bg-surface">
        <p className="px-4 pt-3 text-[13px] font-semibold text-ink-muted">{card.title}</p>
        <ul className="divide-y divide-line">
          {card.rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3 px-4 py-2.5 text-[15px]">
              <span className="min-w-0 flex-1 text-ink">{r.label}</span>
              <b
                className={clsx(
                  'shrink-0 font-semibold tabular-nums',
                  r.tone === 'ruim' ? 'text-danger-600' : 'text-ink',
                )}
              >
                {r.value}
              </b>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="rounded-2xl border border-line bg-surface">
      <p className="px-4 pt-3 text-[13px] font-semibold text-ink-muted">{card.title}</p>
      {card.items.length === 0 ? (
        <p className="px-4 py-3 text-[15px] text-ink-muted">{card.empty ?? 'Nada por aqui.'}</p>
      ) : (
        <ul className="divide-y divide-line">
          {card.items.map((it, i) => {
            const body = (
              <>
                <span className="block text-[15px] text-ink">{it.title}</span>
                {it.detail && <span className="block text-sm text-ink-muted">{it.detail}</span>}
              </>
            );
            return (
              <li key={i} className="px-4 py-2.5">
                {it.href ? (
                  <a href={it.href} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">{body}</span>
                    <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden />
                  </a>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
