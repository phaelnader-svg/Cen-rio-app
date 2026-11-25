'use client';

import {
  OFFICE_LEVELS,
  OFFICE_LEVEL_HINT,
  OFFICE_LEVEL_LABEL,
  type ExpenseCategoryDto,
  type QuoteDraft,
  type OfficeAgentDto,
  type OfficeLevel,
  type OfficeOverviewDto,
  type OfficeProposalDto,
  type OfficeTaskDto,
  type OfficeForecastDto,
  type OfficeMaterialPricesDto,
  type OfficeWeekDto,
  plural,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Calculator,
  Camera,
  CirclePause,
  CirclePlay,
  MessageCircle,
  RefreshCw,
  UserPlus,
} from 'lucide-react';
import { createContext, useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { brDate, money, parseMoney } from '@/lib/finance';
import { formatDateTime } from '@/lib/format';
import { useMe } from '@/lib/hooks';
import { preparePhoto } from '@/lib/photos';
import { putDraftInEditor, shrinkImage } from '@/lib/quotes';
import { useRouter } from 'next/navigation';

const KEY = ['office'] as const;

export function useOffice() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<OfficeOverviewDto>('/api/v1/office'),
    refetchInterval: 60_000,
  });
}

/** Mutação do Escritório: devolve o escritório atualizado ou recarrega. */
export function useOfficeSend() {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ run }: { run: () => Promise<unknown>; ok?: string }) => run(),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      setError(null);
      if (v.ok) toast('ok', v.ok);
    },
    onError: (e) => {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  return { m, error, setError };
}

/**
 * Escritório (2026-11-25): o que os agentes fizeram e o que espera o dono, no celular. Aprovar,
 * mudar ou recusar cada pedido; escolher o nível de cada tarefa; parar tudo.
 */
/**
 * Aprovado sem o WhatsApp da empresa: falta o dono apertar enviar. A proposta sai da lista
 * "Esperando você" assim que o escritório recarrega, então o botão de enviar fica aqui em cima,
 * fora do cartão, até ser tocado.
 */
type ToSend = {
  id: string;
  title: string;
  /** Mensagem para um cliente. */
  href?: string;
  /** Post pronto para postar (antes e depois). */
  post?: { caption: string; photos: { label: string; url: string; thumbUrl: string }[] };
  /** Uma mensagem para cada cliente (promoção). */
  list?: { customerId: string; name: string; href: string }[];
};
const ToSendContext = createContext<{
  items: ToSend[];
  add: (t: ToSend) => void;
  remove: (id: string) => void;
} | null>(null);

export function ToSendProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToSend[]>([]);
  return (
    <ToSendContext.Provider
      value={{
        items,
        add: (t) => setItems((l) => [...l.filter((x) => x.id !== t.id), t]),
        remove: (id) => setItems((l) => l.filter((x) => x.id !== id)),
      }}
    >
      {children}
    </ToSendContext.Provider>
  );
}

/** Os aprovados que falta enviar no WhatsApp (dentro do ToSendProvider). */
export function ToSendList() {
  const ctx = useContext(ToSendContext);
  if (!ctx?.items.length) return null;
  return (
    <ul className="space-y-3" data-testid="office-to-send">
      {ctx.items.map((t) => (
        <li key={t.id}>
          <ReadyCard t={t} onDone={() => ctx.remove(t.id)} />
        </li>
      ))}
    </ul>
  );
}

function ReadyCard({ t, onDone }: { t: ToSend; onDone: () => void }) {
  if (t.post) return <PostCard title={t.title} post={t.post} onDone={onDone} />;
  if (t.list) return <SendListCard title={t.title} list={t.list} onDone={onDone} />;
  return <SendCard title={t.title} href={t.href ?? ''} onSent={onDone} />;
}

/** Post aprovado: baixar as fotos e copiar a legenda para postar no Instagram. */
function PostCard({
  title,
  post,
  onDone,
}: {
  title: string;
  post: NonNullable<ToSend['post']>;
  onDone: () => void;
}) {
  const toast = useToast();
  return (
    <Card className="p-4" data-testid="office-post-ready">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">
        Aprovado. Baixe as fotos, copie a legenda e poste no Instagram.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {post.photos.map((f) => (
          <a
            key={f.url}
            href={f.url}
            download
            className="block"
            aria-label={`Baixar a foto de ${f.label.toLowerCase()}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={f.thumbUrl}
              alt={f.label}
              className="aspect-square w-full rounded-lg border border-line object-cover"
            />
            <span className="mt-1 block text-center text-sm text-ink-soft">
              Baixar {f.label.toLowerCase()}
            </span>
          </a>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          onClick={() =>
            navigator.clipboard
              ?.writeText(post.caption)
              .then(() => toast('ok', 'Legenda copiada.'))
              .catch(() => toast('danger', 'Não deu para copiar.'))
          }
        >
          Copiar legenda
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Já postei
        </Button>
      </div>
    </Card>
  );
}

/** Promoção aprovada: uma mensagem para cada cliente, com o nome de cada um. */
function SendListCard({
  title,
  list,
  onDone,
}: {
  title: string;
  list: NonNullable<ToSend['list']>;
  onDone: () => void;
}) {
  const [sent, setSent] = useState<string[]>([]);
  const left = list.length - sent.length;
  return (
    <Card className="p-4" data-testid="office-send-list">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">
        Aprovado. Toque em cada cliente para abrir o WhatsApp com a mensagem pronta
        {left ? ` (faltam ${left})` : ''}.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {list.map((c) => (
          <li key={c.customerId} className="flex items-center justify-between gap-3 py-2">
            <span
              className={clsx(
                'text-sm',
                sent.includes(c.customerId) ? 'text-ink-muted line-through' : 'text-ink',
              )}
            >
              {c.name}
            </span>
            <a
              href={c.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setSent((l) => [...new Set([...l, c.customerId])])}
              className={buttonClass(sent.includes(c.customerId) ? 'ghost' : 'secondary', 'sm')}
            >
              <MessageCircle className="size-4" aria-hidden />
              {sent.includes(c.customerId) ? 'Enviado' : 'Enviar'}
            </a>
          </li>
        ))}
      </ul>
      <Button variant="ghost" className="mt-2 w-full" onClick={onDone}>
        {left ? 'Parar por aqui' : 'Pronto'}
      </Button>
    </Card>
  );
}

function SendCard({ title, href, onSent }: { title: string; href: string; onSent: () => void }) {
  return (
    <Card className="p-4">
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">Aprovado. Falta só apertar enviar no WhatsApp.</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => setTimeout(onSent, 500)}
        className={clsx(buttonClass('primary', 'md'), 'mt-3 w-full sm:w-auto')}
      >
        <MessageCircle className="size-4" aria-hidden />
        Enviar no WhatsApp
      </a>
    </Card>
  );
}

export function OfficePage() {
  return (
    <ToSendProvider>
      <OfficeInner />
    </ToSendProvider>
  );
}

function OfficeInner() {
  const q = useOffice();
  const { m, error } = useOfficeSend();
  const data = q.data;
  const asking = data?.pending.filter((p) => !p.suggestion) ?? [];
  const suggestions = data?.pending.filter((p) => p.suggestion) ?? [];
  return (
    <>
      <PageHeader
        title="Escritório"
        description="Os agentes trabalham sozinhos a cada meia hora, no horário da oficina. O que precisa de você aparece aqui e no sininho."
        help="Cada tarefa tem um nível: só sugere, pede aprovação, sozinho com limite ou sozinho. Comece pedindo aprovação e vá liberando o que o agente acerta sempre. Mensagem para o cliente só sai sozinha com o WhatsApp da empresa ligado; até lá, você aprova e aperta enviar. Parar tudo faz todos voltarem a pedir aprovação."
        actions={
          data && (
            <>
              <Button
                variant="secondary"
                icon={<RefreshCw className="size-4" aria-hidden />}
                loading={m.isPending}
                onClick={() =>
                  m.mutate({
                    ok: 'Os agentes olharam tudo agora.',
                    run: () =>
                      api('/api/v1/office/round', {
                        method: 'POST',
                        body: {},
                        idempotencyKey: newIdempotencyKey(),
                      }),
                  })
                }
              >
                Rodar agora
              </Button>
              <Button
                variant={data.paused ? 'primary' : 'outline-danger'}
                icon={
                  data.paused ? (
                    <CirclePlay className="size-4" aria-hidden />
                  ) : (
                    <CirclePause className="size-4" aria-hidden />
                  )
                }
                onClick={() =>
                  m.mutate({
                    ok: data.paused
                      ? 'Os agentes voltaram a trabalhar.'
                      : 'Tudo parado: agora tudo pede sua aprovação.',
                    run: () =>
                      api('/api/v1/office/settings', {
                        method: 'PUT',
                        body: { paused: !data.paused },
                      }),
                  })
                }
              >
                {data.paused ? 'Voltar a trabalhar' : 'Parar tudo'}
              </Button>
            </>
          )
        }
      />
      {q.isPending && <Spinner />}
      {q.isError && <Alert tone="danger">{errorMessage(q.error)}</Alert>}
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {data && (
        <div className="space-y-8">
          {data.paused && (
            <Alert tone="warn" title="Tudo parado">
              Desde {formatDateTime(data.pausedAt)}, os agentes só preparam e pedem sua aprovação.
              Nada sai sozinho.
            </Alert>
          )}
          <ToSendList />
          <Today data={data} />
          <ReceiptCard data={data} />
          <QuoteRequestCard data={data} />

          <section aria-labelledby="esperando">
            <h2 id="esperando" className="mb-3 text-lg font-semibold text-ink">
              Esperando você
            </h2>
            {asking.length ? (
              <ul className="space-y-3">
                {asking.map((p) => (
                  <li key={p.id}>
                    <ProposalCard p={p} />
                  </li>
                ))}
              </ul>
            ) : (
              <Card>
                <EmptyState
                  title="Nada esperando você"
                  description="Quando um agente precisar da sua aprovação, aparece aqui e no sininho."
                />
              </Card>
            )}
          </section>

          {suggestions.length > 0 && (
            <section aria-labelledby="sugestoes">
              <h2 id="sugestoes" className="mb-1 text-lg font-semibold text-ink">
                Sugestões
              </h2>
              <p className="mb-3 text-sm text-ink-muted">
                Tarefas em &quot;só sugere&quot;: ficam aqui, sem aviso no celular.
              </p>
              <ul className="space-y-3">
                {suggestions.map((p) => (
                  <li key={p.id}>
                    <ProposalCard p={p} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="agentes">
            <h2 id="agentes" className="mb-1 text-lg font-semibold text-ink">
              Agentes e o que cada um pode fazer
            </h2>
            <p className="mb-3 text-sm text-ink-muted">
              {data.whatsappConnected
                ? 'O WhatsApp da empresa está ligado: as mensagens podem sair sozinhas.'
                : 'Sem o WhatsApp da empresa ligado, as mensagens ficam em "pede aprovação": você aprova e aperta enviar.'}
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              {data.agents.map((a) => (
                <AgentCard key={a.roleKey} a={a} />
              ))}
            </div>
          </section>

          {data.agents.some((a) => a.roleKey === 'GERENTE' && a.agentId) && <WeekReport />}
          {data.agents.some((a) => a.roleKey === 'FINANCEIRO' && a.agentId) && <CashForecast />}
          {data.agents.some((a) => a.roleKey === 'COMPRAS' && a.agentId) && <SupplierPrices />}
          <Recent items={data.recent} />
          <ReviewLink current={data.googleReviewUrl} discount={data.customerDiscountPct} />
        </div>
      )}
    </>
  );
}

function Today({ data }: { data: OfficeOverviewDto }) {
  const cells: [string, number, string][] = [
    ['Feitas hoje', data.today.done, 'text-ink'],
    ['Sozinhos', data.today.doneAlone, 'text-brand-700'],
    ['Esperando você', data.today.waiting, data.today.waiting ? 'text-warn-600' : 'text-ink'],
  ];
  return (
    <div className="grid grid-cols-3 gap-3" data-testid="office-today">
      {cells.map(([label, n, tone]) => (
        <Card key={label} className="px-3 py-3 text-center sm:px-4">
          <p className={clsx('text-2xl font-semibold tabular-nums', tone)}>{n}</p>
          <p className="mt-0.5 text-xs text-ink-muted sm:text-sm">{label}</p>
        </Card>
      ))}
    </div>
  );
}

const AgentDot = ({ color }: { color: string }) => (
  <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: color }} />
);

export function ProposalCard({ p }: { p: OfficeProposalDto }) {
  const { m, error } = useOfficeSend();
  const [edit, setEdit] = useState(false);
  const [ready, setReady] = useState<ToSend | null>(null);
  const toSend = useContext(ToSendContext);
  const decide = (decision: 'APROVAR' | 'REJEITAR', edits?: Record<string, unknown>) =>
    m.mutate({
      ok: decision === 'APROVAR' ? 'Aprovado.' : 'Recusado.',
      run: async () => {
        const r = await api<{ payload: Record<string, unknown> }>(
          `/api/v1/game/proposals/${p.id}/decide`,
          {
            method: 'POST',
            body: { decision, ...(edits ? { edits } : {}) },
            idempotencyKey: newIdempotencyKey(),
          },
        );
        // Sem o WhatsApp da empresa: o dono aperta enviar no próprio WhatsApp (ou posta).
        const pr = r.payload;
        const next: ToSend | null =
          decision !== 'APROVAR'
            ? null
            : typeof pr.postId === 'string'
              ? {
                  id: p.id,
                  title: p.title,
                  post: { caption: String(pr.text ?? ''), photos: (pr.photos ?? []) as never },
                }
              : Array.isArray(pr.sendList)
                ? { id: p.id, title: p.title, list: pr.sendList as never }
                : pr.sent === false && typeof pr.href === 'string'
                  ? { id: p.id, title: p.title, href: pr.href }
                  : null;
        if (next) {
          if (toSend) toSend.add(next);
          else setReady(next);
        }
        setEdit(false);
      },
    });
  const pl = p.payload;
  const isDelivery = p.task === 'AGENDAR_ENTREGA';
  const isExpense = p.task === 'LANCAR_DESPESA';
  const isQuote = p.task === 'MONTAR_ORCAMENTO';
  const isContract = p.task === 'ENVIAR_CONTRATO';
  const missing = Array.isArray(pl.missing) ? (pl.missing as string[]) : [];
  if (ready) return <ReadyCard t={ready} onDone={() => setReady(null)} />;
  return (
    <Card className="p-4" data-testid="office-proposal">
      <div className="flex items-center gap-2 text-sm text-ink-muted">
        <AgentDot color={p.agentColor} />
        <span className="font-medium text-ink-soft">{p.agentName}</span>
        <span aria-hidden>·</span>
        <span>{formatDateTime(p.createdAt)}</span>
      </div>
      <p className="mt-1.5 font-semibold text-ink">{p.title}</p>
      {isDelivery && (
        <p className="mt-1 text-sm text-ink-soft">
          Entrega em {brDate(String(pl.scheduledDate))} a partir das {String(pl.windowStart)}
          {typeof pl.openCents === 'number' && pl.openCents > 0
            ? ` · saldo ${money(pl.openCents)}`
            : ''}
        </p>
      )}
      {isExpense && <ExpenseSummary pl={pl} />}
      {isQuote && <QuoteSummary pl={pl} />}
      {p.task === 'POST_ANTES_DEPOIS' && Array.isArray(pl.photos) && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(pl.photos as { label: string; url: string; thumbUrl: string }[]).map((f) => (
              <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.thumbUrl}
                  alt={f.label}
                  className="aspect-square w-full rounded-lg border border-line object-cover"
                />
                <span className="mt-1 block text-center text-sm text-ink-soft">{f.label}</span>
              </a>
            ))}
          </div>
          <p className="mt-2 text-sm text-warn-600">
            Aprove só se o cliente deixou divulgar as fotos.
          </p>
        </>
      )}
      {Array.isArray(pl.recipients) && (
        <p className="mt-1 text-sm text-ink-soft">
          Vai para:{' '}
          {(pl.recipients as { name: string }[])
            .slice(0, 6)
            .map((c) => c.name)
            .join(', ')}
          {(pl.recipients as unknown[]).length > 6
            ? ` e mais ${(pl.recipients as unknown[]).length - 6}`
            : ''}
          .
        </p>
      )}
      {isContract && missing.length > 0 && (
        <p className="mt-1 text-sm text-warn-600">
          Antes de aprovar, falta no cadastro: {missing.join(', ')}.{' '}
          <a href={`/painel/pedidos/${String(pl.orderId)}`} className="underline">
            Abrir o pedido
          </a>
        </p>
      )}
      {Array.isArray(pl.cheaperElsewhere) && (
        <div className="mt-1 text-sm text-warn-600">
          <p className="font-medium">Já saiu mais barato em outro fornecedor:</p>
          {(pl.cheaperElsewhere as string[]).map((h) => (
            <p key={h}>{h}</p>
          ))}
        </div>
      )}
      {typeof pl.planProblem === 'string' && (
        <p className="mt-1 text-sm text-warn-600">{pl.planProblem}</p>
      )}
      {typeof pl.autoError === 'string' && pl.autoError && (
        <p className="mt-1 text-sm text-warn-600">
          O agente tentou fazer sozinho e não conseguiu: {pl.autoError}
        </p>
      )}
      {!isExpense && (
        <p className="mt-2 whitespace-pre-line rounded-lg bg-subtle px-3 py-2 text-sm text-ink-soft">
          {isQuote
            ? p.detail.replace('{link}', '[link da proposta]')
            : isContract
              ? p.detail.replace('{link}', '[link do contrato]')
              : p.detail.replaceAll('{nome}', '[nome do cliente]')}
        </p>
      )}
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      {isQuote && <OpenInQuotes draft={pl.draft as QuoteDraft} />}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button loading={m.isPending} onClick={() => decide('APROVAR')}>
          Aprovar
        </Button>
        <Button variant="secondary" disabled={m.isPending} onClick={() => setEdit(true)}>
          Mudar
        </Button>
        <Button variant="ghost" disabled={m.isPending} onClick={() => decide('REJEITAR')}>
          Recusar
        </Button>
      </div>
      <EditDialog
        open={edit}
        p={p}
        busy={m.isPending}
        onClose={() => setEdit(false)}
        onApprove={(edits) => decide('APROVAR', edits)}
      />
    </Card>
  );
}

function EditDialog({
  open,
  p,
  busy,
  onClose,
  onApprove,
}: {
  open: boolean;
  p: OfficeProposalDto;
  busy: boolean;
  onClose: () => void;
  onApprove: (edits: Record<string, unknown>) => void;
}) {
  if (p.task === 'LANCAR_DESPESA')
    return <ExpenseDialog open={open} p={p} busy={busy} onClose={onClose} onApprove={onApprove} />;
  if (p.task === 'AJUSTAR_TABELA')
    return <PriceDialog open={open} p={p} busy={busy} onClose={onClose} onApprove={onApprove} />;
  if (p.task === 'PLANEJAR_OS' && p.payload.entry)
    return <PlanDialog open={open} p={p} busy={busy} onClose={onClose} onApprove={onApprove} />;
  return <MessageDialog open={open} p={p} busy={busy} onClose={onClose} onApprove={onApprove} />;
}

type DialogProps = {
  open: boolean;
  p: OfficeProposalDto;
  busy: boolean;
  onClose: () => void;
  onApprove: (edits: Record<string, unknown>) => void;
};

/** Semana da produção: o dono só muda o dia de começar; os tapeceiros ficam como o Gerente propôs. */
function PlanDialog({ open, p, busy, onClose, onApprove }: DialogProps) {
  const [date, setDate] = useState(String(p.payload.startDate ?? ''));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mudar antes de aprovar"
      description={p.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button loading={busy} onClick={() => onApprove({ scheduledDate: date })}>
            Aprovar com a mudança
          </Button>
        </>
      }
    >
      <Field
        label="Começa em"
        hint="Quem fica com cada peça dá para trocar depois na Semana da oficina."
      >
        {(f) => <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/** Ajustar a tabela: o dono pode escolher outro custo antes de aprovar. */
function PriceDialog({ open, p, busy, onClose, onApprove }: DialogProps) {
  const [amount, setAmount] = useState(
    (Number(p.payload.toCents ?? 0) / 100).toFixed(2).replace('.', ','),
  );
  const cents = parseMoney(amount);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mudar antes de aprovar"
      description={p.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button loading={busy} disabled={!cents} onClick={() => onApprove({ priceCents: cents })}>
            Atualizar a tabela
          </Button>
        </>
      }
    >
      <Field
        label={`Custo novo de ${String(p.payload.catalogName ?? 'material')} (R$)`}
        hint={`Hoje na tabela: ${money(Number(p.payload.fromCents ?? 0))}.`}
      >
        {(f) => (
          <Input
            {...f}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

function MessageDialog({ open, p, busy, onClose, onApprove }: DialogProps) {
  const isDelivery = p.task === 'AGENDAR_ENTREGA';
  const isQuote = p.task === 'MONTAR_ORCAMENTO';
  const isContract = p.task === 'ENVIAR_CONTRATO';
  const [text, setText] = useState(String(p.payload.text ?? p.detail));
  const [date, setDate] = useState(String(p.payload.scheduledDate ?? ''));
  const [start, setStart] = useState(String(p.payload.windowStart ?? '09:00'));
  const textChanged = text.trim() !== String(p.payload.text ?? p.detail).trim();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mudar antes de aprovar"
      description={p.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={busy}
            onClick={() =>
              onApprove({
                ...(textChanged ? { text: text.trim() } : {}),
                ...(isDelivery ? { scheduledDate: date, windowStart: start } : {}),
              })
            }
          >
            Aprovar com a mudança
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isDelivery && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Dia da entrega">
              {(f) => (
                <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              )}
            </Field>
            <Field label="A partir das">
              {(f) => (
                <Input
                  {...f}
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        <Field
          label="Mensagem"
          hint={
            isDelivery && !textChanged
              ? 'Se mudar o dia ou o horário, a mensagem é refeita com a data nova.'
              : isQuote
                ? 'Deixe {link} onde o link da proposta deve entrar.'
                : isContract
                  ? 'Deixe {link} onde o link do contrato deve entrar.'
                  : Array.isArray(p.payload.recipients)
                    ? 'Deixe {nome} onde entra o nome de cada cliente.'
                    : undefined
          }
        >
          {(f) => (
            <Textarea {...f} rows={7} value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** Despesa pela foto: o que o Financeiro leu do comprovante, com a foto ao lado. */
function ExpenseSummary({ pl }: { pl: Record<string, unknown> }) {
  const amount = Number(pl.totalCents ?? 0);
  const rows: [string, string][] = [
    ['Valor', amount > 0 ? money(amount) : 'Não deu para ler: toque em Mudar'],
    ['Data', brDate(String(pl.date ?? ''))],
    ['Quem recebeu', String(pl.beneficiary || 'Não deu para ler')],
    ['Categoria', String(pl.categoryLabel ?? pl.category ?? '')],
    ['Situação', pl.paid ? 'Já pago' : 'A pagar'],
  ];
  return (
    // Em celular estreito a foto fica em cima e os dados embaixo, sem espremer as palavras.
    <div className="mt-2 flex flex-wrap gap-3 rounded-lg bg-subtle p-3">
      {typeof pl.thumbUrl === 'string' && (
        <a
          href={String(pl.photoUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
          aria-label="Ver a foto do comprovante"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pl.thumbUrl}
            alt="Comprovante"
            className="size-20 rounded-md border border-line object-cover"
          />
        </a>
      )}
      <dl className="grid min-w-[13rem] flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="min-w-0 break-words text-ink">{v}</dd>
          </div>
        ))}
        {typeof pl.description === 'string' && pl.description && (
          <dd className="col-span-2 mt-1 text-ink-soft">{pl.description}</dd>
        )}
        {Array.isArray(pl.items) && pl.items.length > 0 && (
          <dd className="col-span-2 mt-1 text-ink-soft">
            {(pl.items as { description: string; unit: string | null; unitPriceCents: number }[])
              .slice(0, 4)
              .map(
                (i) => `${i.description}: ${money(i.unitPriceCents)}${i.unit ? `/${i.unit}` : ''}`,
              )
              .join(' · ')}
            <span className="block text-ink-muted">
              O preço de cada material fica guardado para comparar os fornecedores.
            </span>
          </dd>
        )}
      </dl>
    </div>
  );
}

function ExpenseDialog({ open, p, busy, onClose, onApprove }: DialogProps) {
  const pl = p.payload;
  const cats = useQuery({
    queryKey: ['finance', 'expense-categories'],
    queryFn: () => api<ExpenseCategoryDto[]>('/api/v1/finance/expense-categories'),
    enabled: open,
  });
  const [amount, setAmount] = useState(
    Number(pl.totalCents ?? 0) > 0
      ? (Number(pl.totalCents) / 100).toFixed(2).replace('.', ',')
      : '',
  );
  const [date, setDate] = useState(String(pl.date ?? ''));
  const [who, setWho] = useState(String(pl.beneficiary ?? ''));
  const [what, setWhat] = useState(String(pl.description ?? ''));
  const [category, setCategory] = useState(String(pl.category ?? 'OUTRAS'));
  const [paid, setPaid] = useState(pl.paid === true);
  const cents = parseMoney(amount);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Conferir a despesa"
      description="Corrija o que o Financeiro leu errado e aprove."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={busy}
            disabled={!cents || !date || who.trim().length < 2}
            onClick={() =>
              onApprove({
                amountCents: cents,
                date,
                beneficiary: who.trim(),
                ...(what.trim().length >= 2 ? { description: what.trim() } : {}),
                category,
                paid,
              })
            }
          >
            Lançar despesa
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (R$)">
            {(f) => (
              <Input
                {...f}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label="Data">
            {(f) => (
              <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
        </div>
        <Field label="Quem recebeu">
          {(f) => <Input {...f} value={who} onChange={(e) => setWho(e.target.value)} />}
        </Field>
        <Field label="O que foi">
          {(f) => <Input {...f} value={what} onChange={(e) => setWhat(e.target.value)} />}
        </Field>
        <Field label="Categoria">
          {(f) => (
            <Select {...f} value={category} onChange={(e) => setCategory(e.target.value)}>
              {(cats.data ?? [{ value: category, label: String(pl.categoryLabel ?? category) }])
                .filter((c) => !('active' in c) || c.active || c.value === category)
                .map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Checkbox
          label="Já está pago"
          description="Dá baixa na conta junto. Sem marcar, vai para Contas a pagar."
          checked={paid}
          onChange={(e) => setPaid(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}

/** Orçamento montado pelo agente: o valor, como chegou nele e o que falta saber. */
function QuoteSummary({ pl }: { pl: Record<string, unknown> }) {
  const c = (k: string) => Number(pl[k] ?? 0);
  const lines = Array.isArray(pl.lines) ? (pl.lines as string[]) : [];
  const questions = Array.isArray(pl.questions) ? (pl.questions as string[]) : [];
  const rows: [string, string][] = [
    ['Materiais', money(c('materialsCents'))],
    ['Mão de obra', money(c('laborCents'))],
    ['Logística', money(c('logisticsCents'))],
    ['Lucro', money(c('profitCents'))],
  ];
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-subtle p-3 text-sm">
      <p className="text-ink">
        <span className="text-lg font-semibold tabular-nums">{money(c('totalCents'))}</span>{' '}
        <span className="text-ink-muted">à vista</span>
        {typeof pl.installmentTotalCents === 'number' && c('installments') > 1 && (
          <span className="text-ink-muted">
            {' '}
            · {c('installments')}x de{' '}
            {money(Math.ceil(c('installmentTotalCents') / c('installments')))}
          </span>
        )}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-muted">{k}</dt>
            <dd className="tabular-nums text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {lines.length > 0 && (
        <ul className="list-inside list-disc text-ink-soft">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {typeof pl.summary === 'string' && pl.summary && (
        <p className="text-ink-soft">{pl.summary}</p>
      )}
      {questions.length > 0 && (
        <div>
          <p className="font-medium text-warn-600">Confirme com o cliente:</p>
          <ul className="list-inside list-disc text-ink-soft">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
      {typeof pl.blocker === 'string' && pl.blocker && (
        <p className="font-medium text-danger-600">
          {pl.blocker} Abra no orçamento para completar.
        </p>
      )}
    </div>
  );
}

/** Leva o rascunho do agente para a tela de Orçamentos, para mexer em tudo antes de salvar. */
function OpenInQuotes({ draft }: { draft: QuoteDraft }) {
  const me = useMe();
  const router = useRouter();
  const uid = me.data?.user.id;
  if (!uid || !draft) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mt-2"
      icon={<Calculator className="size-4" aria-hidden />}
      onClick={() => {
        if (putDraftInEditor(uid, draft)) router.push('/painel/orcamentos');
      }}
    >
      Abrir no orçamento
    </Button>
  );
}

/** Pedir orçamento ao agente: o dono conta o pedido (texto e fotos) e ele monta. */
function QuoteRequestCard({ data }: { data: OfficeOverviewDto }) {
  const { m, error, setError } = useOfficeSend();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [request, setRequest] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const agent = data.agents.find((a) => a.roleKey === 'ORCAMENTOS');
  if (!agent?.agentId) return null;
  const close = () => {
    setOpen(false);
    setError(null);
  };
  return (
    <Card className="p-4" data-testid="office-quote-request">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Pedir orçamento ao agente</p>
          <p className="text-sm text-ink-muted">
            {data.aiReady
              ? 'Conte o pedido do cliente e mande fotos. O agente monta com a sua tabela e você aprova.'
              : 'Fica disponível assim que a IA for ligada no sistema.'}
          </p>
        </div>
        <Button
          icon={<Calculator className="size-4" aria-hidden />}
          disabled={!data.aiReady}
          onClick={() => setOpen(true)}
        >
          Pedir orçamento
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Pedir orçamento ao agente"
        description="Quanto mais detalhe (medidas, tecido, fotos), mais certo o valor."
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Voltar
            </Button>
            <Button
              loading={m.isPending}
              disabled={name.trim().length < 2 || request.trim().length < 5}
              onClick={() =>
                m.mutate(
                  {
                    ok: 'O agente montou o orçamento.',
                    run: () =>
                      api('/api/v1/office/quote', {
                        method: 'POST',
                        body: { customerName: name, phone, city, request, photos },
                        idempotencyKey: newIdempotencyKey(),
                      }),
                  },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setName('');
                      setPhone('');
                      setCity('');
                      setRequest('');
                      setPhotos([]);
                    },
                  },
                )
              }
            >
              {m.isPending ? 'Montando…' : 'Montar orçamento'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Cliente">
            {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="WhatsApp">
              {(f) => (
                <Input
                  {...f}
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              )}
            </Field>
            <Field label="Cidade">
              {(f) => <Input {...f} value={city} onChange={(e) => setCity(e.target.value)} />}
            </Field>
          </div>
          <Field label="O que o cliente quer">
            {(f) => (
              <Textarea
                {...f}
                rows={5}
                placeholder="Ex.: sofá 3 lugares de 2,10 m, trocar o tecido por linho cinza e a espuma do assento."
                value={request}
                onChange={(e) => setRequest(e.target.value)}
              />
            )}
          </Field>
          <Field label={`Fotos (${photos.length} de 3)`}>
            {(f) => (
              <Input
                {...f}
                type="file"
                accept="image/*"
                multiple
                disabled={photos.length >= 3}
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])].slice(0, 3 - photos.length);
                  e.target.value = '';
                  const urls = await Promise.all(
                    files.map((x) => shrinkImage(x, 1280, 'image/jpeg', 0.8).catch(() => null)),
                  );
                  setPhotos((p) => [...p, ...urls.filter((u): u is string => !!u)].slice(0, 3));
                }}
              />
            )}
          </Field>
          {photos.length > 0 && (
            <div className="flex gap-2">
              {photos.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt={`Foto ${i + 1}`}
                  className="size-16 rounded-md border border-line object-cover"
                />
              ))}
              <Button variant="ghost" size="sm" onClick={() => setPhotos([])}>
                Tirar fotos
              </Button>
            </div>
          )}
        </div>
      </Dialog>
    </Card>
  );
}

/** Relatório da semana (Gerente): os últimos 7 dias; chega no sininho no domingo à tarde. */
/** Financeiro: o que entra e sai nas próximas 4 semanas, com os maiores valores de cada uma. */
function CashForecast() {
  const q = useQuery({
    queryKey: [...KEY, 'forecast'],
    queryFn: () => api<OfficeForecastDto>('/api/v1/office/forecast-weeks'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const f = q.data;
  if (!f) return null;
  // Saldo somando as semanas (sem contar o vencido).
  const running = f.weeks.map((_, k) =>
    f.weeks.slice(0, k + 1).reduce((a, w) => a + w.inCents - w.outCents, 0),
  );
  return (
    <section aria-labelledby="caixa-titulo" id="caixa" className="scroll-mt-20">
      <h2 id="caixa-titulo" className="mb-1 text-lg font-semibold text-ink">
        Caixa das próximas semanas
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        O que está para receber dos clientes e da maquininha, e as contas a pagar já lançadas.
      </p>
      <Card className="divide-y divide-line p-0" data-testid="office-forecast">
        {(f.overdueInCents > 0 || f.overdueOutCents > 0) && (
          <div className="px-4 py-3 text-sm">
            {f.overdueInCents > 0 && (
              <p className="text-danger-600">
                Clientes em atraso: {money(f.overdueInCents)} para receber.
              </p>
            )}
            {f.overdueOutCents > 0 && (
              <p className="text-danger-600">Contas vencidas: {money(f.overdueOutCents)}.</p>
            )}
          </div>
        )}
        {f.weeks.map((w, k) => {
          const net = w.inCents - w.outCents;
          const sum = running[k]!;
          return (
            <div key={w.from} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-ink">
                  {k === 0
                    ? 'Esta semana'
                    : `${brDate(w.from).slice(0, 5)} a ${brDate(w.to).slice(0, 5)}`}
                </p>
                <p
                  className={clsx(
                    'tabular-nums font-semibold',
                    net < 0 ? 'text-danger-600' : 'text-ink',
                  )}
                >
                  {net >= 0 ? '+' : '−'}
                  {money(Math.abs(net))}
                </p>
              </div>
              <p className="text-sm text-ink-muted">
                Entra {money(w.inCents)} · sai {money(w.outCents)}
                {k > 0 && ` · somando as semanas: ${sum < 0 ? '−' : ''}${money(Math.abs(sum))}`}
              </p>
              {(w.ins.length > 0 || w.outs.length > 0) && (
                <ul className="mt-1 space-y-0.5 text-sm text-ink-soft">
                  {w.ins.slice(0, 2).map((l) => (
                    <li key={`i${l.label}${l.date}`}>
                      + {money(l.amountCents)} {l.label} ({brDate(l.date).slice(0, 5)})
                    </li>
                  ))}
                  {w.outs.slice(0, 2).map((l) => (
                    <li key={`o${l.label}${l.date}`}>
                      − {money(l.amountCents)} {l.label} ({brDate(l.date).slice(0, 5)})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </Card>
    </section>
  );
}

const UNIT_LABEL: Record<string, string> = { m: 'metro', kg: 'kg', un: 'unidade', l: 'litro' };

/** Compras: o que cada fornecedor cobrou da última vez (das notas lidas pela foto). */
function SupplierPrices() {
  const q = useQuery({
    queryKey: [...KEY, 'material-prices'],
    queryFn: () => api<OfficeMaterialPricesDto>('/api/v1/office/material-prices'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const list = q.data?.materials ?? [];
  if (!list.length) return null;
  return (
    <section aria-labelledby="precos-titulo" id="precos" className="scroll-mt-20">
      <h2 id="precos-titulo" className="mb-1 text-lg font-semibold text-ink">
        Preço dos fornecedores
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        Quanto cada um cobrou na última compra, pelas notas que você mandou na foto. O mais barato
        vem primeiro.
      </p>
      <Card className="divide-y divide-line p-0" data-testid="office-prices">
        {list.map((m) => (
          <div key={`${m.name}${m.unit}`} className="px-4 py-3">
            <p className="font-medium text-ink">
              {m.name}
              {m.unit && (
                <span className="font-normal text-ink-muted">
                  {' '}
                  · {UNIT_LABEL[m.unit] ?? m.unit}
                </span>
              )}
            </p>
            <ul className="mt-1 space-y-0.5 text-sm">
              {m.suppliers.map((s, i) => (
                <li key={s.supplierName} className="flex justify-between gap-3">
                  <span
                    className={clsx(
                      i === 0 && m.suppliers.length > 1 ? 'text-ok-600' : 'text-ink-soft',
                    )}
                  >
                    {s.supplierName}{' '}
                    <span className="text-ink-muted">({brDate(s.date).slice(0, 5)})</span>
                  </span>
                  <span
                    className={clsx(
                      'tabular-nums',
                      i === 0 && m.suppliers.length > 1 ? 'font-semibold text-ok-600' : 'text-ink',
                    )}
                  >
                    {money(s.unitPriceCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </section>
  );
}

function WeekReport() {
  const q = useQuery({
    queryKey: [...KEY, 'week'],
    queryFn: () => api<OfficeWeekDto>('/api/v1/office/week'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const w = q.data;
  if (!w) return null;
  const diff =
    w.lastYearContractedCents && w.lastYearContractedCents > 0
      ? Math.round(
          ((w.contractedCents - w.lastYearContractedCents) / w.lastYearContractedCents) * 100,
        )
      : null;
  const mo = w.month;
  const goalLeft =
    mo.lastYearMonthCents !== null ? Math.max(0, mo.lastYearMonthCents - mo.contractedCents) : null;
  const cells: [string, string, string?][] = [
    [
      'Fechou',
      money(w.contractedCents),
      `${plural(w.contractedOrders, 'pedido', 'pedidos')}${diff !== null ? ` · ${diff >= 0 ? '+' : ''}${diff}% que no ano passado` : ''}`,
    ],
    ['Entrou', money(w.receivedCents)],
    ['Saiu', money(w.paidCents)],
    [
      'Lucro das OS entregues',
      money(w.marginCents),
      plural(w.completedOrders, 'OS entregue', 'OS entregues'),
    ],
  ];
  return (
    <section aria-labelledby="semana-titulo" id="semana" className="scroll-mt-20">
      <h2 id="semana-titulo" className="mb-1 text-lg font-semibold text-ink">
        Relatório da semana
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        De {brDate(w.from)} a {brDate(w.to)}. O Gerente avisa no sininho todo domingo à tarde.
      </p>
      <Card className="space-y-4 p-4" data-testid="office-week">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cells.map(([k, v, sub]) => (
            <div key={k}>
              <dt className="text-xs text-ink-muted">{k}</dt>
              <dd className="text-lg font-semibold tabular-nums text-ink">{v}</dd>
              {sub && <dd className="text-xs text-ink-muted">{sub}</dd>}
            </div>
          ))}
        </dl>
        {w.services.length > 0 && (
          <div>
            <p className="mb-1 text-sm font-medium text-ink">Lucro por serviço</p>
            <ul className="divide-y divide-line text-sm">
              {w.services.map((s) => (
                <li key={s.label} className="flex justify-between gap-3 py-1.5">
                  <span className="text-ink-soft">
                    {s.label} <span className="text-ink-muted">({s.orders})</span>
                  </span>
                  <span className="tabular-nums text-ink">
                    {money(s.marginCents)}{' '}
                    <span className="text-ink-muted">de {money(s.revenueCents)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="rounded-lg bg-subtle px-3 py-2 text-sm">
          <p className="font-medium text-ink">No mês: fechou {money(mo.contractedCents)}</p>
          {mo.lastYearMonthCents === null ? (
            <p className="text-ink-muted">Sem pedidos do mesmo mês do ano passado para comparar.</p>
          ) : (
            <p className="text-ink-soft">
              Ano passado, até o mesmo dia: {money(mo.lastYearSoFarCents ?? 0)}. No mês inteiro:{' '}
              {money(mo.lastYearMonthCents)}
              {goalLeft ? (
                <>
                  . Para passar dele, faltam <strong>{money(goalLeft)}</strong>.
                </>
              ) : (
                <span className="text-ok-600">. Já passou do ano passado.</span>
              )}
            </p>
          )}
        </div>
        <ul className="space-y-1 text-sm text-ink-soft">
          <li>
            Orçamentos: {plural(w.quotesSent, 'enviado', 'enviados')},{' '}
            {plural(w.quotesApproved, 'aprovado', 'aprovados')}.
          </li>
          {w.receivableOverdueCents > 0 && (
            <li className="text-danger-600">
              Para receber em atraso: {money(w.receivableOverdueCents)}.
            </li>
          )}
          <li>
            Semana que vem: {plural(w.nextWeek.deliveries, 'entrega', 'entregas')} e{' '}
            {plural(w.nextWeek.billsCount, 'conta', 'contas')} a pagar
            {w.nextWeek.billsCents ? ` (${money(w.nextWeek.billsCents)})` : ''}.
          </li>
          {w.reworks > 0 && (
            <li className="text-danger-600">
              {plural(w.reworks, 'retrabalho', 'retrabalhos')} na semana.
            </li>
          )}
        </ul>
      </Card>
    </section>
  );
}

/** Despesa pela foto: tirar a foto do comprovante e o Financeiro lança. */
function ReceiptCard({ data }: { data: OfficeOverviewDto }) {
  const { m, error } = useOfficeSend();
  const input = useRef<HTMLInputElement>(null);
  const finance = data.agents.find((a) => a.roleKey === 'FINANCEIRO');
  if (!finance?.agentId) return null;
  return (
    <Card className="p-4" data-testid="office-receipt">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Lançar despesa pela foto</p>
          <p className="text-sm text-ink-muted">
            {data.aiReady
              ? 'Tire a foto da nota, do cupom ou do comprovante do Pix. O Financeiro lê e prepara a despesa.'
              : 'Fica disponível assim que a IA for ligada no sistema.'}
          </p>
        </div>
        <Button
          icon={<Camera className="size-4" aria-hidden />}
          loading={m.isPending}
          disabled={!data.aiReady}
          onClick={() => input.current?.click()}
        >
          Tirar foto
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            m.mutate({
              ok: 'O Financeiro leu o comprovante.',
              run: async () => {
                const fd = new FormData();
                fd.append('file', await preparePhoto(file));
                return api('/api/v1/office/receipt', { method: 'POST', body: fd });
              },
            });
          }}
        />
      </div>
      {m.isPending && <p className="mt-2 text-sm text-ink-muted">Lendo o comprovante…</p>}
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
    </Card>
  );
}

export function AgentCard({ a }: { a: OfficeAgentDto }) {
  const { m, error } = useOfficeSend();
  return (
    <Card className="p-4" data-testid={`office-agent-${a.roleKey}`}>
      <div className="flex items-center gap-2">
        <AgentDot color={a.color} />
        <p className="font-semibold text-ink">{a.name}</p>
        {a.status === 'PAUSADO' && <Badge tone="warn">Pausado</Badge>}
        {!a.agentId && a.tasks.length > 0 && (
          <Button
            size="sm"
            className="ml-auto"
            icon={<UserPlus className="size-4" aria-hidden />}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                ok: `${a.name} começou a trabalhar.`,
                run: () =>
                  api('/api/v1/office/hire', {
                    method: 'POST',
                    body: { roleKey: a.roleKey },
                    idempotencyKey: newIdempotencyKey(),
                  }),
              })
            }
          >
            Contratar
          </Button>
        )}
      </div>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      {a.tasks.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {a.tasks.map((t) => (
            <TaskRow key={t.key} t={t} agentId={a.agentId} />
          ))}
        </ul>
      )}
      {a.alsoDoes.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-ink-muted">
          {a.alsoDoes.map((x) => (
            <li key={x}>• {x}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TaskRow({ t, agentId }: { t: OfficeTaskDto; agentId: string | null }) {
  const { m, error } = useOfficeSend();
  const [limit, setLimit] = useState(t.limitCents !== null ? money(t.limitCents) : '');
  // Sem valor em dinheiro, "sozinho com limite" não existe para a tarefa.
  const levels = OFFICE_LEVELS.filter((l) => l !== 3 || t.money);
  const save = (nivel: OfficeLevel, limiteCents?: number | null) =>
    m.mutate({
      ok: `"${t.label}": ${OFFICE_LEVEL_LABEL[nivel].toLowerCase()}.`,
      run: () =>
        api('/api/v1/office/tasks', {
          method: 'PUT',
          body: { agentId, task: t.key, setting: { nivel, limiteCents: limiteCents ?? null } },
        }),
    });
  const blocked = t.level > t.maxLevel;
  return (
    <li className="py-3">
      <p className="font-medium text-ink">{t.label}</p>
      <p className="text-sm text-ink-muted">{t.what}</p>
      <div
        role="radiogroup"
        aria-label={`Nível: ${t.label}`}
        className="mt-2 grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap"
      >
        {levels.map((l) => {
          const active = t.level === l;
          const disabled = !agentId || m.isPending || l > t.maxLevel;
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              title={OFFICE_LEVEL_HINT[l]}
              onClick={() => {
                if (l === 3) {
                  const cents = parseMoney(limit);
                  if (cents === null) return save(3, 50_000);
                  return save(3, cents);
                }
                save(l);
              }}
              className={clsx(
                'rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition',
                active
                  ? 'bg-brand-700 text-white ring-brand-700'
                  : 'bg-surface text-ink-soft ring-line hover:bg-subtle',
                disabled && !active && 'cursor-not-allowed opacity-45 hover:bg-surface',
              )}
            >
              {OFFICE_LEVEL_LABEL[l]}
            </button>
          );
        })}
      </div>
      {t.level === 3 && t.money && (
        <div className="mt-2 flex items-end gap-2">
          <Field label="Sozinho até" className="w-40">
            {(f) => (
              <Input
                {...f}
                inputMode="decimal"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            )}
          </Field>
          <Button
            size="sm"
            variant="secondary"
            className="mb-[22px]"
            onClick={() => save(3, parseMoney(limit))}
          >
            Salvar
          </Button>
        </div>
      )}
      {/* O motivo "precisa do WhatsApp da empresa" já aparece uma vez no topo dos agentes. */}
      {((t.maxReason && !t.maxReason.includes('WhatsApp da empresa')) || blocked) && (
        <p className="mt-1.5 text-xs text-ink-muted">
          {blocked ? 'Por enquanto continua pedindo aprovação. ' : ''}
          {t.maxReason}
        </p>
      )}
      <p className="mt-1.5 text-xs text-ink-muted">
        {t.approved || t.rejected
          ? `${plural(t.approved, 'aprovada', 'aprovadas')}, ${plural(t.rejected, 'recusada', 'recusadas')}${t.doneAlone ? `, ${t.doneAlone} sozinho no mês` : ''}`
          : 'Ainda sem histórico.'}
      </p>
      {t.suggestLevelUp && (
        <Alert tone="ok" className="mt-2">
          {plural(t.streak, 'aprovação seguida', 'aprovações seguidas')} sem você mudar nada. Que
          tal deixar fazer sozinho?
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mt-2">
          {error}
        </Alert>
      )}
    </li>
  );
}

const STATUS: Record<string, [string, 'ok' | 'brand' | 'neutral' | 'warn']> = {
  APROVADA: ['Aprovado por você', 'ok'],
  EXECUTADA_TESTE: ['Feito (teste)', 'ok'],
  REJEITADA: ['Recusado', 'neutral'],
  OBSOLETA: ['Desatualizado', 'warn'],
};

function Recent({ items }: { items: OfficeProposalDto[] }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="recentes">
      <h2 id="recentes" className="mb-3 text-lg font-semibold text-ink">
        Feito recentemente
      </h2>
      <Card>
        <ul className="divide-y divide-line">
          {items.slice(0, 15).map((p) => {
            const [label, tone] = p.decidedByAgent
              ? (['Feito sozinho', 'brand'] as const)
              : (STATUS[p.status] ?? [p.status, 'neutral']);
            return (
              <li key={p.id} className="flex items-start gap-3 px-4 py-3">
                <AgentDot color={p.agentColor} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{p.title}</p>
                  <p className="text-xs text-ink-muted">
                    {p.agentName} · {formatDateTime(p.decidedAt)}
                    {p.status === 'OBSOLETA' && p.decisionNote ? ` · ${p.decisionNote}` : ''}
                  </p>
                </div>
                <Badge tone={tone}>{label}</Badge>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

function ReviewLink({ current, discount }: { current: string | null; discount: number }) {
  const { m, error } = useOfficeSend();
  const [url, setUrl] = useState(current ?? '');
  const [pct, setPct] = useState(String(discount));
  const pctN = Number(pct);
  const pctOk = /^\d{1,2}$/.test(pct.trim()) && pctN <= 50;
  return (
    <section aria-labelledby="avaliacao">
      <h2 id="avaliacao" className="mb-1 text-lg font-semibold text-ink">
        Avaliação e desconto do Atendimento
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        O link vai junto quando o Atendimento pede a avaliação depois da entrega. Sem ele, só
        agradece e pede a opinião do cliente. O desconto vale para o aniversário do cliente e para a
        indicação (quem indica e quem foi indicado).
      </p>
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <Field label="Link de avaliação no Google">
            {(f) => (
              <Input
                {...f}
                placeholder="https://g.page/r/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <Field label="Desconto (%)" error={pctOk ? undefined : 'De 0 a 50'}>
            {(f) => (
              <Input
                {...f}
                inputMode="numeric"
                value={pct}
                onChange={(e) => setPct(e.target.value.replace(/\D/g, '').slice(0, 2))}
              />
            )}
          </Field>
          <Button
            className="sm:mb-[22px]"
            loading={m.isPending}
            disabled={!pctOk}
            onClick={() =>
              m.mutate({
                ok: 'Salvo.',
                run: () =>
                  api('/api/v1/office/settings', {
                    method: 'PUT',
                    body: { googleReviewUrl: url.trim() || null, customerDiscountPct: pctN },
                  }),
              })
            }
          >
            Salvar
          </Button>
        </div>
        {error && (
          <Alert tone="danger" className="mt-2">
            {error}
          </Alert>
        )}
      </Card>
    </section>
  );
}
