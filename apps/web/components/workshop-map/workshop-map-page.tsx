'use client';

import {
  FULFILLMENT_STAGE_LABEL,
  PIECE_TYPE_LABEL,
  type WorkshopMapAreaDto,
  type WorkshopMapDto,
  type WorkshopMapPieceDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { MapPin, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/simple-materials';

/**
 * Reformulação, Fase 2 — mapa interno da oficina: cada área (as localizações já cadastradas em
 * Qualidade) com as peças que estão nela agora. Busca por OS, peça ou cliente destaca onde a peça
 * está. Mover usa a mesma movimentação de sempre (histórico imutável), para quem já podia mover.
 */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function WorkshopMapPage() {
  const q = useQuery({
    queryKey: ['workshop-map'],
    queryFn: () => api<WorkshopMapDto>('/api/v1/workshop-map'),
  });
  const [search, setSearch] = useState('');
  const act = useAction([['workshop-map'], ['service-order'], ['os-state']], 'Peça movida.');
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const { areas, unplaced, can } = q.data;
  const needle = norm(search.trim());
  const matches = (p: WorkshopMapPieceDto) =>
    needle.length > 0 &&
    [p.code, p.serviceOrderCode, p.description, p.customerName].some((x) =>
      norm(x).includes(needle),
    );
  const found = [...areas.flatMap((a) => a.pieces), ...unplaced].filter(matches);
  const activeAreas = areas.filter((a) => a.active);
  const move = (p: WorkshopMapPieceDto, locationId: string) =>
    act.mutate({ path: `/api/v1/pieces/${p.id}/move`, body: { locationId } });
  const total = areas.reduce((n, a) => n + a.pieces.length, 0) + unplaced.length;

  return (
    <>
      <PageHeader
        title="Mapa da oficina"
        description={`Onde cada peça está agora (${total} peça(s) na oficina). As áreas são as localizações cadastradas em Qualidade › Inspetor e localizações.`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-md">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            aria-label="Procurar peça"
            placeholder="Procurar por OS, peça ou cliente"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {needle && (
          <p className="text-sm text-ink-muted" data-testid="workshop-map-found" role="status">
            {found.length === 0
              ? 'Nenhuma peça encontrada.'
              : found
                  .map(
                    (p) =>
                      `${p.code} → ${areas.find((a) => a.pieces.includes(p))?.label ?? 'sem localização registrada'}`,
                  )
                  .join(' · ')}
          </p>
        )}
      </div>
      {act.error && (
        <Alert tone="danger" className="mb-3">
          {act.error}
        </Alert>
      )}
      {areas.length === 0 && (
        <Alert tone="info" className="mb-4">
          Nenhuma área cadastrada. Cadastre as áreas da oficina em Qualidade › Inspetor e
          localizações.
        </Alert>
      )}
      <ul
        className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3"
        data-testid="workshop-map"
        aria-label="Áreas da oficina"
      >
        {/* Primeiro o que precisa de atenção: peças sem localização registrada. */}
        {unplaced.length > 0 && (
          <Area
            area={{
              id: '',
              key: 'SEM_LOCALIZACAO',
              label: 'Sem localização registrada',
              position: 9999,
              active: true,
              pieces: unplaced,
            }}
            unplaced
            highlight={matches}
            dim={Boolean(needle) && !unplaced.some(matches)}
            canMove={can.move}
            targets={activeAreas}
            busy={act.isPending}
            onMove={move}
          />
        )}
        {areas.map((a) => (
          <Area
            key={a.id}
            area={a}
            highlight={matches}
            dim={Boolean(needle) && !a.pieces.some(matches)}
            canMove={can.move}
            targets={activeAreas}
            busy={act.isPending}
            onMove={move}
          />
        ))}
      </ul>
    </>
  );
}

function Area({
  area,
  unplaced,
  highlight,
  dim,
  canMove,
  targets,
  busy,
  onMove,
}: {
  area: WorkshopMapAreaDto;
  unplaced?: boolean;
  highlight: (p: WorkshopMapPieceDto) => boolean;
  dim: boolean;
  canMove: boolean;
  targets: WorkshopMapAreaDto[];
  busy: boolean;
  onMove: (p: WorkshopMapPieceDto, locationId: string) => void;
}) {
  return (
    <li
      className={clsx(
        'flex flex-col rounded-2xl border bg-surface shadow-[var(--shadow-card)] transition-opacity',
        unplaced ? 'border-dashed border-line-strong' : 'border-line',
        dim && 'opacity-40',
      )}
      data-testid={`map-area-${area.key}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <MapPin className="size-4 text-ink-muted" aria-hidden />
          {area.label}
          {!area.active && <Badge tone="warn">desativada</Badge>}
        </h2>
        <Badge tone={area.pieces.length ? 'brand' : 'neutral'}>{area.pieces.length}</Badge>
      </div>
      {area.pieces.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted">Vazia.</p>
      ) : (
        <ul className="divide-y divide-line">
          {area.pieces.map((p) => (
            <li
              key={p.id}
              className={clsx('space-y-1 px-4 py-3 text-sm', highlight(p) && 'bg-brand-50')}
              data-testid={`map-piece-${p.code}`}
            >
              <p>
                <Link
                  href={`/painel/os/${p.serviceOrderId}?tab=pecas`}
                  className="font-semibold text-brand-700 hover:underline"
                >
                  {p.code}
                </Link>{' '}
                · {p.description}{' '}
                <span className="text-ink-muted">
                  ({p.quantity}× {PIECE_TYPE_LABEL[p.pieceType]})
                </span>
              </p>
              <p className="flex flex-wrap items-center gap-2 text-ink-muted">
                {p.customerName}
                <Badge tone="neutral">{FULFILLMENT_STAGE_LABEL[p.stage]}</Badge>
              </p>
              {unplaced && p.receiptLocations.length > 0 && (
                <p className="text-xs text-ink-muted">
                  No recebimento: {p.receiptLocations.join(', ')}
                </p>
              )}
              {p.movedAt && (
                <p className="text-xs text-ink-muted">
                  Movida {p.movedBy ? `por ${p.movedBy} ` : ''}em {formatDateTime(p.movedAt)}
                </p>
              )}
              {canMove && targets.length > 0 && (
                <Select
                  aria-label={`Mover ${p.code}`}
                  className="mt-1 h-9 text-sm"
                  value=""
                  disabled={busy}
                  onChange={(e) => e.target.value && onMove(p, e.target.value)}
                >
                  <option value="">Mover para…</option>
                  {targets
                    .filter((t) => t.id !== area.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                </Select>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
