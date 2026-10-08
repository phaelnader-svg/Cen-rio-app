'use client';

import { MATERIAL_READINESS_STATES, MATERIAL_READINESS_LABEL } from '@cenario/shared';
import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { formatDay } from '@/lib/commercial';
import { useReadinessList } from '@/lib/purchasing';
import { ReadinessBadge } from './badges';

export function ReadinessPage() {
  const list = useReadinessList();
  const [state, setState] = useState('');
  const rows = (list.data ?? []).filter((r) => !state || r.state === state);
  return (
    <>
      <PageHeader
        title="Prontidão de materiais"
        description="Calculada a partir de solicitações, compras, recebimentos e reservas. Material completo não libera a produção — a programação é feita em fase futura."
      />
      <Card className="mb-4 flex flex-wrap gap-3 p-4">
        <Select
          aria-label="Situação"
          className="max-w-72"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">Todas as situações</option>
          {MATERIAL_READINESS_STATES.map((s) => (
            <option key={s} value={s}>
              {MATERIAL_READINESS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardCheck className="size-6" aria-hidden />}
            title="Nenhuma OS aberta nesta situação"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="readiness-list">
            {rows.map((r) => (
              <li key={r.serviceOrder.id}>
                <Link
                  href={`/painel/os/${r.serviceOrder.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                  data-testid={`readiness-${r.serviceOrder.code}`}
                >
                  <span className="w-24 font-mono text-sm font-semibold">
                    {r.serviceOrder.code}
                  </span>
                  <div className="min-w-0 flex-1 basis-[calc(100%-7rem)] sm:basis-0">
                    <p className="truncate font-medium">{r.customerName}</p>
                    <p className="text-sm text-ink-muted">
                      {r.lines
                        ? `${r.coveredLines} de ${r.lines} material(is) disponível(is)`
                        : 'Sem materiais aprovados'}
                      {r.serviceOrder.promisedDate
                        ? ` · prazo ${formatDay(r.serviceOrder.promisedDate)}`
                        : ''}
                    </p>
                  </div>
                  <PriorityBadge priority={r.serviceOrder.priority} />
                  <ReadinessBadge state={r.state} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
