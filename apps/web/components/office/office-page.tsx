'use client';

import {
  OFFICE_LEVELS,
  OFFICE_LEVEL_HINT,
  OFFICE_LEVEL_LABEL,
  type OfficeAgentDto,
  type OfficeLevel,
  type OfficeOverviewDto,
  type OfficeProposalDto,
  type OfficeTaskDto,
  plural,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CirclePause, CirclePlay, MessageCircle, RefreshCw, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { brDate, money, parseMoney } from '@/lib/finance';
import { formatDateTime } from '@/lib/format';

const KEY = ['office'] as const;

function useOffice() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<OfficeOverviewDto>('/api/v1/office'),
    refetchInterval: 60_000,
  });
}

/** Mutação do Escritório: devolve o escritório atualizado ou recarrega. */
function useOfficeSend() {
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
export function OfficePage() {
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
          <Today data={data} />

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

          <Recent items={data.recent} />
          <ReviewLink current={data.googleReviewUrl} />
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

function ProposalCard({ p }: { p: OfficeProposalDto }) {
  const { m, error } = useOfficeSend();
  const [edit, setEdit] = useState(false);
  const [sendLink, setSendLink] = useState<string | null>(null);
  const decide = (decision: 'APROVAR' | 'REJEITAR', edits?: Record<string, string>) =>
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
        // Sem o WhatsApp da empresa: o dono aperta enviar no próprio WhatsApp.
        if (
          decision === 'APROVAR' &&
          r.payload.sent === false &&
          typeof r.payload.href === 'string'
        )
          setSendLink(r.payload.href);
        setEdit(false);
      },
    });
  const pl = p.payload;
  const isDelivery = p.task === 'AGENDAR_ENTREGA';
  if (sendLink)
    return (
      <Card className="p-4">
        <p className="font-medium text-ink">{p.title}</p>
        <p className="mt-1 text-sm text-ink-muted">
          Aprovado. Falta só apertar enviar no WhatsApp.
        </p>
        <a
          href={sendLink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setTimeout(() => setSendLink(null), 500)}
          className={clsx(buttonClass('primary', 'md'), 'mt-3 w-full sm:w-auto')}
        >
          <MessageCircle className="size-4" aria-hidden />
          Enviar no WhatsApp
        </a>
      </Card>
    );
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
      {typeof pl.autoError === 'string' && pl.autoError && (
        <p className="mt-1 text-sm text-warn-600">
          O agente tentou fazer sozinho e não conseguiu: {pl.autoError}
        </p>
      )}
      <p className="mt-2 whitespace-pre-line rounded-lg bg-subtle px-3 py-2 text-sm text-ink-soft">
        {p.detail}
      </p>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
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
  onApprove: (edits: Record<string, string>) => void;
}) {
  const isDelivery = p.task === 'AGENDAR_ENTREGA';
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

function AgentCard({ a }: { a: OfficeAgentDto }) {
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

function ReviewLink({ current }: { current: string | null }) {
  const { m, error } = useOfficeSend();
  const [url, setUrl] = useState(current ?? '');
  return (
    <section aria-labelledby="avaliacao">
      <h2 id="avaliacao" className="mb-1 text-lg font-semibold text-ink">
        Link de avaliação no Google
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        O Atendimento manda este link quando pede a avaliação depois da entrega. Sem ele, só
        agradece e pede a opinião do cliente.
      </p>
      <Card className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Link" className="flex-1">
            {(f) => (
              <Input
                {...f}
                placeholder="https://g.page/r/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <Button
            className="sm:mb-[22px]"
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                ok: 'Link salvo.',
                run: () =>
                  api('/api/v1/office/settings', {
                    method: 'PUT',
                    body: { googleReviewUrl: url.trim() || null },
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
