'use client';

import {
  ARRIVAL_PROBLEMS,
  ARRIVAL_PROBLEM_LABEL,
  type PHYSICAL_UNITS,
  PHYSICAL_UNIT_LABEL,
  PIECE_TYPE_LABEL,
  type ArrivalConfirmationDto,
  type MaterialArrivalDueDto,
  type PieceArrivalDto,
} from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, MapPin, Minus, Package, Plus, Sofa, Truck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, ApiError, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useArrivals } from '@/lib/arrivals';
import { arrivalText, todayIso } from '@/lib/commercial';
import { useLogisticsRoute } from '@/lib/quality';
import { useOnline } from './tasks';

/**
 * Simplificação Fase 3 — "Aguardando chegada": central COMPARTILHADA por todos os tablets.
 * Qualquer pessoa autorizada confirma; o sistema registra quem, em qual aparelho e quando.
 * Confirmou em um tablet, o aviso some dos outros em tempo real (evento → invalidação).
 *
 * Regras de tela: botões grandes, poucos campos, nenhum valor financeiro, nunca "atrasado"
 * (o horário da retirada é a chegada ao CLIENTE, não à oficina). Nada aparece como confirmado
 * antes da resposta do servidor; sem conexão, a confirmação fica desativada.
 */

type View =
  | { kind: 'list' }
  | { kind: 'piece'; id: string }
  | { kind: 'material'; id: string }
  | { kind: 'done'; result: ArrivalConfirmationDto; title: string };

export function useArrivalsCount(enabled: boolean) {
  const q = useArrivals(enabled);
  if (!q.data) return undefined;
  return (q.data.pieces?.length ?? 0) + q.data.materials.length;
}

/**
 * Resposta perdida (o envio pode ou não ter chegado ao servidor): nunca se atribui a mudança a
 * outro aparelho — pode ter sido este mesmo. Mensagem aprovada pelo responsável.
 */
export const LOST_RESPONSE_MESSAGE =
  'Não foi possível confirmar se sua ação foi concluída. Atualize a tela e confira o status antes de tentar novamente.';

export function ArrivalsCenter() {
  const q = useArrivals();
  const [view, setView] = useState<View>({ kind: 'list' });
  // Recarregar a confirmação aberta com o saldo atual (depois de um novo registro).
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  // Avisos cuja última confirmação ficou sem resposta (falha de rede durante o envio).
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  const markLost = (id: string) => setLost((s) => new Set(s).add(id));
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const back = () => setView({ kind: 'list' });

  if (view.kind === 'done') return <Done view={view} onBack={back} />;
  if (view.kind === 'piece') {
    const p = q.data.pieces?.find((x) => x.pickupId === view.id);
    if (!p) return <Gone lostResponse={lost.has(view.id)} onBack={back} />;
    return (
      <PieceConfirm
        key={`${p.pickupId}:${nonce}`}
        p={p}
        lostResponse={lost.has(p.pickupId)}
        onLost={() => markLost(p.pickupId)}
        onReload={reload}
        onBack={back}
        onDone={(result) => setView({ kind: 'done', result, title: `Retirada ${p.pickupCode}` })}
      />
    );
  }
  if (view.kind === 'material') {
    const m = q.data.materials.find((x) => x.purchaseOrderId === view.id);
    if (!m) return <Gone lostResponse={lost.has(view.id)} onBack={back} />;
    return (
      <MaterialConfirm
        key={`${m.purchaseOrderId}:${nonce}`}
        m={m}
        lostResponse={lost.has(m.purchaseOrderId)}
        onLost={() => markLost(m.purchaseOrderId)}
        onReload={reload}
        onBack={back}
        onDone={(result) => setView({ kind: 'done', result, title: `Pedido ${m.code}` })}
      />
    );
  }

  const pieces = q.data.pieces;
  const materials = q.data.materials;
  return (
    <div className="space-y-8" data-testid="arrivals-center">
      {pieces && (
        <section aria-labelledby="arr-pieces" className="space-y-4">
          <h2 id="arr-pieces" className="flex items-center gap-2 text-xl font-semibold">
            <Sofa className="size-6 text-brand-700" aria-hidden />
            Peças de clientes
          </h2>
          {!pieces.length ? (
            <Empty testId="arrivals-pieces-empty">
              Nenhuma peça de cliente aguardando chegada.
            </Empty>
          ) : (
            <ul className="grid gap-4 lg:grid-cols-2">
              {pieces.map((p) => (
                <li key={p.pickupId}>
                  <ArrivalCard
                    testId={`arrival-piece-${p.pickupCode}`}
                    eyebrow={`Retirada ${p.pickupCode}`}
                    title={pieceTitle(p)}
                    situation={p.stageLabel}
                    lines={p.items.map(
                      (i) =>
                        `${i.pending}× ${i.description || PIECE_TYPE_LABEL[i.pieceType] || 'Peça'}`,
                    )}
                    action="Confirmar chegada"
                    onAction={() => setView({ kind: 'piece', id: p.pickupId })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section aria-labelledby="arr-materials" className="space-y-4">
        <h2 id="arr-materials" className="flex items-center gap-2 text-xl font-semibold">
          <Package className="size-6 text-bronze-600" aria-hidden />
          Materiais comprados
        </h2>
        {!materials.length ? (
          <Empty testId="arrivals-materials-empty">Nenhum material aguardando chegada.</Empty>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {materials.map((m) => (
              <li key={m.purchaseOrderId}>
                <ArrivalCard
                  testId={`arrival-material-${m.code}`}
                  eyebrow={`Pedido ${m.code}`}
                  title={m.supplierName ?? 'Fornecedor não informado'}
                  situation={m.dueLabel}
                  lines={m.items.map((i) =>
                    i.mode === 'FISICA'
                      ? `${i.description} — conferência em ${i.unitLabel} depois`
                      : `${fmt(i.pending)} ${i.unitLabel} · ${i.description}${i.conference ? ' — conferência depois' : ''}`,
                  )}
                  note={
                    m.awaitingConference
                      ? `${m.awaitingConference} item(ns) já chegaram e aguardam conferência.`
                      : null
                  }
                  action="Confirmar materiais"
                  tone="bronze"
                  onAction={() => setView({ kind: 'material', id: m.purchaseOrderId })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

function pieceTitle(p: PieceArrivalDto) {
  const first = p.items[0];
  const what = first ? first.description || PIECE_TYPE_LABEL[first.pieceType] || 'Peças' : 'Peças';
  return `${what}${p.items.length > 1 ? ` e mais ${p.items.length - 1}` : ''} — ${p.customerName}`;
}

function Empty({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p className="rounded-2xl bg-subtle p-6 text-lg text-ink-muted" data-testid={testId}>
      {children}
    </p>
  );
}

function ArrivalCard({
  testId,
  eyebrow,
  title,
  situation,
  lines,
  note,
  action,
  onAction,
  tone = 'brand',
}: {
  testId: string;
  eyebrow: string;
  title: string;
  situation: string;
  lines: string[];
  note?: string | null;
  action: string;
  onAction: () => void;
  tone?: 'brand' | 'bronze';
}) {
  return (
    <article
      className="flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
      data-testid={testId}
    >
      <p
        className={clsx(
          'text-sm font-semibold tracking-wide uppercase',
          tone === 'brand' ? 'text-brand-700' : 'text-bronze-600',
        )}
      >
        {eyebrow}
      </p>
      <h3 className="text-xl leading-snug font-semibold break-words">{title}</h3>
      <p className="text-base">
        <span className="text-ink-muted">Situação: </span>
        <span className="font-medium" data-testid="arrival-situation">
          {situation}
        </span>
      </p>
      <ul className="space-y-1 text-base text-ink-soft">
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
      {note && <p className="rounded-xl bg-info-50 px-4 py-2 text-base text-info-600">{note}</p>}
      <Button size="xl" className="mt-auto w-full" onClick={onAction}>
        {action}
      </Button>
    </article>
  );
}

function Gone({ lostResponse, onBack }: { lostResponse: boolean; onBack: () => void }) {
  return (
    <div className="space-y-4" data-testid="arrival-gone">
      <Alert tone={lostResponse ? 'warn' : 'info'} title="Este aviso já foi atualizado">
        <span data-testid="arrival-gone-message">
          {lostResponse ? LOST_RESPONSE_MESSAGE : 'Esta chegada não está mais pendente.'}
        </span>
      </Alert>
      <Button size="xl" variant="secondary" onClick={onBack}>
        Voltar ao Aguardando chegada
      </Button>
    </div>
  );
}

/**
 * Envio com a mesma chave na nova tentativa (rede caiu) — o servidor não duplica. Nada é
 * reenviado sozinho: depois de uma resposta perdida a pessoa confere o status e decide.
 */
function useConfirm(onDone: (r: ArrivalConfirmationDto) => void, onLost: () => void) {
  const qc = useQueryClient();
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; stale: boolean } | null>(null);
  async function send(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ArrivalConfirmationDto>(path, {
        method: 'POST',
        body,
        idempotencyKey: key,
      });
      setKey(newIdempotencyKey());
      void qc.invalidateQueries({ queryKey: ['arrivals'] });
      onDone(r);
    } catch (e) {
      const network = e instanceof ApiError && e.code === 'NETWORK_ERROR';
      // Erro de rede: mantém a chave (a próxima tentativa é a MESMA confirmação).
      if (!network) setKey(newIdempotencyKey());
      const stale = e instanceof ApiError && e.status === 409;
      if (network) onLost();
      setError({ msg: network ? LOST_RESPONSE_MESSAGE : errorMessage(e), stale });
      if (stale) void qc.invalidateQueries({ queryKey: ['arrivals'] });
    } finally {
      setBusy(false);
    }
  }
  return { send, busy, error };
}

function Stepper({
  label,
  value,
  max,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (n: number) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={testId}>
      <span className="min-w-0 flex-1 text-lg break-words">{label}</span>
      <div className="flex items-center gap-2" role="group" aria-label={`Quantidade: ${label}`}>
        <Button
          variant="secondary"
          size="lg"
          aria-label="Menos"
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          icon={<Minus className="size-5" aria-hidden />}
        />
        <output className="w-12 text-center text-2xl font-semibold tabular-nums" data-testid="qty">
          {value}
        </output>
        <Button
          variant="secondary"
          size="lg"
          aria-label="Mais"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          icon={<Plus className="size-5" aria-hidden />}
        />
      </div>
    </div>
  );
}

function ConfirmShell({
  eyebrow,
  title,
  children,
  onBack,
  onConfirm,
  confirmLabel,
  canConfirm,
  busy,
  error,
  stale,
  lostResponse,
  onReload,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  onBack: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  canConfirm: boolean;
  busy: boolean;
  error: { msg: string; stale: boolean } | null;
  /** Houve novo registro depois que esta tela abriu: confere o saldo antes de enviar. */
  stale: boolean;
  /** A última confirmação desta tela ficou sem resposta (pode ter sido gravada). */
  lostResponse: boolean;
  onReload: () => void;
}) {
  const online = useOnline();
  return (
    <div className="space-y-6" data-testid="arrival-confirm">
      <div>
        <p className="text-sm font-semibold tracking-wide text-ink-muted uppercase">{eyebrow}</p>
        <h2 className="mt-1 text-2xl font-semibold break-words">{title}</h2>
      </div>
      {stale && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn-600/20 bg-warn-50 p-4"
          data-testid="arrival-stale"
        >
          <p className="min-w-0 flex-1 text-lg text-warn-600" data-testid="arrival-stale-message">
            {lostResponse
              ? LOST_RESPONSE_MESSAGE
              : 'Este aviso foi atualizado depois que a tela abriu. Confira o saldo atual antes de confirmar.'}
          </p>
          <Button size="lg" onClick={onReload} data-testid="arrival-reload">
            Ver saldo atual
          </Button>
        </div>
      )}
      {children}
      {error && (
        <Alert
          tone={error.stale ? 'warn' : 'danger'}
          title={error.stale ? 'Já atualizado' : undefined}
        >
          <span data-testid="arrival-error">{error.msg}</span>
        </Alert>
      )}
      {!online && (
        <Alert tone="warn">
          Sem conexão: a confirmação volta a funcionar quando a rede voltar.
        </Alert>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          size="xl"
          className="w-full sm:flex-1"
          disabled={!online || !canConfirm || stale}
          loading={busy}
          onClick={onConfirm}
          data-testid="arrival-submit"
          icon={<CheckCircle2 className="size-6" aria-hidden />}
        >
          {confirmLabel}
        </Button>
        <Button size="xl" variant="secondary" className="w-full sm:w-auto" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

function ProblemBox({
  open,
  setOpen,
  children,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return open ? (
    <fieldset
      className="space-y-4 rounded-2xl border border-line p-4"
      data-testid="arrival-problem"
    >
      <legend className="px-1 text-lg font-semibold">Informar problema</legend>
      {children}
      <Button variant="ghost" size="lg" onClick={() => setOpen(false)}>
        Não há problema
      </Button>
    </fieldset>
  ) : (
    <Button
      variant="secondary"
      size="lg"
      onClick={() => setOpen(true)}
      data-testid="arrival-problem-open"
    >
      Informar problema
    </Button>
  );
}

function PieceConfirm({
  p: live,
  lostResponse,
  onLost,
  onBack,
  onDone,
  onReload,
}: {
  p: PieceArrivalDto;
  lostResponse: boolean;
  onLost: () => void;
  onBack: () => void;
  onDone: (r: ArrivalConfirmationDto) => void;
  onReload: () => void;
}) {
  // A tela trabalha sobre o que a pessoa VIU; a versão enviada é a dela (409 se mudou).
  const [p] = useState(live);
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(p.items.map((i) => [i.orderItemId, i.pending])),
  );
  const [problemOpen, setProblemOpen] = useState(false);
  const [note, setNote] = useState('');
  const { send, busy, error } = useConfirm(onDone, onLost);
  const total = Object.values(qty).reduce((a, b) => a + b, 0);
  const partial = total < p.pendingTotal;
  const problemOk = !problemOpen || note.trim().length >= 3;
  return (
    <ConfirmShell
      eyebrow={`Retirada ${p.pickupCode} · ${p.orderCode}`}
      title={`Peças de ${p.customerName}`}
      onBack={onBack}
      busy={busy}
      error={error}
      stale={live.version !== p.version}
      lostResponse={lostResponse}
      onReload={onReload}
      canConfirm={total > 0 && problemOk}
      confirmLabel={partial ? `Confirmar ${total} peça(s)` : 'Confirmar chegada'}
      onConfirm={() =>
        void send(`/api/v1/arrivals/pickups/${p.pickupId}/confirm`, {
          version: p.version,
          lines: p.items.map((i) => ({ orderItemId: i.orderItemId, quantity: qty[i.orderItemId] })),
          ...(problemOpen ? { problem: { note: note.trim() } } : {}),
        })
      }
    >
      <p className="text-lg text-ink-soft">Quantas peças chegaram à oficina?</p>
      <div className="space-y-4 rounded-2xl border border-line bg-surface p-4">
        {p.items.map((i) => (
          <Stepper
            key={i.orderItemId}
            testId={`arrival-line-${i.description}`}
            label={i.description || PIECE_TYPE_LABEL[i.pieceType] || 'Peça'}
            value={qty[i.orderItemId] ?? 0}
            max={i.pending}
            onChange={(n) => setQty((s) => ({ ...s, [i.orderItemId]: n }))}
          />
        ))}
      </div>
      {partial && total > 0 && (
        <Alert tone="info">
          Chegada parcial: a OS sai só com as peças que chegaram. O restante continua aguardando.
        </Alert>
      )}
      <ProblemBox open={problemOpen} setOpen={setProblemOpen}>
        <label className="block">
          <span className="label">O que aconteceu?</span>
          <textarea
            className="input mt-1 min-h-24 text-lg"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="arrival-problem-note"
            maxLength={500}
          />
        </label>
      </ProblemBox>
    </ConfirmShell>
  );
}

function MaterialConfirm({
  m: live,
  lostResponse,
  onLost,
  onBack,
  onDone,
  onReload,
}: {
  m: MaterialArrivalDueDto;
  lostResponse: boolean;
  onLost: () => void;
  onBack: () => void;
  onDone: (r: ArrivalConfirmationDto) => void;
  onReload: () => void;
}) {
  const [m] = useState(live);
  // Contáveis: começa no saldo. Em metros: conta-se o que chegou (rolos/volumes), começa em 0.
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      m.items.map((i) => [i.purchaseOrderItemId, i.mode === 'CONTAGEM' ? i.pending : 0]),
    ),
  );
  const [units, setUnits] = useState<Record<string, (typeof PHYSICAL_UNITS)[number]>>({});
  const [problemOpen, setProblemOpen] = useState(false);
  const [kind, setKind] = useState<(typeof ARRIVAL_PROBLEMS)[number]>('FALTANDO');
  const [itemId, setItemId] = useState('');
  const [note, setNote] = useState('');
  const { send, busy, error } = useConfirm(onDone, onLost);
  const lines = m.items.filter((i) => (qty[i.purchaseOrderItemId] ?? 0) > 0);
  const problemOk = !problemOpen || note.trim().length >= 3;
  return (
    <ConfirmShell
      eyebrow={`Pedido ${m.code} · ${m.dueLabel}`}
      title={m.supplierName ?? 'Fornecedor não informado'}
      onBack={onBack}
      busy={busy}
      error={error}
      stale={live.version !== m.version}
      lostResponse={lostResponse}
      onReload={onReload}
      canConfirm={lines.length > 0 && problemOk}
      confirmLabel="Confirmar materiais"
      onConfirm={() =>
        void send(`/api/v1/arrivals/purchase-orders/${m.purchaseOrderId}/confirm`, {
          version: m.version,
          lines: lines.map((i) => ({
            purchaseOrderItemId: i.purchaseOrderItemId,
            quantity: qty[i.purchaseOrderItemId],
            ...(i.mode === 'FISICA'
              ? { physicalUnit: units[i.purchaseOrderItemId] ?? 'ROLO' }
              : {}),
          })),
          ...(problemOpen
            ? { problem: { kind, purchaseOrderItemId: itemId || null, note: note.trim() } }
            : {}),
        })
      }
    >
      <p className="text-lg text-ink-soft">O que chegou? Só a contagem física.</p>
      <div className="space-y-5 rounded-2xl border border-line bg-surface p-4">
        {m.items.map((i) =>
          i.mode === 'FISICA' ? (
            <div key={i.purchaseOrderItemId} className="space-y-2">
              <Stepper
                testId={`arrival-line-${i.description}`}
                label={i.description}
                value={qty[i.purchaseOrderItemId] ?? 0}
                max={999}
                onChange={(n) => setQty((s) => ({ ...s, [i.purchaseOrderItemId]: n }))}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base text-ink-muted">Chegou em</span>
                {(['ROLO', 'VOLUME', 'PACOTE'] as const).map((u) => {
                  const on = (units[i.purchaseOrderItemId] ?? 'ROLO') === u;
                  return (
                    <Button
                      key={u}
                      size="md"
                      variant={on ? 'primary' : 'secondary'}
                      aria-pressed={on}
                      onClick={() => setUnits((s) => ({ ...s, [i.purchaseOrderItemId]: u }))}
                    >
                      {PHYSICAL_UNIT_LABEL[u]}
                    </Button>
                  );
                })}
              </div>
              <p className="text-sm text-ink-muted">
                Controlado em {i.unitLabel}: a metragem é conferida depois, no painel.
              </p>
            </div>
          ) : (
            <div key={i.purchaseOrderItemId} className="space-y-1">
              <Stepper
                testId={`arrival-line-${i.description}`}
                label={`${i.description} (${i.unitLabel})`}
                value={qty[i.purchaseOrderItemId] ?? 0}
                max={Math.floor(i.pending)}
                onChange={(n) => setQty((s) => ({ ...s, [i.purchaseOrderItemId]: n }))}
              />
              <p className="text-sm text-ink-muted">Aguardando: {fmt(i.pending)}</p>
              {i.conference && (
                <p className="text-sm text-ink-muted" data-testid="arrival-line-conference">
                  Compra exclusiva da OS: só fica disponível depois da conferência no painel.
                </p>
              )}
            </div>
          ),
        )}
      </div>
      <ProblemBox open={problemOpen} setOpen={setProblemOpen}>
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Tipo de problema">
          {ARRIVAL_PROBLEMS.map((k) => (
            <Button
              key={k}
              size="lg"
              variant={kind === k ? 'primary' : 'secondary'}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className="w-full"
            >
              {ARRIVAL_PROBLEM_LABEL[k]}
            </Button>
          ))}
        </div>
        <label className="block">
          <span className="label">Qual item? (opcional)</span>
          <select
            className="input mt-1 text-lg"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            data-testid="arrival-problem-item"
          >
            <option value="">Pedido inteiro</option>
            {m.items.map((i) => (
              <option key={i.purchaseOrderItemId} value={i.purchaseOrderItemId}>
                {i.description}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Observação</span>
          <textarea
            className="input mt-1 min-h-24 text-lg"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="arrival-problem-note"
            maxLength={500}
          />
        </label>
      </ProblemBox>
    </ConfirmShell>
  );
}

function Done({ view, onBack }: { view: Extract<View, { kind: 'done' }>; onBack: () => void }) {
  const r = view.result;
  const when = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(r.confirmedAt),
  );
  return (
    <div className="space-y-5" data-testid="arrival-done">
      <div className="flex items-start gap-4 rounded-2xl border border-ok-600/20 bg-ok-50 p-5">
        <CheckCircle2 className="mt-1 size-8 shrink-0 text-ok-600" aria-hidden />
        <div className="min-w-0 space-y-1 text-lg">
          <p className="text-xl font-semibold">{view.title}: chegada confirmada</p>
          <p className="text-ink-soft">
            Por {r.confirmedBy ?? '—'} às {when}.
          </p>
          {r.receipt && <p data-testid="arrival-done-receipt">Recebimento {r.receipt.code}</p>}
          {r.arrival && (
            <p data-testid="arrival-done-arrival">
              Chegada {r.arrival.code} — aguardando conferência técnica
            </p>
          )}
          {r.serviceOrder && (
            <p className="font-semibold" data-testid="arrival-done-os">
              OS {r.serviceOrder.code} criada com as peças que chegaram
            </p>
          )}
          <p data-testid="arrival-done-remaining">
            {r.remaining > 0
              ? `Ainda aguardando: ${fmt(r.remaining)}`
              : 'Nada mais aguardando neste item.'}
          </p>
        </div>
      </div>
      <Button size="xl" className="w-full sm:w-auto" onClick={onBack}>
        Voltar ao Aguardando chegada
      </Button>
    </div>
  );
}

/**
 * Equipe própria (ex.: João acompanhando a retirada do Thiago): as paradas de hoje em que a
 * pessoa é responsável ou participante — só leitura, sem valores. Participar não gera pagamento.
 */
export function MyTripsToday() {
  const route = useLogisticsRoute(todayIso(), true);
  if (route.isPending || route.isError || !route.data.stops.length) return null;
  return (
    <section className="mt-10 space-y-4" data-testid="my-trips">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-ink-soft">
        <Truck className="size-5" aria-hidden />
        Minhas retiradas e entregas de hoje
      </h2>
      <ol className="grid gap-4 md:grid-cols-2">
        {route.data.stops.map((s) => {
          const a = s.job.address;
          return (
            <li
              key={`${s.job.kind}:${s.job.id}`}
              className="rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]"
              data-testid={`route-stop-${s.job.code}`}
            >
              <p className="text-base font-semibold text-ink-soft">
                {s.job.kind === 'ENTREGA' ? 'Entrega' : 'Retirada'} {s.job.code} ·{' '}
                {arrivalText(s.job.windowStart, s.job.windowEnd)}
              </p>
              <p className="mt-1 text-xl font-semibold break-words">{s.job.customerName}</p>
              {a && (
                <p className="mt-1 flex items-start gap-2 text-base">
                  <MapPin className="mt-0.5 size-5 shrink-0" aria-hidden />
                  <span className="break-words">
                    {a.street}, {a.number}
                    {a.complement ? ` — ${a.complement}` : ''} · {a.city}
                  </span>
                </p>
              )}
              <p className="mt-2 text-base text-ink-muted">
                Equipe:{' '}
                {[s.responsible?.displayName, ...s.participants.map((p) => p.displayName)]
                  .filter(Boolean)
                  .join(', ')}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
