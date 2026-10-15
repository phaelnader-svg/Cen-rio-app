'use client';

import type {
  PipelineServiceDto,
  PipelineStage,
  PublicationPreviewDto,
  WorkerDto,
} from '@cenario/shared';
import {
  PIECE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SERVICE_TYPE_LABEL,
  type PieceType,
  type Priority,
  type ServiceType,
} from '@cenario/shared';
import clsx from 'clsx';
import { CalendarPlus, CalendarRange, ClipboardCheck, Send } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDay, todayIso } from '@/lib/commercial';
import { useCan, useMe } from '@/lib/hooks';
import { usePipeline, usePublicationPreview, useWorkers } from '@/lib/production';
import { useSend } from './use-send';

/**
 * Simplificação Fase 4 — Produção → A planejar. O gestor escolhe a OS, o tapeceiro titular de
 * cada peça e a data de início; o sistema monta o rascunho da semana (plano semanal existente) e
 * distribui as tarefas pelo motor automático. "Publicar semana" libera tudo de uma vez.
 * Cada OS aparece em UMA aba só (calculado no servidor pelos vínculos reais).
 */

type Tab = 'A_PLANEJAR' | 'PLANEJADOS' | 'AGUARDANDO_CONDICAO' | 'EM_PRODUCAO' | 'CONCLUIDO';

const day = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');

export function PreplanningPage() {
  const can = useCan();
  const plan = can('producao.planejar');
  const q = usePipeline();
  const workers = useWorkers(plan);
  const [tab, setTab] = useState<Tab>('A_PLANEJAR');
  const [selected, setSelected] = useState<string[]>([]);
  const [planning, setPlanning] = useState<PipelineServiceDto[] | null>(null);
  const [rescheduling, setRescheduling] = useState<PipelineServiceDto | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  const items = q.data?.items ?? [];
  const counts = q.data?.counts;
  const of = (s: PipelineStage[]) => items.filter((i) => s.includes(i.stage));
  const toPlan = of(['A_PLANEJAR']);
  const chosen = toPlan.filter((i) => selected.includes(i.serviceOrder.id));

  return (
    <>
      <PageHeader
        title="Produção — A planejar"
        description="Serviços recebidos que ainda precisam entrar na programação. Escolha o tapeceiro e a data de início: o sistema prepara as tarefas e você publica a semana quando estiver pronta."
        actions={
          <Link
            href="/painel/producao/planejamento"
            className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-semibold hover:bg-subtle"
          >
            <CalendarRange className="size-4" aria-hidden /> Planejamento avançado
          </Link>
        }
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <Tabs
          active={tab}
          onChange={(k) => setTab(k as Tab)}
          tabs={[
            { key: 'A_PLANEJAR', label: 'A planejar', count: counts?.A_PLANEJAR },
            {
              key: 'PLANEJADOS',
              label: 'Planejados',
              count: (counts?.PLANEJADO_RASCUNHO ?? 0) + (counts?.PLANEJADO_PUBLICADO ?? 0),
            },
            {
              key: 'AGUARDANDO_CONDICAO',
              label: 'Aguardando condição',
              count: counts?.AGUARDANDO_CONDICAO,
            },
            { key: 'EM_PRODUCAO', label: 'Em produção', count: counts?.EM_PRODUCAO },
            { key: 'CONCLUIDO', label: 'Concluídos', count: counts?.CONCLUIDO },
          ]}
        >
          <div className="pt-5" data-testid={`pipeline-${tab}`}>
            {tab === 'A_PLANEJAR' && (
              <ToPlanList
                items={toPlan}
                canPlan={plan}
                selected={selected}
                setSelected={setSelected}
                onPlan={(list) => setPlanning(list)}
                onPlanSelected={() => setPlanning(chosen)}
              />
            )}
            {tab === 'PLANEJADOS' && (
              <PlannedList
                items={of(['PLANEJADO_RASCUNHO', 'PLANEJADO_PUBLICADO'])}
                canPlan={plan}
                onReschedule={setRescheduling}
                onPublish={setPublishing}
              />
            )}
            {tab === 'AGUARDANDO_CONDICAO' && (
              <SimpleList
                items={of(['AGUARDANDO_CONDICAO'])}
                empty="Nenhum serviço planejado com impedimento."
                showBlockers
                canPlan={plan}
                onReschedule={setRescheduling}
              />
            )}
            {tab === 'EM_PRODUCAO' && (
              <SimpleList items={of(['EM_PRODUCAO'])} empty="Nenhum serviço em produção." />
            )}
            {tab === 'CONCLUIDO' && (
              <SimpleList
                items={of(['CONCLUIDO'])}
                empty="Nenhum serviço concluído nos últimos 30 dias."
              />
            )}
          </div>
        </Tabs>
      )}
      {planning && (
        <PlanDialog
          services={planning}
          workers={workers.data ?? []}
          onClose={() => setPlanning(null)}
          onDone={() => {
            setPlanning(null);
            setSelected([]);
          }}
        />
      )}
      {rescheduling && (
        <RescheduleDialog item={rescheduling} onClose={() => setRescheduling(null)} />
      )}
      {publishing && <PublishDialog planId={publishing} onClose={() => setPublishing(null)} />}
    </>
  );
}

// ─────────────────────────── Listas ───────────────────────────

function pieceLine(i: PipelineServiceDto) {
  return i.pieces
    .map(
      (p) =>
        `${p.quantity}× ${PIECE_TYPE_LABEL[p.pieceType as PieceType] ?? p.pieceType} (${
          SERVICE_TYPE_LABEL[p.serviceType as ServiceType] ?? p.serviceType
        })`,
    )
    .join(' · ');
}

function MaterialsBadge({ i }: { i: PipelineServiceDto }) {
  const tone =
    i.materials.state === 'COMPLETO'
      ? 'ok'
      : i.materials.state === 'COM_DIVERGENCIA'
        ? 'danger'
        : i.materials.state === 'SEM_LEVANTAMENTO'
          ? 'neutral'
          : 'warn';
  return (
    <Badge tone={tone}>
      Materiais: {i.materials.label}
      {i.materials.inConference ? ' · em conferência' : ''}
    </Badge>
  );
}

function ServiceHead({ i }: { i: PipelineServiceDto }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/painel/os/${i.serviceOrder.id}`}
          className="font-mono font-semibold text-brand-700 hover:underline"
        >
          {i.serviceOrder.code}
        </Link>
        <span className="font-medium break-words">{i.customerName}</span>
      </p>
      <p className="mt-0.5 text-sm break-words text-ink-soft">{pieceLine(i)}</p>
      <p className="mt-0.5 text-sm text-ink-muted">
        Recebida em {i.receivedAt ? formatDay(i.receivedAt.slice(0, 10)) : '—'}
        {i.serviceOrder.promisedDate ? ` · prazo ${formatDay(i.serviceOrder.promisedDate)}` : ''}
        {i.pieces.some((p) => p.upholsterer)
          ? ` · titular: ${[...new Set(i.pieces.map((p) => p.upholsterer?.displayName).filter(Boolean))].join(', ')}`
          : ''}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <MaterialsBadge i={i} />
      </div>
      {i.pendencies.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-sm text-warn-600">
          {i.pendencies.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToPlanList({
  items,
  canPlan,
  selected,
  setSelected,
  onPlan,
  onPlanSelected,
}: {
  items: PipelineServiceDto[];
  canPlan: boolean;
  selected: string[];
  setSelected: (v: string[]) => void;
  onPlan: (list: PipelineServiceDto[]) => void;
  onPlanSelected: () => void;
}) {
  if (!items.length)
    return (
      <Card>
        <EmptyState
          icon={<ClipboardCheck className="size-6" aria-hidden />}
          title="Nenhum serviço aguardando planejamento"
          description="Quando as peças chegarem à oficina, a OS aparece aqui automaticamente."
        />
      </Card>
    );
  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="space-y-3">
      {canPlan && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-brand-700"
              checked={selected.length === items.length}
              onChange={(e) =>
                setSelected(e.target.checked ? items.map((i) => i.serviceOrder.id) : [])
              }
            />
            Selecionar todos
          </label>
          <Button
            className="ml-auto"
            disabled={!selected.length}
            onClick={onPlanSelected}
            icon={<CalendarPlus className="size-4" aria-hidden />}
            data-testid="plan-selected"
          >
            Planejar selecionados ({selected.length})
          </Button>
        </div>
      )}
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li
              key={i.serviceOrder.id}
              className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:px-5"
              data-testid={`to-plan-${i.serviceOrder.code}`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {canPlan && (
                  <input
                    type="checkbox"
                    aria-label={`Selecionar ${i.serviceOrder.code}`}
                    className="mt-1 size-5 shrink-0 accent-brand-700"
                    checked={selected.includes(i.serviceOrder.id)}
                    onChange={() => toggle(i.serviceOrder.id)}
                  />
                )}
                <ServiceHead i={i} />
              </div>
              {canPlan && (
                <Button
                  size="sm"
                  className="self-start"
                  onClick={() => onPlan([i])}
                  data-testid="plan-one"
                >
                  Planejar serviço
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function PlannedList({
  items,
  canPlan,
  onReschedule,
  onPublish,
}: {
  items: PipelineServiceDto[];
  canPlan: boolean;
  onReschedule: (i: PipelineServiceDto) => void;
  onPublish: (planId: string) => void;
}) {
  const weeks = useMemo(() => {
    const m = new Map<string, { weekStart: string; planId: string; list: PipelineServiceDto[] }>();
    for (const i of items) {
      const k = i.plan!.planId;
      const cur = m.get(k) ?? { weekStart: i.plan!.weekStart, planId: k, list: [] };
      cur.list.push(i);
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }, [items]);
  if (!weeks.length)
    return (
      <Card>
        <EmptyState title="Nenhum serviço planejado ainda não iniciado" />
      </Card>
    );
  return (
    <div className="space-y-6">
      {weeks.map((w) => {
        const drafts = w.list.filter((i) => i.stage === 'PLANEJADO_RASCUNHO');
        const pub = w.list.filter((i) => i.stage === 'PLANEJADO_PUBLICADO');
        return (
          <section
            key={w.planId}
            className="space-y-3"
            data-testid={`week-${w.weekStart}`}
            aria-label={`Semana de ${day(w.weekStart)}`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="mr-auto text-lg font-semibold">Semana de {day(w.weekStart)}</h2>
              {canPlan && drafts.length > 0 && (
                <Button
                  onClick={() => onPublish(w.planId)}
                  icon={<Send className="size-4" aria-hidden />}
                  data-testid="publish-week"
                >
                  Revisar e publicar semana
                </Button>
              )}
            </div>
            {[
              { label: 'Rascunho — ainda não visível aos funcionários', list: drafts, key: 'r' },
              { label: 'Publicado — já na fila dos tablets', list: pub, key: 'p' },
            ]
              .filter((g) => g.list.length)
              .map((g) => (
                <Card key={g.key} className="overflow-hidden">
                  <h3
                    className={clsx(
                      'border-b border-line px-5 py-2.5 text-sm font-semibold',
                      g.key === 'r' ? 'bg-warn-50 text-warn-600' : 'bg-ok-50 text-ok-600',
                    )}
                  >
                    {g.label}
                  </h3>
                  <ul className="divide-y divide-line">
                    {g.list.map((i) => (
                      <li
                        key={i.serviceOrder.id}
                        className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:px-5"
                        data-testid={`planned-${i.serviceOrder.code}`}
                      >
                        <ServiceHead i={i} />
                        <div className="text-sm text-ink-soft sm:w-44 sm:shrink-0">
                          <p>
                            Início: <strong>{day(i.plan!.startDate)}</strong>
                          </p>
                          <p>{i.tasks.total} tarefa(s)</p>
                          {i.plan!.plannedBy && (
                            <p className="text-ink-muted">por {i.plan!.plannedBy}</p>
                          )}
                        </div>
                        {canPlan && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="self-start"
                            onClick={() => onReschedule(i)}
                          >
                            Reprogramar
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
          </section>
        );
      })}
    </div>
  );
}

function SimpleList({
  items,
  empty,
  showBlockers,
  canPlan,
  onReschedule,
}: {
  items: PipelineServiceDto[];
  empty: string;
  showBlockers?: boolean;
  canPlan?: boolean;
  onReschedule?: (i: PipelineServiceDto) => void;
}) {
  if (!items.length)
    return (
      <Card>
        <EmptyState title={empty} />
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {items.map((i) => (
          <li
            key={i.serviceOrder.id}
            className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:px-5"
            data-testid={`stage-${i.serviceOrder.code}`}
          >
            <ServiceHead i={i} />
            <div className="min-w-0 text-sm text-ink-soft sm:w-72 sm:shrink-0">
              {i.plan && (
                <p>
                  Semana de {day(i.plan.weekStart)} · início {day(i.plan.startDate)}
                </p>
              )}
              <p>
                {i.tasks.done}/{i.tasks.total} tarefa(s) concluída(s)
              </p>
              {showBlockers && i.blockers.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-warn-600" data-testid="blockers">
                  {i.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {showBlockers && (
                <p className="mt-1">
                  <Link
                    href={`/painel/os/${i.serviceOrder.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    Resolver na OS
                  </Link>
                  {' · '}
                  <Link href="/painel/prontidao" className="text-brand-700 hover:underline">
                    Prontidão de materiais
                  </Link>
                </p>
              )}
            </div>
            {canPlan && onReschedule && i.plan && (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => onReschedule(i)}
              >
                Reprogramar
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─────────────────────────── Planejar (individual ou lote) ───────────────────────────

type Draft = { startDate: string; owners: Record<string, string> };

function PlanDialog({
  services,
  workers,
  onClose,
  onDone,
}: {
  services: PipelineServiceDto[];
  workers: WorkerDto[];
  onClose: () => void;
  onDone: () => void;
}) {
  const me = useMe();
  const today = todayIso(me.data?.company.timezone);
  const tapeceiros = workers.filter((w) => w.isTapeceiro);
  const [key] = useState(newIdempotencyKey);
  const [all, setAll] = useState({ startDate: today, owner: '' });
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      services.map((s) => [
        s.serviceOrder.id,
        {
          startDate: today,
          owners: Object.fromEntries(
            s.pieces
              .filter((p) => p.needsUpholsterer)
              .map((p) => [p.id, p.upholsterer?.userId ?? '']),
          ),
        },
      ]),
    ),
  );
  const { m, error } = useSend(onDone);
  const set = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));
  // Evita preenchimento repetido: aplica data e tapeceiro a todas as peças ainda sem titular.
  const applyAll = () =>
    setDrafts((d) =>
      Object.fromEntries(
        services.map((s) => {
          const cur = d[s.serviceOrder.id]!;
          const owners = { ...cur.owners };
          for (const p of s.pieces)
            if (p.needsUpholsterer && !p.upholsterer && all.owner) owners[p.id] = all.owner;
          return [s.serviceOrder.id, { startDate: all.startDate || cur.startDate, owners }];
        }),
      ),
    );
  const missing = services.flatMap((s) =>
    s.pieces
      .filter((p) => p.needsUpholsterer && !drafts[s.serviceOrder.id]!.owners[p.id])
      .map((p) => p.code),
  );
  const past = services.filter((s) => drafts[s.serviceOrder.id]!.startDate < today);
  const byOwner = new Map<string, number>();
  for (const s of services)
    for (const v of Object.values(drafts[s.serviceOrder.id]!.owners))
      if (v) byOwner.set(v, (byOwner.get(v) ?? 0) + 1);
  const name = (id: string) => workers.find((w) => w.userId === id)?.displayName ?? '—';
  const batch = services.length > 1;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={
        batch
          ? `Planejar ${services.length} serviços`
          : `Planejar ${services[0]!.serviceOrder.code}`
      }
      description="Escolha o tapeceiro de cada peça e a data de início. As tarefas entram no rascunho da semana — os funcionários só veem depois de publicar."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={missing.length > 0 || past.length > 0}
            data-testid="plan-submit"
            onClick={() =>
              m.mutate({
                run: () =>
                  api('/api/v1/production/plan-services', {
                    method: 'POST',
                    idempotencyKey: key,
                    body: {
                      entries: services.map((s) => {
                        const d = drafts[s.serviceOrder.id]!;
                        return {
                          serviceOrderId: s.serviceOrder.id,
                          startDate: d.startDate,
                          pieces: s.pieces
                            .filter((p) => p.needsUpholsterer && !p.upholsterer && d.owners[p.id])
                            .map((p) => ({
                              serviceOrderItemId: p.id,
                              upholstererUserId: d.owners[p.id],
                            })),
                        };
                      }),
                    },
                  }),
                ok: batch
                  ? `${services.length} serviços adicionados ao planejamento.`
                  : `${services[0]!.serviceOrder.code} adicionada ao planejamento.`,
              })
            }
          >
            Adicionar ao planejamento
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {batch && (
        <div className="mb-5 grid gap-3 rounded-xl bg-subtle p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Data de início (todas)">
            {(p) => (
              <Input
                {...p}
                type="date"
                min={today}
                value={all.startDate}
                onChange={(e) => setAll((a) => ({ ...a, startDate: e.target.value }))}
              />
            )}
          </Field>
          <Field label="Tapeceiro (peças sem titular)">
            {(p) => (
              <Select
                {...p}
                value={all.owner}
                onChange={(e) => setAll((a) => ({ ...a, owner: e.target.value }))}
              >
                <option value="">Selecione…</option>
                {tapeceiros.map((w) => (
                  <option key={w.userId} value={w.userId}>
                    {w.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button variant="secondary" onClick={applyAll} className="mb-[1.375rem]">
            Aplicar a todos
          </Button>
        </div>
      )}
      <ul className="space-y-4">
        {services.map((s) => {
          const d = drafts[s.serviceOrder.id]!;
          return (
            <li
              key={s.serviceOrder.id}
              className="rounded-xl border border-line p-4"
              data-testid={`plan-entry-${s.serviceOrder.code}`}
            >
              <p className="font-semibold">
                {s.serviceOrder.code} · <span className="font-normal">{s.customerName}</span>
              </p>
              {s.materials.state !== 'COMPLETO' && (
                <p className="mt-1 text-sm text-warn-600">
                  Materiais: {s.materials.label}. Pode planejar; as etapas que exigem material só
                  são liberadas quando ele estiver disponível.
                </p>
              )}
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Data de início" required>
                  {(p) => (
                    <Input
                      {...p}
                      type="date"
                      min={today}
                      value={d.startDate}
                      data-testid="plan-start"
                      onChange={(e) => set(s.serviceOrder.id, { startDate: e.target.value })}
                    />
                  )}
                </Field>
                {s.pieces
                  .filter((p) => p.needsUpholsterer)
                  .map((p) => (
                    <Field
                      key={p.id}
                      label={`Tapeceiro — ${p.code} (${p.description})`}
                      required
                      hint={
                        p.upholsterer
                          ? 'Titular já definido (troca só pela OS, com motivo).'
                          : undefined
                      }
                    >
                      {(f) => (
                        <Select
                          {...f}
                          value={d.owners[p.id] ?? ''}
                          disabled={Boolean(p.upholsterer)}
                          data-testid={`plan-owner-${p.code}`}
                          onChange={(e) =>
                            set(s.serviceOrder.id, {
                              owners: { ...d.owners, [p.id]: e.target.value },
                            })
                          }
                        >
                          <option value="">Selecione…</option>
                          {tapeceiros.map((w) => (
                            <option key={w.userId} value={w.userId}>
                              {w.displayName}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  ))}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-5 rounded-xl bg-subtle p-4 text-sm" data-testid="plan-summary">
        <p className="font-semibold">Resumo</p>
        <p>
          {services.length} serviço(s) · {services.reduce((n, s) => n + s.pieces.length, 0)} peça(s)
          · preparação com o responsável padrão (João)
        </p>
        {[...byOwner].map(([id, n]) => (
          <p key={id}>
            {name(id)}: {n} peça(s) de tapeçaria
          </p>
        ))}
        {missing.length > 0 && (
          <p className="mt-1 text-warn-600">Falta escolher o tapeceiro: {missing.join(', ')}.</p>
        )}
        {past.length > 0 && (
          <p className="mt-1 text-danger-600">A data de início não pode estar no passado.</p>
        )}
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Reprogramar ───────────────────────────

function RescheduleDialog({ item, onClose }: { item: PipelineServiceDto; onClose: () => void }) {
  const me = useMe();
  const today = todayIso(me.data?.company.timezone);
  const [key] = useState(newIdempotencyKey);
  const [startDate, setStartDate] = useState(item.plan!.startDate ?? today);
  const [priority, setPriority] = useState<Priority>(item.serviceOrder.priority as Priority);
  const [reason, setReason] = useState('');
  const { m, error } = useSend(onClose);
  const published = item.plan!.planStatus === 'PUBLICADO' && item.stage !== 'PLANEJADO_RASCUNHO';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reprogramar ${item.serviceOrder.code}`}
      description="Outra data na mesma semana muda só o início; outra semana leva as tarefas para o rascunho daquela semana. Nada concluído é alterado."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={startDate < today || (published && reason.trim().length < 3)}
            data-testid="reschedule-submit"
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production/planned/${item.plan!.itemId}`, {
                    method: 'PUT',
                    idempotencyKey: key,
                    body: {
                      version: item.plan!.version,
                      startDate,
                      priority,
                      reason: reason || undefined,
                    },
                  }),
                ok: `${item.serviceOrder.code} reprogramada.`,
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Data de início">
          {(p) => (
            <Input
              {...p}
              type="date"
              min={today}
              value={startDate}
              data-testid="reschedule-start"
              onChange={(e) => setStartDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Prioridade" hint="É a prioridade do serviço: altera também a OS.">
          {(p) => (
            <Select
              {...p}
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {PRIORITY_LABEL[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Motivo"
          className="sm:col-span-2"
          required={published}
          hint={published ? 'A semana já foi publicada: a mudança gera uma revisão.' : 'Opcional.'}
        >
          {(p) => (
            <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Revisar e publicar ───────────────────────────

function PublishDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const q = usePublicationPreview(planId);
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  const p: PublicationPreviewDto | undefined = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={p ? `Publicar semana de ${day(p.weekStart)}` : 'Publicar semana'}
      description="Confira o que vai para os tablets. Tarefas com impedimento continuam bloqueadas até a condição ser resolvida."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!p?.publishable}
            data-testid="publish-confirm"
            icon={<Send className="size-4" aria-hidden />}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-plans/${planId}/publish`, {
                    method: 'POST',
                    idempotencyKey: key,
                    body: { version: p!.version },
                  }),
                ok: 'Semana publicada: os tablets já receberam as tarefas.',
              })
            }
          >
            Publicar semana
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        p && (
          <div className="space-y-4 text-sm" data-testid="publish-preview">
            <dl className="grid grid-cols-3 gap-3">
              {[
                ['OS', p.serviceOrders],
                ['Peças', p.pieces],
                ['Tarefas', p.tasks],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl bg-subtle p-3 text-center">
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="font-semibold">Distribuição por profissional</p>
              <ul className="mt-1 space-y-0.5">
                {p.byAssignee.map((b) => (
                  <li key={b.userId ?? '-'}>
                    {b.displayName}: {b.tasks} tarefa(s)
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-semibold">Datas de início</p>
              <ul className="mt-1 space-y-0.5">
                {p.startDates.map((s) => (
                  <li key={s.code}>
                    {s.code}: {day(s.startDate)}
                  </li>
                ))}
              </ul>
            </div>
            {p.materialsBlocked.length > 0 && (
              <Alert tone="warn" title="Materiais pendentes (as etapas ficam bloqueadas)">
                {p.materialsBlocked.map((x) => `${x.code}: ${x.label}`).join(' · ')}
              </Alert>
            )}
            {[...p.pendencies, ...p.conflicts].length > 0 && (
              <Alert tone="warn" title="Pendências e conflitos">
                <ul>
                  {[...p.pendencies, ...p.conflicts].map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {p.planStatus === 'PUBLICADO' && (
              <p className="text-ink-muted">
                Esta semana já tinha sido publicada: os serviços acima entram como nova revisão; o
                que já estava publicado não muda.
              </p>
            )}
          </div>
        )
      )}
    </Dialog>
  );
}
