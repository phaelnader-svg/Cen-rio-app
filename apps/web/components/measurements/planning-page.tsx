'use client';

import type { ConsolidatedLine, PurchaseNeedDto } from '@cenario/shared';
import {
  MATERIAL_KIND_LABEL,
  MATERIAL_UNIT_LABEL,
  consolidateMaterials,
  describeMaterial,
  formatQuantity,
} from '@cenario/shared';
import clsx from 'clsx';
import { CheckCircle2, Circle, Clock3 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Section } from '@/components/commercial/section';
import { Input } from '@/components/ui/field';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { addDays, formatDay, todayIso } from '@/lib/commercial';
import { useCan, useMe } from '@/lib/hooks';
import { usePlanning } from '@/lib/measurements';
import { useNeeds } from '@/lib/purchasing';
import { MeasurementList } from './measurements-page';

type CheckState = 'ok' | 'pending' | 'future';

function CheckItem({
  state,
  title,
  detail,
  href,
  testId,
}: {
  state: CheckState;
  title: string;
  detail: string;
  href?: string;
  testId: string;
}) {
  const Icon = state === 'ok' ? CheckCircle2 : state === 'pending' ? Circle : Clock3;
  const body = (
    <>
      <Icon
        className={clsx(
          'mt-0.5 size-5 shrink-0',
          state === 'ok' ? 'text-ok-600' : state === 'pending' ? 'text-warn-600' : 'text-ink-muted',
        )}
        aria-hidden
      />
      <span className="min-w-0">
        <span className={clsx('block font-medium', state === 'future' && 'text-ink-muted')}>
          {title}
        </span>
        <span className="block text-sm text-ink-muted">{detail}</span>
      </span>
    </>
  );
  return (
    <li data-testid={testId} data-state={state}>
      {href ? (
        <Link href={href} className="flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-subtle">
          {body}
        </Link>
      ) : (
        <div className="flex items-start gap-3 px-3 py-3">{body}</div>
      )}
    </li>
  );
}

/** Comprado/recebido por linha consolidada (mesma chave da consolidação da Fase 3). */
function purchaseProgress(needs: PurchaseNeedDto[]) {
  const input = (field: 'purchased' | 'received') =>
    needs.map((n) => ({
      kind: n.kind,
      sourcing: n.sourcing,
      description: n.description,
      color: n.color,
      reference: n.reference,
      foamDensity: n.foamDensity,
      thicknessCm: n.thicknessCm,
      lengthCm: n.lengthCm,
      widthCm: n.widthCm,
      unit: n.unit,
      quantity: n[field],
      serviceOrder: { id: n.serviceOrder.id, code: n.serviceOrder.code },
      itemCode: n.itemCode,
      measurementCode: null,
    }));
  const out = new Map<string, { purchased: number; received: number }>();
  for (const l of consolidateMaterials(input('purchased')))
    out.set(l.key, { purchased: l.totalQuantity, received: 0 });
  for (const l of consolidateMaterials(input('received'))) {
    const cur = out.get(l.key) ?? { purchased: 0, received: 0 };
    out.set(l.key, { ...cur, received: l.totalQuantity });
  }
  return out;
}

interface MaterialRow {
  line: ConsolidatedLine;
  requested: number | null;
  approved: number | null;
}

function mergeLines(requested: ConsolidatedLine[], approved: ConsolidatedLine[]): MaterialRow[] {
  const map = new Map<string, MaterialRow>();
  for (const l of approved) map.set(l.key, { line: l, requested: null, approved: l.totalQuantity });
  for (const l of requested) {
    const cur = map.get(l.key);
    if (cur) cur.requested = l.totalQuantity;
    else map.set(l.key, { line: l, requested: l.totalQuantity, approved: null });
  }
  return [...map.values()];
}

/** Planejamento de sexta: checklist do período + situação dos materiais. */
export function PlanningPage() {
  const me = useMe();
  const today = todayIso(me.data?.company.timezone);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const plan = usePlanning(from || undefined, to || undefined);
  const period = plan.data?.period;
  // Fase 4: comprado e recebido vêm dos pedidos de compra reais (sem estados fictícios).
  const can = useCan();
  const canBuy = can('compras.ver');
  const needs = useNeeds(false, canBuy);
  const progress = useMemo(() => purchaseProgress(needs.data ?? []), [needs.data]);
  const toBuy = (needs.data ?? []).filter((n) => n.pendingToBuy > 0).length;
  const toReceive = (needs.data ?? []).filter(
    (n) => n.pendingToBuy <= 0 && n.received < n.purchased,
  ).length;

  return (
    <>
      <PageHeader
        title="Planejamento de sexta"
        description="O que falta medir, conferir e aprovar antes da compra de materiais."
      />
      <Card className="mb-6 flex flex-wrap items-end gap-3 p-4">
        <label className="field">
          <span className="label">De</span>
          <Input
            type="date"
            value={from || period?.from || ''}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Até</span>
          <Input
            type="date"
            value={to || period?.to || ''}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full border border-line-strong px-3 py-1.5 text-sm hover:bg-subtle"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            Até a próxima sexta
          </button>
          <button
            type="button"
            className="rounded-full border border-line-strong px-3 py-1.5 text-sm hover:bg-subtle"
            onClick={() => {
              setFrom(today);
              setTo(addDays(today, 13));
            }}
          >
            Próximas 2 semanas
          </button>
        </div>
        {period && (
          <p className="ml-auto text-sm text-ink-muted">
            Dia de medição:{' '}
            <strong className="text-ink">{formatDay(period.measurementDay, true)}</strong>
          </p>
        )}
      </Card>

      {plan.isPending ? (
        <Spinner />
      ) : plan.isError ? (
        <Alert tone="danger">{plan.error.message}</Alert>
      ) : (
        <div className="space-y-6">
          <Section title="Checklist" bodyClassName="p-2">
            <ul className="grid sm:grid-cols-2 lg:grid-cols-3" data-testid="planning-checklist">
              <CheckItem
                testId="check-awaiting"
                state={plan.data.awaiting.length ? 'pending' : 'ok'}
                title="Peças recebidas aguardando medição"
                detail={
                  plan.data.awaiting.length
                    ? `${plan.data.awaiting.length} peça(s) sem medição atribuída`
                    : 'Todas as peças recebidas têm medição'
                }
                href="/painel/medicoes"
              />
              <CheckItem
                testId="check-pending"
                state={plan.data.pending.length ? 'pending' : 'ok'}
                title="Medições atribuídas a concluir"
                detail={
                  plan.data.pending.length
                    ? `${plan.data.pending.length} com prazo até ${formatDay(plan.data.period.to)}`
                    : 'Nenhuma medição em aberto no período'
                }
              />
              <CheckItem
                testId="check-completed"
                state="ok"
                title="Medições concluídas no período"
                detail={`${plan.data.completed.length} concluída(s)`}
              />
              <CheckItem
                testId="check-approval"
                state={plan.data.awaitingApproval.length ? 'pending' : 'ok'}
                title="Solicitações aguardando conferência"
                detail={
                  plan.data.awaitingApproval.length
                    ? `${plan.data.awaitingApproval.length} para revisar e aprovar`
                    : 'Nada aguardando aprovação'
                }
              />
              <CheckItem
                testId="check-approved"
                state={plan.data.materials.approved.length ? 'ok' : 'pending'}
                title="Lista de materiais aprovados"
                detail={`${plan.data.materials.approved.length} linha(s) prontas para compra`}
                href="/painel/materiais"
              />
              <CheckItem
                testId="check-purchase"
                state={!canBuy ? 'future' : toBuy || toReceive ? 'pending' : 'ok'}
                title="Compra e recebimento dos materiais"
                detail={
                  !canBuy
                    ? 'Sem acesso à central de compras.'
                    : toBuy || toReceive
                      ? `${toBuy} material(is) a comprar · ${toReceive} aguardando chegada`
                      : 'Tudo comprado e recebido'
                }
                href={canBuy ? '/painel/compras' : undefined}
              />
            </ul>
          </Section>

          <Section title="Materiais das OS abertas" bodyClassName="p-0">
            <PlanningMaterials
              rows={mergeLines(plan.data.materials.requested, plan.data.materials.approved)}
              progress={canBuy ? progress : null}
            />
          </Section>
          {plan.data.awaitingApproval.length > 0 && (
            <div>
              <h2 className="mb-2 font-semibold">Aguardando conferência</h2>
              <MeasurementList rows={plan.data.awaitingApproval} empty="" />
            </div>
          )}
          {plan.data.pending.length > 0 && (
            <div>
              <h2 className="mb-2 font-semibold">Medições em aberto</h2>
              <MeasurementList rows={plan.data.pending} empty="" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PlanningMaterials({
  rows,
  progress,
}: {
  rows: MaterialRow[];
  progress: Map<string, { purchased: number; received: number }> | null;
}) {
  if (rows.length === 0)
    return <p className="p-5 text-sm text-ink-muted">Nenhum material solicitado ou aprovado.</p>;
  const qty = (v: number | null, unit: ConsolidatedLine['unit']) =>
    v === null ? (
      <span className="text-ink-muted">—</span>
    ) : (
      `${formatQuantity(v)} ${MATERIAL_UNIT_LABEL[unit]}`
    );
  return (
    <div className="overflow-x-auto">
      <table className="data-table min-w-[640px]" data-testid="planning-materials">
        <thead>
          <tr>
            <th>Material</th>
            <th className="text-right">Solicitado</th>
            <th className="text-right">Aprovado</th>
            <th className="text-right">Comprado</th>
            <th className="text-right">Recebido</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(({ line, requested, approved }) => (
            <tr key={line.key}>
              <td>
                {MATERIAL_KIND_LABEL[line.kind]}: {describeMaterial(line)}
                <span className="block text-xs text-ink-muted">
                  {line.serviceOrder ? `Exclusivo ${line.serviceOrder.code}` : 'Estoque comum'} ·{' '}
                  {line.origins.map((o) => o.itemCode ?? o.serviceOrderCode).join(', ')}
                </span>
              </td>
              <td className="text-right tabular-nums">{qty(requested, line.unit)}</td>
              <td className="text-right font-semibold tabular-nums">{qty(approved, line.unit)}</td>
              <td className="text-right tabular-nums">
                {progress
                  ? qty(progress.get(line.key)?.purchased ?? 0, line.unit)
                  : qty(null, line.unit)}
              </td>
              <td className="text-right tabular-nums">
                {progress
                  ? qty(progress.get(line.key)?.received ?? 0, line.unit)
                  : qty(null, line.unit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2.5 text-xs text-ink-muted">
        “Solicitado” = enviado e ainda em conferência. “Aprovado” = quantidades conferidas pelo
        gestor (não significa comprado nem recebido). “Comprado” = pedidos confirmados; “Recebido” =
        chegada conferida (Compras e Recebimento de materiais).
      </p>
    </div>
  );
}
