'use client';

import {
  PICKUP_TEAMS,
  PICKUP_TEAM_LABEL,
  REWORK_CAUSES,
  REWORK_CAUSE_LABEL,
  REWORK_STAGE_LABEL,
  type ReworkCause,
  type ReworkDto,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Plus, RotateCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { brDate, localToday, money, monthStart, parseMoney } from '@/lib/finance';
import { useCan, useModules } from '@/lib/hooks';
import {
  useReworkCandidates,
  useReworkStats,
  useReworks,
  type ReworkCandidate,
  type ReworkSituation,
} from '@/lib/reworks';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;

const SITUATIONS: { key: ReworkSituation; label: string }[] = [
  { key: 'abertos', label: 'Em andamento' },
  { key: 'concluidos', label: 'Concluídos' },
  { key: 'cancelados', label: 'Cancelados' },
  { key: 'todos', label: 'Todos' },
];

/** Mutação dos retrabalhos: ao terminar, recarrega tudo (pedido, retirada, OS, agenda). */
function useReworkSend(onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ run }: { run: () => Promise<unknown>; ok: string }) => run(),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries();
      setError(null);
      toast('ok', v.ok);
      onDone?.();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error };
}

/**
 * 2026-11-18: Retrabalhos (substituem Devoluções). Um serviço já feito volta para ser refeito:
 * vira um pedido próprio, sem cobrança, com retirada e OS normais, tudo marcado em vermelho.
 */
export function ReworksPage() {
  const can = useCan();
  const manage = can('os.gerenciar') && can('pedidos.gerenciar') && can('retiradas.gerenciar');
  const [situacao, setSituacao] = useState<ReworkSituation>('abertos');
  const [search, setSearch] = useState('');
  const q = useReworks(situacao, search.trim());
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<ReworkDto | null>(null);
  const [cancel, setCancel] = useState<ReworkDto | null>(null);
  return (
    <>
      <PageHeader
        title="Retrabalhos"
        description="Serviços que voltaram para ser refeitos: prazo, retirada, OS e quanto custaram."
        help="Escolha o serviço que voltou e as peças. O retrabalho vira um pedido sem cobrança, com a retirada e a OS de sempre. Na agenda, nas OS e nos pedidos ele aparece em vermelho. O gasto (material, mão de obra, logística e custo extra) entra no Resumo do financeiro."
        actions={
          manage && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setCreate(true)}
              data-testid="rework-new"
            >
              Novo retrabalho
            </Button>
          )
        }
      />
      <ReworkStats />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="group">
          {SITUATIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSituacao(s.key)}
              aria-pressed={situacao === s.key}
              className={clsx(
                'rounded-md px-3 py-1.5 text-sm font-medium transition',
                situacao === s.key ? 'bg-brand-700 text-white' : 'text-ink-soft hover:bg-subtle',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            aria-label="Buscar retrabalho"
            placeholder="Cliente, RT ou pedido"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : !q.data.length ? (
        <Card>
          <EmptyState
            icon={<RotateCcw className="size-6" />}
            title={situacao === 'abertos' ? 'Nenhum retrabalho em andamento' : 'Nada por aqui'}
          />
        </Card>
      ) : (
        <ul className="space-y-3" data-testid="reworks-list">
          {q.data.map((r) => (
            <ReworkRow
              key={r.id}
              r={r}
              manage={manage}
              onEdit={() => setEdit(r)}
              onCancel={() => setCancel(r)}
            />
          ))}
        </ul>
      )}
      {create && <CreateReworkDialog onClose={() => setCreate(false)} />}
      {edit && <EditReworkDialog r={edit} onClose={() => setEdit(null)} />}
      {cancel && <CancelReworkDialog r={cancel} onClose={() => setCancel(null)} />}
    </>
  );
}

function stageTone(r: ReworkDto) {
  if (r.stage === 'CONCLUIDO') return 'ok' as const;
  if (r.stage === 'CANCELADO') return 'neutral' as const;
  return r.late ? ('danger' as const) : ('warn' as const);
}

function ReworkRow({
  r,
  manage,
  onEdit,
  onCancel,
}: {
  r: ReworkDto;
  manage: boolean;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const open = r.stage !== 'CONCLUIDO' && r.stage !== 'CANCELADO';
  return (
    <li
      className={clsx(
        'card border-l-4 p-4 text-sm',
        r.stage === 'CANCELADO' ? 'border-l-line-strong opacity-70' : 'border-l-danger-600',
      )}
      data-testid={`rework-${r.code}`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-danger-700">{r.code}</span>
            <span className="font-semibold text-ink">{r.customer.name}</span>
            <Badge tone={stageTone(r)}>{REWORK_STAGE_LABEL[r.stage]}</Badge>
            {r.late && open && <Badge tone="danger">Atrasado</Badge>}
          </p>
          <p className="mt-1 text-ink">{r.reason}</p>
          <p className="mt-1 text-ink-muted">
            {REWORK_CAUSE_LABEL[r.cause]} · serviço original{' '}
            <Link
              href={`/painel/pedidos/${r.originalOrder.id}`}
              className="text-brand-700 hover:underline"
            >
              {r.originalOrder.code}
            </Link>
            {' · '}
            {r.items.map((i) => `${i.quantity}× ${i.description}`).join(', ')}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:text-sm">
          <dt className="text-ink-muted">Prazo</dt>
          <dd className={clsx('tabular-nums', r.late && open && 'font-semibold text-danger-600')}>
            {brDate(r.promisedDate)}
          </dd>
          <dt className="text-ink-muted">Retirada</dt>
          <dd>
            {r.pickup ? (
              <Link
                href="/painel/retiradas"
                className="text-brand-700 tabular-nums hover:underline"
              >
                {brDate(r.pickup.scheduledDate)}
                {r.pickup.windowStart ? ` ${r.pickup.windowStart}` : ''}
              </Link>
            ) : (
              'Cliente traz'
            )}
          </dd>
          <dt className="text-ink-muted">OS</dt>
          <dd>
            {r.serviceOrders.length
              ? r.serviceOrders.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ', '}
                    <Link href={`/painel/os/${s.id}`} className="text-brand-700 hover:underline">
                      {s.code}
                    </Link>
                  </span>
                ))
              : '—'}
          </dd>
          {r.cost && (
            <>
              <dt className="text-ink-muted">Gasto</dt>
              <dd className="font-semibold tabular-nums">{money(r.cost.totalCents)}</dd>
            </>
          )}
        </dl>
      </div>
      {r.cancelReason && <p className="mt-2 text-ink-muted">Cancelado: {r.cancelReason}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {r.canGenerateOs && manage && (
          <Link
            href={`/painel/os/nova?pedido=${r.order.id}`}
            className={buttonClass('primary', 'sm')}
          >
            Gerar OS do retrabalho
          </Link>
        )}
        <Link href={`/painel/pedidos/${r.order.id}`} className={buttonClass('secondary', 'sm')}>
          Abrir pedido {r.order.code}
        </Link>
        {manage && open && (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Editar
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** Números do período: quantos, taxa sobre entregas, gasto, motivos e os últimos 6 meses. */
function ReworkStats() {
  const today = localToday();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const q = useReworkStats(from, to);
  const s = q.data;
  const max = Math.max(1, ...(s?.byMonth.map((m) => m.count) ?? [1]));
  const top = s?.byCause.slice().sort((a, b) => b.count - a.count) ?? [];
  return (
    <Card className="mb-6 p-5" data-testid="rework-stats">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-semibold text-ink">Estatística</h2>
        <div className="flex items-end gap-2">
          <Field label="De" className="w-36">
            {(f) => (
              <Input
                {...f}
                type="date"
                value={from}
                onChange={(e) => e.target.value && setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label="Até" className="w-36">
            {(f) => (
              <Input
                {...f}
                type="date"
                value={to}
                onChange={(e) => e.target.value && setTo(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
      {!s ? (
        q.isError ? (
          <Alert tone="danger">{q.error.message}</Alert>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr_1.2fr]">
          <div className="grid grid-cols-2 gap-4 self-start">
            <Tile label="Retrabalhos" value={String(s.count)} />
            <Tile
              label="Taxa"
              value={s.rateBps === null ? '—' : `${(s.rateBps / 100).toFixed(1)}%`}
              hint={`sobre ${s.deliveredOrders} entregues`}
            />
            {s.cost && (
              <Tile
                label="Gasto no período"
                value={money(s.cost.totalCents)}
                className="col-span-2"
                danger
              />
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
              Motivos
            </p>
            {top.length ? (
              <ul className="space-y-2">
                {top.map((c) => (
                  <li key={c.cause}>
                    <div className="flex justify-between text-sm">
                      <span>{REWORK_CAUSE_LABEL[c.cause]}</span>
                      <span className="tabular-nums text-ink-soft">{c.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-subtle">
                      <div
                        className="h-1.5 rounded-full bg-danger-600"
                        style={{ width: `${(c.count / Math.max(1, s.count)) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Nenhum retrabalho no período.</p>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-ink-muted uppercase">
              Últimos 6 meses
            </p>
            <div className="flex h-28 items-end gap-3" role="img" aria-label="Retrabalhos por mês">
              {s.byMonth.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-xs tabular-nums text-ink-soft">{m.count || ''}</span>
                  <div
                    className="w-full max-w-8 rounded-t bg-danger-600/80"
                    style={{ height: `${Math.max(2, (m.count / max) * 72)}px` }}
                  />
                  <span className="text-xs text-ink-muted">{monthLabel(m.month)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Tile({
  label,
  value,
  hint,
  className,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
  danger?: boolean;
}) {
  return (
    <div className={className}>
      <p className="text-sm text-ink-muted">{label}</p>
      <p
        className={clsx(
          'money mt-0.5 text-2xl font-semibold tabular-nums',
          danger && 'text-danger-600',
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

export function CreateReworkDialog({
  onClose,
  initialOrder,
}: {
  onClose: () => void;
  /** "Voltou com defeito" na OS entregue: o serviço já vem escolhido, com as peças marcadas. */
  initialOrder?: ReworkCandidate;
}) {
  const can = useCan();
  const logistica = useModules().logistica;
  const finance = can('financeiro.gerenciar');
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<ReworkCandidate | null>(initialOrder ?? null);
  const candidates = useReworkCandidates(search.trim(), !order);
  const [qty, setQty] = useState<Record<string, number>>(() =>
    initialOrder ? Object.fromEntries(initialOrder.items.map((i) => [i.id, i.quantity])) : {},
  );
  const [reason, setReason] = useState('');
  const [cause, setCause] = useState<ReworkCause>('ERRO_EXECUCAO');
  const [days, setDays] = useState('10');
  const [withPickup, setWithPickup] = useState(logistica);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [team, setTeam] = useState<(typeof PICKUP_TEAMS)[number]>('EQUIPE_PROPRIA');
  const [extra, setExtra] = useState('');
  const [extraNote, setExtraNote] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useReworkSend(onClose);

  const pick = (o: ReworkCandidate) => {
    setOrder(o);
    setQty(Object.fromEntries(o.items.map((i) => [i.id, i.quantity])));
  };
  const items = Object.entries(qty)
    .filter(([, n]) => n > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  const extraCents = extra.trim() ? parseMoney(extra) : null;
  const ready =
    order &&
    items.length > 0 &&
    reason.trim().length >= 3 &&
    Number(days) >= 1 &&
    (!withPickup || (date && time)) &&
    (!extra.trim() || extraCents !== null);

  const submit = () =>
    m.mutate({
      ok: 'Retrabalho cadastrado.',
      run: () =>
        api('/api/v1/reworks', {
          method: 'POST',
          idempotencyKey: key,
          body: {
            originalOrderId: order!.id,
            items,
            reason: reason.trim(),
            cause,
            deliveryBusinessDays: Number(days),
            pickup:
              withPickup && logistica
                ? { scheduledDate: date, windowStart: time, team, participantUserIds: [] }
                : null,
            extraCostCents: finance ? extraCents : null,
            extraCostNote: finance && extraNote.trim() ? extraNote.trim() : null,
          },
        }),
    });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Novo retrabalho"
      description="Escolha o serviço que voltou. O retrabalho não gera cobrança."
      footer={
        order && (
          <Button disabled={!ready} loading={m.isPending} onClick={submit}>
            Cadastrar retrabalho
          </Button>
        )
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {!order ? (
        <div className="space-y-3">
          <Field label="Serviço que precisa ser refeito">
            {(f) => (
              <Input
                {...f}
                autoFocus
                placeholder="Nome do cliente, número do pedido ou serviço"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
          </Field>
          {candidates.isPending ? (
            <Spinner />
          ) : !candidates.data?.length ? (
            <p className="text-sm text-ink-muted">Nenhum serviço encontrado.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {candidates.data.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => pick(o)}
                    className="w-full px-4 py-3 text-left text-sm hover:bg-subtle"
                  >
                    <span className="font-mono font-semibold">{o.code}</span> · {o.customer}
                    <span className="block text-ink-muted">
                      {o.service}
                      {o.deliveredAt ? ` · entregue em ${brDate(o.deliveredAt)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-3 rounded-lg bg-subtle px-4 py-3 text-sm">
            <div>
              <p className="font-semibold">
                {order.code} · {order.customer}
              </p>
              <p className="text-ink-muted">{order.service}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setOrder(null)}>
              Trocar
            </Button>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Peças que voltam</legend>
            <ul className="space-y-2">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3">
                  <Checkbox
                    className="flex-1"
                    label={i.description}
                    checked={(qty[i.id] ?? 0) > 0}
                    onChange={(e) => setQty({ ...qty, [i.id]: e.target.checked ? i.quantity : 0 })}
                  />
                  {i.quantity > 1 && (qty[i.id] ?? 0) > 0 && (
                    <Input
                      aria-label={`Quantidade de ${i.description}`}
                      type="number"
                      min={1}
                      max={i.quantity}
                      className="w-20"
                      value={qty[i.id]}
                      onChange={(e) =>
                        setQty({
                          ...qty,
                          [i.id]: Math.min(i.quantity, Math.max(1, Number(e.target.value) || 1)),
                        })
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </fieldset>

          <Field label="O que precisa ser refeito" required>
            {(f) => (
              <Textarea
                {...f}
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Vai para o pedido e para a OS do retrabalho."
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Motivo" required>
              {(f) => (
                <Select
                  {...f}
                  value={cause}
                  onChange={(e) => setCause(e.target.value as ReworkCause)}
                >
                  {REWORK_CAUSES.map((c) => (
                    <option key={c} value={c}>
                      {REWORK_CAUSE_LABEL[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Prazo (dias úteis)"
              required
              hint={withPickup ? 'Contado do dia da retirada.' : 'Contado de hoje.'}
            >
              {(f) => (
                <Input
                  {...f}
                  type="number"
                  min={1}
                  max={120}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              )}
            </Field>
          </div>

          {logistica && (
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium text-ink">Retirada</legend>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    className="accent-brand-700"
                    checked={withPickup}
                    onChange={() => setWithPickup(true)}
                  />
                  Agendar retirada na casa do cliente
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    className="accent-brand-700"
                    checked={!withPickup}
                    onChange={() => setWithPickup(false)}
                  />
                  O cliente traz as peças
                </label>
              </div>
              {withPickup && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Data" required>
                    {(f) => (
                      <Input
                        {...f}
                        type="date"
                        min={localToday()}
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Chegada ao cliente" required>
                    {(f) => (
                      <Input
                        {...f}
                        type="time"
                        value={time}
                        onChange={(e) => setTime(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Quem busca">
                    {(f) => (
                      <Select
                        {...f}
                        value={team}
                        onChange={(e) => setTeam(e.target.value as typeof team)}
                      >
                        {PICKUP_TEAMS.map((t) => (
                          <option key={t} value={t}>
                            {PICKUP_TEAM_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              )}
            </fieldset>
          )}

          {finance && (
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field label="Custo extra (R$)" hint="Fora da OS. Opcional.">
                {(f) => (
                  <Input
                    {...f}
                    inputMode="decimal"
                    placeholder="0,00"
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                  />
                )}
              </Field>
              <Field label="O que foi o custo extra">
                {(f) => (
                  <Input
                    {...f}
                    placeholder="Ex.: deslocamento a mais, peça comprada à parte"
                    value={extraNote}
                    onChange={(e) => setExtraNote(e.target.value)}
                  />
                )}
              </Field>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function EditReworkDialog({ r, onClose }: { r: ReworkDto; onClose: () => void }) {
  const finance = useCan()('financeiro.gerenciar');
  const [reason, setReason] = useState(r.reason);
  const [cause, setCause] = useState<ReworkCause>(r.cause);
  const [extra, setExtra] = useState(
    r.cost?.extraCents ? (r.cost.extraCents / 100).toFixed(2).replace('.', ',') : '',
  );
  const [extraNote, setExtraNote] = useState(r.extraCostNote ?? '');
  const { m, error } = useReworkSend(onClose);
  const extraCents = extra.trim() ? parseMoney(extra) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Editar ${r.code}`}
      footer={
        <Button
          loading={m.isPending}
          disabled={reason.trim().length < 3 || (extra.trim() !== '' && extraCents === null)}
          onClick={() =>
            m.mutate({
              ok: 'Retrabalho atualizado.',
              run: () =>
                api(`/api/v1/reworks/${r.id}`, {
                  method: 'PUT',
                  body: {
                    version: r.version,
                    reason: reason.trim(),
                    cause,
                    ...(finance
                      ? { extraCostCents: extraCents ?? 0, extraCostNote: extraNote.trim() || null }
                      : {}),
                  },
                }),
            })
          }
        >
          Salvar
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="space-y-4">
        <Field label="O que precisa ser refeito" required>
          {(f) => (
            <Textarea {...f} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
        <Field label="Motivo">
          {(f) => (
            <Select {...f} value={cause} onChange={(e) => setCause(e.target.value as ReworkCause)}>
              {REWORK_CAUSES.map((c) => (
                <option key={c} value={c}>
                  {REWORK_CAUSE_LABEL[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {finance && (
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label="Custo extra (R$)">
              {(f) => (
                <Input
                  {...f}
                  inputMode="decimal"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
              )}
            </Field>
            <Field label="O que foi o custo extra">
              {(f) => (
                <Input {...f} value={extraNote} onChange={(e) => setExtraNote(e.target.value)} />
              )}
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function CancelReworkDialog({ r, onClose }: { r: ReworkDto; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { m, error } = useReworkSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancelar ${r.code}`}
      description="Cancela o pedido do retrabalho e a retirada agendada."
      footer={
        <Button
          variant="danger"
          loading={m.isPending}
          disabled={reason.trim().length < 3}
          onClick={() =>
            m.mutate({
              ok: 'Retrabalho cancelado.',
              run: () =>
                api(`/api/v1/reworks/${r.id}/cancel`, {
                  method: 'POST',
                  body: { version: r.version, reason: reason.trim() },
                }),
            })
          }
        >
          Cancelar retrabalho
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <Field label="Motivo do cancelamento" required>
        {(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

/**
 * Oficina sem tablet (2026-11-24): "Voltou com defeito" na OS entregue abre o Novo retrabalho já
 * com o serviço e as peças marcados; falta só dizer o que precisa ser refeito.
 */
export function ReworkFromOrder({
  order,
  onClose,
}: {
  order: { id: string; code: string };
  onClose: () => void;
}) {
  const candidates = useReworkCandidates(order.code, true);
  if (candidates.isPending) return null;
  const found = candidates.data?.find((o) => o.id === order.id);
  return <CreateReworkDialog onClose={onClose} initialOrder={found} />;
}
