'use client';
/**
 * Estante/prateleira clicada no mapa: materiais endereçados ali, saldos (físico, reservado,
 * disponível), reservas por OS, OS aguardando, compras em aberto e histórico. Movimentar usa as
 * rotas oficiais do estoque (ajuste com motivo e reserva para a OS): saldo e histórico mudam uma
 * única vez, no mesmo lugar que o painel.
 */
import type { GameSlotMaterialDto, StorageUnitDef } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useMaterial, useSlot } from './game-api';
import { GBtn, KV, Panel, Section, Tone, UNIT_LABEL, fmtDate, fmtDateTime, fmtQty } from './ui';

const KIND_LABEL: Record<string, string> = {
  TECIDO: 'Tecido',
  ESPUMA: 'Espuma',
  OUTRO: 'Ferragem / outros',
};
const MOVE_LABEL: Record<string, string> = {
  ENTRADA_COMPRA: 'Entrada (compra)',
  ESTORNO_RECEBIMENTO: 'Estorno de recebimento',
  SAIDA_OS: 'Saída para OS',
  AJUSTE_ENTRADA: 'Ajuste de entrada / devolução',
  AJUSTE_SAIDA: 'Ajuste de saída',
};
const PO_LABEL: Record<string, string> = {
  RASCUNHO: 'Rascunho',
  CONFIRMADO: 'Confirmado',
  PARCIALMENTE_RECEBIDO: 'Parcialmente recebido',
};

export function StoragePanel({
  unit,
  slotId,
  onSelectSlot,
  canMove,
  onClose,
  onOpenOs,
}: {
  unit: StorageUnitDef;
  slotId: string | null;
  onSelectSlot: (id: string) => void;
  canMove: boolean;
  onClose: () => void;
  onOpenOs: (serviceOrderId: string) => void;
}) {
  const slot = useSlot(slotId);
  const sorted = [...unit.slots].sort((a, b) => b.level - a.level);
  return (
    <Panel
      testId="storage-panel"
      icon="🗄️"
      title={unit.label}
      subtitle={slot.data?.address ?? 'Escolha uma posição'}
      onClose={onClose}
      className="h-full"
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {sorted.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelectSlot(s.id)}
            className={`rounded-lg border px-2 py-1 text-xs font-semibold ${s.id === slotId ? 'border-bronze-600 bg-bronze-500 text-white' : 'border-line-strong bg-white'}`}
          >
            {s.label} {s.stockItemIds.length ? `(${s.stockItemIds.length})` : ''}
          </button>
        ))}
      </div>
      {!slotId ? (
        <p className="text-xs text-ink-muted">Clique numa prateleira do móvel ou escolha acima.</p>
      ) : slot.isPending ? (
        <p className="text-xs text-ink-muted">Carregando…</p>
      ) : slot.isError ? (
        <p className="text-xs text-danger-700">{slot.error.message}</p>
      ) : !slot.data.materials.length ? (
        <p className="text-xs text-ink-muted">
          Posição vazia no mapa. No modo Construção, vincule materiais do catálogo a esta posição.
        </p>
      ) : (
        slot.data.materials.map((m) => (
          <MaterialCard key={m.stockItemId} m={m} canMove={canMove} onOpenOs={onOpenOs} />
        ))
      )}
    </Panel>
  );
}

export function MaterialPanel({
  id,
  canMove,
  onClose,
  onOpenOs,
}: {
  id: string;
  canMove: boolean;
  onClose: () => void;
  onOpenOs: (id: string) => void;
}) {
  const m = useMaterial(id);
  return (
    <Panel
      testId="material-panel"
      icon="🧵"
      title={m.data?.description ?? 'Material'}
      subtitle={m.data?.address}
      onClose={onClose}
      className="h-full"
    >
      {m.data ? (
        <MaterialCard m={m.data} canMove={canMove} onOpenOs={onOpenOs} />
      ) : (
        <p className="text-xs text-ink-muted">Carregando…</p>
      )}
    </Panel>
  );
}

function MaterialCard({
  m,
  canMove,
  onOpenOs,
}: {
  m: GameSlotMaterialDto;
  canMove: boolean;
  onOpenOs: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adj, setAdj] = useState<{ qty: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const u = UNIT_LABEL[m.unit] ?? m.unit;
  const refresh = () =>
    Promise.all(
      [
        'game-slot',
        'game-material',
        'game-snapshot',
        'game-readiness',
        'game-material-search',
        'needs',
      ].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível movimentar.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const tone =
    m.available <= 0
      ? 'FALTA'
      : m.minQuantity !== null && m.available < m.minQuantity
        ? 'A_CONFERIR'
        : 'DISPONIVEL';
  return (
    <div className="mb-3 rounded-xl border border-line bg-white p-3" data-testid="material-card">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold">{m.description}</div>
          <div className="text-xs text-ink-muted">
            {m.code} · {KIND_LABEL[m.kind] ?? m.kind} · unidade: {u}
          </div>
          <div className="text-xs text-bronze-600">📍 {m.address}</div>
        </div>
        <Tone tone={tone}>
          {tone === 'FALTA'
            ? '⛔ Sem saldo livre'
            : tone === 'A_CONFERIR'
              ? '⚠ Abaixo do mínimo'
              : '✅ Disponível'}
        </Tone>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
        <div className="rounded-lg bg-subtle p-1.5">
          <div className="text-[11px] text-ink-muted">Físico</div>
          <div className="font-bold">
            {fmtQty(m.onHand)} {u}
          </div>
        </div>
        <div className="rounded-lg bg-warn-50 p-1.5">
          <div className="text-[11px] text-warn-600">Reservado</div>
          <div className="font-bold">
            {fmtQty(m.reserved)} {u}
          </div>
        </div>
        <div className="rounded-lg bg-ok-50 p-1.5">
          <div className="text-[11px] text-ok-600">Disponível</div>
          <div className="font-bold" data-testid="material-available">
            {fmtQty(m.available)} {u}
          </div>
        </div>
      </div>
      {m.minQuantity !== null ? <KV k="Mínimo" v={`${fmtQty(m.minQuantity)} ${u}`} /> : null}

      <Section title="OS com reserva">
        {m.reservations.length ? (
          Object.values(
            m.reservations.reduce<Record<string, { id: string; code: string; qty: number }>>(
              (acc, r) => {
                const cur = acc[r.serviceOrderId] ?? {
                  id: r.serviceOrderId,
                  code: r.osCode,
                  qty: 0,
                };
                cur.qty += r.quantity;
                acc[r.serviceOrderId] = cur;
                return acc;
              },
              {},
            ),
          ).map((r) => (
            <button
              key={r.id}
              onClick={() => onOpenOs(r.id)}
              className="mr-1 mb-1 rounded-full bg-warn-50 px-2 py-0.5 text-xs font-semibold text-warn-600 underline"
            >
              {r.code}: {fmtQty(r.qty)} {u}
            </button>
          ))
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma reserva ativa.</p>
        )}
      </Section>
      <Section title="OS aguardando este material">
        {m.waiting.length ? (
          <ul className="space-y-1">
            {m.waiting.map((w) => (
              <li key={w.requirementId} className="flex flex-wrap items-center gap-1.5 text-xs">
                <button
                  className="font-semibold underline"
                  onClick={() => onOpenOs(w.serviceOrderId)}
                >
                  {w.osCode}
                </button>
                <span>
                  faltam {fmtQty(w.missing)} {u}
                </span>
                {canMove && m.available > 0 ? (
                  <GBtn
                    tone="primary"
                    className="!px-2 !py-0.5 text-xs"
                    disabled={busy}
                    testId="reserve-for-os"
                    onClick={() =>
                      act(`Reservado para ${w.osCode}.`, () =>
                        api('/api/v1/stock-reservations', {
                          method: 'POST',
                          idempotencyKey: newIdempotencyKey(),
                          body: {
                            stockItemId: m.stockItemId,
                            serviceOrderId: w.serviceOrderId,
                            materialRequirementId: w.requirementId,
                            quantity: Math.min(w.missing, m.available),
                          },
                        }),
                      )
                    }
                  >
                    Reservar {fmtQty(Math.min(w.missing, m.available))} {u}
                  </GBtn>
                ) : null}
                {w.missing - Math.max(0, m.available) > 0 ? (
                  <a
                    href={`/painel/compras/novo?req=${w.requirementId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded bg-bronze-500 px-1.5 py-0.5 font-semibold text-white"
                    title="A tela oficial desconta o estoque livre e compras de estoque em aberto"
                  >
                    <ShoppingCart className="size-3" /> Comprar{' '}
                    {fmtQty(Math.round((w.missing - Math.max(0, m.available)) * 1000) / 1000)} {u}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma OS aguardando.</p>
        )}
      </Section>
      <Section title="Destino das reservas encerradas">
        {m.reservationHistory?.length ? (
          <ul className="space-y-0.5 text-xs" data-testid="reservation-history">
            {m.reservationHistory.map((r, i) => (
              <li key={i}>
                {r.osCode}: {fmtQty(r.quantity)} {u} ·{' '}
                {r.status === 'CONSUMIDA'
                  ? 'consumida na produção'
                  : r.status === 'LIBERADA'
                    ? 'liberada de volta ao estoque'
                    : r.status.toLowerCase()}
                {r.closedAt ? ` em ${fmtDateTime(r.closedAt)}` : ''}
                {r.by ? ` · ${r.by}` : ''}
                {r.reason ? ` (${r.reason})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma reserva encerrada ainda.</p>
        )}
      </Section>
      <Section title="Compras em aberto">
        {m.purchases.length ? (
          m.purchases.map((p, i) => (
            <a
              key={`${p.purchaseOrderId}-${i}`}
              href={`/painel/compras/${p.purchaseOrderId}`}
              target="_blank"
              rel="noreferrer"
              className="block text-xs underline"
            >
              {p.code} · {PO_LABEL[p.status] ?? p.status} · {fmtQty(p.received)}/
              {fmtQty(p.quantity)} {u} · previsão {fmtDate(p.expectedDate)}
            </a>
          ))
        ) : (
          <p className="text-xs text-ink-muted">Nenhuma compra em aberto.</p>
        )}
      </Section>
      {canMove ? (
        <Section title="Movimentar (fluxo oficial do estoque)">
          {adj ? (
            <div className="space-y-1.5 text-xs">
              <input
                type="number"
                step="any"
                className="w-full rounded-lg border border-line-strong px-2 py-1"
                placeholder={`Quantidade (+ entrada, − saída) em ${u}`}
                value={adj.qty}
                onChange={(e) => setAdj({ ...adj, qty: e.target.value })}
                aria-label="Quantidade do ajuste"
              />
              <input
                className="w-full rounded-lg border border-line-strong px-2 py-1"
                placeholder="Motivo (obrigatório)"
                value={adj.reason}
                onChange={(e) => setAdj({ ...adj, reason: e.target.value })}
                aria-label="Motivo do ajuste"
              />
              <div className="flex gap-1.5">
                <GBtn
                  tone="primary"
                  disabled={busy || !Number(adj.qty) || adj.reason.trim().length < 3}
                  testId="adjust-save"
                  onClick={() =>
                    act('Movimentação registrada no estoque.', () =>
                      api(`/api/v1/stock-items/${m.stockItemId}/adjust`, {
                        method: 'POST',
                        idempotencyKey: newIdempotencyKey(),
                        body: { quantity: Number(adj.qty), reason: adj.reason.trim() },
                      }),
                    ).then(() => setAdj(null))
                  }
                >
                  Registrar
                </GBtn>
                <GBtn tone="ghost" onClick={() => setAdj(null)}>
                  Cancelar
                </GBtn>
              </div>
            </div>
          ) : (
            <GBtn
              tone="default"
              onClick={() => setAdj({ qty: '', reason: '' })}
              testId="adjust-open"
            >
              Registrar entrada ou saída
            </GBtn>
          )}
        </Section>
      ) : null}
      <Section title="Histórico">
        {m.movements.length ? (
          <ul className="space-y-0.5 text-xs">
            {m.movements.slice(0, 12).map((h) => (
              <li key={h.id}>
                <span className="text-ink-muted">{fmtDateTime(h.at)}</span> ·{' '}
                {MOVE_LABEL[h.type] ?? h.type} {h.quantity > 0 ? '+' : ''}
                {fmtQty(h.quantity)} {u} → saldo {fmtQty(h.balanceAfter)}
                {h.osCode ? ` · ${h.osCode}` : ''}
                {h.actor ? ` · ${h.actor}` : ''}
                {h.reason ? ` (${h.reason})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-muted">Sem movimentações.</p>
        )}
      </Section>
    </div>
  );
}
